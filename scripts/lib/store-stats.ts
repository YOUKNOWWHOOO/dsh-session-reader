// 统计层：全局聚合（缺省目标）与单会话统计、令牌汇总、工具调用计数、不可用指标的显式附注。
// 主要入口：runStats（stats 命令数据）。
// 关键依赖：store-list.ts（会话视图收集）、store-metadata.ts（元数据与最近活动时间）、store-discovery.ts
// （读取与扫描摘要）、store-target.ts（单会话目标解析）、store-types.ts。
// 设计约束：元数据不可用的会话不得静默计 0——逐会话列入 unavailable，并以 excludedMetricSessions 显式
// 给出未计入轮次/步数的会话数（供摘要行附注）；解码失败计入 coverage.excluded，而非让整条命令失败。
// 数据契约见 store-types.ts 文件头。

import { eventType, readNumber } from "./decode.ts";
import type { Result } from "./paths.ts";
import { accumulateScanSummary, emptyScanSummary, readSessionFile } from "./store-discovery.ts";
import { collectSessionViews } from "./store-list.ts";
import { buildMetadata, lastActivityAtOf, loadProjCache } from "./store-metadata.ts";
import { resolveSessionTarget } from "./store-target.ts";
import type {
  DecodedSessionFile,
  ScopeFilters,
  SessionView,
  SingleSessionStats,
  StatsOutcome,
  StoreContext,
  StoreError,
  TokenTotals,
} from "./store-types.ts";
import { catalogForEntry } from "./store-types.ts";

function sumTokens(views: SessionView[]): TokenTotals {
  let uncachedInputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const view of views) {
    const tokens = view.metadata.tokens.value;
    if (tokens === null) continue;
    uncachedInputTokens += tokens.uncachedInputTokens;
    outputTokens += tokens.outputTokens;
    cacheReadTokens += tokens.cacheReadTokens;
    cacheWriteTokens += tokens.cacheWriteTokens;
  }
  return { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

/** 统计单会话日志中的 tool/call 事件数。 */
function countToolCalls(file: DecodedSessionFile): number {
  return file.decoded.events.filter((event) => eventType(event) === "tool/call").length;
}

/** stats 命令数据：全局聚合（缺省）或单会话。 */
export function runStats(
  ctx: StoreContext,
  target: string | undefined,
  scopeFilters: ScopeFilters,
): Result<StatsOutcome, StoreError> {
  if (target !== undefined) {
    const resolved = resolveSessionTarget(ctx, target);
    if (!resolved.success) return resolved;
    const entry = resolved.data;
    const cache = loadProjCache(ctx.dshHome, entry.id, entry.header);
    const metadata = buildMetadata(cache);
    const file = readSessionFile(entry, catalogForEntry(ctx, entry), {
      historicalChildFailures: ctx.historicalChildFailuresBySessionId.get(entry.id),
    });
    if (!file.success) return file;
    const single: SingleSessionStats = {
      id: entry.id,
      title: metadata.title,
      blank: metadata.blank,
      turns: metadata.turns,
      steps: metadata.steps,
      agentPreset: metadata.agentPreset,
      model: metadata.model,
      tokens: metadata.tokens,
      toolCalls: countToolCalls(file.data),
      createdAt: readNumber(entry.header, "createdAt") ?? 0,
      lastActivityAt: lastActivityAtOf(entry, metadata),
      metadataAvailable: metadata.available,
      metadataReasons: metadata.reasons,
      logPath: entry.logPath,
      logVersion: entry.logVersion,
      logCompressed: entry.logCompressed,
      sizeBytes: entry.sizeBytes,
    };
    return {
      success: true,
      data: {
        kind: "single",
        sessionCount: 1,
        blankCount: metadata.blank.value === true ? 1 : 0,
        turns: metadata.turns.value ?? 0,
        steps: metadata.steps.value ?? 0,
        toolCalls: single.toolCalls,
        tokens: metadata.tokens.value ?? {
          uncachedInputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        earliestCreatedAt: single.createdAt,
        latestActivityAt: single.lastActivityAt,
        totalSizeBytes: entry.sizeBytes,
        unavailable:
          metadata.available || metadata.reasons.length === 0
            ? []
            : [{ id: entry.id, reasons: metadata.reasons }],
        excludedMetricSessions: 0,
        coverage: { scannedCount: 1, includedCount: 1, excluded: [] },
        scan: accumulateScanSummary(emptyScanSummary(), file.data.metrics),
        single,
      },
    };
  }
  const selection = collectSessionViews(ctx, {
    workspace: scopeFilters.workspace,
    since: scopeFilters.since,
    until: scopeFilters.until,
    origin: scopeFilters.origin,
    includeBlank: true,
    limit: 0,
    sort: "time",
  });
  if (!selection.success) return selection;
  let toolCalls = 0;
  const decodeFailures: { id: string; reason: string }[] = [];
  let scan = emptyScanSummary();
  for (const view of selection.data.views) {
    const file = readSessionFile(view.entry, catalogForEntry(ctx, view.entry), {
      historicalChildFailures: ctx.historicalChildFailuresBySessionId.get(view.entry.id),
    });
    if (!file.success) {
      decodeFailures.push({ id: view.entry.id, reason: "解码失败" });
      scan = accumulateScanSummary(scan, {
        success: false,
        frameFailures: file.error.frameFailures ?? 0,
      });
      continue;
    }
    scan = accumulateScanSummary(scan, file.data.metrics);
    toolCalls += countToolCalls(file.data);
  }
  let blankCount = 0;
  let earliestCreatedAt: number | null = null;
  let latestActivityAt: number | null = null;
  let totalSizeBytes = 0;
  const unavailable: { id: string; reasons: string[] }[] = [];
  for (const view of selection.data.views) {
    if (view.metadata.blank.value === true) blankCount += 1;
    const createdAt = readNumber(view.entry.header, "createdAt") ?? 0;
    earliestCreatedAt =
      earliestCreatedAt === null ? createdAt : Math.min(earliestCreatedAt, createdAt);
    latestActivityAt =
      latestActivityAt === null
        ? view.lastActivityAt
        : Math.max(latestActivityAt, view.lastActivityAt);
    totalSizeBytes += view.entry.sizeBytes;
    if (view.metadata.reasons.length > 0) {
      unavailable.push({ id: view.entry.id, reasons: view.metadata.reasons });
    }
  }
  const tokens = sumTokens(selection.data.views);
  let turns = 0;
  let steps = 0;
  let excludedMetricSessions = 0;
  for (const view of selection.data.views) {
    if (view.metadata.turns.value === null || view.metadata.steps.value === null) {
      excludedMetricSessions += 1;
    }
    turns += view.metadata.turns.value ?? 0;
    steps += view.metadata.steps.value ?? 0;
  }
  const excluded = [...selection.data.coverage.excluded, ...decodeFailures];
  // 与 search 同口径：解码失败的会话只计入 `excluded`，不得同时计入 `includedCount`
  // （同一会话出现在两个数字里会让 `N = M + K` 失去"未被列出者即为已覆盖"的含义）。
  const includedCount = selection.data.views.length - decodeFailures.length;
  return {
    success: true,
    data: {
      kind: "global",
      sessionCount: selection.data.views.length,
      blankCount,
      turns,
      steps,
      toolCalls,
      tokens,
      earliestCreatedAt,
      latestActivityAt,
      totalSizeBytes,
      unavailable,
      excludedMetricSessions,
      coverage: {
        scannedCount: includedCount + excluded.length,
        includedCount,
        excluded,
      },
      scan,
      single: null,
    },
  };
}
