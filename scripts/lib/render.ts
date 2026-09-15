// 渲染层：Markdown（lint-safe）/JSON/JSONL 输出、可见性控制（推理/工具/事件）、截断、摘要文案。
// 输出格式为"实现与测试的单一真值源"（方案 v2 §3.9 / f2 报告 §4 R1–R5 为规则终稿）：
// - md：GFM 子集、结构骨架只用固定词表与工具生成值；任意文本只经两种载体承载——
//   多行文本 → 动态长度围栏（反引号 + `text` 语言）；单行文本 → 行内代码跨度（动态反引号）；
//   三条极小归一化：制表符 → 4 空格（MD010）、行内值首尾空白去除（MD038）、全 `$` 载荷
//   末尾追加一行单个空格（MD014）；正文以外的结构纪律见 assembleDocument 与各渲染函数注释。
// - json：JSON.stringify(value, null, 2) + 换行；
// - jsonl：首行逻辑 header，其后每行一个已解码事件（键序稳定）。
import {
  asArray,
  asRecord,
  type EventRecord,
  eventSeq,
  eventTime,
  eventType,
  readNumber,
  readString,
  reasoningFromBlocks,
  textFromBlocks,
  toolResultText,
} from "./decode.ts";
import { formatLocalIso } from "./paths.ts";
import type {
  CheckOutcome,
  DecodedSessionFile,
  FieldValue,
  ListEntry,
  ListOutcome,
  ModelView,
  SearchOutcome,
  SessionNode,
  SingleSessionStats,
  StatsOutcome,
  TokenTotals,
} from "./store.ts";

const TURN_SUMMARY_LIMIT = 200;
const EVENT_DATA_LIMIT = 200;
const METADATA_UNAVAILABLE_TEXT = "元数据不可用";
const EMPTY_VALUE = "-";
const SHORT_ID_LENGTH = 12;
const TAB_WIDTH = 4;

function shortSessionId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH);
}

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

function fieldValueText<T>(field: FieldValue<T>, render: (value: T) => string): string {
  if (field.unavailable) return METADATA_UNAVAILABLE_TEXT;
  if (field.value === null) return EMPTY_VALUE;
  return render(field.value);
}

function modelText(model: ModelView): string {
  return `${model.provider}/${model.model}`;
}

function tokenTotalsText(tokens: TokenTotals): string {
  return `${tokens.uncachedInputTokens}/${tokens.outputTokens}/${tokens.cacheReadTokens}/${tokens.cacheWriteTokens}`;
}

// ------------------------- lint-safe 渲染规则（f2 R1–R5） -------------------------

/** 最长连续反引号串长度（围栏/行内跨度定界依据）。 */
function maxBacktickRun(text: string): number {
  let max = 0;
  for (const match of text.matchAll(/`+/gu)) max = Math.max(max, match[0].length);
  return max;
}

/** 归一化 1：制表符 → 4 空格（MD010 覆盖围栏与行内代码；f2 R3-1）。 */
export function normalizeTabs(text: string): string {
  return text.replace(/\t/gu, " ".repeat(TAB_WIDTH));
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
function assembleDocument(sections: readonly string[]): string {
  const normalized = sections
    .map((section) => section.replace(/\n+$/u, ""))
    .filter((section) => section.length > 0);
  return `${normalized.join("\n\n")}\n`;
}

// ------------------------- list -------------------------

/** list Markdown：表格式精简列；--full 使用记录列表（含两空格缩进的续行；f2 R1-6/R2-4）。 */
export function renderListMd(
  outcome: ListOutcome,
  options: { readonly full: boolean },
): RenderedOutput {
  const sections: string[] = [];
  if (!options.full) {
    sections.push("# 会话列表");
    const titleCell = (entry: ListEntry): string =>
      entry.metadata.title.unavailable
        ? METADATA_UNAVAILABLE_TEXT
        : entry.metadata.title.value === null
          ? EMPTY_VALUE
          : tableCellValue(entry.metadata.title.value);
    const rows = outcome.entries.map((entry) => {
      const cells = [
        tableCellValue(entry.shortId),
        titleCell(entry),
        entry.workspaceTitle === null ? EMPTY_VALUE : tableCellValue(entry.workspaceTitle),
        formatLocalIso(entry.lastActivityAt),
        fieldValueText(entry.metadata.turns, String),
        entry.type === "subagent" ? "子" : "主",
        formatSize(entry.sizeBytes),
      ];
      return `| ${cells.join(" | ")} |`;
    });
    sections.push(
      [
        "| 短 ID | 标题 | 工作区 | 最近活动 | 轮次 | 类型 | 大小 |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        ...rows,
      ].join("\n"),
    );
  } else {
    sections.push("# 会话列表（完整）");
    for (const entry of outcome.entries) {
      const title = entry.metadata.title.unavailable
        ? METADATA_UNAVAILABLE_TEXT
        : entry.metadata.title.value === null
          ? EMPTY_VALUE
          : inlineValue(entry.metadata.title.value);
      const firstLine = `- ${inlineValue(entry.shortId)}：${title}（${entry.type === "subagent" ? "子" : "主"}）`;
      const detailLines = [
        `  **全 ID**：${inlineValue(entry.id)}`,
        `  **工作区**：${entry.workspaceTitle === null ? EMPTY_VALUE : inlineValue(entry.workspaceTitle)}`,
        `  **最近活动**：${formatLocalIso(entry.lastActivityAt)}`,
        `  **轮次**：${fieldValueText(entry.metadata.turns, String)}`,
        `  **大小**：${formatSize(entry.sizeBytes)}`,
        `  **创建**：${formatLocalIso(entry.createdAt)}`,
        `  **cwd**：${entry.cwd === null ? EMPTY_VALUE : inlineValue(entry.cwd)}`,
        `  **预设**：${fieldValueText(entry.metadata.agentPreset, (value) => inlineValue(value))}`,
        `  **模型**：${fieldValueText(entry.metadata.model, (model) => inlineValue(modelText(model)))}`,
        `  **令牌**：${fieldValueText(entry.metadata.tokens, tokenTotalsText)}`,
        `  **元数据**：${
          entry.metadata.available
            ? entry.metadata.reasons.length > 0
              ? "部分缺失"
              : "projcache"
            : "不可用"
        }`,
      ];
      sections.push(`${firstLine}\n${detailLines.join("\n")}`);
    }
  }
  sections.push(
    `合计：匹配 ${outcome.matchedCount} 个会话，显示 ${outcome.entries.length} 个（共扫描 ${outcome.scannedCount} 个）`,
  );
  if (outcome.hiddenBlankCount > 0) {
    sections.push(`已隐藏空会话 ${outcome.hiddenBlankCount} 个（--include-blank 显示）`);
  }
  for (const entry of outcome.entries) {
    if (entry.metadata.reasons.length > 0) {
      sections.push(
        `元数据不可用：${inlineValue(entry.id)}（${entry.metadata.reasons
          .map((reason) => inlineValue(reason))
          .join("；")}）`,
      );
    }
  }
  return {
    content: assembleDocument(sections),
    summary: `匹配会话 ${outcome.matchedCount} 个，显示 ${outcome.entries.length} 个`,
  };
}

function entryToJson(entry: ListEntry): Record<string, unknown> {
  return {
    id: entry.id,
    shortId: entry.shortId,
    type: entry.type,
    title: entry.metadata.title.value,
    cwd: entry.cwd,
    workspaceTitle: entry.workspaceTitle,
    createdAt: entry.createdAt,
    lastActivityAt: entry.lastActivityAt,
    lastPromptAt: entry.metadata.lastPromptAt.value,
    turns: entry.metadata.turns.value,
    steps: entry.metadata.steps.value,
    blank: entry.metadata.blank.value,
    agentPreset: entry.metadata.agentPreset.value,
    model: entry.metadata.model.value,
    tokens: entry.metadata.tokens.value,
    sizeBytes: entry.sizeBytes,
    metadata: { available: entry.metadata.available, reasons: entry.metadata.reasons },
  };
}

/** list JSON：{ sessions: [...] }，每项含全部列字段与元数据可用性标记。 */
export function renderListJson(outcome: ListOutcome): string {
  return `${JSON.stringify({ sessions: outcome.entries.map(entryToJson) }, null, 2)}\n`;
}

// ------------------------- show -------------------------

interface HiddenCounts {
  reasoning: number;
  tools: number;
  events: number;
}

function eventDataJson(event: EventRecord): string {
  const data = event.data;
  if (data === undefined) return "{}";
  try {
    return JSON.stringify(data);
  } catch {
    return "[不可序列化]";
  }
}

function findSessionTitle(file: DecodedSessionFile): string | null {
  let title: string | null = null;
  for (const event of file.decoded.events) {
    if (eventType(event) !== "session/title") continue;
    const value = readString(asRecord(event.data) ?? {}, "title");
    if (value !== undefined && value.length > 0) title = value;
  }
  return title;
}

function sumUsage(file: DecodedSessionFile): {
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

function computeTurns(file: DecodedSessionFile): TurnSummary[] {
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

interface SessionEventStats {
  readonly turns: number;
  readonly steps: number;
  readonly toolCalls: number;
}

function computeEventStats(file: DecodedSessionFile): SessionEventStats {
  let turns = 0;
  let steps = 0;
  let toolCalls = 0;
  for (const event of file.decoded.events) {
    const type = eventType(event);
    if (type === "turn/start") turns += 1;
    else if (type === "step/start") steps += 1;
    else if (type === "tool/call") toolCalls += 1;
  }
  return { turns, steps, toolCalls };
}

function optionalInline(valueText: string | undefined): string {
  return valueText === undefined ? EMPTY_VALUE : inlineValue(valueText);
}

/** show 头部 KV 块（一个多行段落；值经载体隔离；f2 R2-4）。 */
function nodeKvBlock(node: SessionNode): string {
  const header = node.file.decoded.header;
  const usage = sumUsage(node.file);
  const stats = computeEventStats(node.file);
  const title = findSessionTitle(node.file);
  const origin = readString(header, "origin");
  const lines: string[] = [
    `- ID：${inlineValue(node.entry.id)}`,
    `- 标题：${title === null ? EMPTY_VALUE : inlineValue(title)}`,
    `- 工作区：${optionalInline(readString(header, "cwd"))}`,
    `- 创建：${formatLocalIso(readNumber(header, "createdAt") ?? 0)}`,
  ];
  if (origin === "subagent") {
    lines.push("- 类型：子代理");
    lines.push(`- 父会话：${optionalInline(readString(header, "parentSession"))}`);
    lines.push(`- 深度：${String(readNumber(header, "delegationDepth") ?? EMPTY_VALUE)}`);
  } else {
    lines.push("- 类型：主会话");
  }
  lines.push(`- 预设：${optionalInline(readString(header, "agentPreset"))}`);
  lines.push(`- 日志：${inlineValue(node.entry.logPath)}`);
  lines.push(
    `- 规模：${formatSize(node.entry.sizeBytes)}；v${String(node.entry.logVersion)}；${node.file.frames} 帧；${node.file.decoded.lineCount} 行；${node.file.decoded.events.length} 事件`,
  );
  lines.push(`- 轮次：${stats.turns}；步数：${stats.steps}；工具调用：${stats.toolCalls}`);
  lines.push(
    `- 令牌：输入 ${usage.input}；输出 ${usage.output}；缓存读 ${usage.cacheRead}；推理 ${usage.reasoning}`,
  );
  const anomalyDetails = node.file.decoded.anomalies.map((anomaly) => inlineValue(anomaly.detail));
  if (anomalyDetails.length > 0) lines.push(`- 异常：${anomalyDetails.join("；")}`);
  return lines.join("\n");
}

/** 加粗标签行：禁止独立成段（MD036），恒以 `：` 收尾；--headers 时附 seq 与时间（f2 R1-4）。 */
function labelLine(base: string, event: EventRecord, headers: boolean): string {
  if (!headers) return `${base}：`;
  const seq = eventSeq(event);
  const time = eventTime(event);
  const timeText = time === undefined ? EMPTY_VALUE : formatLocalIso(time);
  return `${base}（seq ${seq === undefined ? EMPTY_VALUE : String(seq)}；${timeText}）：`;
}

function fencedItem(
  base: string,
  event: EventRecord,
  options: ShowMdOptions,
  payloadRaw: string,
): string[] {
  return [labelLine(base, event, options.headers), fenceBlock(payloadRaw)];
}

function renderTimelineMd(
  node: SessionNode,
  options: ShowMdOptions,
): { sections: string[]; hidden: HiddenCounts } {
  const sections: string[] = [];
  const hidden: HiddenCounts = { reasoning: 0, tools: 0, events: 0 };
  for (const event of node.file.decoded.events) {
    const type = eventType(event);
    const data = asRecord(event.data) ?? {};
    if (type === "user/message") {
      if (options.role === "assistant") continue;
      const text = textFromBlocks(data.content);
      if (text.length > 0) {
        sections.push(
          ...fencedItem("**用户**", event, options, truncateText(text, options.truncate)),
        );
      }
    } else if (type === "assistant/message") {
      if (options.role === "user") continue;
      const content = asRecord(data.message)?.content;
      const text = textFromBlocks(content);
      if (text.length > 0) {
        sections.push(
          ...fencedItem("**助手**", event, options, truncateText(text, options.truncate)),
        );
      }
      const reasoning = reasoningFromBlocks(content);
      if (reasoning.length > 0) {
        if (options.thinking) {
          sections.push(
            ...fencedItem("**推理**", event, options, truncateText(reasoning, options.truncate)),
          );
        } else {
          hidden.reasoning += 1;
        }
      }
    } else if (type === "tool/call") {
      if (options.tools) {
        const name = readString(data, "name") ?? EMPTY_VALUE;
        const argumentsText = readString(data, "arguments") ?? "";
        sections.push(
          ...fencedItem(
            `**工具调用**（${inlineValue(name)}）`,
            event,
            options,
            truncateText(argumentsText, options.truncate),
          ),
        );
      } else {
        hidden.tools += 1;
      }
    } else if (type === "tool/result") {
      if (options.tools) {
        const isError = asRecord(data.error) !== undefined;
        sections.push(
          ...fencedItem(
            `**工具结果**${isError ? "（错误）" : ""}`,
            event,
            options,
            truncateText(toolResultText(event), options.truncate),
          ),
        );
      } else {
        hidden.tools += 1;
      }
    } else if (type === "system/message") {
      if (options.events) {
        sections.push(
          ...fencedItem(
            "**系统消息**",
            event,
            options,
            truncateText(textFromBlocks(asRecord(data.message)?.content), options.truncate),
          ),
        );
      } else {
        hidden.events += 1;
      }
    } else if (options.events) {
      const payload = truncateText(eventDataJson(event), EVENT_DATA_LIMIT);
      sections.push(
        `${labelLine("**事件**", event, options.headers)}${inlineValue(type)} ${inlineValue(payload)}`,
      );
    } else {
      hidden.events += 1;
    }
  }
  return { sections, hidden };
}

function hiddenSummaryMd(hidden: HiddenCounts, options: ShowMdOptions): string {
  const parts: string[] = [];
  if (hidden.reasoning > 0) parts.push(`已隐藏 ${hidden.reasoning} 条推理内容（--thinking 显示）`);
  if (hidden.tools > 0) parts.push(`已隐藏 ${hidden.tools} 条工具调用/结果（--tools 显示）`);
  if (hidden.events > 0) parts.push(`已隐藏 ${hidden.events} 条生命周期事件（--events 显示）`);
  if (options.role !== null) parts.push(`已按 --role ${options.role} 过滤对话消息`);
  if (options.truncate > 0) parts.push(`文本已截断为 ${options.truncate} 字符`);
  return parts.length > 0 ? `摘要：${parts.join("；")}` : "";
}

function outlineSections(node: SessionNode, options: ShowMdOptions): string[] {
  const turns = computeTurns(node.file);
  if (turns.length === 0) return ["无"];
  return turns.map((turn) => {
    const prompt =
      turn.prompt === null
        ? EMPTY_VALUE
        : inlineValue(
            truncateText(turn.prompt.replaceAll("\n", " "), options.truncate || TURN_SUMMARY_LIMIT),
          );
    const response =
      turn.response === null
        ? EMPTY_VALUE
        : inlineValue(
            truncateText(
              turn.response.replaceAll("\n", " "),
              options.truncate || TURN_SUMMARY_LIMIT,
            ),
          );
    return `- T${turn.turn}（seq ${turn.seq}）：${prompt} → ${response}`;
  });
}

/**
 * 单节点渲染：KV 块 →（摘要模式）轮次大纲 /（默认）时间线 → 子代理块（H2 序列、路径编号唯一）。
 * 主节点区块为 H2，子节点内容为各自 H2 下的 H3（MD024 同级唯一由路径编号保证）。
 */
function renderNodeSections(
  node: SessionNode,
  options: ShowMdOptions,
  level: number,
  childPath: string,
): string[] {
  const sections: string[] = [nodeKvBlock(node)];
  if (options.summary) {
    sections.push(`${"#".repeat(level)} 轮次大纲`);
    sections.push(...outlineSections(node, options));
  } else {
    sections.push(`${"#".repeat(level)} 时间线`);
    const timeline = renderTimelineMd(node, options);
    sections.push(...timeline.sections);
    const summaryText = hiddenSummaryMd(timeline.hidden, options);
    if (summaryText.length > 0) sections.push(summaryText);
  }
  if (options.subagents) {
    node.children.forEach((child, index) => {
      const path = childPath.length === 0 ? String(index + 1) : `${childPath}.${index + 1}`;
      sections.push(`## 子代理 ${path}`);
      sections.push(...renderNodeSections(child, options, 3, path));
    });
  }
  return sections;
}

/** show Markdown：头部 KV + 时间线/轮次大纲；子代理可选追加。 */
export function renderShowMd(node: SessionNode, options: ShowMdOptions): RenderedOutput {
  const sections = ["# 会话记录", ...renderNodeSections(node, options, 2, "")];
  const stats = computeEventStats(node.file);
  const summary = options.summary
    ? `会话 ${shortSessionId(node.entry.id)}（摘要）；轮次 ${stats.turns} 个`
    : `会话 ${shortSessionId(node.entry.id)}；事件 ${node.file.decoded.events.length} 个` +
      (options.subagents ? `；子代理 ${countNodes(node) - 1} 个` : "");
  return { content: assembleDocument(sections), summary };
}

function countNodes(node: SessionNode): number {
  let count = 1;
  for (const child of node.children) count += countNodes(child);
  return count;
}

function buildMessageEntries(file: DecodedSessionFile): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const event of file.decoded.events) {
    const type = eventType(event);
    const data = asRecord(event.data) ?? {};
    if (type === "user/message") {
      entries.push({
        seq: eventSeq(event) ?? null,
        time: eventTime(event) ?? null,
        type,
        role: "user",
        source: readString(asRecord(data.source) ?? {}, "kind") ?? null,
        text: textFromBlocks(data.content),
      });
    } else if (type === "assistant/message") {
      const message = asRecord(data.message) ?? {};
      entries.push({
        seq: eventSeq(event) ?? null,
        time: eventTime(event) ?? null,
        type,
        role: "assistant",
        text: textFromBlocks(message.content),
        reasoning: reasoningFromBlocks(message.content),
        toolCalls: readToolCallBlocks(message.content),
      });
    } else if (type === "tool/call") {
      entries.push({
        seq: eventSeq(event) ?? null,
        time: eventTime(event) ?? null,
        type,
        role: "tool",
        callId: readString(data, "callId") ?? null,
        name: readString(data, "name") ?? null,
        arguments: readString(data, "arguments") ?? null,
      });
    } else if (type === "tool/result") {
      const message = asRecord(data.message) ?? {};
      const source = asRecord(message.source) ?? {};
      entries.push({
        seq: eventSeq(event) ?? null,
        time: eventTime(event) ?? null,
        type,
        role: "tool",
        callId: readString(source, "callId") ?? null,
        isError: asRecord(data.error) !== undefined,
        text: toolResultText(event),
      });
    } else if (type === "system/message") {
      entries.push({
        seq: eventSeq(event) ?? null,
        time: eventTime(event) ?? null,
        type,
        role: "system",
        text: textFromBlocks(asRecord(data.message)?.content),
      });
    }
  }
  return entries;
}

function readToolCallBlocks(content: unknown): Record<string, unknown>[] {
  const blocks = asArray(content) ?? [];
  const calls: Record<string, unknown>[] = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (record === undefined || readString(record, "type") !== "tool-call") continue;
    calls.push({
      id: readString(record, "id") ?? null,
      name: readString(record, "name") ?? null,
      arguments: readString(record, "arguments") ?? null,
    });
  }
  return calls;
}

function nodeToJson(node: SessionNode, includeMessages: boolean): Record<string, unknown> {
  const header = node.file.decoded.header;
  const usage = sumUsage(node.file);
  const stats = computeEventStats(node.file);
  return {
    session: {
      id: node.entry.id,
      title: findSessionTitle(node.file),
      cwd: readString(header, "cwd") ?? null,
      createdAt: readNumber(header, "createdAt") ?? null,
      parentSession: readString(header, "parentSession") ?? null,
      origin: readString(header, "origin") ?? null,
      delegationDepth: readNumber(header, "delegationDepth") ?? null,
      agentPreset: readString(header, "agentPreset") ?? null,
      isSeeded: header.isSeeded ?? null,
      logPath: node.entry.logPath,
      logSizeBytes: node.entry.sizeBytes,
      logVersion: node.entry.logVersion,
      logCompressed: node.entry.logCompressed,
    },
    meta: {
      version: readNumber(header, "version") ?? null,
      inheritedEventCount: node.file.decoded.inheritedEventCount,
      frames: node.file.frames,
      lines: node.file.decoded.lineCount,
      eventCount: node.file.decoded.events.length,
      turns: stats.turns,
      steps: stats.steps,
      toolCalls: stats.toolCalls,
      tokens: {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        reasoningTokens: usage.reasoning,
      },
      anomalies: node.file.decoded.anomalies.map((anomaly) => anomaly.detail),
    },
    turns: computeTurns(node.file).map((turn) => ({
      turn: turn.turn,
      seq: turn.seq,
      prompt: turn.prompt,
      response: turn.response,
    })),
    messages: includeMessages ? buildMessageEntries(node.file) : [],
    subagents: node.children.map((child) => nodeToJson(child, includeMessages)),
  };
}

/** show JSON：{ session, meta, turns, messages, subagents }（子代理为父子嵌套结构）。 */
export function renderShowJson(node: SessionNode, options: { readonly summary: boolean }): string {
  return `${JSON.stringify(nodeToJson(node, !options.summary), null, 2)}\n`;
}

/** show JSONL：首行逻辑 header，其后每行一个已解码事件（键序稳定）。 */
export function renderShowJsonl(node: SessionNode): RenderedOutput {
  const lines = [JSON.stringify(node.file.decoded.header)];
  for (const event of node.file.decoded.events) {
    lines.push(JSON.stringify(event));
  }
  return {
    content: `${lines.join("\n")}\n`,
    summary: `会话 ${shortSessionId(node.entry.id)}；事件 ${node.file.decoded.events.length} 个`,
  };
}

// ------------------------- search -------------------------

/** search Markdown：命中列表（单行载体）+ 全量总命中数（截断时标注）。 */
export function renderSearchMd(outcome: SearchOutcome): RenderedOutput {
  const sections = ["# 检索结果"];
  for (const hit of outcome.hits) {
    const seqText = hit.seq === null ? EMPTY_VALUE : String(hit.seq);
    sections.push(
      `- ${inlineValue(hit.shortId)}（seq ${seqText}）${inlineValue(hit.label)}：${inlineValue(hit.excerpt)}`,
    );
  }
  const truncatedNote = outcome.truncated ? `；已截断显示 ${outcome.hits.length} 条` : "";
  sections.push(`命中总数：${outcome.totalHits}${truncatedNote}`);
  return {
    content: assembleDocument(sections),
    summary: `命中 ${outcome.totalHits} 处，显示 ${outcome.hits.length} 处`,
  };
}

/** search JSON：{ matches, total, truncated }。 */
export function renderSearchJson(outcome: SearchOutcome): string {
  const document = {
    matches: outcome.hits.map((hit) => ({
      sessionId: hit.sessionId,
      seq: hit.seq,
      time: hit.time,
      label: hit.label,
      excerpt: hit.excerpt,
    })),
    total: outcome.totalHits,
    truncated: outcome.truncated,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

// ------------------------- stats -------------------------

/**
 * stats 命令级摘要（md 摘要行与 CLI json 路径共用，单一真值源）。
 * 不可用指标不再静默显 0：unavailable → `元数据不可用`、value=null → `-`；
 * 全局聚合的轮次/步数只累计可用值，未计入会话数显式附注（原因见输出文件）。
 */
export function formatStatsSummary(outcome: StatsOutcome): string {
  if (outcome.single !== null) {
    const single = outcome.single;
    const turns = single.turns.unavailable
      ? METADATA_UNAVAILABLE_TEXT
      : single.turns.value === null
        ? EMPTY_VALUE
        : String(single.turns.value);
    return `会话 ${shortSessionId(single.id)}；轮次 ${turns}；工具调用 ${single.toolCalls}`;
  }
  const excluded =
    outcome.excludedMetricSessions > 0
      ? `（${outcome.excludedMetricSessions} 个会话未计入，原因见输出文件）`
      : "";
  return `会话 ${outcome.sessionCount} 个；总轮次 ${outcome.turns}；工具调用 ${outcome.toolCalls}${excluded}`;
}

/** stats Markdown：全局=KV 列表；单会话=KV 列表。 */
export function renderStatsMd(outcome: StatsOutcome): RenderedOutput {
  const sections = ["# 统计"];
  if (outcome.single !== null) {
    const single: SingleSessionStats = outcome.single;
    sections.push(
      [
        `- 会话：${inlineValue(single.id)}`,
        `- 空会话：${fieldValueText(single.blank, (value) => (value ? "是" : "否"))}`,
        `- 轮次：${fieldValueText(single.turns, String)}`,
        `- 步数：${fieldValueText(single.steps, String)}`,
        `- 工具调用：${single.toolCalls}`,
        `- 令牌：未缓存输入 ${fieldValueText(single.tokens, (tokens) => String(tokens.uncachedInputTokens))}；输出 ${fieldValueText(single.tokens, (tokens) => String(tokens.outputTokens))}；缓存读 ${fieldValueText(single.tokens, (tokens) => String(tokens.cacheReadTokens))}；缓存写 ${fieldValueText(single.tokens, (tokens) => String(tokens.cacheWriteTokens))}`,
        `- 创建：${formatLocalIso(single.createdAt)}`,
        `- 最近活动：${formatLocalIso(single.lastActivityAt)}`,
        `- 标题：${fieldValueText(single.title, (value) => inlineValue(value))}`,
        `- 预设：${fieldValueText(single.agentPreset, (value) => inlineValue(value))}`,
        `- 模型：${fieldValueText(single.model, (model) => inlineValue(modelText(model)))}`,
        `- 日志：${inlineValue(single.logPath)}`,
        `- 大小：${formatSize(single.sizeBytes)}`,
      ].join("\n"),
    );
    if (single.metadataReasons.length > 0) {
      sections.push(
        `元数据不可用：${single.metadataReasons.map((reason) => inlineValue(reason)).join("；")}`,
      );
    }
    return {
      content: assembleDocument(sections),
      summary: formatStatsSummary(outcome),
    };
  }
  const earliest =
    outcome.earliestCreatedAt === null ? EMPTY_VALUE : formatLocalIso(outcome.earliestCreatedAt);
  const latest =
    outcome.latestActivityAt === null ? EMPTY_VALUE : formatLocalIso(outcome.latestActivityAt);
  sections.push(
    [
      `- 会话数：${outcome.sessionCount}`,
      `- 空会话数：${outcome.blankCount}`,
      `- 总轮次：${outcome.turns}`,
      `- 总步数：${outcome.steps}`,
      `- 工具调用总数：${outcome.toolCalls}`,
      `- 令牌-未缓存输入：${outcome.tokens.uncachedInputTokens}`,
      `- 令牌-输出：${outcome.tokens.outputTokens}`,
      `- 令牌-缓存读：${outcome.tokens.cacheReadTokens}`,
      `- 令牌-缓存写：${outcome.tokens.cacheWriteTokens}`,
      `- 时间跨度：${earliest} ~ ${latest}`,
      `- 日志总大小：${formatSize(outcome.totalSizeBytes)}`,
    ].join("\n"),
  );
  for (const unavailable of outcome.unavailable) {
    sections.push(
      `元数据不可用：${inlineValue(unavailable.id)}（${unavailable.reasons
        .map((reason) => inlineValue(reason))
        .join("；")}）`,
    );
  }
  return {
    content: assembleDocument(sections),
    summary: formatStatsSummary(outcome),
  };
}

/** stats JSON：global=聚合对象；single=单会话对象（字段值为 null 表示不可用/空）。 */
export function renderStatsJson(outcome: StatsOutcome): string {
  if (outcome.single !== null) {
    const single = outcome.single;
    const document = {
      kind: "single",
      session: {
        id: single.id,
        title: single.title.value,
        blank: single.blank.value,
        turns: single.turns.value,
        steps: single.steps.value,
        toolCalls: single.toolCalls,
        tokens: single.tokens.value,
        agentPreset: single.agentPreset.value,
        model: single.model.value,
        createdAt: single.createdAt,
        lastActivityAt: single.lastActivityAt,
        logPath: single.logPath,
        logVersion: single.logVersion,
        logCompressed: single.logCompressed,
        sizeBytes: single.sizeBytes,
        metadata: { available: single.metadataAvailable, reasons: single.metadataReasons },
      },
    };
    return `${JSON.stringify(document, null, 2)}\n`;
  }
  const document = {
    kind: "global",
    sessionCount: outcome.sessionCount,
    blankCount: outcome.blankCount,
    turns: outcome.turns,
    steps: outcome.steps,
    toolCalls: outcome.toolCalls,
    tokens: outcome.tokens,
    earliestCreatedAt: outcome.earliestCreatedAt,
    latestActivityAt: outcome.latestActivityAt,
    totalSizeBytes: outcome.totalSizeBytes,
    unavailable: outcome.unavailable,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

// ------------------------- check -------------------------

/** check Markdown：逐会话一条（异常详情同行）；结论段落。 */
export function renderCheckMd(outcome: CheckOutcome): RenderedOutput {
  const sections = ["# 完整性校验"];
  for (const session of outcome.sessions) {
    const seqText =
      session.seqContiguous === null ? EMPTY_VALUE : session.seqContiguous ? "连续" : "不连续";
    const fields = [
      `v=${session.formatVersion === null ? EMPTY_VALUE : String(session.formatVersion)}`,
      `结构=${session.structure}`,
      `帧=${session.frames === null ? EMPTY_VALUE : String(session.frames)}`,
      `行=${session.lineCount === null ? EMPTY_VALUE : String(session.lineCount)}`,
      `seq=${seqText}`,
      `坏行=${session.badLineCount}`,
      `异常=${session.anomalies.length}`,
    ];
    let line = `- ${inlineValue(session.id)}：${fields.join("；")}`;
    if (session.anomalies.length > 0) {
      line += `；异常详情：${session.anomalies.map((anomaly) => inlineValue(anomaly)).join("；")}`;
    }
    sections.push(line);
  }
  sections.push(
    outcome.anomalyCount === 0 ? "结论：无异常" : `结论：发现 ${outcome.anomalyCount} 项异常`,
  );
  return {
    content: assembleDocument(sections),
    summary: `会话 ${outcome.sessions.length} 个；异常 ${outcome.anomalyCount} 项`,
  };
}

/** check JSON：{ sessions, anomalyCount }。 */
export function renderCheckJson(outcome: CheckOutcome): string {
  const document = {
    sessions: outcome.sessions.map((session) => ({
      id: session.id,
      logPath: session.logPath,
      formatVersion: session.formatVersion,
      classification: session.classification,
      structure: session.structure,
      structureDetail: session.structureDetail,
      frames: session.frames,
      lines: session.lineCount,
      seqContiguous: session.seqContiguous,
      badLines: session.badLineCount,
      anomalies: session.anomalies,
    })),
    anomalyCount: outcome.anomalyCount,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
