import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { MaterializedSnapshotStore, SnapshotSynchronizer } from "../src/materialized-snapshots.mjs";
import { JsonStateStore } from "../src/state-store.mjs";

async function fixture(context) {
  const directory = join(import.meta.dirname, ".tmp", `snapshots-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  context.after(() => rm(directory, { recursive: true, force: true }));
  const state = new JsonStateStore(join(directory, "snapshots.json"), { defaultState: { entries: {} } });
  return new MaterializedSnapshotStore(state);
}

test("materialized snapshots persist by scenario, item, date, and configuration", async (context) => {
  const snapshots = await fixture(context);
  const item = { id: "book", name: "日报", enabled: true };
  await snapshots.put("scenario-1", item, "2026-08-27", { status: "success", rows: [{ sourceValue: 12 }] });

  assert.equal((await snapshots.get("scenario-1", item, "2026-08-27")).result.rows[0].sourceValue, 12);
  assert.equal(await snapshots.get("scenario-1", { ...item, name: "已改名" }, "2026-08-27"), null);
  await snapshots.invalidate("scenario-1", item.id, "2026-08-27");
  assert.equal(await snapshots.get("scenario-1", item, "2026-08-27"), null);
});

test("preview reads the local snapshot after one live fallback and writes force a refresh", async (context) => {
  const snapshots = await fixture(context);
  const item = { id: "book", name: "日报", enabled: true };
  let reads = 0;
  const collect = async () => ({ status: "success", rows: [{ sourceValue: ++reads }] });
  const sync = new SnapshotSynchronizer({ snapshots, staleMs: 60_000, logger: { warn() {} } });

  const first = await sync.preview("scenario-1", item, "2026-08-27", collect);
  const second = await sync.preview("scenario-1", item, "2026-08-27", collect);
  assert.equal(first.snapshot.mode, "live-fallback");
  assert.equal(second.snapshot.mode, "materialized");
  assert.equal(second.rows[0].sourceValue, 1);
  assert.equal(reads, 1);

  await sync.refreshAfterWrite("scenario-1", item, "2026-08-27", collect);
  const afterWrite = await sync.preview("scenario-1", item, "2026-08-27", collect);
  assert.equal(afterWrite.rows[0].sourceValue, 2);
  assert.equal(reads, 2);
});

test("an existing run is returned immediately while its snapshot refreshes", async (context) => {
  const snapshots = await fixture(context);
  const item = { id: "book", name: "日报", enabled: true };
  const stateStore = { read: async () => ({ scenarios: { "scenario-1": { runs: [{
    type: "preview",
    businessDate: "2026-08-27",
    createdAt: "2026-08-27T12:00:00.000Z",
    results: [{ sourceId: item.id, status: "success", rows: [{ sourceValue: 7 }] }]
  }] } } }) };
  let release;
  const collect = () => new Promise((resolve) => { release = () => resolve({ status: "success", rows: [{ sourceValue: 8 }] }); });
  const sync = new SnapshotSynchronizer({ snapshots, stateStore, logger: { warn() {} } });

  const preview = await sync.preview("scenario-1", item, "2026-08-27", collect);
  assert.equal(preview.snapshot.mode, "historical");
  assert.equal(preview.rows[0].sourceValue, 7);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release();
  await sync.stop();
});
