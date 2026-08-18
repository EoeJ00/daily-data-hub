import test from "node:test";
import assert from "node:assert/strict";
import { fetchJson } from "../src/google-sheets.mjs";

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
