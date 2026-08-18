import { batchWrite, getSheetValues, getSheetValuesBatch, getWorkbook } from "./google-sheets.mjs";
import { mapConcurrent } from "./async-utils.mjs";

const sourceAliases = {
  date: ["日期", "时间", "date"],
  channel: ["渠道号", "渠道名", "渠道", "链名", "channel", "channel name", "channel id"],
  spend: ["花费（U）", "花费(U)", "花费", "消耗", "广告消耗", "spend"],
  returnSpend: ["回流", "回流消耗", "return spend"]
};

const empty = (value) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");
const normalized = (value) => String(value ?? "")
  .trim()
  .toLowerCase()
  .replace(/[（]/g, "(")
  .replace(/[）]/g, ")")
  .replace(/[‐‑‒–—―]/g, "-")
  .replaceAll(/\s+/g, "");

function matches(value, aliases) {
  const target = normalized(value);
  return aliases.some((alias) => target === normalized(alias));
}

function headerScore(value, field) {
  const text = normalized(value);
  if (!text) return 0;
  if (matches(value, sourceAliases[field])) return 100;
  if (field === "date") return /日期|时间|date|day/.test(text) ? 50 : 0;
  if (field === "channel") return /渠道|链名|channel/.test(text) ? 50 : 0;
  if (field === "returnSpend") {
    if (!/回流|return/.test(text)) return 0;
    return /消耗|花费|spend|cost/.test(text) ? 80 : 60;
  }
  if (field === "spend") {
    if (/回流|return/.test(text) || !/消耗|花费|spend|cost/.test(text)) return 0;
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

function sheetRange(sheet, row, column) {
  return `'${sheet.replaceAll("'", "''")}'!${columnName(column)}${row + 1}`;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseNumber(value) {
  if (empty(value)) return { kind: "blank" };
  if (typeof value === "number" && Number.isFinite(value)) return { kind: "number", value: roundMoney(value) };
  const cleaned = String(value).trim().replaceAll(",", "").replace(/[¥￥$%]/g, "");
  if (cleaned && Number.isFinite(Number(cleaned))) return { kind: "number", value: roundMoney(Number(cleaned)) };
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

export function normalizeRoute(value) {
  const raw = String(value ?? "").trim();
  const clean = raw.replace(/[（]/g, "(").replace(/[）]/g, ")").replace(/[‐‑‒–—―]/g, "-").trim();
  const shooterMatch = clean.match(/\(([^()]*)\)\s*$/);
  const shooter = shooterMatch ? normalized(shooterMatch[1]) : "";
  const base = (shooterMatch ? clean.slice(0, shooterMatch.index) : clean).trim();
  const codeMatch = base.match(/(\d+)\s*$/)
    || base.match(/(?:^|[-_\s])0*(\d+)(?=$|[-_\s（(])/);
  return {
    raw,
    base,
    fullChain: normalized(base),
    code: codeMatch ? String(Number(codeMatch[1])) : "",
    shooter
  };
}

function routeTokens(value) {
  const route = typeof value === "string" ? normalizeRoute(value) : value;
  return String(route?.fullChain || "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((token) => token.replace(/^0+(?=\d+$)/, "") || "0");
}

function suffixScore(source, target) {
  const sourceTokens = routeTokens(source);
  const targetTokens = routeTokens(target);
  if (!sourceTokens.length || !targetTokens.length || targetTokens.length > sourceTokens.length) return 0;
  const offset = sourceTokens.length - targetTokens.length;
  return targetTokens.every((token, index) => token === sourceTokens[offset + index]) ? targetTokens.length : 0;
}

function routeScore(left, right) {
  return Math.max(suffixScore(left, right), suffixScore(right, left));
}

function totalChainScore(left, right) {
  const leftRoute = typeof left === "string" ? normalizeRoute(left) : left;
  const rightRoute = typeof right === "string" ? normalizeRoute(right) : right;
  const leftTokens = routeTokens(leftRoute);
  const rightTokens = routeTokens(rightRoute);
  if (!leftTokens.length || !rightTokens.length) return 0;
  if (leftRoute.fullChain === rightRoute.fullChain) return 3000 + leftTokens.length;

  const [shorter, longer] = leftTokens.length <= rightTokens.length
    ? [leftTokens, rightTokens]
    : [rightTokens, leftTokens];
  const prefix = shorter.every((token, index) => token === longer[index]);
  const suffixOffset = longer.length - shorter.length;
  const suffix = shorter.every((token, index) => token === longer[suffixOffset + index]);
  if (prefix || suffix) return 2000 + shorter.length;

  const leftName = normalized(leftRoute.fullChain);
  const rightName = normalized(rightRoute.fullChain);
  const [shorterName, longerName] = leftName.length <= rightName.length
    ? [leftName, rightName]
    : [rightName, leftName];
  return shorterName.length >= 2 && (longerName.startsWith(shorterName) || longerName.endsWith(shorterName))
    ? 1500 + shorterName.length
    : 0;
}

function shooterFallbackScore(targetRoute, headerRoute) {
  const shooter = normalized(targetRoute?.shooter);
  if (!shooter) return 0;
  if (normalized(headerRoute?.shooter) === shooter) return 1000;
  return normalized(headerRoute?.fullChain) === shooter ? 1000 : 0;
}

function looseRouteScore(left, right) {
  const source = typeof left === "string" ? normalizeRoute(left) : left;
  const target = typeof right === "string" ? normalizeRoute(right) : right;
  if (!source?.fullChain || !target?.fullChain) return 0;
  if (source.code && target.code && source.code !== target.code) return 0;
  if (source.fullChain === target.fullChain) return 1000 + routeTokens(source).length;
  const sourceTokens = routeTokens(source);
  const targetTokens = routeTokens(target);
  let common = 0;
  for (let start = 0; start < sourceTokens.length; start += 1) {
    for (let targetStart = 0; targetStart < targetTokens.length; targetStart += 1) {
      let length = 0;
      while (sourceTokens[start + length] && sourceTokens[start + length] === targetTokens[targetStart + length]) length += 1;
      common = Math.max(common, length);
    }
  }
  if (common >= 2) return 500 + common;
  return source.code && target.code && source.code === target.code ? 100 : 0;
}

function routeIdentity(route) {
  return route.fullChain || route.code;
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

function findHeaders(values) {
  const headers = [];
  for (let row = 0; row < values.length; row += 1) {
    const cells = values[row] || [];
    const date = findFieldColumn(cells, "date");
    const channel = findFieldColumn(cells, "channel");
    const spend = findFieldColumn(cells, "spend");
    const returnSpend = findFieldColumn(cells, "returnSpend");
    if (date >= 0 && channel >= 0 && (spend >= 0 || returnSpend >= 0)) {
      headers.push({ row, date, channel, spend, returnSpend });
    }
  }
  return headers;
}

function metricRecord(channel, route, metric, parsed, sourceSheet, row, column) {
  const identity = { channel, routeCode: route.code, routeChain: routeIdentity(route), shooter: route.shooter, metric, sourceSheet };
  if (column < 0) return { ...identity, status: "error", message: `甲方表缺少${metric}列` };
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
  const headers = findHeaders(values);
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
    const cells = values[row] || [];
    const date = findFieldColumn(cells, "date");
    const spend = findFieldColumn(cells, "spend");
    const returnSpend = findFieldColumn(cells, "returnSpend");
    if (date >= 0 && (spend >= 0 || returnSpend >= 0)) headers.push({ row, date, channel: findFieldColumn(cells, "channel"), spend, returnSpend });
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
      metricRecord(routeHint.raw, routeHint, "消耗", { kind: "error", raw: `缺少 ${businessDate} 日期记录` }, sourceSheet, -1, -1),
      metricRecord(routeHint.raw, routeHint, "回流消耗", { kind: "error", raw: `缺少 ${businessDate} 日期记录` }, sourceSheet, -1, -1)
    ];
  }
  return markDuplicateRecords(fallback);
}

function findDetailHeader(values) {
  for (let row = 0; row < Math.min(values.length, 16); row += 1) {
    const cells = values[row] || [];
    const date = findFieldColumn(cells, "date");
    const channel = findFieldColumn(cells, "channel");
    const spend = findFieldColumn(cells, "spend");
    const returnSpend = findFieldColumn(cells, "returnSpend");
    if (date >= 0 && channel >= 0 && (spend >= 0 || returnSpend >= 0)) return { row, date, channel, spend, returnSpend };
  }
  return null;
}

function findDateRow(values, header, businessDate) {
  return values.findIndex((row, index) => index > header.row && dateKey(row?.[header.date], businessDate) === businessDate);
}

function inspectTarget(value, sourceValue, range) {
  if (empty(value)) return { status: "ready", value: null, range };
  const parsed = parseNumber(value);
  if (parsed.kind === "number" && parsed.value === sourceValue) return { status: "same", value: parsed.value, range };
  return { status: "conflict", value, range };
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
  const visible = ownWorkbook.sheets.filter(({ properties }) => !properties.hidden).map(({ properties }) => properties);
  const total = visible.find((sheet) => sheet.title === targetSheet);
  return {
    visible,
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
  const candidateSheets = clientSheets;
  const matchCache = new Map();
  const getMatch = (descriptor) => {
    const key = descriptor.sheet.title;
    if (!matchCache.has(key)) matchCache.set(key, chooseClientChainSheet(candidateSheets, descriptor));
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
        metricRecord(descriptor.sheet.title, descriptor.route, "消耗", { kind: "error", raw: match.error }, descriptor.sheet.title, -1, -1),
        metricRecord(descriptor.sheet.title, descriptor.route, "回流消耗", { kind: "error", raw: match.error }, descriptor.sheet.title, -1, -1)
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

function combineStatus(detail, total) {
  if (detail.status === "error" || total.status === "error") return "error";
  if (detail.status === "conflict" || total.status === "conflict") return "conflict";
  if (detail.status === "ready" || total.status === "ready") return "ready";
  return "same";
}

async function readSheetMap(spreadsheetId, titles, deps, options = {}) {
  const uniqueTitles = [...new Set(titles)];
  if (deps.getSheetValuesBatch) {
    const ranges = uniqueTitles.map((title) => `'${title.replaceAll("'", "''")}'`);
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
  const [totalValues, totalDisplayValues] = await Promise.all([
    readSheetMap(pair.own.spreadsheetId, [totalSheet.title], deps),
    readSheetMap(pair.own.spreadsheetId, [totalSheet.title], deps, { valueRenderOption: "FORMATTED_VALUE" })
  ]).then(([values, displayValues]) => [values.get(totalSheet.title) || [], displayValues.get(totalSheet.title) || []]);
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
        totalColumn = locateTotalColumn(totalDisplayValues, totalTarget, match.descriptor.route, row.metric);
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

export async function collectScenario2Pair(pair, businessDate, deps = defaultDeps) {
  const [clientWorkbook, ownWorkbook] = await Promise.all([
    deps.getWorkbook(pair.client.spreadsheetId),
    deps.getWorkbook(pair.own.spreadsheetId)
  ]);
  const clientSheets = clientWorkbook.sheets.filter(({ properties }) => !properties.hidden).map(({ properties }) => properties);
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
  const preview = await collectScenario2Pair(pair, businessDate, deps);
  const detailUpdates = preview.rows
    .filter((row) => row.status === "ready" && row.detail?.status === "ready" && row.total?.status !== "conflict" && row.total?.status !== "error")
    .map((row) => ({ range: row.detail.range, value: row.sourceValue }));
  await deps.batchWrite(pair.own.spreadsheetId, detailUpdates);

  const afterDetail = await collectScenario2Pair(pair, businessDate, deps);
  const totalUpdates = afterDetail.rows
    .filter((row) => row.detail?.status === "same" && row.total?.status === "ready")
    .map((row) => ({ range: row.total.range, value: row.sourceValue }));
  await deps.batchWrite(pair.own.spreadsheetId, totalUpdates);

  const confirmed = await collectScenario2Pair(pair, businessDate, deps);
  const writtenRanges = new Set([...detailUpdates, ...totalUpdates].map((item) => item.range));
  return {
    ...confirmed,
    rows: confirmed.rows.map((row) => {
      const written = writtenRanges.has(row.detail?.range) || writtenRanges.has(row.total?.range);
      return written && row.status === "same" ? { ...row, status: "written", message: "投手日报及总表已写入并复核" } : row;
    })
  };
}
