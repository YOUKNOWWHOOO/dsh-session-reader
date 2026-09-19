// 目标解析层：会话标识三态解析（唯一匹配 / 歧义 / 存在但不可读）、last 解析（主会话最近活动者）、
// 子树展开与递归节点构建。
// 主要入口：resolveSessionTarget（show/stats/check）、resolveTargetWithin（已持有发现结果时的共用核心，
// 供 runSearch 的 --session/--exclude-session 复用）、collectSubtreeEntries、buildSessionNode。
// 关键依赖：store-discovery.ts（发现与读取）、store-metadata.ts（last 的最近活动时间）、store-types.ts。
// 设计约束：“目标不存在”必须与“目标存在但不可读”可区分（前者退出 1、后者退出 3）；被跳过目录按目录名
// （idFromDir）匹配，因为 header 不可读时无从取得逻辑 id；子树遍历带 visited 防环；父子判定口径与
// buildSessionNode 一致，避免 search --session 与 show --subagents 给出不同答案。
// 数据契约见 store-types.ts 文件头。

import { readNumber, readString } from "./decode.ts";
import type { Result } from "./paths.ts";
import {
  discoverReadableSessions,
  entryIsSubagent,
  readSessionFile,
  storeFail,
} from "./store-discovery.ts";
import { buildMetadata, lastActivityAtOf, loadProjCache } from "./store-metadata.ts";
import type {
  SessionEntry,
  SessionNode,
  StoreContext,
  StoreError,
  TolerantDiscovery,
} from "./store-types.ts";

const MIN_PREFIX_LENGTH = 8;

/** 主会话 id 形如 session-<uuid>；标识匹配同时接受含 session- 的前缀与裸 uuid 前缀（§3.4 示例）。 */
function idMatchesPrefix(id: string, loweredValue: string): boolean {
  const loweredId = id.toLowerCase();
  if (loweredId.startsWith(loweredValue)) return true;
  const sessionPrefix = "session-";
  if (loweredId.startsWith(sessionPrefix)) {
    return loweredId.slice(sessionPrefix.length).startsWith(loweredValue);
  }
  return false;
}

function idMatchesExact(id: string, loweredValue: string): boolean {
  const loweredId = id.toLowerCase();
  if (loweredId === loweredValue) return true;
  const sessionPrefix = "session-";
  if (loweredId.startsWith(sessionPrefix)) {
    return loweredId.slice(sessionPrefix.length) === loweredValue;
  }
  return false;
}

/**
 * 在既有发现结果上解析会话标识（`resolveSessionTarget` 与 `runSearch --session` 的共用核心）。
 * 提取为独立函数的原因：`runSearch` 已经持有发现结果，再调用 `resolveSessionTarget` 会重复扫描一次，
 * 两次扫描之间的日志变化会让"子树展开"与"命中归属"基于不同快照。
 */
export function resolveTargetWithin(
  discovery: TolerantDiscovery,
  value: string,
  dshHome: string,
): Result<SessionEntry, StoreError> {
  const candidates = discovery.entries;
  if (value === "last") {
    let best: SessionEntry | undefined;
    let bestKey = Number.NEGATIVE_INFINITY;
    for (const entry of candidates) {
      if (entryIsSubagent(entry)) continue;
      const cache = loadProjCache(dshHome, entry.id, entry.header);
      const metadata = buildMetadata(cache);
      const key = lastActivityAtOf(entry, metadata);
      if (key > bestKey || (key === bestKey && best !== undefined && entry.id < best.id)) {
        best = entry;
        bestKey = key;
      }
    }
    if (best === undefined) return storeFail("target-missing", "没有主会话");
    return { success: true, data: best };
  }
  if (value.length < MIN_PREFIX_LENGTH) {
    return storeFail("argument-invalid", `会话前缀至少 ${MIN_PREFIX_LENGTH} 个字符`);
  }
  const lowered = value.toLowerCase();
  const exact = candidates.filter((entry) => idMatchesExact(entry.id, lowered));
  if (exact.length === 1) return { success: true, data: exact[0] };
  if (exact.length > 1) {
    return { success: false, error: { category: "ambiguous", candidates: exact.length } };
  }
  const prefixed = candidates.filter((entry) => idMatchesPrefix(entry.id, lowered));
  if (prefixed.length === 0) {
    const unreadable = discovery.skipped.filter((skipped) =>
      idMatchesPrefix(skipped.idFromDir, lowered),
    );
    if (unreadable.length > 0) return storeFail("data-unreadable", "匹配的会话 header 不可读");
    return storeFail("target-missing", "没有匹配的会话");
  }
  if (prefixed.length > 1) {
    return { success: false, error: { category: "ambiguous", candidates: prefixed.length } };
  }
  return { success: true, data: prefixed[0] };
}

/**
 * 解析会话标识：last（主会话最近活动者）／完整 id／唯一前缀（≥8 字符，大小写不敏感）。
 *
 * P7 根因修复——"目标不存在"必须与"目标存在但不可读"可区分：
 * 解析在发现阶段（`discoverReadableSessions`）之上进行，而发现阶段会跳过 header 不可读的会话目录
 * （日志正在被写入导致撕裂、格式分类为 malformed/unsupported、header 缺 id 等）。这些会话确实存在于
 * 磁盘上，只是此刻读不到。因此：
 * - 有多个匹配 → `ambiguous`（CLI 渲染为"目标不存在（候选 N 个）"，退出 1）；
 * - 无匹配、但被跳过的目录名与给定值前缀匹配 → `data-unreadable`（退出 3），调用方据此区分
 *   "确实不存在"与"存在但读不到"，而不是把两者都当成不存在；
 * - 其余无匹配 → `target-missing`（退出 1）。
 *
 * 被跳过目录的匹配必须按目录名（`idFromDir`）判定：header 不可读时无从取得逻辑 id，目录名是唯一可用标识。
 */
export function resolveSessionTarget(
  ctx: StoreContext,
  value: string,
): Result<SessionEntry, StoreError> {
  const discovery = discoverReadableSessions(ctx.dshHome, ctx.catalog);
  if (!discovery.success) return discovery;
  return resolveTargetWithin(discovery.data, value, ctx.dshHome);
}

/**
 * 展开会话子树（含自身）：按 `header.parentSession` 递归，`visited` 防环。
 *
 * 与 `buildSessionNode` 共用同一父子判定口径（`parentSession` 相等），避免 `search --session`
 * 与 `show --subagents` 对"谁是子代理"给出不同答案。
 */
export function collectSubtreeEntries(
  root: SessionEntry,
  allEntries: readonly SessionEntry[],
): SessionEntry[] {
  const collected: SessionEntry[] = [];
  const visited = new Set<string>();
  const queue: SessionEntry[] = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    collected.push(current);
    const children = allEntries
      .filter((candidate) => readString(candidate.header, "parentSession") === current.id)
      .sort(
        (left, right) =>
          (readNumber(left.header, "createdAt") ?? 0) -
          (readNumber(right.header, "createdAt") ?? 0),
      );
    for (const child of children) queue.push(child);
  }
  return collected;
}

/** 递归构建会话节点（含子代理；visited 防环）。 */
export function buildSessionNode(
  ctx: StoreContext,
  entry: SessionEntry,
  allEntries: SessionEntry[],
  visited: Set<string>,
): Result<SessionNode, StoreError> {
  const file = readSessionFile(entry, ctx.catalog);
  if (!file.success) return file;
  visited.add(entry.id);
  const children: SessionNode[] = [];
  const childEntries = allEntries
    .filter((candidate) => readString(candidate.header, "parentSession") === entry.id)
    .filter((candidate) => !visited.has(candidate.id))
    .sort(
      (left, right) =>
        (readNumber(left.header, "createdAt") ?? 0) - (readNumber(right.header, "createdAt") ?? 0),
    );
  for (const childEntry of childEntries) {
    const child = buildSessionNode(ctx, childEntry, allEntries, visited);
    if (!child.success) return child;
    children.push(child.data);
  }
  return { success: true, data: { entry, file: file.data, children } };
}
