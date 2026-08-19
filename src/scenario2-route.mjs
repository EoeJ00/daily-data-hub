export const normalizeScenarioText = (value) => String(value ?? "")
  .trim()
  .toLowerCase()
  .replace(/[（]/g, "(")
  .replace(/[）]/g, ")")
  .replace(/[‐‑‒–—―]/g, "-")
  .replaceAll(/\s+/g, "");

export function normalizeRoute(value) {
  const raw = String(value ?? "").trim();
  const clean = raw.replace(/[（]/g, "(").replace(/[）]/g, ")").replace(/[‐‑‒–—―]/g, "-").trim();
  const shooterMatch = clean.match(/\(([^()]*)\)\s*$/);
  const shooter = shooterMatch ? normalizeScenarioText(shooterMatch[1]) : "";
  const base = (shooterMatch ? clean.slice(0, shooterMatch.index) : clean).trim();
  const codeMatch = base.match(/(\d+)\s*$/)
    || base.match(/(?:^|[-_\s])0*(\d+)(?=$|[-_\s（(])/);
  return {
    raw,
    base,
    fullChain: normalizeScenarioText(base),
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

export function routeScore(left, right) {
  return Math.max(suffixScore(left, right), suffixScore(right, left));
}

export function totalChainScore(left, right) {
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

  const leftName = normalizeScenarioText(leftRoute.fullChain);
  const rightName = normalizeScenarioText(rightRoute.fullChain);
  const [shorterName, longerName] = leftName.length <= rightName.length
    ? [leftName, rightName]
    : [rightName, leftName];
  return shorterName.length >= 2 && (longerName.startsWith(shorterName) || longerName.endsWith(shorterName))
    ? 1500 + shorterName.length
    : 0;
}

export function shooterFallbackScore(targetRoute, headerRoute) {
  const shooter = normalizeScenarioText(targetRoute?.shooter);
  if (!shooter) return 0;
  if (normalizeScenarioText(headerRoute?.shooter) === shooter) return 1000;
  return normalizeScenarioText(headerRoute?.fullChain) === shooter ? 1000 : 0;
}

export function looseRouteScore(left, right) {
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

export function routeIdentity(route) {
  return route.fullChain || route.code;
}
