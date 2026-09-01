import { batchWrite, getSheetValuesBatch, getWorkbook } from "./google-sheets.mjs";
import { dateKey, isEmpty as empty, locateDateWindows, mergeProjectedColumnWindows, mergeProjectedColumns, normalizeText as normalized, parseNumber, planSequentialDateRows, projectedColumnValues, sheetColumnRange, sheetColumnWindowRange, sheetHeaderRange, sheetRange } from "./spreadsheet-utils.mjs";

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

function extractChannel(values, source, channel, businessDate, mappedHeader) {
  const header = mappedHeader || findSourceHeader(values, source.aliases);
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

function locateTargetHeader(values) {
  for (let row = 0; row < Math.min(values.length, 12); row += 1) {
    const dateColumn = (values[row] || []).findIndex((cell) => matches(cell, ["日期", "时间", "date"]));
    if (dateColumn < 0) continue;
    return { headerRow: row, dateColumn };
  }
  return null;
}

function locateTarget(values, businessDate) {
  const header = locateTargetHeader(values);
  if (!header) return null;
  return {
    ...header,
    dateRow: values.findIndex((cells, index) => index > header.headerRow && dateKey(cells[header.dateColumn], businessDate) === businessDate)
  };
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

function mapRows(rows, targetValues, target, datePlan, targetSheet, businessDate, targetColumnMap = null) {
  const metricColumnCache = new Map();
  return rows.map((row) => {
    if (row.status !== "pending") return row;
    const targetChannel = channelColumnName(row.channel);
    if (!target) return { ...row, targetChannel, status: "error", message: "总表未找到日期表头" };
    if (datePlan.error) return { ...row, targetChannel, status: "error", message: datePlan.error };
    const cacheKey = `${normalized(targetChannel)}\u0000${row.metric}`;
    let column = metricColumnCache.get(cacheKey);
    if (column === undefined) {
      column = targetColumnMap && Object.prototype.hasOwnProperty.call(targetColumnMap, cacheKey)
        ? targetColumnMap[cacheKey]
        : locateMetricColumn(targetValues, target, row.channel, row.metric);
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

function withDefaults(deps) {
  return { ...defaultDeps, ...(deps || {}) };
}

function collectorConfiguration(source) {
  return {
    targetSheet: source.targetSheet,
    excludedSheets: [...(source.excludedSheets || [])],
    aliases: {
      date: [...(source.aliases?.date || [])],
      spend: [...(source.aliases?.spend || [])],
      returnSpend: [...(source.aliases?.returnSpend || [])]
    }
  };
}

function collectorMapping(source, channels, sampleByTitle) {
  const targetSample = sampleByTitle.get(source.targetSheet) || [];
  const targetHeader = locateTargetHeader(targetSample);
  const targetColumns = new Set(targetHeader ? [targetHeader.dateColumn] : []);
  const targetColumnMap = {};
  for (const channel of channels) {
    for (const metric of ["消耗", "回流消耗"]) {
      const cacheKey = `${normalized(channelColumnName(channel))}\u0000${metric}`;
      const column = targetHeader ? locateMetricColumn(targetSample, targetHeader, channel, metric) : -1;
      targetColumnMap[cacheKey] = column;
      if (column >= 0) targetColumns.add(column);
    }
  }
  const sourceHeaders = {};
  const specs = [...new Set([source.targetSheet, ...channels])].map((title) => {
    if (title === source.targetSheet) return { title, columns: [...targetColumns] };
    const header = findSourceHeader(sampleByTitle.get(title) || [], source.aliases);
    if (header) sourceHeaders[title] = header;
    return { title, columns: header ? [...new Set([header.date, header.spend, header.returnSpend].filter((column) => column >= 0))] : [] };
  });
  const signatureRowsByTitle = new Map();
  if (targetHeader) signatureRowsByTitle.set(source.targetSheet, [targetHeader.headerRow - 1, targetHeader.headerRow].filter((row) => row >= 0));
  for (const [title, header] of Object.entries(sourceHeaders)) signatureRowsByTitle.set(title, [header.row]);
  return {
    cacheable: Boolean(targetHeader && channels.every((channel) => sourceHeaders[channel])),
    targetSheet: source.targetSheet,
    channels,
    titles: specs.map(({ title }) => title),
    targetHeader,
    targetColumns: [...targetColumns],
    targetColumnMap,
    sourceHeaders,
    specs,
    signatureRowsByTitle
  };
}

function usableCollectorMapping(mapping, source, channels) {
  const validColumns = (columns) => Array.isArray(columns) && columns.every((column) => Number.isInteger(column) && column >= 0);
  const validSourceHeader = (header) => header
    && Number.isInteger(header.row) && header.row >= 0
    && Number.isInteger(header.date) && header.date >= 0
    && Number.isInteger(header.spend) && header.spend >= -1
    && Number.isInteger(header.returnSpend) && header.returnSpend >= -1
    && (header.spend >= 0 || header.returnSpend >= 0);
  return Boolean(mapping
    && mapping.targetSheet === source.targetSheet
    && Array.isArray(mapping.channels)
    && JSON.stringify(mapping.channels) === JSON.stringify(channels)
    && Array.isArray(mapping.specs)
    && mapping.specs.length === channels.length + 1
    && JSON.stringify(mapping.specs.map((spec) => spec?.title)) === JSON.stringify([source.targetSheet, ...channels])
    && mapping.specs.every((spec) => spec && typeof spec.title === "string" && validColumns(spec.columns))
    && mapping.targetHeader
    && Number.isInteger(mapping.targetHeader.headerRow) && mapping.targetHeader.headerRow >= 0
    && Number.isInteger(mapping.targetHeader.dateColumn) && mapping.targetHeader.dateColumn >= 0
    && mapping.sourceHeaders
    && channels.every((channel) => validSourceHeader(mapping.sourceHeaders[channel]))
    && mapping.targetColumnMap);
}

async function resolveCollectorMapping(source, workbook, sampleByTitle, channels, deps) {
  const store = deps.mappingPlans;
  const args = {
    scenario: "scenario-1",
    configurationId: source.id || source.spreadsheetId,
    workbookId: source.spreadsheetId,
    configuration: collectorConfiguration(source),
    workbook,
    samples: sampleByTitle
  };
  if (store) {
    try {
      const cached = await store.get(args);
      if (usableCollectorMapping(cached?.mapping, source, channels)) return cached.mapping;
    } catch {
      // A plan is an optimization; the live parser remains authoritative.
    }
  }
  const mapping = collectorMapping(source, channels, sampleByTitle);
  if (store && mapping.cacheable) {
    try {
      const { signatureRowsByTitle: _signatureRowsByTitle, cacheable: _cacheable, ...persistedMapping } = mapping;
      await store.put({ ...args, signatureRowsByTitle: mapping.signatureRowsByTitle, mapping: persistedMapping });
    } catch {
      // Do not change collection behavior when the local cache cannot be written.
    }
  }
  return mapping;
}

const collectorSampleRows = 20;
const maxCollectorDateWindows = 32;

function collectorHeaderFor(source, mapping, title) {
  return title === source.targetSheet ? mapping.targetHeader : mapping.sourceHeaders?.[title];
}

function collectorDateColumn(source, mapping, title) {
  const header = collectorHeaderFor(source, mapping, title);
  return title === source.targetSheet ? header?.dateColumn : header?.date;
}

async function readCollectorValues(source, businessDate, mapping, sampleByTitle, deps) {
  const specs = mapping.specs;
  const readFull = async () => {
    const ranges = specs.flatMap(({ title, columns }) => columns.map((column) => sheetColumnRange(title, column)));
    const projected = ranges.length ? await deps.getSheetValuesBatch(source.spreadsheetId, ranges) : [];
    let cursor = 0;
    return new Map(specs.map(({ title, columns }) => {
      const values = mergeProjectedColumns(columns, projected.slice(cursor, cursor + columns.length), sampleByTitle.get(title));
      cursor += columns.length;
      return [title, values];
    }));
  };

  const dateSpecs = specs.map((spec) => ({
    ...spec,
    dateColumn: collectorDateColumn(source, mapping, spec.title),
    header: collectorHeaderFor(source, mapping, spec.title),
    sample: sampleByTitle.get(spec.title) || []
  }));
  if (dateSpecs.some(({ dateColumn, header }) => !header || !Number.isInteger(dateColumn) || dateColumn < 0)) return readFull();

  const dateValues = new Map();
  if (!dateSpecs.some(({ sample }) => sample.length >= collectorSampleRows)) return readFull();
  const dateReads = dateSpecs;

  let indexedColumns;
  try {
    const ranges = dateReads.map((spec) => sheetColumnRange(spec.title, spec.dateColumn));
    indexedColumns = await deps.getSheetValuesBatch(source.spreadsheetId, ranges);
  } catch {
    return readFull();
  }
  dateReads.forEach((spec, index) => {
    const columnValues = projectedColumnValues(indexedColumns[index] || [], spec.dateColumn);
    dateValues.set(spec.title, mergeProjectedColumns([spec.dateColumn], [columnValues], spec.sample));
  });

  const windowsByTitle = new Map();
  for (const spec of dateSpecs) {
    const values = dateValues.get(spec.title) || [];
    const index = locateDateWindows(values, {
      headerRow: spec.header.row ?? spec.header.headerRow,
      dateColumn: spec.dateColumn,
      businessDate
    });
    if (!index.ok || index.windows.length > maxCollectorDateWindows) return readFull();
    if (spec.title === source.targetSheet) {
      const datePlan = planSequentialDateRows(values, { row: spec.header.headerRow, date: spec.dateColumn }, businessDate, spec.title);
      windowsByTitle.set(spec.title, datePlan.error ? [] : [{ startRow: datePlan.row, endRow: datePlan.row + 1 }]);
    } else {
      windowsByTitle.set(spec.title, index.windows);
    }
  }

  const reads = [];
  for (const spec of dateSpecs) {
    const windows = windowsByTitle.get(spec.title) || [];
    for (const column of spec.columns.filter((value) => value !== spec.dateColumn)) {
      for (const window of windows) reads.push({ title: spec.title, column, ...window });
    }
  }
  let projected = [];
  try {
    projected = reads.length
      ? await deps.getSheetValuesBatch(source.spreadsheetId, reads.map(({ title, column, startRow, endRow }) => sheetColumnWindowRange(title, column, startRow, endRow)))
      : [];
  } catch {
    return readFull();
  }
  return new Map(specs.map((spec) => {
    const values = dateValues.get(spec.title) || spec.sample;
    const ranges = [];
    const offset = reads.findIndex(({ title }) => title === spec.title);
    const count = reads.filter(({ title }) => title === spec.title).length;
    if (offset >= 0) {
      let cursor = offset;
      for (const read of reads.slice(offset, offset + count)) {
        ranges.push({ ...read, values: projectedColumnValues(projected[cursor] || [], read.column) });
        cursor += 1;
      }
    }
    return [spec.title, mergeProjectedColumnWindows(values, ranges)];
  }));
}

export async function collectWorkbook(source, businessDate, deps = defaultDeps) {
  const runDeps = withDefaults(deps);
  const workbook = await runDeps.getWorkbook(source.spreadsheetId);
  const visibleSheets = workbook.sheets
    .filter(({ properties }) => !properties.hidden)
    .map(({ properties }) => properties.title);
  if (!visibleSheets.includes(source.targetSheet)) throw new Error(`未找到目标页签：${source.targetSheet}`);
  const channels = visibleSheets.filter((title) => !source.excludedSheets.includes(title));
  const titles = [...new Set([source.targetSheet, ...channels])];
  const samples = await runDeps.getSheetValuesBatch(source.spreadsheetId, titles.map((title) => sheetHeaderRange(title)));
  const sampleByTitle = new Map(titles.map((title, index) => [title, samples[index] || []]));
  const mapping = await resolveCollectorMapping(source, workbook, sampleByTitle, channels, runDeps);
  const targetHeader = mapping.targetHeader;
  const valuesByTitle = await readCollectorValues(source, businessDate, mapping, sampleByTitle, runDeps);
  const targetValues = valuesByTitle.get(source.targetSheet) || [];
  const target = targetHeader
    ? {
        ...targetHeader,
        dateRow: targetValues.findIndex((cells, index) => index > targetHeader.headerRow && dateKey(cells?.[targetHeader.dateColumn], businessDate) === businessDate)
      }
    : locateTarget(targetValues, businessDate);
  const datePlan = target
    ? planSequentialDateRows(targetValues, { row: target.headerRow, date: target.dateColumn }, businessDate, source.targetSheet)
    : null;
  const channelValues = channels.map((channel) => ({ channel, values: valuesByTitle.get(channel) || [] }));
  const rows = channelValues.flatMap(({ channel, values }) => extractChannel(values, source, channel, businessDate, mapping.sourceHeaders?.[channel]));
  return {
    sourceId: source.id,
    sourceName: source.name,
    spreadsheetTitle: workbook.properties.title,
    status: "success",
    businessDate,
    channelCount: channels.length,
    rows: mapRows(rows, targetValues, target, datePlan, source.targetSheet, businessDate, mapping.targetColumnMap)
  };
}

export async function executeWorkbook(source, businessDate, deps = defaultDeps) {
  const runDeps = withDefaults(deps);
  let preview = await collectWorkbook(source, businessDate, runDeps);
  const dateUpdates = [...new Map(preview.rows
    .flatMap((row) => row.dateUpdates || [])
    .map((update) => [update.range, update])).values()];
  if (dateUpdates.length) {
    await runDeps.batchWrite(source.spreadsheetId, dateUpdates);
    preview = await collectWorkbook(source, businessDate, runDeps);
  }
  const ready = preview.rows.filter((row) => row.status === "ready");
  await runDeps.batchWrite(source.spreadsheetId, ready.map((row) => ({ range: row.range, value: row.sourceValue })));
  return {
    ...preview,
    rows: preview.rows.map((row) => row.status === "ready" ? { ...row, status: "written", message: "已写入并保留审计记录" } : row)
  };
}
