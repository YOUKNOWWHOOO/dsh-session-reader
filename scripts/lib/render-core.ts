// 用途：渲染基础设施——文本载体（多行动态围栏、单行行内代码跨度、表格单元格）、三条极小归一化
// （CR/CRLF → LF 与制表符 → 4 空格 MD010、行内值首尾空白去除 MD038、全 `$` 载荷末尾补一行空格 MD014）、
// 按码点截断、字节大小格式化、文档装配、空值与"元数据不可用"常量、字段值格式化，以及 md/json 两组
// 渲染器共用的会话派生事实（会话标题、令牌用量、轮次、事件统计、节点计数）。
// 主要入口：fenceBlock / inlineValue / tableCellValue / truncateText / formatSize / assembleDocument、
// fieldValueText / modelText / tokenTotalsText，以及 findSessionTitle / sumUsage / computeTurns /
// computeEventStats / countNodes；RenderedOutput 与 ShowMdOptions 是渲染层的公共契约类型
// （md 渲染器的产物形态与输入选项，CLI 与各渲染器共用）。
// 关键依赖：decode.ts（事件读取基元）、paths.ts（IntegerRange 类型）、store-types.ts（视图与节点类型）。
// 设计约束：本模块不读命令语义、不产出任何命令级文案；载体与归一化是"实现与测试的单一真值源"，
// 任何新载体都必须复用同一套动态反引号长度规则，禁止各渲染器自造转义或第二份归一化。
//
// 以下为拆分前 render.ts 文件头的层规则原稿（输出格式终稿：方案 v2 §3.9 / f2 报告 §4 R1–R5），逐字保留：
// 渲染层：Markdown（lint-safe）/JSON/JSONL 输出、可见性控制（推理/工具/事件）、范围筛选、截断、覆盖声明、摘要文案。
// 输出格式为"实现与测试的单一真值源"（方案 v2 §3.9 / f2 报告 §4 R1–R5 为规则终稿）：
// - md：GFM 子集、结构骨架只用固定词表与工具生成值；任意文本只经两种载体承载——
//   多行文本 → 动态长度围栏（反引号 + `text` 语言）；单行文本 → 行内代码跨度（动态反引号）；
//   三条极小归一化：CR/CRLF → LF 与制表符 → 4 空格（MD010）、行内值首尾空白去除（MD038）、全 `$` 载荷
//   末尾追加一行单个空格（MD014）；正文以外的结构纪律见 assembleDocument 与各渲染函数注释。
// - json：JSON.stringify(value, null, 2) + 换行；
// - jsonl：首行逻辑 header，其后每行一个已解码事件（键序稳定）。
import { asRecord, eventSeq, eventType, readNumber, readString, textFromBlocks } from "./decode.ts";
import type { IntegerRange } from "./paths.ts";
import type {
  CoverageSkip,
  DecodedSessionFile,
  FieldValue,
  ModelView,
  SessionNode,
  TokenTotals,
} from "./store-types.ts";

/** 元数据不可用的显示文案（跨渲染器共用；取值即对外契约，不得改写）。 */
export const METADATA_UNAVAILABLE_TEXT = "元数据不可用";
/** 空值显示（json 侧对应 null）。 */
export const EMPTY_VALUE = "-";
const TAB_WIDTH = 4;

/** 渲染结果：文件内容 + stdout 用的命令级摘要。 */
export interface RenderedOutput {
  readonly content: string;
  readonly summary: string;
}

/** show 呈现选项（与 CLI 约束一致：呈现类开关仅 md）。 */
export interface ShowMdOptions {
  readonly summary: boolean;
  readonly role: "user" | "assistant" | null;
  readonly thinking: boolean;
  readonly tools: boolean;
  readonly events: boolean;
  readonly headers: boolean;
  readonly truncate: number;
  readonly subagents: boolean;
  /** 归属未知的跳过项（仅 `--subagents` 可能有内容），语义见 `SessionCoverage.unattributable`。 */
  readonly unattributable: readonly CoverageSkip[];
  /**
   * 只给规模摘要、不落正文（对应"大体积产物缺先探测规模的两阶段能力"）：
   * 产物只含头部 KV 块与预计字节数，调用方可据此决定是否再执行一次完整导出。
   */
  readonly probe: boolean;
  /** turn 区间（含端点）；null 表示不筛选。 */
  readonly turnRange: IntegerRange | null;
  /** seq 区间（含端点）；null 表示不筛选。 */
  readonly seqRange: IntegerRange | null;
  /** 只呈现筛选结果的首 N 条（0=不限）。 */
  readonly head: number;
  /** 只呈现筛选结果的末 N 条（0=不限）。 */
  readonly tail: number;
}

/** 渲染工具函数：字节大小人读格式（1024 进制）。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 渲染工具函数：按码点截断文本（0=不截断），附加省略号。 */
export function truncateText(text: string, limit: number): string {
  if (limit <= 0) return text;
  const points = [...text];
  if (points.length <= limit) return text;
  return `${points.slice(0, limit).join("")}…`;
}

export function fieldValueText<T>(field: FieldValue<T>, render: (value: T) => string): string {
  if (field.unavailable) return METADATA_UNAVAILABLE_TEXT;
  if (field.value === null) return EMPTY_VALUE;
  return render(field.value);
}

export function modelText(model: ModelView): string {
  return `${model.provider}/${model.model}`;
}

export function tokenTotalsText(tokens: TokenTotals): string {
  return `${tokens.uncachedInputTokens}/${tokens.outputTokens}/${tokens.cacheReadTokens}/${tokens.cacheWriteTokens}`;
}

// ------------------------- lint-safe 渲染规则（f2 R1–R5） -------------------------

/** 最长连续反引号串长度（围栏/行内跨度定界依据）。 */
function maxBacktickRun(text: string): number {
  let max = 0;
  for (const match of text.matchAll(/`+/gu)) max = Math.max(max, match[0].length);
  return max;
}

/**
 * 归一化 1：制表符 → 4 空格（MD010 覆盖围栏与行内代码；f2 R3-1）。
 *
 * 同一步骤内把 CRLF 与孤立 CR 一律折叠为 LF：输出契约要求产物为"UTF-8 无 BOM、LF"，
 * 而会话正文本身可能含 CR 字节，一旦漏过就会让产物混入 CR。内嵌 CR 不会被 markdownlint
 * 判为违规，因此它是**契约层面的静默破坏**而非 lint 问题——必须在载体归一化阶段消除，
 * 否则"LF"这一契约无法成立。（此处不写命中的产物个数：该计数随门禁规模变化，写死必然过时。）
 */
export function normalizeTabs(text: string): string {
  return text.replace(/\r\n|\r/gu, "\n").replace(/\t/gu, " ".repeat(TAB_WIDTH));
}

/** MD014 触发判定：所有非空行均以「可选空白 + $ + 空白」开头（f2 R3-3）。 */
export function wouldTriggerMd014(payload: string): boolean {
  const lines = payload
    .replace(/\r\n|\r/gu, "\n")
    .split("\n")
    .filter((line) => line.length > 0);
  return lines.length > 0 && lines.every((line) => /^\s*\$\s+/u.test(line));
}

/** 归一化 2：MD014 中和——在载荷末尾追加一行单个空格（原文各行逐字保留；f2 R3-3）。 */
export function neutralizeMd014(payload: string): string {
  return wouldTriggerMd014(payload) ? `${payload}\n ` : payload;
}

/** 围栏载体：反引号长度 = 载荷最长连续反引号串 + 1（不小于 3）、信息串固定 `text`（f2 R1-7/R2-1）。 */
export function fenceBlock(rawPayload: string): string {
  const payload = neutralizeMd014(normalizeTabs(rawPayload));
  const marker = "`".repeat(Math.max(3, maxBacktickRun(payload) + 1));
  return `${marker}text\n${payload}\n${marker}`;
}

/** 行内代码跨度：动态反引号长度；内容以反引号开头/结尾时双边加单个空格内边距（f2 R2-2）。 */
export function inlineCodeSpan(text: string): string {
  const ticks = "`".repeat(maxBacktickRun(text) + 1);
  const needsPad = text.startsWith("`") || text.endsWith("`");
  return needsPad ? `${ticks} ${text} ${ticks}` : `${ticks}${text}${ticks}`;
}

/** 行内值载体：折叠换行、制表符归一化、去除首尾空白（MD038）；全空白值保留原样（f2 R2-2/R3-2）。 */
export function inlineValue(rawValue: string): string {
  let value = rawValue.replace(/\r\n|\r|\n/gu, " ");
  value = normalizeTabs(value);
  if (/[^\s]/u.test(value)) value = value.trim();
  return inlineCodeSpan(value);
}

/** 表格单元格值：行内值 + 管道符转义（MD056/MD055；f2 R2-3）。 */
export function tableCellValue(rawValue: string): string {
  return inlineValue(rawValue).replace(/\|/gu, "\\|");
}

/** 文档装配：段落之间恰一个空行、文件末尾恰一个换行（MD012/MD047；f2 R1-1/R1-2）。 */
export function assembleDocument(sections: readonly string[]): string {
  const normalized = sections
    .map((section) => section.replace(/\n+$/u, ""))
    .filter((section) => section.length > 0);
  return `${normalized.join("\n\n")}\n`;
}

// ------------------------- 共享派生事实（md 与 json 渲染器共用） -------------------------

/** 会话标题：取最后一个非空 `session/title` 事件的 title（无则为 null）。 */
export function findSessionTitle(file: DecodedSessionFile): string | null {
  let title: string | null = null;
  for (const event of file.decoded.events) {
    if (eventType(event) !== "session/title") continue;
    const value = readString(asRecord(event.data) ?? {}, "title");
    if (value !== undefined && value.length > 0) title = value;
  }
  return title;
}

/** 令牌用量汇总：只累计 `assistant/message` 事件自带的 usage。 */
export function sumUsage(file: DecodedSessionFile): {
  input: number;
  output: number;
  cacheRead: number;
  reasoning: number;
} {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let reasoning = 0;
  for (const event of file.decoded.events) {
    if (eventType(event) !== "assistant/message") continue;
    const usage = asRecord(asRecord(event.data)?.usage);
    if (usage === undefined) continue;
    input += readNumber(usage, "inputTokens") ?? 0;
    output += readNumber(usage, "outputTokens") ?? 0;
    cacheRead += readNumber(usage, "cacheReadTokens") ?? 0;
    reasoning += readNumber(usage, "reasoningTokens") ?? 0;
  }
  return { input, output, cacheRead, reasoning };
}

interface TurnSummary {
  readonly turn: number;
  readonly seq: number;
  readonly prompt: string | null;
  readonly response: string | null;
}

/** 轮次大纲数据：同一事件流在时间线与轮次大纲里必须归属同一轮次。 */
export function computeTurns(file: DecodedSessionFile): TurnSummary[] {
  const turns: TurnSummary[] = [];
  let current: {
    turn: number;
    seq: number;
    prompt: string | null;
    response: string | null;
  } | null = null;
  for (const event of file.decoded.events) {
    const type = eventType(event);
    const data = asRecord(event.data) ?? {};
    if (type === "turn/start") {
      const turn = readNumber(data, "turn") ?? turns.length + 1;
      current = { turn, seq: eventSeq(event) ?? -1, prompt: null, response: null };
      turns.push(current);
    } else if (type === "user/message" && current !== null && current.prompt === null) {
      const text = textFromBlocks(data.content);
      if (text.length > 0) current.prompt = text;
    } else if (type === "assistant/message" && current !== null) {
      const text = textFromBlocks(asRecord(data.message)?.content);
      if (text.length > 0) current.response = text;
    }
  }
  return turns;
}

/** 会话事件计数（KV 块、`--probe` 的消息数与摘要行共用同一份口径）。 */
export interface SessionEventStats {
  readonly turns: number;
  readonly steps: number;
  readonly toolCalls: number;
  readonly userMessages: number;
  readonly assistantMessages: number;
}

/** 会话事件计数：KV 块与 `--probe` 的"消息数"共用，保证头部与探测口径一致。 */
export function computeEventStats(file: DecodedSessionFile): SessionEventStats {
  let turns = 0;
  let steps = 0;
  let toolCalls = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  for (const event of file.decoded.events) {
    const type = eventType(event);
    if (type === "turn/start") turns += 1;
    else if (type === "step/start") steps += 1;
    else if (type === "tool/call") toolCalls += 1;
    else if (type === "user/message") userMessages += 1;
    else if (type === "assistant/message") assistantMessages += 1;
  }
  return { turns, steps, toolCalls, userMessages, assistantMessages };
}

/** 节点总数（含自身）：覆盖声明的作用域与本目标子树规模共用同一口径。 */
export function countNodes(node: SessionNode): number {
  let count = 1;
  for (const child of node.children) count += countNodes(child);
  return count;
}
