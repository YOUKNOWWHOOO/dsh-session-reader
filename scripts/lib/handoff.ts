// 用途：交接（handoff）事件的判定与结构事实抽取，供 show 的 Markdown 时间线产出 `**交接**` 条目。
// 主要入口：`analyzeHandoffEvents`（按事件身份索引的结构事实条目）。
// 关键依赖：decode.ts（asRecord/readNumber/readString/textFromBlocks/eventType/eventSeq）、
// render-core.ts（空值显示文案）、render-show-md.ts 的截断口径。
// 设计约束：
// 1. 判据只取日志字段，不做任何文本匹配：事件 `type` 为 `developer/message`、且
//    `data.message.source.kind` 为 `handoff`。正文文案变化不影响判定。
// 2. **不复制交接正文**。实测（本机全量会话日志）每次交接恒为三段式：
//    `assistant/message`（模型产出的交接正文）→ `developer/message`(handoff，正文为空、
//    承载 `surfaceOp: replace` 与 `sourceEventSeqs`) → `agent/inbox/spliced`（同一正文被
//    `<compacted-summary>` 包裹后再投递）。每一处 spliced 正文剥去包裹后都与 assistant 正文逐字相同，
//    因此本条目只给结构事实与正文定位（seq 与字符数），正文由同产物里既有的 `**助手**` 条目承载；
//    再把正文渲染一遍会让同一段内容在产物中出现两次（本次改动前由实测确认，见开发规范）。
// 3. 结构字段缺失不是载荷异常：按空值契约显示 `-`。与问答契约的差别在于——问答载荷是内容载体
//    （解析不出就问不出可读文本），交接结构是元数据（轮次、替换区间、投递目标），缺失只损失定位精度，
//    不应让整条 `show` 失败，也不应让该会话被排除出检索结论。
// 4. 本模块是这类内容在全技能范围内的单一真值源；md 渲染只消费这里的产出，禁止另行解析载荷。

import {
  asArray,
  asRecord,
  type EventRecord,
  eventSeq,
  eventType,
  readNumber,
  readString,
  textFromBlocks,
} from "./decode.ts";
import { EMPTY_VALUE } from "./render-core.ts";

/** `**交接**` 标签取值（对外契约，不得改写；标签词表因此由 12 个扩为 13 个）。 */
export const HANDOFF_LABEL = "交接";

/** 交接事件的来源种类取值（`data.message.source.kind`）。 */
export const HANDOFF_SOURCE_KIND = "handoff";

/** 交接事件的 `type` 取值。 */
const HANDOFF_EVENT_TYPE = "developer/message";

/** 交接正文的承载事件类型（模型产出的交接正文由它落账）。 */
const HANDOFF_BODY_EVENT_TYPE = "assistant/message";

/** 交接投递事件的类型（`agent/inbox/spliced`）。 */
const HANDOFF_DELIVERY_EVENT_TYPE = "agent/inbox/spliced";

/**
 * 单个交接事件的条目内容，拆成两段以便分别套用截断口径。
 *
 * 拆开的理由：结构事实是固定词表的元数据（轮次、替换区间、投递目标与正文定位），
 * 长度可控且是定位依据，套用 `--truncate` 只会把它截成读不出坐标的残句；
 * 而交接正文是可长可短的会话内容，必须与其它正文载体共用同一截断口径。
 */
export interface HandoffEntry {
  /** 该条目所属的事件对象本身；渲染层据此按事件身份取回，`--turn`/`--seq` 筛选因此天然生效。 */
  readonly event: EventRecord;
  /** 结构事实（多行固定词表），不受 `--truncate` 影响。 */
  readonly structure: string;
  /** 交接正文（当前插件恒写空数组，实测全部为空串），由渲染层按 `--truncate` 处理。 */
  readonly body: string;
}

/** 按 Unicode 码点计字符数（与 `truncateText` 的截断口径一致）。 */
function codePointsOf(value: string): number {
  return [...value].length;
}

/**
 * 交接事件判定。
 *
 * @param event 已解码的逻辑事件。
 * @returns 该事件是否为 `developer/message` 且来源种类为 `handoff`。
 */
export function isHandoffEvent(event: EventRecord): boolean {
  if (eventType(event) !== HANDOFF_EVENT_TYPE) return false;
  const message = asRecord(asRecord(event.data)?.message);
  if (message === undefined) return false;
  const source = asRecord(message.source);
  if (source === undefined) return false;
  return readString(source, "kind") === HANDOFF_SOURCE_KIND;
}

/** 数字字段的行内取值：缺失按空值契约显示 `-`。 */
function numberText(value: number | undefined): string {
  return value === undefined ? EMPTY_VALUE : String(value);
}

/**
 * 历史替换区间文本。
 *
 * `surfaceOp` 只登记 `replace` 一种形态（实测全部如此）；若换作其它操作或字段缺失，
 * 按空值契约显示 `-`，而不是把未知操作音译成"替换"——那会让产物把未登记的形态说成已登记的行为。
 */
function replacementText(event: EventRecord): string {
  const surfaceOp = asRecord(event.surfaceOp);
  if (surfaceOp === undefined) return EMPTY_VALUE;
  if (readString(surfaceOp, "op") !== "replace") return EMPTY_VALUE;
  const start = readNumber(surfaceOp, "startSeq");
  const end = readNumber(surfaceOp, "endSeq");
  if (start === undefined || end === undefined) return EMPTY_VALUE;
  const replaced = asArray(event.sourceEventSeqs);
  const countText = replaced === undefined ? EMPTY_VALUE : `${replaced.length} 条事件`;
  return `seq ${String(start)}-${String(end)}（${countText}）`;
}

/** 紧随事件的投递目标（`agent/inbox/spliced` 的 `data.target`）。 */
function deliveryTargetOf(event: EventRecord | undefined): string {
  if (event === undefined || eventType(event) !== HANDOFF_DELIVERY_EVENT_TYPE) return EMPTY_VALUE;
  return readString(asRecord(event.data) ?? {}, "target") ?? EMPTY_VALUE;
}

/**
 * 交接正文的定位信息：正文字符数与该正文所在事件的 seq。
 *
 * 只在前一事件确实是 `assistant/message` 时给出：向前找"最近的 assistant 消息"会把更早一轮的
 * 普通回答误认成本次交接的正文，那属于猜测补齐。实测交接正文都紧邻在前一个事件。
 */
function bodyLocatorOf(previous: EventRecord | undefined): string {
  if (previous === undefined || eventType(previous) !== HANDOFF_BODY_EVENT_TYPE) return EMPTY_VALUE;
  const text = textFromBlocks(asRecord(asRecord(previous.data)?.message)?.content);
  const seq = eventSeq(previous);
  if (seq === undefined) return EMPTY_VALUE;
  return `seq ${String(seq)}（${String(codePointsOf(text))} 字符）`;
}

/**
 * 从一批事件抽出交接条目（按事件身份索引）。
 *
 * 两遍式的必要性：条目文本同时引用前一事件（正文定位）与后一事件（投递目标），
 * 单事件上下文不足以判定两者，因此只在 `analyzeHandoffEvents` 内一次遍历完成邻接判定，
 * 调用方按事件对象取回即可。
 *
 * Args:
 *   events: 一个会话（或块）的全部已解码逻辑事件。
 *
 * Returns:
 *   事件对象到交接条目的映射；非交接事件不出现在映射里。
 */
export function analyzeHandoffEvents(
  events: readonly EventRecord[],
): ReadonlyMap<EventRecord, HandoffEntry> {
  const entries = new Map<EventRecord, HandoffEntry>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!isHandoffEvent(event)) continue;
    const data = asRecord(event.data) ?? {};
    const message = asRecord(data.message) ?? {};
    const lines = [
      `轮次 ${numberText(readNumber(data, "turn"))}／步 ${numberText(readNumber(data, "step"))}`,
      `历史替换 ${replacementText(event)}`,
      `投递 ${deliveryTargetOf(events[index + 1])}；正文 ${bodyLocatorOf(events[index - 1])}`,
    ];
    // 正文非空时单独返回，由渲染层按 `--truncate` 处理：当前插件恒写空数组（实测全部为空），
    // 但契约允许非空，静默丢弃会与"禁止静默丢内容"冲突；结构行不掺正文，避免正文混进固定词表的元数据。
    entries.set(event, {
      event,
      structure: lines.join("\n"),
      body: textFromBlocks(message.content),
    });
  }
  return entries;
}
