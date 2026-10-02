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
 * 每一条的存在理由都是实测或官方契约的数据形态，不是推测：
 * - `user`：用户本人的输入。
 * - `compact-checkpoint`：压缩产生的交接指令，携带被遮蔽区间的全部关键结论。
 * - `subagent-settled`：子代理结算回传，携带子代理的最终结论。
 * - `agent-message`：子代理或其它代理的中途发言。
 * - `user-question-reply`：用户对 `ask_user_question` 的**延迟回答**（提问仍在等待时用户之后作答），
 *   由 `dsh-user-questions` 以答案批次注入。保留的理由是它可能承载**唯一**的答案记录：
 *   官方契约里这个消息的内容与当场答复的工具结果同格式（`{ answers: [{ id, selected, custom }] }`，
 *   见 dsh-user-questions 的 `answerBatchSchema`），而提问在等待中被中止、取消或超时时不会产生
 *   配对的 `tool/result`，此时本技能不产出 `**回答**` 条目，答案只在这条消息里。代价是当配对结果
 *   确实存在时，同一答案会在产物中出现两次（回答条目一次、本条消息一次）——重复是可接受的代价，
 *   丢失不可接受。
 *
 * 其余来源一律排除，包括下列已知取值（按包列举；本列表不构成完整声明，白名单之外的取值
 * 全部排除，新增种类无需改判据即正确排除）：
 * - 运行时状态提示：`runtime-context`（dsh-agent-loop）、`time-context`、`tmux-context`、
 *   `model-selection`（dsh-agent）、`tool-registry` 与 `ptc-mode`（dsh-tools）、
 *   `plan-mode`、`repeat-tool-reminder`（重复调用提醒）。
 * - 调度与通知：`tool-jobs`（后台任务完成）、`schedule`、`webhook`、`goal` 与 `tool-goal`、
 *   `user-approval`（审批策略与请求）、`cordis-host-runner`。
 * - 目录与指令注入：`skill-catalog`、`skill-invocation`、`agent-instructions`（工作区指令文件）。
 * - 外部工具与钩子：`hooks-claude-code`、`hooks-codex`、`dsh-session-title-llm`。
 * - 基础成员与历史取值：`plugin`、`model`、`tool`、`system-prompt`、`session-reference`、
 *   `team-message`、`coordinator`、`subagent-report`。
 *
 * 判据是 `kind` 字段而非来源声明的成员名：官方声明里的成员 `user-rpc`（浏览器端用户输入）
 * 其 `kind` 值就是 `'user'`，因此已被保留名单覆盖，无需单列。
 */
export const KEPT_USER_MESSAGE_KINDS: readonly string[] = [
  "user",
  "compact-checkpoint",
  "subagent-settled",
  "agent-message",
  "user-question-reply",
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
