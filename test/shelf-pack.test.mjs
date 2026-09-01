import test from "node:test";
import assert from "node:assert/strict";
import { classifyShelfSheet, collectShelfBook, dateKey, executeShelfBook, extractShelfPackRecords } from "../src/shelf-pack.mjs";

test("classifies merged-date rack sheets separately from shooter sheets", () => {
  assert.equal(classifyShelfSheet([
    ["包A"],
    ["日期", "投手/包名", "服务费", "消耗", "回流消耗"]
  ]), "rack");
  assert.equal(classifyShelfSheet([
    ["包A"],
    ["日期", "渠道名", "服务费", "消耗", "回流消耗"]
  ]), "shooter");
  assert.equal(classifyShelfSheet([["日期", "总消耗", "C", "C回流"]]), "other");
});

test("carries merged dates, sums repeated shooters, and excludes package totals", () => {
  const values = [
    ["架上包 A"],
    ["日期", "投手/包名", "服务费", "消耗", "回流消耗"],
    [46247, "C", 0, 10, 1],
    [null, "C", 0, 3, 2],
    [null, "架上包 A", 0, 13, 3],
    [46248, "C", 0, 99, 9]
  ];
  const result = extractShelfPackRecords(values, "架上包 A", "2026-08-13");
  assert.equal(result.status, "success");
  assert.deepEqual(result.rows.map((row) => [row.shooter, row.metric, row.sourceValue]), [
    ["c", "消耗", 13],
    ["c", "回流消耗", 3]
  ]);
});

test("aggregates one shooter across multiple rack packages and maps both metrics", async () => {
  const packageA = [
    ["架上包 A"],
    ["日期", "投手/包名", "服务费", "消耗", "回流消耗"],
    [46247, "C", 0, 10, 1],
    [null, "架上包 A", 0, 10, 1]
  ];
  const packageB = [
    ["架上包 B"],
    ["日期", "投手/包名", "服务费", "消耗", "回流消耗"],
    [46247, "77F(C)", 0, 4, 0.5],
    [null, "架上包 B", 0, 4, 0.5]
  ];
  const shooterC = [
    ["C"], [], [],
    ["日期", "渠道名", "服务费", "消耗", "回流消耗"],
    [46247, "Aero Parcel 1939", 0, null, null]
  ];
  const total = [
    ["日期", "总消耗（USD）", "C", "C回流"],
    [46247, null, null, null]
  ];
  const values = new Map([
    ["book:架上包 A", packageA],
    ["book:架上包 B", packageB],
    ["book:C", shooterC],
    ["book:总表", total]
  ]);
  const readBatches = [];
  const deps = {
    getWorkbook: async () => ({ properties: { title: "架上包数据表" }, sheets: [
      { properties: { title: "架上包 A", hidden: false } },
      { properties: { title: "架上包 B", hidden: false } },
      { properties: { title: "C", hidden: true } },
      { properties: { title: "总表", hidden: false } }
    ] }),
    getSheetValues: async (id, sheet) => values.get(`${id}:${sheet}`) || [],
    getSheetValuesBatch: async (id, ranges) => {
      readBatches.push(ranges);
      return ranges.map((range) => {
        const sheetPart = range.split("!")[0];
        const title = sheetPart.slice(1, -1).replaceAll("''", "'");
        const full = values.get(`${id}:${title}`) || [];
        const cell = range.split("!")[1];
        if (!cell) return full;
        if (/^\d+:\d+$/.test(cell)) return full.slice(0, Number(cell.split(":")[1]));
        if (/^[A-Z]+:[A-Z]+$/.test(cell)) {
          const column = [...cell.split(":")[0]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
          return full.map((row) => [row?.[column]]);
        }
        const match = cell.match(/^([A-Z]+)(\d+)$/);
        const column = [...match[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
        return [[full[Number(match[2]) - 1]?.[column]]];
      });
    }
  };
  const result = await collectShelfBook({ id: "book-id", name: "架上包数据表", spreadsheetId: "book" }, "2026-08-13", deps);
  assert.equal(result.sourceSheetCount, 2);
  assert.equal(result.targetSheetCount, 1);
  assert.equal(result.totalSheetName, "总表");
  assert.deepEqual(result.rows.map((row) => [row.shooter, row.metric, row.sourceValue, row.targetSheet, row.totalSheet, row.status]), [
    ["c", "消耗", 14, "C", "总表", "ready"],
    ["c", "回流消耗", 1.5, "C", "总表", "ready"]
  ]);
  assert.equal(result.rows[0].detail.range, "'C'!D5");
  assert.equal(result.rows[0].total.range, "'总表'!C2");
  assert.equal(result.rows[1].detail.range, "'C'!E5");
  assert.equal(result.rows[1].total.range, "'总表'!D2");
  assert.equal(result.rows[0].packageDetails.length, 2);
  assert.ok(readBatches[1].every((range) => range.includes("!")));
  assert.deepEqual(readBatches[1], [
    "'架上包 A'!A:A", "'架上包 A'!B:B", "'架上包 A'!D:D", "'架上包 A'!E:E",
    "'架上包 B'!A:A", "'架上包 B'!B:B", "'架上包 B'!D:D", "'架上包 B'!E:E",
    "'C'!A:A", "'C'!B:B", "'C'!D:D", "'C'!E:E",
    "'总表'!A:A", "'总表'!C:C", "'总表'!D:D"
  ]);

  const writes = [];
  const executed = await executeShelfBook({ id: "book-id", name: "架上包数据表", spreadsheetId: "book" }, "2026-08-13", {
    getWorkbook: deps.getWorkbook,
    getSheetValues: deps.getSheetValues,
    getSheetValuesBatch: deps.getSheetValuesBatch,
    batchWrite: async (_id, updates) => {
      writes.push(...updates);
      for (const update of updates) {
        const [quotedTitle, cell] = update.range.split("!");
        const title = quotedTitle.slice(1, -1).replaceAll("''", "'");
        const match = cell.match(/^([A-Z]+)(\d+)$/);
        const column = [...match[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
        const row = Number(match[2]) - 1;
        values.get(`book:${title}`)[row][column] = update.value;
      }
    }
  });
  assert.equal(writes.length, 4);
  assert.ok(executed.rows.every((row) => row.status === "written"));
  assert.deepEqual(writes.map((item) => item.range).sort(), ["'C'!D5", "'C'!E5", "'总表'!C2", "'总表'!D2"]);
});

test("rebuilds shelf-pack results from single-column reads when batch reads are unavailable", async () => {
  const values = new Map([
    ["book:架上包 A", [
      ["架上包 A"],
      ["日期", "投手/包名", "服务费", "消耗", "回流消耗"],
      [46247, "C", 0, 10, 1],
      [null, "架上包 A", 0, 10, 1]
    ]],
    ["book:C", [
      ["C"], [], [],
      ["日期", "渠道名", "服务费", "消耗", "回流消耗"],
      [46247, "Aero Parcel 1939", 0, null, null]
    ]],
    ["book:总表", [
      ["日期", "总消耗（USD）", "C", "C回流"],
      [46247, null, null, null]
    ]]
  ]);
  const reads = [];
  const columnIndex = (letters) => [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  const deps = {
    getWorkbook: async () => ({ properties: { title: "架上包数据表" }, sheets: [
      { properties: { title: "架上包 A", hidden: false } },
      { properties: { title: "C", hidden: false } },
      { properties: { title: "总表", hidden: false } }
    ] }),
    getSheetValues: async (id, title, options = {}) => {
      const range = options.range;
      reads.push({ title, range });
      assert.ok(range, `禁止无范围读取页签：${title}`);
      const rows = values.get(`${id}:${title}`) || [];
      if (range === "1:24") return rows.slice(0, 24);
      const match = range.match(/^([A-Z]+):([A-Z]+)$/);
      assert.ok(match && match[1] === match[2], `只允许单列范围读取：${title}!${range}`);
      const column = columnIndex(match[1]);
      return rows.map((row) => [row?.[column]]);
    }
  };

  const result = await collectShelfBook({ id: "book-id", name: "架上包数据表", spreadsheetId: "book" }, "2026-08-13", deps);
  assert.deepEqual(result.rows.map((row) => [row.shooter, row.metric, row.sourceValue, row.targetSheet, row.totalSheet, row.status]), [
    ["c", "消耗", 10, "C", "总表", "ready"],
    ["c", "回流消耗", 1, "C", "总表", "ready"]
  ]);
  assert.equal(result.rows[0].detail.range, "'C'!D5");
  assert.equal(result.rows[0].total.range, "'总表'!C2");
  const projectionReads = reads.filter(({ range }) => range !== "1:24");
  assert.equal(reads.filter(({ range }) => range === "1:24").length, 3);
  assert.ok(projectionReads.length > 0);
  assert.ok(projectionReads.every(({ range }) => /^[A-Z]+:[A-Z]+$/.test(range)));
  assert.ok(projectionReads.some(({ title, range }) => title === "总表" && range === "C:C"));
});

test("appends missing shooter dates in sequence before writing metrics", async () => {
  const values = new Map([
    ["book:架上包 A", [["日期", "投手/包名", "服务费", "消耗", "回流消耗"], ["2026-08-15", "C", 0, 10, 1]]],
    ["book:C", [["日期", "渠道名", "服务费", "消耗", "回流消耗"], ["2026-08-13", "A", 0, null, null], [], []]],
    ["book:总表", [["日期", "总消耗", "C", "C回流"], ["2026-08-13", null, null, null], [], []]]
  ]);
  const location = (range) => {
    const [quotedTitle, cell] = range.split("!");
    const title = quotedTitle.slice(1, -1).replaceAll("''", "'");
    const columnMatch = cell?.match(/^([A-Z]+):([A-Z]+)$/);
    if (columnMatch) {
      const column = [...columnMatch[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
      return { title, column };
    }
    const match = cell?.match(/^([A-Z]+)(\d+)$/);
    if (!match) return { title };
    const column = [...match[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
    return { title, row: Number(match[2]) - 1, column };
  };
  const deps = {
    getWorkbook: async () => ({ properties: { title: "架上包数据表" }, sheets: [
      { properties: { title: "架上包 A", hidden: false } },
      { properties: { title: "C", hidden: false } },
      { properties: { title: "总表", hidden: false } }
    ] }),
    getSheetValues: async (id, sheet) => values.get(`${id}:${sheet}`) || [],
    getSheetValuesBatch: async (id, ranges) => ranges.map((range) => {
      const target = location(range);
      const sheet = values.get(`${id}:${target.title}`) || [];
      if (target.column !== undefined && target.row === undefined) return sheet.map((row) => [row?.[target.column]]);
      return target.row === undefined ? sheet : [[sheet[target.row]?.[target.column]]];
    })
  };

  const preview = await collectShelfBook({ id: "book-id", name: "架上包数据表", spreadsheetId: "book" }, "2026-08-15", deps);
  assert.ok(preview.rows.every((row) => row.status === "ready"));
  assert.equal(preview.rows[0].detail.range, "'C'!D4");
  assert.deepEqual(preview.rows[0].detail.dateUpdates, [
    { range: "'C'!A3", value: "2026-08-14" },
    { range: "'C'!A4", value: "2026-08-15" }
  ]);
  assert.deepEqual(preview.rows[0].total.dateUpdates, [
    { range: "'总表'!A3", value: "2026-08-14" },
    { range: "'总表'!A4", value: "2026-08-15" }
  ]);
  assert.match(preview.rows[0].message, /自动补充 2 个日期行/);

  const writes = [];
  const batches = [];
  const executed = await executeShelfBook({ id: "book-id", name: "架上包数据表", spreadsheetId: "book" }, "2026-08-15", {
    ...deps,
    batchWrite: async (_id, updates) => {
      batches.push(updates.map((item) => item.range));
      writes.push(...updates);
      for (const update of updates) {
        const target = location(update.range);
        const sheet = values.get(`book:${target.title}`);
        while (sheet.length <= target.row) sheet.push([]);
        sheet[target.row][target.column] = update.value;
      }
    }
  });

  assert.ok(batches[0].every((range) => /!A\d+$/.test(range)));
  assert.deepEqual(writes.map((item) => item.range).sort(), ["'C'!A3", "'C'!A4", "'C'!D4", "'C'!E4", "'总表'!A3", "'总表'!A4", "'总表'!C4", "'总表'!D4"]);
  assert.deepEqual(values.get("book:C").slice(2, 4).map((row) => row[0]), ["2026-08-14", "2026-08-15"]);
  assert.deepEqual(values.get("book:总表").slice(2, 4).map((row) => row[0]), ["2026-08-14", "2026-08-15"]);
  assert.ok(executed.rows.every((row) => row.status === "written"));
});

test("does not append an older missing shooter date after a newer row", async () => {
  const values = new Map([
    ["book:架上包 A", [["日期", "投手/包名", "服务费", "消耗", "回流消耗"], ["2026-08-15", "C", 0, 10, 1]]],
    ["book:C", [["日期", "渠道名", "服务费", "消耗", "回流消耗"], ["2026-08-16", "A", 0, null, null]]],
    ["book:总表", [["日期", "总消耗", "C", "C回流"], ["2026-08-15", null, null, null]]]
  ]);
  const deps = {
    getWorkbook: async () => ({ properties: { title: "架上包数据表" }, sheets: [
      { properties: { title: "架上包 A", hidden: false } },
      { properties: { title: "C", hidden: false } },
      { properties: { title: "总表", hidden: false } }
    ] }),
    getSheetValues: async (id, sheet) => values.get(`${id}:${sheet}`) || []
  };

  const preview = await collectShelfBook({ id: "book-id", name: "架上包数据表", spreadsheetId: "book" }, "2026-08-15", deps);
  assert.ok(preview.rows.every((row) => row.status === "error"));
  assert.match(preview.rows[0].message, /早于表内最后日期 2026-08-16/);
});

test("uses the column immediately right of a shooter code for generic return headers", async () => {
  const values = new Map([
    ["book:架上包 A", [["日期", "投手/包名", "服务费", "消耗", "回流消耗"], [46247, "C", 0, 10, 1]]],
    ["book:C", [["备注", "日期", "渠道名", "服务费", "其他", "消耗", "回流"], [null, 46247, "A", 0, null, null, null]]],
    ["book:总表", [["备注", "日期", "总消耗（USD）", "其他", "C", "回流"], [null, 46247, null, null, null, null]]]
  ]);
  const deps = {
    getWorkbook: async () => ({ properties: { title: "架上包数据表" }, sheets: [
      { properties: { title: "架上包 A", hidden: false } },
      { properties: { title: "C", hidden: false } },
      { properties: { title: "总表", hidden: false } }
    ] }),
    getSheetValues: async (id, sheet) => values.get(`${id}:${sheet}`) || []
  };
  const result = await collectShelfBook({ id: "book-id", name: "架上包数据表", spreadsheetId: "book" }, "2026-08-13", deps);
  const spendRow = result.rows.find((row) => row.metric === "消耗");
  const returnRow = result.rows.find((row) => row.metric === "回流消耗");
  assert.equal(spendRow.detail.range, "'C'!F2");
  assert.equal(spendRow.total.range, "'总表'!E2");
  assert.equal(returnRow.detail.range, "'C'!G2");
  assert.equal(returnRow.total.range, "'总表'!F2");
});

test("reads a large rack date block and exact shooter/total target rows", async () => {
  const targetIndex = 500;
  const rowCount = 1000;
  const businessDate = dateKey(46247 + targetIndex, "2026-08-13");
  const rack = [
    ["架上包 A"],
    ["日期", "投手/包名", "服务费", "消耗", "回流消耗"],
    ...Array.from({ length: rowCount }, (_, index) => [
      index === targetIndex + 1 ? null : 46247 + index,
      "C",
      0,
      index === targetIndex ? 10 : index === targetIndex + 1 ? 4 : null,
      index === targetIndex ? 1 : index === targetIndex + 1 ? 0.5 : null
    ])
  ];
  const shooter = [
    ["日期", "渠道名", "服务费", "消耗", "回流消耗"],
    ...Array.from({ length: rowCount }, (_, index) => [46247 + index, "A", 0, null, null])
  ];
  const total = [
    ["日期", "总消耗", "C", "C回流"],
    ...Array.from({ length: rowCount }, (_, index) => [46247 + index, null, null, null])
  ];
  const values = new Map([
    ["book:架上包 A", rack],
    ["book:C", shooter],
    ["book:总表", total]
  ]);
  const readBatches = [];
  const columnIndex = (letters) => [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  const getSheetValuesBatch = async (id, ranges) => {
    readBatches.push(ranges);
    return ranges.map((range) => {
      const [sheetPart, selector] = range.split("!");
      const title = sheetPart.slice(1, -1).replaceAll("''", "'");
      const rows = values.get(`${id}:${title}`) || [];
      if (/^\d+:\d+$/.test(selector)) return rows.slice(0, Number(selector.split(":")[1]));
      const whole = selector.match(/^([A-Z]+):([A-Z]+)$/i);
      if (whole) return rows.map((row) => [row?.[columnIndex(whole[1].toUpperCase())]]);
      const window = selector.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
      assert.ok(window, `unexpected range ${range}`);
      assert.equal(window[1].toUpperCase(), window[3].toUpperCase());
      const column = columnIndex(window[1].toUpperCase());
      return rows.slice(Number(window[2]) - 1, Number(window[4])).map((row) => [row?.[column]]);
    });
  };
  const deps = {
    getWorkbook: async () => ({ properties: { title: "架上包数据表" }, sheets: [
      { properties: { title: "架上包 A", hidden: false } },
      { properties: { title: "C", hidden: false } },
      { properties: { title: "总表", hidden: false } }
    ] }),
    getSheetValuesBatch
  };

  const result = await collectShelfBook({ id: "large-book", name: "架上包数据表", spreadsheetId: "book" }, businessDate, deps);

  assert.deepEqual(result.rows.map((row) => [row.metric, row.sourceValue, row.status, row.detail.range, row.total.range]), [
    ["消耗", 14, "ready", "'C'!D502", "'总表'!C502"],
    ["回流消耗", 1.5, "ready", "'C'!E502", "'总表'!D502"]
  ]);
  assert.deepEqual(readBatches[1], ["'架上包 A'!A:A", "'C'!A:A", "'总表'!A:A"]);
  assert.deepEqual(readBatches[2], [
    "'架上包 A'!B503:B504", "'架上包 A'!D503:D504", "'架上包 A'!E503:E504",
    "'C'!B502:B502", "'C'!D502:D502", "'C'!E502:E502",
    "'总表'!C502:C502", "'总表'!D502:D502"
  ]);
  assert.ok(readBatches[2].every((range) => !/![A-Z]+:[A-Z]+$/i.test(range)));
});
