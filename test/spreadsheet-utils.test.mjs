import test from "node:test";
import assert from "node:assert/strict";
import { columnName, combineTargetStatuses, dateKey, inspectTarget, parseNumber, parseSheetRange, quoteSheetTitle, sheetRange } from "../src/spreadsheet-utils.mjs";

test("provides stable spreadsheet number, date, range, and status primitives", () => {
  assert.deepEqual(parseNumber("￥1,234.50"), { kind: "number", value: 1234.5 });
  assert.deepEqual(parseNumber(" "), { kind: "blank" });
  assert.equal(dateKey(46247, "2026-08-13"), "2026-08-13");
  assert.equal(dateKey("8月13日", "2026-08-13"), "2026-08-13");
  assert.equal(columnName(27), "AB");
  assert.equal(quoteSheetTitle("O'Brien"), "'O''Brien'");
  assert.equal(sheetRange("O'Brien", 9, 27), "'O''Brien'!AB10");
  assert.deepEqual(parseSheetRange("'O''Brien'!AB10"), { title: "O'Brien", cell: "AB10", row: 9, column: 27 });
  assert.deepEqual(inspectTarget("10", 10, "'表'!A1"), { status: "same", value: 10, range: "'表'!A1" });
  assert.equal(combineTargetStatuses({ status: "same" }, { status: "written" }), "same");
  assert.equal(combineTargetStatuses({ status: "ready" }, { status: "same" }), "ready");
});
