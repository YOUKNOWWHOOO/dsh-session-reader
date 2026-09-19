// 用途：JSON/JSONL 渲染——list/show/search/stats/check 的 json 形态与 show 的 jsonl 形态，
// 含子代理的父子嵌套递归（nodeToJson）与逐事件穷尽导出的逻辑 header。
// 主要入口：renderListJson / renderShowJson / renderShowJsonl / renderSearchJson / renderStatsJson /
// renderCheckJson。
// 关键依赖：render-core.ts（会话派生事实、RenderedOutput）、render-summary.ts（全部命令级摘要文案）、
// decode.ts（事件读取基元）、store-types.ts（outcome 与节点类型）。
// 设计约束：json 侧不做任何文本载体与归一化（载体规则仅 md 适用，见 render-core.ts 文件头的层规则）；
// 键序稳定、`null` 表示空值；字段名与嵌套形态是 json 形态的对外契约，不得改写。show 的 coverage 与 md
// 同源同口径：作用域是本目标及其子树，可归属的排除项恒为空。每个 json 渲染函数与 md 侧同签名返回
// `{ content, summary }`：摘要是 stdout 第二行，只能取自 render-summary.ts，CLI 不得自行拼接。
import {
  asArray,
  asRecord,
  eventSeq,
  eventTime,
  eventType,
  readNumber,
  readString,
  reasoningFromBlocks,
  textFromBlocks,
  toolResultText,
} from "./decode.ts";
import { attributeSource } from "./message-source.ts";
import {
  computeEventStats,
  computeTurns,
  countNodes,
  findSessionTitle,
  type RenderedOutput,
  sumUsage,
} from "./render-core.ts";
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
    turns: entry.metadata.turns.value,
    steps: entry.metadata.steps.value,
    blank: entry.metadata.blank.value,
    agentPreset: entry.metadata.agentPreset.value,
    model: entry.metadata.model.value,
    tokens: entry.metadata.tokens.value,
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

function buildMessageEntries(file: DecodedSessionFile): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const event of file.decoded.events) {
    const type = eventType(event);
    const data = asRecord(event.data) ?? {};
    if (type === "user/message") {
      entries.push({
        seq: eventSeq(event) ?? null,
        time: eventTime(event) ?? null,
        type,
        role: "user",
        // 来源归属必须是对象而非 kind 字符串：调用方要能区分"用户本人"与"子代理中继/插件注入"，
        // 且对 `agent-message`/`subagent-settled` 还要能定位是哪个子代理（senderSessionId）。
        source: attributeSource(data.source),
        text: textFromBlocks(data.content),
      });
    } else if (type === "assistant/message") {
      const message = asRecord(data.message) ?? {};
      entries.push({
        seq: eventSeq(event) ?? null,
        time: eventTime(event) ?? null,
        type,
        role: "assistant",
        text: textFromBlocks(message.content),
        reasoning: reasoningFromBlocks(message.content),
        toolCalls: readToolCallBlocks(message.content),
      });
    } else if (type === "tool/call") {
      entries.push({
        seq: eventSeq(event) ?? null,
        time: eventTime(event) ?? null,
        type,
        role: "tool",
        callId: readString(data, "callId") ?? null,
        name: readString(data, "name") ?? null,
        arguments: readString(data, "arguments") ?? null,
      });
    } else if (type === "tool/result") {
      const message = asRecord(data.message) ?? {};
      const source = asRecord(message.source) ?? {};
      entries.push({
        seq: eventSeq(event) ?? null,
        time: eventTime(event) ?? null,
        type,
        role: "tool",
        callId: readString(source, "callId") ?? null,
        isError: asRecord(data.error) !== undefined,
        text: toolResultText(event),
      });
    } else if (type === "system/message") {
      entries.push({
        seq: eventSeq(event) ?? null,
        time: eventTime(event) ?? null,
        type,
        role: "system",
        text: textFromBlocks(asRecord(data.message)?.content),
      });
    }
  }
  return entries;
}

function readToolCallBlocks(content: unknown): Record<string, unknown>[] {
  const blocks = asArray(content) ?? [];
  const calls: Record<string, unknown>[] = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (record === undefined || readString(record, "type") !== "tool-call") continue;
    calls.push({
      id: readString(record, "id") ?? null,
      name: readString(record, "name") ?? null,
      arguments: readString(record, "arguments") ?? null,
    });
  }
  return calls;
}

function nodeToJson(node: SessionNode, includeMessages: boolean): Record<string, unknown> {
  const header = node.file.decoded.header;
  const usage = sumUsage(node.file);
  const stats = computeEventStats(node.file);
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
      turns: stats.turns,
      steps: stats.steps,
      toolCalls: stats.toolCalls,
      tokens: {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        reasoningTokens: usage.reasoning,
      },
      anomalies: node.file.decoded.anomalies.map((anomaly) => anomaly.detail),
    },
    turns: computeTurns(node.file).map((turn) => ({
      turn: turn.turn,
      seq: turn.seq,
      prompt: turn.prompt,
      response: turn.response,
    })),
    messages: includeMessages ? buildMessageEntries(node.file) : [],
    subagents: node.children.map((child) => nodeToJson(child, includeMessages)),
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
    readonly subagents: boolean;
    readonly unattributable: readonly CoverageSkip[];
  },
): RenderedOutput {
  const nodes = countNodes(node);
  const document = {
    ...nodeToJson(node, !options.summary),
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
    summary: showSummary(node, options, computeEventStats(node.file)),
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
        turns: single.turns.value,
        steps: single.steps.value,
        toolCalls: single.toolCalls,
        tokens: single.tokens.value,
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
    turns: outcome.turns,
    steps: outcome.steps,
    toolCalls: outcome.toolCalls,
    tokens: outcome.tokens,
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
