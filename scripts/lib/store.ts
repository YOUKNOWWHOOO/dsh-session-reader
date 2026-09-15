// 会话数据层：发现（canonical generation 选择）、三源元数据合并（header + projcache + workspace.json）、
// 读取/搜索/统计/完整性校验。
// 数据契约（方案 §2.6/§2.7）：日志只读；projcache 是列表/统计元数据的唯一来源（version + identity 校验，
// 失败/缺失一律显式标注"元数据不可用"，不静默空值）；workspace.json 仅提供工作区标题。
import {
  closeSync,
  type Dirent,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  asArray,
  asRecord,
  type DecodedSession,
  decodeSessionLog,
  type EventRecord,
  eventSeq,
  eventTime,
  eventType,
  readBoolean,
  readNumber,
  readString,
  reasoningFromBlocks,
  type SessionFormatCatalog,
  textFromBlocks,
  toolResultText,
} from "./decode.ts";
import {
  decompressFrame,
  extractLogText,
  scanZstdFrames,
  splitLines,
  type ZstdScanResult,
} from "./frames.ts";
import { normalizePathForCompare, type Result, sessionsRoot } from "./paths.ts";

/** 数据层错误：CLI 据此映射退出码与 stderr 分类。 */
export interface StoreError {
  readonly category:
    | "argument-invalid"
    | "target-missing"
    | "ambiguous"
    | "data-unreadable"
    | "internal";
  readonly detail?: string;
  readonly candidates?: number;
  /** 帧解压失败的帧数（仅 data-unreadable 路径可能携带；供扫描摘要累加）。 */
  readonly frameFailures?: number;
}

/** 已发现的会话条目（header 已通过官方库分类为 current/migration-required）。 */
export interface SessionEntry {
  readonly id: string;
  readonly projectDirName: string;
  readonly dirPath: string;
  readonly logPath: string;
  readonly logVersion: number;
  readonly logCompressed: boolean;
  readonly sizeBytes: number;
  readonly header: Record<string, unknown>;
}

/** 数据层上下文。 */
export interface StoreContext {
  readonly dshHome: string;
  readonly catalog: SessionFormatCatalog;
}

/** projcache 加载结果。 */
export interface ProjCacheState {
  readonly available: boolean;
  readonly reason: string | null;
  readonly rows: Record<string, unknown>;
}

/** 工作区登记项（来自 workspace.json）。 */
export interface WorkspaceEntry {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly sessionIds: string[];
}

/** 模型选择视图。 */
export interface ModelView {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: string | null;
}

/** 令牌总计视图（projcache tokenUsage.totals 结构）。 */
export interface TokenTotals {
  readonly uncachedInputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** 字段值：value=null 表示空值；unavailable=true 表示因元数据问题不可用（必须显式标注）。 */
export interface FieldValue<T> {
  readonly value: T | null;
  readonly unavailable: boolean;
}

/**
 * 覆盖声明（对应"边界可自证"契约）：让调用方无需读源码即可判断结论强度。
 * `excluded` 逐条列出被排除的会话与原因——排除是显式的，而不是静默漏读，
 * 这是"检索 0 命中 ⇒ 不存在"这类全称断言能够成立的前提。
 */
export interface SessionCoverage {
  /** 枚举到的会话目录数（不读 header，因此包含 header 不可读者）。 */
  readonly scannedCount: number;
  /** 实际纳入本次结论的会话数。 */
  readonly includedCount: number;
  /** 被排除的会话：id 为会话目录名（header 不可读时无从取得逻辑 id）。 */
  readonly excluded: { readonly id: string; readonly reason: string }[];
}

/**
 * 扫描摘要（对应"0 命中没有分母"的缺陷）：给出"读了什么、读了多少、有没有读失败、覆盖到什么时间"。
 * 与 `SessionCoverage` 的分工：覆盖声明回答"哪些会话进了结论"，扫描摘要回答"这些会话的日志被读到了什么程度"。
 * 两者合起来才使"0 命中"可自证——只有会话集合与日志读取都完整，0 才等价于不存在。
 *
 * 时间范围的来源是**事件自带的 `time` 字段**（读日志时顺带得到，不需要额外 I/O），
 * 不是会话的"最近活动时间"（后者来自 projcache，语义不同，混用会让调用方误判覆盖区间）。
 */
export interface ScanSummary {
  /** 成功解压并解码日志的份数。 */
  readonly logsDecoded: number;
  /** 解码得到的逻辑事件总数。 */
  readonly eventsRead: number;
  /** 解码失败的日志份数（逐条列在 `coverage.excluded` 中，原因="解码失败"）。 */
  readonly decodeFailures: number;
  /** 帧解压失败的帧数累计（帧级失败会让整份日志按解码失败处理）。 */
  readonly frameFailures: number;
  /** 观测到的事件时间下界（无事件时为 null）。 */
  readonly observedFrom: number | null;
  /** 观测到的事件时间上界（无事件时为 null）。 */
  readonly observedTo: number | null;
}

/** 空扫描摘要（无会话或无事件时的起点）。 */
export function emptyScanSummary(): ScanSummary {
  return {
    logsDecoded: 0,
    eventsRead: 0,
    decodeFailures: 0,
    frameFailures: 0,
    observedFrom: null,
    observedTo: null,
  };
}

/**
 * 把一次日志读取并入扫描摘要（纯函数，逐日志累加）。
 *
 * @param summary 已有摘要。
 * @param metrics 本次读取的度量（失败时只有 `frameFailures` 有效）。
 * @returns 新的摘要（不修改入参）。
 */
export function accumulateScanSummary(summary: ScanSummary, metrics: DecodeMetrics): ScanSummary {
  if (!metrics.success) {
    return {
      ...summary,
      decodeFailures: summary.decodeFailures + 1,
      frameFailures: summary.frameFailures + metrics.frameFailures,
    };
  }
  return {
    logsDecoded: summary.logsDecoded + 1,
    eventsRead: summary.eventsRead + metrics.eventCount,
    decodeFailures: summary.decodeFailures,
    frameFailures: summary.frameFailures + metrics.frameFailures,
    observedFrom:
      metrics.observedFrom === null
        ? summary.observedFrom
        : summary.observedFrom === null
          ? metrics.observedFrom
          : Math.min(summary.observedFrom, metrics.observedFrom),
    observedTo:
      metrics.observedTo === null
        ? summary.observedTo
        : summary.observedTo === null
          ? metrics.observedTo
          : Math.max(summary.observedTo, metrics.observedTo),
  };
}

/** 单会话元数据视图（projcache 派生）。 */
export interface MetadataView {
  readonly available: boolean;
  readonly reasons: string[];
  readonly title: FieldValue<string>;
  readonly blank: FieldValue<boolean>;
  readonly lastPromptAt: FieldValue<number>;
  readonly turns: FieldValue<number>;
  readonly steps: FieldValue<number>;
  readonly agentPreset: FieldValue<string>;
  readonly model: FieldValue<ModelView>;
  readonly tokens: FieldValue<TokenTotals>;
}

/** 列表过滤条件。 */
export interface ListFilters {
  readonly workspace?: string;
  readonly since?: number;
  readonly until?: number;
  readonly title?: string;
  readonly origin: "all" | "main" | "subagent";
  readonly includeBlank: boolean;
  readonly limit: number;
  readonly sort: "time" | "created" | "title" | "size" | "turns";
}

/** 列表条目。 */
export interface ListEntry {
  readonly id: string;
  readonly type: "main" | "subagent";
  readonly cwd: string | null;
  readonly workspaceTitle: string | null;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly sizeBytes: number;
  readonly metadata: MetadataView;
}

/** 列表结果。 */
export interface ListOutcome {
  readonly entries: ListEntry[];
  readonly matchedCount: number;
  readonly scannedCount: number;
  readonly hiddenBlankCount: number;
  readonly coverage: SessionCoverage;
}

/** 一次完整解码的日志视图。 */
export interface DecodedSessionFile {
  readonly decoded: DecodedSession;
  readonly frames: number;
  readonly tornStart: number | undefined;
  readonly sizeBytes: number;
  /** 本次读取的度量（供扫描摘要累加）。 */
  readonly metrics: DecodeMetrics & { readonly success: true };
}

/** 会话节点（含递归子代理）。 */
export interface SessionNode {
  readonly entry: SessionEntry;
  readonly file: DecodedSessionFile;
  readonly children: SessionNode[];
}

/** 检索选项。 */
export interface SearchOptions {
  readonly scope: "text" | "tools" | "all";
  readonly caseSensitive: boolean;
  readonly context: number;
  readonly limit: number;
}

/** 每会话命中分布：调用方据此剔除被自己语料污染的会话。 */
export interface SessionHitCount {
  readonly sessionId: string;
  readonly type: "main" | "subagent";
  readonly title: string | null;
  readonly hits: number;
}

/** 检索范围过滤（与 list 同源语义）。 */
export interface ScopeFilters {
  readonly workspace?: string;
  readonly since?: number;
  readonly until?: number;
  readonly origin: "all" | "main" | "subagent";
}

/** 命中条目。 */
export interface SearchHit {
  readonly sessionId: string;
  readonly seq: number | null;
  readonly time: number | null;
  readonly label: string;
  readonly excerpt: string;
}

/** 检索结果。 */
export interface SearchOutcome {
  readonly hits: SearchHit[];
  readonly totalHits: number;
  readonly scannedSessions: number;
  readonly truncated: boolean;
  /** 实际参与检索的会话数（= `coverage.includedCount`）。 */
  readonly searchedSessions: number;
  readonly scope: "text" | "tools" | "all";
  /**
   * 命中总数是否为精确值。恒为 true 的证据链：① 检索阶段对纳入会话不做任何提前终止
   * （`totalHits` 全量计数，`--limit` 只限制 `hits` 数组的收集）；② `scope=all` 时每个事件的
   * 完整 JSON 载荷都是检索单元，任意事件的任意字符串必然可命中；③ 未纳入的会话逐条列入
   * `coverage.excluded` 并给出原因，属于"显式排除"而非"未确定"。
   */
  readonly totalIsExact: boolean;
  readonly coverage: SessionCoverage;
  readonly scan: ScanSummary;
  /**
   * 每会话命中分布（含 0 命中的纳入会话），按命中数降序、同数按会话 id 升序。
   *
   * 存在理由（对应"检索被调用方自己的语料污染"）：检索在全库上做，而发起检索的会话与它派出的
   * 子代理会话也在库里，调查结论、复述过的错误串、贴过的代码片段都会被命中。产物必须给出足够信息
   * 让调用方区分"真实会话命中"与"自己的笔记命中"——只给一个总数会把污染藏起来。
   */
  readonly distribution: SessionHitCount[];
}

/** 统计结果。 */
export interface StatsOutcome {
  readonly kind: "global" | "single";
  readonly sessionCount: number;
  readonly blankCount: number;
  readonly turns: number;
  readonly steps: number;
  readonly toolCalls: number;
  readonly tokens: TokenTotals;
  readonly earliestCreatedAt: number | null;
  readonly latestActivityAt: number | null;
  readonly totalSizeBytes: number;
  readonly unavailable: { readonly id: string; readonly reasons: string[] }[];
  /** 全局聚合中轮次或步数不可用（未计入总和）的会话数；单会话恒为 0。摘要行据此显式附注。 */
  readonly excludedMetricSessions: number;
  readonly coverage: SessionCoverage;
  readonly scan: ScanSummary;
  readonly single: SingleSessionStats | null;
}

/** 单会话统计。 */
export interface SingleSessionStats {
  readonly id: string;
  readonly title: FieldValue<string>;
  readonly blank: FieldValue<boolean>;
  readonly turns: FieldValue<number>;
  readonly steps: FieldValue<number>;
  readonly agentPreset: FieldValue<string>;
  readonly model: FieldValue<ModelView>;
  readonly tokens: FieldValue<TokenTotals>;
  readonly toolCalls: number;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly metadataAvailable: boolean;
  readonly metadataReasons: string[];
  readonly logPath: string;
  readonly logVersion: number;
  readonly logCompressed: boolean;
  readonly sizeBytes: number;
}

/** 单会话校验结果。 */
export interface CheckSessionResult {
  readonly id: string;
  readonly logPath: string;
  readonly formatVersion: number | null;
  readonly classification: string | null;
  readonly structure: string;
  readonly structureDetail: string | null;
  readonly frames: number | null;
  readonly lineCount: number | null;
  readonly seqContiguous: boolean | null;
  readonly badLineCount: number;
  readonly anomalies: string[];
}

/** 校验结果。 */
export interface CheckOutcome {
  readonly sessions: CheckSessionResult[];
  readonly anomalyCount: number;
  readonly coverage: SessionCoverage;
}

const PROJCACHE_VERSION = 7;
const GENERATION_FILE_PATTERN = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/u;
const HEADER_FRAME_INITIAL_BYTES = 65536;
const MIN_PREFIX_LENGTH = 8;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function storeFail(
  category: StoreError["category"],
  detail?: string,
  extra?: { readonly frameFailures: number },
): { success: false; error: StoreError } {
  return {
    success: false,
    error: {
      category,
      ...(detail === undefined ? {} : { detail }),
      ...(extra === undefined ? {} : { frameFailures: extra.frameFailures }),
    },
  };
}

function entryCwdNormalized(entry: SessionEntry): string {
  const cwd = readString(entry.header, "cwd");
  return cwd === undefined ? "" : normalizePathForCompare(cwd);
}

function entryIsSubagent(entry: SessionEntry): boolean {
  return readString(entry.header, "origin") === "subagent";
}

/** 解析单帧头部文本（压缩文件：按块增长读取，只解压第一个完整帧）。 */
function readCompressedHeaderLine(logPath: string): Result<string, string> {
  const fileSize = statSync(logPath).size;
  if (fileSize === 0) return { success: false, error: "日志文件为空" };
  const fd = openSync(logPath, "r");
  try {
    let capacity = Math.min(fileSize, HEADER_FRAME_INITIAL_BYTES);
    for (;;) {
      const buffer = Buffer.alloc(capacity);
      const bytesRead = readSync(fd, buffer, 0, capacity, 0);
      const slice = buffer.subarray(0, bytesRead);
      let scan: ZstdScanResult;
      try {
        scan = scanZstdFrames(slice, 1);
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
      const frame = scan.frames[0];
      if (frame !== undefined) {
        try {
          return { success: true, data: decompressFrame(slice, frame).toString("utf8") };
        } catch (error) {
          return { success: false, error: `header 帧解压失败: ${errorMessage(error)}` };
        }
      }
      if (bytesRead >= fileSize) return { success: false, error: "header 帧不完整（截断文件）" };
      capacity = Math.min(fileSize, capacity * 2);
    }
  } finally {
    closeSync(fd);
  }
}

/** 读取日志首行（明文：整文件读取取首行；压缩：只读取并解压第一个完整帧）。 */
function readHeaderLine(entry: {
  readonly logPath: string;
  readonly logCompressed: boolean;
}): Result<string, string> {
  let rawText: string;
  if (entry.logCompressed) {
    const header = readCompressedHeaderLine(entry.logPath);
    if (!header.success) return header;
    rawText = header.data;
  } else {
    try {
      rawText = readFileSync(entry.logPath, "utf8");
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }
  const lines = splitLines(rawText);
  if (lines.length === 0) return { success: false, error: "日志为空" };
  return { success: true, data: lines[0] };
}

/** 会话文件引用（仅路径层信息，不读取 header；check 诊断路径使用）。 */
export interface SessionFileRef {
  readonly idFromDir: string;
  readonly projectDirName: string;
  readonly dirPath: string;
  readonly logPath: string;
  readonly logVersion: number;
  readonly logCompressed: boolean;
  readonly sizeBytes: number;
}

/** 枚举全部 canonical generation 文件（多代并存取最高版本，同版本优先 .zstd；不读 header）。 */
export function enumerateSessionFiles(dshHome: string): Result<SessionFileRef[], StoreError> {
  const root = sessionsRoot(dshHome);
  if (!existsSync(root)) return storeFail("target-missing", `sessions 目录不存在: ${root}`);
  let projectDirents: Dirent[];
  try {
    projectDirents = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    return storeFail("data-unreadable", errorMessage(error));
  }
  const refs: SessionFileRef[] = [];
  for (const projectDirent of projectDirents) {
    if (!projectDirent.isDirectory()) continue;
    const projectDirPath = join(root, projectDirent.name);
    let sessionDirents: Dirent[];
    try {
      sessionDirents = readdirSync(projectDirPath, { withFileTypes: true });
    } catch (error) {
      return storeFail("data-unreadable", errorMessage(error));
    }
    for (const sessionDirent of sessionDirents) {
      if (!sessionDirent.isDirectory()) continue;
      const dirPath = join(projectDirPath, sessionDirent.name);
      const candidates: { path: string; version: number; compressed: boolean }[] = [];
      let fileDirents: Dirent[];
      try {
        fileDirents = readdirSync(dirPath, { withFileTypes: true });
      } catch (error) {
        return storeFail("data-unreadable", errorMessage(error));
      }
      for (const fileDirent of fileDirents) {
        if (!fileDirent.isFile()) continue;
        const match = GENERATION_FILE_PATTERN.exec(fileDirent.name);
        if (match === null) continue;
        const version = match[1] === undefined ? 0 : Number(match[1]);
        const compressed = fileDirent.name.endsWith(".zstd");
        candidates.push({ path: join(dirPath, fileDirent.name), version, compressed });
      }
      if (candidates.length === 0) continue;
      candidates.sort((left, right) => {
        if (left.version !== right.version) return left.version - right.version;
        return Number(left.compressed) - Number(right.compressed);
      });
      const selected = candidates[candidates.length - 1];
      refs.push({
        idFromDir: sessionDirent.name,
        projectDirName: projectDirent.name,
        dirPath,
        logPath: selected.path,
        logVersion: selected.version,
        logCompressed: selected.compressed,
        sizeBytes: statSync(selected.path).size,
      });
    }
  }
  return { success: true, data: refs };
}

/** 容忍 header 不可读会话的发现结果（供 show 目标解析与子代理发现使用）。 */
export interface TolerantDiscovery {
  readonly entries: SessionEntry[];
  readonly skipped: { readonly idFromDir: string; readonly error: string }[];
}

/** 发现可读会话：逐个读取 header，不可读者记入 skipped 而不中断（损坏兄弟文件不得阻塞健康会话读取）。 */
export function discoverReadableSessions(
  dshHome: string,
  catalog: SessionFormatCatalog,
): Result<TolerantDiscovery, StoreError> {
  const refs = enumerateSessionFiles(dshHome);
  if (!refs.success) return refs;
  const entries: SessionEntry[] = [];
  const skipped: { idFromDir: string; error: string }[] = [];
  for (const ref of refs.data) {
    const headerLine = readHeaderLine(ref);
    if (!headerLine.success) {
      skipped.push({ idFromDir: ref.idFromDir, error: headerLine.error });
      continue;
    }
    let headerValue: unknown;
    try {
      headerValue = JSON.parse(headerLine.data);
    } catch {
      skipped.push({ idFromDir: ref.idFromDir, error: "header 行不是合法 JSON" });
      continue;
    }
    const classification = catalog.readHeader(headerValue);
    if (classification.status === "malformed" || classification.status === "unsupported") {
      skipped.push({ idFromDir: ref.idFromDir, error: `header 分类 ${classification.status}` });
      continue;
    }
    const logicalHeader = classification.header;
    if (logicalHeader === undefined) {
      skipped.push({ idFromDir: ref.idFromDir, error: "header 分类缺少逻辑 header" });
      continue;
    }
    const id = readString(logicalHeader, "id");
    if (id === undefined) {
      skipped.push({ idFromDir: ref.idFromDir, error: "header 缺少 id" });
      continue;
    }
    entries.push({
      id,
      projectDirName: ref.projectDirName,
      dirPath: ref.dirPath,
      logPath: ref.logPath,
      logVersion: ref.logVersion,
      logCompressed: ref.logCompressed,
      sizeBytes: ref.sizeBytes,
      header: logicalHeader,
    });
  }
  return { success: true, data: { entries, skipped } };
}

/** 从发现结果构造覆盖声明（excluded 逐条列出，禁止静默丢弃）。 */
function coverageOf(discovery: TolerantDiscovery): SessionCoverage {
  return {
    scannedCount: discovery.entries.length + discovery.skipped.length,
    includedCount: discovery.entries.length,
    excluded: discovery.skipped.map((skipped) => ({
      id: skipped.idFromDir,
      reason: skipped.error,
    })),
  };
}

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

interface SessionView {
  readonly entry: SessionEntry;
  readonly metadata: MetadataView;
  readonly lastActivityAt: number;
  readonly workspaceTitle: string | null;
}

interface ScopeSelection {
  readonly views: SessionView[];
  readonly scannedCount: number;
  readonly hiddenBlankCount: number;
  readonly coverage: SessionCoverage;
}

/**
 * 收集会话视图并应用范围过滤（workspace/since/until/title/origin/空会话）。
 *
 * 容错语义（P7 根因修复）：单个会话 header 不可读时不再让整个聚合命令失败——那会让一份损坏的
 * 日志永久阻断对其余会话的浏览与检索。改为跳过该会话并把"跳过了谁、为什么"写入 coverage，
 * 由渲染层逐条列出。范围过滤后的结果集是"显式的子集"，不是"静默的漏读"。
 */
function collectSessionViews(
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
      // 由 `matchedCount` 与产物行数表达）。把 includedCount 绑到"列出条数"会让恒等式
      // `scanned = included + excluded` 被 `--limit` 打破，调用方也就无法据此核对漏读。
      coverage: selection.data.coverage,
    },
  };
}

/** 一次日志读取的度量（供扫描摘要累加；失败时只有 `frameFailures` 有效）。 */
export type DecodeMetrics =
  | {
      readonly success: false;
      readonly frameFailures: number;
    }
  | {
      readonly success: true;
      readonly eventCount: number;
      readonly frameFailures: number;
      readonly observedFrom: number | null;
      readonly observedTo: number | null;
    };

/**
 * 读取单个会话的完整解码日志。
 *
 * @param entry 会话条目。
 * @param catalog 官方格式库。
 */
export function readSessionFile(
  entry: SessionEntry,
  catalog: SessionFormatCatalog,
): Result<DecodedSessionFile, StoreError> {
  try {
    let text: string;
    let frames: number;
    let tornStart: number | undefined;
    const frameFailures = 0;
    if (entry.logCompressed) {
      const buffer = readFileSync(entry.logPath);
      const extraction = extractLogText(buffer);
      if (extraction.failedFrames.length > 0) {
        const detail = extraction.failedFrames
          .map((failure) => `帧 ${failure.index}: ${failure.message}`)
          .join("；");
        return storeFail("data-unreadable", `帧解压失败: ${detail}`, {
          frameFailures: extraction.failedFrames.length,
        });
      }
      text = extraction.text;
      frames = extraction.frameCount;
      tornStart = extraction.tornStart;
    } else {
      text = readFileSync(entry.logPath, "utf8");
      frames = 1;
      tornStart = undefined;
    }
    const decoded = decodeSessionLog(catalog, text, { tornTail: tornStart !== undefined });
    if (!decoded.success) {
      return storeFail("data-unreadable", decoded.error, { frameFailures });
    }
    const events = decoded.data.events;
    const times = events
      .map((event) => eventTime(event))
      .filter((time): time is number => time !== undefined);
    return {
      success: true,
      data: {
        decoded: decoded.data,
        frames,
        tornStart,
        sizeBytes: entry.sizeBytes,
        metrics: {
          success: true,
          eventCount: events.length,
          frameFailures,
          observedFrom: times.length === 0 ? null : Math.min(...times),
          observedTo: times.length === 0 ? null : Math.max(...times),
        },
      },
    };
  } catch (error) {
    return storeFail("data-unreadable", errorMessage(error), { frameFailures: 0 });
  }
}

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
function resolveTargetWithin(
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

interface SearchUnit {
  readonly label: string;
  readonly text: string;
}

function joinTextParts(parts: string[]): string {
  return parts.filter((part) => part.length > 0).join("\n");
}

function messageContent(event: EventRecord): unknown {
  const message = asRecord(asRecord(event.data)?.message);
  return message === undefined ? undefined : message.content;
}

/**
 * 收集单个事件的可检索文本单元。
 *
 * 三档语义（单调包含）：
 * - `text`：用户/助手正文；
 * - `tools`：另含工具调用参数与工具结果；
 * - `all`：另含推理、系统消息、压缩摘要、命令、标题请求、web 检索请求、交付物、待办、代理信箱，
 *   **以及整条事件记录的完整 JSON 载荷**（label 取事件类型）。
 *
 * `all` 档的穷尽性是"检索 0 命中 ⇒ 不存在"这一推断成立的前提：按类型枚举字段必然有遗漏
 * （实测 `assistant/attempt` 与 `llm/retry` 的 `data.failure` 内嵌上游错误体，此前任何 scope 都检索不到），
 * 只有把整条记录纳入检索才能保证任意事件的任意字符串都可命中。
 */
function collectSearchUnits(event: EventRecord, scope: "text" | "tools" | "all"): SearchUnit[] {
  const type = eventType(event);
  const units: SearchUnit[] = [];
  if (type === "user/message") {
    const text = textFromBlocks(asRecord(event.data)?.content);
    if (text.length > 0) units.push({ label: "user", text });
  } else if (type === "assistant/message") {
    const text = textFromBlocks(messageContent(event));
    if (text.length > 0) units.push({ label: "assistant", text });
  } else if (scope !== "text" && type === "tool/call") {
    const argumentsText = readString(asRecord(event.data) ?? {}, "arguments");
    if (argumentsText !== undefined && argumentsText.length > 0) {
      units.push({ label: "tool/call", text: argumentsText });
    }
  } else if (scope !== "text" && type === "tool/result") {
    const text = toolResultText(event);
    if (text.length > 0) units.push({ label: "tool/result", text });
  }
  if (scope === "all") {
    if (type === "assistant/message") {
      const reasoning = reasoningFromBlocks(messageContent(event));
      if (reasoning.length > 0) units.push({ label: "assistant/reasoning", text: reasoning });
    } else if (type === "system/message") {
      const text = textFromBlocks(messageContent(event));
      if (text.length > 0) units.push({ label: "system", text });
    } else if (type === "compaction/summary") {
      const data = asRecord(event.data) ?? {};
      const text = joinTextParts([textFromBlocks(data.summary), textFromBlocks(data.rawOutput)]);
      if (text.length > 0) units.push({ label: "compaction/summary", text });
    } else if (type === "command/run") {
      const data = asRecord(event.data) ?? {};
      const name = readString(data, "name") ?? "";
      const args = data.args === undefined ? "" : JSON.stringify(data.args);
      const text = `${name} ${args}`.trim();
      if (text.length > 0) units.push({ label: "command/run", text });
    } else if (type === "command/done") {
      const text = readString(asRecord(event.data) ?? {}, "text") ?? "";
      if (text.length > 0) units.push({ label: "command/done", text });
    } else if (type === "session/title-llm-request") {
      const data = asRecord(event.data) ?? {};
      const system = readString(data, "system") ?? "";
      const messages = asArray(data.messages) ?? [];
      const parts = [system];
      for (const message of messages) {
        const record = asRecord(message);
        if (record === undefined) continue;
        parts.push(textFromBlocks(record.content));
      }
      const text = joinTextParts(parts);
      if (text.length > 0) units.push({ label: "title-request", text });
    } else if (type === "web/deepseek-search-llm-request") {
      const body = asRecord(event.data)?.body;
      if (body !== undefined) {
        const text = JSON.stringify(body);
        if (text.length > 0) units.push({ label: "web-search-request", text });
      }
    } else if (type === "deliverables/presented") {
      const files = asArray(asRecord(event.data)?.files) ?? [];
      const parts: string[] = [];
      for (const file of files) {
        const record = asRecord(file);
        if (record === undefined) continue;
        const description = readString(record, "description");
        const path = readString(record, "path");
        if (description !== undefined) parts.push(description);
        if (path !== undefined) parts.push(path);
      }
      const text = joinTextParts(parts);
      if (text.length > 0) units.push({ label: "deliverables", text });
    } else if (type === "todo/write") {
      const todos = asArray(asRecord(event.data)?.todos) ?? [];
      const parts: string[] = [];
      for (const todo of todos) {
        const record = asRecord(todo);
        if (record === undefined) continue;
        const content = readString(record, "content");
        const status = readString(record, "status");
        if (content !== undefined) parts.push(content);
        if (status !== undefined) parts.push(status);
      }
      const text = joinTextParts(parts);
      if (text.length > 0) units.push({ label: "todo", text });
    } else if (type === "agent/inbox/spliced") {
      const inserted = asArray(asRecord(event.data)?.inserted) ?? [];
      const parts: string[] = [];
      for (const message of inserted) {
        const record = asRecord(message);
        if (record === undefined) continue;
        parts.push(textFromBlocks(record.content));
      }
      const text = joinTextParts(parts);
      if (text.length > 0) units.push({ label: "agent/inbox", text });
    }
    // 穷尽兜底：把整条事件记录的完整 JSON 载荷作为检索单元。
    // 这是"检索 0 命中 ⇒ 不存在"能够成立的前提——上面按类型枚举的字段必然有遗漏
    // （实测遗漏的类型包括 assistant/attempt 与 llm/retry，其 data.failure 里内嵌了上游错误体），
    // 只有覆盖整条记录才能保证任意事件的任意字符串都可被检索到。label 取事件类型本身，便于定位。
    const raw = eventPayloadJson(event);
    if (raw.length > 0) units.push({ label: type.length === 0 ? "(未知类型)" : type, text: raw });
  }
  return units;
}

/**
 * 事件记录的完整 JSON 序列化载荷。
 * 循环引用等无法序列化的记录返回空串（该事件由按类型枚举的单元覆盖），不抛错也不伪造占位文本。
 */
function eventPayloadJson(event: EventRecord): string {
  try {
    return JSON.stringify(event);
  } catch {
    return "";
  }
}

/**
 * search 命令数据：按范围过滤会话，逐会话解码并按 scope 检索。
 *
 * 关键契约：
 * 1. `--limit` 只限制 `hits` 数组的收集上限，`totalHits` 对纳入会话全量计数且不做任何提前终止，
 *    因此"命中总数"不是显示条数的副产品（`totalIsExact` 恒为 true，证据见该字段注释）。
 * 2. 单个会话解码失败不会让整次检索失败，而是记入 `coverage.excluded`（原因="解码失败"）并继续。
 *    这是"未被列出者即为已覆盖"这一推断成立的前提——静默跳过或整体失败都会让调用方无法判断
 *    "0 命中"到底是"不存在"还是"没读到"。
 * 3. `distribution` 逐会话给出命中数（含 0 命中的纳入会话），使调用方能把自己会话与子代理会话的
 *    命中从结论中剔除；`excludeSessionTarget` 提供同一件事的自动化形式。
 *
 * @param sessionTarget 只检索该会话及其子代理子树；undefined 表示不限。
 * @param excludeSessionTarget 排除该会话及其子代理子树（与 `sessionTarget` 以差集生效）。
 */
export function runSearch(
  ctx: StoreContext,
  keyword: string,
  scopeFilters: ScopeFilters,
  options: SearchOptions,
  sessionTarget?: string,
  excludeSessionTarget?: string,
): Result<SearchOutcome, StoreError> {
  const discovery = discoverReadableSessions(ctx.dshHome, ctx.catalog);
  if (!discovery.success) return discovery;
  const discoveryCoverage = coverageOf(discovery.data);

  // `--session`/`--exclude-session` 的子树展开与目标解析共用同一次发现结果，
  // 避免重复扫描造成两次读取之间的一致性漂移。
  const subtreeIds = (target: string): Result<Set<string>, StoreError> => {
    const resolved = resolveTargetWithin(discovery.data, target, ctx.dshHome);
    if (!resolved.success) return resolved;
    const subtree = collectSubtreeEntries(resolved.data, discovery.data.entries);
    return { success: true, data: new Set(subtree.map((entry) => entry.id)) };
  };
  let sessionIds: Set<string> | null = null;
  if (sessionTarget !== undefined) {
    const resolved = subtreeIds(sessionTarget);
    if (!resolved.success) return resolved;
    sessionIds = resolved.data;
  }
  let excludedIds: Set<string> | null = null;
  if (excludeSessionTarget !== undefined) {
    const resolved = subtreeIds(excludeSessionTarget);
    if (!resolved.success) return resolved;
    excludedIds = resolved.data;
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
  const views = selection.data.views.filter(
    (view) =>
      (sessionIds === null || sessionIds.has(view.entry.id)) &&
      (excludedIds === null || !excludedIds.has(view.entry.id)),
  );

  const needle = options.caseSensitive ? keyword : keyword.toLowerCase();
  const hits: SearchHit[] = [];
  let totalHits = 0;
  const decodeFailures: { id: string; reason: string }[] = [];
  const distribution: SessionHitCount[] = [];
  let scan = emptyScanSummary();
  for (const view of views) {
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
    let sessionHits = 0;
    for (const event of file.data.decoded.events) {
      for (const unit of collectSearchUnits(event, options.scope)) {
        const haystack = options.caseSensitive ? unit.text : unit.text.toLowerCase();
        let from = 0;
        for (;;) {
          const at = haystack.indexOf(needle, from);
          if (at < 0) break;
          totalHits += 1;
          sessionHits += 1;
          if (options.limit === 0 || hits.length < options.limit) {
            // 按 Unicode 码点计算上下文窗口（与 truncateText 同口径；先把 UTF-16 索引折算为码点数），
            // 避免在代理对（surrogate pair）中间切片产生孤立代理项（UTF-8 落盘后会变为 U+FFFD）。
            const points = [...unit.text];
            const startPoint = Math.max(0, [...unit.text.slice(0, at)].length - options.context);
            const endPoint = Math.min(
              points.length,
              [...unit.text.slice(0, at + needle.length)].length + options.context,
            );
            const excerpt = `${startPoint > 0 ? "…" : ""}${points.slice(startPoint, endPoint).join("")}${endPoint < points.length ? "…" : ""}`;
            hits.push({
              sessionId: view.entry.id,
              seq: eventSeq(event) ?? null,
              time: eventTime(event) ?? null,
              label: unit.label,
              // 文本输出要求“每命中一条”独占一行：片段内换行折叠为空格。
              excerpt: excerpt.replaceAll("\n", " "),
            });
          }
          from = at + needle.length;
        }
      }
    }
    distribution.push({
      sessionId: view.entry.id,
      type: entryIsSubagent(view.entry) ? "subagent" : "main",
      title: view.metadata.title.value,
      hits: sessionHits,
    });
  }
  distribution.sort((left, right) => {
    if (left.hits !== right.hits) return right.hits - left.hits;
    return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0;
  });
  const shown = hits.length;
  const excluded = [...discoveryCoverage.excluded, ...decodeFailures];
  return {
    success: true,
    data: {
      hits,
      totalHits,
      scannedSessions: views.length,
      truncated: totalHits > shown,
      searchedSessions: views.length,
      scope: options.scope,
      totalIsExact: true,
      // 恒等式 `scannedCount = includedCount + excluded.length` 必须成立：纳入数是本次实际检索的
      // 会话数，排除项是发现阶段跳过与解码阶段失败两类，调用方据此核对是否存在未列出的漏读。
      coverage: {
        scannedCount: views.length + excluded.length,
        includedCount: views.length,
        excluded,
      },
      scan,
      distribution,
    },
  };
}

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
    const file = readSessionFile(entry, ctx.catalog);
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
        scannedCount: selection.data.views.length + excluded.length,
        includedCount: selection.data.views.length,
        excluded,
      },
      scan,
      single: null,
    },
  };
}

function checkOneSession(ref: SessionFileRef, catalog: SessionFormatCatalog): CheckSessionResult {
  const anomalies: string[] = [];
  let id = ref.idFromDir;
  let formatVersion: number | null = null;
  let classification: string | null = null;
  let structure = "完整";
  let structureDetail: string | null = null;
  let frames: number | null = null;
  let lineCount: number | null = null;
  let seqContiguous: boolean | null = null;
  let badLineCount = 0;
  try {
    let text: string;
    if (ref.logCompressed) {
      const buffer = readFileSync(ref.logPath);
      const extraction = extractLogText(buffer);
      frames = extraction.frameCount;
      for (const failure of extraction.failedFrames) {
        anomalies.push(`帧解压失败: 第 ${failure.index} 帧（${failure.message}）`);
      }
      if (extraction.tornStart !== undefined) {
        structure = `tornStart@${extraction.tornStart}`;
        anomalies.push(`尾部截断: tornStart 位置 ${extraction.tornStart}`);
      }
      text = extraction.text;
    } else {
      text = readFileSync(ref.logPath, "utf8");
      frames = 1;
    }
    const lines = splitLines(text);
    lineCount = lines.length;
    if (lines.length === 0) {
      anomalies.push("日志为空");
    } else {
      try {
        const headerValue = JSON.parse(lines[0]);
        const result = catalog.readHeader(headerValue);
        formatVersion = result.storedVersion ?? null;
        classification = result.status;
        const headerId = readString(result.header ?? {}, "id");
        if (headerId !== undefined && headerId.length > 0) id = headerId;
        if (result.status === "malformed" || result.status === "unsupported") {
          anomalies.push(`header 分类: ${result.status}`);
        }
      } catch {
        anomalies.push("header 行不是合法 JSON");
      }
    }
    let expected = 0;
    let contiguous = true;
    let gapCount = 0;
    for (let index = 1; index < lines.length; index += 1) {
      let row: unknown;
      try {
        row = JSON.parse(lines[index]);
      } catch {
        badLineCount += 1;
        continue;
      }
      const seq = readNumber(asRecord(row) ?? {}, "seq");
      if (seq === undefined) {
        anomalies.push(`第 ${index + 1} 行缺少 seq`);
        continue;
      }
      if (seq !== expected) {
        contiguous = false;
        gapCount += 1;
      }
      expected = seq + 1;
    }
    if (badLineCount > 0) anomalies.push(`坏行 ${badLineCount} 行`);
    if (!contiguous) anomalies.push(`seq 不连续（${gapCount} 处）`);
    seqContiguous = contiguous;
  } catch (error) {
    structure = "结构损坏";
    structureDetail = errorMessage(error);
    anomalies.push(`结构损坏: ${structureDetail}`);
  }
  return {
    id,
    logPath: ref.logPath,
    formatVersion,
    classification,
    structure,
    structureDetail,
    frames,
    lineCount,
    seqContiguous,
    badLineCount,
    anomalies,
  };
}

/**
 * check 命令数据：逐会话结构扫描 + 行/seq/坏行检查；anomalyCount>0 时退出码 3。
 * 无目标时使用不读 header 的枚举（结构损坏/header 不可读的会话也必须能被诊断并如实报告）。
 */
export function runCheck(
  ctx: StoreContext,
  target: string | undefined,
): Result<CheckOutcome, StoreError> {
  let refs: SessionFileRef[];
  if (target !== undefined) {
    const resolved = resolveSessionTarget(ctx, target);
    if (!resolved.success) return resolved;
    const entry = resolved.data;
    refs = [
      {
        idFromDir: entry.id,
        projectDirName: entry.projectDirName,
        dirPath: entry.dirPath,
        logPath: entry.logPath,
        logVersion: entry.logVersion,
        logCompressed: entry.logCompressed,
        sizeBytes: entry.sizeBytes,
      },
    ];
  } else {
    const enumeration = enumerateSessionFiles(ctx.dshHome);
    if (!enumeration.success) return enumeration;
    refs = enumeration.data;
  }
  const sessions = refs.map((ref) => checkOneSession(ref, ctx.catalog));
  const anomalyCount = sessions.reduce((sum, session) => sum + session.anomalies.length, 0);
  // check 走不读 header 的枚举，因此没有"因 header 不可读而被排除的会话"——它们恰恰是本命令的
  // 诊断对象，全部纳入。覆盖声明据此恒为"扫描数 = 纳入数、无排除"。
  return {
    success: true,
    data: {
      sessions,
      anomalyCount,
      coverage: { scannedCount: sessions.length, includedCount: sessions.length, excluded: [] },
    },
  };
}
