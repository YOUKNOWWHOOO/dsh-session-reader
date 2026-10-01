// render 拆分测试的共享夹具：字段/元数据/列表项/覆盖声明/扫描摘要、会话条目与节点构造、show 选项、解码文件与结构纪律断言。
// 命名为 render-helpers.ts（非 *.test.ts），避免被 node --test 收集而污染测试数。
import assert from "node:assert/strict";
import type { RenderedOutput, ShowMdOptions } from "../scripts/lib/render-core.ts";
import { renderShowMd } from "../scripts/lib/render-show-md.ts";
import type {
  DecodedSessionFile,
  FieldValue,
  ListEntry,
  MetadataView,
  ScanSummary,
  SessionCoverage,
  SessionEntry,
  SessionNode,
} from "../scripts/lib/store-types.ts";

/**
 * 渲染 show 的 md 并解包成功结果；失败即让用例失败。
 *
 * `renderShowMd` 返回 Result 是因为问答载荷结构不符必须让整条命令失败（退出 3、不产出文件）。
 * 绝大多数用例断言的是成功路径的正文，用本函数解包可避免每个调用点都写一遍 `if (!rendered.success)`，
 * 也避免把失败当成"空产物"继续断言下去（那会产出难以定位的假失败）；需要断言失败路径的用例
 * 直接调用 `renderShowMd`。
 */
export function showMd(node: SessionNode, options: ShowMdOptions): RenderedOutput {
  const rendered = renderShowMd(node, options);
  assert.equal(rendered.success, true, rendered.success ? "" : `渲染失败: ${rendered.error}`);
  if (!rendered.success) throw new Error("unreachable");
  return rendered.data;
}

export function field<T>(value: T | null, unavailable = false): FieldValue<T> {
  return { value, unavailable };
}

export function metadata(overrides: Partial<MetadataView> = {}): MetadataView {
  return {
    available: true,
    reasons: [],
    title: field("测试标题"),
    blank: field(false),
    lastPromptAt: field(1000),
    turns: field(3),
    steps: field(5),
    agentPreset: field("standard"),
    model: field({ provider: "provider-x", model: "model-y", reasoningEffort: "max" }),
    tokens: field({
      uncachedInputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
    }),
    ...overrides,
  };
}

export function listEntry(
  id: string,
  overrides: Partial<ListEntry> = {},
  meta: MetadataView = metadata(),
): ListEntry {
  return {
    id,
    type: "main",
    cwd: "C:\\Users\\Alice\\user_projects",
    workspaceTitle: "user_projects",
    createdAt: 1000,
    lastActivityAt: 2000,
    sizeBytes: 2048,
    metadata: meta,
    ...overrides,
  };
}

/** 覆盖声明：默认"扫描=纳入、无排除"；测试按需注入排除项。 */
export function coverage(overrides: Partial<SessionCoverage> = {}): SessionCoverage {
  const includedCount = overrides.includedCount ?? 0;
  const excluded = overrides.excluded ?? [];
  return {
    scannedCount: overrides.scannedCount ?? includedCount + excluded.length,
    includedCount,
    excluded,
  };
}

/** 扫描摘要：默认"一份日志、零事件、零失败、无时间范围"；测试按需覆盖。 */
export function scanSummary(overrides: Partial<ScanSummary> = {}): ScanSummary {
  return {
    logsDecoded: 0,
    eventsRead: 0,
    decodeFailures: 0,
    frameFailures: 0,
    observedFrom: null,
    observedTo: null,
    ...overrides,
  };
}

export const HEADER = {
  version: 3,
  id: "session-render-01",
  createdAt: 1000,
  cwd: "C:\\Users\\Alice\\user_projects",
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: "standard",
};

export const RENDER_EVENTS: Record<string, unknown>[] = [
  { type: "turn/start", seq: 0, time: 10, data: { turn: 1 } },
  {
    type: "user/message",
    seq: 1,
    time: 11,
    data: {
      role: "user",
      content: [{ type: "text", text: "用户内容 USER-TEXT" }],
      // 真实日志的 user/message 恒带 source（307 会话实测零缺失），夹具按 schema 忠实给出：
      // 缺 source 的形态由 tests\source-annotation.test.ts 专门覆盖（渲染为 `来源 未标注`）。
      source: { kind: "user" },
    },
    surfaceOp: "append",
  },
  {
    type: "assistant/message",
    seq: 2,
    time: 12,
    data: {
      turn: 1,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "助手内容 ASSIST-TEXT" },
          { type: "reasoning", text: "推理内容 THINK-TEXT" },
        ],
      },
    },
    surfaceOp: "append",
  },
  {
    type: "tool/call",
    seq: 3,
    time: 13,
    data: { callId: "c1", name: "read", arguments: '{"path":"x"}' },
  },
  {
    type: "tool/result",
    seq: 4,
    time: 14,
    data: {
      message: {
        role: "user",
        content: [{ type: "tool-result", content: [{ type: "text", text: "结果 RESULT-TEXT" }] }],
      },
    },
    surfaceOp: "append",
  },
  {
    type: "system/message",
    seq: 5,
    time: 15,
    data: { message: { role: "system", content: [{ type: "text", text: "系统 SYSTEM-TEXT" }] } },
    surfaceOp: "append",
  },
  { type: "session/title", seq: 6, time: 16, data: { title: "渲染标题" } },
  { type: "session/title-llm-request", seq: 7, time: 17, data: { system: "标题请求" } },
  { type: "turn/end", seq: 8, time: 18, data: { turn: 1 } },
];

export function decodedFile(events: Record<string, unknown>[] = RENDER_EVENTS): DecodedSessionFile {
  return {
    decoded: {
      header: HEADER,
      events,
      inheritedEventCount: 0,
      anomalies: [],
      lineCount: events.length + 1,
      eventLineCount: events.length,
      parsedEventCount: events.length,
    },
    frames: 3,
    tornStart: undefined,
    sizeBytes: 2048,
    metrics: metricsOf(events),
  };
}

/** 由事件列表计算读取度量（与 store 层 `readSessionFile` 的口径一致）。 */
function metricsOf(events: readonly Record<string, unknown>[]): DecodedSessionFile["metrics"] {
  const times = events
    .map((event) => (typeof event.time === "number" ? event.time : undefined))
    .filter((time): time is number => time !== undefined);
  return {
    success: true,
    eventCount: events.length,
    frameFailures: 0,
    observedFrom: times.length === 0 ? null : Math.min(...times),
    observedTo: times.length === 0 ? null : Math.max(...times),
  };
}

export function sessionEntry(): SessionEntry {
  return {
    id: "session-render-01",
    projectDirName: "p",
    dirPath: "d",
    logPath: "C:\\logs\\session-render-01\\session.v3.jsonl.zstd",
    logVersion: 3,
    logCompressed: true,
    sizeBytes: 2048,
    header: HEADER,
  };
}

export function node(
  children: SessionNode[] = [],
  events?: Record<string, unknown>[],
): SessionNode {
  return {
    entry: sessionEntry(),
    file: events === undefined ? decodedFile() : decodedFile(events),
    children,
  };
}

export function showOptions(overrides: Partial<ShowMdOptions> = {}): ShowMdOptions {
  return {
    summary: false,
    role: null,
    thinking: false,
    tools: false,
    events: false,
    headers: false,
    truncate: 0,
    subagents: false,
    unattributable: [],
    probe: false,
    turnRange: null,
    seqRange: null,
    head: 0,
    tail: 0,
    ...overrides,
  };
}

/** 结构纪律断言：末尾恰一个换行、无连续空行。 */
export function assertDocumentShape(content: string): void {
  assert.equal(content.endsWith("\n"), true);
  assert.equal(content.endsWith("\n\n"), false);
  assert.equal(content.includes("\n\n\n"), false);
}
