import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createDailyDataServer, normalizeState, resolvePublicPath, validateApiRequest } from "../server.mjs";
import { JsonStateStore } from "../src/state-store.mjs";

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
  assert.equal((await fetch(`${baseUrl}/api/jobs/preview`)).status, 404);
  assert.equal(sourceResponse.status, 200);
  assert.equal(pairResponse.status, 200);
  assert.equal(bookResponse.status, 200);
  const source = await sourceResponse.json();
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
