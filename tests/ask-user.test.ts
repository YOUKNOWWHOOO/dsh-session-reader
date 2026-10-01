// 问答抽取单元测试：判定与配对、可读文本的逐字段格式、错误态结果，以及载荷结构不符的各形态。
//
// 事件构造分工：所有**可写进日志**的形态都经 ./fixtures.ts 的问答构造器产出（与 CLI 集成测试、
// 全组合门禁共用同一份事件定义）；只有"字段类型不符"这类官方库在写入侧就会拒绝的形态，
// 才在本文件内以记录级合成事件覆盖——那类形态的真实来源是解码器之外的数据，无法用日志夹具表达。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASK_USER_ANSWER_LABEL,
  ASK_USER_QUESTION_LABEL,
  type AskUserAnalysis,
  analyzeAskUserEvents,
} from "../scripts/lib/ask-user.ts";
import type { EventRecord } from "../scripts/lib/decode.ts";
import {
  askAnswerEvent,
  askErrorResultEvent,
  askQuestionEvent,
  askQuestionRawEvent,
} from "./fixtures.ts";

/** 期望分析成功；失败时把诊断文本带进断言消息，避免"期望 true 实际 false"这种无信息量的失败。 */
function analyzeOk(events: readonly EventRecord[]): AskUserAnalysis {
  const result = analyzeAskUserEvents(events);
  assert.equal(result.success, true, result.success ? "" : `分析失败: ${result.error}`);
  if (!result.success) throw new Error("unreachable");
  return result.data;
}

/** 期望分析失败并返回诊断文本。 */
function analyzeMismatch(events: readonly EventRecord[]): string {
  const result = analyzeAskUserEvents(events);
  assert.equal(result.success, false, "期望结构不符，但分析成功了");
  if (result.success) throw new Error("unreachable");
  return result.error;
}

/** 记录级合成事件（仅用于官方库写入侧会拒绝的形态）。 */
function record(type: string, seq: number, data: Record<string, unknown>): EventRecord {
  return { type, seq, time: 100 + seq, data };
}

describe("analyzeAskUserEvents 提问抽取", () => {
  it("逐题输出序号、标题、id、问题与每个选项一行", () => {
    const analysis = analyzeOk([
      askQuestionEvent(2, 12, "call-unit-1", [
        {
          id: "q1",
          header: "标题一",
          question: "问题一",
          options: [
            { label: "选项 1", description: "说明 1" },
            { label: "选项 2", description: "说明 2" },
          ],
        },
        {
          id: "q2",
          header: "标题二",
          question: "问题二",
          options: [{ label: "选项 3" }, { label: "选项 4" }, { label: "选项 5" }],
        },
      ]),
    ]);
    assert.deepEqual(
      analysis.entries.map((entry) => entry.label),
      [ASK_USER_QUESTION_LABEL],
    );
    assert.equal(
      analysis.entries[0].text,
      [
        "[1] 标题一（id：q1）",
        "问题：问题一",
        "选项：选项 1｜说明 1",
        "选项：选项 2｜说明 2",
        "[2] 标题二（id：q2）",
        "问题：问题二",
        // 选项缺 description 时按空值契约显示 `-`，而不是省略该行或留空。
        "选项：选项 3｜-",
        "选项：选项 4｜-",
        "选项：选项 5｜-",
      ].join("\n"),
    );
  });

  it("无选项时省略选项行（options 缺失与空数组等价）", () => {
    const missing = analyzeOk([
      askQuestionEvent(2, 12, "call-unit-2", [{ id: "q1", header: "H", question: "Q" }]),
    ]);
    assert.equal(missing.entries[0].text, "[1] H（id：q1）\n问题：Q");
    const empty = analyzeOk([
      askQuestionEvent(2, 12, "call-unit-3", [
        { id: "q1", header: "H", question: "Q", options: [] },
      ]),
    ]);
    assert.equal(empty.entries[0].text, "[1] H（id：q1）\n问题：Q");
  });

  it("字段缺失按空值契约显示 -", () => {
    const analysis = analyzeOk([askQuestionEvent(2, 12, "call-unit-4", [{}])]);
    assert.equal(analysis.entries[0].text, "[1] -（id：-）\n问题：-");
  });
});

describe("analyzeAskUserEvents 回答抽取", () => {
  it("selected 非空输出选择行，多条选择以顿号连接", () => {
    const analysis = analyzeOk([
      askQuestionEvent(2, 12, "call-unit-10", [{ id: "q1", header: "H", question: "Q" }]),
      askAnswerEvent(3, 13, "call-unit-10", [{ id: "q1", selected: ["选项 A", "选项 B"] }]),
    ]);
    assert.deepEqual(
      analysis.entries.map((entry) => entry.label),
      [ASK_USER_QUESTION_LABEL, ASK_USER_ANSWER_LABEL],
    );
    assert.equal(analysis.entries[1].text, "[1] id：q1\n选择：选项 A、选项 B");
  });

  it("custom 为非空字符串时输出自定义行（保留内嵌换行）", () => {
    const analysis = analyzeOk([
      askQuestionEvent(2, 12, "call-unit-11", [{ id: "q1", header: "H", question: "Q" }]),
      askAnswerEvent(3, 13, "call-unit-11", [{ id: "q1", custom: "第一行\n第二行" }]),
    ]);
    assert.equal(analysis.entries[1].text, "[1] id：q1\n自定义：第一行\n第二行");
  });

  it("selected 与 custom 同时非空时先选择后自定义", () => {
    const analysis = analyzeOk([
      askQuestionEvent(2, 12, "call-unit-12", [{ id: "q1", header: "H", question: "Q" }]),
      askAnswerEvent(3, 13, "call-unit-12", [{ id: "q1", selected: ["选项 A"], custom: "补充" }]),
    ]);
    assert.equal(analysis.entries[1].text, "[1] id：q1\n选择：选项 A\n自定义：补充");
  });

  it("两者皆无输出未作答（空对象、空数组、空串三种写法等价）", () => {
    const cases: readonly { readonly answer: Record<string, unknown>; readonly text: string }[] = [
      // 缺 id 时按空值契约显示 `-`：未作答与空值是两个独立的显示事实，不得互相顶替。
      { answer: {}, text: "[1] id：-\n未作答" },
      { answer: { id: "q1", selected: [] }, text: "[1] id：q1\n未作答" },
      { answer: { id: "q1", custom: "" }, text: "[1] id：q1\n未作答" },
    ];
    for (const item of cases) {
      const analysis = analyzeOk([
        askQuestionEvent(2, 12, "call-unit-13", [{ id: "q1", header: "H", question: "Q" }]),
        askAnswerEvent(3, 13, "call-unit-13", [item.answer]),
      ]);
      assert.equal(analysis.entries[1].text, item.text);
    }
  });

  it("多条回答逐条编号", () => {
    const analysis = analyzeOk([
      askQuestionEvent(2, 12, "call-unit-14", [{ id: "q1", header: "H", question: "Q" }]),
      askAnswerEvent(3, 13, "call-unit-14", [
        { id: "q1", selected: ["选项 A"] },
        { id: "q2" },
        { id: "q3", custom: "补充" },
      ]),
    ]);
    assert.equal(
      analysis.entries[1].text,
      "[1] id：q1\n选择：选项 A\n[2] id：q2\n未作答\n[3] id：q3\n自定义：补充",
    );
  });
});

describe("analyzeAskUserEvents 配对与计数", () => {
  it("条目顺序等于事件顺序，按 callId 配对", () => {
    const analysis = analyzeOk([
      askQuestionEvent(2, 12, "call-a", [{ id: "qa", header: "A", question: "问 A" }]),
      askQuestionEvent(3, 13, "call-b", [{ id: "qb", header: "B", question: "问 B" }]),
      askAnswerEvent(4, 14, "call-b", [{ id: "qb", selected: ["选项 B"] }]),
      askAnswerEvent(5, 15, "call-a", [{ id: "qa", selected: ["选项 A"] }]),
    ]);
    assert.deepEqual(
      analysis.entries.map((entry) => entry.label),
      [
        ASK_USER_QUESTION_LABEL,
        ASK_USER_QUESTION_LABEL,
        ASK_USER_ANSWER_LABEL,
        ASK_USER_ANSWER_LABEL,
      ],
    );
    assert.equal(analysis.entries[2].text, "[1] id：qb\n选择：选项 B");
    assert.equal(analysis.entries[3].text, "[1] id：qa\n选择：选项 A");
    assert.equal(analysis.questionCount, 2);
    assert.equal(analysis.answerCount, 2);
  });

  it("未配对提问照常产出条目，answerCount 为 0", () => {
    const analysis = analyzeOk([
      askQuestionEvent(2, 12, "call-open", [{ id: "q1", header: "H", question: "Q" }]),
    ]);
    assert.equal(analysis.entries.length, 1);
    assert.equal(analysis.entries[0].label, ASK_USER_QUESTION_LABEL);
    assert.equal(analysis.questionCount, 1);
    assert.equal(analysis.answerCount, 0);
  });

  it("缺少 callId 的提问不参与配对，但仍产出条目并计入 P", () => {
    const analysis = analyzeOk([
      askQuestionRawEvent(2, 12, "", JSON.stringify({ questions: [{ id: "q1", question: "Q" }] })),
      askAnswerEvent(3, 13, "", [{ id: "q1", selected: ["选项 A"] }]),
    ]);
    assert.deepEqual(
      analysis.entries.map((entry) => entry.label),
      [ASK_USER_QUESTION_LABEL],
    );
    assert.equal(analysis.questionCount, 1);
    assert.equal(analysis.answerCount, 0);
  });

  it("非问答工具调用与结果不产出条目", () => {
    const analysis = analyzeOk([
      record("tool/call", 0, { callId: "c1", name: "read", arguments: '{"path":"x"}' }),
      record("tool/result", 1, {
        message: { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "结果" }] },
      }),
      record("tool/result", 2, {
        message: {
          role: "tool",
          toolCallId: "no-such-call",
          content: [{ type: "text", text: "x" }],
        },
      }),
    ]);
    assert.deepEqual(analysis.entries, []);
    assert.equal(analysis.questionCount, 0);
    assert.equal(analysis.answerCount, 0);
  });

  it("重复结果只认第一条非错误态结果", () => {
    const analysis = analyzeOk([
      askQuestionEvent(2, 12, "call-dup", [{ id: "q1", header: "H", question: "Q" }]),
      askAnswerEvent(3, 13, "call-dup", [{ id: "q1", selected: ["第一次"] }]),
      askAnswerEvent(4, 14, "call-dup", [{ id: "q1", selected: ["第二次"] }]),
    ]);
    assert.equal(analysis.entries.length, 2);
    assert.equal(analysis.entries[1].text, "[1] id：q1\n选择：第一次");
    assert.equal(analysis.answerCount, 1);
  });
});

describe("analyzeAskUserEvents 错误态结果", () => {
  it("message.isError 为 true 时不产出回答条目，也不触发载荷异常", () => {
    const analysis = analyzeOk([
      askQuestionEvent(2, 12, "call-err-1", [{ id: "q1", header: "H", question: "Q" }]),
      // 错误态结果的内容不是 answers 载荷；若被当作回答处理必然判成结构不符。
      record("tool/result", 3, {
        message: {
          role: "tool",
          toolCallId: "call-err-1",
          isError: true,
          content: [{ type: "text", text: "Error: the user cancelled ask_user_question" }],
        },
      }),
    ]);
    assert.deepEqual(
      analysis.entries.map((entry) => entry.label),
      [ASK_USER_QUESTION_LABEL],
    );
    assert.equal(analysis.questionCount, 1);
    assert.equal(analysis.answerCount, 0);
  });

  it("data.error 存在时同样按错误态处理（提问被中止）", () => {
    const analysis = analyzeOk([
      askQuestionEvent(2, 12, "call-err-2", [{ id: "q1", header: "H", question: "Q" }]),
      askErrorResultEvent(
        3,
        13,
        "call-err-2",
        "ASK_ABORTED",
        "Error: ask_user_question was aborted before the user answered",
      ),
    ]);
    assert.deepEqual(
      analysis.entries.map((entry) => entry.label),
      [ASK_USER_QUESTION_LABEL],
    );
    assert.equal(analysis.answerCount, 0);
  });

  it("错误态结果之后若出现正常的配对结果，仍按回答处理", () => {
    const analysis = analyzeOk([
      askQuestionEvent(2, 12, "call-err-3", [{ id: "q1", header: "H", question: "Q" }]),
      askErrorResultEvent(3, 13, "call-err-3", "ASK_CANCELLED", "Error: the user cancelled"),
      askAnswerEvent(4, 14, "call-err-3", [{ id: "q1", selected: ["选项 A"] }]),
    ]);
    assert.deepEqual(
      analysis.entries.map((entry) => entry.label),
      [ASK_USER_QUESTION_LABEL, ASK_USER_ANSWER_LABEL],
    );
    assert.equal(analysis.answerCount, 1);
  });
});

describe("analyzeAskUserEvents 载荷结构不符", () => {
  it("提问侧：可写进日志的失真形态", () => {
    const cases: readonly { readonly name: string; readonly events: EventRecord[] }[] = [
      {
        name: "arguments 不是合法 JSON",
        events: [askQuestionRawEvent(2, 12, "c", '{"questions": [')],
      },
      {
        name: "arguments 顶层不是对象",
        events: [askQuestionRawEvent(2, 12, "c", "[1,2]")],
      },
      {
        name: "questions 不是数组",
        events: [askQuestionRawEvent(2, 12, "c", '{"questions": {}}')],
      },
      {
        name: "题不是对象",
        events: [askQuestionRawEvent(2, 12, "c", '{"questions": ["题"]}')],
      },
      {
        name: "选项不是对象",
        events: [askQuestionRawEvent(2, 12, "c", '{"questions": [{"id":"q","options":["选项"]}]}')],
      },
    ];
    for (const item of cases) {
      const error = analyzeMismatch(item.events);
      assert.notEqual(error.length, 0, item.name);
    }
  });

  it("提问侧：字段类型不符（记录级形态）", () => {
    const cases: readonly { readonly name: string; readonly data: Record<string, unknown> }[] = [
      { name: "arguments 缺失", data: { callId: "c", name: "ask_user_question" } },
      {
        name: "arguments 非字符串",
        data: { callId: "c", name: "ask_user_question", arguments: 1 },
      },
      {
        name: "header 非字符串",
        data: {
          callId: "c",
          name: "ask_user_question",
          arguments: '{"questions":[{"id":"q","header":1,"question":"Q"}]}',
        },
      },
      {
        name: "options 非数组",
        data: {
          callId: "c",
          name: "ask_user_question",
          arguments: '{"questions":[{"id":"q","question":"Q","options":{}}]}',
        },
      },
      {
        name: "选项 label 非字符串",
        data: {
          callId: "c",
          name: "ask_user_question",
          arguments: '{"questions":[{"id":"q","question":"Q","options":[{"label":1}]}]}',
        },
      },
    ];
    for (const item of cases) {
      const error = analyzeMismatch([record("tool/call", 2, item.data)]);
      assert.equal(error.includes("提问事件"), true, item.name);
    }
  });

  it("回答侧：可写进日志与记录级的失真形态", () => {
    const question = askQuestionEvent(2, 12, "c", [{ id: "q1", header: "H", question: "Q" }]);
    const contents: readonly { readonly name: string; readonly text: string }[] = [
      { name: "content 文本不是合法 JSON", text: "Error: ask_user_question failed" },
      { name: "JSON 顶层不是对象", text: "[1]" },
      { name: "answers 不是数组", text: '{"answers": {}}' },
      { name: "回答条不是对象", text: '{"answers": ["a"]}' },
      { name: "selected 不是数组", text: '{"answers": [{"id":"q1","selected":"选项"}]}' },
      { name: "selected 含非字符串元素", text: '{"answers": [{"id":"q1","selected":[1]}]}' },
      { name: "custom 不是字符串", text: '{"answers": [{"id":"q1","custom":1}]}' },
    ];
    for (const item of contents) {
      const event = record("tool/result", 3, {
        message: {
          role: "tool",
          toolCallId: "c",
          content: [{ type: "text", text: item.text }],
        },
      });
      const error = analyzeMismatch([question, event]);
      assert.equal(error.includes("回答事件"), true, item.name);
    }
  });

  it("回答侧：message 缺失或无文本块", () => {
    const question = askQuestionEvent(2, 12, "c", [{ id: "q1", header: "H", question: "Q" }]);
    const missingMessage = record("tool/result", 3, { message: { toolCallId: "c" } });
    const emptyContent = record("tool/result", 3, {
      message: { role: "tool", toolCallId: "c", content: [] },
    });
    assert.equal(analyzeMismatch([question, missingMessage]).includes("回答事件"), true);
    assert.equal(analyzeMismatch([question, emptyContent]).includes("回答事件"), true);
  });
});
