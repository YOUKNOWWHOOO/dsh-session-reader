// 用途：合成上下文消息的判定与正文抽取，标准模式的官方压缩检查点、交接投递的压缩通知、交接维护指令、
// 子代理会话的首条任务消息，以及子代理创建与发往子代理两类工具调用的正文。它们都不是人类用户输入，
// 分别渲染为 `**上下文摘要**`、`**交接通知**`、`**交接指令**`、`**子代理任务**` 与
// `**发往子代理**`，而不是伪装成 `**用户**` 正文。
// 主要入口：`analyzeContextCheckpoints`（按事件身份索引的合成条目）、`extractSubagentCallContent`
// （子代理创建与发往子代理两类工具调用的可读正文，md 条目与检索单元的同一真值源）。
// 关键依赖：decode.ts（事件读取基元与 `userMessageText`）、handoff.ts（交接通知与维护指令）、
// visibility.ts（子代理创建工具名的唯一判据）。
// 设计约束：
// 1. 标准模式判据：`user/message` 的 `source.kind` 为 `compact-checkpoint`（官方
//    `compactCheckpointSource` 产出的固定标记），不依赖正文文案；正文保留官方检查点前言与
//    `<compacted-summary>` 标签，不做摘要信封解析。
// 2. 交接：交接后投递的 `context-compacted` 通知单独渲染为 `**交接通知**`；交接内容以该通知所指的
//    文件为准，通知与交接事件都不承载文件全文，本技能不自动读取该文件。助手事件因此按普通消息呈现、
//    不做任何抑制。维护指令由 handoff.ts 按来源与注入标记判定。
// 3. 子代理任务判据：会话 header 的 `origin` 为 `subagent`，且首条 `source.kind === "user"` 的消息
//    不带 `rpcId`。带 `rpcId` 的是客户端提交的真实用户输入，不标为任务。
// 4. 子代理工具调用的正文只从调用实参取：创建工具（`subagent`/`subagent_fork`）取 `prompt`，
//    `send_message` 取 `message`。工具名判据在 visibility.ts，本模块不维护工具名字面量。
// 5. 这些合成条目的可见性不随 `--thinking`/`--tools`/`--events`/`--role` 改变（它们是上下文结构，
//    不是对话双方之一），也不计入任何隐藏计数；仍受 `--turn`/`--seq` 与 `--head`/`--tail` 影响。
//    通知与维护指令的来源 `handoff` 已加入 visibility.ts 的保留名单，因此专门条目不会
//    在进入渲染前被当作普通注入丢弃。

import {
  asRecord,
  type EventRecord,
  eventSeq,
  eventType,
  readString,
  userMessageText,
} from "./decode.ts";
import type { HandoffAnalysis } from "./handoff.ts";
import { isSubagentCreationTool, SEND_MESSAGE_TOOL_NAME } from "./visibility.ts";

/** `**上下文摘要**` 标签取值（对外契约，不得改写）。 */
export const CONTEXT_CHECKPOINT_LABEL = "上下文摘要";

/** `**交接通知**` 标签取值（交接投递的上下文压缩通知）。 */
export const HANDOFF_NOTICE_LABEL = "交接通知";

/** `**交接指令**` 标签取值（生成交接文件的维护指令）。 */
export const HANDOFF_PROMPT_LABEL = "交接指令";

/** `**子代理任务**` 标签取值（子代理会话的首条任务消息，以及创建子代理的工具调用；同一对外名称）。 */
export const SUBAGENT_TASK_LABEL = "子代理任务";

/**
 * `**发往子代理**` 标签取值（`send_message` 工具调用的消息正文）。
 *
 * 与 `SUBAGENT_TASK_LABEL` 一起构成工具调用正文仅有的两个标签，取值由
 * `extractSubagentCallContent` 的返回类型引用，不在此之外另写一份字符串联合。
 */
const SEND_TO_SUBAGENT_LABEL = "发往子代理";

/** 标准模式官方压缩检查点的来源种类。 */
export const COMPACT_CHECKPOINT_KIND = "compact-checkpoint";

/** 单条上下文摘要条目。 */
export interface ContextCheckpoint {
  /** 承载摘要正文的事件对象；渲染层按事件身份取回，范围筛选因此天然生效。 */
  readonly event: EventRecord;
  /** 摘要正文（已剥离部署信封；标准检查点保留官方的检查点前言与标签）。 */
  readonly text: string;
}

/** 交接维护指令条目。 */
export interface HandoffPromptEntry {
  readonly event: EventRecord;
  readonly text: string;
}

/** 交接投递的压缩通知条目。 */
export interface HandoffNoticeEntry {
  readonly event: EventRecord;
  readonly text: string;
}

/**
 * 子代理相关工具调用的可读正文。
 *
 * 只承载普通数据，不承载任何 Markdown：标签由渲染层套成加粗标签行、正文由渲染层送进围栏载体，
 * 检索层直接用这两个字段建检索单元。这样同一份抽取同时服务 md 与 search，不需要各自解析实参。
 */
export interface SubagentCallContent {
  /** 工具调用的标签取值，只有两个来源（见 `SUBAGENT_TASK_LABEL` 与 `SEND_TO_SUBAGENT_LABEL`）。 */
  readonly label: typeof SUBAGENT_TASK_LABEL | typeof SEND_TO_SUBAGENT_LABEL;
  /** 展示括号里的附加信息（创建工具取 `description`，`send_message` 取 `agent_id`）；缺失时为 null。 */
  readonly annotation: string | null;
  /** 交流正文（创建工具取 `prompt`，`send_message` 取 `message`）。 */
  readonly text: string;
}

/** 合成上下文消息的分析结果。 */
export interface ContextAnalysis {
  /** 摘要事件 → 条目。 */
  readonly checkpoints: ReadonlyMap<EventRecord, ContextCheckpoint>;
  /** 交接通知事件 → 条目。 */
  readonly handoffNotices: ReadonlyMap<EventRecord, HandoffNoticeEntry>;
  /** 交接维护指令事件 → 条目。 */
  readonly handoffPrompts: ReadonlyMap<EventRecord, HandoffPromptEntry>;
  /** 子代理会话的首条任务消息；主会话或无法判定时为 null。 */
  readonly subagentTask: EventRecord | null;
}

/** `user/message` 的来源种类；缺失、非字符串与空串一律返回 null。 */
function sourceKindOf(event: EventRecord): string | null {
  const source = asRecord(asRecord(event.data)?.source);
  const kind = source === undefined ? undefined : readString(source, "kind");
  return kind === undefined || kind.length === 0 ? null : kind;
}

/**
 * 子代理会话的首条任务消息。
 *
 * 判据只取字段：header 的 `origin` 为 `subagent`，首条 `source.kind === "user"` 的消息不带 `rpcId`。
 * 带 `rpcId` 的是客户端提交的真实输入，遇到即停止判定（不再向后寻找），避免把后续真实消息标成任务。
 *
 * @param header 会话日志的逻辑 header。
 * @param events 会话的已解码逻辑事件。
 * @returns 任务消息；主会话、无候选或首个候选带 `rpcId` 时返回 null。
 */
function subagentTaskOf(
  header: Record<string, unknown>,
  events: readonly EventRecord[],
): EventRecord | null {
  if (readString(header, "origin") !== "subagent") return null;
  for (const event of events) {
    if (eventType(event) !== "user/message") continue;
    if (sourceKindOf(event) !== "user") continue;
    const source = asRecord(asRecord(event.data)?.source) ?? {};
    if (readString(source, "rpcId") !== undefined) return null;
    return event;
  }
  return null;
}

/**
 * 分析一个会话（或块）的合成上下文消息。
 *
 * @param header 会话日志的逻辑 header（用于判定子代理任务）。
 * @param events 会话的已解码逻辑事件。
 * @param handoff 同一批事件的交接分析结果（提供交接通知与维护指令）。
 * @returns 摘要条目、交接通知、维护指令与子代理任务。
 */
export function analyzeContextCheckpoints(
  header: Record<string, unknown>,
  events: readonly EventRecord[],
  handoff: HandoffAnalysis,
): ContextAnalysis {
  const checkpoints = new Map<EventRecord, ContextCheckpoint>();
  for (const event of events) {
    if (eventType(event) !== "user/message") continue;
    if (sourceKindOf(event) !== COMPACT_CHECKPOINT_KIND) continue;
    checkpoints.set(event, { event, text: userMessageText(event) });
  }
  const handoffNotices = new Map<EventRecord, HandoffNoticeEntry>();
  for (const notice of handoff.notices.values()) {
    handoffNotices.set(notice.event, { event: notice.event, text: notice.text });
  }
  const handoffPrompts = new Map<EventRecord, HandoffPromptEntry>();
  for (const prompt of handoff.prompts.values()) {
    handoffPrompts.set(prompt.event, prompt);
  }
  return {
    checkpoints,
    handoffNotices,
    handoffPrompts,
    subagentTask: subagentTaskOf(header, events),
  };
}

/**
 * 摘要、交接通知与维护指令事件对应的 prompt 跳过集合：`--summary` 的轮次大纲与 json 的 `turns`
 * 不得把这些合成消息当成用户提问。子代理任务不在此列，它就是该轮的任务来源。
 * 返回事件 seq 集合，供 `computeTurns` 使用。
 */
export function checkpointSeqsOf(analysis: ContextAnalysis): ReadonlySet<number> {
  const seqs = new Set<number>();
  for (const event of analysis.checkpoints.keys()) {
    const seq = eventSeq(event);
    if (seq !== undefined) seqs.add(seq);
  }
  for (const event of analysis.handoffNotices.keys()) {
    const seq = eventSeq(event);
    if (seq !== undefined) seqs.add(seq);
  }
  for (const event of analysis.handoffPrompts.keys()) {
    const seq = eventSeq(event);
    if (seq !== undefined) seqs.add(seq);
  }
  return seqs;
}

/**
 * 解析 `tool/call` 的实参 JSON。
 *
 * `arguments` 由官方库解码成 JSON 字符串，解析失败或顶层不是普通对象时返回 null：调用方据此让该
 * 调用退回普通工具条目（`--tools` 仍能看到原始实参），异常因此可定位，而不是被伪装成一条正常消息。
 *
 * @param data `tool/call` 事件的 `data`。
 * @returns 解析出的对象；缺失、空串、非法 JSON 或非普通对象时返回 null。
 */
function parseCallArguments(data: Record<string, unknown>): Record<string, unknown> | null {
  const raw = readString(data, "arguments");
  if (raw === undefined || raw.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return asRecord(value) ?? null;
}

/**
 * 子代理相关工具调用的可读正文。
 *
 * 覆盖两类工具：创建子代理（`subagent`/`subagent_fork`，正文取 `prompt`、附加信息取 `description`）
 * 与 `send_message`（正文取 `message`、附加信息取 `agent_id`）。创建工具的判定调用
 * `visibility.ts` 的 `isSubagentCreationTool`，与回执排除共用同一判据，不在这里另写工具名。
 *
 * 正文为空、实参缺失或无法解析时返回 null，由调用方退回普通工具条目；这与该函数存在之前的行为
 * 一致，不另设兜底文案。`send_message` 只是发消息给已存在的子代理，它的配对结果不是创建回执。
 *
 * @param event 已解码的逻辑事件。
 * @returns 标签、展示括号附加信息与正文；不适用时返回 null。
 */
export function extractSubagentCallContent(event: EventRecord): SubagentCallContent | null {
  const data = asRecord(event.data);
  if (data === undefined) return null;
  const name = readString(data, "name");
  const isCreation = isSubagentCreationTool(name);
  if (!isCreation && name !== SEND_MESSAGE_TOOL_NAME) return null;
  const parsed = parseCallArguments(data);
  if (parsed === null) return null;
  if (isCreation) {
    const prompt = readString(parsed, "prompt") ?? "";
    if (prompt.length === 0) return null;
    return {
      label: SUBAGENT_TASK_LABEL,
      annotation: readString(parsed, "description") ?? null,
      text: prompt,
    };
  }
  const message = readString(parsed, "message") ?? "";
  if (message.length === 0) return null;
  return {
    label: SEND_TO_SUBAGENT_LABEL,
    annotation: readString(parsed, "agent_id") ?? null,
    text: message,
  };
}
