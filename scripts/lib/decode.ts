// 官方格式库接入（readHeader/createRestore/decodeRow/finish）＋事件模型工具。
// 兼容性设计：官方库 API 收敛在本文件单点适配；不静态 import 外部包（tsc 解析不到），
// 一律经 createRequire 锚点解析后动态 import（spike 已验证的机制）。
// 解码策略（P0 spike 结论）：生产读取 = { recovery: 'recoverable', validation: 'transformed' }；
// 强制一致性校验：输入事件行数必须等于 artifact.events.length，否则视为数据不完整（致命）。
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
export interface SessionFormatCatalog {
  readonly currentVersion: number;
  readHeader(headerValue: unknown): HeaderClassification;
  createRestore(headerValue: unknown, options: RestoreOptions): CatalogRestore;
}

/** 解码异常（可继续的物理/行级问题；输出必须显式标注）。 */
export interface DecodeAnomaly {
  readonly kind: "torn-tail" | "bad-line";
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
    };
    const catalog = module.sessionFormatCatalog;
    if (catalog === undefined)
      return { success: false, error: "官方格式库未导出 sessionFormatCatalog" };
    return { success: true, data: catalog };
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
 * - 一致性校验失败（输入事件行数 != artifact.events.length，即 recoverable 模式静默丢弃）。
 * 非失败异常（记入 anomalies，输出显式标注）：尾部撕裂帧（options.tornTail）、行 JSON 解析失败。
 */
export function decodeSessionLog(
  catalog: SessionFormatCatalog,
  logText: string,
  options: { readonly tornTail: boolean },
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
  const classification = catalog.readHeader(headerValue);
  if (classification.status === "malformed" || classification.status === "unsupported") {
    return {
      success: false,
      error: `header 分类为 ${classification.status}: ${classification.reason ?? ""}`,
    };
  }
  let restore: CatalogRestore;
  try {
    restore = catalog.createRestore(headerValue, {
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
  if (artifact.events.length !== parsedEventCount) {
    return {
      success: false,
      error: `解码不一致: 输入 ${parsedEventCount} 行，解码得到 ${artifact.events.length} 个事件`,
    };
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

/** 拼接 content 块中的 text 文本。 */
export function textFromBlocks(blocks: unknown): string {
  const array = asArray(blocks);
  if (array === undefined) return "";
  const parts: string[] = [];
  for (const block of array) {
    const record = asRecord(block);
    if (record === undefined) continue;
    if (readString(record, "type") !== "text") continue;
    const text = readString(record, "text");
    if (text !== undefined) parts.push(text);
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

/** 从 tool/result 事件 data.message.content 中抽取工具结果文本。 */
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
    if (readString(record, "type") !== "tool-result") continue;
    const nested = textFromBlocks(record.content);
    if (nested.length > 0) parts.push(nested);
  }
  return parts.join("\n");
}
