import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("架上包成功但零记录时显示无数据而不是未知错误", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /result\.status === "success" \? '<span class="badge neutral">无数据<\/span>'/);
  assert.match(source, /result\.status === "success" \? "当前日期无可归集数据" : "未知错误"/);
});
