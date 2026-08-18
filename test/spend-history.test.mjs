import test from "node:test";
import assert from "node:assert/strict";
import { latestSuccessfulResultsByConfiguration } from "../public/spend-history.js";

const spendResult = (sourceId, value, status = "success") => ({
  sourceId,
  status,
  rows: value === null ? [] : [{ metric: "spend", sourceValue: value }]
});

const select = (runs, businessDate = "2026-08-16") => latestSuccessfulResultsByConfiguration(runs, {
  businessDate,
  configurationKey: (result) => result.sourceId,
  hasSpendData: (result) => result.rows.some((row) => Number.isFinite(Number(row.sourceValue)))
});

test("a partial rerun replaces only that configuration", () => {
  const older = {
    id: "older",
    businessDate: "2026-08-16",
    createdAt: "2026-08-16T10:00:00.000Z",
    results: [spendResult("a", 10), spendResult("b", 20)]
  };
  const newer = {
    id: "newer",
    businessDate: "2026-08-16",
    createdAt: "2026-08-16T11:00:00.000Z",
    results: [spendResult("a", 15)]
  };

  assert.deepEqual(
    select([older, newer]).map(({ run, result }) => [result.sourceId, run.id]),
    [["a", "newer"], ["b", "older"]]
  );
});

test("a failed or empty rerun does not erase the previous successful snapshot", () => {
  const runs = [
    { id: "failed", businessDate: "2026-08-16", createdAt: "2026-08-16T12:00:00.000Z", results: [spendResult("a", 0, "error")] },
    { id: "empty", businessDate: "2026-08-16", createdAt: "2026-08-16T11:00:00.000Z", results: [spendResult("a", null)] },
    { id: "success", businessDate: "2026-08-16", createdAt: "2026-08-16T10:00:00.000Z", results: [spendResult("a", 10)] }
  ];

  assert.equal(select(runs)[0].run.id, "success");
});

test("each configuration appears once and results stay within the requested date", () => {
  const runs = [
    { id: "other-date", businessDate: "2026-08-17", createdAt: "2026-08-17T10:00:00.000Z", results: [spendResult("a", 99)] },
    { id: "new", businessDate: "2026-08-16", createdAt: "2026-08-16T11:00:00.000Z", results: [spendResult("a", 15)] },
    { id: "old", businessDate: "2026-08-16", createdAt: "2026-08-16T10:00:00.000Z", results: [spendResult("a", 10)] }
  ];

  const selected = select(runs);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].run.id, "new");
});
