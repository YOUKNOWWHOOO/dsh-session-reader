// 用途：交接（handoff）事件的判定、结构事实抽取与正文定位，供 show 的 Markdown 时间线产出
// `**交接**` 条目，并为 `**上下文摘要**`、`**交接通知**` 与 `**交接指令**` 提供事件与正文。
// 主要入口：`analyzeHandoffEvents`（结构事实条目、旧摘要投递、新交接通知、生成指令与抑制集合）。
// 关键依赖：decode.ts（事件读取基元）、deployment-text.ts（部署信封与交接摘要解析）、
// render-core.ts（空值显示文案）。
// 设计约束：
// 1. 判据只取日志字段，不做正文文案匹配：事件 `type` 为 `developer/message`、且
//    `data.message.source.kind` 为 `handoff`。
// 2. 两代交接格式并存。旧格式在交接事件后投递一条正文为 `<compacted-summary>` 的用户消息，
//    该正文与助手生成副本逐字相同，因此由投递消息渲染为 `**上下文摘要**` 并抑制助手副本。
//    新格式不再投递摘要正文，改为投递一条 `context-compacted` 注入通知，正文只含投影层路径与
//    读取要求；交接正文保留在 `assistant/message`，通知由 `**交接通知**` 单独承载，不抑制助手。
// 3. 旧投递判据：只把「来源为 `user`、正文剥离部署信封后恰好是完整 `<compacted-summary>` 信封」的
//    第一条用户消息认作投递；先遇到普通用户消息则判为「无投递」。
// 4. 新通知判据：交接事件之后、下一条交接事件之前的 `user/message`，来源为 `handoff`，且
//    注入起点行的 `kind` 为 `context-compacted`。先遇到真实用户消息即停止，禁止跨轮误认。
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
import {
  compactedSummaryBody,
  leadingInjectionKind,
  stripNestedMessageEnvelope,
} from "./deployment-text.ts";
import { EMPTY_VALUE } from "./render-core.ts";

/** `**交接**` 标签取值（对外契约，不得改写；标签词表因此由 12 个扩为 13 个）。 */
export const HANDOFF_LABEL = "交接";

/** 交接事件的来源种类取值（`data.message.source.kind`）。 */
export const HANDOFF_SOURCE_KIND = "handoff";

/** 交接事件的 `type` 取值。 */
const HANDOFF_EVENT_TYPE = "developer/message";

/** 交接投递事件的类型（`agent/inbox/spliced`）。 */
const HANDOFF_DELIVERY_EVENT_TYPE = "agent/inbox/spliced";

/**
 * 一次成功交接的投递事实：投递消息、投递目标与摘要内层正文。
 *
 * `event` 是随后落账的 `user/message`，它将由 `**上下文摘要**` 条目呈现正文；`body` 是
 * `<compacted-summary>` 信封的内层文本，用于与助手副本比对（相等才抑制助手副本）。
 */
export interface HandoffDelivery {
  readonly event: EventRecord;
  readonly target: string;
  readonly body: string;
}

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
  /** 交接正文；有投递消息时为空串（正文由 `**上下文摘要**` 承载），否则为交接事件自身正文。 */
  readonly body: string;
}

/** 一次交接生成请求的提示词消息。 */
export interface HandoffPrompt {
  /** 承载生成指令的 `user/message` 事件。 */
  readonly event: EventRecord;
  /** 指令正文（未截断；渲染层按 `--truncate` 处理）。 */
  readonly text: string;
}

/** 新格式交接在历史替换后投递的 `context-compacted` 通知。 */
export interface HandoffNotice {
  /** 承载通知的 `user/message` 事件。 */
  readonly event: EventRecord;
  /** 通知正文（已剥离注入信封；未截断）。 */
  readonly text: string;
}

/** 一次交接分析的全部产出：结构条目、旧投递、新通知、生成指令与应抑制的助手事件 seq。 */
export interface HandoffAnalysis {
  /** 交接事件 → 结构事实条目。 */
  readonly entries: ReadonlyMap<EventRecord, HandoffEntry>;
  /** 交接事件 → 旧格式投递消息。 */
  readonly deliveries: ReadonlyMap<EventRecord, HandoffDelivery>;
  /** 交接事件 → 新格式的 `context-compacted` 通知。 */
  readonly notices: ReadonlyMap<EventRecord, HandoffNotice>;
  /** 交接事件 → 生成交接摘要的提示词消息。 */
  readonly prompts: ReadonlyMap<EventRecord, HandoffPrompt>;
  /** 已由投递消息承载正文、不应再作为 `**助手**` 呈现的助手事件 seq。 */
  readonly suppressedAssistantSeqs: ReadonlySet<number>;
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
 * 一次交接的投递事实。
 *
 * 判据只取字段与登记的信封形态：从交接事件之后按事件顺序寻找第一条 `source.kind === "user"`
 * 的用户消息；把它的正文剥离部署信封（消息信封与注入信封）后是完整的 `<compacted-summary>` 信封，
 * 即为本次交接的投递消息。先遇到的其它来源（运行时上下文、技能目录、时间上下文等）跳过；先遇到
 * 一条普通用户消息（正文剥信封后不是该信封）则判为「无投递」，避免把用户自己粘贴的交接指令误认成
 * 插件投递。
 *
 * @param events 会话的已解码逻辑事件。
 * @param handoffIndex 交接事件在数组中的下标。
 * @returns 投递消息与目标；找不到时返回 null。
 */
function deliveryOf(events: readonly EventRecord[], handoffIndex: number): HandoffDelivery | null {
  let target = EMPTY_VALUE;
  for (let index = handoffIndex + 1; index < events.length; index += 1) {
    const event = events[index];
    if (isHandoffEvent(event)) return null;
    if (eventType(event) === HANDOFF_DELIVERY_EVENT_TYPE) {
      const candidate = readString(asRecord(event.data) ?? {}, "target");
      if (candidate !== undefined && candidate.length > 0) target = candidate;
      continue;
    }
    if (eventType(event) !== "user/message") continue;
    const data = asRecord(event.data) ?? {};
    const kind = readString(asRecord(data.source) ?? {}, "kind");
    // 注入类消息可能排在同一步的队列里；它们不是投递，继续向前找。
    if (kind !== "user") continue;
    // 部署侧给真实用户消息套了 `<dsh-message>`，投递消息的正文因此不再以 `<compacted-summary>` 开头。
    // 必须先剥掉这一层再判摘要信封，否则交接成功会被误判成「无投递」。
    const text = messageTextFromBlocks(data.content);
    const inner = compactedSummaryBody(text);
    if (inner === null) return null;
    // 内层是助手落账文本，带着 `<dsh-message role="assistant">` 与其被转义的终点；剥掉这一层残形，
    // 与助手副本比较的才是两侧的纯正文。
    return { event, target, body: stripNestedMessageEnvelope(inner) };
  }
  return null;
}

/**
 * 交接替换范围内的助手正文事件 seq。
 *
 * 优先取 `surfaceOp.endSeq`；缺失时从 `sourceEventSeqs` 末尾向前找。只作为候选：调用方还要
 * 核对它确实是 `assistant/message` 且正文与投递摘要逐字相同，才抑制该助手副本。
 */
function generationSeqCandidates(event: EventRecord): readonly number[] {
  const candidates: number[] = [];
  const surfaceOp = asRecord(event.surfaceOp);
  const endSeq = surfaceOp === undefined ? undefined : readNumber(surfaceOp, "endSeq");
  if (endSeq !== undefined) candidates.push(endSeq);
  const seqs = asArray(event.sourceEventSeqs);
  if (seqs !== undefined) {
    for (let index = seqs.length - 1; index >= 0; index -= 1) {
      const value = seqs[index];
      if (typeof value === "number") candidates.push(value);
    }
  }
  return candidates;
}

/**
 * 无投递时的正文定位：只认前一事件确实是 `assistant/message` 的形态。
 *
 * 向前找"最近的 assistant 消息"会把更早一轮的普通回答误认成本次交接的正文，那属于猜测补齐。
 */
function bodyLocatorOf(previous: EventRecord | undefined): string {
  if (previous === undefined || eventType(previous) !== "assistant/message") return EMPTY_VALUE;
  // 助手消息同样被部署侧套了 `<dsh-message>`；字符数按剥离后的正文计，否则回溯坐标会带上信封长度。
  const text = messageTextFromBlocks(asRecord(asRecord(previous.data)?.message)?.content);
  const seq = eventSeq(previous);
  if (seq === undefined) return EMPTY_VALUE;
  return `seq ${String(seq)}（${String(codePointsOf(text))} 字符）`;
}

/**
 * 交接生成正文所在的事件（助手消息）。
 *
 * 候选来自 `surfaceOp.endSeq` 与 `sourceEventSeqs` 的末尾；只接受 `assistant/message`。
 * 失败提交（例如被截断）也有生成正文，因此本函数不要求投递存在。
 */
function generationOf(
  event: EventRecord,
  eventsBySeq: ReadonlyMap<number, EventRecord>,
): { readonly seq: number; readonly event: EventRecord } | undefined {
  for (const candidate of generationSeqCandidates(event)) {
    const generation = eventsBySeq.get(candidate);
    if (generation !== undefined && eventType(generation) === "assistant/message") {
      return { seq: candidate, event: generation };
    }
  }
  return undefined;
}

/**
 * 生成交接摘要的提示词消息。
 *
 * 两代格式的可判定位置不同，因此先按新格式的标记判定，再退回旧格式的结构位置：
 * - 新格式：维护指令是来源 `handoff`、注入起点 `kind` 为 `handoff-instruction` 的注入消息。新格式的
 *   生成是多步骤过程（模型在生成阶段要读取真值源、改真值源、运行生成器），最终回复与维护指令之间
 *   隔着大量工具往返与后续步骤，**因此不能只看前一条事件**。判据改为从生成正文向前扫描到上一个
 *   交接事件为止，取最近的一条维护指令注入；注入标记是该格式自带的结构锚点，不依赖正文文案。
 * - 旧格式：维护指令没有注入标记，只能按结构位置认——生成正文的前一条事件是 `source.kind === "user"`
 *   且不带 `rpcId` 的用户消息。带 `rpcId` 的是客户端提交的真实用户输入，不得改标。
 *
 * 正文先剥离部署信封（注入信封与消息信封），再由渲染层按 `--truncate` 处理。
 */
function promptOf(
  events: readonly EventRecord[],
  generationIndex: number | undefined,
): HandoffPrompt | undefined {
  if (generationIndex === undefined || generationIndex <= 0) return undefined;
  // 新格式：向回扫描到上一个交接事件为止，取最近的维护指令注入。
  for (let index = generationIndex - 1; index >= 0; index -= 1) {
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
  // 旧格式：只认紧邻生成正文之前的那条无 rpcId 用户消息。
  const previous = events[generationIndex - 1];
  if (previous === undefined || eventType(previous) !== "user/message") return undefined;
  const previousData = asRecord(previous.data) ?? {};
  const previousSource = asRecord(previousData.source);
  if (previousSource === undefined) return undefined;
  if (readString(previousSource, "rpcId") !== undefined) return undefined;
  if (readString(previousSource, "kind") !== "user") return undefined;
  return { event: previous, text: messageTextFromBlocks(previousData.content) };
}

/**
 * 新格式交接替换历史后投递的 `context-compacted` 通知。
 *
 * 只扫到下一条交接事件为止；先遇到真实用户消息（来源 `user`）说明本轮没有通知，立即停止，
 * 禁止跨轮把后续交接的通知误认成本轮。`context-compacted` 的 kind 取自注入起点行，
 * 不按正文文案判定，也不把内部投射的正文当作普通用户输入。
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
      // 真实用户输入先出现，说明本轮没有投递通知；其它注入继续跳过。
      if (kind === "user") return null;
      continue;
    }
    if (leadingInjectionKind(textFromBlocks(data.content)) !== "context-compacted") continue;
    return { event, text: messageTextFromBlocks(data.content) };
  }
  return null;
}

/**
 * 从一批事件抽出交接条目、投递映射、生成指令与应抑制的助手副本。
 *
 * 单次遍历即可：投递判定需要向前扫描，但每个交接事件只扫描到下一交接或第一条普通用户消息，
 * 交接本身是低频事件，扫描成本可忽略。抑制集合只在「助手正文与投递摘要逐字相同」时加入，
 * 正文不一致时保留助手副本，避免隐藏真实内容。
 *
 * @param events 一个会话（或块）的全部已解码逻辑事件。
 * @returns 结构条目、投递映射、生成指令与助手副本抑制集合。
 */
export function analyzeHandoffEvents(events: readonly EventRecord[]): HandoffAnalysis {
  const entries = new Map<EventRecord, HandoffEntry>();
  const deliveries = new Map<EventRecord, HandoffDelivery>();
  const notices = new Map<EventRecord, HandoffNotice>();
  const prompts = new Map<EventRecord, HandoffPrompt>();
  const suppressedAssistantSeqs = new Set<number>();
  const eventsBySeq = new Map<number, EventRecord>();
  const indexBySeq = new Map<number, number>();
  for (let index = 0; index < events.length; index += 1) {
    const seq = eventSeq(events[index]);
    if (seq === undefined) continue;
    eventsBySeq.set(seq, events[index]);
    indexBySeq.set(seq, index);
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!isHandoffEvent(event)) continue;
    const data = asRecord(event.data) ?? {};
    const message = asRecord(data.message) ?? {};
    const generation = generationOf(event, eventsBySeq);
    const prompt = promptOf(
      events,
      generation === undefined ? undefined : indexBySeq.get(generation.seq),
    );
    if (prompt !== undefined) prompts.set(event, prompt);
    const notice = noticeOf(events, index);
    if (notice !== null) notices.set(event, notice);
    const delivery = deliveryOf(events, index);
    let deliveryLine: string;
    if (delivery === null) {
      deliveryLine = `投递 ${deliveryTargetOf(events[index + 1])}；正文 ${bodyLocatorOf(events[index - 1])}`;
    } else {
      deliveries.set(event, delivery);
      const deliverySeq = eventSeq(delivery.event);
      const locator =
        deliverySeq === undefined
          ? EMPTY_VALUE
          : `seq ${String(deliverySeq)}（${String(codePointsOf(delivery.body))} 字符）`;
      deliveryLine = `投递 ${delivery.target}；正文 ${locator}`;
      if (generation !== undefined) {
        // 比较的双方都取剥离部署信封后的正文：助手消息在落账时也被 `<dsh-message>` 包裹，
        // 直接比较原始拼接结果会恒不相等，助手副本因此永远不会被抑制。
        const text = messageTextFromBlocks(
          asRecord(asRecord(generation.event.data)?.message)?.content,
        );
        if (text === delivery.body) suppressedAssistantSeqs.add(generation.seq);
      }
    }
    const lines = [
      `轮次 ${numberText(readNumber(data, "turn"))}／步 ${numberText(readNumber(data, "step"))}`,
      `历史替换 ${replacementText(event)}`,
      deliveryLine,
    ];
    // 有投递时正文由 `**上下文摘要**` 承载，本条目只留结构事实；无投递时保留交接事件自身的
    // 正文（当前插件恒写空数组），由渲染层按 `--truncate` 处理，禁止静默丢弃。
    entries.set(event, {
      event,
      structure: lines.join("\n"),
      body: delivery === null ? textFromBlocks(message.content) : "",
    });
  }
  return { entries, deliveries, notices, prompts, suppressedAssistantSeqs };
}
