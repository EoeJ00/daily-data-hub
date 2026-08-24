import test from "node:test";
import assert from "node:assert/strict";
import { JobQueue } from "../src/job-queue.mjs";

test("job queue runs tasks one at a time in submission order", async () => {
  const queue = new JobQueue();
  const order = [];
  let releaseFirst;
  let markStarted;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise((resolve) => { markStarted = resolve; });

  const first = queue.enqueue(async () => {
    order.push("first:start");
    markStarted();
    await firstGate;
    order.push("first:end");
    return 1;
  }, { scenario: "scenario-1" });
  const second = queue.enqueue(async () => {
    order.push("second:start");
    return 2;
  }, { scenario: "scenario-2" });

  await firstStarted;
  assert.equal(queue.snapshot().running.scenario, "scenario-1");
  assert.equal(queue.snapshot().queued.length, 1);
  releaseFirst();

  assert.deepEqual(await Promise.all([first.promise, second.promise]), [1, 2]);
  await queue.onIdle();
  assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
});

test("closed job queue drains existing tasks and rejects new work", async () => {
  const queue = new JobQueue();
  const job = queue.enqueue(async () => "done");
  queue.close();

  assert.throws(() => queue.enqueue(async () => {}), /优雅重启/);
  assert.equal(await job.promise, "done");
  await queue.onIdle();
  assert.equal(queue.snapshot().accepting, false);
});
