// 用途：默认参数下的"哪些事件进入产物"判定的唯一真值源——框架与插件自动注入的消息、框架事件、
// 工具调度回执一律不进默认产物；只有携带真实交流内容的消息才进。
// 主要入口：isInjectedUserMessage（注入消息判定）、isVisibleEvent（默认可见性判定）、
// collectSubagentReplyCallIds（子代理调用回执的识别集合）、injectedEventCount（排除计数）。
// 设计约束：
// 1. 判据只能是日志字段（`user/message` 的 `data.source.kind`、事件 type、`tool/call` 的 `name` 与
//    `callId`），禁止任何文本匹配。理由：同一注入换个文案就会漏；`<dsh-injection …>` 标签被
//    `tool-jobs`、`agent-message`、`subagent-settled` 三类共用；`<system-reminder>` 也可能出现在
//    用户本人输入里。凭标签或文案判定必然误判。
// 2. 保留名单是"白名单"：名单外的 `source.kind` 一律排除。框架与插件的来源种类是合并可扩展的
//    联合，黑名单必然漏掉未来新增的注入；白名单的失效方向是"新种类默认不显示"，属于安全方向。
// 3. 本模块只判定"默认是否可见"，不决定用户显式要求查看时（`--events`）是否出现——那是渲染层
//    与检索层的开关语义，两者都必须以本模块的判定为唯一依据，禁止各自另行判别。
import { asRecord, type EventRecord, eventType, readString } from "./decode.ts";

/**
 * 默认保留的 `user/message` 来源种类。
 *
 * 每一条的存在理由都是实测的数据形态，不是推测：
 * - `user`：用户本人的输入。
 * - `compact-checkpoint`：压缩产生的交接指令，携带被遮蔽区间的全部关键结论。
 * - `subagent-settled`：子代理结算回传，携带子代理的最终结论。
 * - `agent-message`：子代理或其它代理的中途发言。
 *
 * 其余已知来源（`runtime-context`、`skill-catalog`、`tool-jobs`、`model-selection`、
 * `user-question-reply`、`goal`、`schedule`、`webhook`、`session-reference`、`plugin`、`model`、
 * `tool`、`system-prompt`、`user-approval`、`ptc-mode`、`tool-registry`、`cordis-host-runner`、
 * `team-message`、`coordinator`、`subagent-report`、`skill-invocation`、`agent-instructions` 等）
 * 都是框架或插件为了运行而注入的状态提示与调度通知，不是交流内容，故不在名单内。
 */
export const KEPT_USER_MESSAGE_KINDS: readonly string[] = [
  "user",
  "compact-checkpoint",
  "subagent-settled",
  "agent-message",
];

/** 子代理调度工具名：它的调用实参携带发往子代理的任务正文，它的结果是一条回执。 */
export const SUBAGENT_TOOL_NAME = "subagent";

/** 主代理主动发消息给已存在子代理的工具名。 */
export const SEND_MESSAGE_TOOL_NAME = "send_message";

/** `user/message` 事件的来源种类（缺失、非字符串与空串一律返回 null）。 */
function userMessageSourceKind(event: EventRecord): string | null {
  const source = asRecord(asRecord(event.data)?.source);
  const kind = source === undefined ? undefined : readString(source, "kind");
  return kind === undefined || kind.length === 0 ? null : kind;
}

/**
 * 该 `user/message` 事件是否为框架或插件注入的消息。
 *
 * @param event 已解码的逻辑事件。
 * @returns 事件不是 `user/message` 时返回 false（判定只对这类事件有意义）；
 *          来源种类不在保留名单内时返回 true，包括来源缺失与空串——缺失来源的消息无法证明
 *          它来自用户或子代理，默认显示会把来源不明的注入呈现成用户消息。
 */
export function isInjectedUserMessage(event: EventRecord): boolean {
  if (eventType(event) !== "user/message") return false;
  const kind = userMessageSourceKind(event);
  return kind === null || !KEPT_USER_MESSAGE_KINDS.includes(kind);
}

/** `subagent` 工具调用的 `callId` 集合：其配对的 `tool/result` 是调度回执，不是子代理的回答。 */
export function collectSubagentReplyCallIds(events: readonly EventRecord[]): ReadonlySet<string> {
  const callIds = new Set<string>();
  for (const event of events) {
    if (eventType(event) !== "tool/call") continue;
    const data = asRecord(event.data);
    if (data === undefined || readString(data, "name") !== SUBAGENT_TOOL_NAME) continue;
    const callId = readString(data, "callId");
    if (callId !== undefined && callId.length > 0) callIds.add(callId);
  }
  return callIds;
}

/**
 * 该 `tool/result` 是否为子代理调度回执（正文形如 `started subagent <id>`）。
 *
 * 识别方式是 `toolCallId` 与某个 `subagent` 调用配对，而不是正文文案：文案随产品变化，
 * 配对关系是日志的结构事实。
 */
export function isSubagentReceipt(event: EventRecord, replyCallIds: ReadonlySet<string>): boolean {
  if (eventType(event) !== "tool/result") return false;
  const message = asRecord(asRecord(event.data)?.message);
  const callId = message === undefined ? undefined : readString(message, "toolCallId");
  return callId !== undefined && replyCallIds.has(callId);
}

/** 排除口径汇总：默认产物中被排除的事件总数，按类别分列以便摘要行逐项给出。 */
export interface InjectionsExcluded {
  /** 框架与插件注入的消息（`runtime-context`、`skill-catalog`、`tool-jobs`、`model-selection` 等）。 */
  readonly userMessages: number;
  /** 子代理调度回执（`started subagent <id>`）。 */
  readonly subagentReceipts: number;
}

/**
 * 该事件在默认参数下是否可见。
 *
 * 默认可见性只决定"不给任何显式开关时"的呈现；框架事件（`system/message`、`permission/preset`、
 * `subagent/catalog`、`step/start` 等）的隐藏仍由既有的 `--events` 分支负责，本函数不对它们
 * 重复判定——两处都判定会让同一事件出现"两个真值源"，一旦不一致就无从解释。
 *
 * @param event 已解码的逻辑事件。
 * @param replyCallIds 由 `collectSubagentReplyCallIds` 得到的回执识别集合。
 * @returns 注入消息与调度回执为 false，其余事件为 true。
 */
export function isVisibleEvent(event: EventRecord, replyCallIds: ReadonlySet<string>): boolean {
  if (isInjectedUserMessage(event)) return false;
  return !isSubagentReceipt(event, replyCallIds);
}

/**
 * 统计一批事件中被默认排除的注入与回执数量，供产物摘要行逐项声明。
 *
 * 必须给出计数的理由：调用方看不到被排除的内容，若连"排除了多少条"都没有，就无法判断产物
 * 是否经过过滤，也无法在需要时改用 `--events` 取回。
 */
export function countExcludedInjections(
  events: readonly EventRecord[],
  replyCallIds: ReadonlySet<string>,
): InjectionsExcluded {
  let userMessages = 0;
  let subagentReceipts = 0;
  for (const event of events) {
    if (isInjectedUserMessage(event)) userMessages += 1;
    else if (isSubagentReceipt(event, replyCallIds)) subagentReceipts += 1;
  }
  return { userMessages, subagentReceipts };
}
