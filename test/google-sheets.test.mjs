import test from "node:test";
import assert from "node:assert/strict";
import { createPromiseCache, createRequestScheduler, fetchJson } from "../src/google-sheets.mjs";

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

test("fetchJson retries a transient connection reset", async () => {
  let calls = 0;
  const delays = [];
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) {
      const error = new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      throw error;
    }
    return jsonResponse({ ok: true });
  };

  const result = await fetchJson("https://example.test", {}, "测试接口", {
    attempts: 4,
    fetchImpl,
    delay: async (milliseconds) => delays.push(milliseconds)
  });

  assert.equal(calls, 3);
  assert.deepEqual(delays, [300, 800]);
  assert.deepEqual(result.data, { ok: true });
});

test("fetchJson retries temporary Google HTTP statuses", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1
      ? jsonResponse({ error: "busy" }, 503)
      : jsonResponse({ title: "日报" });
  };

  const result = await fetchJson("https://example.test", {}, "测试接口", {
    attempts: 2,
    fetchImpl,
    delay: async () => {}
  });

  assert.equal(calls, 2);
  assert.deepEqual(result.data, { title: "日报" });
});

test("fetchJson does not retry when only one attempt is allowed", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
  };

  await assert.rejects(
    fetchJson("https://example.test", {}, "写入接口", {
      attempts: 1,
      fetchImpl,
      delay: async () => {}
    }),
    /ECONNRESET/
  );
  assert.equal(calls, 1);
});

test("fetchJson backs off before retrying a Sheets quota response", async () => {
  let calls = 0;
  const delays = [];
  const result = await fetchJson("https://example.test", {}, "Google Sheets 接口", {
    attempts: 4,
    fetchImpl: async () => {
      calls += 1;
      return calls < 4
        ? jsonResponse({ error: { message: "Quota exceeded" } }, 429)
        : jsonResponse({ ok: true });
    },
    delay: async (milliseconds) => delays.push(milliseconds)
  });
  assert.equal(result.response.status, 200);
  assert.equal(calls, 4);
  assert.deepEqual(delays, [5_000, 20_000, 60_000]);
});

test("request scheduler serializes reads at the configured interval", async () => {
  let currentTime = 0;
  const delays = [];
  const starts = [];
  const schedule = createRequestScheduler({
    interval: 1_200,
    now: () => currentTime,
    delay: async (milliseconds) => {
      delays.push(milliseconds);
      currentTime += milliseconds;
    }
  });

  await Promise.all(Array.from({ length: 3 }, () => schedule(async () => starts.push(currentTime))));

  assert.deepEqual(starts, [0, 1_200, 2_400]);
  assert.deepEqual(delays, [1_200, 1_200]);
});

test("promise cache deduplicates concurrent loads and expires predictably", async () => {
  let currentTime = 0;
  let loads = 0;
  const cache = createPromiseCache(300_000, () => currentTime);
  const load = async () => ++loads;

  assert.deepEqual(await Promise.all([cache.get("sheet", load), cache.get("sheet", load)]), [1, 1]);
  currentTime = 299_999;
  assert.equal(await cache.get("sheet", load), 1);
  currentTime = 300_000;
  assert.equal(await cache.get("sheet", load), 2);
  cache.clear("sheet");
  assert.equal(await cache.get("sheet", load), 3);
});
