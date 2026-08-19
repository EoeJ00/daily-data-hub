import test from "node:test";
import assert from "node:assert/strict";
import { collectWorkbook, executeWorkbook } from "../src/collector.mjs";

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
    getSheetValuesBatch: async (_id, ranges) => ranges.map((range) => values[range.slice(1, -1)] || []),
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
