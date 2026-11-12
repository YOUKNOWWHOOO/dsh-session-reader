// show 的 JSON/JSONL 渲染：session/meta/turns/messages/subagents/顶层 coverage、归属未知项，以及首行逻辑 header 的逐事件 JSONL。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderShowJson, renderShowJsonl } from "../scripts/lib/render-json.ts";
import { toolResultIsErrorOnlyEvent } from "./fixtures.ts";
import { node, RENDER_EVENTS } from "./render-helpers.ts";

describe("renderShowJson / renderShowJsonl", () => {
  it("JSON 结构：session/meta/turns/messages/subagents/coverage", () => {
    const document = JSON.parse(
      renderShowJson(node(), { summary: false, subagents: false, unattributable: [] }).content,
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
      renderShowJson(node(), { summary: true, subagents: false, unattributable: [] }).content,
    ) as Record<string, unknown>;
    assert.deepEqual(document.messages, []);
  });

  it("摘要与 md 同源：正文带事件数、--summary 不含轮次总数、--subagents 追加子代理数", () => {
    const base = { unattributable: [] };
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
