// show 的 JSON/JSONL 渲染：session/meta/turns/messages/subagents/顶层 coverage、归属未知项，以及首行逻辑 header 的逐事件 JSONL。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderShowJson, renderShowJsonl } from "../scripts/lib/render-json.ts";
import type { SessionNode } from "../scripts/lib/store-types.ts";
import { toolResultIsErrorOnlyEvent } from "./fixtures.ts";
import { HEADER, node, RENDER_EVENTS, showMd, showOptions } from "./render-helpers.ts";

describe("renderShowJson / renderShowJsonl", () => {
  it("子会话的任务、助手正文和通信工具块随开关过滤，推理与普通工具保留", () => {
    const events = [
      { type: "turn/start", seq: 0, data: { turn: 1 } },
      {
        type: "user/message",
        seq: 1,
        data: { source: { kind: "user" }, content: [{ type: "text", text: "任务" }] },
      },
      {
        type: "assistant/message",
        seq: 2,
        data: {
          message: {
            content: [
              { type: "text", text: "答复" },
              { type: "reasoning", text: "推理" },
              { type: "tool-call", id: "send", name: "send_message", arguments: "{}" },
              { type: "tool-call", id: "read", name: "read", arguments: "{}" },
            ],
          },
        },
      },
    ];
    const base = node([], events);
    const child = {
      ...base,
      file: {
        ...base.file,
        decoded: {
          ...base.file.decoded,
          header: { ...base.file.decoded.header, origin: "subagent" },
        },
      },
    };
    const render = (includeAgentComm: boolean) =>
      JSON.parse(
        renderShowJson(child, {
          summary: false,
          includeAgentComm,
          subagents: false,
          unattributable: [],
        }).content,
      ) as {
        turns: { prompt: string | null; response: string | null }[];
        messages: {
          role: string;
          text: string;
          reasoning: string;
          toolCalls: { name: string }[];
        }[];
      };
    const hidden = render(false);
    assert.deepEqual(hidden.turns[0], { turn: 1, seq: 0, prompt: null, response: null });
    assert.equal(hidden.messages.length, 1);
    assert.equal(hidden.messages[0].text, "");
    assert.equal(hidden.messages[0].reasoning, "推理");
    assert.deepEqual(
      hidden.messages[0].toolCalls.map((call) => call.name),
      ["read"],
    );
    const included = render(true);
    assert.equal(included.turns[0].prompt, "任务");
    assert.equal(included.turns[0].response, "答复");
    assert.deepEqual(
      included.messages[1].toolCalls.map((call) => call.name),
      ["send_message", "read"],
    );
  });

  it("普通主会话（origin 缺失）的助手混合块按主会话处理", () => {
    const events = [
      {
        type: "user/message",
        seq: 0,
        data: { source: { kind: "user" }, content: [{ type: "text", text: "fork-task" }] },
      },
      {
        type: "assistant/message",
        seq: 1,
        data: {
          message: {
            content: [
              { type: "text", text: "fork-text" },
              { type: "reasoning", text: "fork-reasoning" },
              { type: "tool-call", id: "fork-send", name: "send_message", arguments: "{}" },
              { type: "tool-call", id: "fork-read", name: "read", arguments: "{}" },
            ],
          },
        },
      },
    ];
    const base = node([], events);
    const fork = {
      ...base,
      entry: { ...base.entry, id: "json-fork" },
      file: {
        ...base.file,
        decoded: {
          ...base.file.decoded,
          header: { ...base.file.decoded.header, origin: undefined },
        },
      },
    };
    const render = (includeAgentComm: boolean) =>
      JSON.parse(
        renderShowJson(fork, {
          summary: false,
          includeAgentComm,
          subagents: false,
          unattributable: [],
        }).content,
      ) as {
        messages: { text: string; reasoning: string; toolCalls: { name: string }[] }[];
      };
    const hidden = render(false);
    assert.equal(hidden.messages[1].text, "fork-text");
    assert.equal(hidden.messages[1].reasoning, "fork-reasoning");
    assert.deepEqual(
      hidden.messages[1].toolCalls.map((call) => call.name),
      ["read"],
    );
    const included = render(true);
    assert.deepEqual(
      included.messages[1].toolCalls.map((call) => call.name),
      ["send_message", "read"],
    );
  });

  it("种子 fork 会话按 inheritedEventCount 分离继承轮次与自有通信", () => {
    const events = [
      { type: "turn/start", seq: 0, data: { turn: 1 } },
      {
        type: "user/message",
        seq: 1,
        data: {
          source: { kind: "user", rpcId: "rpc-inherited" },
          content: [{ type: "text", text: "INHERITED-PROMPT-MARK" }],
        },
      },
      {
        type: "assistant/message",
        seq: 2,
        data: {
          message: { content: [{ type: "text", text: "INHERITED-REPLY-MARK" }] },
        },
      },
      { type: "turn/start", seq: 3, data: { turn: 2 } },
      {
        type: "user/message",
        seq: 4,
        data: {
          source: { kind: "user" },
          content: [{ type: "text", text: "FORK-TASK-MARK" }],
        },
      },
      {
        type: "assistant/message",
        seq: 5,
        data: {
          message: {
            content: [
              { type: "text", text: "FORK-TEXT-MARK" },
              { type: "reasoning", text: "FORK-REASON-MARK" },
              { type: "tool-call", id: "fork-send", name: "send_message", arguments: "{}" },
              { type: "tool-call", id: "fork-read", name: "read", arguments: "{}" },
            ],
          },
        },
      },
    ];
    const seeded = node([], events, {
      header: { ...HEADER, origin: "subagent", isSeeded: true },
      inheritedEventCount: 3,
    });
    type Message = {
      role: string;
      text: string;
      reasoning: string;
      toolCalls: { name: string }[];
    };
    type Document = {
      turns: { turn: number; seq: number; prompt: string | null; response: string | null }[];
      messages: Message[];
    };
    const render = (includeAgentComm: boolean): Document =>
      JSON.parse(
        renderShowJson(seeded, {
          summary: false,
          includeAgentComm,
          subagents: false,
          unattributable: [],
        }).content,
      ) as Document;

    const hidden = render(false);
    assert.equal(
      hidden.messages.some((message) => message.text.includes("INHERITED-PROMPT-MARK")),
      true,
    );
    assert.equal(
      hidden.messages.some((message) => message.text.includes("FORK-TASK-MARK")),
      false,
    );
    const hiddenAssistant = hidden.messages.find((message) => message.role === "assistant");
    assert.equal(hiddenAssistant?.text, "");
    assert.equal(hiddenAssistant?.reasoning.includes("FORK-REASON-MARK"), true);
    assert.deepEqual(
      hiddenAssistant?.toolCalls.map((call) => call.name),
      ["read"],
    );
    assert.equal(hidden.turns[0]?.prompt?.includes("INHERITED-PROMPT-MARK"), true);
    assert.equal(hidden.turns[0]?.response, null);
    assert.equal(hidden.turns[1]?.prompt, null);
    assert.equal(hidden.turns[1]?.response, null);

    const included = render(true);
    assert.equal(
      included.messages.some((message) => message.text.includes("FORK-TASK-MARK")),
      true,
    );
    const includedAssistant = included.messages.find((message) =>
      message.text.includes("FORK-TEXT-MARK"),
    );
    assert.equal(includedAssistant?.text.includes("FORK-TEXT-MARK"), true);
    assert.equal(includedAssistant?.reasoning.includes("FORK-REASON-MARK"), true);
    assert.deepEqual(
      includedAssistant?.toolCalls.map((call) => call.name),
      ["send_message", "read"],
    );
    assert.equal(included.turns[1]?.prompt?.includes("FORK-TASK-MARK"), true);
    assert.equal(included.turns[1]?.response?.includes("FORK-TEXT-MARK"), true);

    const hiddenMd = showMd(seeded, showOptions()).content;
    assert.equal(hiddenMd.includes("INHERITED-PROMPT-MARK"), true);
    assert.equal(hiddenMd.includes("FORK-TASK-MARK"), false);
    assert.equal(hiddenMd.includes("FORK-TEXT-MARK"), false);
    const includedMd = showMd(seeded, showOptions({ includeAgentComm: true })).content;
    assert.equal(includedMd.includes("**子代理任务**"), true);
    assert.equal(includedMd.includes("FORK-TASK-MARK"), true);
    assert.equal(includedMd.includes("FORK-TEXT-MARK"), true);
  });

  it("JSON 递归保留三层会话子树，并按通信开关逐节点投影", () => {
    const eventsFor = (name: string): Record<string, unknown>[] => [
      {
        type: "turn/start",
        seq: 0,
        data: { turn: 1 },
      },
      {
        type: "user/message",
        seq: 1,
        data: {
          source: { kind: "user" },
          content: [{ type: "text", text: `${name}-task` }],
        },
      },
      {
        type: "assistant/message",
        seq: 2,
        data: {
          message: {
            content: [
              { type: "text", text: `${name}-reply` },
              { type: "reasoning", text: `${name}-reasoning` },
              { type: "tool-call", id: `${name}-send`, name: "send_message", arguments: "{}" },
              { type: "tool-call", id: `${name}-read`, name: "read", arguments: "{}" },
            ],
          },
        },
      },
    ];
    const makeNode = (
      id: string,
      origin: string | undefined,
      children: SessionNode[],
    ): SessionNode => {
      const base = node(children, eventsFor(id));
      return {
        ...base,
        entry: { ...base.entry, id },
        file: {
          ...base.file,
          decoded: {
            ...base.file.decoded,
            header: { ...base.file.decoded.header, origin },
          },
        },
      };
    };
    const grandchild = makeNode("json-grandchild", "subagent", []);
    const child = makeNode("json-child", "subagent", [grandchild]);
    const root = makeNode("json-root", undefined, [child]);
    type JsonNode = {
      session: { id: string };
      turns: { prompt: string | null; response: string | null }[];
      messages: { role: string; text: string; reasoning: string; toolCalls: { name: string }[] }[];
      subagents: {
        session: { id: string };
        turns: { prompt: string | null; response: string | null }[];
        messages: {
          role: string;
          text: string;
          reasoning: string;
          toolCalls: { name: string }[];
        }[];
        subagents: JsonNode[];
      }[];
    };
    const render = (includeAgentComm: boolean): JsonNode =>
      JSON.parse(
        renderShowJson(root, {
          summary: false,
          includeAgentComm,
          subagents: true,
          unattributable: [],
        }).content,
      ) as JsonNode;

    const hidden = render(false);
    const included = render(true);
    const hiddenChild = hidden.subagents[0];
    const hiddenGrandchild = hiddenChild.subagents[0];
    const includedChild = included.subagents[0];
    const includedGrandchild = includedChild.subagents[0];
    assert.equal(hidden.session.id, "json-root");
    assert.equal(hiddenChild.session.id, "json-child");
    assert.equal(hiddenGrandchild.session.id, "json-grandchild");
    assert.equal(hidden.subagents.length, 1);
    assert.equal(hiddenChild.subagents.length, 1);

    const hiddenRootAssistant = hidden.messages.find((message) => message.role === "assistant");
    const includedRootAssistant = included.messages.find((message) => message.role === "assistant");
    assert.equal(hiddenRootAssistant?.text, "json-root-reply");
    assert.equal(includedRootAssistant?.text, "json-root-reply");
    assert.deepEqual(
      hiddenRootAssistant?.toolCalls.map((call) => call.name),
      ["read"],
    );
    assert.deepEqual(
      includedRootAssistant?.toolCalls.map((call) => call.name),
      ["send_message", "read"],
    );

    for (const child of [hiddenChild, hiddenGrandchild]) {
      assert.equal(
        child.messages.every((message) => message.text.length === 0),
        true,
      );
      assert.deepEqual(
        child.messages
          .find((message) => message.role === "assistant")
          ?.toolCalls.map((call) => call.name),
        ["read"],
      );
      assert.deepEqual(child.turns[0], { turn: 1, seq: 0, prompt: null, response: null });
    }
    for (const child of [includedChild, includedGrandchild]) {
      const assistant = child.messages.find((message) => message.role === "assistant");
      assert.equal(
        child.messages.some((message) => message.text.includes(`${child.session.id}-task`)),
        true,
      );
      assert.equal(assistant?.text, `${child.session.id}-reply`);
      assert.equal(assistant?.reasoning, `${child.session.id}-reasoning`);
      assert.deepEqual(
        assistant?.toolCalls.map((call) => call.name),
        ["send_message", "read"],
      );
      assert.equal(child.turns[0]?.prompt?.includes(`${child.session.id}-task`), true);
      assert.equal(child.turns[0]?.response?.includes(`${child.session.id}-reply`), true);
    }
  });

  it("JSON 结构：session/meta/turns/messages/subagents/coverage", () => {
    const document = JSON.parse(
      renderShowJson(node(), {
        summary: false,
        includeAgentComm: false,
        subagents: false,
        unattributable: [],
      }).content,
    ) as Record<string, unknown>;
    const session = document.session as Record<string, unknown>;
    assert.equal(session.id, "session-render-01");
    assert.equal(session.title, "渲染标题");
    const meta = document.meta as Record<string, unknown>;
    assert.equal(meta.eventCount, RENDER_EVENTS.length);
    assert.equal((document.turns as unknown[]).length, 1);
    assert.equal((document.messages as unknown[]).length >= 5, true);
    assert.deepEqual(document.subagents, []);
    // show 也必须自证边界：作用域是本节点及其子树，可归属的排除项恒为空。
    assert.deepEqual(document.coverage, {
      scannedCount: 1,
      includedCount: 1,
      excluded: [],
      unattributable: [],
    });
  });

  it("JSON：coverage.unattributable 反映归属未知项", () => {
    const document = JSON.parse(
      renderShowJson(node(), {
        summary: false,
        includeAgentComm: false,
        subagents: false,
        unattributable: [{ id: "x-bad", reason: "header 分类 malformed" }],
      }).content,
    ) as { coverage: { unattributable: Array<{ id: string; reason: string }> } };
    assert.deepEqual(document.coverage.unattributable, [
      { id: "x-bad", reason: "header 分类 malformed" },
    ]);
  });

  it("--summary 时 messages 为空", () => {
    const document = JSON.parse(
      renderShowJson(node(), {
        summary: true,
        includeAgentComm: false,
        subagents: false,
        unattributable: [],
      }).content,
    ) as Record<string, unknown>;
    assert.deepEqual(document.messages, []);
  });

  it("摘要与 md 同源：正文带事件数、--summary 不含轮次总数、--subagents 追加子代理数", () => {
    const base = { unattributable: [], includeAgentComm: false };
    assert.match(
      renderShowJson(node(), { ...base, summary: false, subagents: false }).summary,
      /^会话 session-render-01；事件 \d+ 个$/u,
    );
    assert.match(
      renderShowJson(node(), { ...base, summary: false, subagents: true }).summary,
      /^会话 session-render-01；事件 \d+ 个；子代理 \d+ 个$/u,
    );
    assert.match(
      renderShowJson(node(), { ...base, summary: true, subagents: false }).summary,
      /^会话 session-render-01（摘要）$/u,
    );
  });

  it("文件式交接：通知与维护指令都是 user/message，不新增条目类型，正文已剥离信封", () => {
    const ts = "2026-10-31T12:44:50+08:00";
    const injection = (kind: string, text: string): string =>
      `<dsh-injection kind="${kind}" src="handoff" id="abcdef12" ts="${ts}">\n${text}\n</dsh-injection>`;
    const INSTRUCTION = "维护指令 NEW-INSTRUCTION-MARK";
    const NOTICE = "压缩通知 NEW-NOTICE-MARK";
    const BODY = "维护完成说明 NEW-BODY-MARK";
    const events: Record<string, unknown>[] = [
      { type: "turn/start", seq: 0, time: 10, data: { turn: 1 } },
      {
        type: "user/message",
        seq: 1,
        time: 11,
        data: {
          role: "user",
          content: [{ type: "text", text: injection("handoff-instruction", INSTRUCTION) }],
          source: { kind: "handoff" },
        },
      },
      {
        type: "assistant/message",
        seq: 2,
        time: 12,
        data: {
          turn: 1,
          message: { role: "assistant", content: [{ type: "text", text: BODY }] },
        },
      },
      {
        type: "developer/message",
        seq: 3,
        time: 13,
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
        time: 14,
        data: { target: "next-step", start: 0, inserted: [] },
      },
      {
        type: "user/message",
        seq: 5,
        time: 15,
        data: {
          role: "user",
          content: [{ type: "text", text: injection("context-compacted", NOTICE) }],
          source: { kind: "handoff" },
        },
      },
      { type: "turn/end", seq: 6, time: 16, data: { turn: 1 } },
    ];
    const document = JSON.parse(
      renderShowJson(node([], events), {
        summary: false,
        includeAgentComm: false,
        subagents: false,
        unattributable: [],
      }).content,
    ) as { messages: Array<{ type: string; text: string }> };
    const noticeEntry = document.messages.find((message) => message.text.includes(NOTICE));
    assert.notEqual(noticeEntry, undefined);
    assert.equal(noticeEntry?.type, "user/message");
    assert.equal(noticeEntry?.text, NOTICE);
    const instructionEntry = document.messages.find((message) =>
      message.text.includes(INSTRUCTION),
    );
    assert.equal(instructionEntry?.type, "user/message");
    // 维护完成说明仍作为普通助手消息保留。
    assert.equal(document.messages.filter((message) => message.text === BODY).length, 1);
    assert.equal(
      document.messages.some((message) => message.type === "developer/message"),
      false,
    );
    // jsonl 是逐字原文入口：注入信封在原始事件行里原样保留。
    const lines = renderShowJsonl(node([], events))
      .content.split("\n")
      .filter((line) => line.length > 0);
    assert.equal(lines.filter((line) => line.includes("<dsh-injection")).length, 2);
  });

  it("JSONL：首行逻辑 header，其后逐事件", () => {
    const rendered = renderShowJsonl(node());
    const lines = rendered.content.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 1 + RENDER_EVENTS.length);
    const header = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(header.id, "session-render-01");
    assert.equal(header.type, undefined);
    const event = JSON.parse(lines[1]) as Record<string, unknown>;
    assert.equal(event.seq, 0);
  });

  it("只写 message.isError 的工具结果在 messages 里为 isError: true", () => {
    // 与 md 侧同一判据（decode.ts 的 toolResultIsError）。只认 `data.error` 的实现会在这里写出
    // `isError: false`，而该结果的正文正是 `Error: …`；json 是给程序消费的形态，
    // 这个字段被读反的影响比标签更直接。
    const events: Record<string, unknown>[] = [
      { type: "turn/start", seq: 0, time: 10, data: { turn: 1 } },
      toolResultIsErrorOnlyEvent(
        1,
        11,
        "call-edit-1",
        "Error: old_string and new_string must differ",
      ),
      { type: "turn/end", seq: 2, time: 12, data: { turn: 1 } },
    ];
    const document = JSON.parse(
      renderShowJson(node([], events), {
        summary: false,
        includeAgentComm: false,
        subagents: false,
        unattributable: [],
      }).content,
    ) as { messages: Array<{ type: string; isError?: boolean; text: string }> };
    const result = document.messages.find((message) => message.type === "tool/result");
    assert.notEqual(result, undefined);
    assert.equal(result?.isError, true);
    // 信封在 json 正文里已剥离，只剩错误文本。
    assert.equal(result?.text, "Error: old_string and new_string must differ");
  });
});
