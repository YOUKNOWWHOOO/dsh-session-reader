// 概况层：全局聚合（缺省目标）与单会话概况。
// 主要入口：runStats（stats 命令数据）。
// 关键依赖：store-list.ts（会话视图收集）、store-metadata.ts（元数据与最近活动时间）、store-discovery.ts
// （读取与扫描摘要）、store-target.ts（单会话目标解析）、store-types.ts。
// 设计约束：元数据问题逐会话列入 unavailable；解码失败计入 coverage.excluded。
// 数据契约见 store-types.ts 文件头。

import { hasToolCalls, readNumber } from "./decode.ts";
import type { Result } from "./paths.ts";
import { accumulateScanSummary, emptyScanSummary, readSessionFile } from "./store-discovery.ts";
import { collectSessionViews } from "./store-list.ts";
import { buildMetadata, lastActivityAtOf, loadProjCache } from "./store-metadata.ts";
import { resolveSessionTarget } from "./store-target.ts";
import type {
  ScopeFilters,
  SingleSessionStats,
  StatsOutcome,
  StoreContext,
  StoreError,
} from "./store-types.ts";

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
    const file = readSessionFile(entry, ctx.catalog);
    if (!file.success) return file;
    const single: SingleSessionStats = {
      id: entry.id,
      title: metadata.title,
      blank: metadata.blank,
      agentPreset: metadata.agentPreset,
      model: metadata.model,
      hasToolCalls: hasToolCalls(file.data.decoded.events),
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
        hasToolCalls: single.hasToolCalls,
        earliestCreatedAt: single.createdAt,
        latestActivityAt: single.lastActivityAt,
        totalSizeBytes: entry.sizeBytes,
        unavailable:
          metadata.available || metadata.reasons.length === 0
            ? []
            : [{ id: entry.id, reasons: metadata.reasons }],
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
  let anyToolCalls = false;
  const decodeFailures: { id: string; reason: string }[] = [];
  let scan = emptyScanSummary();
  for (const view of selection.data.views) {
    const file = readSessionFile(view.entry, ctx.catalog);
    if (!file.success) {
      decodeFailures.push({ id: view.entry.id, reason: "解码失败" });
      scan = accumulateScanSummary(scan, {
        success: false,
        frameFailures: file.error.frameFailures ?? 0,
      });
      continue;
    }
    scan = accumulateScanSummary(scan, file.data.metrics);
    if (hasToolCalls(file.data.decoded.events)) anyToolCalls = true;
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
      hasToolCalls: anyToolCalls,
      earliestCreatedAt,
      latestActivityAt,
      totalSizeBytes,
      unavailable,
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
