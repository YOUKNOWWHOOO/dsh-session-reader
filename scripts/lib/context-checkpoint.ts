// 用途：合成上下文消息的判定与正文抽取——标准模式的官方压缩检查点、自定义模式交接的旧摘要投递、
// 新格式交接通知、交接生成指令与子代理会话的首条任务消息。它们都不是人类用户输入，分别渲染为
// `**上下文摘要**`、`**交接通知**`、`**交接指令**` 与 `**子代理任务**`，而不是伪装成 `**用户**` 正文。
// 主要入口：`analyzeContextCheckpoints`（按事件身份索引的合成条目 + 应抑制的助手副本 seq）。
// 关键依赖：decode.ts（事件读取基元与 `userMessageText`）、handoff.ts（交接投递、通知、生成指令与
// 抑制集合）。
// 设计约束：
// 1. 标准模式判据：`user/message` 的 `source.kind` 为 `compact-checkpoint`（官方
//    `compactCheckpointSource` 产出的固定标记），不依赖正文文案。
// 2. 自定义模式旧格式：由 handoff.ts 判定的 `<compacted-summary>` 投递消息与生成指令；旧摘要正文
//    与助手副本相同时抑制副本。
// 3. 自定义模式新格式：交接后投递的 `context-compacted` 通知单独渲染为 `**交接通知**`，交接正文
//    保留在助手事件中，不抑制；生成指令由 handoff.ts 按结构位置判定。
// 4. 子代理任务判据：会话 header 的 `origin` 为 `subagent`，且首条 `source.kind === "user"` 的消息
//    不带 `rpcId`。带 `rpcId` 的是客户端提交的真实用户输入，不标为任务。
// 5. 这些合成条目的可见性不随 `--thinking`/`--tools`/`--events`/`--role` 改变（它们是上下文结构，
//    不是对话双方之一），也不计入任何隐藏计数；仍受 `--turn`/`--seq` 与 `--head`/`--tail` 影响。
//    新格式通知与生成指令的来源 `handoff` 已加入 visibility.ts 的保留名单，因此专门条目不会
//    在进入渲染前被当作普通注入丢弃。

import {
  asRecord,
  type EventRecord,
  eventSeq,
  eventType,
  readString,
  userMessageText,
} from "./decode.ts";
import { cleanCompactedSummary } from "./deployment-text.ts";
import type { HandoffAnalysis } from "./handoff.ts";

/** `**上下文摘要**` 标签取值（对外契约，不得改写）。 */
export const CONTEXT_CHECKPOINT_LABEL = "上下文摘要";

/** `**交接通知**` 标签取值（新格式交接投递的上下文压缩通知）。 */
export const HANDOFF_NOTICE_LABEL = "交接通知";

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
  /** 摘要正文（已剥离部署信封；标准检查点保留官方的检查点前言与标签）。 */
  readonly text: string;
}

/** 交接生成指令条目。 */
export interface HandoffPromptEntry {
  readonly event: EventRecord;
  readonly text: string;
}

/** 新格式交接的压缩通知条目。 */
export interface HandoffNoticeEntry {
  readonly event: EventRecord;
  readonly text: string;
}

/** 合成上下文消息的分析结果。 */
export interface ContextAnalysis {
  /** 摘要事件 → 条目。 */
  readonly checkpoints: ReadonlyMap<EventRecord, ContextCheckpoint>;
  /** 新格式交接通知事件 → 条目。 */
  readonly handoffNotices: ReadonlyMap<EventRecord, HandoffNoticeEntry>;
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
      // 旧交接投递的内层复制了助手落账文本，因此带着 `<dsh-message role="assistant">` 与其被转义的
      // 终点；清理这一层残形后再呈现，标签本身保留。
      text: cleanCompactedSummary(userMessageText(delivery.event)),
    });
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
    suppressedAssistantSeqs: handoff.suppressedAssistantSeqs,
  };
}

/**
 * 摘要、交接通知与生成指令事件对应的 prompt 跳过集合：`--summary` 的轮次大纲与 json 的 `turns`
 * 不得把这些合成消息当成用户提问。子代理任务不在此列——它就是该轮的任务来源。
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
