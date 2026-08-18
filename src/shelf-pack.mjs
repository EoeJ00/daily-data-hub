import { batchWrite, getSheetValues, getWorkbook } from "./google-sheets.mjs";
import { mapConcurrent } from "./async-utils.mjs";

const empty = (value) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");
const normalized = (value) => String(value ?? "").trim().toLowerCase().replaceAll(/\s+/g, "");
const compact = (value) => normalized(value).replace(/[\-_—–（）()]/g, "");

function parseNumber(value) {
  if (empty(value)) return { kind: "blank" };
  if (typeof value === "number" && Number.isFinite(value)) return { kind: "number", value };
  const cleaned = String(value).trim().replaceAll(",", "").replace(/[¥￥$%]/g, "");
  if (cleaned && Number.isFinite(Number(cleaned))) return { kind: "number", value: Number(cleaned) };
  return { kind: "error", raw: value };
}

export function dateKey(value, businessDate = "") {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && Number.isFinite(value)) {
    const epoch = Date.UTC(1899, 11, 30);
    return new Date(epoch + Math.round(value) * 86_400_000).toISOString().slice(0, 10);
  }
  const text = String(value ?? "").trim().replace(/[年月/.]/g, "-").replace("日", "");
  const full = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (full) return `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`;
  const short = text.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!short) return "";
  const year = /^\d{4}-/.test(businessDate) ? businessDate.slice(0, 4) : String(new Date().getFullYear());
  return `${year}-${short[1].padStart(2, "0")}-${short[2].padStart(2, "0")}`;
}

function headerText(value) {
  return normalized(value).replace(/[\n\r]/g, "");
}

function findHeader(values, kind) {
  for (let row = 0; row < Math.min(values.length, 24); row += 1) {
    const cells = values[row] || [];
    const date = cells.findIndex((cell) => headerText(cell) === "日期" || headerText(cell) === "时间" || headerText(cell) === "date");
    const spend = cells.findIndex((cell) => /消耗/.test(String(cell ?? "")) && !/回流/.test(String(cell ?? "")));
    const returnSpend = cells.findIndex((cell) => /回流消耗|回流/.test(String(cell ?? "")));
    const name = cells.findIndex((cell) => kind === "rack"
      ? /投手|包名/.test(String(cell ?? ""))
      : /渠道名|渠道/.test(String(cell ?? "")));
    if (date >= 0 && spend >= 0 && returnSpend >= 0 && name >= 0) return { row, date, name, spend, returnSpend };
  }
  return null;
}

export function classifyShelfSheet(values) {
  if (findHeader(values, "rack")) return "rack";
  if (findHeader(values, "shooter")) return "shooter";
  return "other";
}

function shooterAliases(value) {
  const raw = String(value ?? "").trim();
  const aliases = new Set([compact(raw)]);
  const match = raw.match(/[（(]([^（）()]*)[）)]\s*$/);
  if (match?.[1]) aliases.add(compact(match[1]));
  return [...aliases].filter(Boolean);
}

function isSummaryLabel(value, sheetTitle) {
  const label = String(value ?? "").trim();
  if (!label) return true;
  if (/汇总|合计|总计/.test(label)) return true;
  return compact(label) === compact(sheetTitle);
}

function addMetric(record, metric, parsed, packageName, rawShooter) {
  if (parsed.kind === "blank") return;
  if (parsed.kind === "error") {
    record.errors.push({ metric, rawShooter, packageName, message: `架上包 ${packageName} 的${metric}不是数值：${parsed.raw}` });
    return;
  }
  record[metric === "消耗" ? "spend" : "returnSpend"] += parsed.value;
  record.metrics.add(metric);
  record.packages.add(packageName);
  record.details.push({ packageName, rawShooter, metric, value: parsed.value });
}

export function extractShelfPackRecords(values, sheetTitle, businessDate) {
  const header = findHeader(values, "rack");
  if (!header) return { status: "error", sheetTitle, rows: [], error: "未找到架上包表头" };
  const records = new Map();
  let activeDate = "";
  for (let rowIndex = header.row + 1; rowIndex < values.length; rowIndex += 1) {
    const row = values[rowIndex] || [];
    const explicitDate = dateKey(row[header.date], businessDate);
    if (!empty(row[header.date])) activeDate = explicitDate;
    if (activeDate !== businessDate) continue;
    const rawShooter = String(row[header.name] ?? "").trim();
    if (isSummaryLabel(rawShooter, sheetTitle)) continue;
    const shooter = shooterAliases(rawShooter).at(-1) || compact(rawShooter);
    if (!shooter) continue;
    const record = records.get(shooter) || {
      shooter,
      displayShooter: rawShooter,
      spend: 0,
      returnSpend: 0,
      metrics: new Set(),
      packages: new Set(),
      details: [],
      errors: []
    };
    addMetric(record, "消耗", parseNumber(row[header.spend]), sheetTitle, rawShooter);
    addMetric(record, "回流消耗", parseNumber(row[header.returnSpend]), sheetTitle, rawShooter);
    records.set(shooter, record);
  }

  const rows = [];
  for (const record of records.values()) {
    for (const error of record.errors) rows.push({ ...error, status: "error", shooter: record.shooter });
    for (const metric of ["消耗", "回流消耗"]) {
      if (!record.metrics.has(metric)) continue;
      rows.push({
        shooter: record.shooter,
        displayShooter: record.displayShooter,
        metric,
        sourceValue: metric === "消耗" ? record.spend : record.returnSpend,
        packageName: sheetTitle,
        packageCount: record.packages.size,
        details: record.details.filter((item) => item.metric === metric),
        status: "pending"
      });
    }
  }
  return { status: "success", sheetTitle, rows };
}

function locateDateRow(values, header, businessDate) {
  return values.findIndex((row, index) => index > header.row && dateKey(row?.[header.date], businessDate) === businessDate);
}

function inspectTarget(value, sourceValue, range) {
  if (empty(value)) return { status: "ready", value: null, range };
  const parsed = parseNumber(value);
  if (parsed.kind === "number" && parsed.value === sourceValue) return { status: "same", value: parsed.value, range };
  return { status: "conflict", value, range };
}

function columnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function targetMetricColumns(values, header) {
  const row = values[header.row] || [];
  return { spend: header.spend, returnSpend: header.returnSpend, row };
}

function matchTargetSheet(shooter, targetSheets) {
  const aliases = shooterAliases(shooter);
  const scored = targetSheets.map((item) => {
    const target = compact(item.title);
    const exact = aliases.includes(target);
    const partial = aliases.some((alias) => alias.endsWith(target) || target.endsWith(alias));
    return { item, score: exact ? 1000 : partial ? 500 : 0 };
  }).filter((item) => item.score > 0);
  const maxScore = Math.max(0, ...scored.map((item) => item.score));
  const matches = scored.filter((item) => item.score === maxScore);
  if (!matches.length) return { error: `未找到投手 ${shooter} 对应的投手消耗表` };
  if (matches.length > 1) return { error: `投手 ${shooter} 匹配到多个投手消耗表` };
  return matches[0].item;
}

export function aggregateShelfPackRows(results) {
  const groups = new Map();
  for (const result of results) {
    for (const row of result.rows || []) {
      if (row.status === "error") continue;
      const group = groups.get(row.shooter) || {
        shooter: row.shooter,
        displayShooter: row.displayShooter,
        spend: 0,
        returnSpend: 0,
        metrics: new Set(),
        details: []
      };
      group[row.metric === "消耗" ? "spend" : "returnSpend"] += row.sourceValue;
      group.metrics.add(row.metric);
      group.details.push(...(row.details || []));
      groups.set(row.shooter, group);
    }
  }
  return [...groups.values()];
}

function mapShelfTargets(records, businessDate, targetSheets) {
  const targetCache = new Map(targetSheets.map((sheet) => [sheet.title, sheet]));
  const rows = [];
  for (const record of records) {
    const match = matchTargetSheet(record.shooter, targetSheets);
    for (const metric of ["消耗", "回流消耗"]) {
      if (!record.metrics.has(metric)) continue;
      const sourceValue = metric === "消耗" ? record.spend : record.returnSpend;
      const base = {
        shooter: record.shooter,
        displayShooter: record.displayShooter,
        metric,
        sourceValue,
        packageDetails: record.details.filter((item) => item.metric === metric),
        status: "error"
      };
      if (match.error) {
        rows.push({ ...base, message: match.error });
        continue;
      }
      const target = targetCache.get(match.title);
      const header = findHeader(target.values, "shooter");
      const dateRow = header ? locateDateRow(target.values, header, businessDate) : -1;
      if (!header) {
        rows.push({ ...base, targetSheet: target.title, message: "投手消耗表未找到日期、消耗和回流表头" });
        continue;
      }
      if (dateRow < 0) {
        rows.push({ ...base, targetSheet: target.title, message: `投手消耗表缺少 ${businessDate} 日期行` });
        continue;
      }
      const columns = targetMetricColumns(target.values, header);
      const column = metric === "消耗" ? columns.spend : columns.returnSpend;
      const range = `'${target.title.replaceAll("'", "''")}'!${columnName(column)}${dateRow + 1}`;
      const inspection = inspectTarget(target.values[dateRow]?.[column], sourceValue, range);
      rows.push({ ...base, targetSheet: target.title, targetValue: inspection.value, range, status: inspection.status });
    }
  }
  return rows;
}

export async function collectShelfBook(book, businessDate, deps = { getWorkbook, getSheetValues }) {
  const workbook = await deps.getWorkbook(book.spreadsheetId);
  const properties = workbook.sheets.filter(({ properties: sheet }) => !sheet?.title || sheet.title).map(({ properties: sheet }) => sheet);
  const sheets = await mapConcurrent(properties, async (sheet) => ({
    ...sheet,
    values: await deps.getSheetValues(book.spreadsheetId, sheet.title)
  }), 6);
  const rackSheets = sheets.filter((sheet) => classifyShelfSheet(sheet.values) === "rack");
  const visibleRackSheets = rackSheets.filter((sheet) => !sheet.hidden);
  const sourceSheets = visibleRackSheets.length ? visibleRackSheets : rackSheets;
  const targetSheets = sheets.filter((sheet) => classifyShelfSheet(sheet.values) === "shooter");
  if (!sourceSheets.length) throw new Error("未识别到架上包数据记录表");
  if (!targetSheets.length) throw new Error("未识别到投手消耗表");
  const extracted = sourceSheets.map((sheet) => extractShelfPackRecords(sheet.values, sheet.title, businessDate));
  const records = aggregateShelfPackRows(extracted);
  const extractionErrors = extracted.flatMap((result) => result.status === "error"
    ? [{ status: "error", sourceSheet: result.sheetTitle, message: result.error }]
    : (result.rows || []).filter((row) => row.status === "error").map((row) => ({ ...row, sourceSheet: result.sheetTitle })));
  const rows = [...extractionErrors, ...mapShelfTargets(records, businessDate, targetSheets)];
  return {
    sourceId: book.id,
    sourceName: book.name,
    spreadsheetTitle: workbook.properties?.title || book.name,
    sourceSheetCount: sourceSheets.length,
    targetSheetCount: targetSheets.length,
    status: "success",
    businessDate,
    rows
  };
}

export async function executeShelfBook(book, businessDate, deps = { getWorkbook, getSheetValues, batchWrite }) {
  const preview = await collectShelfBook(book, businessDate, deps);
  const updates = preview.rows
    .filter((row) => row.status === "ready" && row.range)
    .map((row) => ({ range: row.range, value: row.sourceValue }));
  await deps.batchWrite(book.spreadsheetId, updates);
  const verified = updates.length ? await collectShelfBook(book, businessDate, deps) : preview;
  const writtenRanges = new Set(updates.map((item) => item.range));
  return {
    ...verified,
    rows: verified.rows.map((row) => writtenRanges.has(row.range) && row.status === "same"
      ? { ...row, status: "written", message: "已写入并复核" }
      : row)
  };
}
