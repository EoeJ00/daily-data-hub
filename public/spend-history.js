export function latestSuccessfulResultsByConfiguration(runs, {
  businessDate = "",
  configurationKey,
  hasSpendData
} = {}) {
  if (typeof configurationKey !== "function" || typeof hasSpendData !== "function") return [];

  const selected = new Map();
  const newestFirst = [...(Array.isArray(runs) ? runs : [])]
    .sort((left, right) => String(right?.createdAt || "").localeCompare(String(left?.createdAt || "")));

  for (const run of newestFirst) {
    if (businessDate && String(run?.businessDate || "") !== businessDate) continue;
    for (const result of run?.results || []) {
      if (result?.status !== "success" || !hasSpendData(result)) continue;
      const key = String(configurationKey(result) || "").trim();
      if (!key || selected.has(key)) continue;
      selected.set(key, { run, result });
    }
  }

  return [...selected.values()];
}
