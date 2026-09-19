// show 的 Markdown 渲染：默认可见性与隐藏摘要、开关全开、--role/--truncate 截断、覆盖声明、归属未知、轮次大纲、子代理块、围栏动态长度、MD014 中和与空事件节点。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderShowMd } from "../scripts/lib/render-show-md.ts";
import type { SessionNode } from "../scripts/lib/store-types.ts";
import {
  assertDocumentShape,
  decodedFile,
  node,
  sessionEntry,
  showOptions,
} from "./render-helpers.ts";

describe("renderShowMd", () => {
  it("默认可见性：正文经围栏承载、推理/工具/事件隐藏并给出摘要", () => {
    const rendered = renderShowMd(node(), showOptions());
    assertDocumentShape(rendered.content);
    assert.equal(rendered.content.startsWith("# 会话记录\n\n"), true);
    assert.equal(rendered.content.includes("- ID：`session-render-01`"), true);
    assert.equal(rendered.content.includes("- 标题：`渲染标题`"), true);
    assert.equal(rendered.content.includes("## 时间线"), true);
    assert.equal(rendered.content.includes("**用户**：\n\n```text\n用户内容 USER-TEXT\n```"), true);
    assert.equal(
      rendered.content.includes("**助手**：\n\n```text\n助手内容 ASSIST-TEXT\n```"),
      true,
    );
    assert.equal(rendered.content.includes("**推理**"), false);
    assert.equal(rendered.content.includes("**工具调用**"), false);
    assert.equal(rendered.content.includes("**事件**"), false);
    assert.equal(rendered.content.includes("摘要：已隐藏 1 条推理内容（--thinking 显示）"), true);
    assert.equal(rendered.content.includes("已隐藏 2 条工具调用/结果（--tools 显示）"), true);
    assert.match(rendered.content, /已隐藏 \d+ 条生命周期事件（--events 显示）/u);
    assert.match(rendered.summary, /事件 9 个/u);
  });

  it("开关全部打开：推理/工具/事件/系统消息可见；--headers 附 seq 与时间", () => {
    const rendered = renderShowMd(
      node(),
      showOptions({ thinking: true, tools: true, events: true, headers: true }),
    );
    assertDocumentShape(rendered.content);
    assert.match(
      rendered.content,
      /\*\*推理\*\*（seq 2；[0-9T:+-]+）：\n\n```text\n推理内容 THINK-TEXT\n```/u,
    );
    assert.match(rendered.content, /\*\*工具调用\*\*（`read`）（seq 3；[0-9T:+-]+）：/u);
    assert.equal(rendered.content.includes('```text\n{"path":"x"}\n```'), true);
    assert.match(
      rendered.content,
      /\*\*工具结果\*\*（seq 4；[0-9T:+-]+）：\n\n```text\n结果 RESULT-TEXT\n```/u,
    );
    assert.match(rendered.content, /\*\*系统消息\*\*（seq 5；[0-9T:+-]+）：/u);
    assert.match(
      rendered.content,
      /\*\*事件\*\*（seq 0；[0-9T:+-]+）：`turn\/start` `\{"turn":1\}`/u,
    );
    assert.match(rendered.content, /\*\*用户\*\*（seq 1；[0-9T:+-]+）：/u);
    assert.equal(rendered.content.includes("摘要："), false);
  });

  it("--role 过滤与 --truncate 截断（截断先于围栏）", () => {
    const rendered = renderShowMd(node(), showOptions({ role: "user", truncate: 4 }));
    assert.equal(rendered.content.includes("```text\n用户内容…\n```"), true);
    assert.equal(rendered.content.includes("**助手**"), false);
    assert.equal(rendered.content.includes("已按 --role user 过滤对话消息"), true);
    assert.equal(rendered.content.includes("文本已截断为 4 字符"), true);
  });

  it("覆盖声明：show 的 md 自证边界，--probe 不含", () => {
    const rendered = renderShowMd(node(), showOptions());
    assert.equal(rendered.content.includes("扫描会话 1 个；纳入 1 个；排除 0 个"), true);
    const probe = renderShowMd(node(), showOptions({ probe: true }));
    assert.equal(probe.content.includes("扫描会话"), false);
  });

  it("归属未知：逐条声明且不计入 N/M/K", () => {
    const rendered = renderShowMd(
      node(),
      showOptions({
        subagents: true,
        unattributable: [{ id: "sess-child-bad", reason: "header 行不是合法 JSON" }],
      }),
    );
    assertDocumentShape(rendered.content);
    assert.equal(rendered.content.includes("扫描会话 1 个；纳入 1 个；排除 0 个"), true);
    assert.equal(
      rendered.content.includes("归属未知：`sess-child-bad`（`header 行不是合法 JSON`）"),
      true,
    );
  });

  it("轮次大纲截断与其它载体同口径：0 即不截断、无固定上限", () => {
    const long = "超".repeat(300);
    const outlineEvents: Record<string, unknown>[] = [
      { type: "turn/start", seq: 0, time: 10, data: { turn: 1 } },
      {
        type: "user/message",
        seq: 1,
        time: 11,
        data: { role: "user", content: [{ type: "text", text: long }] },
        surfaceOp: "append",
      },
      {
        type: "assistant/message",
        seq: 2,
        time: 12,
        data: { turn: 1, message: { role: "assistant", content: [{ type: "text", text: "答" }] } },
        surfaceOp: "append",
      },
    ];
    const full = renderShowMd(node([], outlineEvents), showOptions({ summary: true }));
    assert.equal(full.content.includes(long), true);
    assert.equal(full.content.includes("…"), false);
    const cut = renderShowMd(node([], outlineEvents), showOptions({ summary: true, truncate: 8 }));
    assert.equal(cut.content.includes(`${"超".repeat(8)}…`), true);
    assert.equal(cut.content.includes(long), false);
  });

  it("--summary 输出轮次大纲", () => {
    const rendered = renderShowMd(node(), showOptions({ summary: true }));
    assertDocumentShape(rendered.content);
    assert.equal(rendered.content.includes("## 轮次大纲"), true);
    assert.equal(
      rendered.content.includes("- T1（seq 0）：`用户内容 USER-TEXT` → `助手内容 ASSIST-TEXT`"),
      true,
    );
    assert.equal(rendered.content.includes("## 时间线"), false);
    assert.match(rendered.summary, /（摘要）/u);
  });

  it("--subagents 追加子代理块（## 子代理 路径编号）", () => {
    const child: SessionNode = {
      entry: { ...sessionEntry(), id: "cafe1111-2222-3333-4444-555566667777" },
      file: decodedFile(),
      children: [],
    };
    const rendered = renderShowMd(node([child]), showOptions({ subagents: true }));
    assertDocumentShape(rendered.content);
    assert.equal(rendered.content.includes("## 子代理 1"), true);
    assert.equal(rendered.content.includes("### 时间线"), true);
    assert.equal(rendered.content.includes("cafe1111-2222-3333-4444-555566667777"), true);
    assert.match(rendered.summary, /子代理 1 个/u);
  });

  it("围栏动态长度：正文含 ``` 与更长反引号串时围栏加长", () => {
    const events: Record<string, unknown>[] = [
      {
        type: "user/message",
        seq: 0,
        time: 10,
        data: { role: "user", content: [{ type: "text", text: "a\n```\nb" }] },
      },
      {
        type: "user/message",
        seq: 1,
        time: 11,
        data: { role: "user", content: [{ type: "text", text: "x ```` y" }] },
      },
    ];
    const rendered = renderShowMd(node([], events), showOptions());
    assert.equal(rendered.content.includes("````text\na\n```\nb\n````"), true);
    assert.equal(rendered.content.includes("`````text\nx ```` y\n`````"), true);
  });

  it("MD014 中和：全 $ 载荷末尾追加空格行；制表符归一化", () => {
    const events: Record<string, unknown>[] = [
      {
        type: "user/message",
        seq: 0,
        time: 10,
        data: { role: "user", content: [{ type: "text", text: "$ ls\n$ pwd" }] },
      },
      {
        type: "user/message",
        seq: 1,
        time: 11,
        data: { role: "user", content: [{ type: "text", text: "a\tb" }] },
      },
    ];
    const rendered = renderShowMd(node([], events), showOptions());
    assert.equal(rendered.content.includes("```text\n$ ls\n$ pwd\n \n```"), true);
    assert.equal(rendered.content.includes("```text\na    b\n```"), true);
  });

  it("空事件节点：轮次大纲为空、KV 规模行为零", () => {
    const rendered = renderShowMd(node([], []), showOptions({ summary: true }));
    assert.equal(rendered.content.includes("## 轮次大纲\n\n无"), true);
    assert.match(rendered.content, /规模：.*；0 事件/u);
  });
});
