import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { JsonStateStore } from "../src/state-store.mjs";

const temporaryRoot = join(import.meta.dirname, ".tmp");

async function temporaryStateFile(name) {
  const directory = join(temporaryRoot, `${name}-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  return { directory, file: join(directory, "state.json") };
}

test("serializes concurrent state mutations without losing updates", async (context) => {
  const { directory, file } = await temporaryStateFile("concurrent");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStateStore(file, { defaultState: { runs: [] } });

  await Promise.all([
    store.mutate(async (state) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state.runs.push("scenario-1");
    }),
    store.mutate((state) => state.runs.push("scenario-2"))
  ]);

  assert.deepEqual((await store.read()).runs, ["scenario-1", "scenario-2"]);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).runs, ["scenario-1", "scenario-2"]);
  assert.deepEqual(await readdir(directory), ["state.json"]);
});

test("returns isolated snapshots and normalizes persisted state", async (context) => {
  const { directory, file } = await temporaryStateFile("normalize");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStateStore(file, {
    defaultState: { version: 1, items: [] },
    normalize: (state) => ({ version: 1, items: Array.isArray(state.items) ? state.items : [] })
  });

  const snapshot = await store.read();
  snapshot.items.push("local-only");
  assert.deepEqual((await store.read()).items, []);

  await store.mutate((state) => state.items.push("persisted"));
  assert.deepEqual((await store.read()).items, ["persisted"]);
});
