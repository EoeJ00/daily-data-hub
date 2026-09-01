import test from "node:test";
import assert from "node:assert/strict";
import { collectWorkbook, executeWorkbook } from "../src/collector.mjs";
import { dateKey } from "../src/spreadsheet-utils.mjs";

test("environment supports the collector runtime", () => {
  assert.equal(typeof structuredClone, "function");
  assert.equal(typeof fetch, "function");
});

test("collects channel metrics and writes only ready target cells", async () => {
  const source = {
    id: "source-1",
    name: "渠道 A",
    spreadsheetId: "book-1",
    targetSheet: "总表",
    excludedSheets: ["总表"],
    aliases: {
      date: ["日期"],
      spend: ["消耗"],
      returnSpend: ["回流消耗"]
    }
  };
  const values = {
    "总表": [["日期", "渠道A", "渠道A回流"], [46247, null, null]],
    "渠道A(C)": [["日期", "消耗", "回流消耗"], [46247, 12.5, 0.8]]
  };
  const writes = [];
  const deps = {
    getWorkbook: async () => ({ properties: { title: "日报" }, sheets: [
      { properties: { title: "总表", hidden: false } },
      { properties: { title: "渠道A(C)", hidden: false } }
    ] }),
    getSheetValuesBatch: async (_id, ranges) => ranges.map((range) => {
      const [sheetPart, selector] = range.split("!");
      const rows = values[sheetPart.slice(1, -1)] || [];
      if (!selector) return rows;
      if (/^\d+:\d+$/.test(selector)) return rows.slice(0, Number(selector.split(":")[1]));
      const column = [...selector.split(":")[0]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
      return rows.map((row) => [row[column]]);
    }),
    batchWrite: async (_id, updates) => writes.push(...updates)
  };

  const preview = await collectWorkbook(source, "2026-08-13", deps);
  assert.deepEqual(preview.rows.map((row) => [row.metric, row.sourceValue, row.status, row.range]), [
    ["消耗", 12.5, "ready", "'总表'!B2"],
    ["回流消耗", 0.8, "ready", "'总表'!C2"]
  ]);

  const executed = await executeWorkbook(source, "2026-08-13", deps);
  assert.deepEqual(writes, [
    { range: "'总表'!B2", value: 12.5 },
    { range: "'总表'!C2", value: 0.8 }
  ]);
  assert.ok(executed.rows.every((row) => row.status === "written"));
});

test("appends missing total dates before single-table writes", async () => {
  const source = {
    id: "source-1",
    name: "渠道 A",
    spreadsheetId: "book-1",
    targetSheet: "总表",
    excludedSheets: ["总表"],
    aliases: { date: ["日期"], spend: ["消耗"], returnSpend: ["回流消耗"] }
  };
  const values = {
    "总表": [["日期", "渠道A", "渠道A回流"], [46247, null, null], [], []],
    "渠道A(C)": [["日期", "消耗", "回流消耗"], [46249, 12.5, 0.8]]
  };
  const columnIndex = (letters) => [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  const writes = [];
  const batches = [];
  const deps = {
    getWorkbook: async () => ({ properties: { title: "日报" }, sheets: [
      { properties: { title: "总表", hidden: false } },
      { properties: { title: "渠道A(C)", hidden: false } }
    ] }),
    getSheetValuesBatch: async (_id, ranges) => ranges.map((range) => {
      const [sheetPart, selector] = range.split("!");
      const rows = values[sheetPart.slice(1, -1)] || [];
      if (!selector) return rows;
      if (/^\d+:\d+$/.test(selector)) return rows.slice(0, Number(selector.split(":")[1]));
      const column = columnIndex(selector.split(":")[0]);
      return rows.map((row) => [row[column]]);
    }),
    batchWrite: async (_id, updates) => {
      batches.push(updates.map((item) => item.range));
      writes.push(...updates);
      for (const update of updates) {
        const match = update.range.match(/^'(.+)'!([A-Z]+)(\d+)$/);
        const rows = values[match[1]];
        const row = Number(match[3]) - 1;
        while (rows.length <= row) rows.push([]);
        rows[row][columnIndex(match[2])] = update.value;
      }
    }
  };

  const preview = await collectWorkbook(source, "2026-08-15", deps);
  assert.deepEqual(preview.rows[0].dateUpdates, [
    { range: "'总表'!A3", value: "2026-08-14" },
    { range: "'总表'!A4", value: "2026-08-15" }
  ]);

  const executed = await executeWorkbook(source, "2026-08-15", deps);
  assert.deepEqual(batches[0], ["'总表'!A3", "'总表'!A4"]);
  assert.deepEqual(writes.map((item) => item.range).sort(), ["'总表'!A3", "'总表'!A4", "'总表'!B4", "'总表'!C4"]);
  assert.deepEqual(values["总表"].slice(2, 4).map((row) => row[0]), ["2026-08-14", "2026-08-15"]);
  assert.ok(executed.rows.every((row) => row.status === "written"));
});

test("reads only the target row from large single-table projections", async () => {
  const targetIndex = 500;
  const businessDate = dateKey(46247 + targetIndex, "2026-08-13");
  const rowCount = 1000;
  const targetValues = [
    ["date", "channel-a", "channel-a回流"],
    ...Array.from({ length: rowCount }, (_, index) => [46247 + index, null, null])
  ];
  const sourceValues = [
    ["date", "spend", "return"],
    ...Array.from({ length: rowCount }, (_, index) => [46247 + index, index === targetIndex ? 12.5 : null, index === targetIndex ? 0.8 : null])
  ];
  const rangesSeen = [];
  const columnIndex = (letters) => [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  const values = { total: targetValues, "channel-a": sourceValues };
  const deps = {
    getWorkbook: async () => ({ properties: { title: "日报" }, sheets: [
      { properties: { title: "total", hidden: false } },
      { properties: { title: "channel-a", hidden: false } }
    ] }),
    getSheetValuesBatch: async (_id, ranges) => {
      rangesSeen.push(ranges);
      return ranges.map((range) => {
        const [sheetPart, selector] = range.split("!");
        const title = sheetPart.slice(1, -1).replaceAll("''", "'");
        const rows = values[title];
        const header = selector.match(/^([A-Z]+):(\1)$/i);
        if (/^\d+:\d+$/.test(selector)) return rows.slice(0, Number(selector.split(":")[1]));
        if (header) {
          const column = columnIndex(header[1].toUpperCase());
          return rows.map((row) => [row?.[column]]);
        }
        const window = selector.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
        assert.ok(window, `unexpected range ${range}`);
        assert.equal(window[1].toUpperCase(), window[3].toUpperCase());
        const column = columnIndex(window[1].toUpperCase());
        return rows.slice(Number(window[2]) - 1, Number(window[4])).map((row) => [row?.[column]]);
      });
    }
  };

  const result = await collectWorkbook({
    id: "large-source",
    name: "渠道 A",
    spreadsheetId: "large-book",
    targetSheet: "total",
    excludedSheets: ["total"],
    aliases: { date: ["date"], spend: ["spend"], returnSpend: ["return"] }
  }, businessDate, deps);

  assert.deepEqual(result.rows.map((row) => [row.metric, row.sourceValue, row.status, row.range]), [
    ["消耗", 12.5, "ready", "'total'!B502"],
    ["回流消耗", 0.8, "ready", "'total'!C502"]
  ]);
  assert.ok(rangesSeen.some((ranges) => ranges.every((range) => /!A:A$/.test(range))));
  const windowRanges = rangesSeen.find((ranges) => ranges.some((range) => /!B502:B502$/.test(range)));
  assert.deepEqual(windowRanges, ["'total'!B502:B502", "'total'!C502:C502", "'channel-a'!B502:B502", "'channel-a'!C502:C502"]);
  assert.ok(windowRanges.every((range) => !/![B-C]:[B-C]$/i.test(range)));
});

test("falls back to the full projection once when the date index read fails", async () => {
  const targetIndex = 500;
  const businessDate = dateKey(46247 + targetIndex, "2026-08-13");
  const rowCount = 1000;
  const values = {
    total: [
      ["date", "channel-a", "channel-a回流"],
      ...Array.from({ length: rowCount }, (_, index) => [46247 + index, null, null])
    ],
    "channel-a": [
      ["date", "spend", "return"],
      ...Array.from({ length: rowCount }, (_, index) => [46247 + index, index === targetIndex ? 12.5 : null, index === targetIndex ? 0.8 : null])
    ]
  };
  const rangesSeen = [];
  const columnIndex = (letters) => [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  const deps = {
    getWorkbook: async () => ({ properties: { title: "日报" }, sheets: [
      { properties: { title: "total", hidden: false } },
      { properties: { title: "channel-a", hidden: false } }
    ] }),
    getSheetValuesBatch: async (_id, ranges) => {
      rangesSeen.push(ranges);
      if (ranges.length === 2 && ranges.every((range) => /!A:A$/.test(range))) throw new Error("date index unavailable");
      return ranges.map((range) => {
        const [sheetPart, selector] = range.split("!");
        const title = sheetPart.slice(1, -1).replaceAll("''", "'");
        const rows = values[title];
        if (/^\d+:\d+$/.test(selector)) return rows.slice(0, Number(selector.split(":")[1]));
        const column = columnIndex(selector.split(":")[0]);
        return rows.map((row) => [row?.[column]]);
      });
    }
  };

  const result = await collectWorkbook({
    id: "fallback-source",
    name: "渠道 A",
    spreadsheetId: "fallback-book",
    targetSheet: "total",
    excludedSheets: ["total"],
    aliases: { date: ["date"], spend: ["spend"], returnSpend: ["return"] }
  }, businessDate, deps);

  assert.deepEqual(result.rows.map((row) => [row.metric, row.sourceValue, row.status]), [
    ["消耗", 12.5, "ready"],
    ["回流消耗", 0.8, "ready"]
  ]);
  assert.equal(rangesSeen.filter((ranges) => ranges.length === 2 && ranges.every((range) => /!A:A$/.test(range))).length, 1);
  const fallbackRanges = rangesSeen.find((ranges) => ranges.some((range) => /!B:B$/.test(range)));
  assert.deepEqual(fallbackRanges, [
    "'total'!A:A", "'total'!B:B", "'total'!C:C",
    "'channel-a'!A:A", "'channel-a'!B:B", "'channel-a'!C:C"
  ]);
});
