// 上下文摘要条目：标准模式官方压缩检查点的呈现；以及文件式交接的维护指令、压缩通知与子代理任务。
// 覆盖：判定只看字段与注入起点 / 标准检查点保留前言与 `<compacted-summary>` 标签 / 正文只出现一次 /
// 轮次大纲跳过合成消息 / 旧自定义摘要投递与旧生成指令位置判据不再识别。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeContextCheckpoints,
  CONTEXT_CHECKPOINT_LABEL,
  checkpointSeqsOf,
  HANDOFF_NOTICE_LABEL,
  HANDOFF_PROMPT_LABEL,
  SUBAGENT_TASK_LABEL,
} from "../scripts/lib/context-checkpoint.ts";
import type { EventRecord } from "../scripts/lib/decode.ts";
import { analyzeHandoffEvents, HANDOFF_LABEL } from "../scripts/lib/handoff.ts";
import { computeTurns } from "../scripts/lib/render-core.ts";
import { buildDefaultViewFilter } from "../scripts/lib/visibility.ts";
import { decodedFile, node, showMd, showOptions } from "./render-helpers.ts";

const BODY = "助手回复 BODY-MARK";
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

describe("标准模式的官方压缩检查点", () => {
  it("按 source.kind 判定，渲染为 **上下文摘要** 而不是 **用户**", () => {
    const content = showMd(node([], checkpointEvents()), showOptions()).content;
    assert.equal(content.includes(`**${CONTEXT_CHECKPOINT_LABEL}**：`), true);
    assert.equal(content.includes("摘要 SUMMARY-MARK"), true);
    // 标准检查点保留官方前言与 `<compacted-summary>` 标签，不按摘要信封二次切分。
    assert.equal(content.includes("这是自动生成的检查点前言。"), true);
    assert.equal(content.includes("<compacted-summary>"), true);
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
    const context = analyzeContextCheckpoints({}, events, handoff, 0);
    const turns = computeTurns(
      decodedFile(events),
      checkpointSeqsOf(context),
      buildDefaultViewFilter(events, context.subagentTask, false, false),
    );
    assert.equal(turns[0]?.prompt, null);
  });
});

describe("旧自定义交接形态不再识别", () => {
  it("`<compacted-summary>` 投递消息不再渲染为上下文摘要，助手正文保留为助手", () => {
    const events: EventRecord[] = [
      ev("turn/start", 0, { turn: 1 }),
      assistantMessage(1, BODY),
      handoffEvent(2, 1, 1),
      userMessage(3, `<compacted-summary>\n${BODY}\n</compacted-summary>`),
      ev("turn/end", 4, { turn: 1 }),
    ];
    const analysis = analyzeHandoffEvents(events);
    const context = analyzeContextCheckpoints({}, events, analysis, 0);
    // 旧摘要投递与助手副本抑制已删除，不保留空集合或兼容别名。
    assert.equal(Object.hasOwn(analysis, "deliveries"), false);
    assert.equal(Object.hasOwn(context, "suppressedAssistantSeqs"), false);
    assert.equal(context.checkpoints.size, 0);
    const content = showMd(node([], events), showOptions()).content;
    assert.equal(content.includes(`**${CONTEXT_CHECKPOINT_LABEL}**`), false);
    assert.equal(content.includes("**助手**："), true);
    // 助手正文只由助手条目承载一次；用户消息里的摘要标签不再被当成摘要正文。
    assert.equal(content.slice(0, content.indexOf(`**${HANDOFF_LABEL}**`)).includes(BODY), true);
  });

  it("紧邻 assistant/message 的普通用户消息不再按旧结构位置认作维护指令", () => {
    const prompt = userMessage(1, "从现在起，你唯一的任务是给出交接指令。PROMPT-MARK");
    const events: EventRecord[] = [prompt, assistantMessage(2, BODY), handoffEvent(3, 1, 2)];
    const analysis = analyzeHandoffEvents(events);
    assert.equal(analysis.prompts.size, 0);
    const content = showMd(node([], events), showOptions()).content;
    assert.equal(content.includes(`**${HANDOFF_PROMPT_LABEL}**`), false);
    assert.equal(content.includes("**用户**："), true);
    assert.equal(content.includes("PROMPT-MARK"), true);
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
    const content = showMd(subagentNode, showOptions({ includeAgentComm: true })).content;
    assert.equal(content.includes(`**${SUBAGENT_TASK_LABEL}**：`), true);
    assert.equal(content.includes("TASK-MARK"), true);
  });

  it("带 rpcId 的首条用户消息不标为任务", () => {
    const message = ev("user/message", 0, {
      role: "user",
      content: [{ type: "text", text: "真实用户输入" }],
      source: { kind: "user", rpcId: "rpc-1" },
    });
    const inheritedEventCount = 0;
    const analysis = analyzeContextCheckpoints(
      { origin: "subagent", delegationDepth: 1 },
      [message],
      analyzeHandoffEvents([message]),
      inheritedEventCount,
    );
    assert.equal(analysis.subagentTask, null);
  });

  it("种子前缀里的无 rpcId 用户消息不影响自有任务识别", () => {
    const inheritedEvents = [
      ev("turn/start", 0, { turn: 1 }),
      userMessage(1, "继承用户消息 WITHOUT-RPC-INHERITED"),
      assistantMessage(2, "继承助手回复 WITHOUT-RPC-INHERITED"),
    ];
    const task = userMessage(3, "自有任务 WITHOUT-RPC-TASK");
    const events = [...inheritedEvents, task];
    const inheritedEventCount = 3;
    const analysis = analyzeContextCheckpoints(
      { origin: "subagent", delegationDepth: 1 },
      events,
      analyzeHandoffEvents(events),
      inheritedEventCount,
    );
    assert.equal(analysis.subagentTask, task);
  });

  it("种子历史中的 rpcId 不得阻止自有首条任务消息被识别", () => {
    const inheritedMessage = ev("user/message", 0, {
      role: "user",
      content: [{ type: "text", text: "继承历史中的用户输入" }],
      source: { kind: "user", rpcId: "rpc-inherited" },
    });
    const task = userMessage(1, "自有子代理任务 TASK-AFTER-INHERITED");
    const events = [inheritedMessage, task, assistantMessage(2, "回答")];
    const inheritedEventCount = 1;
    const analysis = analyzeContextCheckpoints(
      { origin: "subagent", delegationDepth: 1 },
      events,
      analyzeHandoffEvents(events),
      inheritedEventCount,
    );
    assert.equal(analysis.subagentTask, task);
  });
});

describe("文件式交接的压缩通知", () => {
  const NOTICE = "本会话刚才发生了上下文压缩，你是接续会话。NOTICE-MARK";
  const INSTRUCTION = "从现在起，你唯一的任务是完成对交接文件的维护。INSTRUCTION-MARK";
  const CONTINUE = "继续 CONTINUE-MARK";

  /** 部署侧注入起点（形态取自 `preset-lib/injection-boundary.mjs`）。 */
  function injection(kind: string, text: string): string {
    const ts = "2026-10-31T12:44:50+08:00";
    return `<dsh-injection kind="${kind}" src="handoff" id="abcdef12" ts="${ts}">\n${text}\n</dsh-injection>`;
  }

  /**
   * 文件式完整交接：维护指令注入 → 助手正文 → 交接事件 → 代理信箱拼接事件 →
   * `context-compacted` 通知 → 用户继续。
   *
   * 顺序取自真实日志：通知在交接事件之后、下一次真实用户消息之前落账。
   */
  function noticeEvents(): EventRecord[] {
    return [
      ev("turn/start", 0, { turn: 1 }),
      userMessage(1, injection("handoff-instruction", INSTRUCTION), "handoff"),
      assistantMessage(2, BODY),
      handoffEvent(3, 1, 2),
      splicedEvent(4, "next-step"),
      userMessage(5, injection("context-compacted", NOTICE), "handoff"),
      userMessage(6, CONTINUE),
      assistantMessage(7, NORMAL),
      ev("turn/end", 8, { turn: 1 }),
    ];
  }

  /** 取包含给定文本的行之前最近的标签名（用于断言"这段正文归属哪个条目"）。 */
  function labelBefore(content: string, needle: string): string | null {
    const lines = content.split("\n");
    const index = lines.findIndex((line) => line.includes(needle));
    if (index < 0) return null;
    for (let cursor = index; cursor >= 0; cursor -= 1) {
      const matched = /^\*\*([^*]+)\*\*/u.exec(lines[cursor]);
      if (matched !== null) return matched[1];
    }
    return null;
  }

  it("通知渲染为 **交接通知**，助手回复保留为 **助手**，不产生上下文摘要", () => {
    const events = noticeEvents();
    const content = showMd(node([], events), showOptions()).content;
    assert.equal(content.includes(`**${HANDOFF_NOTICE_LABEL}**：`), true);
    assert.equal(content.includes(NOTICE), true);
    assert.equal(content.includes(`**${HANDOFF_PROMPT_LABEL}**：`), true);
    assert.equal(content.includes(INSTRUCTION), true);
    assert.equal(content.includes(`**${HANDOFF_LABEL}**：`), true);
    assert.equal(content.includes(`**${CONTEXT_CHECKPOINT_LABEL}**`), false);
    // 助手回复只由助手条目承载一次（文件式交接不产生摘要副本）。
    assert.equal(content.split(BODY).length - 1, 1);
    // 通知不是人类输入：承载它的条目标签必须是 交接通知，而不是 用户。
    assert.equal(labelBefore(content, NOTICE), HANDOFF_NOTICE_LABEL);
  });

  it("通知与维护指令都不进入轮次大纲的 prompt", () => {
    const events = noticeEvents();
    const analysis = analyzeHandoffEvents(events);
    const context = analyzeContextCheckpoints({}, events, analysis, 0);
    const notice = events[5] as EventRecord;
    const instruction = events[1] as EventRecord;
    assert.equal(context.handoffNotices.has(notice), true);
    assert.equal(context.handoffNotices.get(notice)?.text, NOTICE);
    assert.equal(context.handoffPrompts.has(instruction), true);
    assert.equal(context.handoffPrompts.get(instruction)?.text, INSTRUCTION);
    const turns = computeTurns(
      decodedFile(events),
      checkpointSeqsOf(context),
      buildDefaultViewFilter(events, context.subagentTask, false, false),
    );
    assert.equal(turns[0]?.prompt, CONTINUE);
  });

  it("不受 --role 与 --summary 影响：--role user 仍呈现通知，--summary 不输出通知", () => {
    const events = noticeEvents();
    const roleContent = showMd(node([], events), showOptions({ role: "user" })).content;
    assert.equal(roleContent.includes(`**${HANDOFF_NOTICE_LABEL}**：`), true);
    const summaryContent = showMd(node([], events), showOptions({ summary: true })).content;
    assert.equal(summaryContent.includes(`**${HANDOFF_NOTICE_LABEL}**`), false);
    assert.equal(summaryContent.includes(NOTICE), false);
    assert.equal(summaryContent.includes(CONTINUE), true);
  });
});
