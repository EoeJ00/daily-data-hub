import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createDailyDataServer, normalizeState, resolvePublicPath, validateApiRequest } from "../server.mjs";
import { JsonStateStore } from "../src/state-store.mjs";
import { JobQueue } from "../src/job-queue.mjs";

test("normalizes legacy state into the three scenario structure", () => {
  const state = normalizeState({
    sources: [{ id: "source", scenario: "scenario-1" }],
    runs: [{ id: "run", scenario: "scenario-1" }]
  });
  assert.equal(state.scenarios["scenario-1"].sources[0].id, "source");
  assert.equal(state.scenarios["scenario-1"].runs[0].id, "run");
  assert.deepEqual(state.scenarios["scenario-2"], { pairs: [], runs: [] });
  assert.ok(Array.isArray(state.scenarios["scenario-3"].books));
});

test("restricts static paths and mutating API requests to safe local usage", () => {
  assert.match(resolvePublicPath("/index.html"), /public[\\/]index\.html$/);
  assert.equal(resolvePublicPath("/../server.mjs"), null);
  assert.equal(validateApiRequest({ method: "POST", headers: { origin: "http://localhost:4173", "content-type": "application/json" } }), null);
  assert.deepEqual(validateApiRequest({ method: "POST", headers: { origin: "https://example.test", "content-type": "application/json" } }), { status: 403, error: "拒绝非本机来源的写入请求" });
  assert.equal(validateApiRequest({ method: "PATCH", headers: { "content-type": "text/plain" } }).status, 415);
});

test("serves the app and preserves concurrent cross-scenario API mutations", async (context) => {
  const directory = join(import.meta.dirname, ".tmp", `server-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const initialState = normalizeState({ scenarios: {
    "scenario-1": { sources: [], runs: [] },
    "scenario-2": { pairs: [], runs: [] },
    "scenario-3": { books: [], runs: [] }
  } });
  const store = new JsonStateStore(join(directory, "state.json"), { defaultState: initialState, normalize: normalizeState });
  const server = createDailyDataServer({ store });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const request = (path, body) => fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify(body)
  });

  const [page, sourceResponse, pairResponse, bookResponse] = await Promise.all([
    fetch(`${baseUrl}/`),
    request("/api/scenarios/scenario-1/sources/import", {
      name: "自定义单表",
      text: "https://docs.google.com/spreadsheets/d/single-book-1/edit#gid=4"
    }),
    request("/api/scenarios/scenario-2/pairs", {
      name: "并发配对",
      clientUrl: "https://docs.google.com/spreadsheets/d/client-book-1/edit#gid=1",
      ownUrl: "https://docs.google.com/spreadsheets/d/own-book-1/edit#gid=2"
    }),
    request("/api/scenarios/scenario-3/books", {
      name: "并发架上包",
      url: "https://docs.google.com/spreadsheets/d/shelf-book-1/edit#gid=3"
    })
  ]);

  assert.equal(page.status, 200);
  assert.match(await page.text(), /MIULX/);
  assert.equal(page.headers.get("cache-control"), "no-cache, must-revalidate");
  const pageEtag = page.headers.get("etag");
  assert.ok(pageEtag);
  const cachedPage = await fetch(`${baseUrl}/`, { headers: { "if-none-match": pageEtag } });
  assert.equal(cachedPage.status, 304);
  const script = await fetch(`${baseUrl}/app.js`);
  assert.equal(script.headers.get("cache-control"), "no-cache, must-revalidate");
  assert.ok(script.headers.get("etag"));
  assert.equal((await fetch(`${baseUrl}/api/jobs/preview`)).status, 404);
  assert.equal(sourceResponse.status, 200);
  assert.equal(pairResponse.status, 200);
  assert.equal(bookResponse.status, 200);
  const source = await sourceResponse.json();
  assert.equal(source.results[0].name, "自定义单表");
  const duplicateSourceResponse = await request("/api/scenarios/scenario-1/sources/import", {
    name: "重复导入改名",
    text: source.results[0].url
  });
  assert.equal(duplicateSourceResponse.status, 200);
  const duplicateSource = await duplicateSourceResponse.json();
  assert.equal(duplicateSource.results[0].status, "updated");
  assert.equal(duplicateSource.results[0].name, "重复导入改名");
  assert.equal(duplicateSource.sources[0].name, "重复导入改名");
  const pair = await pairResponse.json();
  const book = await bookResponse.json();
  const rename = (path, body) => fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify(body)
  });
  const [renamedSource, renamedPair, renamedBook] = await Promise.all([
    rename(`/api/scenarios/scenario-1/sources/${source.sources[0].id}`, { name: "重命名单表" }),
    rename(`/api/scenarios/scenario-2/pairs/${pair.pair.id}`, { name: "重命名配对" }),
    rename(`/api/scenarios/scenario-3/books/${book.book.id}`, { name: "重命名架上包" })
  ]);
  assert.equal(renamedSource.status, 200);
  assert.equal(renamedPair.status, 200);
  assert.equal(renamedBook.status, 200);
  const bootstrap = await fetch(`${baseUrl}/api/bootstrap`);
  assert.equal(bootstrap.status, 200);
  const data = await bootstrap.json();
  assert.equal(data.scenarios["scenario-2"].pairs[0].name, "重命名配对");
  assert.equal(data.scenarios["scenario-3"].books[0].name, "重命名架上包");
  assert.equal(data.scenarios["scenario-1"].sources[0].name, "重命名单表");
});

test("queued jobs continue after a client disconnects and do not release concurrency early", async (context) => {
  const directory = join(import.meta.dirname, ".tmp", `queue-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const initialState = normalizeState({ scenarios: {
    "scenario-1": { sources: [{ id: "source", name: "测试表", enabled: true }], runs: [] },
    "scenario-2": { pairs: [], runs: [] },
    "scenario-3": { books: [], runs: [] }
  } });
  const store = new JsonStateStore(join(directory, "state.json"), { defaultState: initialState, normalize: normalizeState });
  const queue = new JobQueue();
  let executions = 0;
  let releaseFirst;
  let markStarted;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise((resolve) => { markStarted = resolve; });
  const collect = async (source, businessDate) => {
    executions += 1;
    if (executions === 1) {
      markStarted();
      await firstGate;
    }
    return { sourceId: source.id, sourceName: source.name, status: "success", businessDate, rows: [] };
  };
  const jobs = {
    "scenario-1": {
      collection: "sources",
      idsKey: "sourceIds",
      emptyMessage: "没有已启用的工作簿",
      collect,
      execute: collect,
      failed: (source, error) => ({ sourceId: source.id, sourceName: source.name, status: "failed", error: error.message, rows: [] })
    }
  };
  const server = createDailyDataServer({ store, queue, jobs });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(async () => {
    await queue.onIdle();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  const firstRequest = fetch(`${baseUrl}/api/scenarios/scenario-1/jobs/preview`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ date: "2026-08-24" }),
    signal: controller.signal
  }).catch(() => null);

  await firstStarted;
  controller.abort();
  const secondRequest = fetch(`${baseUrl}/api/scenarios/scenario-1/jobs/preview`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ date: "2026-08-24" })
  });
  for (let attempt = 0; attempt < 50 && queue.snapshot().queued.length !== 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const queuedCount = queue.snapshot().queued.length;
  releaseFirst();
  assert.equal(queuedCount, 1);
  await firstRequest;
  const secondResponse = await secondRequest;
  assert.equal(secondResponse.status, 200);
  await secondResponse.json();
  await queue.onIdle();
  const state = await store.read();
  assert.equal(executions, 2);
  assert.equal(state.scenarios["scenario-1"].runs.length, 2);
});

test("a scenario prepares at most two configurations concurrently and preserves result order", async (context) => {
  const directory = join(import.meta.dirname, ".tmp", `concurrency-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const sources = Array.from({ length: 4 }, (_, index) => ({ id: `source-${index}`, name: `source-${index}`, enabled: true }));
  const initialState = normalizeState({ scenarios: {
    "scenario-1": { sources, runs: [] },
    "scenario-2": { pairs: [], runs: [] },
    "scenario-3": { books: [], runs: [] }
  } });
  const store = new JsonStateStore(join(directory, "state.json"), { defaultState: initialState, normalize: normalizeState });
  let active = 0;
  let maximum = 0;
  const collect = async (source, businessDate) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return { sourceId: source.id, sourceName: source.name, status: "success", businessDate, rows: [] };
  };
  const jobs = { "scenario-1": {
    collection: "sources",
    idsKey: "sourceIds",
    emptyMessage: "empty",
    collect,
    execute: collect,
    failed: (source, error) => ({ sourceId: source.id, status: "failed", error: error.message, rows: [] })
  } };
  const server = createDailyDataServer({ store, jobs });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/api/scenarios/scenario-1/jobs/preview`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ date: "2026-08-24" })
  });
  const run = await response.json();
  assert.equal(response.status, 200);
  assert.equal(maximum, 2);
  assert.deepEqual(run.results.map((item) => item.sourceId), sources.map((item) => item.id));
});

test("previews use materialized snapshots while runs keep the live execution path", async (context) => {
  const directory = join(import.meta.dirname, ".tmp", `snapshot-server-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const source = { id: "source", name: "测试表", enabled: true };
  const store = new JsonStateStore(join(directory, "state.json"), { defaultState: normalizeState({ scenarios: {
    "scenario-1": { sources: [source], runs: [] },
    "scenario-2": { pairs: [], runs: [] },
    "scenario-3": { books: [], runs: [] }
  } }), normalize: normalizeState });
  let liveRuns = 0;
  let snapshotReads = 0;
  let refreshes = 0;
  const result = { sourceId: source.id, sourceName: source.name, status: "success", rows: [] };
  const jobs = { "scenario-1": {
    collection: "sources",
    idsKey: "sourceIds",
    emptyMessage: "empty",
    collect: async () => { throw new Error("预览不应实时读取"); },
    execute: async () => { liveRuns += 1; return result; },
    failed: (_item, error) => ({ status: "failed", error: error.message, rows: [] })
  } };
  const snapshots = {
    preview: async () => { snapshotReads += 1; return { ...result, snapshot: { mode: "materialized", syncedAt: new Date().toISOString() } }; },
    refreshAfterWrite: async () => { refreshes += 1; },
    status: () => ({ running: true }),
    wake() {}
  };
  const queue = new JobQueue();
  let releaseBlocker;
  const blocker = queue.enqueue(() => new Promise((resolve) => { releaseBlocker = resolve; }), { type: "run" });
  while (!queue.snapshot().running) await new Promise((resolve) => setImmediate(resolve));
  const server = createDailyDataServer({ store, jobs, snapshots, queue });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (type) => fetch(`${baseUrl}/api/scenarios/scenario-1/jobs/${type}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ date: "2026-08-27" })
  });

  const previewResponse = await request("preview");
  assert.equal(previewResponse.status, 200);
  assert.equal(previewResponse.headers.get("x-data-source"), "materialized-snapshot");
  releaseBlocker();
  await blocker.promise;
  assert.equal((await request("run")).status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(snapshotReads, 1);
  assert.equal(liveRuns, 1);
  assert.equal(refreshes, 1);
});

test("shutdown endpoint reports queue drain before invoking the runtime callback", async (context) => {
  const queue = new JobQueue();
  let reason = "";
  let shuttingDown = false;
  const server = createDailyDataServer({
    queue,
    isShuttingDown: () => shuttingDown,
    onShutdown: (value) => {
      reason = value;
      shuttingDown = true;
      queue.close();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/api/system/shutdown`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: "{}"
  });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, "draining");
  assert.equal(reason, "api");
  assert.equal((await fetch(`${baseUrl}/api/bootstrap`)).status, 503);
  assert.equal(queue.snapshot().accepting, false);
});
