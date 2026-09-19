// 列表层：会话视图收集与范围过滤（workspace/since/until/title/origin/空会话）→ 排序 → limit，
// 并产出覆盖声明与隐藏空会话数。
// 主要入口：collectSessionViews（list/search/stats 共用的视图收集与过滤核心）、buildList（list 命令数据）。
// 关键依赖：store-discovery.ts（发现、覆盖声明、header 字段判定）、store-metadata.ts（元数据与最近活动
// 时间）、store-types.ts。
// 设计约束：单个会话 header 不可读时不得让整个聚合命令失败——那会让一份损坏的日志永久阻断对其余会话
// 的浏览与检索；跳过者写入 coverage 由渲染层逐条列出，范围过滤后的结果集是“显式的子集”，不是“静默的
// 漏读”；覆盖声明描述“本次检查了哪些会话”，与 --limit 无关。数据契约见 store-types.ts 文件头。

import { readNumber, readString } from "./decode.ts";
import { normalizePathForCompare, type Result } from "./paths.ts";
import {
  coverageOf,
  discoverReadableSessions,
  entryCwdNormalized,
  entryIsSubagent,
  storeFail,
} from "./store-discovery.ts";
import {
  buildMetadata,
  lastActivityAtOf,
  loadProjCache,
  loadWorkspaceIndex,
} from "./store-metadata.ts";
import type {
  ListEntry,
  ListFilters,
  ListOutcome,
  ScopeSelection,
  SessionView,
  StoreContext,
  StoreError,
  WorkspaceEntry,
} from "./store-types.ts";

/**
 * 收集会话视图并应用范围过滤（workspace/since/until/title/origin/空会话）。
 *
 * 容错语义（P7 根因修复）：单个会话 header 不可读时不再让整个聚合命令失败——那会让一份损坏的
 * 日志永久阻断对其余会话的浏览与检索。改为跳过该会话并把"跳过了谁、为什么"写入 coverage，
 * 由渲染层逐条列出。范围过滤后的结果集是"显式的子集"，不是"静默的漏读"。
 */
export function collectSessionViews(
  ctx: StoreContext,
  filters: ListFilters,
): Result<ScopeSelection, StoreError> {
  const discovery = discoverReadableSessions(ctx.dshHome, ctx.catalog);
  if (!discovery.success) return discovery;
  const entries = discovery.data.entries;
  const coverage = coverageOf(discovery.data);
  const workspaces = loadWorkspaceIndex(ctx.dshHome);
  const workspaceFilter = filters.workspace;
  let matchedWorkspaces: WorkspaceEntry[] = [];
  if (workspaceFilter !== undefined) {
    const normalizedFilter = normalizePathForCompare(workspaceFilter);
    const loweredFilter = workspaceFilter.toLowerCase();
    matchedWorkspaces = workspaces.filter(
      (workspace) =>
        normalizePathForCompare(workspace.path) === normalizedFilter ||
        workspace.title.toLowerCase() === loweredFilter,
    );
    const anyCwdMatch = entries.some((entry) => entryCwdNormalized(entry) === normalizedFilter);
    if (!anyCwdMatch && matchedWorkspaces.length === 0) {
      return storeFail("target-missing", "工作区过滤值无匹配");
    }
  }
  const workspacePaths = new Set(
    matchedWorkspaces.map((workspace) => normalizePathForCompare(workspace.path)),
  );
  const workspaceTitleByPath = new Map<string, string>();
  for (const workspace of workspaces) {
    const key = normalizePathForCompare(workspace.path);
    if (!workspaceTitleByPath.has(key)) workspaceTitleByPath.set(key, workspace.title);
  }
  const views: SessionView[] = [];
  let hiddenBlankCount = 0;
  for (const entry of entries) {
    const cache = loadProjCache(ctx.dshHome, entry.id, entry.header);
    const metadata = buildMetadata(cache);
    const effectiveLastActivity = lastActivityAtOf(entry, metadata);
    const cwdNormalized = entryCwdNormalized(entry);
    if (workspaceFilter !== undefined) {
      const normalizedFilter = normalizePathForCompare(workspaceFilter);
      const matched = cwdNormalized === normalizedFilter || workspacePaths.has(cwdNormalized);
      if (!matched) continue;
    }
    if (filters.since !== undefined && effectiveLastActivity < filters.since) continue;
    if (filters.until !== undefined && effectiveLastActivity > filters.until) continue;
    const titleFilter = filters.title;
    if (titleFilter !== undefined) {
      const title = metadata.title.value;
      if (title === null || !title.toLowerCase().includes(titleFilter.toLowerCase())) continue;
    }
    if (filters.origin === "main" && entryIsSubagent(entry)) continue;
    if (filters.origin === "subagent" && !entryIsSubagent(entry)) continue;
    if (!filters.includeBlank && metadata.blank.value === true) {
      hiddenBlankCount += 1;
      continue;
    }
    const workspaceTitle =
      cwdNormalized.length === 0 ? null : (workspaceTitleByPath.get(cwdNormalized) ?? null);
    views.push({ entry, metadata, lastActivityAt: effectiveLastActivity, workspaceTitle });
  }
  return {
    success: true,
    data: { views, scannedCount: coverage.scannedCount, hiddenBlankCount, coverage },
  };
}

function compareViews(left: SessionView, right: SessionView, sort: ListFilters["sort"]): number {
  let result = 0;
  if (sort === "time") result = left.lastActivityAt - right.lastActivityAt;
  else if (sort === "created") {
    result =
      (readNumber(left.entry.header, "createdAt") ?? 0) -
      (readNumber(right.entry.header, "createdAt") ?? 0);
  } else if (sort === "title") {
    const leftTitle = (left.metadata.title.value ?? "").toLowerCase();
    const rightTitle = (right.metadata.title.value ?? "").toLowerCase();
    result = leftTitle < rightTitle ? -1 : leftTitle > rightTitle ? 1 : 0;
  } else if (sort === "size") result = left.entry.sizeBytes - right.entry.sizeBytes;
  else result = (left.metadata.turns.value ?? -1) - (right.metadata.turns.value ?? -1);
  if (result !== 0) return result;
  return left.entry.id < right.entry.id ? -1 : left.entry.id > right.entry.id ? 1 : 0;
}

/** list 命令数据：过滤 → 排序（time/created/size/turns 降序；title 升序）→ limit（0=不限）。 */
export function buildList(
  ctx: StoreContext,
  filters: ListFilters,
): Result<ListOutcome, StoreError> {
  const selection = collectSessionViews(ctx, filters);
  if (!selection.success) return selection;
  const sorted = [...selection.data.views];
  const descending = filters.sort !== "title";
  sorted.sort((left, right) => {
    const compared = compareViews(left, right, filters.sort);
    return descending ? -compared : compared;
  });
  const limited = filters.limit === 0 ? sorted : sorted.slice(0, filters.limit);
  const entries: ListEntry[] = limited.map((view) => ({
    id: view.entry.id,
    type: entryIsSubagent(view.entry) ? "subagent" : "main",
    cwd: readString(view.entry.header, "cwd") ?? null,
    workspaceTitle: view.workspaceTitle,
    createdAt: readNumber(view.entry.header, "createdAt") ?? 0,
    lastActivityAt: view.lastActivityAt,
    sizeBytes: view.entry.sizeBytes,
    metadata: view.metadata,
  }));
  return {
    success: true,
    data: {
      entries,
      matchedCount: sorted.length,
      scannedCount: selection.data.scannedCount,
      hiddenBlankCount: selection.data.hiddenBlankCount,
      // 覆盖声明描述"本次检查了哪些会话"，与 `--limit` 无关（`--limit` 只影响产物列出多少条，
      // 由 `matchedCount` 与产物行数表达）。把 includedCount 绑到"列出条数"会让三个数不再自洽。
      // 注意：`scanned = included + excluded` 由本函数所在层构造（见 store-discovery.ts 的
      // coverageOf），恒成立但不具备核对能力——核对覆盖范围只能依据逐条列出的排除项。
      coverage: selection.data.coverage,
    },
  };
}
