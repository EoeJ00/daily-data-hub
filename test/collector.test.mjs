import test from "node:test";
import assert from "node:assert/strict";

test("environment supports the collector runtime", () => {
  assert.equal(typeof structuredClone, "function");
  assert.equal(typeof fetch, "function");
});
