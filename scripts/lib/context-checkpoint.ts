// 用途：合成上下文消息的判定与正文抽取——标准模式的官方压缩检查点、自定义模式交接的投递消息、
// 交接生成指令与子代理会话的首条任务消息。它们都不是人类用户输入，分别渲染为
// `**上下文摘要**`、`**交接指令**` 与 `**子代理任务**`，而不是伪装成 `**用户**` 正文。
// 主要入口：`analyzeContextCheckpoints`（按事件身份索引的合成条目 + 应抑制的助手副本 seq）。
// 关键依赖：decode.ts（事件读取基元与 `userMessageText`）、handoff.ts（交接投递、生成指令与抑制集合）。
// 设计约束：
// 1. 标准模式判据：`user/message` 的 `source.kind` 为 `compact-checkpoint`（官方
//    `compactCheckpointSource` 产出的固定标记），不依赖正文文案。
// 2. 自定义模式判据：由 handoff.ts 判定的投递消息与生成指令（来源均为 `user`，但结构位置不同：
//    投递消息在交接事件之后且正文是完整 `<compacted-summary>` 信封；生成指令是生成正文的前一条
//    无 `rpcId` 用户消息）。本模块不重复判定，只消费它的产出。
// 3. 子代理任务判据：会话 header 的 `origin` 为 `subagent`，且首条 `source.kind === "user"` 的消息
//    不带 `rpcId`。带 `rpcId` 的是客户端提交的真实用户输入，不标为任务。
// 4. 正文只呈现一次：标准检查点没有独立的助手副本；自定义交接的助手生成副本由 handoff.ts 在正文
//    逐字相同时列入抑制集合，md、json 与检索的 `text`/`tools` 档据此跳过。`--format jsonl` 仍保留
//    全部原始事件。
// 5. 这些合成条目的可见性不随 `--thinking`/`--tools`/`--events`/`--role` 改变（它们是上下文结构，
//    不是对话双方之一），也不计入任何隐藏计数；仍受 `--turn`/`--seq` 与 `--head`/`--tail` 影响。

import {
  asRecord,
  type EventRecord,
  eventSeq,
  eventType,
  readString,
  userMessageText,
} from "./decode.ts";
import type { HandoffAnalysis } from "./handoff.ts";

/** `**上下文摘要**` 标签取值（对外契约，不得改写）。 */
export const CONTEXT_CHECKPOINT_LABEL = "上下文摘要";

/** `**交接指令**` 标签取值（生成交接摘要的协议提示词）。 */
export const HANDOFF_PROMPT_LABEL = "交接指令";

/** `**子代理任务**` 标签取值（子代理会话的首条任务消息；与父会话的任务条目同名）。 */
export const SUBAGENT_TASK_LABEL = "子代理任务";

/** 标准模式官方压缩检查点的来源种类。 */
export const COMPACT_CHECKPOINT_KIND = "compact-checkpoint";

/** 单条上下文摘要条目。 */
export interface ContextCheckpoint {
  /** 承载摘要正文的事件对象；渲染层按事件身份取回，范围筛选因此天然生效。 */
  readonly event: EventRecord;
  /** 摘要正文（已剥离部署注入信封；标准检查点保留官方的检查点前言与标签）。 */
  readonly text: string;
}

/** 交接生成指令条目。 */
export interface HandoffPromptEntry {
  readonly event: EventRecord;
  readonly text: string;
}

/** 合成上下文消息的分析结果。 */
export interface ContextAnalysis {
  /** 摘要事件 → 条目。 */
  readonly checkpoints: ReadonlyMap<EventRecord, ContextCheckpoint>;
  /** 交接生成指令事件 → 条目。 */
  readonly handoffPrompts: ReadonlyMap<EventRecord, HandoffPromptEntry>;
  /** 子代理会话的首条任务消息；主会话或无法判定时为 null。 */
  readonly subagentTask: EventRecord | null;
  /** 已由摘要条目承载正文、不应再作为 `**助手**` 呈现的助手事件 seq。 */
  readonly suppressedAssistantSeqs: ReadonlySet<number>;
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
 * @param handoff 同一批事件的交接分析结果（提供投递消息、生成指令与助手副本抑制集合）。
 * @returns 摘要、生成指令、子代理任务与助手副本抑制集合。
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
  for (const delivery of handoff.deliveries.values()) {
    checkpoints.set(delivery.event, {
      event: delivery.event,
      text: userMessageText(delivery.event),
    });
  }
  const handoffPrompts = new Map<EventRecord, HandoffPromptEntry>();
  for (const prompt of handoff.prompts.values()) {
    handoffPrompts.set(prompt.event, prompt);
  }
  return {
    checkpoints,
    handoffPrompts,
    subagentTask: subagentTaskOf(header, events),
    suppressedAssistantSeqs: handoff.suppressedAssistantSeqs,
  };
}

/**
 * 摘要与生成指令事件对应的 prompt 跳过集合：`--summary` 的轮次大纲与 json 的 `turns` 不得把
 * 摘要正文或交接协议提示词当成用户提问。子代理任务不在此列——它就是该轮的任务来源。
 * 返回事件 seq 集合，供 `computeTurns` 使用。
 */
export function checkpointSeqsOf(analysis: ContextAnalysis): ReadonlySet<number> {
  const seqs = new Set<number>();
  for (const event of analysis.checkpoints.keys()) {
    const seq = eventSeq(event);
    if (seq !== undefined) seqs.add(seq);
  }
  for (const event of analysis.handoffPrompts.keys()) {
    const seq = eventSeq(event);
    if (seq !== undefined) seqs.add(seq);
  }
  return seqs;
}
