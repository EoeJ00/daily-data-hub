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

test("preview verifies an unchanged workbook and refreshes after its version changes", async (context) => {
  const snapshots = await fixture(context);
  const item = { id: "book", name: "日报", spreadsheetId: "sheet-1", enabled: true };
  let reads = 0;
  let version = "1";
  const collect = async () => ({ status: "success", rows: [{ sourceValue: ++reads }] });
  const sync = new SnapshotSynchronizer({
    snapshots,
    definitions: { "scenario-1": { spreadsheetIds: (value) => [value.spreadsheetId] } },
    getSpreadsheetRevision: async () => ({ version }),
    logger: { warn() {} }
  });

  const first = await sync.preview("scenario-1", item, "2026-08-27", collect);
  const second = await sync.preview("scenario-1", item, "2026-08-27", collect);
  assert.equal(first.snapshot.mode, "live-fallback");
  assert.equal(second.snapshot.mode, "verified");
  assert.equal(second.rows[0].sourceValue, 1);
  assert.equal(reads, 1);

  version = "2";
  const refreshed = await sync.preview("scenario-1", item, "2026-08-27", collect);
  assert.equal(refreshed.snapshot.mode, "refreshed");
  assert.equal(refreshed.rows[0].sourceValue, 2);
  assert.equal(reads, 2);
});

test("a historical preview is synchronously replaced with current live data", async (context) => {
  const snapshots = await fixture(context);
  const item = { id: "book", name: "日报", spreadsheetId: "sheet-1", enabled: true };
  const stateStore = { read: async () => ({ scenarios: { "scenario-1": { runs: [{
    type: "preview",
    businessDate: "2026-08-27",
    createdAt: "2026-08-27T12:00:00.000Z",
    results: [{ sourceId: item.id, status: "success", rows: [{ sourceValue: 7 }] }]
  }] } } }) };
  const collect = async () => ({ status: "success", rows: [{ sourceValue: 8 }] });
  const sync = new SnapshotSynchronizer({
    snapshots,
    stateStore,
    definitions: { "scenario-1": { spreadsheetIds: (value) => [value.spreadsheetId] } },
    getSpreadsheetRevision: async () => ({ version: "1" }),
    logger: { warn() {} }
  });

  const preview = await sync.preview("scenario-1", item, "2026-08-27", collect);
  assert.equal(preview.snapshot.mode, "refreshed");
  assert.equal(preview.rows[0].sourceValue, 8);
});

test("preview falls back to a live read when revision verification is unavailable", async (context) => {
  const snapshots = await fixture(context);
  const item = { id: "book", name: "日报", spreadsheetId: "sheet-1", enabled: true };
  let reads = 0;
  const sync = new SnapshotSynchronizer({
    snapshots,
    definitions: { "scenario-1": { spreadsheetIds: (value) => [value.spreadsheetId] } },
    getSpreadsheetRevision: async () => { throw new Error("Drive unavailable"); },
    logger: { warn() {} }
  });

  const preview = await sync.preview("scenario-1", item, "2026-08-27", async () => ({ status: "success", rows: [{ sourceValue: ++reads }] }));
  assert.equal(preview.snapshot.mode, "live-fallback");
  assert.match(preview.snapshot.warning, /直接读取实时数据/);
  assert.equal(reads, 1);
});

test("refresh recollects once when the workbook changes during collection", async (context) => {
  const snapshots = await fixture(context);
  const item = { id: "book", name: "日报", spreadsheetId: "sheet-1", enabled: true };
  let version = "1";
  let reads = 0;
  const sync = new SnapshotSynchronizer({
    snapshots,
    definitions: { "scenario-1": { spreadsheetIds: (value) => [value.spreadsheetId] } },
    getSpreadsheetRevision: async () => ({ version }),
    logger: { warn() {} }
  });

  const preview = await sync.preview("scenario-1", item, "2026-08-27", async () => {
    reads += 1;
    if (reads === 1) version = "2";
    return { status: "success", rows: [{ sourceValue: reads }] };
  });

  assert.equal(reads, 2);
  assert.equal(preview.rows[0].sourceValue, 2);
  assert.deepEqual((await snapshots.get("scenario-1", item, "2026-08-27")).revisions, { "sheet-1": "2" });
});

test("preview labels cached data unverified when both verification and live read fail", async (context) => {
  const snapshots = await fixture(context);
  const item = { id: "book", name: "日报", spreadsheetId: "sheet-1", enabled: true };
  await snapshots.put("scenario-1", item, "2026-08-27", { status: "success", rows: [{ sourceValue: 7 }] }, { "sheet-1": "1" });
  const sync = new SnapshotSynchronizer({
    snapshots,
    definitions: { "scenario-1": { spreadsheetIds: (value) => [value.spreadsheetId] } },
    getSpreadsheetRevision: async () => { throw new Error("Drive unavailable"); },
    logger: { warn() {} }
  });

  const preview = await sync.preview("scenario-1", item, "2026-08-27", async () => { throw new Error("Sheets unavailable"); });
  assert.equal(preview.snapshot.mode, "stale-unverified");
  assert.equal(preview.rows[0].sourceValue, 7);
  assert.match(preview.snapshot.warning, /未经验证/);
});
