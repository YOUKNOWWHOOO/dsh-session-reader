// show 的 Markdown 渲染：默认可见性与隐藏摘要、开关全开、--role/--truncate 截断、覆盖声明、归属未知、轮次大纲、子代理块、围栏动态长度、MD014 中和与空事件节点。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ASK_USER_QUESTION_LABEL, analyzeAskUserEvents } from "../scripts/lib/ask-user.ts";
import { renderShowJson } from "../scripts/lib/render-json.ts";
import { renderShowMd } from "../scripts/lib/render-show-md.ts";
import type { SessionNode } from "../scripts/lib/store-types.ts";
import {
  askQuestionEvent,
  askSampleErrorResult,
  askSampleMalformed,
  askSamplePaired,
  askSampleUnpaired,
  toolResultIsErrorOnlyEvent,
} from "./fixtures.ts";
import {
  assertDocumentShape,
  decodedFile,
  node,
  RENDER_EVENTS,
  sessionEntry,
  showMd,
  showOptions,
} from "./render-helpers.ts";

describe("renderShowMd", () => {
  it("收件箱事件由通信开关与事件开关共同控制", () => {
    const events = [
      {
        type: "agent/inbox/spliced",
        seq: 1,
        data: { inserted: [{ content: [{ type: "text", text: "INBOX-MARK" }] }] },
      },
    ];
    for (const includeAgentComm of [false, true]) {
      for (const eventsVisible of [false, true]) {
        const content = showMd(
          node([], events),
          showOptions({ includeAgentComm, events: eventsVisible }),
        ).content;
        assert.equal(content.includes("INBOX-MARK"), includeAgentComm && eventsVisible);
        assert.equal(content.includes("已排除 1 条与其它 agent 的通信"), !includeAgentComm);
      }
    }
  });

  it("通信开关与 tools/summary 组合下的探测字节数与完整输出一致", () => {
    const events = [
      {
        type: "user/message",
        seq: 1,
        data: { source: { kind: "agent-message" }, content: [{ type: "text", text: "通信正文" }] },
      },
    ];
    for (const includeAgentComm of [false, true]) {
      for (const tools of [false, true]) {
        for (const summary of [false, true]) {
          const options = showOptions({ includeAgentComm, tools, summary });
          const full = showMd(node([], events), options).content;
          const probe = showMd(node([], events), { ...options, probe: true }).content;
          assert.ok(probe.includes(`预计字节数：${Buffer.byteLength(full, "utf8")}`));
        }
      }
    }
  });

  it("范围筛选只统计范围内被排除的通信消息", () => {
    const events = [
      {
        type: "user/message",
        seq: 1,
        data: { source: { kind: "agent-message" }, content: [{ type: "text", text: "outside" }] },
      },
      {
        type: "user/message",
        seq: 2,
        data: { source: { kind: "agent-message" }, content: [{ type: "text", text: "inside" }] },
      },
    ];
    const rendered = showMd(
      node([], events),
      showOptions({ seqRange: { from: 2, to: 2 } }),
    ).content;
    assert.equal(rendered.includes("inside"), false);
    assert.equal(rendered.includes("outside"), false);
    assert.equal(rendered.includes("已排除 1 条与其它 agent 的通信"), true);
    assert.equal(rendered.includes("已排除 2 条与其它 agent 的通信"), false);
  });

  it("父子孙节点按各自 header 与事件过滤，fork 不继承父节点任务身份", () => {
    const task = (text: string) => ({
      type: "user/message",
      seq: 1,
      data: { source: { kind: "user" }, content: [{ type: "text", text }] },
    });
    const assistant = (text: string) => ({
      type: "assistant/message",
      seq: 2,
      data: { message: { content: [{ type: "text", text }] } },
    });
    const childNode = (
      name: string,
      origin: string | undefined,
      children: SessionNode[],
    ): SessionNode => {
      const base = node(children, [task(`${name}-task`), assistant(`${name}-reply`)]);
      return {
        ...base,
        file: {
          ...base.file,
          decoded: { ...base.file.decoded, header: { ...base.file.decoded.header, origin } },
        },
      };
    };
    const grandchild = childNode("grand", "subagent", []);
    const fork = childNode("fork", undefined, [grandchild]);
    const child = childNode("child", "subagent", [fork]);
    const root = childNode("root", undefined, [child]);
    const hidden = showMd(root, showOptions({ subagents: true })).content;
    for (const text of ["root-task", "root-reply", "fork-task", "fork-reply"])
      assert.ok(hidden.includes(text));
    for (const text of ["child-task", "child-reply", "grand-task", "grand-reply"])
      assert.equal(hidden.includes(text), false);
    assert.equal(hidden.split("已排除 2 条与其它 agent 的通信").length - 1, 2);
    const included = showMd(root, showOptions({ subagents: true, includeAgentComm: true })).content;
    for (const text of ["child-task", "child-reply", "grand-task", "grand-reply"])
      assert.ok(included.includes(text));
    assert.equal(included.includes("与其它 agent 的通信（--include-agent-comm 显示）"), false);
  });

  it("同一助手事件的正文与推理分别参与首尾截取", () => {
    const events = [RENDER_EVENTS[2]];
    const head = showMd(node([], events), showOptions({ thinking: true, head: 1 })).content;
    const tail = showMd(node([], events), showOptions({ thinking: true, tail: 1 })).content;
    assert.equal(head.includes("**助手**：\n\n```text\n助手内容 ASSIST-TEXT\n```"), true);
    assert.equal(head.includes("**推理**"), false);
    assert.equal(tail.includes("**推理**：\n\n```text\n推理内容 THINK-TEXT\n```"), true);
    assert.equal(tail.includes("**助手**"), false);
    assert.equal(head.includes("显示 1 条时间线条目"), true);
    assert.equal(tail.includes("显示 1 条时间线条目"), true);
  });

  it("默认可见性：正文经围栏承载、推理/工具/事件隐藏并给出摘要", () => {
    const rendered = showMd(node(), showOptions());
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
    const rendered = showMd(
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
    const rendered = showMd(node(), showOptions({ role: "user", truncate: 4 }));
    assert.equal(rendered.content.includes("```text\n用户内容…\n```"), true);
    assert.equal(rendered.content.includes("**助手**"), false);
    assert.equal(rendered.content.includes("已按 --role user 过滤对话消息"), true);
    assert.equal(rendered.content.includes("文本已截断为 4 字符"), true);
  });

  it("覆盖声明：show 的 md 自证边界，--probe 不含", () => {
    const rendered = showMd(node(), showOptions());
    assert.equal(rendered.content.includes("扫描会话 1 个；纳入 1 个；排除 0 个"), true);
    const probe = showMd(node(), showOptions({ probe: true }));
    assert.equal(probe.content.includes("扫描会话"), false);
  });

  it("归属未知：逐条声明且不计入 N/M/K", () => {
    const rendered = showMd(
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
        data: { role: "user", content: [{ type: "text", text: long }], source: { kind: "user" } },
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
    const full = showMd(node([], outlineEvents), showOptions({ summary: true }));
    assert.equal(full.content.includes(long), true);
    assert.equal(full.content.includes("…"), false);
    const cut = showMd(node([], outlineEvents), showOptions({ summary: true, truncate: 8 }));
    assert.equal(cut.content.includes(`${"超".repeat(8)}…`), true);
    assert.equal(cut.content.includes(long), false);
  });

  it("--summary 输出轮次大纲", () => {
    const rendered = showMd(node(), showOptions({ summary: true }));
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
    const rendered = showMd(node([child]), showOptions({ subagents: true }));
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
        data: {
          role: "user",
          content: [{ type: "text", text: "a\n```\nb" }],
          source: { kind: "user" },
        },
      },
      {
        type: "user/message",
        seq: 1,
        time: 11,
        data: {
          role: "user",
          content: [{ type: "text", text: "x ```` y" }],
          source: { kind: "user" },
        },
      },
    ];
    const rendered = showMd(node([], events), showOptions());
    assert.equal(rendered.content.includes("````text\na\n```\nb\n````"), true);
    assert.equal(rendered.content.includes("`````text\nx ```` y\n`````"), true);
  });

  it("MD014 中和：全 $ 载荷末尾追加空格行；制表符归一化", () => {
    const events: Record<string, unknown>[] = [
      {
        type: "user/message",
        seq: 0,
        time: 10,
        data: {
          role: "user",
          content: [{ type: "text", text: "$ ls\n$ pwd" }],
          source: { kind: "user" },
        },
      },
      {
        type: "user/message",
        seq: 1,
        time: 11,
        data: { role: "user", content: [{ type: "text", text: "a\tb" }], source: { kind: "user" } },
      },
    ];
    const rendered = showMd(node([], events), showOptions());
    assert.equal(rendered.content.includes("```text\n$ ls\n$ pwd\n \n```"), true);
    assert.equal(rendered.content.includes("```text\na    b\n```"), true);
  });

  it("空事件节点：轮次大纲为空、KV 规模行为零", () => {
    const rendered = showMd(node([], []), showOptions({ summary: true }));
    assert.equal(rendered.content.includes("## 轮次大纲\n\n无"), true);
    assert.match(rendered.content, /规模：.*；0 事件/u);
  });
});

describe("renderShowMd 的问答条目", () => {
  it("工具原始条目与问答条目独立截取，完整输出保持顺序和计数", () => {
    for (const [seq, first, second] of [
      [2, "**工具调用**", "**提问**"],
      [3, "**工具结果**", "**回答**"],
    ] as const) {
      const base = { tools: true, seqRange: { from: seq, to: seq } };
      const full = showMd(node([], askSamplePaired()), showOptions(base)).content;
      const head = showMd(node([], askSamplePaired()), showOptions({ ...base, head: 1 })).content;
      const tail = showMd(node([], askSamplePaired()), showOptions({ ...base, tail: 1 })).content;
      assert.ok(full.indexOf(first) >= 0 && full.indexOf(first) < full.indexOf(second));
      assert.equal(full.includes("显示 2 条时间线条目"), true);
      assert.equal(head.includes(first), true);
      assert.equal(head.includes(second), false);
      assert.equal(tail.includes(first), false);
      assert.equal(tail.includes(second), true);
      for (const content of [head, tail]) {
        assert.equal(content.includes("显示 1 条时间线条目"), true);
        assert.equal(content.split("```text\n").length - 1, 1);
        assert.equal(content.split("\n```\n").length - 1, 1);
      }
    }
  });

  it("默认可见（不需要 --tools），且不计入隐藏的工具条目数", () => {
    const rendered = showMd(node([], askSamplePaired()), showOptions());
    assertDocumentShape(rendered.content);
    // 载体内容与抽取同源：逐题的三部分与逐条的 id/选择/自定义/未作答都在围栏里。
    assert.equal(rendered.content.includes("**提问**：\n\n```text"), true);
    assert.equal(rendered.content.includes("**回答**：\n\n```text"), true);
    assert.equal(rendered.content.includes("[1] 确认事项 `x`（id：ask_one）"), true);
    assert.equal(rendered.content.includes("问题：题干含 **bold text** 与制表符    a"), true);
    assert.equal(
      rendered.content.includes("选项：选项 A｜说明 A；见 https://example.com/path"),
      true,
    );
    assert.equal(rendered.content.includes("[1] id：ask_one\n选择：选项 A"), true);
    assert.equal(rendered.content.includes("[2] id：ask_three\n未作答"), true);
    // 问答条目是"提问与回答"，不是被隐藏的工具条目：摘要行不得把它们算进工具计数
    // （生命周期事件的隐藏计数仍照常出现，因此只断言工具那一段不出现）。
    assert.equal(rendered.content.includes("工具调用/结果"), false);
    // 原始工具条目仍按 --tools 隐藏，因此两条问答事件都不额外产出工具条目。
    assert.equal(rendered.content.includes("**工具调用**"), false);
    assert.equal(rendered.content.includes("**工具结果**"), false);
  });

  it("--tools 打开时同一事件同时以原始工具条目与问答条目出现", () => {
    const rendered = showMd(node([], askSamplePaired()), showOptions({ tools: true }));
    assert.equal(rendered.content.includes("**工具调用**（`ask_user_question`）"), true);
    assert.equal(rendered.content.includes("**工具结果**"), true);
    assert.equal(rendered.content.includes("**提问**"), true);
    assert.equal(rendered.content.includes("**回答**"), true);
  });

  it("--role 不影响问答条目（与工具、事件一致）", () => {
    for (const role of ["user", "assistant"] as const) {
      const rendered = showMd(node([], askSamplePaired()), showOptions({ role }));
      assert.equal(rendered.content.includes("**提问**"), true, role);
      assert.equal(rendered.content.includes("**回答**"), true, role);
      // 前置的用户消息则按 --role 正常过滤（role=user 时保留，role=assistant 时消失）。
      assert.equal(rendered.content.includes("问答夹具提问前置"), role === "user");
    }
  });

  it("仍受 --seq 范围选择影响", () => {
    const all = showMd(node([], askSamplePaired()), showOptions());
    assert.equal(all.content.includes("**提问**"), true);
    // 提问在 seq 2/4、回答在 seq 3/5：只留 seq 0-1 时两类条目都消失。
    const narrowed = showMd(
      node([], askSamplePaired()),
      showOptions({ seqRange: { from: 0, to: 1 } }),
    );
    assert.equal(narrowed.content.includes("**提问**"), false);
    assert.equal(narrowed.content.includes("**回答**"), false);
    assert.equal(narrowed.content.includes("筛选：seq 0-1；显示 1 条时间线条目"), true);
  });

  it("仍受 --head 条目截取影响（按条目而不是按事件截取）", () => {
    const rendered = showMd(node([], askSamplePaired()), showOptions({ head: 1 }));
    assert.equal(rendered.content.includes("筛选：首 1 条；显示 1 条时间线条目"), true);
    // 首条是前置用户消息，因此两条问答条目都不在产物里。
    assert.equal(rendered.content.includes("**提问**"), false);
    const tail = showMd(node([], askSamplePaired()), showOptions({ tail: 2 }));
    assert.equal(tail.content.includes("筛选：末 2 条；显示 2 条时间线条目"), true);
    assert.equal(tail.content.includes("**提问**"), true);
    assert.equal(tail.content.includes("**回答**"), true);
  });

  it("未配对提问照常呈现；错误态结果只呈现提问", () => {
    const unpaired = showMd(node([], askSampleUnpaired()), showOptions());
    assert.equal(unpaired.content.includes("**提问**"), true);
    assert.equal(unpaired.content.includes("**回答**"), false);
    // 未配对的提问自己是默认可见的问答条目，不计入隐藏的工具条目数。
    assert.equal(unpaired.content.includes("工具调用/结果"), false);

    const errored = showMd(node([], askSampleErrorResult()), showOptions());
    assert.equal(errored.content.includes("**提问**"), true);
    assert.equal(errored.content.includes("**回答**"), false);
    // 错误态是显式字段，不是载荷异常：不产出回答条目，也不标注为异常。
    assert.equal(errored.content.includes("- 异常："), false);
    // 错误态结果本身就是一个普通工具结果：默认隐藏且照常计数；要核对某个提问为何没有回答，
    // 就用 --tools 看它的结果条目（错误态在那里显式标注）。
    assert.equal(errored.content.includes("已隐藏 1 条工具调用/结果（--tools 显示）"), true);
    const withTools = showMd(node([], askSampleErrorResult()), showOptions({ tools: true }));
    assert.equal(withTools.content.includes("**工具结果**（错误）"), true);
    assert.equal(withTools.content.includes("**回答**"), false);
  });

  it("--summary 视图不输出问答条目", () => {
    const rendered = showMd(node([], askSamplePaired()), showOptions({ summary: true }));
    assert.equal(rendered.content.includes("## 轮次大纲"), true);
    assert.equal(rendered.content.includes("**提问**"), false);
    assert.equal(rendered.content.includes("**回答**"), false);
  });
  it("--probe 保留字节规模且不输出问答数", () => {
    const paired = showMd(node([], askSamplePaired()), showOptions({ probe: true }));
    assert.equal(paired.content.includes("- 问答数："), false);
    assert.equal(paired.content.includes("时间线"), false);
    const unpaired = showMd(node([], askSampleUnpaired()), showOptions({ probe: true }));
    assert.equal(unpaired.content.includes("- 预计字节数："), true);
    const errored = showMd(node([], askSampleErrorResult()), showOptions({ probe: true }));
    assert.equal(errored.content.includes("- 问答数："), false);
  });

  it("载荷结构不符时整体失败（不产出任何降级内容）", () => {
    const rendered = renderShowMd(node([], askSampleMalformed()), showOptions());
    assert.equal(rendered.success, false);
    if (rendered.success) return;
    assert.equal(rendered.error.includes("提问事件"), true);
    // 子代理块里的结构不符同样必须上抛，而不是让根块照常产出。
    const child: SessionNode = {
      entry: { ...sessionEntry(), id: "cafe1111-2222-3333-4444-555566667777" },
      file: decodedFile(askSampleMalformed()),
      children: [],
    };
    const withSubagents = renderShowMd(node([child]), showOptions({ subagents: true }));
    assert.equal(withSubagents.success, false);
  });
});

describe("renderShowMd 的工具结果错误态", () => {
  it("只写 message.isError 的结果必须标为（错误）", () => {
    // 真实日志里普通工具失败只写 `message.isError: true`、没有 `data.error`（见 fixtures.ts 的
    // `toolResultIsErrorOnlyEvent`）。只认 `data.error` 的实现会把这类结果渲染成普通工具结果，
    // 而它的正文正是 `Error: …`，调用方据标签判断"这次调用是否成功"时会读反。
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
    const rendered = showMd(node([], events), showOptions({ tools: true }));
    assert.equal(rendered.content.includes("**工具结果**（错误）："), true);
    // 正文经 `<dsh-result …>` 信封剥离后只剩错误文本，信封本身不得进入产物。
    assert.equal(
      rendered.content.includes("```text\nError: old_string and new_string must differ\n```"),
      true,
    );
    assert.equal(rendered.content.includes("<dsh-result"), false);
  });

  it("判据只看字段：信封起点写 is-error 而 message.isError 为 false 时不算错误态", () => {
    // 写入侧的信封属性是给模型看的标注，不是判据。若实现改为读标记文本，这条会失败，
    // 那正是"按文本匹配判定语义"的退化形态。
    const events: Record<string, unknown>[] = [
      { type: "turn/start", seq: 0, time: 10, data: { turn: 1 } },
      {
        type: "tool/result",
        seq: 1,
        time: 11,
        data: {
          message: {
            role: "tool",
            source: { kind: "tool", callId: "call-text-1" },
            toolCallId: "call-text-1",
            isError: false,
            content: [
              {
                type: "text",
                text: '<dsh-result tool="edit" call="call-text-1" is-error="true">\n正文\n</dsh-result>',
              },
            ],
          },
        },
        surfaceOp: "append",
      },
      { type: "turn/end", seq: 2, time: 12, data: { turn: 1 } },
    ];
    const rendered = showMd(node([], events), showOptions({ tools: true }));
    assert.equal(rendered.content.includes("**工具结果**："), true);
    assert.equal(rendered.content.includes("（错误）"), false);
  });

  it("三个消费面结论一致：md 标签、json isError 与问答的错误态处理", () => {
    // 同一事件在三条路径上必须给出同一答案：md 的标签、json 的字段、问答条目是否产出。
    // 三面各写一份判据时，最典型的漂移就是"md 标了错误、json 说 false"（本技能实际出现过）。
    const events: Record<string, unknown>[] = [
      { type: "turn/start", seq: 0, time: 10, data: { turn: 1 } },
      askQuestionEvent(1, 11, "call-consistency-1", [{ id: "q1", header: "H", question: "Q" }]),
      toolResultIsErrorOnlyEvent(2, 12, "call-consistency-1", "Error: old_string must differ"),
      { type: "turn/end", seq: 3, time: 13, data: { turn: 1 } },
    ];
    const md = showMd(node([], events), showOptions({ tools: true }));
    assert.equal(md.content.includes("**工具结果**（错误）："), true);

    const document = JSON.parse(
      renderShowJson(node([], events), {
        summary: false,
        includeAgentComm: false,
        subagents: false,
        unattributable: [],
      }).content,
    ) as { messages: Array<{ type: string; isError?: boolean }> };
    const resultEntry = document.messages.find((message) => message.type === "tool/result");
    assert.equal(resultEntry?.isError, true);

    const analysis = analyzeAskUserEvents(events);
    assert.equal(analysis.success, true);
    if (!analysis.success) return;
    assert.deepEqual(
      analysis.data.entries.map((entry) => entry.label),
      [ASK_USER_QUESTION_LABEL],
    );
    assert.equal(analysis.data.entries[0].event.seq, 1);
  });
});
