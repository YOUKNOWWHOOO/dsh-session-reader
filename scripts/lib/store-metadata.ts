// 元数据层：projcache 加载与 version + identity 校验、字段级元数据视图组装、workspace.json 工作区标题
// 索引、有效“最近活动时间”计算。
// 主要入口：loadProjCache、buildMetadata、lastActivityAtOf、loadWorkspaceIndex。
// 关键依赖：node:fs/node:path、decode.ts（asRecord/asArray/read* 取值）、store-types.ts。
// 设计约束：projcache 是列表/统计元数据的唯一来源（version + identity 校验，失败/缺失一律显式标注
// "元数据不可用"，不静默空值）；workspace.json 仅提供工作区标题；不可用原因去重且保持出现顺序。
// 数据契约见 store-types.ts 文件头。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { asArray, asRecord, readBoolean, readNumber, readString } from "./decode.ts";
import type {
  FieldValue,
  MetadataView,
  ModelView,
  ProjCacheState,
  SessionEntry,
  TokenTotals,
  WorkspaceEntry,
} from "./store-types.ts";

const PROJCACHE_VERSION = 7;

/** 加载 projcache（version + identity 校验；失败返回不可用原因）。 */
export function loadProjCache(
  dshHome: string,
  id: string,
  header: Record<string, unknown>,
): ProjCacheState {
  const path = join(dshHome, "storages", "session_projcache", "sessions", `${id}.json`);
  if (!existsSync(path)) return { available: false, reason: "projcache 记录缺失", rows: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { available: false, reason: "projcache 读取失败", rows: {} };
  }
  const document = asRecord(parsed);
  if (document === undefined) return { available: false, reason: "projcache 结构无效", rows: {} };
  if (document.version !== PROJCACHE_VERSION) {
    return {
      available: false,
      reason: `projcache 版本不匹配（${String(document.version)}）`,
      rows: {},
    };
  }
  const record = asRecord(document.record);
  if (record === undefined) return { available: false, reason: "projcache 缺少 record", rows: {} };
  const identity = asRecord(record.identity);
  if (identity === undefined)
    return { available: false, reason: "projcache 缺少 identity", rows: {} };
  const mismatches: string[] = [];
  if (identity.formatVersion !== header.version) mismatches.push("formatVersion");
  if (identity.createdAt !== header.createdAt) mismatches.push("createdAt");
  if (identity.cwd !== header.cwd) mismatches.push("cwd");
  if (identity.isSeeded !== header.isSeeded) mismatches.push("isSeeded");
  if (mismatches.length > 0) {
    return {
      available: false,
      reason: `projcache identity 不匹配（${mismatches.join("、")}）`,
      rows: {},
    };
  }
  const rows = asRecord(record.rows);
  if (rows === undefined) return { available: false, reason: "projcache 缺少 rows", rows: {} };
  return { available: true, reason: null, rows };
}

interface RowRead {
  readonly ok: boolean;
  readonly value: unknown;
  readonly reason: string;
}

function readProjCacheRow(cache: ProjCacheState, rowName: string): RowRead {
  if (!cache.available) {
    return { ok: false, value: null, reason: cache.reason ?? "元数据不可用" };
  }
  const row = asRecord(cache.rows[rowName]);
  if (row === undefined) return { ok: false, value: null, reason: `缺少 ${rowName} 记录` };
  const version = readNumber(row, "ver");
  if (version === undefined || !Number.isSafeInteger(version) || version < 0) {
    return { ok: false, value: null, reason: `${rowName}.ver 无效` };
  }
  if (readNumber(row, "seq") === undefined) {
    return { ok: false, value: null, reason: `${rowName}.seq 无效` };
  }
  if (!Object.hasOwn(row, "val")) {
    return { ok: false, value: null, reason: `${rowName}.val 缺失` };
  }
  return { ok: true, value: row.val, reason: "" };
}

function parseTokenTotals(value: unknown): TokenTotals | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const totals = asRecord(record.totals);
  if (totals === undefined) return undefined;
  const uncachedInputTokens = readNumber(totals, "uncachedInputTokens");
  const outputTokens = readNumber(totals, "outputTokens");
  const cacheReadTokens = readNumber(totals, "cacheReadTokens");
  const cacheWriteTokens = readNumber(totals, "cacheWriteTokens");
  if (
    uncachedInputTokens === undefined ||
    outputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined
  ) {
    return undefined;
  }
  return { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

function parseModelView(value: unknown): ModelView | null | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const lastUsed = record.lastUsed;
  if (lastUsed === null) return null;
  const modelRecord = asRecord(lastUsed);
  if (modelRecord === undefined) return undefined;
  const provider = readString(modelRecord, "provider");
  const model = readString(modelRecord, "model");
  if (provider === undefined || model === undefined) return undefined;
  const reasoningEffort = readString(modelRecord, "reasoningEffort");
  return { provider, model, reasoningEffort: reasoningEffort ?? null };
}

/** 组装单会话元数据视图（字段级可用性；原因去重）。 */
export function buildMetadata(cache: ProjCacheState): MetadataView {
  const reasons: string[] = [];
  const collect = (unavailable: boolean, reason: string): void => {
    if (unavailable && reason.length > 0) reasons.push(reason);
  };
  const titleRow = readProjCacheRow(cache, "title");
  collect(!titleRow.ok, titleRow.reason);
  const title: FieldValue<string> = titleRow.ok
    ? typeof titleRow.value === "string"
      ? { value: titleRow.value, unavailable: false }
      : { value: null, unavailable: false }
    : { value: null, unavailable: true };
  const listRow = readProjCacheRow(cache, "sessionListMetadata");
  collect(!listRow.ok, listRow.reason);
  const listRecord = listRow.ok ? asRecord(listRow.value) : undefined;
  const blankValue = listRecord === undefined ? undefined : readBoolean(listRecord, "blank");
  const blank: FieldValue<boolean> =
    blankValue === undefined
      ? { value: null, unavailable: true }
      : { value: blankValue, unavailable: false };
  let lastPromptValue: number | null | undefined;
  if (listRecord !== undefined) {
    const raw = listRecord.lastPromptAt;
    lastPromptValue = raw === null ? null : readNumber(listRecord, "lastPromptAt");
  }
  const lastPromptAt: FieldValue<number> =
    lastPromptValue === undefined
      ? { value: null, unavailable: true }
      : { value: lastPromptValue, unavailable: false };
  if (listRecord !== undefined) {
    if (blankValue === undefined) collect(true, "缺少 sessionListMetadata.blank 字段");
    if (lastPromptValue === undefined) collect(true, "缺少 sessionListMetadata.lastPromptAt 字段");
  }
  const statsRow = readProjCacheRow(cache, "sessionStats");
  collect(!statsRow.ok, statsRow.reason);
  const statsRecord = statsRow.ok ? asRecord(statsRow.value) : undefined;
  const turnsValue = statsRecord === undefined ? undefined : readNumber(statsRecord, "turns");
  const stepsValue = statsRecord === undefined ? undefined : readNumber(statsRecord, "steps");
  if (statsRow.ok && turnsValue === undefined) collect(true, "缺少 sessionStats.turns 字段");
  if (statsRow.ok && stepsValue === undefined) collect(true, "缺少 sessionStats.steps 字段");
  const turns: FieldValue<number> =
    turnsValue === undefined
      ? { value: null, unavailable: true }
      : { value: turnsValue, unavailable: false };
  const steps: FieldValue<number> =
    stepsValue === undefined
      ? { value: null, unavailable: true }
      : { value: stepsValue, unavailable: false };
  const presetRow = readProjCacheRow(cache, "agentPreset");
  collect(!presetRow.ok, presetRow.reason);
  const agentPreset: FieldValue<string> = presetRow.ok
    ? typeof presetRow.value === "string"
      ? { value: presetRow.value, unavailable: false }
      : { value: null, unavailable: false }
    : { value: null, unavailable: true };
  const modelRow = readProjCacheRow(cache, "modelSelection");
  collect(!modelRow.ok, modelRow.reason);
  const modelValue = modelRow.ok ? parseModelView(modelRow.value) : undefined;
  if (modelRow.ok && modelValue === undefined) collect(true, "modelSelection 结构无效");
  const model: FieldValue<ModelView> =
    modelValue === undefined
      ? { value: null, unavailable: true }
      : { value: modelValue, unavailable: false };
  const tokenRow = readProjCacheRow(cache, "tokenUsage");
  collect(!tokenRow.ok, tokenRow.reason);
  const tokenValue = tokenRow.ok ? parseTokenTotals(tokenRow.value) : undefined;
  if (tokenRow.ok && tokenValue === undefined) collect(true, "tokenUsage 结构无效");
  const tokens: FieldValue<TokenTotals> =
    tokenValue === undefined
      ? { value: null, unavailable: true }
      : { value: tokenValue, unavailable: false };
  return {
    available: cache.available,
    reasons: [...new Set(reasons)],
    title,
    blank,
    lastPromptAt,
    turns,
    steps,
    agentPreset,
    model,
    tokens,
  };
}

/** 计算有效"最近活动时间"：lastPromptAt，缺失取 createdAt。 */
export function lastActivityAtOf(entry: SessionEntry, metadata: MetadataView): number {
  if (metadata.lastPromptAt.value !== null) return metadata.lastPromptAt.value;
  return readNumber(entry.header, "createdAt") ?? 0;
}

/** 加载 workspace.json（缺失或不可解析时返回空表；仅提供标题与路径匹配）。 */
export function loadWorkspaceIndex(dshHome: string): WorkspaceEntry[] {
  const path = join(dshHome, "storages", "workspace.json");
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const document = asRecord(parsed);
  const tables = document === undefined ? undefined : asRecord(document.tables);
  const workspaces = tables === undefined ? undefined : asRecord(tables.workspaces);
  if (workspaces === undefined) return [];
  const entries: WorkspaceEntry[] = [];
  for (const [id, raw] of Object.entries(workspaces)) {
    const record = asRecord(raw);
    if (record === undefined) continue;
    const workspacePath = readString(record, "path") ?? "";
    const title = readString(record, "title") ?? "";
    const sessionIds = (asArray(record.sessionIds) ?? []).filter(
      (value): value is string => typeof value === "string",
    );
    entries.push({ id, path: workspacePath, title, sessionIds });
  }
  return entries;
}
