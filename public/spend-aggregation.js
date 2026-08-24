import { latestSuccessfulResultsByConfiguration } from "./spend-history.js";

const spendScenarios = ["scenario-1", "scenario-2", "scenario-3"];

function scenarioData(scenarios, scenario) {
  return scenarios?.[scenario] || { sources: [], pairs: [], books: [], runs: [] };
}

function scenarioConfigurations(scenarios, scenario) {
  const data = scenarioData(scenarios, scenario);
  if (scenario === "scenario-2") return data.pairs || [];
  if (scenario === "scenario-3") return data.books || [];
  return data.sources || [];
}

export function spendEntry(row) {
  const metricName = String(row.metric || "");
  const metric = /回流/.test(metricName) ? "returnSpend" : /消耗/.test(metricName) ? "spend" : "";
  if (!metric || row.status === "error" || row.status === "blank" || row.sourceValue === undefined || row.sourceValue === null || row.sourceValue === "") return null;
  const value = Number(row.sourceValue);
  return Number.isFinite(value) ? { metric, value } : null;
}

export function displayShooter(row) {
  const target = String(row.targetSheet || "").match(/\(([^()]*)\)\s*$/);
  const channel = String(row.channel || "").match(/\(([^()]*)\)\s*$/);
  const value = row.shooter || target?.[1] || channel?.[1] || "未标注";
  return String(value).trim().toUpperCase();
}

export function displayChain(row) {
  const channel = String(row.channel || "").replace(/\s*\([^()]*\)\s*$/, "").trim();
  const packageNames = (row.packageDetails || []).map((item) => String(item.packageName || "").trim()).filter(Boolean);
  return row.routeKey || row.targetChannel || channel || row.routeCode || [...new Set(packageNames)].join("、") || row.packageName || row.targetSheet || "未识别";
}

export function displayChannelGroup(result, scenario, scenarios) {
  const configurations = scenarioConfigurations(scenarios, scenario);
  const configurationId = scenario === "scenario-2" ? result.pairId : result.sourceId;
  const snapshotName = scenario === "scenario-2" ? result.pairName : result.sourceName;
  const configured = configurationId
    ? configurations.find((item) => item.id === configurationId)
    : configurations.find((item) => String(item.name).trim() === String(snapshotName || "").trim());
  return String(configured?.name || "").trim();
}

export function latestDataResults(scenarios, scenario, businessDate = "") {
  const data = scenarioData(scenarios, scenario);
  return latestSuccessfulResultsByConfiguration(data.runs, {
    businessDate,
    configurationKey: (result) => (scenario === "scenario-2" ? result.pairId : result.sourceId) || displayChannelGroup(result, scenario, scenarios),
    hasSpendData: (result) => result.rows?.some(spendEntry)
  });
}

export function shooterBusinessDates(scenarios) {
  return [...new Set(spendScenarios.flatMap((scenario) => scenarioData(scenarios, scenario).runs
    .filter((run) => run.businessDate && run.results?.some((result) => result.status === "success" && result.rows?.some(spendEntry)))
    .map((run) => String(run.businessDate))))].sort((a, b) => b.localeCompare(a));
}

function splitShelfPackRow(row) {
  const details = Array.isArray(row.packageDetails) ? row.packageDetails : [];
  if (!details.length) return [row];
  const packages = new Map();
  for (const detail of details) {
    const packageName = String(detail.packageName || "").trim();
    const value = Number(detail.value);
    if (!packageName || !Number.isFinite(value)) continue;
    const current = packages.get(packageName) || { packageName, value: 0 };
    current.value += value;
    packages.set(packageName, current);
  }
  if (!packages.size) return [row];
  return [...packages.values()].map(({ packageName, value }) => ({
    ...row,
    sourceValue: value,
    packageDetails: [{ packageName, metric: row.metric, value }]
  }));
}

export function shooterSpendRows(scenarios, businessDate = "") {
  const snapshots = spendScenarios.flatMap((scenario) =>
    latestDataResults(scenarios, scenario, businessDate).map(({ run, result }) => ({ scenario, run, result }))
  );
  const runs = [...new Map(snapshots.map(({ run }) => [run.id, run])).values()];
  const groups = new Map();
  for (const { scenario, result } of snapshots) {
    const channelGroup = displayChannelGroup(result, scenario, scenarios);
    if (!channelGroup) continue;
    for (const row of result.rows || []) {
      const sourceRows = scenario === "scenario-3" ? splitShelfPackRow(row) : [row];
      for (const sourceRow of sourceRows) {
        const entry = spendEntry(sourceRow);
        if (!entry) continue;
        const chain = displayChain(sourceRow);
        if (!chain || chain === "未识别") continue;
        const shooter = displayShooter(sourceRow);
        const key = `${channelGroup}\u0000${shooter}\u0000${chain}`;
        const current = groups.get(key) || { channelGroup, shooter, chain, spend: 0, returnSpend: 0 };
        current[entry.metric] += entry.value;
        groups.set(key, current);
      }
    }
  }
  return { runs, rows: [...groups.values()].sort((a, b) => a.shooter.localeCompare(b.shooter, "zh-CN") || a.chain.localeCompare(b.chain, "zh-CN", { numeric: true })) };
}

export function summarizeSpendRows(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const groupKey = row[key];
    const current = groups.get(groupKey) || { [key]: groupKey, spend: 0, returnSpend: 0, details: [] };
    current.spend += row.spend;
    current.returnSpend += row.returnSpend;
    current.details.push(row);
    groups.set(groupKey, current);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, total: group.spend + group.returnSpend }))
    .sort((a, b) => b.total - a.total || String(a[key]).localeCompare(String(b[key]), "zh-CN", { numeric: true }));
}

export function spendMetricData(rows, runs) {
  const spend = rows.reduce((sum, row) => sum + row.spend, 0);
  const returnSpend = rows.reduce((sum, row) => sum + row.returnSpend, 0);
  return { spend, returnSpend, total: spend + returnSpend, rows, runs };
}
