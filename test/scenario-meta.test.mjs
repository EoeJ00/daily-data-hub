import test from "node:test";
import assert from "node:assert/strict";
import { emptyScenarioData, scenarioApi, scenarioDefinitions, scenarioForPage } from "../public/scenario-meta.js";

test("maps pages and API paths through shared scenario metadata", () => {
  assert.equal(scenarioForPage("overview"), "scenario-1");
  assert.equal(scenarioForPage("scenario2-runs"), "scenario-2");
  assert.equal(scenarioForPage("scenario3-config"), "scenario-3");
  assert.equal(scenarioDefinitions["scenario-1"].label, "单表");
  assert.equal(scenarioDefinitions["scenario-2"].label, "多表匹配");
  assert.equal(scenarioApi("scenario-3", "/books"), "/api/scenarios/scenario-3/books");
  assert.deepEqual(emptyScenarioData("scenario-2"), { pairs: [], runs: [] });
});
