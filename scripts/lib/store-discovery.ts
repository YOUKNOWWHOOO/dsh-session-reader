// 会话发现与读取：canonical generation 选择（多代并存取最高版本、同版本优先 .zstd）、header 行读取与
// 分类（明文整文件取首行 / 压缩文件按块增长只解第一个完整帧）、容错跳过（header 不可读者记入 skipped
// 而不中断）、单会话完整解码读取，以及读取度量与扫描摘要累加。
// 主要入口：enumerateSessionFiles（不读 header，check 诊断路径）、discoverReadableSessions（可读会话 +
// 跳过清单）、readSessionFile（单会话解码 + DecodeMetrics）、coverageOf（发现结果 → 覆盖声明）、
// emptyScanSummary / accumulateScanSummary（扫描摘要）。
// 关键依赖：node:fs/node:path、frames.ts（zstd 帧扫描与解压）、decode.ts（官方格式库与事件取值）、
// store-types.ts（全部跨模块数据类型）。
// 设计约束：日志只读；单个会话不可读不得让整条命令失败——跳过必须逐条记入 TolerantDiscovery.skipped
// 并由 coverageOf 显式列出，禁止静默漏读；失败一律经 storeFail 构造 Result 错误，本模块同时承载全层
// 共用的 storeFail 与 errorMessage（避免为约二十行辅助代码单列文件）。数据契约见 store-types.ts 文件头。

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
import { decodeSessionLog, eventTime, readString, type SessionFormatCatalog } from "./decode.ts";
import {
  decompressFrame,
  extractLogText,
  scanZstdFrames,
  splitLines,
  type ZstdScanResult,
} from "./frames.ts";
import { normalizePathForCompare, type Result, sessionsRoot } from "./paths.ts";
import type {
  DecodedSessionFile,
  DecodeMetrics,
  ScanSummary,
  SessionCoverage,
  SessionEntry,
  SessionFileRef,
  StoreError,
  TolerantDiscovery,
} from "./store-types.ts";

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

const GENERATION_FILE_PATTERN = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/u;
const HEADER_FRAME_INITIAL_BYTES = 65536;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function storeFail(
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

export function entryCwdNormalized(entry: SessionEntry): string {
  const cwd = readString(entry.header, "cwd");
  return cwd === undefined ? "" : normalizePathForCompare(cwd);
}

export function entryIsSubagent(entry: SessionEntry): boolean {
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
export function coverageOf(discovery: TolerantDiscovery): SessionCoverage {
  return {
    scannedCount: discovery.entries.length + discovery.skipped.length,
    includedCount: discovery.entries.length,
    excluded: discovery.skipped.map((skipped) => ({
      id: skipped.idFromDir,
      reason: skipped.error,
    })),
  };
}

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
