// 官方格式库接入（readHeader/createRestore/decodeRow/finish）＋事件模型工具。
// 兼容性设计：官方库 API 收敛在本文件单点适配；不静态 import 外部包（tsc 解析不到），
// 一律经 createRequire 锚点解析后动态 import（spike 已验证的机制）。
// 解码策略：生产读取固定为 { recovery: 'recoverable', validation: 'transformed' }。
// 物理 JSON 行与迁移后的逻辑事件是不同计量，不能用它们的数量相等作为完整性判据。
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { splitLines } from "./frames.ts";
import type { Result } from "./paths.ts";

/** 官方库 readHeader 分类结果（结构镜像自 dsh-session-format 的 SessionFormatHeaderReadResult）。 */
export interface HeaderClassification {
  readonly status: "current" | "migration-required" | "unsupported" | "malformed";
  readonly storedVersion?: number;
  readonly targetVersion: number;
  readonly reason?: string;
  readonly header?: Record<string, unknown>;
}

/** 逻辑事件信封（已解码，字段结构由官方库冻结）。 */
export type EventRecord = Record<string, unknown>;

/** restore.finish() 返回的当前逻辑 artifact。 */
export interface RestoreArtifact {
  readonly header: Record<string, unknown>;
  readonly inheritedEventCount: number;
  readonly events: readonly EventRecord[];
}

/** 单次读取的流式恢复器（官方 SessionFormatRestore 的最小本地镜像）。 */
export interface CatalogRestore {
  readonly header: Record<string, unknown>;
  decodeRow(rowValue: unknown): void;
  finish(): RestoreArtifact;
}

/** restore 选项（官方 SessionFormatRestoreOptions）。 */
export interface RestoreOptions {
  readonly recovery: "strict" | "recoverable";
  readonly validation: "transformed" | "current";
}

/** 官方 catalog 对象的最小本地镜像（仅使用本技能需要的成员）。 */
export interface HistoricalChildCatalogSource {
  readonly childId: string;
  readonly childCreatedAt: number;
  readonly descriptorCount: number;
  readonly descriptor: Record<string, unknown> | null;
  readonly sourcePath?: string;
}

export interface SessionFormatCatalog {
  readonly currentVersion: number;
  readHeader(headerValue: unknown): HeaderClassification;
  createRestore(headerValue: unknown, options: RestoreOptions): CatalogRestore;
  createSessionFormatCatalogWithChildren?: (
    children: readonly HistoricalChildCatalogSource[],
  ) => SessionFormatCatalog;
  historicalSessionFormatCatalog?: SessionFormatCatalog;
  historicalBound?: boolean;
  historicalChildCatalogSource?: (artifact: RestoreArtifact) => HistoricalChildCatalogSource;
}

/**
 * header 分类的唯一入口：官方库 `readHeader` 的全部调用点（含只读 header 的轻量路径）必须经此函数，
 * 使"官方库 API 变化只允许修改 decode.ts 单点适配"这一兼容性约束成立（`doc\开发规范.md` 的数据契约）。
 * 直接调用 `catalog.readHeader` 会让其它模块各自耦合官方签名，升级 dsh 时必然漏改。
 *
 * @param catalog 已加载的官方格式库。
 * @param headerValue 已解析的 header 值（首行 JSON 的产物，可能不是对象）。
 * @returns 官方库的分类结果，原样返回不做任何改写或兜底。
 */
export function classifyHeader(
  catalog: SessionFormatCatalog,
  headerValue: unknown,
): HeaderClassification {
  return catalog.readHeader(headerValue);
}

/** 解码异常（可继续的物理/行级问题；输出必须显式标注）。 */
export interface DecodeAnomaly {
  readonly kind: "torn-tail" | "bad-line" | "historical-child-unreadable";
  readonly detail: string;
}

/** 一次完整解码结果。 */
export interface DecodedSession {
  readonly header: Record<string, unknown>;
  readonly events: EventRecord[];
  readonly inheritedEventCount: number;
  readonly anomalies: DecodeAnomaly[];
  readonly lineCount: number;
  readonly eventLineCount: number;
  readonly parsedEventCount: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 从 `--lib-root`（默认 `<dsh-home>\profiles\node_modules`）解析并加载官方格式库。
 * 失败返回 Result 错误（调用方映射为退出码 3）。
 */
export async function loadCatalog(libRoot: string): Promise<Result<SessionFormatCatalog, string>> {
  try {
    const anchor = join(libRoot, "@deepseek-ai", "dsh-session-format-catalog", "package.json");
    const require = createRequire(anchor);
    const entry = require.resolve("@deepseek-ai/dsh-session-format-catalog");
    const module = (await import(pathToFileURL(entry).href)) as {
      sessionFormatCatalog?: SessionFormatCatalog;
      createSessionFormatCatalogWithChildren?: (
        children: readonly HistoricalChildCatalogSource[],
      ) => SessionFormatCatalog;
      historicalSessionFormatCatalog?: SessionFormatCatalog;
    };
    const catalog = module.sessionFormatCatalog;
    if (catalog === undefined)
      return { success: false, error: "官方格式库未导出 sessionFormatCatalog" };
    const historicalSessionFormatCatalog = module.historicalSessionFormatCatalog;
    const createWithChildren = module.createSessionFormatCatalogWithChildren;
    if (createWithChildren === undefined || historicalSessionFormatCatalog === undefined) {
      return { success: false, error: "官方格式库缺少历史 catalog 或直属子会话 catalog 工厂" };
    }
    const historicalEntry = require.resolve("@deepseek-ai/dsh-session-format-v3-to-v4");
    const historicalModule = (await import(pathToFileURL(historicalEntry).href)) as {
      historicalChildCatalogSource?: (artifact: RestoreArtifact) => HistoricalChildCatalogSource;
    };
    const historicalChildCatalogSource = historicalModule.historicalChildCatalogSource;
    if (historicalChildCatalogSource === undefined) {
      return { success: false, error: "官方格式库缺少 historicalChildCatalogSource" };
    }
    return {
      success: true,
      data: {
        ...catalog,
        ...(historicalSessionFormatCatalog === undefined ? {} : { historicalSessionFormatCatalog }),
        createSessionFormatCatalogWithChildren: createWithChildren,
        historicalChildCatalogSource,
      },
    };
  } catch (error) {
    return { success: false, error: `官方格式库加载失败: ${errorMessage(error)}` };
  }
}

/**
 * 解码完整日志文本：首行 header 分类 → 逐行解码事件 → finish。
 * 失败条件（均返回 Result 错误，调用方按退出码 3 处理）：
 * - header 行不是合法 JSON；
 * - header 分类为 malformed/unsupported；
 * - 任一行 decodeRow 抛错（结构违规）；
 * - finish 抛错；
 * - 官方 catalog 拒绝创建或收尾；
 * - 物理行 JSON 解析失败（记入 anomalies，不中断其余行）。
 * 迁移后逻辑事件数可以与物理事件行数不同，因为官方迁移会重映射、插入或追加逻辑事件；
 * `parsedEventCount` 只表示成功喂入 decoder 的物理行数，不再把合法迁移误判为数据损坏。
 */
export interface SessionDecodeOptions {
  readonly tornTail: boolean;
  readonly historicalChildren?: readonly HistoricalChildCatalogSource[];
  readonly historicalChildFailures?: readonly string[];
}

export function decodeSessionLog(
  catalog: SessionFormatCatalog,
  logText: string,
  options: SessionDecodeOptions,
): Result<DecodedSession, string> {
  const lines = splitLines(logText);
  if (lines.length === 0) return { success: false, error: "日志为空" };
  const headerLine = lines[0];
  let headerValue: unknown;
  try {
    headerValue = JSON.parse(headerLine);
  } catch {
    return { success: false, error: "header 行不是合法 JSON" };
  }
  const classification = classifyHeader(catalog, headerValue);
  if (classification.status === "malformed" || classification.status === "unsupported") {
    return {
      success: false,
      error: `header 分类为 ${classification.status}: ${classification.reason ?? ""}`,
    };
  }
  const storedVersion = classification.storedVersion;
  const isHistorical =
    catalog.currentVersion >= 4 &&
    storedVersion !== undefined &&
    storedVersion < catalog.currentVersion;
  let restore: CatalogRestore;
  try {
    const activeCatalog = isHistorical
      ? catalog.historicalBound
        ? catalog
        : options.historicalChildren === undefined
          ? undefined
          : catalog.createSessionFormatCatalogWithChildren?.(options.historicalChildren)
      : catalog;
    if (activeCatalog === undefined) {
      return { success: false, error: "历史日志需要官方子会话证据 catalog" };
    }
    restore = activeCatalog.createRestore(headerValue, {
      recovery: "recoverable",
      validation: "transformed",
    });
  } catch (error) {
    return { success: false, error: `创建解码器失败: ${errorMessage(error)}` };
  }
  const anomalies: DecodeAnomaly[] = [];
  if (options.tornTail) {
    anomalies.push({ kind: "torn-tail", detail: "尾部未完整帧已丢弃（v1 不做前缀抢救）" });
  }
  for (const detail of options.historicalChildFailures ?? []) {
    anomalies.push({ kind: "historical-child-unreadable", detail });
  }
  let parsedEventCount = 0;
  for (let index = 1; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let row: unknown;
    try {
      row = JSON.parse(lines[index]);
    } catch {
      anomalies.push({ kind: "bad-line", detail: `第 ${lineNumber} 行不是合法 JSON` });
      continue;
    }
    try {
      restore.decodeRow(row);
      parsedEventCount += 1;
    } catch (error) {
      return { success: false, error: `第 ${lineNumber} 行解码失败: ${errorMessage(error)}` };
    }
  }
  let artifact: RestoreArtifact;
  try {
    artifact = restore.finish();
  } catch (error) {
    return { success: false, error: `解码收尾失败: ${errorMessage(error)}` };
  }
  return {
    success: true,
    data: {
      header: artifact.header,
      events: [...artifact.events],
      inheritedEventCount: artifact.inheritedEventCount,
      anomalies,
      lineCount: lines.length,
      eventLineCount: lines.length - 1,
      parsedEventCount,
    },
  };
}

// ------------------------- 事件模型工具 -------------------------

/** 非 null、非数组的对象判型。 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** 数组判型。 */
export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** 读取字符串字段；类型不符返回 undefined。 */
export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * 读取非空字符串字段；缺失、类型不符或空串一律返回 undefined。
 *
 * 存在的理由是消除「取值可能 undefined 却直接当字符串用」这一类静默缺陷：本技能的工具结果
 * 抽取曾因对 `readString(...)` 的结果直接取 `.length` 而在缺字段的输入上抛 TypeError。
 * 调用方用「返回值是否为 undefined」判分支，就同时表达了「字段存在」与「字段非空」。
 */
function readNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = readString(record, key);
  return value === undefined || value.length === 0 ? undefined : value;
}

/** 读取数字字段；类型不符返回 undefined。 */
export function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

/** 读取布尔字段；类型不符返回 undefined。 */
export function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

/** 事件 type。 */
export function eventType(event: EventRecord): string {
  return readString(event, "type") ?? "";
}

/** 事件 seq。 */
export function eventSeq(event: EventRecord): number | undefined {
  return readNumber(event, "seq");
}

/** 事件 time（Unix 毫秒）。 */
export function eventTime(event: EventRecord): number | undefined {
  return readNumber(event, "time");
}

/** 事件 data 对象（非对象时返回空对象）。 */
export function eventData(event: EventRecord): Record<string, unknown> {
  return asRecord(event.data) ?? {};
}

/** 拼接 content 块中的 text 文本；只计 type 为 text 且 text 为非空字符串的块。 */
export function textFromBlocks(blocks: unknown): string {
  const array = asArray(blocks);
  if (array === undefined) return "";
  const parts: string[] = [];
  for (const block of array) {
    const record = asRecord(block);
    if (record === undefined) continue;
    if (readString(record, "type") !== "text") continue;
    const text = readString(record, "text");
    if (text !== undefined && text.length > 0) parts.push(text);
  }
  return parts.join("\n");
}

/** 拼接 content 块中的 reasoning（推理）文本。 */
export function reasoningFromBlocks(blocks: unknown): string {
  const array = asArray(blocks);
  if (array === undefined) return "";
  const parts: string[] = [];
  for (const block of array) {
    const record = asRecord(block);
    if (record === undefined) continue;
    if (readString(record, "type") !== "reasoning") continue;
    const text = readString(record, "text");
    if (text !== undefined) parts.push(text);
  }
  return parts.join("\n");
}

/** 抽取 content 块中的 tool-call 列表。 */
export interface ToolCallBlock {
  readonly id: string | undefined;
  readonly name: string | undefined;
  readonly arguments: string | undefined;
}

export function toolCallsFromBlocks(blocks: unknown): ToolCallBlock[] {
  const array = asArray(blocks);
  if (array === undefined) return [];
  const calls: ToolCallBlock[] = [];
  for (const block of array) {
    const record = asRecord(block);
    if (record === undefined) continue;
    if (readString(record, "type") !== "tool-call") continue;
    calls.push({
      id: readString(record, "id"),
      name: readString(record, "name"),
      arguments: readString(record, "arguments"),
    });
  }
  return calls;
}

/**
 * 从 tool/result 事件 data.message.content 中抽取工具结果文本。
 *
 * 必须兼容两种内容形态，否则对某一代的日志会**静默抽不到任何文本**（实测踩过：只认
 * `tool-result` 嵌套块时，对当前 v4 日志的 410 个工具结果事件全部返回空串，表现为
 * `show --tools` 不显示工具输出、`search --scope tools` 检索不到工具结果）：
 * - 当前 v4：内容块是普通的 `{type:"text", text}`，与消息正文同形；
 * - 旧版本日志：内容是 `{type:"tool-result", content:[…]}` 的嵌套块。
 * 两种都取，互不影响（同一事件不会同时出现两种形态）。
 */
export function toolResultText(event: EventRecord): string {
  const data = eventData(event);
  const message = asRecord(data.message);
  if (message === undefined) return "";
  const content = asArray(message.content);
  if (content === undefined) return "";
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record === undefined) continue;
    const own = readNonEmptyString(record, "text");
    if (own !== undefined) {
      parts.push(own);
      continue;
    }
    if (readString(record, "type") !== "tool-result") continue;
    const nested = textFromBlocks(record.content);
    if (nested.length > 0) parts.push(nested);
  }
  return parts.join("\n");
}
