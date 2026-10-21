// 上下文摘要条目：标准模式官方压缩检查点与自定义模式交接投递消息的统一呈现。
// 覆盖：判定只看字段 / 完整信封、正文只出现一次、助手副本抑制、轮次大纲跳过摘要正文、
// 无投递与不完整信封不误判。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeContextCheckpoints,
  CONTEXT_CHECKPOINT_LABEL,
  checkpointSeqsOf,
  HANDOFF_PROMPT_LABEL,
  SUBAGENT_TASK_LABEL,
} from "../scripts/lib/context-checkpoint.ts";
import type { EventRecord } from "../scripts/lib/decode.ts";
import { analyzeHandoffEvents } from "../scripts/lib/handoff.ts";
import { computeTurns } from "../scripts/lib/render-core.ts";
import { decodedFile, node, showMd, showOptions } from "./render-helpers.ts";

const BODY = "交接正文 BODY-MARK";
const NORMAL = "普通回答 NORMAL-MARK";

function ev(
  type: string,
  seq: number,
  data: Record<string, unknown>,
  extra?: { readonly surfaceOp?: unknown; readonly sourceEventSeqs?: readonly number[] },
): EventRecord {
  return { type, seq, time: 1000 + seq, data, ...extra };
}

function userMessage(seq: number, text: string, kind = "user"): EventRecord {
  return ev("user/message", seq, {
    role: "user",
    content: [{ type: "text", text }],
    source: { kind },
  });
}

function assistantMessage(seq: number, text: string): EventRecord {
  return ev(
    "assistant/message",
    seq,
    { turn: 1, message: { role: "assistant", content: [{ type: "text", text }] } },
    { surfaceOp: "append" },
  );
}

function handoffEvent(seq: number, startSeq: number, endSeq: number): EventRecord {
  return ev(
    "developer/message",
    seq,
    {
      turn: 1,
      step: 1,
      message: { role: "developer", source: { kind: "handoff" }, content: [] },
    },
    { surfaceOp: { op: "replace", startSeq, endSeq }, sourceEventSeqs: [startSeq, endSeq] },
  );
}

function splicedEvent(seq: number, target: string): EventRecord {
  return ev("agent/inbox/spliced", seq, { target, start: 0, inserted: [] });
}

/** 标准模式官方压缩检查点：正文由前言、开标签、摘要块、闭标签组成。 */
function checkpointEvents(): EventRecord[] {
  return [
    ev("turn/start", 0, { turn: 1 }),
    userMessage(1, "压缩前的用户消息"),
    ev("compaction/start", 2, { compactionId: "c1" }),
    ev("compaction/summary", 3, { summary: [{ type: "text", text: "摘要 SUMMARY-MARK" }] }),
    userMessage(
      4,
      "这是自动生成的检查点前言。\n\n<compacted-summary>\n摘要 SUMMARY-MARK\n</compacted-summary>",
      "compact-checkpoint",
    ),
    assistantMessage(5, "压缩后的回答"),
    ev("turn/end", 6, { turn: 1 }),
  ];
}

/** 自定义模式普通消息交接：助手生成 → 交接事件 → 投递消息。 */
function handoffDeliveryEvents(): EventRecord[] {
  return [
    ev("turn/start", 0, { turn: 1 }),
    // 生成正文的前一条且不带 rpcId：按契约它是交接生成指令，渲染为 `**交接指令**`。
    userMessage(1, "从现在起，你唯一的任务是给出交接指令 PROMPT-MARK"),
    assistantMessage(2, BODY),
    handoffEvent(3, 1, 2),
    splicedEvent(4, "next-step"),
    userMessage(5, `<compacted-summary>\n${BODY}\n</compacted-summary>`),
    ev("turn/end", 7, { turn: 1 }),
    ev("turn/start", 8, { turn: 2 }),
    userMessage(9, `<compacted-summary>\n${BODY}\n</compacted-summary>`),
    assistantMessage(10, NORMAL),
    ev("turn/end", 11, { turn: 2 }),
  ];
}

describe("标准模式的官方压缩检查点", () => {
  it("按 source.kind 判定，渲染为 **上下文摘要** 而不是 **用户**", () => {
    const content = showMd(node([], checkpointEvents()), showOptions()).content;
    assert.equal(content.includes(`**${CONTEXT_CHECKPOINT_LABEL}**：`), true);
    assert.equal(content.includes("摘要 SUMMARY-MARK"), true);
    // 检查点不是用户输入：默认视图里不得出现把它标成 **用户** 的条目。
    const checkpointAt = content.indexOf(`**${CONTEXT_CHECKPOINT_LABEL}**：`);
    const before = content.slice(0, checkpointAt);
    assert.equal(before.includes("**用户**：\n\n```text\n这是自动生成的检查点前言"), false);
  });

  it("不受 --role 影响，也不计入隐藏计数", () => {
    const content = showMd(
      node([], checkpointEvents()),
      showOptions({ role: "assistant" }),
    ).content;
    assert.equal(content.includes(`**${CONTEXT_CHECKPOINT_LABEL}**：`), true);
    assert.equal(content.includes("压缩前的用户消息"), false);
  });

  it("轮次大纲跳过摘要正文，不把它当成用户 prompt", () => {
    const events: EventRecord[] = [
      ev("turn/start", 0, { turn: 1 }),
      userMessage(
        1,
        "前言\n\n<compacted-summary>\n摘要 SUMMARY-MARK\n</compacted-summary>",
        "compact-checkpoint",
      ),
      assistantMessage(2, "回答"),
      ev("turn/end", 3, { turn: 1 }),
    ];
    const handoff = analyzeHandoffEvents(events);
    const context = analyzeContextCheckpoints({}, events, handoff);
    const turns = computeTurns(decodedFile(events), checkpointSeqsOf(context));
    assert.equal(turns[0]?.prompt, null);
  });
});

describe("自定义模式的交接投递", () => {
  it("投递消息渲染为 **上下文摘要**，助手副本被抑制，正文只出现一次", () => {
    const content = showMd(node([], handoffDeliveryEvents()), showOptions()).content;
    assert.equal(content.includes(`**${CONTEXT_CHECKPOINT_LABEL}**：`), true);
    // BODY 只出现在摘要条目（两次投递消息中的第一条；第二条在下一轮同样呈现）。
    assert.equal(content.includes(`**交接**：`), true);
    assert.equal(content.includes("投递 next-step；正文 seq 5"), true);
    assert.equal(content.includes(NORMAL), true);
  });

  it("不把真实的用户消息误认成投递消息", () => {
    const events: EventRecord[] = [
      assistantMessage(0, BODY),
      handoffEvent(1, 0, 0),
      userMessage(2, `<compacted-summary>\n${BODY}\n</compacted-summary>`),
      userMessage(3, "真实的用户输入"),
    ];
    const analysis = analyzeHandoffEvents(events);
    const context = analyzeContextCheckpoints({}, events, analysis);
    assert.equal(context.checkpoints.has(events[2] as EventRecord), true);
    assert.equal(context.checkpoints.has(events[3] as EventRecord), false);
  });

  it("先出现普通用户消息时不认定投递，保持旧行为", () => {
    const events: EventRecord[] = [
      assistantMessage(0, BODY),
      handoffEvent(1, 0, 0),
      userMessage(2, "用户先插话"),
      userMessage(3, `<compacted-summary>\n${BODY}\n</compacted-summary>`),
    ];
    const analysis = analyzeHandoffEvents(events);
    const context = analyzeContextCheckpoints({}, events, analysis);
    assert.equal(context.checkpoints.size, 0);
    assert.equal(context.suppressedAssistantSeqs.size, 0);
  });

  it("信封不完整时不认定投递", () => {
    const events: EventRecord[] = [
      assistantMessage(0, BODY),
      handoffEvent(1, 0, 0),
      userMessage(2, `<compacted-summary>\n${BODY}`),
    ];
    const analysis = analyzeHandoffEvents(events);
    const context = analyzeContextCheckpoints({}, events, analysis);
    assert.equal(context.checkpoints.size, 0);
    assert.equal(analysis.deliveries.size, 0);
  });

  it("助手正文与投递摘要不一致时保留助手副本", () => {
    const events: EventRecord[] = [
      assistantMessage(0, "不同的正文 DIFFERENT"),
      handoffEvent(1, 0, 0),
      userMessage(2, `<compacted-summary>\n${BODY}\n</compacted-summary>`),
    ];
    const analysis = analyzeHandoffEvents(events);
    const context = analyzeContextCheckpoints({}, events, analysis);
    assert.equal(context.checkpoints.size, 1);
    assert.equal(context.suppressedAssistantSeqs.size, 0);
  });

  it("交接生成指令渲染为 **交接指令**，不是 **用户**", () => {
    const prompt = userMessage(1, "从现在起，你唯一的任务是给出交接指令。PROMPT-MARK");
    const events: EventRecord[] = [
      prompt,
      assistantMessage(2, BODY),
      handoffEvent(3, 1, 2),
      userMessage(4, `<compacted-summary>\n${BODY}\n</compacted-summary>`),
    ];
    const analysis = analyzeHandoffEvents(events);
    assert.equal(analysis.prompts.get(events[2] as EventRecord)?.event, prompt);
    const content = showMd(node([], events), showOptions()).content;
    assert.equal(content.includes(`**${HANDOFF_PROMPT_LABEL}**：`), true);
    assert.equal(content.includes("PROMPT-MARK"), true);
  });

  it("带 rpcId 的用户消息不被当成交接生成指令", () => {
    const prompt = ev("user/message", 1, {
      role: "user",
      content: [{ type: "text", text: "真实用户输入" }],
      source: { kind: "user", rpcId: "rpc-1" },
    });
    const events: EventRecord[] = [prompt, assistantMessage(2, BODY), handoffEvent(3, 1, 2)];
    const analysis = analyzeHandoffEvents(events);
    assert.equal(analysis.prompts.size, 0);
  });
});

describe("子代理会话的首条任务消息", () => {
  it("渲染为 **子代理任务**，不是 **用户**", () => {
    const task = userMessage(0, "子代理任务正文 TASK-MARK");
    const events: EventRecord[] = [task, assistantMessage(1, "回答")];
    const base = node([], events);
    const subagentNode = {
      ...base,
      entry: {
        ...base.entry,
        header: { ...base.entry.header, origin: "subagent", delegationDepth: 1 },
      },
      file: {
        ...base.file,
        decoded: {
          ...base.file.decoded,
          header: { ...base.file.decoded.header, origin: "subagent", delegationDepth: 1 },
        },
      },
    };
    const content = showMd(subagentNode, showOptions()).content;
    assert.equal(content.includes(`**${SUBAGENT_TASK_LABEL}**：`), true);
    assert.equal(content.includes("TASK-MARK"), true);
  });

  it("带 rpcId 的首条用户消息不标为任务", () => {
    const message = ev("user/message", 0, {
      role: "user",
      content: [{ type: "text", text: "真实用户输入" }],
      source: { kind: "user", rpcId: "rpc-1" },
    });
    const analysis = analyzeContextCheckpoints(
      { origin: "subagent", delegationDepth: 1 },
      [message],
      analyzeHandoffEvents([message]),
    );
    assert.equal(analysis.subagentTask, null);
  });
});
