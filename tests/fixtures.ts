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

/**
 * 夹具写出的会话日志格式版本（当前库的 `currentVersion`）。
 *
 * 测试不得写死这个数字：dsh 升级会同时改变文件名版本段与 header 的 `version`，写死会让
 * 每次升级都打红一整批与版本无关的用例（本技能已因此实际失败过一次）。需要文件名或
 * header 版本时一律引用本常量。
 */
export const CURRENT_LOG_VERSION = 4;

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
  /** 日志文件名（默认 `session.v<当前版本>.jsonl.zstd`，版本见 `CURRENT_LOG_VERSION`）。 */
  readonly fileName?: string;
  /** 是否以明文写入（fileName 默认 `session.v<当前版本>.jsonl`）。 */
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

/** 判定非 null、非数组对象。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 由事件位置派生稳定的消息 id。
 *
 * 结构上派生而不是随机生成：同一次夹具写入必须每次产生逐字节相同的日志，
 * 否则依赖"确定性复跑"的门禁会假失败。
 */
function messageIdFor(seq: number, suffix: string): string {
  return `fixture-msg-${seq}-${suffix}`;
}

/** 构建事件行文本（当前会话格式 v4 的形态）。 */
function eventLine(event: FixtureEvent): string {
  const record: Record<string, unknown> = {
    type: event.type,
    seq: event.seq,
    // v4 要求时间戳是安全整数；非整数会让该行被解码器丢弃，进而以「输入 N 行、解码得到 M 个事件」
    // 的一致性校验失败告终，而报错位置离根因很远。
    time: Math.trunc(Number(event.time)),
    data: event.data,
  };
  if (event.surfaceOp !== undefined) record.surfaceOp = event.surfaceOp;
  if (event.sourceEventSeqs !== undefined) record.sourceEventSeqs = event.sourceEventSeqs;

  // v4 要求带一级消息对象的事件携带字符串 id；消息 id 在真实日志里由落账侧铸成，夹具按事件位置派生。
  const data = record.data;
  if (isPlainObject(data) && isPlainObject(data.message)) {
    const compact: Record<string, unknown> = { ...data.message };
    if (typeof compact.id !== "string" || compact.id.length === 0) {
      compact.id = messageIdFor(event.seq, compact.role === "tool" ? "result" : "message");
    }
    // tool/result 的消息在 v4 里是「工具」角色的一级消息：toolCallId 与 isError 是消息字段，
    // 而 v3 把它们放在 content 内的 tool-result 块里。两者在同一事件里给出，v4 才接受。
    if (typeof compact.role !== "string" || compact.role.length === 0) compact.role = "tool";
    if (compact.toolCallId === undefined && Array.isArray(compact.content)) {
      for (const block of compact.content) {
        if (isPlainObject(block) && typeof block.toolCallId === "string") {
          compact.toolCallId = block.toolCallId;
          if (compact.isError === undefined && typeof block.isError === "boolean")
            compact.isError = block.isError;
          break;
        }
      }
    }
    data.message = compact;
  }
  return JSON.stringify(record);
}

/** 构建 header 行文本。 */
function headerLine(spec: FixtureSessionSpec): string {
  const header: Record<string, unknown> = {
    type: "session",
    // 夹具一律写当前版本。写旧版本会让解码器走迁移分支，而迁移要求传入「显式历史子事实」
    // （含无子会话时的空数组），夹具没有这些事实，迁移必定失败，表现为整批用例以
    // 「数据不可读」失败。旧版本日志的读取由专门用例覆盖。
    version: CURRENT_LOG_VERSION,
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
    // projcache 的 identity 与日志 header 同源：都取当前会话格式版本（见 CURRENT_LOG_VERSION），
    // 两处必须一致，否则投影缓存被判为 identity 不符而被丢弃。
    formatVersion: CURRENT_LOG_VERSION,
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
      writeFileSync(
        join(dirPath, session.fileName ?? `session.v${CURRENT_LOG_VERSION}.jsonl.zstd`),
        buffer,
      );
    } else if (session.plaintext) {
      const fileName = session.fileName ?? `session.v${CURRENT_LOG_VERSION}.jsonl`;
      writeFileSync(join(dirPath, fileName), `${[header, ...lines].join("\n")}\n`, "utf8");
    } else {
      const fileName = session.fileName ?? `session.v${CURRENT_LOG_VERSION}.jsonl.zstd`;
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

// ------------------------- 问答（ask_user_question）夹具 -------------------------

/**
 * 问答夹具的事件构造器。
 *
 * 集中在这里的理由与 `eventLine` 一致：问答事件的载荷是"工具自己写进日志的 JSON 字符串"，
 * 形状一旦散落到各测试文件，格式升级与结构变更就要在多处对齐。全部问答夹具都经这几个构造器
 * 产出，再由 `eventLine` 统一转译为当前格式的日志行，因此单元测试、CLI 集成测试与全组合门禁
 * 共用同一份事件定义。
 */
export const ASK_PAIRED_CALL_ID = "call-fixture-ask-paired";
export const ASK_PAIRED_SECOND_CALL_ID = "call-fixture-ask-paired-2";
export const ASK_UNPAIRED_CALL_ID = "call-fixture-ask-unpaired";
export const ASK_MALFORMED_CALL_ID = "call-fixture-ask-malformed";
export const ASK_ERROR_CALL_ID = "call-fixture-ask-error";

type FixtureEventExtra = Partial<Pick<FixtureEvent, "surfaceOp" | "sourceEventSeqs">>;

/**
 * 问答夹具事件的类型：`FixtureEvent` 与"带索引签名的事件记录"的交叉。
 *
 * 交叉而不是直接用 `FixtureEvent` 的理由：TypeScript 只给对象字面量类型隐式索引签名，`interface`
 * 没有，因此 `FixtureEvent` 无法直接传给按事件记录（`Record<string, unknown>`）消费的入口
 * （抽取、渲染层）。交叉后既保留"必须是合法夹具事件"的编译期约束，又能直接交给这些入口，
 * 不必在每个测试里逐字段转写——转写本身就是一处会漂移的复制。
 */
export type AskFixtureEvent = FixtureEvent & Record<string, unknown>;

/**
 * 提问事件（`tool/call`）：`arguments` 是 `{questions: [...]}` 的 JSON 文本。
 *
 * @param questions 逐题对象数组，字段按登记结构给出（`id`/`header`/`question`/`options`）。
 */
export function askQuestionEvent(
  seq: number,
  time: number,
  callId: string,
  questions: unknown,
  extra?: FixtureEventExtra,
): AskFixtureEvent {
  return askQuestionRawEvent(seq, time, callId, JSON.stringify({ questions }), extra);
}

/**
 * 提问事件（原始 `arguments` 文本形态）。
 *
 * 存在的理由是"结构不符"这一类样本必须能写出**无法解析为登记结构**的载荷：
 * 合法的载荷由 `askQuestionEvent` 的 `JSON.stringify` 产出，永远不可能失真，
 * 而门禁用例恰好需要一份失真的载荷来证明整体失败路径真的被走到。
 */
export function askQuestionRawEvent(
  seq: number,
  time: number,
  callId: string,
  argumentsText: string,
  extra?: FixtureEventExtra,
): AskFixtureEvent {
  return {
    type: "tool/call",
    seq,
    time,
    data: { turn: 1, step: 1, callId, name: "ask_user_question", arguments: argumentsText },
    ...extra,
  };
}

/** 回答事件（`tool/result`）：`message.content` 的文本是 `{answers: [...]}` 的 JSON 文本。 */
export function askAnswerEvent(
  seq: number,
  time: number,
  callId: string,
  answers: unknown,
  extra?: FixtureEventExtra,
): AskFixtureEvent {
  return {
    type: "tool/result",
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: "tool",
        // 工具结果的来源是"工具"这个生产者，其 callId 必须与 toolCallId 一致：v4 解码器会校验
        // 二者匹配。缺 source 时整行被拒绝（报错为「requires toolCallId matching its tool source」），
        // 而 `show` 只会把它呈现为 `数据不可读`，错误位置离夹具很远。
        source: { kind: "tool", callId },
        toolCallId: callId,
        isError: false,
        content: [{ type: "text", text: JSON.stringify({ answers }) }],
      },
    },
    surfaceOp: "append",
    ...extra,
  };
}

/**
 * 错误态结果事件（`tool/result`）：提问被中止或取消时日志里的真实形态。
 *
 * 判据由 `scripts\lib\ask-user.ts` 的 `isErrorResult` 定义（`message.isError` 为 true 或
 * `data.error` 存在）；这里的两个字段都给出，因为真实日志两个都写。
 *
 * @param code 工具错误码，实测取值为 `ASK_ABORTED`（用户中止）与 `ASK_CANCELLED`（用户取消）。
 */
export function askErrorResultEvent(
  seq: number,
  time: number,
  callId: string,
  code: string,
  text: string,
  extra?: FixtureEventExtra,
): AskFixtureEvent {
  return {
    type: "tool/result",
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: "tool",
        // 同 askAnswerEvent：工具结果的 source.callId 必须与 toolCallId 一致，否则整行被解码器拒绝。
        source: { kind: "tool", callId },
        toolCallId: callId,
        isError: true,
        content: [{ type: "text", text }],
      },
      error: { name: "UserQuestionError", code },
    },
    surfaceOp: "append",
    ...extra,
  };
}

/** 样本公共骨架：轮次开始、用户消息、样本主体、会话标题、轮次结束（seq 由主体长度续接）。 */
function askSampleEvents(body: readonly AskFixtureEvent[], title: string): AskFixtureEvent[] {
  const lastSeq = body.length === 0 ? 1 : body[body.length - 1].seq;
  const head: AskFixtureEvent[] = [
    { type: "turn/start", seq: 0, time: 10, data: { turn: 1 } },
    {
      type: "user/message",
      seq: 1,
      time: 11,
      data: { role: "user", content: [{ type: "text", text: `问答夹具提问前置 ${title}` }] },
      surfaceOp: "append",
    },
  ];
  const tail: AskFixtureEvent[] = [
    {
      type: "session/title",
      seq: lastSeq + 1,
      time: 11 + lastSeq + 1,
      data: { title, messageSeqs: [1] },
    },
    { type: "turn/end", seq: lastSeq + 2, time: 11 + lastSeq + 2, data: { turn: 1 } },
  ];
  return [...head, ...body, ...tail];
}

/**
 * 样本 1：成对问答。两次提问各有结果，覆盖"选择"、"自定义（含换行）"与"未作答"三种回答形态，
 * 并覆盖单题与多题、2/3 个选项、含制表符与反引号的题干（载体规则因此也被这些条目覆盖）。
 */
export function askSamplePaired(): AskFixtureEvent[] {
  return askSampleEvents(
    [
      askQuestionEvent(2, 12, ASK_PAIRED_CALL_ID, [
        {
          id: "ask_one",
          header: "确认事项 `x`",
          question: "题干含 **bold text** 与制表符\ta",
          options: [
            { label: "选项 A", description: "说明 A；见 https://example.com/path" },
            { label: "选项 B", description: "说明 B" },
          ],
        },
      ]),
      askAnswerEvent(3, 13, ASK_PAIRED_CALL_ID, [{ id: "ask_one", selected: ["选项 A"] }], {
        sourceEventSeqs: [2],
      }),
      askQuestionEvent(4, 14, ASK_PAIRED_SECOND_CALL_ID, [
        {
          id: "ask_two",
          header: "第二题",
          question: "第二题正文",
          options: [
            { label: "选项 C", description: "说明 C" },
            { label: "选项 D", description: "说明 D" },
            { label: "选项 E", description: "说明 E" },
          ],
        },
        { id: "ask_three", header: "第三题", question: "第三题正文", options: [] },
      ]),
      askAnswerEvent(
        5,
        15,
        ASK_PAIRED_SECOND_CALL_ID,
        [{ id: "ask_two", selected: [], custom: "自定义回答第一行\n第二行" }, { id: "ask_three" }],
        { sourceEventSeqs: [4] },
      ),
    ],
    "问答夹具：成对",
  );
}

/** 样本 2：未配对提问（只有提问事件，没有结果事件），提问必须照常呈现。 */
export function askSampleUnpaired(): AskFixtureEvent[] {
  return askSampleEvents(
    [
      askQuestionEvent(2, 12, ASK_UNPAIRED_CALL_ID, [
        { id: "ask_open", header: "未配对", question: "未配对的提问仍需呈现" },
      ]),
    ],
    "问答夹具：未配对",
  );
}

/** 样本 3：结构不符的载荷（提问参数不是合法 JSON），必须整体失败而不做任何降级。 */
export function askSampleMalformed(): AskFixtureEvent[] {
  return askSampleEvents(
    [askQuestionRawEvent(2, 12, ASK_MALFORMED_CALL_ID, '{"questions": [')],
    "问答夹具：结构不符",
  );
}

/** 样本 4：配对结果为错误态（提问被中止），提问照常呈现且不产出回答条目、不触发失败。 */
export function askSampleErrorResult(): AskFixtureEvent[] {
  return askSampleEvents(
    [
      askQuestionEvent(2, 12, ASK_ERROR_CALL_ID, [
        { id: "ask_aborted", header: "被中止的提问", question: "提问在被回答前被中止" },
      ]),
      askErrorResultEvent(
        3,
        13,
        ASK_ERROR_CALL_ID,
        "ASK_ABORTED",
        "Error: ask_user_question was aborted before the user answered",
        { sourceEventSeqs: [2] },
      ),
    ],
    "问答夹具：错误态",
  );
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
