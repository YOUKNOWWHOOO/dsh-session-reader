// 校验层：逐会话结构扫描（帧计数、帧解压失败、tornStart 截断）、header 分类、行数、seq 连续性与坏行统计。
// 主要入口：runCheck（check 命令数据）；checkOneSession 为单会话诊断。
// 关键依赖：node:fs、frames.ts（帧提取）、decode.ts（header 分类与取值）、store-discovery.ts（不读 header
// 的枚举与错误消息归一）、store-target.ts（指定目标时复用目标解析）、store-types.ts。
// 设计约束：无目标时走不读 header 的枚举路径，因此结构损坏/header 不可读的会话本身也在诊断范围内，
// 覆盖声明据此恒为“扫描数 = 纳入数、无排除”；异常一律如实记入 anomalies（anomalyCount>0 时退出码 3），
// 不静默吞掉。数据契约见 store-types.ts 文件头。

import { readFileSync } from "node:fs";
import { asRecord, readNumber, readString, type SessionFormatCatalog } from "./decode.ts";
import { extractLogText, splitLines } from "./frames.ts";
import type { Result } from "./paths.ts";
import { enumerateSessionFiles, errorMessage } from "./store-discovery.ts";
import { resolveSessionTarget } from "./store-target.ts";
import type {
  CheckOutcome,
  CheckSessionResult,
  SessionFileRef,
  StoreContext,
  StoreError,
} from "./store-types.ts";

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
