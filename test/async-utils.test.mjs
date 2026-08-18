import test from "node:test";
import assert from "node:assert/strict";
import { mapConcurrent } from "../src/async-utils.mjs";

test("mapConcurrent caps active work and preserves input order", async () => {
  let active = 0;
  let peak = 0;
  const values = await mapConcurrent([1, 2, 3, 4, 5], async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return value * 10;
  }, 2);
  assert.deepEqual(values, [10, 20, 30, 40, 50]);
  assert.equal(peak, 2);
});
