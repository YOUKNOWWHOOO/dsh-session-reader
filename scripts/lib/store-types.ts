// 会话数据层：发现（canonical generation 选择）、三源元数据合并（header + projcache + workspace.json）、
// 读取/搜索/统计/完整性校验。
// 数据契约（方案 §2.6/§2.7）：日志只读；projcache 是列表/统计元数据的唯一来源（version + identity 校验，
// 失败/缺失一律显式标注"元数据不可用"，不静默空值）；workspace.json 仅提供工作区标题。
// 本模块是数据层的共享类型词表：跨模块使用的数据类型只在此处定义一次
// （StoreError 错误分类、发现/元数据/列表/检索/统计/校验的视图与 outcome 接口），各实现模块按需以
// `import type` 引入，从而让实现模块之间只依赖类型、不互相依赖内部结构。
// 主要入口：无运行时导出——纯类型模块，不得在此加入 I/O、常量或函数。
// 关键依赖：decode.ts（DecodedSession/SessionFormatCatalog 的类型引用，仅类型，无运行时依赖）。
// 设计约束：字段级可用性用 FieldValue 显式表达（unavailable=true 表示不可用而非空值）；
// 每个 outcome 都自带覆盖声明与（检索/统计的）扫描摘要，调用方无需读源码即可判断结论强度。

import type { DecodedSession, SessionFormatCatalog } from "./decode.ts";
import type { SourceAttribution } from "./message-source.ts";

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
  readonly catalogsBySessionId: ReadonlyMap<string, SessionFormatCatalog>;
  readonly historicalChildFailuresBySessionId: ReadonlyMap<string, readonly string[]>;
}

export function catalogForEntry(ctx: StoreContext, entry: SessionEntry): SessionFormatCatalog {
  return ctx.catalogsBySessionId.get(entry.id) ?? ctx.catalog;
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
  /** 本次作用域内的会话数，恒等于 `includedCount + excluded.length`。 */
  readonly scannedCount: number;
  /** 实际进入本次结论的会话数：范围过滤后的会话数减去其中解码失败者。 */
  readonly includedCount: number;
  /** 被排除的会话。 */
  readonly excluded: readonly CoverageSkip[];
  /**
   * 归属未知的跳过项（仅 `show` 使用）：header 不可读时既取不到 id 与父子关系，
   * 也无从判定它是否属于目标子树，因此既不列入 `excluded`、也不计入 `scannedCount`，
   * 只作为读取缺口显式声明——静默消失会让"导出了整棵子树"这一预期落空而无从察觉。
   */
  readonly unattributable?: readonly CoverageSkip[];
}

/** 覆盖声明中被排除或归属未知的一项：`id` 在 header 不可读时为会话目录名。 */
export interface CoverageSkip {
  readonly id: string;
  readonly reason: string;
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
  /**
   * 该命中所属事件的来源归属：`user/message` 事件恒给出（`kind` 为 `user` 表示用户本人），
   * 其它事件类型为 null。存在理由是"`**用户**`/`user` 标签会把子代理中继与插件注入显示成用户消息"，
   * 调用方必须能仅凭产物区分消息由谁提供。
   */
  readonly source: SourceAttribution | null;
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
   * 命中总数是否为精确值。类型为字面量 `true`：证据链 ① 检索阶段对纳入会话不做任何提前终止
   * （`totalHits` 全量计数，`--limit` 只限制 `hits` 数组的收集）；② `scope=all` 时每个事件的
   * 完整 JSON 载荷都是检索单元，任意事件的任意字符串必然可命中；③ 未纳入的会话逐条列入
   * `coverage.excluded` 并给出原因，属于"显式排除"而非"未确定"。因此不存在"下界"形态，
   * 渲染层不得保留对应的分支（保留即为不可达代码）。
   */
  readonly totalIsExact: true;
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

/** 容忍 header 不可读会话的发现结果（供 show 目标解析与子代理发现使用）。 */
export interface TolerantDiscovery {
  readonly entries: SessionEntry[];
  readonly skipped: { readonly idFromDir: string; readonly error: string }[];
}

export interface SessionView {
  readonly entry: SessionEntry;
  readonly metadata: MetadataView;
  readonly lastActivityAt: number;
  readonly workspaceTitle: string | null;
}

export interface ScopeSelection {
  readonly views: SessionView[];
  readonly scannedCount: number;
  readonly hiddenBlankCount: number;
  readonly coverage: SessionCoverage;
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
