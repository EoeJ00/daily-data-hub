import { createHash } from "node:crypto";
import { JsonStateStore } from "./state-store.mjs";

export const MAPPING_PLAN_SCHEMA_VERSION = 1;

const clone = (value) => structuredClone(value);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function stableSerialize(value) {
  return JSON.stringify(stableValue(value));
}

export function fingerprint(value) {
  return createHash("sha256").update(stableSerialize(value) ?? "undefined").digest("base64url").slice(0, 24);
}

export function configurationFingerprint(configuration) {
  return fingerprint(configuration || {});
}

export function mappingPlanKey(scenario, configurationId, workbookId) {
  return `${String(scenario)}\u0000${String(configurationId)}\u0000${String(workbookId)}`;
}

function sheetMetadata(properties = {}) {
  return {
    sheetId: properties.sheetId ?? null,
    title: String(properties.title ?? ""),
    index: properties.index ?? null,
    hidden: Boolean(properties.hidden)
  };
}

export function workbookSheets(workbook) {
  return (workbook?.sheets || []).map(({ properties }) => sheetMetadata(properties));
}

export function sheetStructureFingerprint(properties, sample = [], signatureRows = []) {
  const rows = [...new Set((Array.isArray(signatureRows) ? signatureRows : []).filter((row) => Number.isInteger(row) && row >= 0))]
    .sort((left, right) => left - right)
    .map((row) => ({ row, cells: Array.isArray(sample?.[row]) ? sample[row] : [] }));
  return fingerprint({ metadata: sheetMetadata(properties), rows });
}

function asMap(value) {
  if (value instanceof Map) return value;
  return new Map(Object.entries(value || {}));
}

function buildSheets(workbook, samples, signatureRowsByTitle = {}) {
  const sampleByTitle = asMap(samples);
  const rowsByTitle = asMap(signatureRowsByTitle);
  return workbookSheets(workbook).map((sheet) => {
    const signatureRows = rowsByTitle.get(sheet.title) || [];
    return {
      ...sheet,
      signatureRows: [...signatureRows],
      structureFingerprint: sheetStructureFingerprint(sheet, sampleByTitle.get(sheet.title), signatureRows)
    };
  });
}

export function buildMappingPlan({
  scenario,
  configurationId,
  workbookId,
  configuration,
  workbook,
  samples,
  signatureRowsByTitle,
  mapping
}) {
  const configFingerprint = configurationFingerprint(configuration);
  return {
    schemaVersion: MAPPING_PLAN_SCHEMA_VERSION,
    scenario: String(scenario),
    configurationId: String(configurationId),
    workbookId: String(workbookId),
    configurationFingerprint: configFingerprint,
    configFingerprint,
    sheets: buildSheets(workbook, samples, signatureRowsByTitle),
    mapping: clone(mapping),
    mappingFingerprint: fingerprint(mapping),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export function isMappingPlanValid(plan, {
  scenario,
  configurationId,
  workbookId,
  configuration,
  workbook,
  samples
} = {}) {
  if (!plan || plan.schemaVersion !== MAPPING_PLAN_SCHEMA_VERSION || !plan.mapping || !plan.mappingFingerprint || !Array.isArray(plan.sheets)) return false;
  if (plan.scenario !== String(scenario)
    || plan.configurationId !== String(configurationId)
    || plan.workbookId !== String(workbookId)) return false;
  const expectedFingerprint = configurationFingerprint(configuration);
  if ((plan.configurationFingerprint || plan.configFingerprint) !== expectedFingerprint) return false;
  if (plan.mappingFingerprint !== fingerprint(plan.mapping)) return false;

  const currentSheets = workbookSheets(workbook);
  const plannedMetadata = plan.sheets.map(({ sheetId, title, index, hidden }) => ({ sheetId, title, index, hidden }));
  if (stableSerialize(plannedMetadata) !== stableSerialize(currentSheets)) return false;

  const currentByTitle = new Map((workbook?.sheets || []).map(({ properties }) => [String(properties?.title ?? ""), properties || {}]));
  const sampleByTitle = asMap(samples);
  for (const sheet of plan.sheets) {
    if (!Array.isArray(sheet.signatureRows)) return false;
    if (sheet.signatureRows.length && !sampleByTitle.has(sheet.title)) return false;
    const current = currentByTitle.get(sheet.title);
    if (!current || sheet.structureFingerprint !== sheetStructureFingerprint(current, sampleByTitle.get(sheet.title), sheet.signatureRows)) return false;
  }
  return true;
}

export class MappingPlanStore {
  constructor(fileOrStore, { stateStore } = {}) {
    this.file = typeof fileOrStore === "string" ? fileOrStore : undefined;
    this.store = stateStore || (fileOrStore?.read && fileOrStore?.mutate
      ? fileOrStore
      : new JsonStateStore(fileOrStore, { defaultState: { plans: {} }, recover: true }));
  }

  async get(args) {
    let state;
    try {
      state = await this.store.read();
    } catch {
      return null;
    }
    const plan = state?.plans?.[mappingPlanKey(args.scenario, args.configurationId, args.workbookId)];
    return isMappingPlanValid(plan, args) ? clone(plan) : null;
  }

  async put(args) {
    const plan = buildMappingPlan(args);
    await this.store.mutate((state) => {
      state.plans ||= {};
      state.plans[mappingPlanKey(args.scenario, args.configurationId, args.workbookId)] = plan;
    });
    return clone(plan);
  }
}
