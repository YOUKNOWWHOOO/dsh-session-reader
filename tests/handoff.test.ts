// 交接抽取单元测试：判定口径、三行结构事实（含前置助手消息与交接通知定位）、结构字段缺失时的
// 空值契约，以及"交接条目不承载正文"这一设计约束（紧邻其前的助手回复按普通助手消息呈现）。
//
// 事件构造：本文件只用记录级合成事件（`EventRecord`），因为交接抽取是纯函数、不依赖日志写入侧；
// 需要经真实解码路径验证的行为在 handoff-cli.test.ts 里用合成 DSH_HOME 覆盖。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventRecord } from "../scripts/lib/decode.ts";
import {
  analyzeHandoffEvents,
  HANDOFF_LABEL,
  HANDOFF_SOURCE_KIND,
  isHandoffEvent,
} from "../scripts/lib/handoff.ts";

/** 记录级合成事件。 */
function ev(
  type: string,
  seq: number,
  data: Record<string, unknown>,
  extra?: Record<string, unknown>,
): EventRecord {
  return { type, seq, time: 1000 + seq, data, ...extra };
}

/** 交接事件（正文为空，与当期插件写入形态一致）。 */
function handoffEvent(
  seq: number,
  turn: number,
  step: number,
  extra?: Record<string, unknown>,
): EventRecord {
  return ev(
    "developer/message",
    seq,
    {
      turn,
      step,
      message: {
        role: "developer",
        id: `m-${seq}`,
        source: { kind: HANDOFF_SOURCE_KIND },
        content: [],
      },
    },
    {
      surfaceOp: { op: "replace", startSeq: 2, endSeq: 10 },
      sourceEventSeqs: [2, 5, 10],
      ...extra,
    },
  );
}

/** assistant 消息（普通助手回复）。 */
function assistantEvent(seq: number, text: string): EventRecord {
  return ev("assistant/message", seq, {
    role: "assistant",
    message: { role: "assistant", id: `m-${seq}`, content: [{ type: "text", text }] },
  });
}

/**
 * 部署侧注入起点（形态取自 `preset-lib/injection-boundary.mjs`：起点单独成行，正文另起一行）。
 *
 * 文件式交接的两条协议消息都由交接插件自己包裹，来源为 `handoff`；`kind` 是判定合成条目的
 * 结构锚点，本文件的用例据此区分维护指令与压缩通知。
 */
function injectionText(kind: string, text: string): string {
  const ts = "2026-10-31T12:44:50+08:00";
  return `<dsh-injection kind="${kind}" src="handoff" id="abcdef12" ts="${ts}">\n${text}\n</dsh-injection>`;
}

/** 文件式交接的维护指令消息（来源 `handoff`）。 */
function instructionEvent(seq: number, text: string): EventRecord {
  return ev("user/message", seq, {
    role: "user",
    content: [{ type: "text", text: injectionText("handoff-instruction", text) }],
    source: { kind: HANDOFF_SOURCE_KIND },
  });
}

/** 文件式交接的压缩通知消息（来源 `handoff`）。 */
function noticeEvent(seq: number, text: string): EventRecord {
  return ev("user/message", seq, {
    role: "user",
    content: [{ type: "text", text: injectionText("context-compacted", text) }],
    source: { kind: HANDOFF_SOURCE_KIND },
  });
}

describe("isHandoffEvent 判定", () => {
  it("developer/message 且来源种类为 handoff 时命中", () => {
    assert.equal(isHandoffEvent(handoffEvent(2, 1, 1)), true);
  });

  it("developer/message 但来源种类不是 handoff 时不命中", () => {
    const event = ev("developer/message", 2, {
      turn: 1,
      step: 1,
      message: { role: "developer", id: "m-2", source: { kind: "tool-registry" }, content: [] },
    });
    assert.equal(isHandoffEvent(event), false);
  });

  it("user/message 即使来源种类为 handoff 也不命中", () => {
    const event = ev("user/message", 2, {
      role: "user",
      content: [{ type: "text", text: "正文" }],
      source: { kind: HANDOFF_SOURCE_KIND },
    });
    assert.equal(isHandoffEvent(event), false);
  });

  it("缺少 message 或 source 时不命中，且不抛错", () => {
    assert.equal(isHandoffEvent(ev("developer/message", 2, { turn: 1 })), false);
    assert.equal(
      isHandoffEvent(ev("developer/message", 3, { message: { role: "developer", id: "m-3" } })),
      false,
    );
    assert.equal(
      isHandoffEvent(
        ev("developer/message", 4, { message: { role: "developer", id: "m-4", source: {} } }),
      ),
      false,
    );
  });
});

describe("analyzeHandoffEvents 结构事实", () => {
  it("给出轮次、步、替换区间与被替换事件数", () => {
    const handoff = handoffEvent(2, 3, 7);
    const entries = analyzeHandoffEvents([handoff]).entries;
    const entry = entries.get(handoff);
    assert.notEqual(entry, undefined);
    assert.equal(
      entry?.structure,
      ["轮次 3／步 7", "历史替换 seq 2-10（3 条事件）", "前置助手消息 -；交接通知 -"].join("\n"),
    );
  });

  it("紧邻其前的 assistant/message 给出前置助手消息定位（seq 与码点字符数）", () => {
    const body = "助手回复 BODY";
    const assistant = assistantEvent(1, body);
    const handoff = handoffEvent(2, 1, 1);
    const entries = analyzeHandoffEvents([assistant, handoff]).entries;
    const entry = entries.get(handoff);
    assert.notEqual(entry, undefined);
    assert.equal(
      entry?.structure.endsWith(
        `前置助手消息 seq 1（${String([...body].length)} 字符）；交接通知 -`,
      ),
      true,
    );
    // 条目不承载正文：`body` 字段已随旧摘要投递一并删除。
    assert.equal(Object.hasOwn(entry ?? {}, "body"), false);
  });

  it("前置助手消息带消息信封时定位按剥净后的正文计字符数", () => {
    // 部署侧给助手消息套了 `<dsh-message>`；字符数必须按剥离后的正文计，否则回溯坐标会带上信封长度。
    const body = "助手回复 BODY";
    const open = '<dsh-message role="assistant" id="abcdef12" ts="2026-10-29T22:59:57+08:00">';
    const assistant = assistantEvent(1, `${open}\n${body}\n</dsh-message>`);
    const handoff = handoffEvent(2, 1, 1);
    const entry = analyzeHandoffEvents([assistant, handoff]).entries.get(handoff);
    assert.notEqual(entry, undefined);
    assert.equal(
      entry?.structure.endsWith(
        `前置助手消息 seq 1（${String([...body].length)} 字符）；交接通知 -`,
      ),
      true,
    );
  });

  it("识别到交接通知时第三行给出通知 seq", () => {
    const body = "正文";
    const assistant = assistantEvent(1, body);
    const handoff = handoffEvent(2, 5, 2);
    const notice = noticeEvent(4, "通知正文");
    const entry = analyzeHandoffEvents([assistant, handoff, notice]).entries.get(handoff);
    assert.equal(entry?.structure.startsWith("轮次 5／步 2\n"), true);
    assert.equal(
      entry?.structure.endsWith(
        `前置助手消息 seq 1（${String([...body].length)} 字符）；交接通知 seq 4`,
      ),
      true,
    );
  });

  it("surfaceOp 不是 replace 时替换区间显示空值 -", () => {
    const handoff = handoffEvent(2, 1, 1, { surfaceOp: "append" });
    assert.equal(
      analyzeHandoffEvents([handoff]).entries.get(handoff)?.structure.includes("历史替换 -"),
      true,
    );
  });

  it("surfaceOp 缺失时替换区间显示空值 -", () => {
    const handoff = ev("developer/message", 2, {
      turn: 1,
      step: 1,
      message: { role: "developer", id: "m-2", source: { kind: HANDOFF_SOURCE_KIND }, content: [] },
    });
    assert.equal(
      analyzeHandoffEvents([handoff]).entries.get(handoff)?.structure.includes("历史替换 -"),
      true,
    );
  });

  it("turn 或 step 缺失时逐项显示空值 -", () => {
    const handoff = ev("developer/message", 2, {
      message: { role: "developer", id: "m-2", source: { kind: HANDOFF_SOURCE_KIND }, content: [] },
    });
    assert.equal(
      analyzeHandoffEvents([handoff]).entries.get(handoff)?.structure.startsWith("轮次 -／步 -"),
      true,
    );
  });

  it("前驱不是 assistant/message 时前置助手消息显示空值，禁止向前搜索更早回答", () => {
    const earlier = assistantEvent(1, "更早的回答");
    const middle = ev("system/message", 2, {
      message: { role: "system", id: "m-2", content: [{ type: "text", text: "系统" }] },
    });
    const handoff = handoffEvent(3, 1, 1);
    const entries = analyzeHandoffEvents([earlier, middle, handoff]).entries;
    assert.equal(entries.get(handoff)?.structure.endsWith("前置助手消息 -；交接通知 -"), true);
  });

  it("交接事件自身的内容不进入结构事实，条目不携带正文", () => {
    const handoff = ev("developer/message", 2, {
      turn: 1,
      step: 1,
      message: {
        role: "developer",
        id: "m-2",
        source: { kind: HANDOFF_SOURCE_KIND },
        content: [{ type: "text", text: "助手回复 INLINE" }],
      },
    });
    const entry = analyzeHandoffEvents([handoff]).entries.get(handoff);
    assert.equal(entry?.structure.includes("INLINE"), false);
    assert.equal(entry?.structure.split("\n").length, 3);
    assert.equal(Object.hasOwn(entry ?? {}, "body"), false);
  });

  it("非交接事件不产生条目", () => {
    const entries = analyzeHandoffEvents([
      ev("user/message", 0, { role: "user", content: [], source: { kind: "user" } }),
      assistantEvent(1, "正文"),
      ev("agent/inbox/spliced", 3, { target: "next-step", start: 0, inserted: [] }),
    ]).entries;
    assert.equal(entries.size, 0);
  });

  it("sourceEventSeqs 缺失时只给区间不给条数", () => {
    const handoff = ev(
      "developer/message",
      2,
      {
        turn: 1,
        step: 1,
        message: {
          role: "developer",
          id: "m-2",
          source: { kind: HANDOFF_SOURCE_KIND },
          content: [],
        },
      },
      { surfaceOp: { op: "replace", startSeq: 2, endSeq: 10 } },
    );
    assert.equal(
      analyzeHandoffEvents([handoff])
        .entries.get(handoff)
        ?.structure.includes("历史替换 seq 2-10（-）"),
      true,
    );
  });

  it("surfaceOp 为 replace 但缺少区间端点时显示空值 -", () => {
    const handoff = ev(
      "developer/message",
      2,
      {
        turn: 1,
        step: 1,
        message: {
          role: "developer",
          id: "m-2",
          source: { kind: HANDOFF_SOURCE_KIND },
          content: [],
        },
      },
      { surfaceOp: { op: "replace" }, sourceEventSeqs: [2] },
    );
    assert.equal(
      analyzeHandoffEvents([handoff]).entries.get(handoff)?.structure.includes("历史替换 -"),
      true,
    );
  });

  it("surfaceOp 不是对象时按空值处理，不抛错", () => {
    const handoff = ev(
      "developer/message",
      2,
      {
        turn: 1,
        step: 1,
        message: {
          role: "developer",
          id: "m-2",
          source: { kind: HANDOFF_SOURCE_KIND },
          content: [],
        },
      },
      { surfaceOp: ["replace"], sourceEventSeqs: [2] },
    );
    assert.equal(
      analyzeHandoffEvents([handoff]).entries.get(handoff)?.structure.includes("历史替换 -"),
      true,
    );
  });

  it("前驱 assistant 消息缺少 seq 时不给出错误的正文定位", () => {
    const assistant: EventRecord = {
      type: "assistant/message",
      time: 1001,
      data: {
        role: "assistant",
        message: { role: "assistant", id: "m-1", content: [{ type: "text", text: "正文" }] },
      },
    };
    const handoff = handoffEvent(2, 1, 1);
    assert.equal(
      analyzeHandoffEvents([assistant, handoff])
        .entries.get(handoff)
        ?.structure.endsWith("前置助手消息 -；交接通知 -"),
      true,
    );
  });

  it("来源种类的 kind 不是字符串时不命中", () => {
    const event = ev("developer/message", 2, {
      message: { role: "developer", id: "m-2", source: { kind: 7 }, content: [] },
    });
    assert.equal(isHandoffEvent(event), false);
  });

  it("message 不是对象时不命中", () => {
    const event = ev("developer/message", 2, { message: ["handoff"] });
    assert.equal(isHandoffEvent(event), false);
  });

  it("turn 与 step 不是数字时逐项显示空值 -", () => {
    const handoff = ev("developer/message", 2, {
      turn: "一",
      step: null,
      message: { role: "developer", id: "m-2", source: { kind: HANDOFF_SOURCE_KIND }, content: [] },
    });
    assert.equal(
      analyzeHandoffEvents([handoff]).entries.get(handoff)?.structure.startsWith("轮次 -／步 -"),
      true,
    );
  });

  it("标签取值为对外契约的 交接", () => {
    assert.equal(HANDOFF_LABEL, "交接");
  });
});

describe("文件式交接的压缩通知", () => {
  const NOTICE = "本会话刚才发生了上下文压缩，你是接续会话。NOTICE-MARK";

  it("按来源 handoff 与注入起点的 kind 认定，正文剥离注入信封", () => {
    const handoff = handoffEvent(2, 1, 1);
    const notice = noticeEvent(4, NOTICE);
    const analysis = analyzeHandoffEvents([
      handoff,
      ev("agent/inbox/spliced", 3, { target: "next-step", start: 0, inserted: [] }),
      notice,
    ]);
    const found = analysis.notices.get(handoff);
    assert.notEqual(found, undefined);
    assert.equal(found?.event, notice);
    assert.equal(found?.text, NOTICE);
    assert.equal(found?.text.includes("<dsh-injection"), false);
  });

  it("先遇到真实用户消息时不再认定通知，禁止跨轮误认", () => {
    const handoff = handoffEvent(1, 1, 1);
    const real = ev("user/message", 2, {
      role: "user",
      content: [{ type: "text", text: "用户自己插话" }],
      source: { kind: "user" },
    });
    const analysis = analyzeHandoffEvents([handoff, real, noticeEvent(3, NOTICE)]);
    assert.equal(analysis.notices.size, 0);
  });

  it("扫描在下一条交接事件处停止", () => {
    const first = handoffEvent(1, 1, 1);
    const second = handoffEvent(7, 2, 1);
    const analysis = analyzeHandoffEvents([
      first,
      noticeEvent(2, NOTICE),
      ev("agent/inbox/spliced", 6, { target: "next-step", start: 0, inserted: [] }),
      second,
    ]);
    assert.equal(analysis.notices.size, 1);
    assert.equal(analysis.notices.has(first), true);
    assert.equal(analysis.notices.has(second), false);
  });

  it("来源同为 handoff 但 kind 不是 context-compacted 时不认定通知", () => {
    const handoff = handoffEvent(1, 1, 1);
    const analysis = analyzeHandoffEvents([handoff, instructionEvent(2, "维护指令正文")]);
    assert.equal(analysis.notices.size, 0);
  });

  it("文件式交接不产生独立摘要投递，普通助手回复保留在助手条目", () => {
    const body = "维护完成说明 NEW-BODY";
    const instruction = instructionEvent(0, "维护指令 INSTRUCTION-MARK");
    const assistant = assistantEvent(1, body);
    const handoff = handoffEvent(2, 1, 1, {
      surfaceOp: { op: "replace", startSeq: 0, endSeq: 1 },
      sourceEventSeqs: [0, 1],
    });
    const analysis = analyzeHandoffEvents([
      instruction,
      assistant,
      handoff,
      ev("agent/inbox/spliced", 3, { target: "next-step", start: 0, inserted: [] }),
      noticeEvent(4, NOTICE),
    ]);
    // 旧摘要投递与助手副本抑制相关的字段已随旧自定义交接一并删除，不保留空集合或兼容别名。
    assert.equal(Object.hasOwn(analysis, "deliveries"), false);
    assert.equal(Object.hasOwn(analysis, "suppressedAssistantSeqs"), false);
    const entry = analysis.entries.get(handoff);
    assert.equal(
      entry?.structure.endsWith(
        `前置助手消息 seq 1（${String([...body].length)} 字符）；交接通知 seq 4`,
      ),
      true,
    );
    assert.equal(Object.hasOwn(entry ?? {}, "body"), false);
  });
});

describe("文件式交接的维护指令定位", () => {
  const INSTRUCTION = "从现在起，你唯一的任务是完成对交接文件的维护。INSTRUCTION-MARK";

  /** 多步生成中的一步：step/start → assistant（可带工具调用）→ 工具往返 → step/end。 */
  function stepEvents(seq: number, assistantText: string): EventRecord[] {
    return [
      ev("step/start", seq, { turn: 1, step: seq }),
      assistantEvent(seq + 1, assistantText),
      ev("tool/call", seq + 2, { callId: `c-${seq}`, name: "read", arguments: "{}" }),
      ev("tool/result", seq + 3, { message: { role: "tool", content: [] } }),
      ev("step/end", seq + 4, { turn: 1, step: seq }),
    ];
  }

  it("最终回复与维护指令之间隔着多步工具往返时仍能定位", () => {
    // 维护阶段可跨多步工具往返，最终回复不必与维护指令相邻；只看前一条事件会让
    // `**交接指令**` 永不出现。
    const instruction = instructionEvent(1, INSTRUCTION);
    const firstStep = stepEvents(2, "");
    const secondStep = stepEvents(7, "");
    const finalAssistant = assistantEvent(12, "维护完成说明 FINAL-BODY");
    const handoff = handoffEvent(13, 1, 3, {
      surfaceOp: { op: "replace", startSeq: 1, endSeq: 12 },
      sourceEventSeqs: [1, 12],
    });
    const analysis = analyzeHandoffEvents([
      ev("turn/start", 0, { turn: 1 }),
      instruction,
      ...firstStep,
      ...secondStep,
      finalAssistant,
      handoff,
      ev("agent/inbox/spliced", 14, { target: "next-step", start: 0, inserted: [] }),
      noticeEvent(15, "通知正文"),
    ]);
    const prompt = analysis.prompts.get(handoff);
    assert.notEqual(prompt, undefined);
    assert.equal(prompt?.event, instruction);
    assert.equal(prompt?.text, INSTRUCTION);
    // 多步之间的助手消息不因"不是最终回复"而影响维护指令的定位。
    assert.equal(analysis.prompts.size, 1);
  });

  it("向前扫描遇到上一个交接事件即停止，不把上一次的指令认成本次", () => {
    const instruction = instructionEvent(0, "第一次的维护指令");
    const firstAssistant = assistantEvent(1, "第一次正文");
    const firstHandoff = handoffEvent(2, 1, 1, {
      surfaceOp: { op: "replace", startSeq: 0, endSeq: 1 },
      sourceEventSeqs: [0, 1],
    });
    const secondAssistant = assistantEvent(3, "第二次正文");
    const secondHandoff = handoffEvent(4, 2, 1, {
      surfaceOp: { op: "replace", startSeq: 2, endSeq: 3 },
      sourceEventSeqs: [2, 3],
    });
    const analysis = analyzeHandoffEvents([
      instruction,
      firstAssistant,
      firstHandoff,
      secondAssistant,
      secondHandoff,
    ]);
    assert.equal(analysis.prompts.get(firstHandoff)?.event, instruction);
    assert.equal(analysis.prompts.has(secondHandoff), false);
  });

  it("不依赖助手正文候选链：交接事件缺少 surfaceOp 与 sourceEventSeqs 时仍定位维护指令", () => {
    // 维护指令的判据是从交接事件向回扫描到上一个交接边界，而不是从"生成正文"的位置回退。
    // 生成正文候选（surfaceOp.endSeq 与 sourceEventSeqs）缺失时，旧实现拿不到起点，`**交接指令**` 会消失。
    const instruction = instructionEvent(1, INSTRUCTION);
    const assistant = assistantEvent(2, "维护完成说明 FINAL-BODY");
    const handoff = handoffEvent(3, 1, 1, {
      surfaceOp: undefined,
      sourceEventSeqs: undefined,
    });
    const analysis = analyzeHandoffEvents([instruction, assistant, handoff]);
    assert.equal(analysis.prompts.get(handoff)?.event, instruction);
    assert.equal(analysis.prompts.get(handoff)?.text, INSTRUCTION);
  });

  it("来源为 user 的紧邻用户消息不再按旧结构位置认作维护指令", () => {
    const prompt = ev("user/message", 0, {
      role: "user",
      content: [{ type: "text", text: "从现在起，你唯一的任务是给出交接指令 PROMPT-MARK" }],
      source: { kind: "user" },
    });
    const assistant = assistantEvent(1, "普通助手正文");
    const handoff = handoffEvent(2, 1, 1, {
      surfaceOp: { op: "replace", startSeq: 0, endSeq: 1 },
      sourceEventSeqs: [0, 1],
    });
    assert.equal(analyzeHandoffEvents([prompt, assistant, handoff]).prompts.size, 0);
  });
});
