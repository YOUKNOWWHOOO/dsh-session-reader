// 用途：交接（handoff）事件的判定、结构事实抽取与交接通知、维护指令的定位，供 show 的 Markdown
// 时间线产出 `**交接**` 条目，并为 `**交接通知**` 与 `**交接指令**` 提供事件与正文。
// 主要入口：`analyzeHandoffEvents`（结构事实条目、交接通知与维护指令）。
// 关键依赖：decode.ts（事件读取基元）、deployment-text.ts（注入起点类别读取）、
// render-core.ts（空值显示文案）。
// 设计约束：
// 1. 判据只取日志字段，不做正文文案匹配：事件 `type` 为 `developer/message`、且
//    `data.message.source.kind` 为 `handoff`。
// 2. 只支持当前交接格式：交接事件之后投递一条 `context-compacted` 注入通知，通知正文给出交接文件的
//    位置与读取要求。交接内容以该通知所指的文件为准，交接事件与通知本身都不承载文件全文；本技能
//    不自动读取该文件，也不重建它的历史。助手事件仍按普通助手消息呈现，不做任何抑制。
// 3. 通知判据：交接事件之后、下一条交接事件之前的 `user/message`，来源为 `handoff`，且
//    注入起点行的 `kind` 为 `context-compacted`。先遇到真实用户消息即停止，禁止跨轮误认。
// 4. 维护指令判据：从交接事件向前扫描到上一个交接事件为止，取最近一条来源为 `handoff`、注入起点行
//    `kind` 为 `handoff-instruction` 且不带 `rpcId` 的用户消息（生成阶段会跨多步工具往返，
//    指令与交接事件并不相邻）。
// 5. 结构字段缺失不是载荷异常：按空值契约显示 `-`，不让整条 `show` 失败。
// 6. 本模块是这类内容在全技能范围内的单一真值源；md 渲染只消费这里的产出，禁止另行解析载荷。

import {
  asArray,
  asRecord,
  type EventRecord,
  eventSeq,
  eventType,
  messageTextFromBlocks,
  readNumber,
  readString,
  textFromBlocks,
} from "./decode.ts";
import { leadingInjectionKind } from "./deployment-text.ts";
import { EMPTY_VALUE } from "./render-core.ts";

/** `**交接**` 标签取值（对外契约，不得改写；该条目使标签词表新增一个取值）。 */
export const HANDOFF_LABEL = "交接";

/** 交接事件的来源种类取值（`data.message.source.kind`）。 */
export const HANDOFF_SOURCE_KIND = "handoff";

/** 交接事件的 `type` 取值。 */
const HANDOFF_EVENT_TYPE = "developer/message";

/**
 * 单个交接事件的条目内容。
 *
 * 条目只有结构事实这一段：它是固定词表的元数据（轮次、替换区间、前置助手消息与交接通知的定位），
 * 长度可控且是回溯依据，因此不套用 `--truncate`（截断后读不出坐标）。交接内容以通知所指的文件为准，
 * 本条目不承载它，渲染层也不得据结构推断文件内容。
 */
export interface HandoffEntry {
  /** 该条目所属的事件对象本身；渲染层据此按事件身份取回，`--turn`/`--seq` 筛选因此天然生效。 */
  readonly event: EventRecord;
  /** 结构事实（三行固定词表），不受 `--truncate` 影响。 */
  readonly structure: string;
}

/** 一次交接生成请求的提示词消息。 */
export interface HandoffPrompt {
  /** 承载维护指令的 `user/message` 事件。 */
  readonly event: EventRecord;
  /** 指令正文（未截断；渲染层按 `--truncate` 处理）。 */
  readonly text: string;
}

/** 交接在历史替换后投递的 `context-compacted` 通知。 */
export interface HandoffNotice {
  /** 承载通知的 `user/message` 事件。 */
  readonly event: EventRecord;
  /** 通知正文（已剥离注入信封；未截断）。 */
  readonly text: string;
}

/** 交接分析的全部产出：结构事实条目、交接通知与维护指令。 */
export interface HandoffAnalysis {
  /** 交接事件 → 结构事实条目。 */
  readonly entries: ReadonlyMap<EventRecord, HandoffEntry>;
  /** 交接事件 → `context-compacted` 通知。 */
  readonly notices: ReadonlyMap<EventRecord, HandoffNotice>;
  /** 交接事件 → 生成交接文件的维护指令消息。 */
  readonly prompts: ReadonlyMap<EventRecord, HandoffPrompt>;
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
 * 按空值契约显示 `-`，而不是把未知操作音译成"替换"，那会让产物把未登记的形态说成已登记的行为。
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

/**
 * 前置助手消息的定位：只认紧邻交接事件之前的那一条 `assistant/message`。
 *
 * 交接条目只给回溯坐标、不复述内容：交接内容在通知所指的文件里，这条助手消息本身仍作为普通
 * `**助手**` 条目呈现。向前搜索"最近的助手消息"会把更早一轮的普通回答误认成本次交接的前置消息，
 * 那属于猜测补齐，因此这里只看紧邻的前一条事件。
 */
function precedingAssistantLocatorOf(previous: EventRecord | undefined): string {
  if (previous === undefined || eventType(previous) !== "assistant/message") return EMPTY_VALUE;
  // 助手消息同样被部署侧套了 `<dsh-message>`；字符数按剥离后的正文计，否则回溯坐标会带上信封长度。
  const text = messageTextFromBlocks(asRecord(asRecord(previous.data)?.message)?.content);
  const seq = eventSeq(previous);
  if (seq === undefined) return EMPTY_VALUE;
  return `seq ${String(seq)}（${String(codePointsOf(text))} 字符）`;
}

/** 交接通知的定位：给出承载通知的消息 seq；没有识别到通知时显示空值 `-`。 */
function noticeLocatorOf(notice: HandoffNotice | null): string {
  if (notice === null) return EMPTY_VALUE;
  const seq = eventSeq(notice.event);
  return seq === undefined ? EMPTY_VALUE : `seq ${String(seq)}`;
}

/**
 * 生成交接文件的维护指令消息。
 *
 * 判据只取字段与注入标记：从交接事件向前扫描到上一个交接事件为止，取最近一条来源为 `handoff`、
 * 注入起点行 `kind` 为 `handoff-instruction` 且不带 `rpcId` 的用户消息。生成阶段要读真值源、改真值源
 * 并跨多步工具往返，最终回复与维护指令并不相邻，因此不能只看前一条事件；注入标记是该格式自带的
 * 结构锚点，不依赖正文文案。带 `rpcId` 的是客户端提交的真实用户输入，不得改标。
 *
 * 正文先剥离部署信封（注入信封与消息信封），再由渲染层按 `--truncate` 处理。
 *
 * @param events 会话的已解码逻辑事件。
 * @param handoffIndex 交接事件在数组中的下标。
 * @returns 维护指令消息；扫描到上一个交接事件仍未命中时返回 undefined。
 */
function promptOf(events: readonly EventRecord[], handoffIndex: number): HandoffPrompt | undefined {
  for (let index = handoffIndex - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (isHandoffEvent(event)) return undefined;
    if (eventType(event) !== "user/message") continue;
    const data = asRecord(event.data) ?? {};
    const source = asRecord(data.source);
    if (source === undefined) continue;
    if (readString(source, "kind") !== HANDOFF_SOURCE_KIND) continue;
    if (readString(source, "rpcId") !== undefined) continue;
    if (leadingInjectionKind(textFromBlocks(data.content)) !== "handoff-instruction") continue;
    return { event, text: messageTextFromBlocks(data.content) };
  }
  return undefined;
}

/**
 * 交接替换历史后投递的 `context-compacted` 通知。
 *
 * 通知正文给出交接文件的位置与读取要求，本身不是交接内容，也不是用户输入。
 * 只扫到下一条交接事件为止；先遇到真实用户消息（来源 `user`）说明本轮没有通知，立即停止，
 * 禁止跨轮把后续交接的通知误认成本轮。`context-compacted` 的 kind 取自注入起点行，不按正文文案判定。
 *
 * @param events 已解码逻辑事件。
 * @param handoffIndex 交接事件在数组中的下标。
 * @returns 通知事件与正文；没有通知时返回 null。
 */
function noticeOf(events: readonly EventRecord[], handoffIndex: number): HandoffNotice | null {
  for (let index = handoffIndex + 1; index < events.length; index += 1) {
    const event = events[index];
    if (isHandoffEvent(event)) return null;
    if (eventType(event) !== "user/message") continue;
    const data = asRecord(event.data) ?? {};
    const kind = readString(asRecord(data.source) ?? {}, "kind");
    if (kind !== HANDOFF_SOURCE_KIND) {
      // 真实用户输入先出现，说明本轮没有通知；其它注入继续跳过。
      if (kind === "user") return null;
      continue;
    }
    if (leadingInjectionKind(textFromBlocks(data.content)) !== "context-compacted") continue;
    return { event, text: messageTextFromBlocks(data.content) };
  }
  return null;
}

/**
 * 从一批事件抽出交接条目、交接通知与维护指令。
 *
 * 单次遍历即可，两类扫描的边界不同：通知向后扫描，遇下一条交接事件或真实用户消息即停止；
 * 维护指令向前回扫，只在再遇到上一个交接事件时停止，真实用户消息不构成它的边界。
 * 交接本身是低频事件，扫描成本可忽略。
 *
 * @param events 一个会话（或块）的全部已解码逻辑事件。
 * @returns 结构条目、通知映射与维护指令映射。
 */
export function analyzeHandoffEvents(events: readonly EventRecord[]): HandoffAnalysis {
  const entries = new Map<EventRecord, HandoffEntry>();
  const notices = new Map<EventRecord, HandoffNotice>();
  const prompts = new Map<EventRecord, HandoffPrompt>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!isHandoffEvent(event)) continue;
    const data = asRecord(event.data) ?? {};
    const prompt = promptOf(events, index);
    if (prompt !== undefined) prompts.set(event, prompt);
    const notice = noticeOf(events, index);
    if (notice !== null) notices.set(event, notice);
    // 三行结构事实：轮次与步、历史替换区间、前置助手消息与交接通知的定位。字段缺失一律显示空值，
    // 不让整条 show 失败（结构是元数据，缺失只损失定位精度）。
    const preceding = precedingAssistantLocatorOf(events[index - 1]);
    const noticeLocator = noticeLocatorOf(notice);
    const lines = [
      `轮次 ${numberText(readNumber(data, "turn"))}／步 ${numberText(readNumber(data, "step"))}`,
      `历史替换 ${replacementText(event)}`,
      `前置助手消息 ${preceding}；交接通知 ${noticeLocator}`,
    ];
    entries.set(event, { event, structure: lines.join("\n") });
  }
  return { entries, notices, prompts };
}
