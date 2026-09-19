// store 系列测试的共享辅助：分域夹具路径（tests/.tmp/store/<scope>/）、v3 事件构造器、
// 合成 DSH_HOME 规范（healthy/broken）、假 catalog 与 StoreContext、列表过滤默认值与条目查找。
// 夹具初始化由各测试文件在文件级 before 中调用 initStoreFixtures 触发：每个测试文件都是独立
// 进程，各自独占一个作用域目录，因此既不会重复建库，也不会跨文件相互清理（测试自清理）。

import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ListFilters, SessionEntry, StoreContext } from "../scripts/lib/store-types.ts";
import type { FixtureEvent, FixtureHomeSpec, FixtureSessionSpec } from "./fixtures.ts";
import { createFakeCatalog, resetTempDir, writeFixtureHome } from "./fixtures.ts";

const TEMP_BASE = fileURLToPath(new URL("./.tmp/store", import.meta.url));

/** 单个测试文件独占的夹具域：目录互不重叠，避免并行文件相互清理。 */
export interface StoreFixtures {
  readonly tempRoot: string;
  readonly healthyHome: string;
  readonly brokenHome: string;
}

/** 为指定作用域生成夹具路径（tests/.tmp/store/<scope>/）。 */
export function storeFixtures(scope: string): StoreFixtures {
  const tempRoot = join(TEMP_BASE, scope);
  return {
    tempRoot,
    healthyHome: join(tempRoot, "healthy-dsh"),
    brokenHome: join(tempRoot, "broken-dsh"),
  };
}

/** 清理并重建该作用域的合成 DSH_HOME；由测试文件在文件级 before 中调用，保证只执行一次。 */
export function initStoreFixtures(fixtures: StoreFixtures): void {
  resetTempDir(fixtures.tempRoot);
  writeFixtureHome(fixtures.healthyHome, healthySpec());
  writeFixtureHome(fixtures.brokenHome, brokenSpec());
}

export function event(
  type: string,
  seq: number,
  time: number,
  data: Record<string, unknown>,
  extra?: Partial<Pick<FixtureEvent, "surfaceOp" | "sourceEventSeqs">>,
): FixtureEvent {
  return { type, seq, time, data, ...extra };
}

export const MAIN_CWD = "C:\\Users\\ZHANG\\user_projects";
export const OTHER_CWD = "C:\\Users\\ZHANG";
export const PROJECT_MAIN = "--C-Users-ZHANG-user_projects--";
export const PROJECT_OTHER = "--C-Users-ZHANG--";

export function mainEvents(): FixtureEvent[] {
  return [
    event("turn/start", 0, 10, { turn: 1 }),
    event(
      "user/message",
      1,
      11,
      {
        role: "user",
        content: [{ type: "text", text: "Alpha Needle here" }],
      },
      { surfaceOp: "append" },
    ),
    event(
      "assistant/message",
      2,
      12,
      {
        turn: 1,
        step: 1,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Assistant needle reply" },
            { type: "reasoning", text: "Reasoning Needle thoughts" },
          ],
        },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, reasoningTokens: 1 },
      },
      { surfaceOp: "append" },
    ),
    event("tool/call", 3, 13, {
      turn: 1,
      step: 1,
      callId: "call_1",
      name: "read",
      arguments: '{"path":"needle.txt"}',
    }),
    event(
      "tool/result",
      4,
      14,
      {
        turn: 1,
        step: 1,
        message: {
          role: "user",
          source: { kind: "tool", callId: "call_1" },
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              content: [{ type: "text", text: "Result Needle content" }],
              isError: false,
            },
          ],
        },
      },
      { surfaceOp: "append", sourceEventSeqs: [3] },
    ),
    event(
      "system/message",
      5,
      15,
      {
        turn: 1,
        step: 1,
        message: {
          role: "system",
          source: { kind: "plugin", plugin: "fixture-plugin" },
          content: [{ type: "text", text: "System Needle prompt" }],
        },
      },
      { surfaceOp: "append" },
    ),
    event("compaction/summary", 6, 16, {
      summary: [{ type: "text", text: "Compaction needle summary" }],
      rawOutput: [{ type: "text", text: "Raw needle output" }],
    }),
    event("command/run", 7, 17, {
      commandId: "cmd-1",
      name: "compact",
      args: { note: "needle arg" },
      source: { kind: "user" },
    }),
    event("command/done", 8, 18, {
      commandId: "cmd-1",
      kind: "text",
      text: "Command needle done",
      sourceEventSeq: 7,
    }),
    event("session/title-llm-request", 9, 19, {
      titleProvider: "p",
      messageSeqs: [1],
      route: { provider: "p", model: "m" },
      system: "Title needle system",
      messages: [{ role: "user", content: [{ type: "text", text: "Title needle request" }] }],
      maxTokens: 100,
    }),
    event("web/deepseek-search-llm-request", 10, 20, {
      endpoint: "e",
      apiVersion: "v",
      body: { model: "m", max_tokens: 1, messages: [], tools: [] },
    }),
    event("deliverables/presented", 11, 21, {
      turn: 1,
      callId: "call_1",
      files: [{ path: "needle.txt", description: "Deliverable needle desc" }],
    }),
    event("session/title", 12, 22, {
      title: "夹具标题 A",
      messageSeqs: [1],
      source: { kind: "fallback" },
    }),
    event("turn/end", 13, 23, { turn: 1, reason: { kind: "completed" } }),
  ];
}

function subagentEvents(): FixtureEvent[] {
  return [
    event("subagent/descriptor", 0, 10, {
      version: 3,
      mode: "continuable",
      label: "夹具子代理",
      provider: "spawn",
    }),
    event(
      "user/message",
      1,
      11,
      { role: "user", content: [{ type: "text", text: "sub prompt" }] },
      { surfaceOp: "append" },
    ),
    event(
      "assistant/message",
      2,
      12,
      {
        turn: 1,
        message: { role: "assistant", content: [{ type: "text", text: "sub reply" }] },
      },
      { surfaceOp: "append" },
    ),
  ];
}

export function singleEvent(): FixtureEvent[] {
  return [event("permission/preset", 0, 5, { preset: "workspace-write" })];
}

function healthySpec(): FixtureHomeSpec {
  const sessions: FixtureSessionSpec[] = [
    {
      id: "session-fixture-main-01",
      projectDir: PROJECT_MAIN,
      cwd: MAIN_CWD,
      createdAt: 1000,
      events: mainEvents(),
      title: "夹具标题 A",
      turns: 2,
      steps: 3,
      lastPromptAt: 2000,
    },
    {
      id: "bbbb1111-2222-3333-4444-555566667777",
      projectDir: PROJECT_MAIN,
      cwd: MAIN_CWD,
      createdAt: 1500,
      events: subagentEvents(),
      parentSession: "session-fixture-main-01",
      origin: "subagent",
      title: null,
      turns: 1,
      steps: 0,
      lastPromptAt: null,
    },
    {
      id: "session-fixture-plain-03",
      projectDir: PROJECT_OTHER,
      cwd: OTHER_CWD,
      createdAt: 500,
      events: singleEvent(),
      plaintext: true,
      title: "Plain 标题 C",
      turns: 0,
      steps: 0,
      lastPromptAt: null,
    },
    {
      id: "session-fixture-multigen-04",
      projectDir: PROJECT_OTHER,
      cwd: OTHER_CWD,
      createdAt: 600,
      events: singleEvent(),
      title: "MultiGen TITLE",
      turns: 0,
      steps: 0,
      lastPromptAt: null,
      extraFiles: [
        { fileName: "session.v1.jsonl.zstd", content: Buffer.from("not-a-real-v1-log", "utf8") },
      ],
    },
    {
      id: "session-fixture-blank-05",
      projectDir: PROJECT_OTHER,
      cwd: OTHER_CWD,
      createdAt: 700,
      events: singleEvent(),
      title: null,
      blank: true,
      turns: 0,
      steps: 0,
      lastPromptAt: null,
    },
    {
      id: "session-fixture-partial-06",
      projectDir: PROJECT_OTHER,
      cwd: OTHER_CWD,
      createdAt: 800,
      events: singleEvent(),
      projcache: "partial",
      title: null,
      turns: 0,
      steps: 0,
      lastPromptAt: null,
    },
    {
      id: "session-fixture-identity-07",
      projectDir: PROJECT_OTHER,
      cwd: OTHER_CWD,
      createdAt: 900,
      events: singleEvent(),
      projcache: "identity",
      title: null,
      turns: 0,
      steps: 0,
      lastPromptAt: null,
    },
    {
      id: "session-fixture-version-08",
      projectDir: PROJECT_OTHER,
      cwd: OTHER_CWD,
      createdAt: 1100,
      events: singleEvent(),
      projcache: "version",
      title: null,
      turns: 0,
      steps: 0,
      lastPromptAt: null,
    },
    {
      id: "session-fixture-nocache-09",
      projectDir: PROJECT_OTHER,
      cwd: OTHER_CWD,
      createdAt: 1200,
      events: singleEvent(),
      projcache: "missing",
      title: null,
      turns: 0,
      steps: 0,
      lastPromptAt: null,
    },
  ];
  return {
    sessions,
    workspace: { path: MAIN_CWD, title: "user_projects", sessionIds: ["session-fixture-main-01"] },
  };
}

function brokenSpec(): FixtureHomeSpec {
  return {
    sessions: [
      {
        id: "session-broken-torn-06",
        projectDir: PROJECT_OTHER,
        cwd: OTHER_CWD,
        createdAt: 1000,
        events: [
          event("permission/preset", 0, 1, { preset: "workspace-write" }),
          event(
            "user/message",
            1,
            2,
            { role: "user", content: [{ type: "text", text: "torn" }] },
            { surfaceOp: "append" },
          ),
          event(
            "assistant/message",
            2,
            3,
            { turn: 1, message: { role: "assistant", content: [] } },
            { surfaceOp: "append" },
          ),
          event("session/title", 3, 4, {
            title: "被截断",
            messageSeqs: [1],
            source: { kind: "fallback" },
          }),
        ],
        tornTail: true,
      },
      {
        id: "session-broken-gap-07",
        projectDir: PROJECT_OTHER,
        cwd: OTHER_CWD,
        createdAt: 2000,
        events: [
          event("permission/preset", 0, 1, { preset: "workspace-write" }),
          event(
            "user/message",
            1,
            2,
            { role: "user", content: [{ type: "text", text: "gap" }] },
            { surfaceOp: "append" },
          ),
          event(
            "assistant/message",
            3,
            3,
            { turn: 1, message: { role: "assistant", content: [] } },
            { surfaceOp: "append" },
          ),
        ],
      },
      {
        id: "session-broken-corrupt-08",
        projectDir: PROJECT_OTHER,
        cwd: OTHER_CWD,
        createdAt: 3000,
        events: singleEvent(),
        corrupt: true,
      },
    ],
  };
}

export const fakeCatalog = createFakeCatalog();

export function contextOf(home: string): StoreContext {
  return { dshHome: home, catalog: fakeCatalog };
}

export function defaultFilters(overrides: Partial<ListFilters> = {}): ListFilters {
  return {
    origin: "all",
    includeBlank: false,
    limit: 0,
    sort: "time",
    ...overrides,
  };
}

export function findEntry(entries: readonly SessionEntry[], id: string): SessionEntry {
  const found = entries.find((entry) => entry.id === id);
  assert.notEqual(found, undefined, `缺少会话 ${id}`);
  if (found === undefined) throw new Error("unreachable");
  return found;
}
