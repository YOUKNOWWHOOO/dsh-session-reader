// 测试：默认可见性判定的全部取值与边界——注入消息、子代理调度回执、保留名单、缺失来源。
// 依据：默认参数下只保留携带真实交流内容的消息（判定真值源为 scripts\lib\visibility.ts）。
// 关键设计：判据只允许字段（`data.source.kind`、事件 type、`tool/call` 的 `name` 与 `callId`），
// 因此每个用例都直接给出字段组合，不依赖任何正文文案。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectSubagentReplyCallIds,
  countExcludedInjections,
  isInjectedUserMessage,
  isSubagentReceipt,
  isVisibleEvent,
  KEPT_USER_MESSAGE_KINDS,
} from "../scripts/lib/visibility.ts";

function userMessage(source: unknown): Record<string, unknown> {
  return {
    type: "user/message",
    seq: 1,
    time: 1,
    data: { role: "user", content: [{ type: "text", text: "正文" }], source },
  };
}

function subagentCall(callId: string): Record<string, unknown> {
  return {
    type: "tool/call",
    seq: 2,
    time: 2,
    data: { callId, name: "subagent", arguments: '{"prompt":"p"}' },
  };
}

function toolResult(callId: string): Record<string, unknown> {
  return {
    type: "tool/result",
    seq: 3,
    time: 3,
    data: {
      message: { role: "tool", toolCallId: callId, content: [{ type: "text", text: "ok" }] },
    },
  };
}

describe("默认可见性判定", () => {
  it("保留名单内的来源默认可见", () => {
    for (const kind of KEPT_USER_MESSAGE_KINDS) {
      const event = userMessage({ kind });
      assert.equal(isInjectedUserMessage(event), false, `kind=${kind} 应保留`);
      assert.equal(isVisibleEvent(event, new Set()), true, `kind=${kind} 应可见`);
    }
  });

  it("延迟回答必在保留名单内（它可能承载唯一的答案记录）", () => {
    // 提问在等待中被中止、取消或超时时不产生配对的 tool/result，此时本技能不产出 `**回答**`
    // 条目，用户的选择与自定义回答只存在这条消息里；因此它必须默认可见。
    assert.equal(KEPT_USER_MESSAGE_KINDS.includes("user-question-reply"), true);
    const event = userMessage({ kind: "user-question-reply" });
    assert.equal(isVisibleEvent(event, new Set()), true);
  });

  it("保留名单外的来源默认排除，含来源缺失、空串与非字符串", () => {
    for (const kind of [
      "runtime-context",
      "skill-catalog",
      "tool-jobs",
      "model-selection",
      "goal",
      "schedule",
      "webhook",
      "session-reference",
      "plugin",
      "skill-invocation",
      "team-message",
      // 本机会话库实测出现的三个来源种类：工作区指令文件、重复调用提醒、审批策略通知。
      "agent-instructions",
      "repeat-tool-reminder",
      "user-approval",
      // 基础成员与外部钩子：同为框架注入，默认不呈现。
      "system-prompt",
      "tool-registry",
      "ptc-mode",
      "plan-mode",
      "time-context",
      "tmux-context",
      "cordis-host-runner",
    ]) {
      const event = userMessage({ kind });
      assert.equal(isInjectedUserMessage(event), true, `kind=${kind} 应排除`);
      assert.equal(isVisibleEvent(event, new Set()), false, `kind=${kind} 应不可见`);
    }
    // 缺 source / 空串 / 非字符串：都无法证明来源，一律排除（白名单的失效方向是"默认不显示"）。
    assert.equal(isInjectedUserMessage(userMessage(undefined)), true);
    assert.equal(isInjectedUserMessage(userMessage({})), true);
    assert.equal(isInjectedUserMessage(userMessage({ kind: "" })), true);
    assert.equal(isInjectedUserMessage(userMessage({ kind: 42 })), true);
    assert.equal(isInjectedUserMessage({ type: "user/message", seq: 1, time: 1, data: {} }), true);
  });

  it("非 user/message 事件不参与注入判定", () => {
    assert.equal(
      isInjectedUserMessage({ type: "assistant/message", seq: 1, time: 1, data: {} }),
      false,
    );
    assert.equal(isInjectedUserMessage(subagentCall("call_1")), false);
  });

  it("子代理调度回执按 callId 配对识别，与正文文案无关", () => {
    const ids = collectSubagentReplyCallIds([
      subagentCall("call_sub_1"),
      {
        type: "tool/call",
        seq: 4,
        time: 4,
        data: { callId: "call_read_1", name: "read", arguments: "{}" },
      },
    ]);
    assert.deepEqual([...ids], ["call_sub_1"]);
    assert.equal(isSubagentReceipt(toolResult("call_sub_1"), ids), true);
    assert.equal(isSubagentReceipt(toolResult("call_read_1"), ids), false);
    // 未配对的 toolCallId 不是回执：不能凭"看起来像回执"排除。
    assert.equal(isSubagentReceipt(toolResult("call_unknown"), ids), false);
    assert.equal(isSubagentReceipt(subagentCall("call_sub_1"), ids), false);
    // 回执默认不可见，普通工具结果默认可见。
    assert.equal(isVisibleEvent(toolResult("call_sub_1"), ids), false);
    assert.equal(isVisibleEvent(toolResult("call_read_1"), ids), true);
  });

  it("回执集合不因 callId 缺失或空串而纳入空键", () => {
    const ids = collectSubagentReplyCallIds([
      { type: "tool/call", seq: 1, time: 1, data: { name: "subagent" } },
      { type: "tool/call", seq: 2, time: 2, data: { name: "subagent", callId: "" } },
    ]);
    assert.equal(ids.size, 0);
  });

  it("排除计数按类别分列，普通事件不计入", () => {
    const events = [
      userMessage({ kind: "user" }),
      userMessage({ kind: "runtime-context" }),
      userMessage({ kind: "tool-jobs" }),
      userMessage({ kind: "skill-catalog" }),
      subagentCall("call_sub_1"),
      toolResult("call_sub_1"),
      toolResult("call_read_1"),
      { type: "assistant/message", seq: 9, time: 9, data: {} },
    ];
    const ids = collectSubagentReplyCallIds(events);
    assert.deepEqual(countExcludedInjections(events, ids), {
      userMessages: 3,
      subagentReceipts: 1,
    });
  });

  it("默认参数下的整体可见集合：注入与回执被排除，其余保留", () => {
    const events = [
      userMessage({ kind: "user" }),
      userMessage({ kind: "subagent-settled" }),
      userMessage({ kind: "runtime-context" }),
      subagentCall("call_sub_1"),
      toolResult("call_sub_1"),
      toolResult("call_read_1"),
      { type: "assistant/message", seq: 10, time: 10, data: {} },
      { type: "compaction/summary", seq: 11, time: 11, data: {} },
    ];
    const ids = collectSubagentReplyCallIds(events);
    const decisions = events.map((event) => isVisibleEvent(event, ids));
    assert.deepEqual(decisions, [
      true, // 用户消息
      true, // 子代理结算
      false, // 运行时上下文
      true, // 调度调用本身（它是发往子代理的消息载体）
      false, // 调度回执
      true, // 普通工具结果
      true, // 助手正文
      true, // 压缩摘要事件（框架事件，默认隐藏由 --events 分支负责，不属注入过滤）
    ]);
    assert.equal(decisions.filter((value) => value).length, 6);
  });
});
