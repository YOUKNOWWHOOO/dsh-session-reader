// 测试夹具：合成 DSH_HOME（多帧 zstd 日志、projcache、workspace.json）与假 catalog。
// 夹具运行时生成于 tests/.tmp/ 下并在测试开始前整体清理（自清理）。
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import type {
  CatalogRestore,
  HeaderClassification,
  SessionFormatCatalog,
} from "../scripts/lib/decode.ts";

/** 夹具事件：v3 合法信封。 */
export interface FixtureEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: Record<string, unknown>;
  readonly surfaceOp?: unknown;
  readonly sourceEventSeqs?: readonly number[];
}

/** 夹具会话定义。 */
export interface FixtureSessionSpec {
  readonly id: string;
  readonly projectDir: string;
  readonly cwd?: string;
  readonly createdAt: number;
  readonly events: readonly FixtureEvent[];
  readonly parentSession?: string;
  readonly origin?: "subagent";
  readonly agentPreset?: string;
  /** 日志文件名（默认 session.v4.jsonl.zstd）。 */
  readonly fileName?: string;
  /** 是否以明文写入（fileName 默认 session.v4.jsonl）。 */
  readonly plaintext?: boolean;
  /** 额外文件（多代并存等场景）。 */
  readonly extraFiles?: readonly { readonly fileName: string; readonly content: Buffer | string }[];
  /** 追加到日志末尾的额外物理行（坏行等场景）。 */
  readonly extraLines?: readonly string[];
  /** 撕裂尾：末帧截断为半长。 */
  readonly tornTail?: boolean;
  /** 结构损坏：首帧魔数替换为无效值。 */
  readonly corrupt?: boolean;
  /** 尾部帧结构损坏：header 帧完好、其后首个正文帧魔数替换为无效值（用于"header 可读但解码失败"）。 */
  readonly corruptTail?: boolean;
  /** projcache 形态：有效/缺失/版本不符/identity 不符/部分行缺失。 */
  readonly projcache?: "valid" | "missing" | "version" | "identity" | "partial";
  readonly title?: string | null;
  readonly blank?: boolean;
  readonly turns?: number;
  readonly steps?: number;
  readonly lastPromptAt?: number | null;
}

/** 夹具根定义。 */
export interface FixtureHomeSpec {
  readonly sessions: readonly FixtureSessionSpec[];
  readonly workspace?: {
    readonly path: string;
    readonly title: string;
    readonly sessionIds: readonly string[];
  } | null;
}

/** 构建事件行文本。 */
function eventLine(event: FixtureEvent): string {
  const record: Record<string, unknown> = {
    type: event.type,
    seq: event.seq,
    time: event.time,
    data: event.data,
  };
  if (event.surfaceOp !== undefined) record.surfaceOp = event.surfaceOp;
  if (event.sourceEventSeqs !== undefined) record.sourceEventSeqs = event.sourceEventSeqs;
  return JSON.stringify(record);
}

/** 构建 header 行文本。 */
function headerLine(spec: FixtureSessionSpec): string {
  const header: Record<string, unknown> = {
    type: "session",
    // 夹具一律写当前版本（v4）。写旧版本会让解码器走 v3→v4 迁移分支，而该分支要求传入
    // 「显式历史子事实」（含无子会话时的空数组），夹具没有这些事实，迁移必定失败，
    // 表现为整批用例以「数据不可读」失败。旧版本日志的读取由专门用例覆盖。
    version: 4,
    id: spec.id,
    createdAt: spec.createdAt,
    isSeeded: false,
    delegationDepth: spec.origin === "subagent" ? 1 : 0,
  };
  if (spec.cwd !== undefined) header.cwd = spec.cwd;
  if (spec.parentSession !== undefined) header.parentSession = spec.parentSession;
  if (spec.origin !== undefined) header.origin = spec.origin;
  if (spec.agentPreset !== undefined) header.agentPreset = spec.agentPreset;
  return JSON.stringify(header);
}

/** 把行数组压缩为多帧 zstd（帧 0=header；其后每 3 行一帧），可选撕裂尾与正文帧损坏。 */
function buildZstdLog(
  header: string,
  lines: readonly string[],
  tornTail: boolean,
  corruptTail: boolean,
): Buffer {
  const frames: Buffer[] = [zstdCompressSync(Buffer.from(`${header}\n`, "utf8"))];
  const batches: string[][] = [];
  for (let index = 0; index < lines.length; index += 3) {
    batches.push(lines.slice(index, index + 3));
  }
  for (const batch of batches) {
    frames.push(zstdCompressSync(Buffer.from(`${batch.join("\n")}\n`, "utf8")));
  }
  if (corruptTail) {
    const target = frames[1];
    if (target === undefined) {
      // 显式失败而非静默降级：没有正文帧时该夹具开关无意义，夹具必须让调用方立刻知道。
      throw new Error("夹具 corruptTail 需要至少一个正文帧：请为该会话提供事件");
    }
    target.writeUInt32LE(0xdeadbeef, 0);
  }
  if (tornTail) {
    const last = frames.pop();
    if (last !== undefined) frames.push(last.subarray(0, Math.max(1, Math.floor(last.length / 2))));
  }
  return Buffer.concat(frames);
}

/** projcache 文档。 */
function projcacheDocument(spec: FixtureSessionSpec): unknown {
  const lastSeq = spec.events.length === 0 ? 0 : spec.events[spec.events.length - 1].seq;
  const row = (val: unknown): unknown => ({ ver: 1, seq: lastSeq, val });
  const allRows: Record<string, unknown> = {
    title: row(spec.title ?? null),
    sessionListMetadata: row({
      blank: spec.blank ?? false,
      lastPromptAt: spec.lastPromptAt ?? null,
    }),
    sessionStats: row({
      turns: spec.turns ?? 0,
      steps: spec.steps ?? 0,
      llmMs: 0,
      toolMs: 0,
      ttftMs: 0,
      ttftSteps: 0,
      decodeMs: 0,
      decodeTokens: 0,
      lastTurn: null,
      openStep: null,
      pendingCalls: {},
    }),
    agentPreset: row(spec.agentPreset ?? "standard"),
    modelSelection: row({
      lastUsed: { provider: "fixture-provider", model: "fixture-model", reasoningEffort: "max" },
      pending: null,
    }),
    tokenUsage: row({
      totals: {
        uncachedInputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 25,
        cacheWriteTokens: 5,
      },
      last: null,
    }),
    turnOutline: row({ turns: [], draft: "" }),
  };
  let rows = allRows;
  let version = 7;
  let identity: Record<string, unknown> = {
    // projcache 的 identity 与日志 header 同源：都取当前会话格式版本（v4），两处必须一致，
    // 否则投影缓存被判为 identity 不符而被丢弃。
    formatVersion: 4,
    createdAt: spec.createdAt,
    cwd: spec.cwd,
    isSeeded: false,
    inheritedEventCount: 0,
  };
  if (spec.projcache === "version") version = 6;
  if (spec.projcache === "identity") identity = { ...identity, createdAt: spec.createdAt + 1 };
  if (spec.projcache === "partial") {
    rows = {
      title: allRows.title,
      tokenUsage: allRows.tokenUsage,
      turnOutline: allRows.turnOutline,
    };
  }
  return { version, record: { identity, rows } };
}

/** 写入一个夹具 DSH_HOME；返回根路径。 */
export function writeFixtureHome(root: string, spec: FixtureHomeSpec): string {
  mkdirSync(join(root, "sessions"), { recursive: true });
  mkdirSync(join(root, "storages", "session_projcache", "sessions"), { recursive: true });
  for (const session of spec.sessions) {
    const dirPath = join(root, "sessions", session.projectDir, session.id);
    mkdirSync(dirPath, { recursive: true });
    const header = headerLine(session);
    const lines = session.events.map((event) => eventLine(event));
    for (const extra of session.extraLines ?? []) lines.push(extra);
    if (session.corrupt) {
      const buffer = buildZstdLog(header, lines, false, false);
      buffer.writeUInt32LE(0xdeadbeef, 0);
      writeFileSync(join(dirPath, session.fileName ?? "session.v4.jsonl.zstd"), buffer);
    } else if (session.plaintext) {
      const fileName = session.fileName ?? "session.v4.jsonl";
      writeFileSync(join(dirPath, fileName), `${[header, ...lines].join("\n")}\n`, "utf8");
    } else {
      const fileName = session.fileName ?? "session.v4.jsonl.zstd";
      writeFileSync(
        join(dirPath, fileName),
        buildZstdLog(header, lines, session.tornTail ?? false, session.corruptTail ?? false),
      );
    }
    for (const extra of session.extraFiles ?? []) {
      writeFileSync(join(dirPath, extra.fileName), extra.content);
    }
    const cacheMode = session.projcache ?? "valid";
    if (cacheMode !== "missing") {
      const cachePath = join(
        root,
        "storages",
        "session_projcache",
        "sessions",
        `${session.id}.json`,
      );
      writeFileSync(cachePath, JSON.stringify(projcacheDocument(session)), "utf8");
    }
  }
  if (spec.workspace !== undefined && spec.workspace !== null) {
    const workspaceDocument = {
      unit: { name: "workspace", version: 2 },
      global: { initialized: true, workspaceIds: ["fixture-workspace"], archivedSessionIds: [] },
      tables: {
        workspaces: {
          "fixture-workspace": {
            path: spec.workspace.path,
            title: spec.workspace.title,
            sessionIds: [...spec.workspace.sessionIds],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    };
    writeFileSync(
      join(root, "storages", "workspace.json"),
      JSON.stringify(workspaceDocument),
      "utf8",
    );
  }
  return root;
}

/** 清理并重建测试临时目录（测试自清理）。 */
export function resetTempDir(root: string): string {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

// ------------------------- 假 catalog（单元测试用） -------------------------

export interface FakeCatalogOptions {
  readonly status?: HeaderClassification["status"];
  readonly headerId?: string;
  readonly createdAt?: number;
  /** finish() 返回的事件数 = 接受行数 - dropped（模拟 recoverable 静默丢弃）。 */
  readonly droppedEvents?: number;
  /** 第 N 次 decodeRow 调用抛错（1 基）。 */
  readonly throwOnRow?: number;
  readonly throwOnFinish?: boolean;
  /** createRestore 抛错。 */
  readonly throwOnCreateRestore?: boolean;
}

/** 非 null、非数组对象判型（假 catalog 用）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 假 catalog：镜像官方库最小 API，用于解码编排的单元测试；header 按输入原样镜像。 */
export function createFakeCatalog(options: FakeCatalogOptions = {}): SessionFormatCatalog {
  const status = options.status ?? "current";
  return {
    currentVersion: 3,
    readHeader(headerValue: unknown): HeaderClassification {
      if (!isRecord(headerValue)) {
        return { status: "malformed", targetVersion: 3, reason: "not an object" };
      }
      if (status === "malformed" || status === "unsupported") {
        return { status, storedVersion: 3, targetVersion: 3, reason: "fake classification" };
      }
      return {
        status,
        storedVersion: 3,
        targetVersion: 3,
        header: { ...headerValue },
      };
    },
    createRestore(headerValue: unknown): CatalogRestore {
      if (options.throwOnCreateRestore) throw new Error("fake createRestore failure");
      const header: Record<string, unknown> = isRecord(headerValue) ? { ...headerValue } : {};
      const rows: Record<string, unknown>[] = [];
      let calls = 0;
      return {
        header,
        decodeRow(rowValue: unknown): void {
          calls += 1;
          if (options.throwOnRow !== undefined && calls === options.throwOnRow) {
            throw new Error("fake decodeRow structure violation");
          }
          if (!isRecord(rowValue)) throw new Error("fake decodeRow: row is not an object");
          rows.push(rowValue);
        },
        finish() {
          if (options.throwOnFinish) throw new Error("fake finish failure");
          const dropped = options.droppedEvents ?? 0;
          return {
            header,
            inheritedEventCount: 0,
            events: rows.slice(0, Math.max(0, rows.length - dropped)),
          };
        },
      };
    },
  };
}
