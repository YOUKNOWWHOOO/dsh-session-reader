// decode.ts 单元测试：官方库加载失败路径、解码编排（分类/坏行/撕裂尾/结构违规/一致性校验）、事件模型工具。
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  asArray,
  asRecord,
  decodeSessionLog,
  eventData,
  eventSeq,
  eventTime,
  eventType,
  loadCatalog,
  readBoolean,
  readNumber,
  readString,
  reasoningFromBlocks,
  type SessionFormatCatalog,
  textFromBlocks,
  toolCallsFromBlocks,
  toolResultText,
} from "../scripts/lib/decode.ts";
import { defaultLibRoot, resolveDshHome } from "../scripts/lib/paths.ts";
import { createFakeCatalog, resetTempDir } from "./fixtures.ts";

const TEMP_ROOT = fileURLToPath(new URL("./.tmp/decode", import.meta.url));

const HEADER_LINE = JSON.stringify({
  type: "session",
  version: 3,
  id: "fake-id",
  createdAt: 0,
  isSeeded: false,
  delegationDepth: 0,
});

function logText(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

describe("loadCatalog", () => {
  it("锚点目录不存在时返回失败 Result（不抛错）", async () => {
    const result = await loadCatalog("C:\\nonexistent-lib-root-for-tests");
    assert.equal(result.success, false);
  });

  it("真实官方库可加载并导出 sessionFormatCatalog", async () => {
    const libRoot = defaultLibRoot(resolveDshHome(undefined, process.env, homedir()));
    // 本用例的前提是本机能唯一定位到官方格式库；定位不到时让它以断言失败暴露，
    // 而不是静默跳过——跳过会被算作未通过验收，失败更诚实。
    assert.notEqual(libRoot, undefined, "默认锚点未能唯一确定官方格式库，本用例无法运行");
    if (libRoot === undefined) return;
    const result = await loadCatalog(libRoot);
    assert.equal(result.success, true);
    if (!result.success) return;
    // 版本号取库自报的值：这里是「库能加载并导出目录」的用例，不是版本号本身。
    // 写死版本号会让每一次 dsh 升级把这条用例连带打红，而它要证明的事情并没有变。
    assert.equal(Number.isSafeInteger(result.data.currentVersion), true);
    assert.equal(result.data.currentVersion >= 1, true);
    assert.equal(typeof result.data.readHeader, "function");
  });
});

describe("decodeSessionLog", () => {
  it("正常解码：行数/事件数/继承数统计正确", () => {
    const catalog = createFakeCatalog();
    const result = decodeSessionLog(catalog, logText([HEADER_LINE, '{"seq":0}', '{"seq":1}']), {
      tornTail: false,
    });
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.events.length, 2);
    assert.equal(result.data.parsedEventCount, 2);
    assert.equal(result.data.lineCount, 3);
    assert.equal(result.data.eventLineCount, 2);
    assert.deepEqual(result.data.anomalies, []);
  });

  it("空文本报错", () => {
    const result = decodeSessionLog(createFakeCatalog(), "", { tornTail: false });
    assert.equal(result.success, false);
  });

  it("header 行不是合法 JSON 时报错", () => {
    const result = decodeSessionLog(createFakeCatalog(), logText(["not-json"]), {
      tornTail: false,
    });
    assert.equal(result.success, false);
  });

  it("header 分类 malformed / unsupported 时报错", () => {
    for (const status of ["malformed", "unsupported"] as const) {
      const result = decodeSessionLog(
        createFakeCatalog({ status }),
        logText([HEADER_LINE, '{"seq":0}']),
        {
          tornTail: false,
        },
      );
      assert.equal(result.success, false, `期望失败: ${status}`);
    }
  });

  it("header 分类 migration-required 允许继续", () => {
    const result = decodeSessionLog(
      createFakeCatalog({ status: "migration-required" }),
      logText([HEADER_LINE, '{"seq":0}']),
      {
        tornTail: false,
      },
    );
    assert.equal(result.success, true);
  });

  it("坏行记入 anomalies（含行号）且不中断其它行", () => {
    const result = decodeSessionLog(
      createFakeCatalog(),
      logText([HEADER_LINE, '{"seq":0}', "not-json", '{"seq":1}']),
      { tornTail: false },
    );
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.events.length, 2);
    assert.equal(result.data.anomalies.length, 1);
    assert.equal(result.data.anomalies[0].kind, "bad-line");
    assert.match(result.data.anomalies[0].detail, /第 3 行/u);
  });

  it("撕裂尾记入 anomalies", () => {
    const result = decodeSessionLog(createFakeCatalog(), logText([HEADER_LINE, '{"seq":0}']), {
      tornTail: true,
    });
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(
      result.data.anomalies.some((anomaly) => anomaly.kind === "torn-tail"),
      true,
    );
  });

  it("header 行合法 JSON 但非对象 → 分类 malformed → 失败", () => {
    const result = decodeSessionLog(createFakeCatalog(), logText(['"not-an-object"']), {
      tornTail: false,
    });
    assert.equal(result.success, false);
  });

  it("非对象事件行（null）→ decodeRow 失败", () => {
    const result = decodeSessionLog(createFakeCatalog(), logText([HEADER_LINE, "null"]), {
      tornTail: false,
    });
    assert.equal(result.success, false);
  });

  it("decodeRow 抛错（结构违规）立即失败", () => {
    const result = decodeSessionLog(
      createFakeCatalog({ throwOnRow: 2 }),
      logText([HEADER_LINE, '{"seq":0}', '{"seq":1}']),
      { tornTail: false },
    );
    assert.equal(result.success, false);
  });

  it("createRestore 抛错时失败", () => {
    const result = decodeSessionLog(
      createFakeCatalog({ throwOnCreateRestore: true }),
      logText([HEADER_LINE]),
      {
        tornTail: false,
      },
    );
    assert.equal(result.success, false);
  });

  it("finish 抛错时失败", () => {
    const result = decodeSessionLog(
      createFakeCatalog({ throwOnFinish: true }),
      logText([HEADER_LINE, '{"seq":0}']),
      {
        tornTail: false,
      },
    );
    assert.equal(result.success, false);
  });

  it("一致性校验：静默丢弃事件时报错", () => {
    const result = decodeSessionLog(
      createFakeCatalog({ droppedEvents: 1 }),
      logText([HEADER_LINE, '{"seq":0}', '{"seq":1}']),
      { tornTail: false },
    );
    assert.equal(result.success, false);
    if (result.success) return;
    assert.match(result.error, /解码不一致/u);
  });
});

describe("事件模型工具", () => {
  it("asRecord / asArray / 字段读取判型", () => {
    assert.deepEqual(asRecord({ a: 1 }), { a: 1 });
    assert.equal(asRecord(null), undefined);
    assert.equal(asRecord([1]), undefined);
    assert.deepEqual(asArray([1, 2]), [1, 2]);
    assert.equal(asArray("x"), undefined);
    const record = { text: "t", count: 3, flag: true, missing: null };
    assert.equal(readString(record, "text"), "t");
    assert.equal(readString(record, "count"), undefined);
    assert.equal(readNumber(record, "count"), 3);
    assert.equal(readBoolean(record, "flag"), true);
    assert.equal(readBoolean(record, "missing"), undefined);
  });

  it("textFromBlocks / reasoningFromBlocks / toolCallsFromBlocks", () => {
    const blocks = [
      { type: "text", text: "第一段" },
      { type: "reasoning", text: "推理内容" },
      { type: "tool-call", id: "call_1", name: "read", arguments: '{"path":"a"}' },
      { type: "text", text: "第二段" },
    ];
    assert.equal(textFromBlocks(blocks), "第一段\n第二段");
    assert.equal(reasoningFromBlocks(blocks), "推理内容");
    assert.deepEqual(toolCallsFromBlocks(blocks), [
      { id: "call_1", name: "read", arguments: '{"path":"a"}' },
    ]);
    assert.equal(textFromBlocks(undefined), "");
  });

  it("事件访问器与 toolResultText", () => {
    const event = {
      type: "tool/result",
      seq: 4,
      time: 123,
      data: {
        message: {
          content: [{ type: "tool-result", content: [{ type: "text", text: "结果文本" }] }],
        },
      },
    };
    assert.equal(eventType(event), "tool/result");
    assert.equal(eventSeq(event), 4);
    assert.equal(eventTime(event), 123);
    assert.equal(textFromBlocks(eventData(event).message), "");
    assert.equal(toolResultText(event), "结果文本");
  });
});

describe("审查修订补充：加载/分类/抛出物边界", () => {
  it("loadCatalog：同名包未导出 sessionFormatCatalog → 显式失败", async () => {
    const libRoot = join(TEMP_ROOT, "fake-lib", "node_modules");
    resetTempDir(libRoot);
    const packageDir = join(libRoot, "@deepseek-ai", "dsh-session-format-catalog");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: "@deepseek-ai/dsh-session-format-catalog",
        version: "0.0.0",
        type: "module",
        main: "index.js",
      }),
      "utf8",
    );
    writeFileSync(join(packageDir, "index.js"), "export const other = 1;\n", "utf8");
    const result = await loadCatalog(libRoot);
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.error, /未导出/u);
  });

  it("decodeSessionLog：分类无 reason 与非 Error 抛出物", () => {
    const noReasonCatalog: SessionFormatCatalog = {
      currentVersion: 3,
      readHeader: () => ({ status: "malformed", targetVersion: 3 }),
      createRestore: () => {
        throw new Error("该测试不应触发 createRestore");
      },
    };
    const noReason = decodeSessionLog(noReasonCatalog, logText([HEADER_LINE, '{"seq":0}']), {
      tornTail: false,
    });
    assert.equal(noReason.success, false);
    if (!noReason.success) assert.equal(noReason.error, "header 分类为 malformed: ");

    const literalThrowCatalog: SessionFormatCatalog = {
      currentVersion: 3,
      readHeader: () => ({ status: "current", storedVersion: 3, targetVersion: 3, header: {} }),
      createRestore: () => ({
        header: {},
        decodeRow: () => {
          throw "boom";
        },
        finish: () => ({ header: {}, inheritedEventCount: 0, events: [] }),
      }),
    };
    const literal = decodeSessionLog(literalThrowCatalog, logText([HEADER_LINE, '{"seq":0}']), {
      tornTail: false,
    });
    assert.equal(literal.success, false);
    if (!literal.success) assert.match(literal.error, /boom/u);
  });

  it("事件模型工具边界：非对象/缺字段/非数组分支", () => {
    assert.equal(asRecord("x"), undefined);
    assert.equal(asRecord(3), undefined);
    assert.equal(eventType({}), "");
    assert.equal(eventSeq({ seq: "n" }), undefined);
    assert.equal(eventTime({ time: "t" }), undefined);
    assert.deepEqual(eventData({ data: "x" }), {});
    assert.equal(readNumber({ value: "1" }, "value"), undefined);
    assert.equal(readString({ value: 1 }, "value"), undefined);
    assert.equal(
      textFromBlocks([
        null,
        5,
        { type: "text" },
        { type: "text", text: 7 },
        { type: "text", text: "ok" },
      ]),
      "ok",
    );
    assert.equal(reasoningFromBlocks(undefined), "");
    assert.equal(
      reasoningFromBlocks([null, { type: "reasoning" }, { type: "reasoning", text: "r1" }]),
      "r1",
    );
    const calls = toolCallsFromBlocks([null, "x", { type: "text" }, { type: "tool-call" }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, undefined);
    assert.deepEqual(toolCallsFromBlocks(undefined), []);
    assert.equal(toolResultText({}), "");
    assert.equal(toolResultText({ data: { message: {} } }), "");
    assert.equal(
      toolResultText({
        data: {
          message: {
            content: [
              null,
              { type: "text" },
              { type: "tool-result", content: [] },
              {
                type: "tool-result",
                content: [
                  { type: "text", text: "a" },
                  { type: "text", text: "b" },
                ],
              },
            ],
          },
        },
      }),
      "a\nb",
    );
  });
});
