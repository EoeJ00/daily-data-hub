import { readFile } from "node:fs/promises";
import { createPrivateKey, sign } from "node:crypto";
import { quoteSheetTitle } from "./spreadsheet-utils.mjs";

let tokenCache;
let tokenRequest;

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const READ_ATTEMPTS = 4;
const DEFAULT_READ_INTERVAL_MS = 1_200;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(attempt, response) {
  const retryAfterHeader = response?.headers?.get?.("retry-after");
  const retryAfter = Number(retryAfterHeader);
  if (retryAfterHeader && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1000, response?.status === 429 ? 60_000 : 3_000);
  }
  if (response?.status === 429) return [5_000, 20_000, 60_000][attempt - 1] || 60_000;
  return [300, 800, 1_600][attempt - 1] || 1_600;
}

export function createRequestScheduler({ interval = DEFAULT_READ_INTERVAL_MS, now = () => Date.now(), delay = wait } = {}) {
  let nextStart = 0;
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(async () => {
      const remaining = Math.max(0, nextStart - now());
      if (remaining) await delay(remaining);
      nextStart = Math.max(nextStart, now()) + interval;
      return task();
    });
    tail = run.catch(() => {});
    return run;
  };
}

function configuredReadInterval() {
  const value = Number(process.env.GOOGLE_SHEETS_READ_INTERVAL_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_READ_INTERVAL_MS;
}

const scheduleReadRequest = createRequestScheduler({ interval: configuredReadInterval() });

function networkError(label, url, error, retries = 0) {
  const cause = error?.cause;
  const detail = cause?.message || cause?.code || error?.message || "fetch failed";
  const retryNote = retries ? `，已自动重试 ${retries} 次` : "";
  return new Error(`${label}连接失败：${detail}${retryNote}（${url}）`, { cause: error });
}

export async function fetchJson(url, options, label, config = {}) {
  const attempts = Math.max(1, config.attempts || 1);
  const fetchImpl = config.fetchImpl || globalThis.fetch;
  const delay = config.delay || wait;
  let response;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      response = await fetchImpl(url, options);
    } catch (error) {
      if (attempt === attempts) throw networkError(label, url, error, attempts - 1);
      await delay(retryDelay(attempt));
      continue;
    }

    if (!RETRYABLE_STATUS.has(response.status) || attempt === attempts) break;
    await delay(retryDelay(attempt, response));
  }

  try {
    return { response, data: await response.json() };
  } catch (error) {
    throw new Error(`${label}返回了无效响应（HTTP ${response.status}）`, { cause: error });
  }
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

async function credentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  if (process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
    return JSON.parse(await readFile(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, "utf8"));
  }
  return null;
}

export function getConnectionStatus() {
  return {
    configured: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_FILE),
    mode: "service-account",
    message: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_FILE
      ? "Google 服务账号已配置"
      : "尚未配置 Google 服务账号；可导入链接，但预览与写入需要凭据"
  };
}

async function requestAccessToken() {
  if (tokenCache?.expiresAt > Date.now() + 60_000) return tokenCache.value;
  const account = await credentials();
  if (!account?.client_email || !account?.private_key) {
    throw new Error("未配置 Google 服务账号。请设置 GOOGLE_SERVICE_ACCOUNT_FILE，并将工作簿共享给服务账号邮箱");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claim}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), createPrivateKey(account.private_key)).toString("base64url");
  const { response, data } = await fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` })
  }, "Google 授权接口", { attempts: 3 });
  if (!response.ok) throw new Error(data.error_description || "Google 授权失败");
  tokenCache = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return tokenCache.value;
}

async function accessToken() {
  if (tokenCache?.expiresAt > Date.now() + 60_000) return tokenCache.value;
  if (!tokenRequest) {
    tokenRequest = requestAccessToken().finally(() => {
      tokenRequest = undefined;
    });
  }
  return tokenRequest;
}

async function googleRequest(path, options = {}) {
  const url = `https://sheets.googleapis.com/v4/${path}`;
  const method = String(options.method || "GET").toUpperCase();
  const requestOptions = {
    ...options,
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", ...options.headers }
  };
  const request = () => fetchJson(url, requestOptions, "Google Sheets 接口", { attempts: method === "GET" ? READ_ATTEMPTS : 1 });
  const { response, data } = method === "GET" ? await scheduleReadRequest(request) : await request();
  if (!response.ok) {
    const quotaMessage = response.status === 429
      ? `Google Sheets 读取配额暂时耗尽，系统已自动限速并退避重试，请稍后再次执行${data.error?.message ? `（${data.error.message}）` : ""}`
      : "";
    throw new Error(quotaMessage || data.error?.message || `Google Sheets 请求失败：${response.status}`);
  }
  return data;
}

export async function getWorkbook(spreadsheetId) {
  const fields = "properties(title,timeZone),sheets(properties(sheetId,title,index,hidden))";
  return googleRequest(`spreadsheets/${spreadsheetId}?fields=${encodeURIComponent(fields)}`);
}

export async function getSheetValues(spreadsheetId, sheetTitle, options = {}) {
  const selectedRange = options.range
    ? `${quoteSheetTitle(sheetTitle)}!${options.range}`
    : quoteSheetTitle(sheetTitle);
  const range = encodeURIComponent(selectedRange);
  const valueRenderOption = options.valueRenderOption || "UNFORMATTED_VALUE";
  const data = await googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?majorDimension=ROWS&valueRenderOption=${encodeURIComponent(valueRenderOption)}`);
  return data.values || [];
}

/**
 * Read several A1 ranges in one Sheets API request. This is intentionally
 * separate from getSheetValues so existing callers keep their simple shape.
 */
export async function getSheetValuesBatch(spreadsheetId, ranges, options = {}) {
  if (!ranges.length) return [];
  const valueRenderOption = options.valueRenderOption || "UNFORMATTED_VALUE";
  const query = ranges.map((range) => `ranges=${encodeURIComponent(range)}`).join("&");
  const data = await googleRequest(`spreadsheets/${spreadsheetId}/values:batchGet?${query}&majorDimension=ROWS&valueRenderOption=${encodeURIComponent(valueRenderOption)}`);
  return (data.valueRanges || []).map((item) => item.values || []);
}

export async function batchWrite(spreadsheetId, updates) {
  if (!updates.length) return { totalUpdatedCells: 0 };
  return googleRequest(`spreadsheets/${spreadsheetId}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "RAW", data: updates.map(({ range, value }) => ({ range, values: [[value]] })) })
  });
}
