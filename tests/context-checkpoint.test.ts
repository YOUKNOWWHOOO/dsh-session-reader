// 上下文摘要条目：标准模式官方压缩检查点与自定义模式交接投递消息的统一呈现。
// 覆盖：判定只看字段 / 完整信封、正文只出现一次、助手副本抑制、轮次大纲跳过摘要正文、
// 无投递与不完整信封不误判。
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

  it("投递消息与助手副本都带消息信封、内层带嵌套残形时判定不变", () => {
    // 真实形态：投递消息外层被 `<dsh-message role="user">` 包裹，内层复制的助手落账文本又带着
    // `<dsh-message role="assistant">`，且它的终点被外层转义为 `<\/dsh-message>`。
    const ts = "2026-10-29T22:59:57+08:00";
    const openOf = (role: "user" | "assistant"): string =>
      `<dsh-message role="${role}" id="abcdef12" ts="${ts}">`;
    const enveloped = (role: "user" | "assistant", text: string): string =>
      `${openOf(role)}\n${text}\n</dsh-message>`;
    // 助手落账文本（内层副本的原始形态）：外层终点未转义。
    const assistantText = enveloped("assistant", BODY);
    // 投递内层：把助手落账文本复制进去后，外层包裹把它的终点转义为 `<\/dsh-message>`。
    const innerText = assistantText.replace("</dsh-message>", "<\\/dsh-message>");
    const assistant = assistantMessage(0, assistantText);
    const handoff = handoffEvent(1, 0, 0);
    const delivery = userMessage(
      2,
      enveloped("user", `<compacted-summary>\n${innerText}\n</compacted-summary>`),
    );
    const events: EventRecord[] = [assistant, handoff, delivery];
    const analysis = analyzeHandoffEvents(events);
    const context = analyzeContextCheckpoints({}, events, analysis);
    assert.equal(analysis.deliveries.size, 1);
    assert.equal(context.checkpoints.size, 1);
    // 正文只在 `<compacted-summary>` 内出现一次：助手副本必须被抑制。
    assert.equal(context.suppressedAssistantSeqs.has(0), true);
    // 摘要正文保留标签，内层的嵌套残形被清理。
    assert.equal(
      context.checkpoints.get(delivery)?.text,
      `<compacted-summary>\n${BODY}\n</compacted-summary>`,
    );
    // 第三行指向投递消息 seq 与剥净后的正文码点数，不含任何信封字符。
    assert.equal(
      analysis.entries
        .get(handoff)
        ?.structure.endsWith(`正文 seq 2（${String([...BODY].length)} 字符）`),
      true,
    );
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

  it("交接生成指令带消息信封时正文被剥离", () => {
    const ts = "2026-10-29T22:59:57+08:00";
    const enveloped = (role: "user" | "assistant", text: string): string =>
      `<dsh-message role="${role}" id="abcdef12" ts="${ts}">\n${text}\n</dsh-message>`;
    const promptText = "从现在起，你唯一的任务是给出交接指令。PROMPT-MARK";
    const prompt = userMessage(1, enveloped("user", promptText));
    const events: EventRecord[] = [
      prompt,
      assistantMessage(2, enveloped("assistant", BODY)),
      handoffEvent(3, 1, 2),
      userMessage(4, enveloped("user", `<compacted-summary>\n${BODY}\n</compacted-summary>`)),
    ];
    const analysis = analyzeHandoffEvents(events);
    // 生成指令正文只剥消息信封，其余逐字保留。
    assert.equal(analysis.prompts.get(events[2] as EventRecord)?.text, promptText);
    assert.equal(analysis.suppressedAssistantSeqs.has(2), true);
    const content = showMd(node([], events), showOptions()).content;
    assert.equal(content.includes(`**${HANDOFF_PROMPT_LABEL}**：`), true);
    assert.equal(content.includes("<dsh-message"), false);
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

describe("新格式交接的压缩通知", () => {
  const NOTICE = "本会话刚才发生了上下文压缩，你是接续会话。NOTICE-MARK";
  const INSTRUCTION = "从现在起，你唯一的任务是完成对交接文件的维护。INSTRUCTION-MARK";
  const CONTINUE = "继续 CONTINUE-MARK";

  /** 部署侧注入起点（形态取自 `preset-lib/injection-boundary.mjs`）。 */
  function injection(kind: string, text: string): string {
    const ts = "2026-10-31T12:44:50+08:00";
    return `<dsh-injection kind="${kind}" src="handoff" id="abcdef12" ts="${ts}">\n${text}\n</dsh-injection>`;
  }

  /**
   * 新格式的完整交接：维护指令注入 → 助手正文 → 交接事件 → 投递 →
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

  it("通知渲染为 **交接通知**，交接正文保留为 **助手**，不产生上下文摘要", () => {
    const events = noticeEvents();
    const content = showMd(node([], events), showOptions()).content;
    assert.equal(content.includes(`**${HANDOFF_NOTICE_LABEL}**：`), true);
    assert.equal(content.includes(NOTICE), true);
    assert.equal(content.includes(`**${HANDOFF_PROMPT_LABEL}**：`), true);
    assert.equal(content.includes(INSTRUCTION), true);
    assert.equal(content.includes(`**${HANDOFF_LABEL}**：`), true);
    assert.equal(content.includes(`**${CONTEXT_CHECKPOINT_LABEL}**`), false);
    // 交接正文只由助手条目承载一次（新格式不抑制助手副本）。
    assert.equal(content.split(BODY).length - 1, 1);
    // 通知不是人类输入：承载它的条目标签必须是 交接通知，而不是 用户。
    assert.equal(labelBefore(content, NOTICE), HANDOFF_NOTICE_LABEL);
  });

  it("通知与维护指令都不进入轮次大纲的 prompt", () => {
    const events = noticeEvents();
    const analysis = analyzeHandoffEvents(events);
    const context = analyzeContextCheckpoints({}, events, analysis);
    const notice = events[5] as EventRecord;
    const instruction = events[1] as EventRecord;
    assert.equal(context.handoffNotices.has(notice), true);
    assert.equal(context.handoffNotices.get(notice)?.text, NOTICE);
    assert.equal(context.handoffPrompts.has(instruction), true);
    const turns = computeTurns(decodedFile(events), checkpointSeqsOf(context));
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
