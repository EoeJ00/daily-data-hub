export const isEmpty = (value) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

export const normalizeText = (value) => String(value ?? "").trim().toLowerCase().replaceAll(/\s+/g, "");

export function parseNumber(value, transform = (number) => number) {
  if (isEmpty(value)) return { kind: "blank" };
  if (typeof value === "number" && Number.isFinite(value)) return { kind: "number", value: transform(value) };
  const cleaned = String(value).trim().replaceAll(",", "").replace(/[¥￥$%]/g, "");
  if (cleaned !== "" && Number.isFinite(Number(cleaned))) return { kind: "number", value: transform(Number(cleaned)) };
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

export function columnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

export function quoteSheetTitle(title) {
  return `'${String(title ?? "").replaceAll("'", "''")}'`;
}

export function sheetHeaderRange(title, rows = 20) {
  return `${quoteSheetTitle(title)}!1:${rows}`;
}

export function sheetColumnRange(title, column) {
  const name = columnName(column);
  return `${quoteSheetTitle(title)}!${name}:${name}`;
}

export function sheetColumnWindowRange(title, column, startRow, endRow) {
  const name = columnName(column);
  const firstRow = Number.isInteger(startRow) ? Math.max(0, startRow) : 0;
  const lastRow = Number.isInteger(endRow) ? Math.max(firstRow + 1, endRow) : firstRow + 1;
  return `${quoteSheetTitle(title)}!${name}${firstRow + 1}:${name}${lastRow}`;
}

export function projectedColumnValues(values, column) {
  const rows = values || [];
  const fullRows = rows.some((row) => Array.isArray(row) && row.length > 1);
  return rows.map((row) => fullRows ? [row?.[column]] : row);
}

export function mergeProjectedColumns(columns, valueRanges, sample = []) {
  const rows = sample.map((row) => [...row]);
  columns.forEach((column, rangeIndex) => {
    (valueRanges[rangeIndex] || []).forEach((row, rowIndex) => {
      if (!rows[rowIndex]) rows[rowIndex] = [];
      rows[rowIndex][column] = row?.[0];
    });
  });
  return rows;
}

export function mergeProjectedColumnWindows(sample = [], reads = []) {
  const rows = sample.map((row) => [...row]);
  for (const { column, startRow, values } of reads) {
    (values || []).forEach((row, rowIndex) => {
      const absoluteRow = startRow + rowIndex;
      if (!rows[absoluteRow]) rows[absoluteRow] = [];
      rows[absoluteRow][column] = row?.[0];
    });
  }
  return rows;
}

function dateCell(row, column, columnOnly = false) {
  if (!Array.isArray(row)) return undefined;
  return row[column] ?? (columnOnly && row.length === 1 ? row[0] : undefined);
}

function looksDateLike(value) {
  const text = String(value ?? "").trim();
  return Boolean(text && /\d/.test(text) && /[-/.年月日]/.test(text));
}

function validDateKey(value) {
  const text = String(value ?? "");
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === text;
}

export function mergeDateWindows(windows) {
  const sorted = [...(windows || [])]
    .filter(({ startRow, endRow }) => Number.isInteger(startRow) && Number.isInteger(endRow) && endRow > startRow)
    .sort((left, right) => left.startRow - right.startRow || left.endRow - right.endRow);
  const merged = [];
  for (const window of sorted) {
    const previous = merged.at(-1);
    if (previous && window.startRow <= previous.endRow) {
      previous.endRow = Math.max(previous.endRow, window.endRow);
    } else {
      merged.push({ startRow: window.startRow, endRow: window.endRow });
    }
  }
  return merged;
}

export function locateDateWindows(values, {
  headerRow = -1,
  dateColumn,
  businessDate,
  parse = (value) => dateKey(value, businessDate),
  block = true,
  validate = true
} = {}) {
  if (!Array.isArray(values) || !Number.isInteger(headerRow) || headerRow < -1 || !Number.isInteger(dateColumn) || dateColumn < 0) {
    return { ok: false, found: false, windows: [], row: -1, lastDatedRow: -1 };
  }

  const target = String(businessDate ?? "");
  const markers = [];
  let lastDatedRow = -1;
  let malformed = false;
  const columnOnly = values.length > 0 && values.every((row) => Array.isArray(row) && row.length <= 1);
  for (let row = Math.max(0, headerRow + 1); row < values.length; row += 1) {
    const value = dateCell(values[row], dateColumn, columnOnly);
    if (isEmpty(value)) continue;
    let parsed;
    try {
      parsed = parse(value);
    } catch {
      malformed = true;
      continue;
    }
    const matches = Array.isArray(parsed) ? parsed : [parsed];
    if (matches.some((item) => item === target)) markers.push(row);
    if (matches.some((item) => item && !validDateKey(item))) {
      malformed = true;
    } else if (matches.some(Boolean)) {
      lastDatedRow = row;
    } else if (validate && looksDateLike(value)) {
      malformed = true;
    }
  }

  if (malformed) return { ok: false, found: false, windows: [], row: -1, lastDatedRow };

  const windows = markers.map((startRow) => {
    if (!block) return { startRow, endRow: startRow + 1 };
    let endRow = startRow + 1;
    while (endRow < values.length && isEmpty(dateCell(values[endRow], dateColumn, columnOnly))) endRow += 1;
    return { startRow, endRow };
  });
  const merged = mergeDateWindows(windows);
  return {
    ok: true,
    found: merged.length > 0,
    windows: merged,
    row: merged[0]?.startRow ?? -1,
    startRow: merged[0]?.startRow ?? -1,
    endRow: merged[0]?.endRow ?? -1,
    lastDatedRow
  };
}

export function sheetRange(title, row, column) {
  return `${quoteSheetTitle(title)}!${columnName(column)}${row + 1}`;
}

export function planSequentialDateRows(values, header, businessDate, sheetTitle) {
  const existingRow = values.findIndex((row, index) => index > header.row && dateKey(row?.[header.date], businessDate) === businessDate);
  if (existingRow >= 0) return { row: existingRow, updates: [] };

  const datedRows = [];
  for (let row = header.row + 1; row < values.length; row += 1) {
    const date = dateKey(values[row]?.[header.date], businessDate);
    if (date) datedRows.push({ row, date });
  }
  const last = datedRows.at(-1);
  if (!last) {
    const row = header.row + 1;
    return { row, updates: [{ range: sheetRange(sheetTitle, row, header.date), value: businessDate }] };
  }

  const lastTime = Date.parse(`${last.date}T00:00:00Z`);
  const targetTime = Date.parse(`${businessDate}T00:00:00Z`);
  if (!Number.isFinite(lastTime) || !Number.isFinite(targetTime)) return { error: `无法解析 ${sheetTitle} 日期：${last.date} → ${businessDate}` };
  if (targetTime <= lastTime) return { error: `${sheetTitle} 缺少 ${businessDate} 日期行，且该日期早于表内最后日期 ${last.date}，无法向下追加` };

  const dayCount = Math.round((targetTime - lastTime) / 86_400_000);
  const updates = Array.from({ length: dayCount }, (_, index) => {
    const row = last.row + index + 1;
    const value = new Date(lastTime + (index + 1) * 86_400_000).toISOString().slice(0, 10);
    return { range: sheetRange(sheetTitle, row, header.date), value };
  });
  return { row: last.row + dayCount, updates };
}

export function parseSheetRange(range) {
  const separator = String(range ?? "").lastIndexOf("!");
  if (separator < 0) return null;
  const sheetPart = range.slice(0, separator);
  const cell = range.slice(separator + 1);
  const title = sheetPart.startsWith("'") && sheetPart.endsWith("'")
    ? sheetPart.slice(1, -1).replaceAll("''", "'")
    : sheetPart;
  const match = cell.match(/^([A-Z]+)(\d+)$/i);
  if (!match) return null;
  const column = [...match[1].toUpperCase()].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  return { title, cell, row: Number(match[2]) - 1, column };
}

export function inspectTarget(value, sourceValue, range, parse = parseNumber) {
  if (isEmpty(value)) return { status: "ready", value: null, range };
  const parsed = parse(value);
  if (parsed.kind === "number" && parsed.value === sourceValue) return { status: "same", value: parsed.value, range };
  return { status: "conflict", value, range };
}

export function combineTargetStatuses(...targets) {
  const statuses = targets.map((target) => target?.status);
  if (statuses.includes("error")) return "error";
  if (statuses.includes("conflict")) return "conflict";
  if (statuses.includes("ready")) return "ready";
  return statuses.every((status) => status === "same" || status === "written") ? "same" : "error";
}
