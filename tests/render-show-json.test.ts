// show 的 JSON/JSONL 渲染：session/meta/turns/messages/subagents/顶层 coverage、归属未知项，以及首行逻辑 header 的逐事件 JSONL。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderShowJson, renderShowJsonl } from "../scripts/lib/render-json.ts";
import { node, RENDER_EVENTS } from "./render-helpers.ts";

describe("renderShowJson / renderShowJsonl", () => {
  it("JSON 结构：session/meta/turns/messages/subagents/coverage", () => {
    const document = JSON.parse(
      renderShowJson(node(), { summary: false, unattributable: [] }),
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
        unattributable: [{ id: "x-bad", reason: "header 分类 malformed" }],
      }),
    ) as { coverage: { unattributable: Array<{ id: string; reason: string }> } };
    assert.deepEqual(document.coverage.unattributable, [
      { id: "x-bad", reason: "header 分类 malformed" },
    ]);
  });

  it("--summary 时 messages 为空", () => {
    const document = JSON.parse(
      renderShowJson(node(), { summary: true, unattributable: [] }),
    ) as Record<string, unknown>;
    assert.deepEqual(document.messages, []);
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
});
