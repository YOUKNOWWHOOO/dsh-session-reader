// 用途：`ask_user_question`（工具向用户提问）问答事件的判定、提问与回答的配对、可读文本抽取，
// 以及规模探测所需的提问/回答事件计数。
// 主要入口：analyzeAskUserEvents（md 时间线条目、默认档检索单元与 `--probe` 计数共用的唯一产出）。
// 关键依赖：decode.ts（事件读取基元 asRecord/readString/textFromBlocks/eventType/eventSeq）、
// render-core.ts（空值显示文案）、paths.ts（Result）。
// 设计约束：本模块是这类内容在全技能范围内的单一真值源——md 渲染与检索单元都消费同一份产出，
// 禁止任一方另写一份抽取（两处各写一份必然漂移，"呈现"与"检索"就会给出不同的答案）。
// 载荷结构与登记不符时返回 Result 错误，由调用方按契约显式失败：`show` 整体失败（退出 3、
// stderr `错误: 数据不可读`、不产出文件），`search` 把该会话逐条列入覆盖声明的排除项并继续。
// 禁止任何降级形态：不做原样兜底、不做猜测补齐、不静默丢弃——把不可解析的载荷塞进载体或悄悄少算
// 一条，都会让产物看起来正常却与日志事实不符。
// 错误态结果（`isError`/`data.error`，即提问被中止或取消）不在此列：它是正常产品形态，
// 按"没有回答"处理而不是载荷异常，判据与理由见 `isErrorResult`。
// 结构与文案逐字依据 doc\开发规范.md 的「提问与回答契约」一节。

import {
  asRecord,
  type EventRecord,
  eventSeq,
  eventType,
  readBoolean,
  readString,
  textFromBlocks,
} from "./decode.ts";
import type { Result } from "./paths.ts";
import { EMPTY_VALUE } from "./render-core.ts";

/** 提问工具名：`data.name` 等于它的 `tool/call` 事件才是提问。 */
export const ASK_USER_TOOL_NAME = "ask_user_question";

/** 提问与回答两类时间线条目的标签（取值即对外契约，不得改写）。 */
export const ASK_USER_QUESTION_LABEL = "提问";
export const ASK_USER_ANSWER_LABEL = "回答";

/** 载荷结构不符合预期时的固定原因文本（`search` 覆盖声明的排除原因；取值即对外契约）。 */
export const ASK_USER_PAYLOAD_MISMATCH_REASON = "问答载荷结构不符合预期";

/** 问答条目的标签类型。 */
export type AskUserLabel = typeof ASK_USER_QUESTION_LABEL | typeof ASK_USER_ANSWER_LABEL;

/**
 * 单个问答事件的可读文本。
 *
 * `event` 是该文本所属的事件对象本身（提问为 `tool/call`，回答为配对的 `tool/result`）：
 * 渲染层据此按"事件身份"取回条目，因此 `--turn`/`--seq` 的事件级筛选天然同时作用于问答条目，
 * 无需另写一套筛选。`text` 未经 `--truncate` 处理，截断由渲染层与检索层各自按统一口径套用。
 */
export interface AskUserEntry {
  readonly event: EventRecord;
  readonly label: AskUserLabel;
  readonly text: string;
}

/** 一次会话的问答分析结果（md 条目、检索单元与探测计数共用的产出）。 */
export interface AskUserAnalysis {
  /** 按事件顺序排列的条目：每个提问事件一条、每个产出回答的结果事件一条。 */
  readonly entries: readonly AskUserEntry[];
  /** 提问事件数（`--probe` 的 `P`）。 */
  readonly questionCount: number;
  /**
   * 产出回答条目的结果数（`--probe` 的 `Q`）。
   *
   * 它小于 `P` 有两种原因，两者都必须能从产物中区分：提问没有配对结果（未配对），
   * 或配对结果是错误态（提问被中止或取消）。前者可用 `--tools` 看出该提问没有结果条目，
   * 后者可用 `--tools` 看出结果的错误态。
   */
  readonly answerCount: number;
}

/**
 * 结构不符的诊断结果。
 *
 * 错误文本只用于测试与调试定位：CLI 契约要求 stderr 恒为单行 `错误: 数据不可读`，
 * 因此细节不会外显（它含事件 seq，直接打到终端会违反"错误行不含会话内容"的约定）。
 */
function mismatch(where: string, detail: string): Result<never, string> {
  return { success: false, error: `${where}：${detail}` };
}

/** 事件定位串（仅用于结构不符的诊断文本）。 */
function locate(event: EventRecord): string {
  return `seq ${String(eventSeq(event) ?? "-")}`;
}

/**
 * 读取登记结构中的字符串字段，返回可直接写入载体的文本。
 *
 * 三态语义：
 * - 字段缺失 → `EMPTY_VALUE`（按空值契约显示 `-`；缺失是合法形态，登记结构里 `header` 等字段可缺）；
 * - 字段是字符串 → 原样返回（空串按"存在但为空"渲染，不冒充缺失）；
 * - 字段存在但类型不符 → 结构不符。把数字、对象等非字符串值渲染进载体属于"猜测补齐"，
 *   产物会看起来正常却与登记结构无关。
 */
function fieldText(record: Record<string, unknown>, key: string): Result<string, string> {
  const value = record[key];
  if (value === undefined) return { success: true, data: EMPTY_VALUE };
  if (typeof value !== "string") return { success: false, error: `字段 ${key} 不是字符串` };
  return { success: true, data: value };
}

/**
 * 把 JSON 文本解析为对象。
 *
 * 解析失败不做任何兜底：`JSON.parse` 的异常在这里被转换为结构不符，而不是被吞掉后继续
 * （吞掉会让"不可解析"与"合法但无内容"变成同一种产物）。
 */
function parseJsonRecord(text: string, where: string): Result<Record<string, unknown>, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return mismatch(where, "不是合法 JSON 文本");
  }
  const record = asRecord(parsed);
  if (record === undefined) return mismatch(where, "JSON 顶层不是对象");
  return { success: true, data: record };
}

/** 提问事件判定：`tool/call` 且 `data.name` 为 `ask_user_question`。 */
function isQuestionEvent(event: EventRecord): boolean {
  if (eventType(event) !== "tool/call") return false;
  return readString(asRecord(event.data) ?? {}, "name") === ASK_USER_TOOL_NAME;
}

/**
 * 提问事件的配对标识（`data.callId`）。
 *
 * 缺失、非字符串或空串时返回 null：此时只是"配对不上"（提问照常呈现，回答数为 0），
 * 不是结构不符——契约把结构不符限定在载荷内容上，没有把配对标识登记为结构的一部分。
 */
function questionCallIdOf(event: EventRecord): string | null {
  const value = readString(asRecord(event.data) ?? {}, "callId");
  return value === undefined || value.length === 0 ? null : value;
}

/** 工具结果事件的配对标识（`data.message.toolCallId`），取值语义同 `questionCallIdOf`。 */
function answerCallIdOf(event: EventRecord): string | null {
  if (eventType(event) !== "tool/result") return null;
  const message = asRecord(asRecord(event.data)?.message);
  if (message === undefined) return null;
  const value = readString(message, "toolCallId");
  return value === undefined || value.length === 0 ? null : value;
}

/**
 * 配对结果的错误态判定：`data.message.isError === true` 或 `data.error !== undefined` 任一成立。
 *
 * 存在理由（实测根因）：日志里真实的"提问被中止或取消"会以工具错误态落账——`data.error` 形如
 * `{ name: "UserQuestionError", code: "ASK_ABORTED" | "ASK_CANCELLED" }`，`message.isError` 为 true，
 * `message.content` 是 `Error: ask_user_question was aborted before the user answered` 这类纯文本。
 * 这是正常的产品形态（用户没作答），不是"载荷结构不符合预期"：把它当载荷异常会让这类会话永久
 * 读不了（`show` 恒退出 3），也会让聚合检索把它们逐条排除，代价远大于收益。
 * 因此错误态结果按"没有回答"处理：不产出 `**回答**` 条目、不计入 `Q`、不触发载荷异常，
 * 提问照常呈现（与"未配对的提问照常呈现"同一处理）。
 */
function isErrorResult(event: EventRecord): boolean {
  const data = asRecord(event.data) ?? {};
  if (data.error !== undefined) return true;
  const message = asRecord(data.message);
  return message !== undefined && readBoolean(message, "isError") === true;
}

/** 单个选项一行的文本：`选项：<label>｜<description>`（分隔符是全角竖线，取值即对外契约）。 */
function optionLines(question: Record<string, unknown>, where: string): Result<string[], string> {
  const options = question.options;
  // 无选项时省略选项行：登记结构把 options 记为可缺字段，缺它表示"该题没有选项"，
  // 与"字段存在但是空数组"在呈现上等价（都是零行）。
  if (options === undefined) return { success: true, data: [] };
  if (!Array.isArray(options)) return mismatch(where, "options 不是数组");
  const lines: string[] = [];
  for (let index = 0; index < options.length; index += 1) {
    const option = asRecord(options[index]);
    const optionWhere = `${where}的第 ${index + 1} 个选项`;
    if (option === undefined) return mismatch(optionWhere, "不是对象");
    const label = fieldText(option, "label");
    if (!label.success) return mismatch(optionWhere, label.error);
    const description = fieldText(option, "description");
    if (!description.success) return mismatch(optionWhere, description.error);
    lines.push(`选项：${label.data}｜${description.data}`);
  }
  return { success: true, data: lines };
}

/**
 * 提问的可读文本：`data.arguments` → `questions[]` → 逐题三条固定部分。
 *
 * 逐题输出 `[<序号>] <header>（id：<id>）`、`问题：<question>`，以及每个选项一行。
 * 序号从 1 起（题序即 `questions[]` 数组序，与日志顺序一致，不做排序）。
 */
function questionTextOf(event: EventRecord): Result<string, string> {
  const where = `提问事件 ${locate(event)}`;
  const argumentsText = readString(asRecord(event.data) ?? {}, "arguments");
  if (argumentsText === undefined) return mismatch(where, "arguments 不是字符串");
  const payload = parseJsonRecord(argumentsText, `${where} 的 arguments`);
  if (!payload.success) return payload;
  const questions = payload.data.questions;
  if (!Array.isArray(questions)) return mismatch(where, "questions 不是数组");
  const lines: string[] = [];
  for (let index = 0; index < questions.length; index += 1) {
    const question = asRecord(questions[index]);
    const questionWhere = `${where}的第 ${index + 1} 题`;
    if (question === undefined) return mismatch(questionWhere, "不是对象");
    const header = fieldText(question, "header");
    if (!header.success) return mismatch(questionWhere, header.error);
    const id = fieldText(question, "id");
    if (!id.success) return mismatch(questionWhere, id.error);
    const text = fieldText(question, "question");
    if (!text.success) return mismatch(questionWhere, text.error);
    const options = optionLines(question, questionWhere);
    if (!options.success) return options;
    lines.push(`[${index + 1}] ${header.data}（id：${id.data}）`);
    lines.push(`问题：${text.data}`);
    lines.push(...options.data);
  }
  return { success: true, data: lines.join("\n") };
}

/** 所选选项标签：`selected` 缺失按空处理；非数组或含非字符串元素即结构不符。 */
function selectedLabels(
  answer: Record<string, unknown>,
  where: string,
): Result<readonly string[], string> {
  const value = answer.selected;
  if (value === undefined) return { success: true, data: [] };
  if (!Array.isArray(value)) return mismatch(where, "selected 不是数组");
  const labels: string[] = [];
  for (const label of value) {
    if (typeof label !== "string") return mismatch(where, "selected 含非字符串元素");
    labels.push(label);
  }
  return { success: true, data: labels };
}

/**
 * 用户自定义回答：缺失或空串一律按 null（等价于"没有自定义回答"）。
 *
 * 空串与缺失同义的理由与来源标注一致：契约要求 `custom` 为**非空**字符串时才输出一行，
 * 空串没有信息量，渲染成 `自定义：` 这样的空载体既不准确也失去意义。
 */
function customText(answer: Record<string, unknown>, where: string): Result<string | null, string> {
  const value = answer.custom;
  if (value === undefined) return { success: true, data: null };
  if (typeof value !== "string") return mismatch(where, "custom 不是字符串");
  return { success: true, data: value.length === 0 ? null : value };
}

/**
 * 回答的可读文本：`data.message.content` → `answers[]` → 逐条固定两部分。
 *
 * 逐条输出 `[<序号>] id：<id>`，随后至多两行：`选择：<label1>、<label2>`（`selected` 非空时）、
 * `自定义：<custom>`（`custom` 为非空字符串时）；两者皆无时输出一行 `未作答`。
 * 序号从 1 起（条序即 `answers[]` 数组序）。
 *
 * 调用方必须先用 `isErrorResult` 排除错误态结果：本函数只处理"本该是回答载荷"的内容，
 * 错误态结果的内容是错误文本，进入这里必然被判成结构不符，而那并不是它的语义。
 */
function answerTextOf(event: EventRecord): Result<string, string> {
  const where = `回答事件 ${locate(event)}`;
  const message = asRecord(asRecord(event.data)?.message);
  if (message === undefined) return mismatch(where, "message 不是对象");
  // 结果文本的抽取复用工具结果的统一入口（兼容平铺与嵌套两种内容形态）：
  // 只认一种形态会让抽取静默返回空串，而空串在这里会被判成"结构不符"——错误位置离根因很远。
  const contentText = textFromBlocks(message.content);
  if (contentText.length === 0) return mismatch(where, "content 中没有非空文本块");
  const payload = parseJsonRecord(contentText, `${where} 的 content 文本`);
  if (!payload.success) return payload;
  const answers = payload.data.answers;
  if (!Array.isArray(answers)) return mismatch(where, "answers 不是数组");
  const lines: string[] = [];
  for (let index = 0; index < answers.length; index += 1) {
    const answer = asRecord(answers[index]);
    const answerWhere = `${where}的第 ${index + 1} 条回答`;
    if (answer === undefined) return mismatch(answerWhere, "不是对象");
    const id = fieldText(answer, "id");
    if (!id.success) return mismatch(answerWhere, id.error);
    const selected = selectedLabels(answer, answerWhere);
    if (!selected.success) return selected;
    const custom = customText(answer, answerWhere);
    if (!custom.success) return custom;
    lines.push(`[${index + 1}] id：${id.data}`);
    if (selected.data.length > 0) lines.push(`选择：${selected.data.join("、")}`);
    if (custom.data !== null) lines.push(`自定义：${custom.data}`);
    if (selected.data.length === 0 && custom.data === null) lines.push("未作答");
  }
  return { success: true, data: lines.join("\n") };
}

/**
 * 分析一批事件中的问答内容：产出可读文本条目（按事件顺序）与提问/回答事件计数。
 *
 * 两遍扫描的理由：配对关系是"提问 → 结果"的前向引用（结果在提问之后，但异常日志里也可能先出现
 * 结果），先把全部提问的 `callId` 登记下来，第二遍才按顺序产出条目，顺序因此恒等于事件顺序，
 * 与 `--head`/`--tail` 的条目口径一致（若边扫边配，条目顺序会依赖配对时机）。
 *
 * Args:
 *   events: 一个会话（或块）的全部已解码逻辑事件。
 *
 * Returns:
 *   Result 成功时给出条目与计数；失败表示某个提问或回答事件的载荷无法解析为登记结构，
 *   错误文本用于定位（不外显）。
 */
export function analyzeAskUserEvents(
  events: readonly EventRecord[],
): Result<AskUserAnalysis, string> {
  const callIds = new Set<string>();
  let questionCount = 0;
  for (const event of events) {
    if (!isQuestionEvent(event)) continue;
    questionCount += 1;
    const callId = questionCallIdOf(event);
    if (callId !== null) callIds.add(callId);
  }
  const entries: AskUserEntry[] = [];
  const pairedCallIds = new Set<string>();
  for (const event of events) {
    if (isQuestionEvent(event)) {
      const text = questionTextOf(event);
      if (!text.success) return text;
      entries.push({ event, label: ASK_USER_QUESTION_LABEL, text: text.data });
      continue;
    }
    const callId = answerCallIdOf(event);
    if (callId === null || !callIds.has(callId) || pairedCallIds.has(callId)) continue;
    // 错误态结果不是回答：它承载的是"提问被中止或取消"这一事实，没有 `answers[]` 可解析。
    // 这里直接跳过（不标记已配对）：错误态结果不参与配对，因此不产出条目、不计入 `Q`，
    // 该提问以"无回答"的形态呈现。载荷异常只对非错误态结果生效（见 `isErrorResult`）。
    if (isErrorResult(event)) continue;
    pairedCallIds.add(callId);
    const text = answerTextOf(event);
    if (!text.success) return text;
    entries.push({ event, label: ASK_USER_ANSWER_LABEL, text: text.data });
  }
  return {
    success: true,
    data: { entries, questionCount, answerCount: pairedCallIds.size },
  };
}
