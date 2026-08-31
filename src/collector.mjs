import { batchWrite, getSheetValuesBatch, getWorkbook } from "./google-sheets.mjs";
import { dateKey, isEmpty as empty, mergeProjectedColumns, normalizeText as normalized, parseNumber, planSequentialDateRows, sheetColumnRange, sheetHeaderRange, sheetRange } from "./spreadsheet-utils.mjs";

function channelColumnName(channel) {
  const displayName = String(channel ?? "").trim();
  return displayName.replace(/\s*[\(（][^()（）]*[\)）]\s*$/, "").trim() || displayName;
}

function matches(value, aliases) {
  const target = normalized(value);
  return aliases.some((alias) => target === normalized(alias));
}

function findSourceHeader(values, aliases) {
  for (let row = 0; row < Math.min(values.length, 12); row += 1) {
    const cells = values[row] || [];
    const date = cells.findIndex((cell) => matches(cell, aliases.date));
    const spend = cells.findIndex((cell) => matches(cell, aliases.spend));
    const returnSpend = cells.findIndex((cell) => matches(cell, aliases.returnSpend));
    if (date >= 0 && (spend >= 0 || returnSpend >= 0)) return { row, date, spend, returnSpend };
  }
  return null;
}

function extractChannel(values, source, channel, businessDate) {
  const header = findSourceHeader(values, source.aliases);
  const targetChannel = channelColumnName(channel);
  if (!header) return [{ channel, targetChannel, metric: "结构", status: "error", message: "未找到日期/消耗表头" }];
  const matchesDate = values.slice(header.row + 1).filter((row) => dateKey(row[header.date], businessDate) === businessDate);
  if (!matchesDate.length) return [{ channel, targetChannel, metric: "日期", status: "error", message: `缺少 ${businessDate} 记录` }];
  return [
    aggregateMetric(matchesDate, header.spend, channel, "消耗"),
    aggregateMetric(matchesDate, header.returnSpend, channel, "回流消耗")
  ].map((row) => ({ ...row, targetChannel }));
}

function aggregateMetric(rows, column, channel, metric) {
  if (column < 0) return { channel, metric, status: "error", message: `缺少${metric}列` };
  const values = rows.map((row) => parseNumber(row[column]));
  const invalid = values.find((item) => item.kind === "error");
  if (invalid) return { channel, metric, status: "error", message: `非数值：${invalid.raw}` };
  const numbers = values.filter((item) => item.kind === "number").map((item) => item.value);
  if (!numbers.length) return { channel, metric, status: "blank", message: "源单元格为空，已跳过" };
  return { channel, metric, status: "pending", sourceValue: numbers.reduce((sum, value) => sum + value, 0) };
}

function locateTarget(values, businessDate) {
  for (let row = 0; row < Math.min(values.length, 12); row += 1) {
    const dateColumn = (values[row] || []).findIndex((cell) => matches(cell, ["日期", "时间", "date"]));
    if (dateColumn < 0) continue;
    const dateRow = values.findIndex((cells, index) => index > row && dateKey(cells[dateColumn], businessDate) === businessDate);
    return { headerRow: row, dateColumn, dateRow };
  }
  return null;
}

function locateMetricColumn(values, target, channel, metric) {
  const current = values[target.headerRow] || [];
  const previous = values[target.headerRow - 1] || [];
  const channelKey = normalized(channelColumnName(channel));
  const exactNames = metric === "消耗"
    ? [channelKey, `${channelKey}消耗`]
    : [`${channelKey}回流`, `${channelKey}回流消耗`];
  for (let column = 0; column < Math.max(current.length, previous.length); column += 1) {
    const cell = normalized(current[column]);
    const parent = normalized(previous[column]);
    if (exactNames.includes(cell)) return column;
    if (parent === channelKey && (metric === "消耗" ? matches(cell, ["消耗"]) : matches(cell, ["回流", "回流消耗"]))) return column;
    if (metric === "回流消耗" && column > 0 && normalized(current[column - 1]) === channelKey && matches(cell, ["回流", "回流消耗"])) return column;
  }
  return -1;
}

function mapRows(rows, targetValues, target, datePlan, targetSheet, businessDate) {
  const metricColumnCache = new Map();
  return rows.map((row) => {
    if (row.status !== "pending") return row;
    const targetChannel = channelColumnName(row.channel);
    if (!target) return { ...row, targetChannel, status: "error", message: "总表未找到日期表头" };
    if (datePlan.error) return { ...row, targetChannel, status: "error", message: datePlan.error };
    const cacheKey = `${normalized(targetChannel)}\u0000${row.metric}`;
    let column = metricColumnCache.get(cacheKey);
    if (column === undefined) {
      column = locateMetricColumn(targetValues, target, row.channel, row.metric);
      metricColumnCache.set(cacheKey, column);
    }
    if (column < 0) return { ...row, targetChannel, status: "error", message: `总表未找到渠道指标列（匹配键：${targetChannel}）` };
    const targetValue = targetValues[datePlan.row]?.[column];
    const range = sheetRange(targetSheet, datePlan.row, column);
    const dateState = {
      dateUpdates: datePlan.updates,
      message: datePlan.updates.length ? `将自动补充 ${datePlan.updates.length} 个日期行至 ${businessDate}` : undefined
    };
    if (empty(targetValue)) return {
      ...row,
      targetChannel,
      status: "ready",
      targetValue: null,
      range,
      ...dateState
    };
    const parsed = parseNumber(targetValue);
    if (parsed.kind === "number" && parsed.value === row.sourceValue) return { ...row, targetChannel, status: "same", targetValue: parsed.value, range, ...dateState, message: dateState.message || "目标值已一致" };
    return { ...row, targetChannel, status: "conflict", targetValue, range, ...dateState, message: dateState.message ? `${dateState.message}；目标已有不同数值，安全模式不覆盖` : "目标已有不同数值，安全模式不覆盖" };
  });
}

const defaultDeps = { batchWrite, getSheetValuesBatch, getWorkbook };

export async function collectWorkbook(source, businessDate, deps = defaultDeps) {
  const workbook = await deps.getWorkbook(source.spreadsheetId);
  const visibleSheets = workbook.sheets
    .filter(({ properties }) => !properties.hidden)
    .map(({ properties }) => properties.title);
  if (!visibleSheets.includes(source.targetSheet)) throw new Error(`未找到目标页签：${source.targetSheet}`);
  const channels = visibleSheets.filter((title) => !source.excludedSheets.includes(title));
  const titles = [...new Set([source.targetSheet, ...channels])];
  const samples = await deps.getSheetValuesBatch(source.spreadsheetId, titles.map((title) => sheetHeaderRange(title)));
  const sampleByTitle = new Map(titles.map((title, index) => [title, samples[index] || []]));
  const targetSample = sampleByTitle.get(source.targetSheet) || [];
  const targetHeader = locateTarget(targetSample, businessDate);
  const targetColumns = new Set(targetHeader ? [targetHeader.dateColumn] : []);
  for (const channel of channels) {
    for (const metric of ["消耗", "回流消耗"]) {
      const column = targetHeader ? locateMetricColumn(targetSample, targetHeader, channel, metric) : -1;
      if (column >= 0) targetColumns.add(column);
    }
  }
  const specs = titles.map((title) => {
    if (title === source.targetSheet) return { title, columns: [...targetColumns] };
    const header = findSourceHeader(sampleByTitle.get(title) || [], source.aliases);
    return { title, columns: header ? [...new Set([header.date, header.spend, header.returnSpend].filter((column) => column >= 0))] : [] };
  });
  const ranges = specs.flatMap(({ title, columns }) => columns.map((column) => sheetColumnRange(title, column)));
  const projected = await deps.getSheetValuesBatch(source.spreadsheetId, ranges);
  let cursor = 0;
  const valuesByTitle = new Map(specs.map(({ title, columns }) => {
    const values = mergeProjectedColumns(columns, projected.slice(cursor, cursor + columns.length), sampleByTitle.get(title));
    cursor += columns.length;
    return [title, values];
  }));
  const targetValues = valuesByTitle.get(source.targetSheet) || [];
  const target = locateTarget(targetValues, businessDate);
  const datePlan = target
    ? planSequentialDateRows(targetValues, { row: target.headerRow, date: target.dateColumn }, businessDate, source.targetSheet)
    : null;
  const channelValues = channels.map((channel) => ({ channel, values: valuesByTitle.get(channel) || [] }));
  const rows = channelValues.flatMap(({ channel, values }) => extractChannel(values, source, channel, businessDate));
  return {
    sourceId: source.id,
    sourceName: source.name,
    spreadsheetTitle: workbook.properties.title,
    status: "success",
    businessDate,
    channelCount: channels.length,
    rows: mapRows(rows, targetValues, target, datePlan, source.targetSheet, businessDate)
  };
}

export async function executeWorkbook(source, businessDate, deps = defaultDeps) {
  let preview = await collectWorkbook(source, businessDate, deps);
  const dateUpdates = [...new Map(preview.rows
    .flatMap((row) => row.dateUpdates || [])
    .map((update) => [update.range, update])).values()];
  if (dateUpdates.length) {
    await deps.batchWrite(source.spreadsheetId, dateUpdates);
    preview = await collectWorkbook(source, businessDate, deps);
  }
  const ready = preview.rows.filter((row) => row.status === "ready");
  await deps.batchWrite(source.spreadsheetId, ready.map((row) => ({ range: row.range, value: row.sourceValue })));
  return {
    ...preview,
    rows: preview.rows.map((row) => row.status === "ready" ? { ...row, status: "written", message: "已写入并保留审计记录" } : row)
  };
}
