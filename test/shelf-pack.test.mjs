import test from "node:test";
import assert from "node:assert/strict";
import { classifyShelfSheet, collectShelfBook, executeShelfBook, extractShelfPackRecords } from "../src/shelf-pack.mjs";

test("classifies merged-date rack sheets separately from shooter sheets", () => {
  assert.equal(classifyShelfSheet([
    ["包A"],
    ["日期", "投手/包名", "服务费", "消耗", "回流消耗"]
  ]), "rack");
  assert.equal(classifyShelfSheet([
    ["包A"],
    ["日期", "渠道名", "服务费", "消耗", "回流消耗"]
  ]), "shooter");
  assert.equal(classifyShelfSheet([["日期", "总消耗", "C", "C回流"]]), "other");
});

test("carries merged dates, sums repeated shooters, and excludes package totals", () => {
  const values = [
    ["架上包 A"],
    ["日期", "投手/包名", "服务费", "消耗", "回流消耗"],
    [46247, "C", 0, 10, 1],
    [null, "C", 0, 3, 2],
    [null, "架上包 A", 0, 13, 3],
    [46248, "C", 0, 99, 9]
  ];
  const result = extractShelfPackRecords(values, "架上包 A", "2026-08-13");
  assert.equal(result.status, "success");
  assert.deepEqual(result.rows.map((row) => [row.shooter, row.metric, row.sourceValue]), [
    ["c", "消耗", 13],
    ["c", "回流消耗", 3]
  ]);
});

test("aggregates one shooter across multiple rack packages and maps both metrics", async () => {
  const packageA = [
    ["架上包 A"],
    ["日期", "投手/包名", "服务费", "消耗", "回流消耗"],
    [46247, "C", 0, 10, 1],
    [null, "架上包 A", 0, 10, 1]
  ];
  const packageB = [
    ["架上包 B"],
    ["日期", "投手/包名", "服务费", "消耗", "回流消耗"],
    [46247, "77F(C)", 0, 4, 0.5],
    [null, "架上包 B", 0, 4, 0.5]
  ];
  const shooterC = [
    ["C"], [], [],
    ["日期", "渠道名", "服务费", "消耗", "回流消耗"],
    [46247, "Aero Parcel 1939", 0, null, null]
  ];
  const total = [
    ["日期", "总消耗（USD）", "C", "C回流"],
    [46247, null, null, null]
  ];
  const values = new Map([
    ["book:架上包 A", packageA],
    ["book:架上包 B", packageB],
    ["book:C", shooterC],
    ["book:总表", total]
  ]);
  const deps = {
    getWorkbook: async () => ({ properties: { title: "架上包数据表" }, sheets: [
      { properties: { title: "架上包 A", hidden: false } },
      { properties: { title: "架上包 B", hidden: false } },
      { properties: { title: "C", hidden: true } },
      { properties: { title: "总表", hidden: false } }
    ] }),
    getSheetValues: async (id, sheet) => values.get(`${id}:${sheet}`) || [],
    getSheetValuesBatch: async (id, ranges) => ranges.map((range) => {
      const sheetPart = range.split("!")[0];
      const title = sheetPart.slice(1, -1).replaceAll("''", "'");
      const full = values.get(`${id}:${title}`) || [];
      const cell = range.split("!")[1];
      if (!cell) return full;
      const match = cell.match(/^([A-Z]+)(\d+)$/);
      const column = [...match[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
      return [[full[Number(match[2]) - 1]?.[column]]];
    })
  };
  const result = await collectShelfBook({ id: "book-id", name: "架上包数据表", spreadsheetId: "book" }, "2026-08-13", deps);
  assert.equal(result.sourceSheetCount, 2);
  assert.equal(result.targetSheetCount, 1);
  assert.equal(result.totalSheetName, "总表");
  assert.deepEqual(result.rows.map((row) => [row.shooter, row.metric, row.sourceValue, row.targetSheet, row.totalSheet, row.status]), [
    ["c", "消耗", 14, "C", "总表", "ready"],
    ["c", "回流消耗", 1.5, "C", "总表", "ready"]
  ]);
  assert.equal(result.rows[0].detail.range, "'C'!D5");
  assert.equal(result.rows[0].total.range, "'总表'!C2");
  assert.equal(result.rows[1].detail.range, "'C'!E5");
  assert.equal(result.rows[1].total.range, "'总表'!D2");
  assert.equal(result.rows[0].packageDetails.length, 2);

  const writes = [];
  const executed = await executeShelfBook({ id: "book-id", name: "架上包数据表", spreadsheetId: "book" }, "2026-08-13", {
    getWorkbook: deps.getWorkbook,
    getSheetValues: deps.getSheetValues,
    getSheetValuesBatch: deps.getSheetValuesBatch,
    batchWrite: async (_id, updates) => {
      writes.push(...updates);
      for (const update of updates) {
        const [quotedTitle, cell] = update.range.split("!");
        const title = quotedTitle.slice(1, -1).replaceAll("''", "'");
        const match = cell.match(/^([A-Z]+)(\d+)$/);
        const column = [...match[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
        const row = Number(match[2]) - 1;
        values.get(`book:${title}`)[row][column] = update.value;
      }
    }
  });
  assert.equal(writes.length, 4);
  assert.ok(executed.rows.every((row) => row.status === "written"));
  assert.deepEqual(writes.map((item) => item.range).sort(), ["'C'!D5", "'C'!E5", "'总表'!C2", "'总表'!D2"]);
});
