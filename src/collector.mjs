import { batchWrite, getSheetValues, getWorkbook } from "./google-sheets.mjs";
import { mapConcurrent } from "./async-utils.mjs";

const empty = (value) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");
const normalized = (value) => String(value ?? "").trim().toLowerCase().replaceAll(/\s+/g, "");

function channelColumnName(channel) {
  const displayName = String(channel ?? "").trim();
  return displayName.replace(/\s*[\(（][^()（）]*[\)）]\s*$/, "").trim() || displayName;
}

function matches(value, aliases) {
  const target = normalized(value);
  return aliases.some((alias) => target === normalized(alias));
}

function parseNumber(value) {
  if (empty(value)) return { kind: "blank" };
  if (typeof value === "number" && Number.isFinite(value)) return { kind: "number", value };
  const cleaned = String(value).trim().replaceAll(",", "").replace(/[¥￥$%]/g, "");
  if (cleaned !== "" && Number.isFinite(Number(cleaned))) return { kind: "number", value: Number(cleaned) };
  return { kind: "error", raw: value };
}

function dateKey(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    const epoch = Date.UTC(1899, 11, 30);
    return new Date(epoch + value * 86_400_000).toISOString().slice(0, 10);
  }
  const text = String(value ?? "").trim().replace(/[年月/.]/g, "-").replace("日", "");
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const short = text.match(/^(\d{1,2})-(\d{1,2})$/);
  if (short) return `${new Date().getFullYear()}-${short[1].padStart(2, "0")}-${short[2].padStart(2, "0")}`;
  return "";
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
  const matchesDate = values.slice(header.row + 1).filter((row) => dateKey(row[header.date]) === businessDate);
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
    const dateRow = values.findIndex((cells, index) => index > row && dateKey(cells[dateColumn]) === businessDate);
    return { headerRow: row, dateRow };
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

function mapRows(rows, targetValues, target, targetSheet) {
  const metricColumnCache = new Map();
  return rows.map((row) => {
    if (row.status !== "pending") return row;
    const targetChannel = channelColumnName(row.channel);
    if (!target || target.dateRow < 0) return { ...row, targetChannel, status: "error", message: "总表缺少目标日期行" };
    const cacheKey = `${normalized(targetChannel)}\u0000${row.metric}`;
    let column = metricColumnCache.get(cacheKey);
    if (column === undefined) {
      column = locateMetricColumn(targetValues, target, row.channel, row.metric);
      metricColumnCache.set(cacheKey, column);
    }
    if (column < 0) return { ...row, targetChannel, status: "error", message: `总表未找到渠道指标列（匹配键：${targetChannel}）` };
    const targetValue = targetValues[target.dateRow]?.[column];
    const range = `'${targetSheet.replaceAll("'", "''")}'!${columnName(column)}${target.dateRow + 1}`;
    if (empty(targetValue)) return { ...row, targetChannel, status: "ready", targetValue: null, range };
    const parsed = parseNumber(targetValue);
    if (parsed.kind === "number" && parsed.value === row.sourceValue) return { ...row, targetChannel, status: "same", targetValue: parsed.value, range, message: "目标值已一致" };
    return { ...row, targetChannel, status: "conflict", targetValue, range, message: "目标已有不同数值，安全模式不覆盖" };
  });
}

export async function collectWorkbook(source, businessDate) {
  const workbook = await getWorkbook(source.spreadsheetId);
  const visibleSheets = workbook.sheets
    .filter(({ properties }) => !properties.hidden)
    .map(({ properties }) => properties.title);
  if (!visibleSheets.includes(source.targetSheet)) throw new Error(`未找到目标页签：${source.targetSheet}`);
  const channels = visibleSheets.filter((title) => !source.excludedSheets.includes(title));
  const targetValues = await getSheetValues(source.spreadsheetId, source.targetSheet);
  const target = locateTarget(targetValues, businessDate);
  // Channel sheets are independent reads. Fetch them together, then flatten
  // in the original order so result ordering and write semantics are stable.
  const channelValues = await mapConcurrent(channels, async (channel) => ({
    channel,
    values: await getSheetValues(source.spreadsheetId, channel)
  }));
  const rows = channelValues.flatMap(({ channel, values }) => extractChannel(values, source, channel, businessDate));
  return {
    sourceId: source.id,
    sourceName: source.name,
    spreadsheetTitle: workbook.properties.title,
    status: "success",
    businessDate,
    channelCount: channels.length,
    rows: mapRows(rows, targetValues, target, source.targetSheet)
  };
}

export async function executeWorkbook(source, businessDate) {
  const preview = await collectWorkbook(source, businessDate);
  const ready = preview.rows.filter((row) => row.status === "ready");
  await batchWrite(source.spreadsheetId, ready.map((row) => ({ range: row.range, value: row.sourceValue })));
  return {
    ...preview,
    rows: preview.rows.map((row) => row.status === "ready" ? { ...row, status: "written", message: "已写入并保留审计记录" } : row)
  };
}
