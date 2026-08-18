import test from "node:test";
import assert from "node:assert/strict";
import { classifyShelfSheet, collectShelfBook, extractShelfPackRecords } from "../src/shelf-pack.mjs";

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
  const values = new Map([
    ["book:架上包 A", packageA],
    ["book:架上包 B", packageB],
    ["book:C", shooterC]
  ]);
  const deps = {
    getWorkbook: async () => ({ properties: { title: "架上包数据表" }, sheets: [
      { properties: { title: "架上包 A", hidden: false } },
      { properties: { title: "架上包 B", hidden: false } },
      { properties: { title: "C", hidden: true } }
    ] }),
    getSheetValues: async (id, sheet) => values.get(`${id}:${sheet}`) || []
  };
  const result = await collectShelfBook({ id: "book-id", name: "架上包数据表", spreadsheetId: "book" }, "2026-08-13", deps);
  assert.equal(result.sourceSheetCount, 2);
  assert.equal(result.targetSheetCount, 1);
  assert.deepEqual(result.rows.map((row) => [row.shooter, row.metric, row.sourceValue, row.targetSheet, row.status]), [
    ["c", "消耗", 14, "C", "ready"],
    ["c", "回流消耗", 1.5, "C", "ready"]
  ]);
  assert.equal(result.rows[0].packageDetails.length, 2);
});
