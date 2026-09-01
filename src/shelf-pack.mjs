import { batchWrite, getSheetValues, getSheetValuesBatch, getWorkbook } from "./google-sheets.mjs";
import { mapConcurrent } from "./async-utils.mjs";
import { combineTargetStatuses as combineStatus, columnName, dateKey, inspectTarget, isEmpty as empty, mergeProjectedColumns, normalizeText as normalized, parseNumber, parseSheetRange, planSequentialDateRows, quoteSheetTitle, sheetColumnRange, sheetHeaderRange, sheetRange } from "./spreadsheet-utils.mjs";

export { dateKey } from "./spreadsheet-utils.mjs";
const compact = (value) => normalized(value).replace(/[\-_—–（）()]/g, "");

function headerText(value) {
  return normalized(value).replace(/[\n\r]/g, "");
}

function findMetricColumn(cells, metric) {
  const exactPattern = metric === "spend"
    ? /^(?:消耗|花费)(?:（[^）]*）|\([^)]*\))?$/
    : /^回流(?:消耗)?(?:（[^）]*）|\([^)]*\))?$/;
  const exact = cells.findIndex((cell) => exactPattern.test(headerText(cell)));
  if (exact >= 0) return exact;
  return cells.findIndex((cell) => metric === "spend"
    ? /消耗|花费/.test(String(cell ?? "")) && !/回流/.test(String(cell ?? ""))
    : /回流消耗|回流/.test(String(cell ?? "")));
}

function findHeader(values, kind) {
  for (let row = 0; row < Math.min(values.length, 24); row += 1) {
    const cells = values[row] || [];
    const date = cells.findIndex((cell) => headerText(cell) === "日期" || headerText(cell) === "时间" || headerText(cell) === "date");
    const spend = findMetricColumn(cells, "spend");
    const returnSpend = findMetricColumn(cells, "returnSpend");
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

function findTotalHeader(values) {
  for (let row = 0; row < Math.min(values.length, 24); row += 1) {
    const cells = values[row] || [];
    const date = cells.findIndex((cell) => headerText(cell) === "日期" || headerText(cell) === "时间" || headerText(cell) === "date");
    const total = cells.findIndex((cell) => /总消耗|汇总消耗/.test(String(cell ?? "")));
    if (date >= 0 && total >= 0) return { row, date, total };
  }
  return null;
}

function locateTotalMetricColumn(values, header, shooter, metric) {
  const aliases = new Set(shooterAliases(shooter));
  const cells = values[header.row] || [];
  const shooterColumns = cells
    .map((cell, column) => ({ text: compact(cell), column }))
    .filter(({ text }) => aliases.has(text) || aliases.has(text.replace(/消耗$|花费$/, "")))
    .map(({ column }) => column);

  if (metric === "回流消耗") {
    const adjacentMatches = shooterColumns
      .map((column) => column + 1)
      .filter((column) => column < cells.length);
    if (adjacentMatches.length === 1) return { column: adjacentMatches[0] };
    if (adjacentMatches.length > 1) return { error: `总表中投手 ${shooter} 的${metric}列不唯一` };
  }

  const matches = [];
  cells.forEach((cell, column) => {
    const text = compact(cell);
    const isReturn = /回流消耗|回流/.test(text);
    const base = text.replace(/回流消耗$|回流$|消耗$|花费$/, "");
    if (!aliases.has(base)) return;
    if ((metric === "消耗" && !isReturn) || (metric === "回流消耗" && isReturn)) matches.push(column);
  });
  if (matches.length === 1) return { column: matches[0] };
  if (matches.length > 1) return { error: `总表中投手 ${shooter} 的${metric}列不唯一` };
  return { error: `总表中未找到投手 ${shooter} 的${metric}列` };
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

function mapShelfTargets(records, businessDate, targetSheets, totalSheet) {
  const totalHeader = findTotalHeader(totalSheet.values);
  const totalDatePlan = totalHeader ? planSequentialDateRows(totalSheet.values, totalHeader, businessDate, totalSheet.title) : null;
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
      const target = match;
      const header = findHeader(target.values, "shooter");
      const datePlan = header ? planSequentialDateRows(target.values, header, businessDate, target.title) : null;
      let detail;
      if (!header) {
        detail = { status: "error", message: "投手消耗表未找到日期、消耗和回流表头" };
      } else if (datePlan.error) {
        detail = { status: "error", message: datePlan.error };
      } else {
        const dateRow = datePlan.row;
        const column = metric === "消耗" ? header.spend : header.returnSpend;
        const range = sheetRange(target.title, dateRow, column);
        const inspection = inspectTarget(target.values[dateRow]?.[column], sourceValue, range);
        detail = {
          ...inspection,
          range,
          dateUpdates: datePlan.updates,
          message: datePlan.updates.length ? `将自动补充 ${datePlan.updates.length} 个日期行至 ${businessDate}` : inspection.message
        };
      }

      let total;
      if (!totalHeader) {
        total = { status: "error", message: "总表未找到日期和总消耗表头" };
      } else if (totalDatePlan.error) {
        total = { status: "error", message: totalDatePlan.error };
      } else {
        const located = locateTotalMetricColumn(totalSheet.values, totalHeader, record.shooter, metric);
        if (located.error) {
          total = { status: "error", message: located.error };
        } else {
          const range = sheetRange(totalSheet.title, totalDatePlan.row, located.column);
          const inspection = inspectTarget(totalSheet.values[totalDatePlan.row]?.[located.column], sourceValue, range);
          total = {
            ...inspection,
            range,
            dateUpdates: totalDatePlan.updates,
            message: totalDatePlan.updates.length ? `将自动补充 ${totalDatePlan.updates.length} 个日期行至 ${businessDate}` : inspection.message
          };
        }
      }

      const messages = [detail.message, total.message].filter(Boolean);
      rows.push({
        ...base,
        targetSheet: target.title,
        totalSheet: totalSheet.title,
        targetValue: detail.value,
        totalValue: total.value,
        range: detail.range,
        detail,
        total,
        status: combineStatus(detail, total),
        message: messages.length ? messages.join("；") : undefined
      });
    }
  }
  return rows;
}

const shelfHeaderRows = 24;

function uniqueColumns(columns) {
  return [...new Set(columns.filter((column) => Number.isInteger(column) && column >= 0))];
}

function totalLabelMatches(value, aliases) {
  const raw = String(value ?? "").trim();
  const text = compact(value);
  const base = text.replace(/回流消耗$|回流$|消耗$|花费$/, "");
  return [...new Set([raw, text, base].flatMap((candidate) => shooterAliases(candidate)))].some((alias) => aliases.has(alias));
}

function totalProjectionColumns(sample, header, targetSheets, sourceSheets) {
  const aliases = new Set(targetSheets.flatMap((sheet) => shooterAliases(sheet.title)));
  for (const source of sourceSheets) {
    const sourceHeader = findHeader(source.sample, "rack");
    if (!sourceHeader) continue;
    for (const row of source.sample.slice(sourceHeader.row + 1)) {
      for (const alias of shooterAliases(row?.[sourceHeader.name])) aliases.add(alias);
    }
  }

  const cells = sample[header.row] || [];
  const columns = new Set([header.date]);
  cells.forEach((cell, column) => {
    if (column === header.date || column === header.total || !totalLabelMatches(cell, aliases)) return;
    columns.add(column);
    if (!/回流|消耗|花费/.test(String(cell ?? "")) && column + 1 < cells.length) columns.add(column + 1);
  });
  if (columns.size === 1) {
    cells.forEach((cell, column) => {
      if (column !== header.date && column !== header.total && !empty(cell)) columns.add(column);
    });
  }
  return [...columns];
}

function projectionColumns(sheet, targetSheets, sourceSheets) {
  if (sheet.kind === "rack" || sheet.kind === "shooter") {
    const header = findHeader(sheet.sample, sheet.kind);
    return header ? uniqueColumns([header.date, header.name, header.spend, header.returnSpend]) : [];
  }
  if (compact(sheet.title) !== "总表") return [];
  const header = findTotalHeader(sheet.sample);
  return header ? totalProjectionColumns(sheet.sample, header, targetSheets, sourceSheets) : [];
}

function projectedColumnValues(values, column) {
  const rows = values || [];
  const fullRows = rows.some((row) => Array.isArray(row) && row.length > 1);
  return rows.map((row) => fullRows ? [row?.[column]] : row);
}

async function readProjectedSheets(spreadsheetId, specs, deps) {
  if (deps.getSheetValuesBatch) {
    const ranges = specs.flatMap((sheet) => sheet.columns.map((column) => sheetColumnRange(sheet.title, column)));
    const projected = ranges.length ? await deps.getSheetValuesBatch(spreadsheetId, ranges) : [];
    let cursor = 0;
    return specs.map((sheet) => {
      const values = mergeProjectedColumns(sheet.columns, projected.slice(cursor, cursor + sheet.columns.length), sheet.sample);
      cursor += sheet.columns.length;
      return { ...sheet, values };
    });
  }

  const requests = specs.flatMap((sheet) => sheet.columns.map((column) => ({ sheet, column })));
  const projected = await mapConcurrent(requests, async ({ sheet, column }) => {
    const range = `${columnName(column)}:${columnName(column)}`;
    const values = await deps.getSheetValues(spreadsheetId, sheet.title, { range });
    return projectedColumnValues(values, column);
  }, 6);
  let cursor = 0;
  return specs.map((sheet) => {
    const values = mergeProjectedColumns(sheet.columns, projected.slice(cursor, cursor + sheet.columns.length), sheet.sample);
    cursor += sheet.columns.length;
    return { ...sheet, values };
  });
}

async function readShelfSheets(spreadsheetId, properties, deps) {
  const samples = deps.getSheetValuesBatch
    ? await deps.getSheetValuesBatch(spreadsheetId, properties.map((sheet) => sheetHeaderRange(sheet.title, shelfHeaderRows)))
    : await mapConcurrent(properties, (sheet) => deps.getSheetValues(spreadsheetId, sheet.title, { range: `1:${shelfHeaderRows}` }), 6);
  const sampled = properties.map((sheet, index) => ({ ...sheet, sample: samples[index] || [], kind: classifyShelfSheet(samples[index] || []) }));
  const racks = sampled.filter((sheet) => sheet.kind === "rack");
  const visibleRacks = racks.filter((sheet) => !sheet.hidden);
  const selectedRacks = visibleRacks.length ? visibleRacks : racks;
  const targetSheets = sampled.filter((sheet) => sheet.kind === "shooter");
  const relevant = [...new Map([
    ...selectedRacks,
    ...targetSheets,
    ...sampled.filter((sheet) => compact(sheet.title) === "总表")
  ].map((sheet) => [sheet.title, sheet])).values()];
  const specs = relevant.map((sheet) => ({
    ...sheet,
    columns: projectionColumns(sheet, targetSheets, selectedRacks)
  }));
  return readProjectedSheets(spreadsheetId, specs, deps);
}

const defaultDeps = { getWorkbook, getSheetValues, getSheetValuesBatch, batchWrite };

export async function collectShelfBook(book, businessDate, deps = defaultDeps) {
  const workbook = await deps.getWorkbook(book.spreadsheetId);
  const properties = workbook.sheets.filter(({ properties: sheet }) => !sheet?.title || sheet.title).map(({ properties: sheet }) => sheet);
  const sheets = await readShelfSheets(book.spreadsheetId, properties, deps);
  const rackSheets = sheets.filter((sheet) => classifyShelfSheet(sheet.values) === "rack");
  const visibleRackSheets = rackSheets.filter((sheet) => !sheet.hidden);
  const sourceSheets = visibleRackSheets.length ? visibleRackSheets : rackSheets;
  const targetSheets = sheets.filter((sheet) => classifyShelfSheet(sheet.values) === "shooter");
  const totalSheets = sheets.filter((sheet) => compact(sheet.title) === "总表");
  const totalSheet = totalSheets[0];
  if (!sourceSheets.length) throw new Error("未识别到架上包数据记录表");
  if (!targetSheets.length) throw new Error("未识别到投手消耗表");
  if (!totalSheet) throw new Error("未识别到总表");
  if (!findTotalHeader(totalSheet.values)) throw new Error("总表缺少日期和总消耗表头");
  const extracted = sourceSheets.map((sheet) => extractShelfPackRecords(sheet.values, sheet.title, businessDate));
  const records = aggregateShelfPackRows(extracted);
  const extractionErrors = extracted.flatMap((result) => result.status === "error"
    ? [{ status: "error", sourceSheet: result.sheetTitle, message: result.error }]
    : (result.rows || []).filter((row) => row.status === "error").map((row) => ({ ...row, sourceSheet: result.sheetTitle })));
  const rows = [...extractionErrors, ...mapShelfTargets(records, businessDate, targetSheets, totalSheet)];
  return {
    sourceId: book.id,
    sourceName: book.name,
    spreadsheetTitle: workbook.properties?.title || book.name,
    sourceSheetCount: sourceSheets.length,
    targetSheetCount: targetSheets.length,
    totalSheetName: totalSheet.title,
    status: "success",
    businessDate,
    rows
  };
}

async function verifyShelfWrites(book, preview, updates, deps) {
  const ranges = [...new Set(updates.map((item) => item.range))];
  const valuesByRange = new Map();
  if (deps.getSheetValuesBatch) {
    const values = await deps.getSheetValuesBatch(book.spreadsheetId, ranges);
    ranges.forEach((range, index) => valuesByRange.set(range, values[index] || []));
  } else {
    await Promise.all(ranges.map(async (range) => {
      const parsed = parseSheetRange(range);
      if (!parsed) return;
      const values = await deps.getSheetValues(book.spreadsheetId, parsed.title, { range: parsed.cell });
      valuesByRange.set(range, values);
    }));
  }
  const readValue = (range) => {
    const parsed = parseSheetRange(range);
    const values = valuesByRange.get(range) || [];
    if (values.length === 1 && values[0]?.length === 1) return values[0][0];
    return parsed ? values[parsed.row]?.[parsed.column] : undefined;
  };
  return {
    ...preview,
    rows: preview.rows.map((row) => {
      const markWritten = (target) => {
        if (!target || !valuesByRange.has(target.range)) return target;
        const verified = inspectTarget(readValue(target.range), row.sourceValue, target.range);
        return verified.status === "same"
          ? { ...target, status: "written", value: verified.value, message: "已写入并复核" }
          : { ...target, status: "error", value: verified.value, message: "写入后复核失败：目标值与汇总值不一致" };
      };
      const detail = markWritten(row.detail);
      const total = markWritten(row.total);
      const wrote = [detail, total].some((target) => target?.status === "written");
      return wrote ? { ...row, detail, total, status: "written", message: "已写入并复核" } : { ...row, detail, total };
    })
  };
}

export async function executeShelfBook(book, businessDate, deps = defaultDeps) {
  let preview = await collectShelfBook(book, businessDate, deps);
  const dateUpdates = [...new Map(preview.rows
    .flatMap((row) => [...(row.detail?.dateUpdates || []), ...(row.total?.dateUpdates || [])])
    .map((update) => [update.range, update])).values()];
  if (dateUpdates.length) {
    await deps.batchWrite(book.spreadsheetId, dateUpdates);
    preview = await collectShelfBook(book, businessDate, deps);
  }
  const readyRows = preview.rows.filter((row) => row.status === "ready");
  const valueUpdates = readyRows.flatMap((row) => {
    return [row.detail, row.total]
      .filter((target) => target?.status === "ready" && target.range)
      .map((target) => ({ range: target.range, value: row.sourceValue }));
  });
  await deps.batchWrite(book.spreadsheetId, valueUpdates);
  return valueUpdates.length ? verifyShelfWrites(book, preview, valueUpdates, deps) : preview;
}
