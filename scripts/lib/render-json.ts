// 用途：JSON/JSONL 渲染，list/show/search/stats/check 的 json 形态与 show 的 jsonl 形态，
// 含子代理的父子嵌套递归（nodeToJson）与逐事件穷尽导出的逻辑 header。
// 主要入口：renderListJson / renderShowJson / renderShowJsonl / renderSearchJson / renderStatsJson /
// renderCheckJson。
// 关键依赖：render-core.ts（会话派生事实、RenderedOutput）、render-summary.ts（全部命令级摘要文案）、
// decode.ts（事件读取基元）、store-types.ts（outcome 与节点类型）。
// 设计约束：json 侧不做任何文本载体与归一化（载体规则仅 md 适用，见 render-core.ts 文件头的层规则）；
// 键序稳定、`null` 表示空值；字段名与嵌套形态是 json 形态的对外契约，不得改写。show 的 coverage 与 md
// 同源同口径：作用域是本目标及其子树，可归属的排除项恒为空。每个 json 渲染函数与 md 侧同签名返回
// `{ content, summary }`：摘要是 stdout 第二行，只能取自 render-summary.ts，CLI 不得自行拼接。

import { analyzeContextCheckpoints, checkpointSeqsOf } from "./context-checkpoint.ts";
import {
  asRecord,
  eventSeq,
  eventTime,
  eventType,
  hasToolCalls,
  isToolCallEvent,
  isToolResultEvent,
  readNumber,
  readString,
  textFromBlocks,
  toolCallArgumentsText,
  toolEventCallId,
  toolResultIsError,
  toolResultText,
  userMessageText,
} from "./decode.ts";
import { analyzeHandoffEvents } from "./handoff.ts";
import { attributeSource } from "./message-source.ts";
import { computeTurns, countNodes, findSessionTitle, type RenderedOutput } from "./render-core.ts";
import {
  checkSummary,
  formatStatsSummary,
  listSummary,
  searchSummary,
  showJsonlSummary,
  showSummary,
} from "./render-summary.ts";
import type {
  CheckOutcome,
  CoverageSkip,
  DecodedSessionFile,
  ListEntry,
  ListOutcome,
  SearchOutcome,
  SessionNode,
  StatsOutcome,
} from "./store-types.ts";
import {
  buildDefaultViewFilter,
  type DefaultViewFilter,
  isVisibleEvent,
  projectAssistantContent,
} from "./visibility.ts";

// ------------------------- list -------------------------

function entryToJson(entry: ListEntry): Record<string, unknown> {
  return {
    id: entry.id,
    type: entry.type,
    title: entry.metadata.title.value,
    cwd: entry.cwd,
    workspaceTitle: entry.workspaceTitle,
    createdAt: entry.createdAt,
    lastActivityAt: entry.lastActivityAt,
    lastPromptAt: entry.metadata.lastPromptAt.value,
    blank: entry.metadata.blank.value,
    agentPreset: entry.metadata.agentPreset.value,
    model: entry.metadata.model.value,
    sizeBytes: entry.sizeBytes,
    metadata: { available: entry.metadata.available, reasons: entry.metadata.reasons },
  };
}

/** list JSON：`{ sessions, coverage }`，每项含全部列字段与元数据可用性标记。 */
export function renderListJson(outcome: ListOutcome): RenderedOutput {
  return {
    content: `${JSON.stringify({ sessions: outcome.entries.map(entryToJson), coverage: outcome.coverage }, null, 2)}\n`,
    summary: listSummary(outcome),
  };
}

// ------------------------- show -------------------------

/**
 * `messages` 的构造：与默认参数提取的可见性完全一致。
 *
 * 排除的三类与 `show` 的 md 时间线、`search` 的 `text` 档同源（判定统一取自 `visibility.ts`）：
 * 框架与插件注入的消息、子代理调度回执、结构化代理通信；第三类由通信开关控制。排除而非降级呈现：调用方要完整消息历史时用
 * `--format jsonl`（逐事件穷尽），它是唯一不被可见性过滤的导出形态。
 *
 */
function buildMessageEntries(
  file: DecodedSessionFile,
  filter: DefaultViewFilter,
): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const event of file.decoded.events) {
    if (!isVisibleEvent(event, filter)) continue;
    const seq = eventSeq(event);
    const type = eventType(event);
    const data = asRecord(event.data) ?? {};
    if (type === "user/message") {
      entries.push({
        seq: seq ?? null,
        time: eventTime(event) ?? null,
        type,
        role: "user",
        // 来源归属必须是对象而非 kind 字符串：调用方要能区分"用户本人"与"子代理中继/插件注入"，
        // 且对 `agent-message`/`subagent-settled` 还要能定位是哪个子代理（senderSessionId）。
        source: attributeSource(data.source),
        text: userMessageText(event),
      });
    } else if (type === "assistant/message") {
      const message = asRecord(data.message) ?? {};
      const projection = projectAssistantContent(message, filter);
      if (!projection.hasVisibleBlock) continue;
      entries.push({
        seq: seq ?? null,
        time: eventTime(event) ?? null,
        type,
        role: "assistant",
        text: projection.text,
        reasoning: projection.reasoning,
        toolCalls: projection.toolCalls.map((call) => ({
          id: call.id ?? null,
          name: call.name ?? null,
          arguments: call.arguments ?? null,
        })),
      });
    } else if (isToolCallEvent(event)) {
      entries.push({
        seq: seq ?? null,
        time: eventTime(event) ?? null,
        type,
        role: "tool",
        callId: toolEventCallId(event) ?? null,
        ...(type === "tool/ptc-dispatch-start"
          ? { rootCallId: data.rootCallId, parentCallId: data.parentCallId }
          : {}),
        name: readString(data, "name") ?? null,
        arguments: toolCallArgumentsText(event) ?? null,
      });
    } else if (isToolResultEvent(event)) {
      entries.push({
        seq: seq ?? null,
        time: eventTime(event) ?? null,
        type,
        role: "tool",
        callId: toolEventCallId(event) ?? null,
        ...(type === "tool/ptc-dispatch"
          ? {
              rootCallId: data.rootCallId,
              parentCallId: data.parentCallId,
              name: readString(data, "name") ?? null,
              arguments: toolCallArgumentsText(event) ?? null,
            }
          : {}),
        // 普通结果按 data.error 与 message.isError 判错，PTC 结果按 data.isError 判错；
        // 统一由 decode.ts 的 toolResultIsError 实现，避免与 Markdown 和问答处理分歧。
        isError: toolResultIsError(event),
        text: toolResultText(event),
      });
    } else if (type === "system/message") {
      entries.push({
        seq: seq ?? null,
        time: eventTime(event) ?? null,
        type,
        role: "system",
        text: textFromBlocks(asRecord(data.message)?.content),
      });
    }
  }
  return entries;
}

function nodeToJson(
  node: SessionNode,
  includeMessages: boolean,
  includeAgentComm: boolean,
): Record<string, unknown> {
  const header = node.file.decoded.header;
  const handoff = analyzeHandoffEvents(node.file.decoded.events);
  const context = analyzeContextCheckpoints(
    node.file.decoded.header,
    node.file.decoded.events,
    handoff,
    node.file.decoded.inheritedEventCount,
  );
  const filter = buildDefaultViewFilter(
    node.file.decoded.events,
    context.subagentTask,
    readString(header, "origin") === "subagent",
    includeAgentComm,
  );
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
      hasToolCalls: hasToolCalls(node.file.decoded.events),
      anomalies: node.file.decoded.anomalies.map((anomaly) => anomaly.detail),
    },
    turns: computeTurns(node.file, checkpointSeqsOf(context), filter).map((turn) => ({
      turn: turn.turn,
      seq: turn.seq,
      prompt: turn.prompt,
      response: turn.response,
    })),
    messages: includeMessages ? buildMessageEntries(node.file, filter) : [],
    subagents: node.children.map((child) => nodeToJson(child, includeMessages, includeAgentComm)),
  };
}

/**
 * show JSON：`{ session, meta, turns, messages, subagents, coverage }`（子代理为父子嵌套结构）。
 *
 * 摘要与 md 路径同源（`showSummary`）：`--summary` 与 `--subagents` 两个开关决定措辞，
 * 因此 `show <目标> --summary --format json` 的 stdout 第二行与 md 逐字一致。
 */
export function renderShowJson(
  node: SessionNode,
  options: {
    readonly summary: boolean;
    readonly includeAgentComm: boolean;
    readonly subagents: boolean;
    readonly unattributable: readonly CoverageSkip[];
  },
): RenderedOutput {
  const nodes = countNodes(node);
  const document = {
    ...nodeToJson(node, !options.summary, options.includeAgentComm),
    // 与 md 同源同口径：作用域是本目标及其子树，可归属的排除项恒为空。
    coverage: {
      scannedCount: nodes,
      includedCount: nodes,
      excluded: [],
      unattributable: options.unattributable,
    },
  };
  return {
    content: `${JSON.stringify(document, null, 2)}\n`,
    summary: showSummary(node, options),
  };
}

/** show JSONL：首行逻辑 header，其后每行一个已解码事件（键序稳定）。 */
export function renderShowJsonl(node: SessionNode): RenderedOutput {
  const lines = [JSON.stringify(node.file.decoded.header)];
  for (const event of node.file.decoded.events) {
    lines.push(JSON.stringify(event));
  }
  return {
    content: `${lines.join("\n")}\n`,
    summary: showJsonlSummary(node),
  };
}

// ------------------------- search -------------------------

/** search JSON：`{ matches, total, truncated, scope, totalIsExact, coverage, scan, distribution }`。 */
export function renderSearchJson(outcome: SearchOutcome): RenderedOutput {
  const document = {
    matches: outcome.hits.map((hit) => ({
      sessionId: hit.sessionId,
      seq: hit.seq,
      time: hit.time,
      label: hit.label,
      excerpt: hit.excerpt,
      source: hit.source,
    })),
    total: outcome.totalHits,
    truncated: outcome.truncated,
    scope: outcome.scope,
    totalIsExact: outcome.totalIsExact,
    excludedInjections: outcome.excludedInjections,
    excludedAgentMessages: outcome.excludedAgentMessages,
    coverage: outcome.coverage,
    scan: outcome.scan,
    distribution: outcome.distribution,
  };
  return {
    content: `${JSON.stringify(document, null, 2)}\n`,
    summary: searchSummary(outcome),
  };
}

// ------------------------- stats -------------------------

/** stats JSON：global=聚合对象；single=单会话对象（字段值为 null 表示不可用/空）。 */
export function renderStatsJson(outcome: StatsOutcome): RenderedOutput {
  const summary = formatStatsSummary(outcome);
  if (outcome.single !== null) {
    const single = outcome.single;
    const document = {
      kind: "single",
      session: {
        id: single.id,
        title: single.title.value,
        blank: single.blank.value,
        hasToolCalls: single.hasToolCalls,
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
      coverage: outcome.coverage,
      scan: outcome.scan,
    };
    return { content: `${JSON.stringify(document, null, 2)}\n`, summary };
  }
  const document = {
    kind: "global",
    sessionCount: outcome.sessionCount,
    blankCount: outcome.blankCount,
    hasToolCalls: outcome.hasToolCalls,
    earliestCreatedAt: outcome.earliestCreatedAt,
    latestActivityAt: outcome.latestActivityAt,
    totalSizeBytes: outcome.totalSizeBytes,
    unavailable: outcome.unavailable,
    coverage: outcome.coverage,
    scan: outcome.scan,
  };
  return { content: `${JSON.stringify(document, null, 2)}\n`, summary };
}

// ------------------------- check -------------------------

/** check JSON：`{ sessions, anomalyCount, coverage }`。 */
export function renderCheckJson(outcome: CheckOutcome): RenderedOutput {
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
    coverage: outcome.coverage,
  };
  return {
    content: `${JSON.stringify(document, null, 2)}\n`,
    summary: checkSummary(outcome),
  };
}
