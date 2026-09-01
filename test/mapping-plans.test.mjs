import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fingerprint, MappingPlanStore } from "../src/mapping-plans.mjs";
import { collectWorkbook } from "../src/collector.mjs";
import { collectScenario2Pair } from "../src/scenario2.mjs";
import { collectShelfBook } from "../src/shelf-pack.mjs";

async function tempStore(context, name) {
  const directory = join(import.meta.dirname, ".tmp", `mapping-${name}-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  context.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, "mapping-plans.json"), store: new MappingPlanStore(join(directory, "mapping-plans.json")) };
}

function simplePlanArgs() {
  const workbook = { sheets: [{ properties: { sheetId: 1, title: "总表", index: 0, hidden: false } }] };
  return {
    scenario: "scenario-1",
    configurationId: "config-1",
    workbookId: "book-1",
    configuration: { targetSheet: "总表", aliases: { date: ["日期"] } },
    workbook,
    samples: new Map([["总表", [["日期", "C"]]]]),
    signatureRowsByTitle: new Map([["总表", [0]]]),
    mapping: { projections: { "总表": [0, 1] } }
  };
}

test("mapping plans survive a restart and invalidate on config, header, or sheet changes", async (context) => {
  const { store } = await tempStore(context, "valid");
  const args = simplePlanArgs();
  await store.put(args);

  const restarted = new MappingPlanStore(store.file);
  const cached = await restarted.get(args);
  assert.equal(cached.schemaVersion, 1);
  assert.ok(cached.configurationFingerprint);
  assert.equal(cached.sheets[0].structureFingerprint.length, 24);
  assert.deepEqual(cached.mapping, args.mapping);
  assert.ok(await restarted.get({ ...args, samples: new Map([["总表", [["日期", "C"], ["日期", 999]]]]) }));

  assert.equal(await restarted.get({ ...args, configuration: { targetSheet: "新总表", aliases: { date: ["日期"] } } }), null);
  assert.equal(await restarted.get({ ...args, samples: new Map([["总表", [["日期", "D"]]]]) }), null);
  assert.equal(await restarted.get({
    ...args,
    workbook: { sheets: [...args.workbook.sheets, { properties: { sheetId: 2, title: "新增页签", index: 1, hidden: false } }] }
  }), null);
});

test("a damaged mapping plan falls back and can be overwritten", async (context) => {
  const { file } = await tempStore(context, "damaged");
  await writeFile(file, "{not-json", "utf8");
  const store = new MappingPlanStore(file);
  const args = simplePlanArgs();
  assert.equal(await store.get(args), null);
  await store.put(args);
  assert.ok(await new MappingPlanStore(file).get(args));
});

function columnIndex(letters) {
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function batchReader(values) {
  return async (_id, ranges) => ranges.map((range) => {
    const [sheetPart, selector] = range.split("!");
    const rows = values.get(sheetPart.slice(1, -1)) || [];
    if (/^\d+:\d+$/.test(selector)) return rows.slice(0, Number(selector.split(":")[1]));
    const column = columnIndex(selector.split(":")[0]);
    return rows.map((row) => [row?.[column]]);
  });
}

function recordingPlanStore(store, onHit = null) {
  const stats = { gets: 0, validHits: 0, puts: 0 };
  return {
    stats,
    async get(args) {
      stats.gets += 1;
      const plan = await store.get(args);
      if (!plan) return null;
      stats.validHits += 1;
      return onHit ? onHit(plan, stats.validHits) : plan;
    },
    async put(args) {
      stats.puts += 1;
      return store.put(args);
    }
  };
}

test("the single-table collector reuses and consumes a persisted mapping", async (context) => {
  const { file } = await tempStore(context, "collector");
  const values = new Map([
    ["总表", [["日期", "渠道A", "渠道A回流"], [46247, null, null]]],
    ["渠道A(C)", [["日期", "消耗", "回流消耗"], [46247, 12.5, 0.8]]]
  ]);
  const source = { id: "source-1", name: "渠道 A", spreadsheetId: "book-1", targetSheet: "总表", excludedSheets: ["总表"], aliases: { date: ["日期"], spend: ["消耗"], returnSpend: ["回流消耗"] } };
  const workbook = { properties: { title: "日报" }, sheets: [
    { properties: { sheetId: 1, title: "总表", index: 0, hidden: false } },
    { properties: { sheetId: 2, title: "渠道A(C)", index: 1, hidden: false } }
  ] };
  const deps = { getWorkbook: async () => workbook, getSheetValuesBatch: batchReader(values) };
  const firstPlans = recordingPlanStore(new MappingPlanStore(file));
  const first = await collectWorkbook(source, "2026-08-13", { ...deps, mappingPlans: firstPlans });
  assert.equal(firstPlans.stats.puts, 1);
  assert.deepEqual(first.rows.map(({ sourceValue }) => sourceValue), [12.5, 0.8]);
  const secondPlans = recordingPlanStore(new MappingPlanStore(file), (plan) => {
    const mapping = structuredClone(plan.mapping);
    const sourceTitle = Object.keys(mapping.sourceHeaders)[0];
    const sourceHeader = mapping.sourceHeaders[sourceTitle];
    mapping.sourceHeaders[sourceTitle] = { ...sourceHeader, spend: sourceHeader.returnSpend, returnSpend: sourceHeader.spend };
    const targetKeys = Object.keys(mapping.targetColumnMap);
    [mapping.targetColumnMap[targetKeys[0]], mapping.targetColumnMap[targetKeys[1]]] = [mapping.targetColumnMap[targetKeys[1]], mapping.targetColumnMap[targetKeys[0]]];
    return { ...plan, mapping, mappingFingerprint: fingerprint(mapping) };
  });
  const second = await collectWorkbook(source, "2026-08-13", { ...deps, mappingPlans: secondPlans });
  assert.equal(secondPlans.stats.validHits, 1);
  assert.equal(secondPlans.stats.puts, 0);
  assert.deepEqual(second.rows.map(({ sourceValue }) => sourceValue), [0.8, 12.5]);
  assert.equal((await new MappingPlanStore(file).get({
    scenario: "scenario-1",
    configurationId: source.id,
    workbookId: source.spreadsheetId,
    configuration: { targetSheet: source.targetSheet, excludedSheets: source.excludedSheets, aliases: source.aliases },
    workbook,
    samples: new Map([["总表", values.get("总表")], ["渠道A(C)", values.get("渠道A(C)")]])
  })).mapping.targetSheet, source.targetSheet);
});

test("the multi-table and shelf-pack collectors consume persisted projections", async (context) => {
  const { directory } = await tempStore(context, "scenarios");
  const pairFile = join(directory, "pair-plans.json");
  const shelfFile = join(directory, "shelf-plans.json");
  const clientValues = new Map([
    ["日报", [["日期", "渠道号", "花费（U）", "回流"], [46247, "MMY-XIONG-SS1-34", 10, 1]]],
    ["总表", [["日期", "34", "34回流"], [46247, null, null]]],
    ["34(ROY)", [["日期", "渠道号", "花费（U）", "回流"], [46247, "", "", ""]]]
  ]);
  const clientWorkbook = { properties: { title: "甲方" }, sheets: [{ properties: { sheetId: 1, title: "日报", index: 0, hidden: false } }] };
  const ownWorkbook = { properties: { title: "乙方" }, sheets: ["总表", "34(ROY)"].map((title, index) => ({ properties: { sheetId: index + 1, title, index, hidden: false } })) };
  const values = new Map([
    ["client:日报", clientValues.get("日报")],
    ["own:总表", clientValues.get("总表")],
    ["own:34(ROY)", clientValues.get("34(ROY)")]
  ]);
  const read = async (id, ranges) => ranges.map((range) => {
    const [sheetPart, selector] = range.split("!");
    const rows = values.get(`${id}:${sheetPart.slice(1, -1)}`) || [];
    if (/^\d+:\d+$/.test(selector)) return rows.slice(0, Number(selector.split(":")[1]));
    const column = columnIndex(selector.split(":")[0]);
    return rows.map((row) => [row?.[column]]);
  });
  const pair = { id: "pair-1", name: "配对", client: { spreadsheetId: "client", gid: "1" }, own: { spreadsheetId: "own" }, targetSheet: "总表" };
  const pairDeps = {
    getWorkbook: async (id) => id === "client" ? clientWorkbook : ownWorkbook,
    getSheetValuesBatch: read,
    batchWrite: async () => ({ totalUpdatedCells: 0 })
  };
  const firstPairPlans = recordingPlanStore(new MappingPlanStore(pairFile));
  const firstPair = await collectScenario2Pair(pair, "2026-08-13", { ...pairDeps, mappingPlans: firstPairPlans });
  assert.ok(firstPairPlans.stats.puts > 0);
  const secondPairPlans = recordingPlanStore(new MappingPlanStore(pairFile));
  const secondPair = await collectScenario2Pair(pair, "2026-08-13", { ...pairDeps, mappingPlans: secondPairPlans });
  assert.ok(secondPairPlans.stats.validHits > 0);
  assert.equal(secondPairPlans.stats.puts, 0);
  assert.deepEqual(secondPair.rows.map(({ status, detail, total }) => [status, detail?.range, total?.range]), firstPair.rows.map(({ status, detail, total }) => [status, detail?.range, total?.range]));

  const shelfValues = new Map([
    ["架上包 A", [["日期", "投手/包名", "服务费", "消耗", "回流消耗"], [46247, "C", 0, 10, 1]]],
    ["C", [["日期", "渠道名", "服务费", "消耗", "回流消耗"], [46247, "A", 0, null, null]]],
    ["总表", [["日期", "总消耗", "C", "C回流"], [46247, null, null, null]]]
  ]);
  const shelfWorkbook = { properties: { title: "架上包" }, sheets: ["架上包 A", "C", "总表"].map((title, index) => ({ properties: { sheetId: index + 1, title, index, hidden: false } })) };
  const shelfDeps = {
    getWorkbook: async () => shelfWorkbook,
    getSheetValuesBatch: async (_id, ranges) => ranges.map((range) => {
      const [sheetPart, selector] = range.split("!");
      const rows = shelfValues.get(sheetPart.slice(1, -1)) || [];
      if (/^\d+:\d+$/.test(selector)) return rows.slice(0, Number(selector.split(":")[1]));
      const column = columnIndex(selector.split(":")[0]);
      return rows.map((row) => [row?.[column]]);
    })
  };
  const shelf = { id: "book-1", name: "架上包", spreadsheetId: "shelf" };
  const firstShelfPlans = recordingPlanStore(new MappingPlanStore(shelfFile));
  const firstShelf = await collectShelfBook(shelf, "2026-08-13", { ...shelfDeps, mappingPlans: firstShelfPlans });
  assert.ok(firstShelfPlans.stats.puts > 0);
  const secondShelfPlans = recordingPlanStore(new MappingPlanStore(shelfFile));
  const secondShelf = await collectShelfBook(shelf, "2026-08-13", { ...shelfDeps, mappingPlans: secondShelfPlans });
  assert.ok(secondShelfPlans.stats.validHits > 0);
  assert.equal(secondShelfPlans.stats.puts, 0);
  assert.deepEqual(secondShelf.rows.map(({ status, detail, total }) => [status, detail?.range, total?.range]), firstShelf.rows.map(({ status, detail, total }) => [status, detail?.range, total?.range]));
});
