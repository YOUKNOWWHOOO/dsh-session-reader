// 检索单元测试：runSearch 的 scope（text/tools/all）、大小写敏感开关、limit 截断显示但
// 总数保持全量、范围过滤（origin 时主会话命中不计）与命中摘录标签；
// 以及问答可读文本进入默认档检索单元、错误态结果不算回答、结构不符会话列入排除项。

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ASK_USER_PAYLOAD_MISMATCH_REASON } from "../scripts/lib/ask-user.ts";
import { runSearch } from "../scripts/lib/store-search.ts";
import {
  askSampleErrorResult,
  askSampleMalformed,
  askSamplePaired,
  askSampleUnpaired,
  resetTempDir,
  writeFixtureHome,
} from "./fixtures.ts";
import { contextOf, initStoreFixtures, storeFixtures } from "./store-helpers.ts";

const fixtures = storeFixtures("search");
const HEALTHY_HOME = fixtures.healthyHome;

before(() => {
  initStoreFixtures(fixtures);
});

describe("runSearch", () => {
  const scopeFilters = { origin: "all" as const };
  const baseOptions = { caseSensitive: false, context: 20, limit: 0 };

  it("scope=text：用户/助手正文与问答可读文本（本夹具的关键词只出现在正文里）", () => {
    const outcome = runSearch(contextOf(HEALTHY_HOME), "needle", scopeFilters, {
      ...baseOptions,
      scope: "text",
    });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.totalHits, 2);
    assert.deepEqual(outcome.data.hits.map((hit) => hit.label).sort(), ["assistant", "user"]);
  });

  it("scope=tools：另含工具参数与结果", () => {
    const outcome = runSearch(contextOf(HEALTHY_HOME), "needle", scopeFilters, {
      ...baseOptions,
      scope: "tools",
    });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.totalHits, 4);
    assert.deepEqual([...new Set(outcome.data.hits.map((hit) => hit.label))].sort(), [
      "assistant",
      "tool/call",
      "tool/result",
      "user",
    ]);
  });

  it("scope=all：覆盖推理/系统/压缩/命令/标题请求/交付物", () => {
    const outcome = runSearch(contextOf(HEALTHY_HOME), "needle", scopeFilters, {
      ...baseOptions,
      scope: "all",
    });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    const labels = new Set(outcome.data.hits.map((hit) => hit.label));
    for (const label of [
      "assistant/reasoning",
      "system",
      "compaction/summary",
      "command/run",
      "command/done",
      "title-request",
      "deliverables",
    ]) {
      assert.equal(labels.has(label), true, `缺少 label: ${label}`);
    }
    const userHit = outcome.data.hits.find((hit) => hit.label === "user");
    assert.equal(userHit?.excerpt, "Alpha Needle here");
  });

  it("大小写敏感开关", () => {
    const sensitive = runSearch(contextOf(HEALTHY_HOME), "Needle", scopeFilters, {
      ...baseOptions,
      scope: "text",
      caseSensitive: true,
    });
    assert.equal(sensitive.success, true);
    if (!sensitive.success) return;
    assert.equal(sensitive.data.totalHits, 1);
  });

  it("limit 截断显示但总数保持全量", () => {
    const outcome = runSearch(contextOf(HEALTHY_HOME), "needle", scopeFilters, {
      ...baseOptions,
      scope: "text",
      limit: 1,
    });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.hits.length, 1);
    assert.equal(outcome.data.totalHits, 2);
    assert.equal(outcome.data.truncated, true);
  });

  it("范围过滤生效（origin=subagent 时主会话命中不计）", () => {
    const outcome = runSearch(
      contextOf(HEALTHY_HOME),
      "needle",
      { origin: "subagent" },
      { ...baseOptions, scope: "all" },
    );
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.totalHits, 0);
  });
});

describe("runSearch 的合成上下文消息检索单元", () => {
  // 独立 home：断言的命中标签与次数依赖样本内容，不复用其它夹具，避免牵连无关用例的精确计数。
  const root = fileURLToPath(new URL("./.tmp/search-context", import.meta.url));
  const PROJECT = "--C-Users-Alice--";
  const scopeFilters = { origin: "all" as const };
  const options = { caseSensitive: false, context: 200, limit: 0 };
  let home: string;

  function search(keyword: string, scope: "text" | "all") {
    const outcome = runSearch(contextOf(home), keyword, scopeFilters, { ...options, scope });
    assert.equal(outcome.success, true, "检索应成功");
    if (!outcome.success) throw new Error("检索失败");
    return outcome.data;
  }

  before(() => {
    home = writeFixtureHome(resetTempDir(root), {
      sessions: [
        {
          id: "session-ctx-handoff-01",
          projectDir: PROJECT,
          createdAt: 1000,
          events: [
            { type: "turn/start", seq: 0, time: 100, data: { turn: 1 } },
            {
              type: "user/message",
              seq: 1,
              time: 101,
              data: {
                role: "user",
                content: [{ type: "text", text: "生成交接指令 PROMPT-MARK" }],
                source: { kind: "user" },
              },
            },
            {
              type: "assistant/message",
              seq: 2,
              time: 102,
              data: {
                turn: 1,
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "交接正文 BODY-MARK" }],
                },
              },
            },
            {
              type: "developer/message",
              seq: 3,
              time: 103,
              data: {
                turn: 1,
                step: 1,
                message: { role: "developer", source: { kind: "handoff" }, content: [] },
              },
              surfaceOp: { op: "replace", startSeq: 1, endSeq: 2 },
              sourceEventSeqs: [1, 2],
            },
            {
              type: "agent/inbox/spliced",
              seq: 4,
              time: 104,
              data: {
                target: "next-step",
                start: 0,
                inserted: [
                  {
                    role: "user",
                    source: { kind: "user" },
                    content: [
                      {
                        type: "text",
                        text: "<compacted-summary>\n交接正文 BODY-MARK\n</compacted-summary>",
                      },
                    ],
                  },
                ],
              },
            },
            {
              type: "user/message",
              seq: 5,
              time: 105,
              data: {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "<compacted-summary>\n交接正文 BODY-MARK\n</compacted-summary>",
                  },
                ],
                source: { kind: "user" },
              },
            },
            { type: "turn/end", seq: 6, time: 106, data: { turn: 1 } },
          ],
        },
        {
          id: "session-ctx-subagent-02",
          projectDir: PROJECT,
          createdAt: 1100,
          origin: "subagent",
          parentSession: "session-ctx-handoff-01",
          events: [
            { type: "turn/start", seq: 0, time: 200, data: { turn: 1 } },
            {
              type: "user/message",
              seq: 1,
              time: 201,
              data: {
                role: "user",
                content: [{ type: "text", text: "子代理任务 TASK-MARK" }],
                source: { kind: "user" },
              },
            },
            {
              type: "assistant/message",
              seq: 2,
              time: 202,
              data: {
                turn: 1,
                message: { role: "assistant", content: [{ type: "text", text: "子代理回答" }] },
              },
            },
            { type: "turn/end", seq: 3, time: 203, data: { turn: 1 } },
          ],
        },
        {
          id: "session-ctx-standard-03",
          projectDir: PROJECT,
          createdAt: 1200,
          agentPreset: "standard",
          events: [
            { type: "turn/start", seq: 0, time: 300, data: { turn: 1 } },
            {
              type: "user/message",
              seq: 1,
              time: 301,
              data: {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "检查点前言\n\n<compacted-summary>\n摘要 CHECKPOINT-MARK\n</compacted-summary>",
                  },
                ],
                source: { kind: "compact-checkpoint" },
              },
            },
            {
              type: "assistant/message",
              seq: 2,
              time: 302,
              data: {
                turn: 1,
                message: { role: "assistant", content: [{ type: "text", text: "压缩后的回答" }] },
              },
            },
            { type: "turn/end", seq: 3, time: 303, data: { turn: 1 } },
          ],
        },
      ],
    });
  });

  it("text 档：三类合成消息各有独立单元名", () => {
    assert.deepEqual(
      search("PROMPT-MARK", "text").hits.map((hit) => hit.label),
      ["交接指令"],
    );
    assert.deepEqual(
      search("TASK-MARK", "text").hits.map((hit) => hit.label),
      ["子代理任务"],
    );
    assert.deepEqual(
      search("CHECKPOINT-MARK", "text").hits.map((hit) => hit.label),
      ["上下文摘要"],
    );
  });

  it("text 档：被抑制的助手副本不建单元，摘要正文只命中一次", () => {
    const data = search("BODY-MARK", "text");
    assert.deepEqual(
      data.hits.map((hit) => hit.label),
      ["上下文摘要"],
    );
    assert.equal(data.totalHits, 1);
  });

  it("all 档：被抑制副本的原始载荷仍可检索", () => {
    const data = search("BODY-MARK", "all");
    const labels = new Set(data.hits.map((hit) => hit.label));
    assert.equal(labels.has("上下文摘要"), true);
    // `all` 档保留整条事件载荷单元，因此被抑制的助手正文仍可检索到（逐字核对入口）。
    assert.equal(labels.has("assistant/message"), true);
    assert.equal(data.totalHits > 1, true);
  });
});

describe("runSearch 的问答检索单元", () => {
  // 专用夹具 home：四种问答样本各自一个会话。检索断言的命中数依赖样本内容，
  // 因此不复用 store-helpers 的通用夹具（那会让无关用例的精确计数被牵动）。
  const root = fileURLToPath(new URL("./.tmp/search-ask", import.meta.url));
  const PROJECT = "--C-Users-Alice--";
  const scopeFilters = { origin: "all" as const };
  const options = { caseSensitive: false, context: 20, limit: 0 };
  let home: string;
  before(() => {
    home = writeFixtureHome(resetTempDir(root), {
      sessions: [
        {
          id: "session-ask-paired-01",
          projectDir: PROJECT,
          createdAt: 1000,
          events: askSamplePaired(),
        },
        {
          id: "session-ask-unpaired-02",
          projectDir: PROJECT,
          createdAt: 1100,
          events: askSampleUnpaired(),
        },
        {
          id: "session-ask-error-03",
          projectDir: PROJECT,
          createdAt: 1200,
          events: askSampleErrorResult(),
        },
        {
          id: "session-ask-malformed-04",
          projectDir: PROJECT,
          createdAt: 1300,
          events: askSampleMalformed(),
        },
      ],
    });
  });

  it("默认档命中提问与回答的可读文本，标签分别为 提问 与 回答", () => {
    const outcome = runSearch(contextOf(home), "选项 A", scopeFilters, {
      ...options,
      scope: "text",
      // 取足够大的窗口，让片段等于整段可读文本：这样才能断言"检索单元与 md 条目逐字同源"。
      context: 200,
    });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    // 成对样本里 `选项 A` 出现在提问的选项行与回答的选择行各一次：两处都必须是检索单元。
    const labels = outcome.data.hits.map((hit) => hit.label);
    assert.deepEqual(labels, ["提问", "回答"]);
    assert.deepEqual(
      outcome.data.hits.map((hit) => hit.seq),
      [2, 3],
    );
    // 片段就是抽取产物的原文（仅按"每条独占一行"的约定把换行折叠为空格）。
    assert.equal(
      outcome.data.hits[0].excerpt,
      "[1] 确认事项 `x`（id：ask_one） 问题：题干含 **bold text** 与制表符\ta 选项：选项 A｜说明 A；见 https://example.com/path 选项：选项 B｜说明 B",
    );
    assert.equal(outcome.data.hits[1].excerpt, "[1] id：ask_one 选择：选项 A");
  });

  it("tools/all 档仍另含问答的原始载荷", () => {
    const text = runSearch(contextOf(home), "选项 A", scopeFilters, {
      ...options,
      scope: "text",
    });
    const tools = runSearch(contextOf(home), "选项 A", scopeFilters, {
      ...options,
      scope: "tools",
    });
    const all = runSearch(contextOf(home), "选项 A", scopeFilters, { ...options, scope: "all" });
    assert.equal(text.success && tools.success && all.success, true);
    if (!text.success || !tools.success || !all.success) return;
    // 单调包含：text ≤ tools ≤ all。tools 多出的正是工具调用参数与工具结果两个原始载荷单元。
    assert.equal(tools.data.totalHits > text.data.totalHits, true);
    assert.equal(all.data.totalHits >= tools.data.totalHits, true);
    const toolLabels = new Set(tools.data.hits.map((hit) => hit.label));
    assert.equal(toolLabels.has("tool/call"), true);
    assert.equal(toolLabels.has("tool/result"), true);
    assert.equal(toolLabels.has("提问"), true);
    assert.equal(toolLabels.has("回答"), true);
  });

  it("未配对提问可被默认档命中，且没有回答单元", () => {
    const outcome = runSearch(contextOf(home), "未配对的提问仍需呈现", scopeFilters, {
      ...options,
      scope: "text",
    });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.deepEqual(
      outcome.data.hits.map((hit) => hit.label),
      ["提问"],
    );
    assert.equal(outcome.data.hits[0].sessionId, "session-ask-unpaired-02");
  });

  it("错误态结果不算回答：只命中提问，且该会话不列入排除项", () => {
    const outcome = runSearch(contextOf(home), "提问在被回答前被中止", scopeFilters, {
      ...options,
      scope: "text",
    });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.deepEqual(
      outcome.data.hits.map((hit) => hit.label),
      ["提问"],
    );
    assert.equal(
      outcome.data.coverage.excluded.some((item) => item.id === "session-ask-error-03"),
      false,
    );
  });

  it("结构不符的会话逐条列入排除项、不计入 M，且不中断整条检索", () => {
    const outcome = runSearch(contextOf(home), "选项 A", scopeFilters, {
      ...options,
      scope: "text",
    });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.deepEqual(
      outcome.data.coverage.excluded.map((item) => ({ id: item.id, reason: item.reason })),
      [{ id: "session-ask-malformed-04", reason: ASK_USER_PAYLOAD_MISMATCH_REASON }],
    );
    // 同一会话不得同时计入 M 与 K；日志本身解码成功，因此扫描摘要仍照常计入它。
    assert.equal(outcome.data.coverage.includedCount, 3);
    assert.equal(
      outcome.data.coverage.includedCount + outcome.data.coverage.excluded.length,
      outcome.data.coverage.scannedCount,
    );
    assert.equal(outcome.data.coverage.includedCount, 3);
    assert.equal(outcome.data.scan.logsDecoded, 4);
    assert.equal(outcome.data.scan.decodeFailures, 0);
    // 其余会话照常被检索（前面的两处命中给出证据）。
    assert.equal(outcome.data.totalHits, 2);
  });
});
