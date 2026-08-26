import { batchWrite, getSheetValues, getSheetValuesBatch, getWorkbook } from "./google-sheets.mjs";
import { mapConcurrent } from "./async-utils.mjs";
import { combineTargetStatuses as combineStatus, dateKey, inspectTarget as inspectSpreadsheetTarget, isEmpty as empty, parseNumber as parseSpreadsheetNumber, quoteSheetTitle, sheetRange } from "./spreadsheet-utils.mjs";
import { looseRouteScore, normalizeRoute, normalizeScenarioText as normalized, routeIdentity, routeScore, shooterFallbackScore, totalChainScore } from "./scenario2-route.mjs";

export { dateKey } from "./spreadsheet-utils.mjs";
export { normalizeRoute } from "./scenario2-route.mjs";

const sourceAliases = {
  date: ["日期", "时间", "date"],
  channel: ["渠道号", "渠道名", "渠道", "链名", "channel", "channel name", "channel id"],
  spend: ["花费（U）", "花费(U)", "花费", "消耗", "广告消耗", "spend"],
  returnSpend: ["回流", "回流消耗", "return spend"]
};

function matches(value, aliases) {
  const target = normalized(value);
  return aliases.some((alias) => target === normalized(alias));
}

function headerScore(value, field) {
  const text = normalized(value);
  if (!text) return 0;
  if (field === "spend" && !/\d+%|卢比|inr|服务费|累计|总消耗|实际/.test(text)
    && /(?:消耗|花费).*(?:u|usd|usdt)$|(?:usd|usdt)(?:spend|cost)/.test(text)) return 120;
  if (field === "returnSpend" && /(?:回流|return).*(?:u|usd|usdt)$/.test(text)) return 120;
  if (matches(value, sourceAliases[field])) return 100;
  if (field === "date") return /日期|时间|date|day/.test(text) ? 50 : 0;
  if (field === "channel") return /渠道|链名|channel/.test(text) ? 50 : 0;
  if (field === "returnSpend") {
    if (!/回流|return/.test(text)) return 0;
    return /消耗|花费|spend|cost/.test(text) ? 80 : 60;
  }
  if (field === "spend") {
    if (/回流|return/.test(text) || !/消耗|花费|spend|cost/.test(text)) return 0;
    if (/\d+%|卢比|inr|服务费|累计|总消耗/.test(text)) return 30;
    return /实际|服务费|总消耗|累计/.test(text) ? 30 : 60;
  }
  return 0;
}

function findFieldColumn(cells, field) {
  let best = { column: -1, score: 0 };
  for (let column = 0; column < cells.length; column += 1) {
    const score = headerScore(cells[column], field);
    if (score > best.score) best = { column, score };
  }
  return best.column;
}

function findFieldColumns(cells) {
  return {
    date: findFieldColumn(cells, "date"),
    channel: findFieldColumn(cells, "channel"),
    spend: findFieldColumn(cells, "spend"),
    returnSpend: findFieldColumn(cells, "returnSpend")
  };
}

function findUniqueFieldColumn(cells, field) {
  const scored = cells
    .map((value, column) => ({ column, score: headerScore(value, field) }))
    .filter(({ score }) => score > 0);
  const bestScore = Math.max(0, ...scored.map(({ score }) => score));
  const best = scored.filter(({ score }) => score === bestScore);
  return best.length === 1 ? best[0].column : -1;
}

function looksLikeDateValue(value, businessDate) {
  if (typeof value === "number") {
    const year = businessDate.slice(0, 4);
    return Number.isInteger(value) && value >= 30_000 && value <= 80_000 && (!year || dateKey(value, businessDate).startsWith(year));
  }
  const text = String(value ?? "").trim();
  const match = text.match(/^(?:\d{4}[年/.-])?(\d{1,2})[月/.-](\d{1,2})日?$/);
  if (!match) return false;
  const month = Number(match[1]);
  const day = Number(match[2]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 && Boolean(dateKey(value, businessDate));
}

function inferDateColumn(values, startRow, businessDate) {
  const width = Math.max(0, ...values.slice(startRow, startRow + 20).map((row) => row?.length || 0));
  const candidates = [];
  for (let column = 0; column < width; column += 1) {
    let matches = 0;
    let conflicts = 0;
    for (const row of values.slice(startRow, startRow + 20)) {
      const value = row?.[column];
      if (empty(value)) continue;
      if (looksLikeDateValue(value, businessDate)) matches += 1;
      else conflicts += 1;
    }
    if (matches) candidates.push({ column, score: matches * 10 - conflicts });
  }
  const bestScore = Math.max(-Infinity, ...candidates.map(({ score }) => score));
  if (bestScore <= 0) return -1;
  const best = candidates.filter(({ score }) => score === bestScore);
  return best.length === 1 ? best[0].column : -1;
}

function inferTabularHeader(values, businessDate) {
  const limit = Math.min(8, values.length - 1);
  for (let row = 0; row < limit; row += 1) {
    const band = values.slice(Math.max(0, row - 2), row + 1);
    const width = Math.max(0, ...band.map((cells) => cells?.length || 0));
    const composite = Array.from({ length: width }, (_, column) => band
      .map((cells) => String(cells?.[column] ?? "").trim())
      .filter(Boolean)
      .join(" "));
    const channel = findUniqueFieldColumn(composite, "channel");
    const spend = findUniqueFieldColumn(composite, "spend");
    const returnSpend = findUniqueFieldColumn(composite, "returnSpend");
    const namedDate = findUniqueFieldColumn(composite, "date");
    const date = namedDate >= 0 ? namedDate : inferDateColumn(values, row + 1, businessDate);
    if (date >= 0 && channel >= 0 && (spend >= 0 || returnSpend >= 0)) {
      return { row, date, channel, spend, returnSpend };
    }
  }
  return null;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseNumber(value) {
  return parseSpreadsheetNumber(value, roundMoney);
}

function markDuplicateRecords(records) {
  const routeCounts = new Map();
  for (const row of records.filter((item) => item.status === "pending")) {
    const key = `${row.routeChain || row.routeCode}:${row.metric}`;
    routeCounts.set(key, (routeCounts.get(key) || 0) + 1);
  }
  return records.map((row) => {
    const duplicate = row.status === "pending" && routeCounts.get(`${row.routeChain || row.routeCode}:${row.metric}`) > 1;
    return duplicate ? { ...row, status: "error", message: `同一日报块内渠道 ${row.routeCode} 的${row.metric}出现多次` } : row;
  });
}

function dateInText(text, businessDate) {
  const value = String(text ?? "").trim();
  const full = value.match(/\d{4}[年./-]\d{1,2}[月./-]\d{1,2}日?/g) || [];
  const short = value.match(/^(?:日期\s*[:：]?\s*)?(\d{1,2}[./]\d{1,2})(?:日)?$/)?.[1];
  const candidates = short ? [...full, short] : full;
  return candidates.map((value) => dateKey(value, businessDate)).find(Boolean) || "";
}

function channelInText(text) {
  const clean = String(text ?? "").replace(/[（]/g, "(").replace(/[）]/g, ")");
  return clean.match(/[a-z0-9]+(?:[-_][a-z0-9]+){2,}[-_]0*\d+(?:\s*\([^()]+\))?/i)?.[0]
    || clean.match(/(?:^|\s)(0*\d+\s*\([^()]+\))/)?.[1]
    || "";
}

function labeledNumber(text, metric) {
  const pattern = metric === "消耗"
    ? /(?:花费(?:\s*\(?u\)?)?|(?:^|[\s,，;；])消耗)\s*[:：=]?\s*([-+]?\d[\d,]*(?:\.\d+)?)/i
    : /回流(?:消耗)?\s*[:：=]?\s*([-+]?\d[\d,]*(?:\.\d+)?)/i;
  return String(text ?? "").match(pattern)?.[1];
}

export function extractBigCellRecords(values, businessDate, sourceSheet = "甲方日报") {
  const grouped = [];
  for (let row = 0; row < values.length; row += 1) {
    const cells = values[row] || [];
    const rowDate = cells.map((cell) => dateKey(cell, businessDate)).find((value) => value === businessDate) || "";
    for (let column = 0; column < cells.length; column += 1) {
      const text = String(cells[column] ?? "");
      if (!text.includes("\n") && !text.includes("\r")) continue;
      let activeDate = rowDate;
      let activeChannel = "";
      let activeRoute = null;
      const records = new Map();
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const lineDate = dateInText(line, businessDate);
        if (lineDate) activeDate = lineDate;
        if (activeDate !== businessDate) continue;
        const foundChannel = channelInText(line);
        if (foundChannel) {
          activeChannel = foundChannel;
          activeRoute = normalizeRoute(foundChannel);
        }
        if (!activeRoute?.code) continue;
        const key = `${routeIdentity(activeRoute)}:${activeRoute.shooter}`;
        if (!records.has(key)) records.set(key, { channel: activeChannel, route: activeRoute, spend: undefined, returnSpend: undefined });
        const current = records.get(key);
        const spend = labeledNumber(line, "消耗");
        const returnSpend = labeledNumber(line, "回流消耗");
        if (spend !== undefined) current.spend = spend;
        if (returnSpend !== undefined) current.returnSpend = returnSpend;
      }
      for (const current of records.values()) {
        grouped.push(
          metricRecord(current.channel, current.route, "消耗", parseNumber(current.spend), sourceSheet, row, column),
          metricRecord(current.channel, current.route, "回流消耗", parseNumber(current.returnSpend), sourceSheet, row, column)
        );
      }
    }
  }
  return markDuplicateRecords(grouped);
}

function findHeaders(values, businessDate) {
  const headers = [];
  for (let row = 0; row < values.length; row += 1) {
    const { date, channel, spend, returnSpend } = findFieldColumns(values[row] || []);
    if (date >= 0 && channel >= 0) {
      headers.push({ row, date, channel, spend, returnSpend });
    }
  }
  const inferred = inferTabularHeader(values, businessDate);
  if (inferred && !headers.some(({ row }) => row === inferred.row)) headers.push(inferred);
  return headers.sort((left, right) => left.row - right.row);
}

function metricRecord(channel, route, metric, parsed, sourceSheet, row, column, missingColumnStatus = "blank") {
  const identity = { channel, routeCode: route.code, routeChain: routeIdentity(route), shooter: route.shooter, metric, sourceSheet };
  if (column < 0) {
    const error = missingColumnStatus === "error";
    const message = error
      ? (parsed.kind === "error" ? parsed.raw : `甲方表缺少${metric}列`)
      : "甲方源单元格为空，已跳过";
    return { ...identity, status: error ? "error" : "blank", message };
  }
  if (parsed.kind === "blank") return { ...identity, status: "blank", message: "甲方源单元格为空，已跳过" };
  if (parsed.kind === "error") return { ...identity, status: "error", message: `甲方源值不是数字：${parsed.raw}` };
  return {
    ...identity,
    sourceValue: parsed.value,
    sourceRange: sheetRange(sourceSheet, row, column),
    status: "pending"
  };
}

export function extractClientRecords(values, businessDate, sourceSheet = "甲方日报") {
  const headers = findHeaders(values, businessDate);
  const records = [];
  let matchedBlock = false;
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    const end = headers[index + 1]?.row ?? values.length;
    let activeDate = "";
    for (let row = header.row + 1; row < end; row += 1) {
      const cells = values[row] || [];
      const first = normalized(cells[header.date]);
      if (first === normalized("汇总") || first === normalized("日报总表")) break;
      if (!empty(cells[header.date])) activeDate = dateKey(cells[header.date], businessDate);
      if (activeDate !== businessDate) continue;
      matchedBlock = true;
      const channel = String(cells[header.channel] ?? "").trim();
      if (!channel) continue;
      const route = normalizeRoute(channel);
      if (!route.code) {
        records.push({ channel, routeCode: "", shooter: route.shooter, metric: "渠道", status: "error", message: "无法从链名提取渠道编号", sourceSheet });
        continue;
      }
      records.push(
        metricRecord(channel, route, "消耗", parseNumber(cells[header.spend]), sourceSheet, row, header.spend),
        metricRecord(channel, route, "回流消耗", parseNumber(cells[header.returnSpend]), sourceSheet, row, header.returnSpend)
      );
    }
  }
  const bigCellRows = extractBigCellRecords(values, businessDate, sourceSheet);
  if (!headers.length) return bigCellRows.length ? bigCellRows : [{ channel: "—", routeCode: "", metric: "结构", status: "error", message: "甲方表未找到标准表头或可识别的大单元格日报", sourceSheet }];
  if (!matchedBlock) return bigCellRows.length ? bigCellRows : [{ channel: "—", routeCode: "", metric: "日期", status: "error", message: `甲方表缺少 ${businessDate} 日报块`, sourceSheet }];
  return markDuplicateRecords(records);
}

function findStandaloneHeaders(values) {
  const headers = [];
  for (let row = 0; row < values.length; row += 1) {
    const { date, channel, spend, returnSpend } = findFieldColumns(values[row] || []);
    if (date >= 0 && (spend >= 0 || returnSpend >= 0)) headers.push({ row, date, channel, spend, returnSpend });
  }
  return headers;
}

function standaloneMetricRows(values, businessDate, sourceSheet, routeHint) {
  const headers = findStandaloneHeaders(values);
  if (!headers.length) return [];
  const records = [];
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    const end = headers[index + 1]?.row ?? values.length;
    let activeDate = "";
    for (let row = header.row + 1; row < end; row += 1) {
      const cells = values[row] || [];
      const dateCell = normalized(cells[header.date]);
      if (dateCell === normalized("汇总") || dateCell === normalized("日报总表")) break;
      if (!empty(cells[header.date])) activeDate = dateKey(cells[header.date], businessDate);
      if (activeDate !== businessDate) continue;
      const channel = header.channel >= 0 && !empty(cells[header.channel]) ? String(cells[header.channel]).trim() : routeHint.raw;
      const route = normalizeRoute(channel);
      if (routeScore(route, routeHint) === 0) {
        records.push({ channel, routeCode: route.code, routeChain: routeIdentity(route), shooter: route.shooter, metric: "渠道", status: "error", message: `日期 ${businessDate} 行链名与工作表 ${sourceSheet} 不一致`, sourceSheet });
        continue;
      }
      records.push(
        metricRecord(channel, routeHint, "消耗", parseNumber(cells[header.spend]), sourceSheet, row, header.spend),
        metricRecord(channel, routeHint, "回流消耗", parseNumber(cells[header.returnSpend]), sourceSheet, row, header.returnSpend)
      );
    }
  }
  return records;
}

function standaloneBigCellRecords(values, businessDate, sourceSheet, routeHint) {
  const records = [];
  for (let row = 0; row < values.length; row += 1) {
    const cells = values[row] || [];
    for (let column = 0; column < cells.length; column += 1) {
      const text = String(cells[column] ?? "");
      if (!text.includes("\n") && !text.includes("\r")) continue;
      let activeDate = "";
      let spend;
      let returnSpend;
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const lineDate = dateInText(line, businessDate);
        if (lineDate) activeDate = lineDate;
        if (activeDate !== businessDate) continue;
        const nextSpend = labeledNumber(line, "消耗");
        const nextReturn = labeledNumber(line, "回流消耗");
        if (nextSpend !== undefined) spend = nextSpend;
        if (nextReturn !== undefined) returnSpend = nextReturn;
      }
      if (!activeDate) continue;
      records.push(
        metricRecord(routeHint.raw, routeHint, "消耗", parseNumber(spend), sourceSheet, row, column),
        metricRecord(routeHint.raw, routeHint, "回流消耗", parseNumber(returnSpend), sourceSheet, row, column)
      );
    }
  }
  return records;
}

export function extractStandaloneChainRecords(values, businessDate, sourceSheet, chainHint) {
  const routeHint = typeof chainHint === "string" ? normalizeRoute(chainHint) : chainHint;
  if (!routeHint?.code) return [{ channel: String(chainHint ?? ""), routeCode: "", metric: "渠道", status: "error", message: "独立链工作表名称无法识别渠道编号", sourceSheet }];
  const rows = standaloneMetricRows(values, businessDate, sourceSheet, routeHint);
  const fallback = rows.length ? rows : standaloneBigCellRecords(values, businessDate, sourceSheet, routeHint);
  if (!fallback.length) {
    return [
      metricRecord(routeHint.raw, routeHint, "消耗", { kind: "error", raw: `缺少 ${businessDate} 日期记录` }, sourceSheet, -1, -1, "error"),
      metricRecord(routeHint.raw, routeHint, "回流消耗", { kind: "error", raw: `缺少 ${businessDate} 日期记录` }, sourceSheet, -1, -1, "error")
    ];
  }
  return markDuplicateRecords(fallback);
}

function findDetailHeader(values) {
  for (let row = 0; row < Math.min(values.length, 16); row += 1) {
    const { date, channel, spend, returnSpend } = findFieldColumns(values[row] || []);
    if (date >= 0 && channel >= 0 && (spend >= 0 || returnSpend >= 0)) return { row, date, channel, spend, returnSpend };
  }
  return null;
}

function findDateRow(values, header, businessDate) {
  return values.findIndex((row, index) => index > header.row && dateKey(row?.[header.date], businessDate) === businessDate);
}

function inspectTarget(value, sourceValue, range) {
  return inspectSpreadsheetTarget(value, sourceValue, range, parseNumber);
}

function chooseDetailSheet(descriptors, row) {
  const sourceRoute = normalizeRoute(row.channel);
  const scored = descriptors
    .map((item) => ({ item, score: looseRouteScore(sourceRoute, item.route) }))
    .filter(({ score }) => score > 0);
  const maxScore = Math.max(0, ...scored.map(({ score }) => score));
  let matches = scored.filter(({ score }) => score === maxScore).map(({ item }) => item);
  if (row.shooter) matches = matches.filter((item) => item.route.shooter === row.shooter);
  if (!matches.length) return { error: `未找到渠道 ${row.channel} 对应的投手页签` };
  if (matches.length > 1) return { error: `渠道 ${row.channel} 匹配到多个投手页签` };
  return { descriptor: matches[0] };
}

function detailDescriptors(ownWorkbook, targetSheet = "总表") {
  const visible = ownWorkbook.sheets
    .filter(({ properties }) => !properties.hidden)
    .map(({ properties }) => properties);
  const total = visible.find((sheet) => sheet.title === targetSheet);
  return {
    totalSheet: total,
    details: visible
      .filter((sheet) => sheet.title !== total?.title)
      .map((sheet) => ({ sheet, route: normalizeRoute(sheet.title) }))
      .filter((item) => item.route.code)
  };
}

function chooseClientChainSheet(clientSheets, descriptor) {
  const scored = clientSheets
    .map((sheet) => ({ sheet, route: normalizeRoute(sheet.title), score: looseRouteScore(descriptor.route, normalizeRoute(sheet.title)) }))
    .filter((item) => item.score > 0)
    .filter((item) => !descriptor.route.shooter || !item.route.shooter || item.route.shooter === descriptor.route.shooter);
  const maxScore = Math.max(0, ...scored.map((item) => item.score));
  let matches = scored.filter((item) => item.score === maxScore);
  if (descriptor.route.shooter) {
    const exactShooter = matches.filter((item) => item.route.shooter === descriptor.route.shooter);
    if (exactShooter.length) matches = exactShooter;
  }
  if (!matches.length) return { error: `甲方表未找到链名 ${descriptor.route.base} 对应的独立工作表` };
  if (matches.length > 1) return { error: `甲方表中链名 ${descriptor.route.base} 匹配到多个独立工作表` };
  return { sheet: matches[0].sheet, route: matches[0].route };
}

async function collectChainSheetRecords(pair, businessDate, clientSheets, ownDescriptors, deps) {
  const matchCache = new Map();
  const getMatch = (descriptor) => {
    const key = descriptor.sheet.title;
    if (!matchCache.has(key)) matchCache.set(key, chooseClientChainSheet(clientSheets, descriptor));
    return matchCache.get(key);
  };
  const hasChainSheets = ownDescriptors.details.some((descriptor) => getMatch(descriptor).sheet);
  if (!hasChainSheets) return null;
  const matchedTitles = [...new Set(ownDescriptors.details
    .map((descriptor) => getMatch(descriptor).sheet?.title)
    .filter(Boolean))];
  const clientValues = await readSheetMap(pair.client.spreadsheetId, matchedTitles, deps);
  const rows = [];
  for (const descriptor of ownDescriptors.details) {
    const match = getMatch(descriptor);
    if (match.error) {
      rows.push(
        metricRecord(descriptor.sheet.title, descriptor.route, "消耗", { kind: "error", raw: match.error }, descriptor.sheet.title, -1, -1, "error"),
        metricRecord(descriptor.sheet.title, descriptor.route, "回流消耗", { kind: "error", raw: match.error }, descriptor.sheet.title, -1, -1, "error")
      );
      continue;
    }
    const values = clientValues.get(match.sheet.title);
    rows.push(...extractStandaloneChainRecords(values, businessDate, match.sheet.title, match.route));
  }
  return rows;
}

function totalHeaderMetric(cells, column) {
  const text = String(cells[column] ?? "").trim();
  const isReturn = /回流/.test(text);
  let base = text.replace(/回流消耗|回流/g, "").trim();
  if (isReturn && !base) {
    for (let previous = column - 1; previous >= 0; previous -= 1) {
      const candidate = String(cells[previous] ?? "").trim();
      if (!candidate || /回流/.test(candidate)) continue;
      base = candidate;
      break;
    }
  }
  return { metric: isReturn ? "回流消耗" : "消耗", route: normalizeRoute(base) };
}

export function locateTotalColumn(values, target, targetRoute, metric) {
  const chainCandidates = [];
  const shooterCandidates = [];
  for (const row of [target.headerRow, target.headerRow - 1].filter((value) => value >= 0)) {
    for (let column = 0; column < (values[row] || []).length; column += 1) {
      const parsed = totalHeaderMetric(values[row], column);
      if (parsed.metric !== metric) continue;
      const chainScore = totalChainScore(targetRoute, parsed.route);
      if (chainScore > 0) chainCandidates.push({ column, score: chainScore });
      const shooterScore = shooterFallbackScore(targetRoute, parsed.route);
      if (shooterScore > 0) shooterCandidates.push({ column, score: shooterScore });
    }
  }
  const candidates = chainCandidates.length ? chainCandidates : shooterCandidates;
  const maxScore = Math.max(0, ...candidates.map(({ score }) => score));
  const unique = [...new Set(candidates.filter(({ score }) => score === maxScore).map(({ column }) => column))];
  return unique.length === 1 ? unique[0] : unique.length ? -2 : -1;
}

function locateTotal(values, businessDate) {
  for (let row = 0; row < Math.min(values.length, 16); row += 1) {
    const dateColumn = findFieldColumn(values[row] || [], "date");
    if (dateColumn < 0) continue;
    return { headerRow: row, dateColumn, dateRow: values.findIndex((cells, index) => index > row && dateKey(cells?.[dateColumn], businessDate) === businessDate) };
  }
  return null;
}

async function readSheetMap(spreadsheetId, titles, deps, options = {}) {
  const uniqueTitles = [...new Set(titles)];
  if (deps.getSheetValuesBatch) {
    const ranges = uniqueTitles.map(quoteSheetTitle);
    const values = await deps.getSheetValuesBatch(spreadsheetId, ranges, options);
    return new Map(uniqueTitles.map((title, index) => [title, values[index] || []]));
  }
  return new Map(await mapConcurrent(uniqueTitles, async (title) => [
    title,
    await deps.getSheetValues(spreadsheetId, title, options)
  ], 6));
}

async function mapTargets(pair, businessDate, sourceRows, ownWorkbook, deps) {
  const { totalSheet, details } = detailDescriptors(ownWorkbook, pair.targetSheet || "总表");
  if (!totalSheet) throw new Error(`自己的日报表未找到目标页签：${pair.targetSheet || "总表"}`);
  const targetDescriptors = details;
  const totalValues = (await readSheetMap(pair.own.spreadsheetId, [totalSheet.title], deps, { valueRenderOption: "FORMATTED_VALUE" })).get(totalSheet.title) || [];
  const totalTarget = locateTotal(totalValues, businessDate);
  const matchCache = new Map();
  const getMatch = (row) => {
    const key = `${row.channel}\u0000${row.shooter || ""}`;
    if (!matchCache.has(key)) matchCache.set(key, chooseDetailSheet(targetDescriptors, row));
    return matchCache.get(key);
  };
  const matchedSheets = [...new Set(sourceRows
    .filter((row) => row.status === "pending")
    .map((row) => getMatch(row).descriptor?.sheet.title)
    .filter(Boolean))];
  const detailCache = await readSheetMap(pair.own.spreadsheetId, matchedSheets, deps);
  const detailMetaCache = new Map();
  const totalColumnCache = new Map();
  const rows = [];

  for (const row of sourceRows) {
    if (row.status !== "pending") {
      rows.push(row);
      continue;
    }
    const match = getMatch(row);
    if (match.error) {
      rows.push({ ...row, status: "error", message: match.error });
      continue;
    }
    const detailSheet = match.descriptor.sheet.title;
    const detailValues = detailCache.get(detailSheet);
    let detailMeta = detailMetaCache.get(detailSheet);
    if (!detailMeta) {
      const detailHeader = findDetailHeader(detailValues);
      detailMeta = detailHeader
        ? { detailHeader, detailDateRow: findDateRow(detailValues, detailHeader, businessDate) }
        : { detailHeader: null, detailDateRow: -1 };
      detailMetaCache.set(detailSheet, detailMeta);
    }
    const { detailHeader, detailDateRow } = detailMeta;
    if (!detailHeader) {
      rows.push({ ...row, targetSheet: detailSheet, status: "error", message: "投手页签未找到日期、渠道号、花费和回流表头" });
      continue;
    }
    if (detailDateRow < 0) {
      rows.push({ ...row, targetSheet: detailSheet, status: "error", message: `投手页签缺少 ${businessDate} 日期行` });
      continue;
    }
    const channelCell = detailValues[detailDateRow]?.[detailHeader.channel];
    const targetRoute = normalizeRoute(channelCell);
    if (!empty(channelCell) && routeScore(targetRoute, match.descriptor.route) === 0) {
      rows.push({ ...row, targetSheet: detailSheet, status: "error", message: `目标日期行渠道号 ${channelCell} 与页签渠道 ${match.descriptor.route.base} 不一致` });
      continue;
    }
    const detailColumn = row.metric === "消耗" ? detailHeader.spend : detailHeader.returnSpend;
    if (detailColumn < 0) {
      rows.push({ ...row, targetSheet: detailSheet, status: "error", message: `投手页签缺少${row.metric}列` });
      continue;
    }
    const detail = inspectTarget(detailValues[detailDateRow]?.[detailColumn], row.sourceValue, sheetRange(detailSheet, detailDateRow, detailColumn));
    let total;
    if (!totalTarget || totalTarget.dateRow < 0) {
      total = { status: "error", range: "", value: null, message: `总表缺少 ${businessDate} 日期行` };
    } else {
      const totalKey = `${match.descriptor.route.fullChain || match.descriptor.route.code}\u0000${row.metric}`;
      let totalColumn = totalColumnCache.get(totalKey);
      if (totalColumn === undefined) {
        totalColumn = locateTotalColumn(totalValues, totalTarget, match.descriptor.route, row.metric);
        totalColumnCache.set(totalKey, totalColumn);
      }
      total = totalColumn === -2
        ? { status: "error", range: "", value: null, message: `总表渠道 ${match.descriptor.route.base} 的${row.metric}列不唯一` }
        : totalColumn < 0
          ? { status: "error", range: "", value: null, message: `总表未找到渠道 ${match.descriptor.route.base} 的${row.metric}列` }
          : inspectTarget(totalValues[totalTarget.dateRow]?.[totalColumn], row.sourceValue, sheetRange(totalSheet.title, totalTarget.dateRow, totalColumn));
    }
    const status = combineStatus(detail, total);
    const notes = [];
    if (empty(channelCell)) notes.push("目标日期行渠道号为空，已按唯一页签编号定位");
    if (detail.status === "conflict") notes.push("投手日报已有不同值");
    if (total.status === "conflict") notes.push("总表已有不同值");
    if (detail.message) notes.push(detail.message);
    if (total.message) notes.push(total.message);
    rows.push({
      ...row,
      routeKey: match.descriptor.route.base,
      status,
      targetSheet: detailSheet,
      targetChannel: channelCell || match.descriptor.route.base,
      detail,
      total,
      message: notes.join("；") || (status === "same" ? "投手日报与总表均已一致" : "等待安全写入")
    });
  }
  return rows;
}

const defaultDeps = { getWorkbook, getSheetValues, getSheetValuesBatch, batchWrite };

function withWorkbookCache(deps) {
  const cache = new Map();
  return {
    ...deps,
    getWorkbook(spreadsheetId) {
      if (!cache.has(spreadsheetId)) {
        const request = Promise.resolve(deps.getWorkbook(spreadsheetId)).catch((error) => {
          cache.delete(spreadsheetId);
          throw error;
        });
        cache.set(spreadsheetId, request);
      }
      return cache.get(spreadsheetId);
    }
  };
}

export async function collectScenario2Pair(pair, businessDate, deps = defaultDeps) {
  const [clientWorkbook, ownWorkbook] = await Promise.all([
    deps.getWorkbook(pair.client.spreadsheetId),
    deps.getWorkbook(pair.own.spreadsheetId)
  ]);
  const clientSheets = clientWorkbook.sheets
    .filter(({ properties }) => !properties.hidden)
    .map(({ properties }) => properties);
  if (!clientSheets.length) throw new Error("甲方日报表没有可读取的页签");
  const ownDescriptors = detailDescriptors(ownWorkbook, pair.targetSheet || "总表");
  let sourceRows = await collectChainSheetRecords(pair, businessDate, clientSheets, ownDescriptors, deps);
  let sourceSheet = "多链独立工作表";
  if (!sourceRows) {
    const selected = clientSheets.find((sheet) => String(sheet.sheetId) === String(pair.client.gid)) || clientSheets[0];
    const clientValues = await deps.getSheetValues(pair.client.spreadsheetId, selected.title);
    sourceRows = extractClientRecords(clientValues, businessDate, selected.title);
    if (sourceRows.some((row) => row.metric === "结构" && row.status === "error")) {
      sourceRows = sourceRows.map((row) => row.metric === "结构" && row.status === "error"
        ? {
            ...row,
            message: `${row.message}；当前页签“${selected.title}”不是可识别的日报，且未找到与自己的日报链名相匹配的甲方独立页签`
          }
        : row);
    }
    sourceSheet = selected.title;
  }
  const rows = await mapTargets(pair, businessDate, sourceRows, ownWorkbook, deps);
  return {
    pairId: pair.id,
    pairName: pair.name,
    sourceName: clientWorkbook.properties.title,
    targetName: ownWorkbook.properties.title,
    sourceSheet,
    status: "success",
    businessDate,
    channelCount: new Set(rows.map((row) => row.routeChain || normalized(row.channel) || row.routeKey || row.routeCode).filter(Boolean)).size,
    rows
  };
}

export async function executeScenario2Pair(pair, businessDate, deps = defaultDeps) {
  const runDeps = withWorkbookCache(deps);
  const preview = await collectScenario2Pair(pair, businessDate, runDeps);
  const detailUpdates = preview.rows
    .filter((row) => row.status === "ready" && row.detail?.status === "ready" && row.total?.status !== "conflict" && row.total?.status !== "error")
    .map((row) => ({ range: row.detail.range, value: row.sourceValue }));
  await runDeps.batchWrite(pair.own.spreadsheetId, detailUpdates);

  const afterDetail = await collectScenario2Pair(pair, businessDate, runDeps);
  const totalUpdates = afterDetail.rows
    .filter((row) => row.detail?.status === "same" && row.total?.status === "ready")
    .map((row) => ({ range: row.total.range, value: row.sourceValue }));
  await runDeps.batchWrite(pair.own.spreadsheetId, totalUpdates);

  const confirmed = await collectScenario2Pair(pair, businessDate, runDeps);
  const writtenRanges = new Set([...detailUpdates, ...totalUpdates].map((item) => item.range));
  return {
    ...confirmed,
    rows: confirmed.rows.map((row) => {
      const written = writtenRanges.has(row.detail?.range) || writtenRanges.has(row.total?.range);
      return written && row.status === "same" ? { ...row, status: "written", message: "投手日报及总表已写入并复核" } : row;
    })
  };
}
