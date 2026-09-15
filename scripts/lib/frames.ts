// 多帧 zstd 物理层：结构性帧扫描（官方 scanZstdFrames 算法）＋逐帧解压＋行拆分＋撕裂尾处理。
// 官方算法来源：dsh-session-persistence-jsonl/lib/index.js 的 scanZstdFrames（约 1298-1361 行）。
// 设计约束：只做结构性判定（解析帧头/块头，不扫描魔数）；完整帧才参与解压；
// tornStart 之后的内容一律丢弃（v1 不做前缀抢救——官方 decompressZstdPrefix 恢复路径留待后续版本）。
import { zstdDecompressSync } from "node:zlib";

/** 结构性扫描错误：帧结构损坏（魔数无效、保留位、保留块类型等）。 */
export class FrameScanError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FrameScanError";
  }
}

/** 单帧范围（字节偏移半开区间 [start, end)）。 */
export interface ZstdFrameRange {
  readonly start: number;
  readonly end: number;
}

/** 扫描结果：完整帧列表；tornStart 存在时表示自该偏移起的尾部不是完整帧。 */
export interface ZstdScanResult {
  readonly frames: ZstdFrameRange[];
  readonly tornStart?: number;
}

// ZSTD 帧魔数（字节序列 FD 2F B5 28 的小端 UInt32），与官方 ZSTD_MAGIC 同值。
const ZSTD_MAGIC = 4247762216;

/**
 * 定位完整 zstd 帧而不解压其块：解析帧头描述符与块头；块类型 3 视为损坏；
 * RLE 块（类型 1）载荷恒为 1 字节，raw(0)/compressed(2) 载荷 = blockSize；
 * 字节不足（帧头/块头/载荷/校验和）时返回 tornStart = 该帧起点。
 */
export function scanZstdFrames(
  buffer: Buffer,
  maxFrames: number = Number.POSITIVE_INFINITY,
): ZstdScanResult {
  const frames: ZstdFrameRange[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new FrameScanError(`帧魔数无效（偏移 ${offset}）`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new FrameScanError(`帧头保留位非零（偏移 ${offset - 1}）`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new FrameScanError(`块类型保留值（偏移 ${offset - 3}）`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/** 逐帧解压失败记录。 */
export interface FrameDecompressFailure {
  readonly index: number;
  readonly message: string;
}

/** 整文件提取结果：拼接后的明文、完整帧数、撕裂尾起点、解压失败帧。 */
export interface FrameExtractionResult {
  readonly text: string;
  readonly frameCount: number;
  readonly tornStart: number | undefined;
  readonly failedFrames: FrameDecompressFailure[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 解压单个完整帧（校验和由 zstd 解码器校验）。 */
export function decompressFrame(buffer: Buffer, frame: ZstdFrameRange): Buffer {
  return zstdDecompressSync(buffer.subarray(frame.start, frame.end));
}

/**
 * 扫描整文件并逐帧解压、按帧顺序拼接 UTF-8 明文。
 * 结构性损坏由 scanZstdFrames 抛出 FrameScanError；单帧解压失败记入 failedFrames（由调用方决定致命/标注）。
 */
export function extractLogText(buffer: Buffer): FrameExtractionResult {
  const scan = scanZstdFrames(buffer);
  const parts: string[] = [];
  const failedFrames: FrameDecompressFailure[] = [];
  scan.frames.forEach((frame, index) => {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString("utf8"));
    } catch (error) {
      failedFrames.push({ index, message: errorMessage(error) });
    }
  });
  return {
    text: parts.join(""),
    frameCount: scan.frames.length,
    tornStart: scan.tornStart,
    failedFrames,
  };
}

/**
 * 拆分物理行为行数组：以 \n 切分；文件末尾换行产生的空元素剔除；其余空行保留（由解码层判为坏行）。
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
