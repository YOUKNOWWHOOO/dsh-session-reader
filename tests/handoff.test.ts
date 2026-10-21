// 交接抽取单元测试：判定口径、结构事实的逐行格式、结构字段缺失时的空值契约，
// 以及"不复制交接正文"这一设计约束（正文由相邻 assistant/message 承载）。
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

/** assistant 消息（交接正文的承载事件）。 */
function assistantEvent(seq: number, text: string): EventRecord {
  return ev("assistant/message", seq, {
    role: "assistant",
    message: { role: "assistant", id: `m-${seq}`, content: [{ type: "text", text }] },
  });
}

/** 投递事件（`agent/inbox/spliced`）。 */
function splicedEvent(seq: number, target: string): EventRecord {
  return ev("agent/inbox/spliced", seq, {
    target,
    start: 0,
    inserted: [
      {
        role: "user",
        id: `m-${seq}`,
        source: { kind: "user" },
        content: [{ type: "text", text: "<compacted-summary>\n正文\n</compacted-summary>" }],
      },
    ],
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
      ["轮次 3／步 7", "历史替换 seq 2-10（3 条事件）", "投递 -；正文 -"].join("\n"),
    );
  });

  it("相邻 assistant/message 给出正文定位（seq 与码点字符数）", () => {
    const body = "交接正文 BODY";
    const assistant = assistantEvent(1, body);
    const handoff = handoffEvent(2, 1, 1);
    const entries = analyzeHandoffEvents([assistant, handoff]).entries;
    const entry = entries.get(handoff);
    assert.notEqual(entry, undefined);
    assert.equal(
      entry?.structure.endsWith(`投递 -；正文 seq 1（${String([...body].length)} 字符）`),
      true,
    );
    // 正文不复制：条目只带结构事实，body 为空串。
    assert.equal(entry?.body, "");
  });

  it("相邻 agent/inbox/spliced 给出投递目标", () => {
    const handoff = handoffEvent(2, 1, 1);
    const entries = analyzeHandoffEvents([handoff, splicedEvent(3, "next-step")]).entries;
    assert.equal(entries.get(handoff)?.structure.endsWith("投递 next-step；正文 -"), true);
  });

  it("三段式完整时同时给出投递目标与正文定位", () => {
    const assistant = assistantEvent(1, "正文");
    const handoff = handoffEvent(2, 5, 2);
    const entries = analyzeHandoffEvents([
      assistant,
      handoff,
      splicedEvent(3, "next-turn"),
    ]).entries;
    const entry = entries.get(handoff);
    assert.equal(entry?.structure.startsWith("轮次 5／步 2\n"), true);
    assert.equal(entry?.structure.endsWith(`（${String([..."正文"].length)} 字符）`), true);
    assert.equal(entry?.structure.includes("投递 next-turn；正文 seq 1"), true);
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

  it("前驱不是 assistant/message 时不把更早的普通回答冒充为正文", () => {
    const earlier = assistantEvent(1, "更早的回答");
    const middle = ev("system/message", 2, {
      message: { role: "system", id: "m-2", content: [{ type: "text", text: "系统" }] },
    });
    const handoff = handoffEvent(3, 1, 1);
    const entries = analyzeHandoffEvents([earlier, middle, handoff]).entries;
    assert.equal(entries.get(handoff)?.structure.endsWith("投递 -；正文 -"), true);
  });

  it("message.content 非空时作为 body 返回，不混进结构事实", () => {
    const handoff = ev("developer/message", 2, {
      turn: 1,
      step: 1,
      message: {
        role: "developer",
        id: "m-2",
        source: { kind: HANDOFF_SOURCE_KIND },
        content: [{ type: "text", text: "交接正文 INLINE" }],
      },
    });
    const entry = analyzeHandoffEvents([handoff]).entries.get(handoff);
    assert.equal(entry?.body, "交接正文 INLINE");
    assert.equal(entry?.structure.includes("INLINE"), false);
  });

  it("非交接事件不产生条目", () => {
    const entries = analyzeHandoffEvents([
      ev("user/message", 0, { role: "user", content: [], source: { kind: "user" } }),
      assistantEvent(1, "正文"),
      splicedEvent(3, "next-step"),
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
      analyzeHandoffEvents([assistant, handoff]).entries.get(handoff)?.structure.endsWith("正文 -"),
      true,
    );
  });

  it("投递事件的 target 缺失或不是字符串时显示空值 -", () => {
    const handoff = handoffEvent(2, 1, 1);
    const numericTarget = ev("agent/inbox/spliced", 3, { target: 42, start: 0, inserted: [] });
    assert.equal(
      analyzeHandoffEvents([handoff, numericTarget])
        .entries.get(handoff)
        ?.structure.includes("投递 -"),
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

  it("content 不是数组时 body 为空串", () => {
    const handoff = ev("developer/message", 2, {
      turn: 1,
      step: 1,
      message: {
        role: "developer",
        id: "m-2",
        source: { kind: HANDOFF_SOURCE_KIND },
        content: "文本",
      },
    });
    assert.equal(analyzeHandoffEvents([handoff]).entries.get(handoff)?.body, "");
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
