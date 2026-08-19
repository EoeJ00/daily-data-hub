import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectWorkbook, executeWorkbook } from "./src/collector.mjs";
import { collectScenario2Pair, executeScenario2Pair } from "./src/scenario2.mjs";
import { collectShelfBook, executeShelfBook } from "./src/shelf-pack.mjs";
import { getConnectionStatus } from "./src/google-sheets.mjs";
import { JsonStateStore } from "./src/state-store.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const dataDir = join(root, "data");
const stateFile = join(dataDir, "state.json");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const activeJobKeys = new Set();

const defaultShelfBook = {
  id: "shelf-pack-default",
  name: "架上包数据表（副本）",
  spreadsheetId: "1heP1gG4WDGQbDzoz1XROnG_cVoq-MIxOmIgPEZUBV64",
  gid: "1263233284",
  url: "https://docs.google.com/spreadsheets/d/1heP1gG4WDGQbDzoz1XROnG_cVoq-MIxOmIgPEZUBV64/edit#gid=1263233284",
  enabled: true,
  scenario: "scenario-3",
  createdAt: "2026-08-18T00:00:00.000Z"
};

const defaultState = {
  scenarios: {
    "scenario-1": { sources: [], runs: [] },
    "scenario-2": { pairs: [], runs: [] },
    "scenario-3": { books: [], runs: [] }
  }
};
const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml"
};

const stateStore = new JsonStateStore(stateFile, { defaultState, normalize: normalizeState });

export function normalizeState(raw) {
  const primary = raw.scenarios?.["scenario-1"];
  const secondary = raw.scenarios?.["scenario-2"];
  const shelf = raw.scenarios?.["scenario-3"];
  const legacySources = Array.isArray(raw.sources)
    ? raw.sources.filter((source) => (source.scenario || "scenario-1") === "scenario-1")
    : [];
  const legacyRuns = Array.isArray(raw.runs)
    ? raw.runs.filter((run) => (run.scenario || "scenario-1") === "scenario-1")
    : [];
  return {
    scenarios: {
      "scenario-1": {
        sources: Array.isArray(primary?.sources) ? primary.sources : legacySources,
        runs: Array.isArray(primary?.runs) ? primary.runs : legacyRuns
      },
      "scenario-2": {
        pairs: Array.isArray(secondary?.pairs) ? secondary.pairs : [],
        runs: Array.isArray(secondary?.runs) ? secondary.runs : []
      },
      "scenario-3": {
        books: Array.isArray(shelf?.books) ? shelf.books : [structuredClone(defaultShelfBook)],
        runs: Array.isArray(shelf?.runs) ? shelf.runs : []
      }
    }
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, jsonHeaders);
  response.end(JSON.stringify(body));
}

function acquireJobLock(response, key) {
  if (activeJobKeys.has(key)) return false;
  activeJobKeys.add(key);
  const release = () => activeJobKeys.delete(key);
  response.once("finish", release);
  response.once("close", release);
  return true;
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("请求内容过大");
  }
  return body ? JSON.parse(body) : {};
}

function parseSheetLink(line) {
  const [labelPart, urlPart] = line.includes("|") ? line.split(/\|(.+)/) : ["", line];
  const urlText = urlPart.trim();
  let url;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error(`无效链接：${urlText}`);
  }
  if (url.hostname !== "docs.google.com") throw new Error(`不是 Google 表格链接：${urlText}`);
  const match = url.pathname.match(/\/spreadsheets\/d\/([\w-]+)/);
  if (!match) throw new Error(`无法识别表格 ID：${urlText}`);
  const gid = url.searchParams.get("gid") || url.hash.match(/gid=(\d+)/)?.[1] || "0";
  return {
    spreadsheetId: match[1],
    gid,
    url: `https://docs.google.com/spreadsheets/d/${match[1]}/edit#gid=${gid}`,
    name: labelPart.trim() || `日报 ${match[1].slice(0, 8)}`
  };
}

function newSource(parsed) {
  const source = {
    id: crypto.randomUUID(),
    ...parsed,
    enabled: true,
    scenario: "scenario-1",
    createdAt: new Date().toISOString()
  };
  return {
    ...source,
    targetSheet: "总表",
    excludedSheets: ["充值明细", "总表（所有渠道）", "总表"],
    aliases: {
      date: ["日期", "时间", "date"],
      spend: ["消耗", "广告消耗", "当日消耗", "spend"],
      returnSpend: ["回流消耗", "回流", "return spend"]
    }
  };
}

function newPair({ name, clientUrl, ownUrl }) {
  if (!String(clientUrl || "").trim() || !String(ownUrl || "").trim()) throw new Error("请同时填写甲方日报链接和自己的日报链接");
  const client = parseSheetLink(clientUrl);
  const own = parseSheetLink(ownUrl);
  if (client.spreadsheetId === own.spreadsheetId) throw new Error("甲方表和自己的日报表不能是同一个工作簿");
  return {
    id: crypto.randomUUID(),
    name: String(name || "").trim() || `日报配对 ${client.spreadsheetId.slice(0, 5)}`,
    enabled: true,
    scenario: "scenario-2",
    client,
    own,
    targetSheet: "总表",
    createdAt: new Date().toISOString()
  };
}

function newShelfBook({ name, url }) {
  const parsed = parseSheetLink(url);
  return {
    id: crypto.randomUUID(),
    ...parsed,
    name: String(name || "").trim() || parsed.name || "架上包数据表",
    enabled: true,
    scenario: "scenario-3",
    createdAt: new Date().toISOString()
  };
}

function scenarioState(state, key = "scenario-1") {
  return state.scenarios[key];
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function sendStateMutation(response, mutator, store = stateStore) {
  try {
    return sendJson(response, 200, await store.mutate(mutator));
  } catch (error) {
    return sendJson(response, error.status || 400, { error: error.message });
  }
}

const entityDefinitions = {
  source: { scenario: "scenario-1", collection: "sources", itemKey: "source", allowed: ["name", "enabled", "targetSheet"], notFound: "未找到该工作簿", deleteExtra: { scenario: "scenario-1" } },
  pair: { scenario: "scenario-2", collection: "pairs", itemKey: "pair", allowed: ["name", "enabled", "targetSheet"], notFound: "未找到该日报配对" },
  book: { scenario: "scenario-3", collection: "books", itemKey: "book", allowed: ["name", "enabled"], notFound: "未找到该架上包工作簿" }
};

async function patchEntity(request, response, definition, id, store) {
  const changes = await readJson(request);
  return sendStateMutation(response, (state) => {
    const items = scenarioState(state, definition.scenario)[definition.collection];
    const item = items.find((candidate) => candidate.id === id);
    if (!item) throw httpError(404, definition.notFound);
    for (const key of definition.allowed) {
      if (key in changes) item[key] = changes[key];
    }
    return { [definition.itemKey]: item };
  }, store);
}

async function deleteEntity(response, definition, id, store) {
  return sendStateMutation(response, (state) => {
    const scope = scenarioState(state, definition.scenario);
    const items = scope[definition.collection];
    const remaining = items.filter((item) => item.id !== id);
    if (remaining.length === items.length) throw httpError(404, definition.notFound);
    scope[definition.collection] = remaining;
    return { ...definition.deleteExtra, [definition.collection]: remaining };
  }, store);
}

const jobDefinitions = {
  "scenario-1": {
    collection: "sources",
    idsKey: "sourceIds",
    emptyMessage: "没有已启用的工作簿",
    lockedMessage: "单表已有任务正在执行，请稍后再试",
    collect: collectWorkbook,
    execute: executeWorkbook,
    failed: (source, error) => ({ sourceId: source.id, sourceName: source.name, status: "failed", error: error.message, rows: [] })
  },
  "scenario-2": {
    collection: "pairs",
    idsKey: "pairIds",
    emptyMessage: "没有已启用的日报配对",
    lockedMessage: "多表匹配已有任务正在执行，请稍后再试",
    collect: collectScenario2Pair,
    execute: executeScenario2Pair,
    failed: (pair, error) => ({ pairId: pair.id, pairName: pair.name, sourceName: pair.client.name, targetName: pair.own.name, status: "failed", error: error.message, rows: [] })
  },
  "scenario-3": {
    collection: "books",
    idsKey: "bookIds",
    emptyMessage: "没有已启用的架上包工作簿",
    lockedMessage: "架上包已有任务正在执行，请稍后再试",
    collect: collectShelfBook,
    execute: executeShelfBook,
    failed: (book, error) => ({ sourceId: book.id, sourceName: book.name, status: "failed", error: error.message, rows: [] })
  }
};

async function runScenarioJob(request, response, scenario, type, store) {
  const definition = jobDefinitions[scenario];
  if (!acquireJobLock(response, scenario)) return sendJson(response, 409, { error: definition.lockedMessage });
  const body = await readJson(request);
  const businessDate = body.date || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const ids = Array.isArray(body[definition.idsKey]) ? body[definition.idsKey] : [];
  const snapshot = await store.read();
  const selected = scenarioState(snapshot, scenario)[definition.collection]
    .filter((item) => item.enabled && (!ids.length || ids.includes(item.id)));
  if (!selected.length) return sendJson(response, 400, { error: definition.emptyMessage });

  const execute = type === "run";
  const results = [];
  for (const item of selected) {
    try {
      results.push(await (execute ? definition.execute(item, businessDate) : definition.collect(item, businessDate)));
    } catch (error) {
      results.push(definition.failed(item, error));
    }
  }
  const run = {
    id: crypto.randomUUID(),
    type: execute ? "run" : "preview",
    scenario,
    businessDate,
    createdAt: new Date().toISOString(),
    summary: summarize(results),
    results
  };
  await store.mutate((state) => {
    const scope = scenarioState(state, scenario);
    scope.runs = [run, ...scope.runs].slice(0, 50);
  });
  return sendJson(response, 200, run);
}

async function importSources(request, response, store) {
  const { text = "", name = "" } = await readJson(request);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return sendJson(response, 400, { error: "请至少输入一个 Google 表格链接" });
  const customName = String(name || "").trim();
  const payload = await store.mutate((state) => {
    const scope = scenarioState(state);
    const results = [];
    for (const line of lines) {
      try {
        const parsed = parseSheetLink(line);
        if (customName && lines.length === 1) parsed.name = customName;
        const existing = scope.sources.find((item) => item.spreadsheetId === parsed.spreadsheetId);
        if (existing) results.push({ status: "duplicate", name: existing.name, url: existing.url });
        else {
          const source = newSource(parsed);
          scope.sources.push(source);
          results.push({ status: "added", name: source.name, url: source.url });
        }
      } catch (error) {
        results.push({ status: "invalid", name: line, error: error.message });
      }
    }
    return { scenario: "scenario-1", results, sources: scope.sources };
  });
  return sendJson(response, 200, payload);
}

async function handleApi(request, response, pathname, store) {
  if (request.method === "GET" && pathname === "/api/bootstrap") {
    const state = await store.read();
    const primary = scenarioState(state);
    const secondary = scenarioState(state, "scenario-2");
    const shelf = scenarioState(state, "scenario-3");
    return sendJson(response, 200, {
      sources: primary.sources,
      runs: primary.runs.slice(0, 50),
      scenarios: {
        "scenario-1": { sources: primary.sources, runs: primary.runs.slice(0, 50) },
        "scenario-2": { pairs: secondary.pairs, runs: secondary.runs.slice(0, 50) },
        "scenario-3": { books: shelf.books, runs: shelf.runs.slice(0, 50) }
      },
      connection: getConnectionStatus(),
      rules: { blankSource: "skip", zeroSource: "write" }
    });
  }

  if (request.method === "POST" && pathname === "/api/sources/import") {
    return importSources(request, response, store);
  }

  const scenarioImportMatch = pathname.match(/^\/api\/scenarios\/(scenario-1)\/sources\/import$/);
  if (request.method === "POST" && scenarioImportMatch) {
    return importSources(request, response, store);
  }

  if (request.method === "POST" && pathname === "/api/scenarios/scenario-2/pairs") {
    try {
      const pair = newPair(await readJson(request));
      return sendStateMutation(response, (state) => {
        const scope = scenarioState(state, "scenario-2");
        const duplicate = scope.pairs.find((item) => item.client.spreadsheetId === pair.client.spreadsheetId || item.own.spreadsheetId === pair.own.spreadsheetId);
        if (duplicate) throw httpError(409, `工作簿已属于配对“${duplicate.name}”`);
        scope.pairs.push(pair);
        return { pair, pairs: scope.pairs };
      }, store);
    } catch (error) {
      return sendJson(response, error.status || 400, { error: error.message });
    }
  }

  if (request.method === "POST" && pathname === "/api/scenarios/scenario-3/books") {
    try {
      const book = newShelfBook(await readJson(request));
      return sendStateMutation(response, (state) => {
        const scope = scenarioState(state, "scenario-3");
        const duplicate = scope.books.find((item) => item.spreadsheetId === book.spreadsheetId);
        if (duplicate) throw httpError(409, `工作簿已配置为“${duplicate.name}”`);
        scope.books.push(book);
        return { book, books: scope.books };
      }, store);
    } catch (error) {
      return sendJson(response, error.status || 400, { error: error.message });
    }
  }

  const pairMatch = pathname.match(/^\/api\/scenarios\/scenario-2\/pairs\/([^/]+)$/);
  if (pairMatch && request.method === "PATCH") {
    return patchEntity(request, response, entityDefinitions.pair, pairMatch[1], store);
  }

  if (pairMatch && request.method === "DELETE") {
    return deleteEntity(response, entityDefinitions.pair, pairMatch[1], store);
  }

  const shelfBookMatch = pathname.match(/^\/api\/scenarios\/scenario-3\/books\/([^/]+)$/);
  if (shelfBookMatch && request.method === "PATCH") {
    return patchEntity(request, response, entityDefinitions.book, shelfBookMatch[1], store);
  }

  if (shelfBookMatch && request.method === "DELETE") {
    return deleteEntity(response, entityDefinitions.book, shelfBookMatch[1], store);
  }

  const scopedSourceMatch = pathname.match(/^\/api\/scenarios\/(scenario-1)\/sources\/([^/]+)$/);
  const legacySourceMatch = pathname.match(/^\/api\/sources\/([^/]+)$/);
  const sourceId = scopedSourceMatch?.[2] || legacySourceMatch?.[1];
  if (sourceId && request.method === "PATCH") {
    return patchEntity(request, response, entityDefinitions.source, sourceId, store);
  }

  if (sourceId && request.method === "DELETE") {
    return deleteEntity(response, entityDefinitions.source, sourceId, store);
  }

  const scopedJobMatch = pathname.match(/^\/api\/scenarios\/(scenario-1)\/jobs\/(preview|run)$/);
  const legacyJobMatch = pathname.match(/^\/api\/jobs\/(preview|run)$/);
  const jobType = scopedJobMatch?.[2] || legacyJobMatch?.[1];
  if (request.method === "POST" && jobType && (scopedJobMatch || legacyJobMatch)) {
    return runScenarioJob(request, response, "scenario-1", jobType, store);
  }

  const scenario2JobMatch = pathname.match(/^\/api\/scenarios\/scenario-2\/jobs\/(preview|run)$/);
  if (scenario2JobMatch && request.method === "POST") {
    return runScenarioJob(request, response, "scenario-2", scenario2JobMatch[1], store);
  }

  const shelfJobMatch = pathname.match(/^\/api\/scenarios\/scenario-3\/jobs\/(preview|run)$/);
  if (shelfJobMatch && request.method === "POST") {
    return runScenarioJob(request, response, "scenario-3", shelfJobMatch[1], store);
  }

  return sendJson(response, 404, { error: "接口不存在" });
}

function summarize(results) {
  const rows = results.flatMap((result) => result.rows || []);
  const countRows = (status) => rows.filter((row) => row.status === status).length;
  return {
    workbooks: results.length,
    successfulWorkbooks: results.filter((item) => item.status === "success").length,
    ready: countRows("ready"),
    written: countRows("written"),
    blankSkipped: countRows("blank"),
    conflicts: countRows("conflict"),
    errors: results.filter((item) => item.status === "failed").length + countRows("error")
  };
}

export function resolvePublicPath(pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const path = resolve(publicDir, requested);
  const localPath = relative(publicDir, path);
  if (localPath.startsWith("..") || isAbsolute(localPath)) return null;
  return path;
}

export function validateApiRequest(request) {
  if (["GET", "HEAD"].includes(request.method)) return null;
  const origin = request.headers.origin;
  if (origin) {
    try {
      const hostname = new URL(origin).hostname;
      if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) return { status: 403, error: "拒绝非本机来源的写入请求" };
    } catch {
      return { status: 403, error: "请求来源无效" };
    }
  }
  if (["POST", "PATCH"].includes(request.method) && !String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    return { status: 415, error: "写入请求必须使用 application/json" };
  }
  return null;
}

async function serveStatic(response, pathname) {
  const path = resolvePublicPath(pathname);
  if (!path) return sendJson(response, 403, { error: "禁止访问" });
  try {
    const content = await readFile(path);
    response.writeHead(200, { "content-type": mimeTypes[extname(path)] || "application/octet-stream" });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: "页面不存在" });
  }
}

export function createDailyDataServer({ store = stateStore } = {}) {
  return createServer(async (request, response) => {
    try {
      const { pathname } = new URL(request.url, `http://${request.headers.host}`);
      if (pathname.startsWith("/api/")) {
        const rejection = validateApiRequest(request);
        if (rejection) return sendJson(response, rejection.status, { error: rejection.error });
        await handleApi(request, response, pathname, store);
      } else {
        await serveStatic(response, pathname);
      }
    } catch (error) {
      sendJson(response, 500, { error: error.message || "服务器错误" });
    }
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  createDailyDataServer().listen(port, host, () => {
    console.log(`Daily Data Hub 已启动：http://localhost:${port}`);
  });
}
