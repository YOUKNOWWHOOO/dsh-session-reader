// 用途：默认参数下"哪些事件进入产物"的唯一真值源。默认排除三类：框架与插件注入、子代理调度回执、
// 结构化代理通信。通信开关控制第三类；开关关闭时 `--tools` 不恢复通信，打开时发送结果仍由 `--tools` 控制。
// 主要入口：buildDefaultViewFilter、defaultExclusionOf、projectAssistantContent 与排除计数。
// 设计约束：
// 1. 判据只能是日志字段（`user/message` 的 `data.source.kind`、事件 type、普通工具与 PTC 子调用的
//    名称和配对标识），禁止任何文本匹配。理由：同一注入换个文案就会漏；`<dsh-injection …>` 由多种注入
//    共用（类别集合随部署扩展），`<dsh-result …>` 只出现在工具结果上；`<system-reminder>` 也可能
//    出现在用户本人输入里。凭标签或文案判定必然误判。
// 2. 保留名单是"白名单"：名单外的 `source.kind` 一律排除。框架与插件的来源种类是合并可扩展的
//    联合，黑名单必然漏掉未来新增的注入；白名单的失效方向是"新种类默认不显示"，属于安全方向。
// 3. 本模块只判定"默认是否可见"，不决定用户显式要求查看时（`--events`）是否出现，那是渲染层
//    与检索层的开关语义，两者都必须以本模块的判定为唯一依据，禁止各自另行判别。
import {
  asRecord,
  type EventRecord,
  eventType,
  isToolCallEvent,
  isToolResultEvent,
  messageTextFromBlocks,
  readString,
  reasoningFromBlocks,
  type ToolCallBlock,
  textFromBlocks,
  toolCallsFromBlocks,
  toolEventCallId,
} from "./decode.ts";

/**
 * 不作为一般注入排除的 `user/message` 来源种类；代理来源另受通信开关控制。
 *
 * 每一条的存在理由都是实测或官方契约的数据形态，不是推测：
 * - `user`：用户本人的输入。
 * - `compact-checkpoint`：标准模式官方压缩产生的检查点（`standard` 预设唯一的上下文替换形态）。
 *   本名单只决定它不被判为注入；它由渲染层呈现为 `**上下文摘要**`（真值源见 context-checkpoint.ts），
 *   而不是 `**用户**`。本机真实库尚无成功的检查点样本，该形态依据官方源码与合成夹具，未经真实
 *   数据验证。
 * - `handoff`：普通消息交接的协议消息。维护指令是 `handoff-instruction` 注入，历史替换后的
 *   通知是 `context-compacted` 注入；两者分别由合成上下文条目呈现为 `**交接指令**` 与
 *   `**交接通知**`，不是人类用户输入。保留它们只为让合成条目能在可见性过滤前被识别。
 * - `subagent-settled`：子代理结算回传，携带子代理的最终结论。
 * - `agent-message`：子代理或其它代理的中途发言。
 * - `user-question-reply`：用户对 `ask_user_question` 的**延迟回答**（提问仍在等待时用户之后作答），
 *   由 `dsh-user-questions` 以答案批次注入。保留的理由是它可能承载**唯一**的答案记录：
 *   官方契约里这个消息的内容与当场答复的工具结果同格式（`{ answers: [{ id, selected, custom }] }`，
 *   见 dsh-user-questions 的 `answerBatchSchema`），而提问在等待中被中止、取消或超时时不会产生
 *   可用的配对回答结果，此时本技能不产出 `**回答**` 条目，答案只在这条消息里。代价是当配对结果
 *   确实存在时，同一答案会在产物中出现两次（回答条目一次、本条消息一次），重复是可接受的代价，
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
 * - 基础成员与历史取值：`plugin`、`model`、`tool`、`system-prompt`、`session-reference`。
 *
 * 判据是 `kind` 字段而非来源声明的成员名：官方声明里的成员 `user-rpc`（浏览器端用户输入）
 * 其 `kind` 值就是 `'user'`，因此已被保留名单覆盖，无需单列。
 */
export const KEPT_USER_MESSAGE_KINDS: readonly string[] = [
  "user",
  "compact-checkpoint",
  "handoff",
  "subagent-settled",
  "agent-message",
  "user-question-reply",
];

/**
 * 创建子代理的工具名（`subagent` 与 `subagent_fork`）。
 *
 * 两个工具的调用实参都携带任务正文（`prompt`），它们的配对结果都是调度回执，
 * 不是子代理的回答。名单只有这两个取值：`send_message` 是把消息发给**已存在**的子代理，
 * 它不创建子代理，其配对结果因而不是创建回执。
 */
const SUBAGENT_CREATION_TOOL_NAMES: readonly string[] = ["subagent", "subagent_fork"];

/** 向已有代理发消息的工具名，方向不限。 */
export const SEND_MESSAGE_TOOL_NAME = "send_message";

/** 代理间通信的用户消息来源。 */
const AGENT_SOURCE_KINDS = new Set([
  "agent-message",
  "subagent-settled",
  "team-message",
  "coordinator",
  "subagent-report",
]);

/** 通信工具包含创建任务和向已有代理发送消息。 */
export function isAgentCommunicationTool(name: string | undefined): boolean {
  return isSubagentCreationTool(name) || name === SEND_MESSAGE_TOOL_NAME;
}

/**
 * 该工具名是否为子代理创建工具。
 *
 * 渲染层与检索层都只经本函数判定创建工具，禁止各自维护工具名字面量：两处判据一旦分叉，
 * 同一调用会出现"呈现有专用条目、检索不覆盖"这类不一致。`send_message` 不在此列。
 *
 * @param name 普通调用或 PTC 子调用开始事件的 `data.name`；缺失时为 undefined。
 * @returns 属于 `subagent` 或 `subagent_fork` 时为 true。
 */
export function isSubagentCreationTool(name: string | undefined): boolean {
  return name !== undefined && SUBAGENT_CREATION_TOOL_NAMES.includes(name);
}

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
 *          来源种类不在保留名单内时返回 true，包括来源缺失与空串，缺失来源的消息无法证明
 *          它来自用户或子代理，默认显示会把来源不明的注入呈现成用户消息。
 */
export function isInjectedUserMessage(event: EventRecord): boolean {
  if (eventType(event) !== "user/message") return false;
  const kind = userMessageSourceKind(event);
  return kind === null || !KEPT_USER_MESSAGE_KINDS.includes(kind);
}

/**
 * 该普通工具结果或 PTC 子调用结果是否为子代理调度回执。
 *
 * 普通结果以 `message.toolCallId` 与创建调用的 `callId` 配对，PTC 结果以 `subCallId` 配对。
 * 判定不依赖正文文案，因为配对关系是日志的结构事实。
 */
export function isSubagentReceipt(event: EventRecord, replyCallIds: ReadonlySet<string>): boolean {
  if (!isToolResultEvent(event)) return false;
  const callId = toolEventCallId(event);
  return callId !== undefined && replyCallIds.has(callId);
}

/** 排除口径汇总：默认产物中被排除的事件总数，按类别分列以便摘要行逐项给出。 */
export interface InjectionsExcluded {
  /** 框架与插件注入的消息（`runtime-context`、`skill-catalog`、`tool-jobs`、`model-selection` 等）。 */
  readonly userMessages: number;
  /** 子代理调度回执（`started subagent <id>`）。 */
  readonly subagentReceipts: number;
}

/** 每个会话独立构造的结构化可见性与调用配对。 */
export interface DefaultViewFilter {
  readonly replyCallIds: ReadonlySet<string>;
  readonly agentCallIds: ReadonlyMap<string, "task" | "send">;
  readonly subagentTaskEvent: EventRecord | null;
  readonly isSubagentSession: boolean;
  readonly includeAgentComm: boolean;
}

/** 在范围筛选前建立调用配对，结果可以位于所选区间内而调用位于区间外。 */
export function buildDefaultViewFilter(
  events: readonly EventRecord[],
  subagentTaskEvent: EventRecord | null,
  isSubagentSession: boolean,
  includeAgentComm: boolean,
): DefaultViewFilter {
  const agentCallIds = new Map<string, "task" | "send">();
  const replyCallIds = new Set<string>();
  for (const event of events) {
    if (!isToolCallEvent(event)) continue;
    const name = readString(asRecord(event.data) ?? {}, "name");
    const id = toolEventCallId(event);
    if (!isAgentCommunicationTool(name) || id === undefined || id.length === 0) continue;
    const kind = isSubagentCreationTool(name) ? "task" : "send";
    agentCallIds.set(id, kind);
    if (kind === "task") replyCallIds.add(id);
  }
  return { replyCallIds, agentCallIds, subagentTaskEvent, isSubagentSession, includeAgentComm };
}

/** 事件级排除原因；助手正文在块级投影中过滤，调度回执保留独立类别。 */
export function defaultExclusionOf(
  event: EventRecord,
  filter: DefaultViewFilter,
): "agent" | "injection" | "receipt" | null {
  const type = eventType(event);
  if (isSubagentReceipt(event, filter.replyCallIds)) return "receipt";
  const kind = type === "user/message" ? userMessageSourceKind(event) : null;
  const sourceIsAgent = kind !== null && AGENT_SOURCE_KINDS.has(kind);
  if (!filter.includeAgentComm) {
    const callId = isToolResultEvent(event) ? toolEventCallId(event) : undefined;
    if (
      event === filter.subagentTaskEvent ||
      sourceIsAgent ||
      type === "agent/inbox/spliced" ||
      (isToolCallEvent(event) &&
        isAgentCommunicationTool(readString(asRecord(event.data) ?? {}, "name"))) ||
      (callId !== undefined && filter.agentCallIds.get(callId) === "send")
    )
      return "agent";
  }
  if (!sourceIsAgent && isInjectedUserMessage(event)) return "injection";
  return null;
}

/** 默认事件可见性，供结构化输出与检索共用。 */
export function isVisibleEvent(event: EventRecord, filter: DefaultViewFilter): boolean {
  return defaultExclusionOf(event, filter) === null;
}

/** 助手消息的共享投影，过滤文本与工具块时保留独立的推理内容。 */
export function projectAssistantContent(
  message: Record<string, unknown>,
  filter: DefaultViewFilter,
): { text: string; reasoning: string; toolCalls: ToolCallBlock[]; hasVisibleBlock: boolean } {
  const content = message.content;
  const text =
    filter.isSubagentSession && !filter.includeAgentComm ? "" : messageTextFromBlocks(content);
  const reasoning = reasoningFromBlocks(content);
  const toolCalls = toolCallsFromBlocks(content).filter(
    (call) => filter.includeAgentComm || !isAgentCommunicationTool(call.name),
  );
  return {
    text,
    reasoning,
    toolCalls,
    hasVisibleBlock: text.length > 0 || reasoning.length > 0 || toolCalls.length > 0,
  };
}

/** 按事件记录计数；助手的多个文本块只计一次。 */
export function countExcludedFromDefaultView(
  events: readonly EventRecord[],
  filter: DefaultViewFilter,
): InjectionsExcluded & { readonly agentMessages: number } {
  let userMessages = 0;
  let subagentReceipts = 0;
  let agentMessages = 0;
  for (const event of events) {
    const reason = defaultExclusionOf(event, filter);
    if (reason === "injection") userMessages += 1;
    else if (reason === "receipt") subagentReceipts += 1;
    else if (reason === "agent") agentMessages += 1;
    else if (
      !filter.includeAgentComm &&
      filter.isSubagentSession &&
      eventType(event) === "assistant/message" &&
      textFromBlocks(asRecord(asRecord(event.data)?.message)?.content).length > 0
    )
      agentMessages += 1;
  }
  return { userMessages, subagentReceipts, agentMessages };
}
