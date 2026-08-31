import test from "node:test";
import assert from "node:assert/strict";
import { collectScenario2Pair, dateKey, executeScenario2Pair, extractBigCellRecords, extractClientRecords, extractStandaloneChainRecords, locateTotalColumn, normalizeRoute } from "../src/scenario2.mjs";
import { looseRouteScore } from "../src/scenario2-route.mjs";

test("normalizes full and short channel formats to the same route code", () => {
  assert.deepEqual(normalizeRoute("MMY-XIONG-SS1-34（ROY）"), {
    raw: "MMY-XIONG-SS1-34（ROY）",
    base: "MMY-XIONG-SS1-34",
    fullChain: "mmy-xiong-ss1-34",
    code: "34",
    shooter: "roy"
  });
  assert.equal(normalizeRoute("034(ROY)").code, "34");
  assert.equal(normalizeRoute("34 ( ROY )").shooter, "roy");
  assert.equal(normalizeRoute("11yXxZgy02(SUKI)").code, "2");
  assert.equal(normalizeRoute("5525006-FB-在投").code, "5525006");
});

test("matches a compound client sheet with the own shooter sheet by route code", () => {
  assert.ok(looseRouteScore(normalizeRoute("3325046(S)"), normalizeRoute("3325046-FB-在投")) > 0);
});

test("normalizes Google serial and short dates against the business year", () => {
  assert.equal(dateKey(46247, "2026-08-13"), "2026-08-13");
  assert.equal(dateKey("8.13", "2026-08-13"), "2026-08-13");
});

test("locates total columns by full, leading, or trailing chain fragments before shooter fallback", () => {
  const target = { headerRow: 0 };
  const route = normalizeRoute("Golden-island-2(C)");

  assert.equal(locateTotalColumn([["日期", "Golden-island-2", "Golden-island-2回流"]], target, route, "消耗"), 1);
  assert.equal(locateTotalColumn([["日期", "Golden-island", "Golden-island回流"]], target, route, "回流消耗"), 2);
  assert.equal(locateTotalColumn([["日期", "island-2", "island-2回流"]], target, route, "消耗"), 1);
  assert.equal(locateTotalColumn([["日期", "Golden-is", "Golden-is回流"]], target, route, "消耗"), 1);
  assert.equal(locateTotalColumn([["日期", "land-2", "land-2回流"]], target, route, "回流消耗"), 2);
  assert.equal(locateTotalColumn([["日期", "C", "C回流"]], target, route, "回流消耗"), 2);
});

test("prefers a chain fragment over a shooter-code column", () => {
  const target = { headerRow: 0 };
  const route = normalizeRoute("Golden-island-2(C)");
  const values = [["日期", "C", "C回流", "island-2", "island-2回流"]];

  assert.equal(locateTotalColumn(values, target, route, "消耗"), 3);
  assert.equal(locateTotalColumn(values, target, route, "回流消耗"), 4);
});

test("extracts a repeated daily block and carries its merged date downward", () => {
  const values = [
    ["日报总表"],
    ["日期", "渠道号", "花费（U）", "回流"],
    [46247, "MMY-XIONG-SS1-34", "", 0.86],
    ["", "35(ROY)", 12.5, 0],
    ["汇总", "", 12.5, 0.86],
    ["日报总表"],
    ["日期", "渠道号", "花费（U）", "回流"],
    [46248, "MMY-XIONG-SS1-34", 20, 1]
  ];
  const rows = extractClientRecords(values, "2026-08-13", "BI（日报总表）");
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => [row.routeCode, row.metric, row.status, row.sourceValue]), [
    ["34", "消耗", "blank", undefined],
    ["34", "回流消耗", "pending", 0.86],
    ["35", "消耗", "pending", 12.5],
    ["35", "回流消耗", "pending", 0]
  ]);
});

test("infers a multi-row client header and prefers U-denominated spend columns", () => {
  const values = [
    ["", "投放人", "渠道", "", "", "前端", "", "", "", "", "", "", "", "", "", "后端", "", "", "", "", "回收"],
    ["", "", "", "消耗+7%", "消耗（卢比）", "消耗U", "展示次数", "链接点击量", "点击率", "注册", "注册成本", "首充", "首充成本", "购物成效", "购物成本", "注册数", "注册成本", "新增充值人数", "CPA", "付费率", "ARPPU", "ROAS", "ROI", "新增充值金额", "新增提现金额", "新增提充比", "回流U"],
    ["8月25", "W", "ko1618d11", 1.94, 193.67, 1.81, "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", 0]
  ];

  const rows = extractClientRecords(values, "2026-08-25", "WINZAA");

  assert.deepEqual(rows.map((row) => [row.routeCode, row.metric, row.sourceValue, row.sourceRange]), [
    ["11", "消耗", 1.81, "'WINZAA'!F3"],
    ["11", "回流消耗", 0, "'WINZAA'!AA3"]
  ]);
});

test("prefers U-denominated metrics over generic columns", () => {
  const rows = extractClientRecords([
    ["日期", "渠道", "消耗", "消耗U", "回流", "回流U"],
    ["8月25", "ko1618d11", 99, 1.81, 88, 0.25]
  ], "2026-08-25", "多口径日报");

  assert.deepEqual(rows.map((row) => [row.metric, row.sourceValue, row.sourceRange]), [
    ["消耗", 1.81, "'多口径日报'!D2"],
    ["回流消耗", 0.25, "'多口径日报'!F2"]
  ]);
});

test("treats a client block without metric columns as blank source cells", () => {
  const rows = extractClientRecords([
    ["日期", "渠道号"],
    [46247, "3325046-FB-在投"]
  ], "2026-08-13", "甲方日报");

  assert.deepEqual(rows.map((row) => [row.routeCode, row.metric, row.status, row.message]), [
    ["3325046", "消耗", "blank", "甲方源单元格为空，已跳过"],
    ["3325046", "回流消耗", "blank", "甲方源单元格为空，已跳过"]
  ]);
});

test("matches a new compound client sheet by route code and skips its missing metric cell", () => {
  const rows = extractStandaloneChainRecords([
    ["日期", "消耗"],
    [46247, ""]
  ], "2026-08-13", "3325046-FB-在投", "3325046-FB-在投");

  assert.deepEqual(rows.map((row) => [row.routeCode, row.metric, row.status]), [
    ["3325046", "消耗", "blank"],
    ["3325046", "回流消耗", "blank"]
  ]);
});

test("extracts labeled metrics from a multiline daily cell without guessing unlabeled numbers", () => {
  const values = [["2026.8.13\n34（ROY） 消耗：10.25 回流消耗：0.86\nMMY-XIONG-SS1-37(YC)\n消耗 19.33\n回流 0.32"]];
  const rows = extractBigCellRecords(values, "2026-08-13", "日报大单元格");
  assert.deepEqual(rows.map((row) => [row.routeCode, row.metric, row.status, row.sourceValue]), [
    ["34", "消耗", "pending", 10.25],
    ["34", "回流消耗", "pending", 0.86],
    ["37", "消耗", "pending", 19.33],
    ["37", "回流消耗", "pending", 0.32]
  ]);
});

function scenario2Fixture() {
  const clientId = "client";
  const ownId = "own";
  const values = new Map([
    [`${clientId}:BI（日报总表）`, [
      ["日报总表"],
      ["日期", "渠道号", "花费（U）", "回流"],
      [46247, "MMY-XIONG-SS1-34", 10.25, 0.86],
      ["", "MMY-XIONG-SS1-37", 19.33, 0.32],
      ["汇总", "", 29.58, 1.18]
    ]],
    [`${ownId}:总表`, [
      ["日期", "总消耗", "34", "34回流", "37", "37回流"],
      [46247, "", "", "", "", ""]
    ]],
    [`${ownId}:34(ROY)`, [
      ["日报总表"],
      ["日期", "渠道号", "花费（U）", "回流"],
      [46247, "", "", ""]
    ]],
    [`${ownId}:37(YC)`, [
      ["日报总表"],
      ["日期", "渠道号", "花费（U）", "回流"],
      [46247, "MMY-XIONG-EVO-37", "", ""]
    ]]
  ]);
  const workbook = (id) => id === clientId
    ? { properties: { title: "甲方日报" }, sheets: [{ properties: { sheetId: 1, title: "BI（日报总表）" } }] }
    : { properties: { title: "自己的日报" }, sheets: ["总表", "34(ROY)", "37(YC)"].map((title, index) => ({ properties: { sheetId: index + 1, title } })) };
  const columnIndex = (letters) => [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  const deps = {
    getWorkbook: async (id) => workbook(id),
    getSheetValues: async (id, sheet) => values.get(`${id}:${sheet}`),
    batchWrite: async (id, updates) => {
      for (const update of updates) {
        const match = update.range.match(/^'(.+)'!([A-Z]+)(\d+)$/);
        const rows = values.get(`${id}:${match[1].replaceAll("''", "'")}`);
        const row = Number(match[3]) - 1;
        const column = columnIndex(match[2]);
        while (rows.length <= row) rows.push([]);
        rows[row][column] = update.value;
      }
      return { totalUpdatedCells: updates.length };
    }
  };
  return {
    pair: { id: "pair", name: "测试配对", client: { spreadsheetId: clientId, gid: "1" }, own: { spreadsheetId: ownId }, targetSheet: "总表" },
    deps,
    values
  };
}

test("maps a client daily block to unique shooter sheets and total columns", async () => {
  const { pair, deps } = scenario2Fixture();
  const preview = await collectScenario2Pair(pair, "2026-08-13", deps);
  assert.equal(preview.channelCount, 2);
  assert.equal(preview.rows.length, 4);
  assert.ok(preview.rows.every((row) => row.status === "ready"));
  assert.equal(preview.rows.find((row) => row.routeCode === "37" && row.metric === "消耗").targetSheet, "37(YC)");
});

test("batches total and matched shooter sheets into two own-workbook reads", async () => {
  const { pair, deps, values } = scenario2Fixture();
  const calls = { client: 0, own: 0 };
  const columnIndex = (letters) => [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  const getSheetValuesBatch = async (id, ranges) => {
    calls[id] += 1;
    return ranges.map((range) => {
      const [sheetPart, selector] = range.split("!");
      const title = sheetPart.slice(1, -1).replaceAll("''", "'");
      const rows = values.get(`${id}:${title}`) || [];
      if (!selector) return rows;
      if (/^\d+:\d+$/.test(selector)) return rows.slice(0, Number(selector.split(":")[1]));
      const column = columnIndex(selector.split(":")[0]);
      return rows.map((row) => [row[column]]);
    });
  };

  const preview = await collectScenario2Pair(pair, "2026-08-13", { ...deps, getSheetValuesBatch });
  assert.equal(preview.rows.length, 4);
  assert.equal(calls.client, 2);
  assert.equal(calls.own, 2);
});

test("matches semantic fields and compound channel suffixes without workbook-specific rules", async () => {
  const clientId = "compound-client";
  const ownId = "compound-own";
  const rawValues = new Map([
    [`${clientId}:甲方明细`, [
      ["余额", "打款", "统计日期", "投放渠道名称", "服务费", "当日消耗", "实际消耗", "回流花费"],
      [0, 0, 46247, "XIAOXIONG-w2a-4-fb-RS9-CS-11-1", 2.8, 40.1, 42.9, 1.18],
      [0, 0, 46247, "XIAOXIONG-w2a-4-fb-RS9-CS-11-4", 2.9, 40.97, 43.84, 0.41]
    ]],
    [`${ownId}:总表`, [
      ["日期", "总消耗", 46327, "回流", 46330, "回流"],
      [46247, 82.66, 40.1, 1.18, 40.97, 0.41]
    ]],
    [`${ownId}:RS9-CS-11-1(SUKI)`, [
      ["日期", "渠道名", "服务费", "消耗", "回流消耗"],
      [46247, "", 0, 40.1, 1.18]
    ]],
    [`${ownId}:RS9-CS-11-4(SUKI)`, [
      ["日期", "渠道名", "服务费", "消耗", "回流消耗"],
      [46247, "", 0, 40.97, 0.41]
    ]]
  ]);
  const displayTotal = [
    ["日期", "总消耗", "11-1", "回流", "11-4", "回流"],
    ["2026/8/13", "82.660", "40.100", "1.180", "40.970", "0.410"]
  ];
  let totalReads = 0;
  const deps = {
    getWorkbook: async (id) => id === clientId
      ? { properties: { title: "甲方表" }, sheets: [{ properties: { sheetId: 1, title: "甲方明细" } }] }
      : { properties: { title: "自己的日报" }, sheets: ["总表", "RS9-CS-11-1(SUKI)", "RS9-CS-11-4(SUKI)"].map((title, index) => ({ properties: { sheetId: index + 1, title } })) },
    getSheetValues: async (id, sheet, options = {}) => {
      if (sheet === "总表") totalReads += 1;
      return options.valueRenderOption === "FORMATTED_VALUE" && sheet === "总表"
        ? displayTotal
        : rawValues.get(`${id}:${sheet}`);
    },
    batchWrite: async () => ({ totalUpdatedCells: 0 })
  };
  const pair = { id: "compound", name: "复合渠道", client: { spreadsheetId: clientId, gid: "1" }, own: { spreadsheetId: ownId }, targetSheet: "总表" };
  const preview = await collectScenario2Pair(pair, "2026-08-13", deps);

  assert.equal(preview.channelCount, 2);
  assert.equal(preview.rows.length, 4);
  assert.ok(preview.rows.every((row) => row.status === "same"));
  assert.deepEqual([...new Set(preview.rows.map((row) => row.routeKey))], ["RS9-CS-11-1", "RS9-CS-11-4"]);
  assert.equal(preview.rows.find((row) => row.channel.endsWith("11-4") && row.metric === "回流消耗").targetSheet, "RS9-CS-11-4(SUKI)");
  assert.equal(totalReads, 1);
});

test("writes detail rows first, rechecks them, and then writes the total", async () => {
  const { pair, deps } = scenario2Fixture();
  let workbookReads = 0;
  const result = await executeScenario2Pair(pair, "2026-08-13", {
    ...deps,
    getWorkbook: async (...args) => {
      workbookReads += 1;
      return deps.getWorkbook(...args);
    }
  });
  assert.ok(result.rows.every((row) => row.status === "written"));
  assert.ok(result.rows.every((row) => row.detail.status === "same" && row.total.status === "same"));
  assert.equal(workbookReads, 2);
});

test("appends missing shooter dates in sequence before multi-table writes", async () => {
  const { pair, deps, values } = scenario2Fixture();
  const client = values.get("client:BI（日报总表）");
  client[2][0] = 46249;

  const preview = await collectScenario2Pair(pair, "2026-08-15", deps);
  assert.ok(preview.rows.every((row) => row.status === "ready"));
  assert.deepEqual(preview.rows.find((row) => row.targetSheet === "34(ROY)").detail.dateUpdates, [
    { range: "'34(ROY)'!A4", value: "2026-08-14" },
    { range: "'34(ROY)'!A5", value: "2026-08-15" }
  ]);
  assert.deepEqual(preview.rows[0].total.dateUpdates, [
    { range: "'总表'!A3", value: "2026-08-14" },
    { range: "'总表'!A4", value: "2026-08-15" }
  ]);
  assert.match(preview.rows[0].message, /自动补充 2 个日期行/);

  const batches = [];
  const result = await executeScenario2Pair(pair, "2026-08-15", {
    ...deps,
    batchWrite: async (id, updates) => {
      batches.push(updates.map((item) => item.range));
      return deps.batchWrite(id, updates);
    }
  });
  assert.ok(batches[0].every((range) => /!A\d+$/.test(range)));
  assert.ok(result.rows.every((row) => row.status === "written"));
  assert.deepEqual(values.get("own:34(ROY)").slice(3, 5).map((row) => row[0]), ["2026-08-14", "2026-08-15"]);
  assert.deepEqual(values.get("own:37(YC)").slice(3, 5).map((row) => row[0]), ["2026-08-14", "2026-08-15"]);
  assert.deepEqual(values.get("own:总表").slice(2, 4).map((row) => row[0]), ["2026-08-14", "2026-08-15"]);
});

test("ignores hidden own and client chain sheets during matching", async () => {
  const clientId = "single-sheet-client";
  const ownId = "single-sheet-own";
  const values = new Map([
    [`${clientId}:SS1-34(ROY)`, [["日期", "消耗", "回流消耗"], [46247, 18.2, 0.4]]],
    [`${clientId}:MMY-XIONG-SS1-37(YC)`, [["日期", "消耗", "回流消耗"], [46247, 9.3, 0]]],
    [`${ownId}:总表`, [["日期", "34", "34回流", "37", "37回流"], [46247, "", "", "", ""]]],
    [`${ownId}:34(ROY)`, [["日期", "渠道号", "消耗", "回流消耗"], [46247, "", "", ""]]],
    [`${ownId}:37(YC)`, [["日期", "渠道号", "消耗", "回流消耗"], [46247, "", "", ""]]]
  ]);
  const workbook = (id) => id === clientId
    ? { properties: { title: "甲方逐链日报" }, sheets: ["汇总", "SS1-34(ROY)", "MMY-XIONG-SS1-37(YC)"].map((title, index) => ({ properties: { sheetId: index + 1, title, hidden: title === "SS1-34(ROY)" } })) }
    : { properties: { title: "自己的日报" }, sheets: ["总表", "34(ROY)", "37(YC)"].map((title, index) => ({ properties: { sheetId: index + 1, title, hidden: title === "34(ROY)" } })) };
  const deps = {
    getWorkbook: async (id) => workbook(id),
    getSheetValues: async (id, sheet) => values.get(`${id}:${sheet}`) || [],
    batchWrite: async () => ({ totalUpdatedCells: 0 })
  };
  const pair = { id: "single-sheet-pair", name: "逐链配对", client: { spreadsheetId: clientId, gid: "1" }, own: { spreadsheetId: ownId }, targetSheet: "总表" };
  const preview = await collectScenario2Pair(pair, "2026-08-13", deps);
  assert.equal(preview.sourceSheet, "多链独立工作表");
  assert.equal(preview.rows.length, 2);
  assert.ok(preview.rows.every((row) => row.status === "ready"));
  assert.deepEqual([...new Set(preview.rows.map((row) => row.routeKey))].sort(), ["37"]);
});

test("rejects a standalone chain sheet when the requested date is absent", () => {
  const rows = extractStandaloneChainRecords([["日期", "消耗", "回流消耗"], [46248, 10, 1]], "2026-08-13", "MMY-XIONG-SS1-34(ROY)", "MMY-XIONG-SS1-34(ROY)");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.status === "error"));
});
