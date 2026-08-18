import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { collectWorkbook, executeWorkbook } from "./src/collector.mjs";
import { collectScenario2Pair, executeScenario2Pair } from "./src/scenario2.mjs";
import { collectShelfBook, executeShelfBook } from "./src/shelf-pack.mjs";
import { getConnectionStatus } from "./src/google-sheets.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const dataDir = join(root, "data");
const stateFile = join(dataDir, "state.json");
const port = Number(process.env.PORT || 4173);

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

await mkdir(dataDir, { recursive: true });

async function readState() {
  try {
    return normalizeState(JSON.parse(await readFile(stateFile, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(defaultState);
    throw error;
  }
}

function normalizeState(raw) {
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

async function saveState(state) {
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function sendJson(response, status, body) {
  response.writeHead(status, jsonHeaders);
  response.end(JSON.stringify(body));
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
    name: String(name || "").trim() || parsed.name || "架上包数据表",
    ...parsed,
    enabled: true,
    scenario: "scenario-3",
    createdAt: new Date().toISOString()
  };
}

function scenarioState(state, key = "scenario-1") {
  return state.scenarios[key];
}

async function importSources(request, response, state) {
  const { text = "" } = await readJson(request);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return sendJson(response, 400, { error: "请至少输入一个 Google 表格链接" });
  const scope = scenarioState(state);
  const results = [];
  for (const line of lines) {
    try {
      const parsed = parseSheetLink(line);
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
  await saveState(state);
  return sendJson(response, 200, { scenario: "scenario-1", results, sources: scope.sources });
}

async function handleApi(request, response, pathname) {
  const state = await readState();

  if (request.method === "GET" && pathname === "/api/bootstrap") {
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
    return importSources(request, response, state);
  }

  const scenarioImportMatch = pathname.match(/^\/api\/scenarios\/(scenario-1)\/sources\/import$/);
  if (request.method === "POST" && scenarioImportMatch) {
    return importSources(request, response, state);
  }

  if (request.method === "POST" && pathname === "/api/scenarios/scenario-2/pairs") {
    const scope = scenarioState(state, "scenario-2");
    try {
      const pair = newPair(await readJson(request));
      const duplicate = scope.pairs.find((item) => item.client.spreadsheetId === pair.client.spreadsheetId || item.own.spreadsheetId === pair.own.spreadsheetId);
      if (duplicate) return sendJson(response, 409, { error: `工作簿已属于配对“${duplicate.name}”` });
      scope.pairs.push(pair);
      await saveState(state);
      return sendJson(response, 200, { pair, pairs: scope.pairs });
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  if (request.method === "POST" && pathname === "/api/scenarios/scenario-3/books") {
    const scope = scenarioState(state, "scenario-3");
    try {
      const book = newShelfBook(await readJson(request));
      const duplicate = scope.books.find((item) => item.spreadsheetId === book.spreadsheetId);
      if (duplicate) return sendJson(response, 409, { error: `工作簿已配置为“${duplicate.name}”` });
      scope.books.push(book);
      await saveState(state);
      return sendJson(response, 200, { book, books: scope.books });
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  const pairMatch = pathname.match(/^\/api\/scenarios\/scenario-2\/pairs\/([^/]+)$/);
  if (pairMatch && request.method === "PATCH") {
    const scope = scenarioState(state, "scenario-2");
    const pair = scope.pairs.find((item) => item.id === pairMatch[1]);
    if (!pair) return sendJson(response, 404, { error: "未找到该日报配对" });
    const changes = await readJson(request);
    for (const key of ["name", "enabled", "targetSheet"]) {
      if (key in changes) pair[key] = changes[key];
    }
    await saveState(state);
    return sendJson(response, 200, { pair });
  }

  if (pairMatch && request.method === "DELETE") {
    const scope = scenarioState(state, "scenario-2");
    const before = scope.pairs.length;
    scope.pairs = scope.pairs.filter((item) => item.id !== pairMatch[1]);
    if (scope.pairs.length === before) return sendJson(response, 404, { error: "未找到该日报配对" });
    await saveState(state);
    return sendJson(response, 200, { pairs: scope.pairs });
  }

  const shelfBookMatch = pathname.match(/^\/api\/scenarios\/scenario-3\/books\/([^/]+)$/);
  if (shelfBookMatch && request.method === "PATCH") {
    const scope = scenarioState(state, "scenario-3");
    const book = scope.books.find((item) => item.id === shelfBookMatch[1]);
    if (!book) return sendJson(response, 404, { error: "未找到该架上包工作簿" });
    const changes = await readJson(request);
    for (const key of ["name", "enabled"]) {
      if (key in changes) book[key] = changes[key];
    }
    await saveState(state);
    return sendJson(response, 200, { book });
  }

  if (shelfBookMatch && request.method === "DELETE") {
    const scope = scenarioState(state, "scenario-3");
    const before = scope.books.length;
    scope.books = scope.books.filter((item) => item.id !== shelfBookMatch[1]);
    if (scope.books.length === before) return sendJson(response, 404, { error: "未找到该架上包工作簿" });
    await saveState(state);
    return sendJson(response, 200, { books: scope.books });
  }

  const scopedSourceMatch = pathname.match(/^\/api\/scenarios\/(scenario-1)\/sources\/([^/]+)$/);
  const legacySourceMatch = pathname.match(/^\/api\/sources\/([^/]+)$/);
  const sourceId = scopedSourceMatch?.[2] || legacySourceMatch?.[1];
  const sourceScope = scenarioState(state);
  if (sourceId && request.method === "PATCH") {
    const source = sourceScope.sources.find((item) => item.id === sourceId);
    if (!source) return sendJson(response, 404, { error: "未找到该工作簿" });
    const changes = await readJson(request);
    for (const key of ["name", "enabled", "targetSheet"]) {
      if (key in changes) source[key] = changes[key];
    }
    await saveState(state);
    return sendJson(response, 200, { source });
  }

  if (sourceId && request.method === "DELETE") {
    const before = sourceScope.sources.length;
    sourceScope.sources = sourceScope.sources.filter((item) => item.id !== sourceId);
    if (sourceScope.sources.length === before) return sendJson(response, 404, { error: "未找到该工作簿" });
    await saveState(state);
    return sendJson(response, 200, { scenario: "scenario-1", sources: sourceScope.sources });
  }

  const scopedJobMatch = pathname.match(/^\/api\/scenarios\/(scenario-1)\/jobs\/(preview|run)$/);
  const legacyJobMatch = pathname.match(/^\/api\/jobs\/(preview|run)$/);
  const jobType = scopedJobMatch?.[2] || legacyJobMatch?.[1];
  if (jobType && (scopedJobMatch || legacyJobMatch)) {
    const { date, sourceIds = [] } = await readJson(request);
    const businessDate = date || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const scope = scenarioState(state);
    const selected = scope.sources.filter((source) => source.enabled && (!sourceIds.length || sourceIds.includes(source.id)));
    if (!selected.length) return sendJson(response, 400, { error: "没有已启用的工作簿" });
    const execute = jobType === "run";
    const results = [];
    for (const source of selected) {
      try {
        results.push(await (execute ? executeWorkbook(source, businessDate) : collectWorkbook(source, businessDate)));
      } catch (error) {
        results.push({ sourceId: source.id, sourceName: source.name, status: "failed", error: error.message, rows: [] });
      }
    }
    const run = {
      id: crypto.randomUUID(),
      type: execute ? "run" : "preview",
      scenario: "scenario-1",
      businessDate,
      createdAt: new Date().toISOString(),
      summary: summarize(results),
      results
    };
    scope.runs.unshift(run);
    scope.runs = scope.runs.slice(0, 50);
    await saveState(state);
    return sendJson(response, 200, run);
  }

  const scenario2JobMatch = pathname.match(/^\/api\/scenarios\/scenario-2\/jobs\/(preview|run)$/);
  if (scenario2JobMatch && request.method === "POST") {
    const { date, pairIds = [] } = await readJson(request);
    const businessDate = date || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const scope = scenarioState(state, "scenario-2");
    const selected = scope.pairs.filter((pair) => pair.enabled && (!pairIds.length || pairIds.includes(pair.id)));
    if (!selected.length) return sendJson(response, 400, { error: "没有已启用的日报配对" });
    const execute = scenario2JobMatch[1] === "run";
    const results = [];
    for (const pair of selected) {
      try {
        results.push(await (execute ? executeScenario2Pair(pair, businessDate) : collectScenario2Pair(pair, businessDate)));
      } catch (error) {
        results.push({ pairId: pair.id, pairName: pair.name, sourceName: pair.client.name, targetName: pair.own.name, status: "failed", error: error.message, rows: [] });
      }
    }
    const run = {
      id: crypto.randomUUID(),
      type: execute ? "run" : "preview",
      scenario: "scenario-2",
      businessDate,
      createdAt: new Date().toISOString(),
      summary: summarize(results),
      results
    };
    scope.runs.unshift(run);
    scope.runs = scope.runs.slice(0, 50);
    await saveState(state);
    return sendJson(response, 200, run);
  }

  const shelfJobMatch = pathname.match(/^\/api\/scenarios\/scenario-3\/jobs\/(preview|run)$/);
  if (shelfJobMatch && request.method === "POST") {
    const { date, bookIds = [] } = await readJson(request);
    const businessDate = date || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const scope = scenarioState(state, "scenario-3");
    const selected = scope.books.filter((book) => book.enabled && (!bookIds.length || bookIds.includes(book.id)));
    if (!selected.length) return sendJson(response, 400, { error: "没有已启用的架上包工作簿" });
    const execute = shelfJobMatch[1] === "run";
    const results = [];
    for (const book of selected) {
      try {
        results.push(await (execute ? executeShelfBook(book, businessDate) : collectShelfBook(book, businessDate)));
      } catch (error) {
        results.push({ sourceId: book.id, sourceName: book.name, status: "failed", error: error.message, rows: [] });
      }
    }
    const run = {
      id: crypto.randomUUID(),
      type: execute ? "run" : "preview",
      scenario: "scenario-3",
      businessDate,
      createdAt: new Date().toISOString(),
      summary: summarize(results),
      results
    };
    scope.runs.unshift(run);
    scope.runs = scope.runs.slice(0, 50);
    await saveState(state);
    return sendJson(response, 200, run);
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

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const path = normalize(join(publicDir, requested));
  if (!path.startsWith(publicDir)) return sendJson(response, 403, { error: "禁止访问" });
  try {
    const content = await readFile(path);
    response.writeHead(200, { "content-type": mimeTypes[extname(path)] || "application/octet-stream" });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: "页面不存在" });
  }
}

createServer(async (request, response) => {
  try {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);
    if (pathname.startsWith("/api/")) await handleApi(request, response, pathname);
    else await serveStatic(response, pathname);
  } catch (error) {
    sendJson(response, 500, { error: error.message || "服务器错误" });
  }
}).listen(port, () => {
  console.log(`Daily Data Hub 已启动：http://localhost:${port}`);
});
