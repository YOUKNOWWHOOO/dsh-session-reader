// frames.ts 单元测试：单帧/多帧/撕裂尾/损坏结构/空文件/raw、RLE、compressed 三型块逐字节断言。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zstdCompressSync } from "node:zlib";
import {
  decompressFrame,
  extractLogText,
  FrameScanError,
  scanZstdFrames,
  splitLines,
} from "../scripts/lib/frames.ts";

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

/** 手工构造帧：magic + descriptor + 其余字节。 */
function handcraftedFrame(descriptor: number, rest: readonly number[]): Buffer {
  return Buffer.from([...MAGIC, descriptor, ...rest]);
}

/** RLE 块帧（singleSegment、contentSize=5、RLE 载荷 1 字节 'A'）。 */
function rleFrame(): Buffer {
  // descriptor 0x20 = singleSegment；块头 0x2B 0x00 0x00 = last(1)|type(1)<<1|size(5)<<3
  return handcraftedFrame(0x20, [0x05, 0x2b, 0x00, 0x00, 0x41]);
}

/** raw 块帧（singleSegment、contentSize=5、raw 载荷 'hello'）。 */
function rawFrame(): Buffer {
  // 块头 0x29 0x00 0x00 = last(1)|type(0)<<1|size(5)<<3
  return handcraftedFrame(0x20, [0x05, 0x29, 0x00, 0x00, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
}

/** 结构上合法但 compressed 载荷为垃圾的帧（用于触发解压失败）。 */
function corruptCompressedFrame(): Buffer {
  // 块头 = last(1)|type(2)<<1|size(8)<<3 = 69 = 0x45；载荷 8 字节垃圾
  return handcraftedFrame(
    0x20,
    [0x00, 0x45, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
  );
}

describe("scanZstdFrames", () => {
  it("单压缩帧：识别完整帧范围", () => {
    const frame = zstdCompressSync(Buffer.from("hello"));
    const result = scanZstdFrames(frame);
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames[0].start, 0);
    assert.equal(result.frames[0].end, frame.length);
    assert.equal(result.tornStart, undefined);
  });

  it("多帧拼接：逐帧识别", () => {
    const first = zstdCompressSync(Buffer.from("one"));
    const second = zstdCompressSync(Buffer.from("two"));
    const buffer = Buffer.concat([first, second]);
    const result = scanZstdFrames(buffer);
    assert.deepEqual(result.frames, [
      { start: 0, end: first.length },
      { start: first.length, end: first.length + second.length },
    ]);
  });

  it("末帧撕裂：识别 tornStart 且不误吞", () => {
    const complete = zstdCompressSync(Buffer.from("complete-frame"));
    const torn = zstdCompressSync(Buffer.from("torn-frame")).subarray(0, 6);
    const buffer = Buffer.concat([complete, torn]);
    const result = scanZstdFrames(buffer);
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames[0].end, complete.length);
    assert.equal(result.tornStart, complete.length);
  });

  it("maxFrames 限制只返回前 N 帧", () => {
    const frames = [1, 2, 3].map((value) => zstdCompressSync(Buffer.from(`frame-${value}`)));
    const buffer = Buffer.concat(frames);
    const result = scanZstdFrames(buffer, 2);
    assert.equal(result.frames.length, 2);
  });

  it("空缓冲：无帧且无 tornStart", () => {
    const result = scanZstdFrames(Buffer.alloc(0));
    assert.deepEqual(result.frames, []);
    assert.equal(result.tornStart, undefined);
  });

  it("不足 4 字节：tornStart=0", () => {
    const result = scanZstdFrames(Buffer.from([0x28, 0xb5]));
    assert.deepEqual(result.frames, []);
    assert.equal(result.tornStart, 0);
  });

  it("魔数无效：抛 FrameScanError", () => {
    assert.throws(() => scanZstdFrames(Buffer.from([0x00, 0x00, 0x00, 0x00])), FrameScanError);
  });

  it("帧头保留位非零：抛 FrameScanError", () => {
    assert.throws(() => scanZstdFrames(handcraftedFrame(0x08, [0x00, 0x00, 0x00])), FrameScanError);
  });

  it("块类型保留值 3：抛 FrameScanError", () => {
    // 块头 = last(1)|type(3)<<1|size(1)<<3 = 15 = 0x0f
    assert.throws(
      () => scanZstdFrames(handcraftedFrame(0x20, [0x01, 0x0f, 0x00, 0x00])),
      FrameScanError,
    );
  });

  it("RLE 块：载荷 1 字节、解压为重复值", () => {
    const frame = rleFrame();
    const result = scanZstdFrames(frame);
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames[0].end, frame.length);
    assert.equal(decompressFrame(frame, result.frames[0]).toString("utf8"), "AAAAA");
  });

  it("raw 块：载荷 = blockSize、解压为原文", () => {
    const frame = rawFrame();
    const result = scanZstdFrames(frame);
    assert.equal(result.frames.length, 1);
    assert.equal(decompressFrame(frame, result.frames[0]).toString("utf8"), "hello");
  });

  it("压缩载荷内包含魔数字节：结构扫描不误判", () => {
    const payload = Buffer.concat([
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x28, 0xb5, 0x2f, 0xfd]),
      Buffer.from("tail"),
    ]);
    const frame = zstdCompressSync(payload);
    const result = scanZstdFrames(frame);
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames[0].end, frame.length);
    assert.deepEqual(decompressFrame(frame, result.frames[0]), payload);
  });
});

describe("extractLogText", () => {
  it("空缓冲：无帧、空文本", () => {
    const result = extractLogText(Buffer.alloc(0));
    assert.equal(result.text, "");
    assert.equal(result.frameCount, 0);
    assert.equal(result.tornStart, undefined);
    assert.deepEqual(result.failedFrames, []);
  });

  it("仅魔数（4 字节）：tornStart=0", () => {
    const result = scanZstdFrames(Buffer.from(MAGIC));
    assert.deepEqual(result.frames, []);
    assert.equal(result.tornStart, 0);
  });

  it("帧头剩余字节不足：tornStart=0", () => {
    const result = scanZstdFrames(handcraftedFrame(0x00, [0x00]));
    assert.deepEqual(result.frames, []);
    assert.equal(result.tornStart, 0);
  });

  it("块头不足 3 字节：tornStart=0", () => {
    const result = scanZstdFrames(handcraftedFrame(0x00, [0x00]));
    assert.equal(result.tornStart, 0);
  });

  it("带校验和的帧：正确计入校验和字节", () => {
    // descriptor 0x24 = singleSegment|checksum；raw 块 1 字节 'x'；附 4 字节校验和
    const frame = handcraftedFrame(0x24, [0x01, 0x09, 0x00, 0x00, 0x78, 0x00, 0x00, 0x00, 0x00]);
    const result = scanZstdFrames(frame);
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames[0].end, frame.length);
    const truncated = scanZstdFrames(frame.subarray(0, frame.length - 2));
    assert.equal(truncated.frames.length, 0);
    assert.equal(truncated.tornStart, 0);
  });

  it("解压损坏帧抛错（decompressFrame）", () => {
    const corrupt = corruptCompressedFrame();
    const scan = scanZstdFrames(corrupt);
    assert.equal(scan.frames.length, 1);
    assert.throws(() => decompressFrame(corrupt, scan.frames[0]));
  });

  it("多帧拼接文本；撕裂尾丢弃并报告 tornStart", () => {
    const frameA = zstdCompressSync(Buffer.from("line-a\n"));
    const frameB = zstdCompressSync(Buffer.from("line-b\n"));
    const torn = zstdCompressSync(Buffer.from("never-seen\n")).subarray(0, 5);
    const result = extractLogText(Buffer.concat([frameA, frameB, torn]));
    assert.equal(result.text, "line-a\nline-b\n");
    assert.equal(result.frameCount, 2);
    assert.equal(result.tornStart, frameA.length + frameB.length);
    assert.deepEqual(result.failedFrames, []);
  });

  it("单帧解压失败记入 failedFrames，其它帧文本保留", () => {
    const good = zstdCompressSync(Buffer.from("good\n"));
    const corrupt = corruptCompressedFrame();
    const result = extractLogText(Buffer.concat([good, corrupt]));
    assert.equal(result.text, "good\n");
    assert.equal(result.frameCount, 2);
    assert.equal(result.failedFrames.length, 1);
    assert.equal(result.failedFrames[0].index, 1);
  });
});

describe("splitLines", () => {
  it("末尾换行不产生空行；中间空行保留", () => {
    assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
    assert.deepEqual(splitLines("a\n\nb"), ["a", "", "b"]);
    assert.deepEqual(splitLines("a"), ["a"]);
    assert.deepEqual(splitLines(""), []);
  });
});
