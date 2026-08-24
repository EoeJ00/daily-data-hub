import test from "node:test";
import assert from "node:assert/strict";
import { shooterBusinessDates, shooterSpendRows, spendMetricData, summarizeSpendRows } from "../public/spend-aggregation.js";

test("includes shelf-pack spend in the assigned shooter and channel totals", () => {
  const scenarios = {
    "scenario-1": { sources: [], runs: [] },
    "scenario-2": { pairs: [], runs: [] },
    "scenario-3": {
      books: [{ id: "shelf-book", name: "架上包数据表" }],
      runs: [{
        id: "shelf-run",
        businessDate: "2026-08-13",
        createdAt: "2026-08-13T10:00:00.000Z",
        results: [{
          sourceId: "shelf-book",
          sourceName: "架上包数据表",
          status: "success",
          rows: [
            { shooter: "c", metric: "消耗", sourceValue: 14, status: "ready", targetSheet: "C", packageDetails: [{ packageName: "架上包 A" }, { packageName: "架上包 B" }] },
            { shooter: "c", metric: "回流消耗", sourceValue: 1.5, status: "ready", targetSheet: "C", packageDetails: [{ packageName: "架上包 A" }, { packageName: "架上包 B" }] }
          ]
        }]
      }]
    }
  };

  const rows = scenarios["scenario-3"].runs[0].results[0].rows;
  const packageA = rows[0].packageDetails[0].packageName;
  const packageB = rows[0].packageDetails[1].packageName;
  rows[0].packageDetails = [{ packageName: packageA, value: 10 }, { packageName: packageB, value: 4 }];
  rows[1].packageDetails = [{ packageName: packageA, value: 1 }, { packageName: packageB, value: 0.5 }];

  const source = shooterSpendRows(scenarios, "2026-08-13");
  const data = spendMetricData(source.rows, source.runs);
  const shooters = summarizeSpendRows(source.rows, "shooter");
  const channels = summarizeSpendRows(source.rows, "channelGroup");
  const packages = summarizeSpendRows(source.rows, "chain");

  assert.deepEqual(shooters.map(({ shooter, spend, returnSpend, total }) => ({ shooter, spend, returnSpend, total })), [
    { shooter: "C", spend: 14, returnSpend: 1.5, total: 15.5 }
  ]);
  assert.deepEqual(channels.map(({ channelGroup, total }) => ({ channelGroup, total })), [
    { channelGroup: "架上包数据表", total: 15.5 }
  ]);
  assert.deepEqual(packages.map(({ chain, spend, returnSpend, total }) => ({ chain, spend, returnSpend, total })), [
    { chain: packageA, spend: 10, returnSpend: 1, total: 11 },
    { chain: packageB, spend: 4, returnSpend: 0.5, total: 4.5 }
  ]);
  assert.deepEqual({ spend: data.spend, returnSpend: data.returnSpend, total: data.total }, { spend: 14, returnSpend: 1.5, total: 15.5 });
  assert.deepEqual(shooterBusinessDates(scenarios), ["2026-08-13"]);
});
