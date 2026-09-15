// store.ts 单元测试：发现（canonical/多代/明文）、三源元数据与缺失标注、列表过滤/排序、标识解析、
// 读取/搜索/统计/校验（使用假 catalog 与合成 DSH_HOME）。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import type { SessionFormatCatalog } from "../scripts/lib/decode.ts";
import {
  buildList,
  buildMetadata,
  buildSessionNode,
  discoverReadableSessions,
  enumerateSessionFiles,
  type ListFilters,
  loadProjCache,
  loadWorkspaceIndex,
  readSessionFile,
  resolveSessionTarget,
  runCheck,
  runSearch,
  runStats,
  type SessionEntry,
  type StoreContext,
} from "../scripts/lib/store.ts";
import type { FixtureEvent, FixtureHomeSpec, FixtureSessionSpec } from "./fixtures.ts";
import { createFakeCatalog, resetTempDir, writeFixtureHome } from "./fixtures.ts";

const TEMP_ROOT = fileURLToPath(new URL("./.tmp/store", import.meta.url));
const HEALTHY_HOME = join(TEMP_ROOT, "healthy-dsh");
const BROKEN_HOME = join(TEMP_ROOT, "broken-dsh");

function event(
  type: string,
  seq: number,
  time: number,
  data: Record<string, unknown>,
  extra?: Partial<Pick<FixtureEvent, "surfaceOp" | "sourceEventSeqs">>,
): FixtureEvent {
  return { type, seq, time, data, ...extra };
}

const MAIN_CWD = "C:\\Users\\Alice\\user_projects";
const OTHER_CWD = "C:\\Users\\Alice";
const PROJECT_MAIN = "--C-Users-Alice-user_projects--";
const PROJECT_OTHER = "--C-Users-Alice--";

function mainEvents(): FixtureEvent[] {
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

function singleEvent(): FixtureEvent[] {
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

const fakeCatalog = createFakeCatalog();

function contextOf(home: string): StoreContext {
  return { dshHome: home, catalog: fakeCatalog };
}

function defaultFilters(overrides: Partial<ListFilters> = {}): ListFilters {
  return {
    origin: "all",
    includeBlank: false,
    limit: 0,
    sort: "time",
    ...overrides,
  };
}

function findEntry(entries: readonly SessionEntry[], id: string): SessionEntry {
  const found = entries.find((entry) => entry.id === id);
  assert.notEqual(found, undefined, `缺少会话 ${id}`);
  if (found === undefined) throw new Error("unreachable");
  return found;
}

before(() => {
  resetTempDir(TEMP_ROOT);
  writeFixtureHome(HEALTHY_HOME, healthySpec());
  writeFixtureHome(BROKEN_HOME, brokenSpec());
});

describe("enumerateSessionFiles / discoverReadableSessions", () => {
  it("枚举全部 canonical generation 文件（多代取最高版本、明文标记）", () => {
    const refs = enumerateSessionFiles(HEALTHY_HOME);
    assert.equal(refs.success, true);
    if (!refs.success) return;
    assert.equal(refs.data.length, 9);
    const multigen = refs.data.find((ref) => ref.idFromDir === "session-fixture-multigen-04");
    assert.equal(multigen?.logVersion, 3);
    assert.equal(multigen?.logCompressed, true);
    const plain = refs.data.find((ref) => ref.idFromDir === "session-fixture-plain-03");
    assert.equal(plain?.logCompressed, false);
  });

  it("发现会话并读取 header（id/cwd/大小），不跳过任何会话", () => {
    const result = discoverReadableSessions(HEALTHY_HOME, fakeCatalog);
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.entries.length, 9);
    assert.deepEqual(result.data.skipped, []);
    const main = findEntry(result.data.entries, "session-fixture-main-01");
    assert.equal(main.header.cwd, MAIN_CWD);
    assert.equal(main.sizeBytes > 0, true);
  });

  it("sessions 根缺失报目标不存在", () => {
    const result = discoverReadableSessions(join(TEMP_ROOT, "no-such-home"), fakeCatalog);
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.category, "target-missing");
  });

  it("header 不可读的会话记入 skipped 而非整体失败（容错语义）", () => {
    const result = discoverReadableSessions(BROKEN_HOME, fakeCatalog);
    assert.equal(result.success, true);
    if (!result.success) return;
    // 夹具中只有 corrupt 会话的 header 帧被破坏；tornTail 只截断末帧、gap 只缺 seq，二者 header 仍可读。
    assert.equal(result.data.entries.length, 2);
    assert.equal(result.data.skipped.length, 1);
    assert.equal(result.data.skipped[0].idFromDir, "session-broken-corrupt-08");
  });
});

describe("loadProjCache / buildMetadata", () => {
  it("有效 projcache：identity 校验通过、行值可读", () => {
    const entries = discoverReadableSessions(HEALTHY_HOME, fakeCatalog);
    assert.equal(entries.success, true);
    if (!entries.success) return;
    assert.deepEqual(entries.data.skipped, []);
    const main = findEntry(entries.data.entries, "session-fixture-main-01");
    const cache = loadProjCache(HEALTHY_HOME, main.id, main.header);
    assert.equal(cache.available, true);
    const metadata = buildMetadata(cache);
    assert.equal(metadata.title.value, "夹具标题 A");
    assert.equal(metadata.title.unavailable, false);
    assert.equal(metadata.turns.value, 2);
    assert.equal(metadata.tokens.value?.uncachedInputTokens, 100);
    assert.equal(metadata.model.value?.provider, "fixture-provider");
    assert.deepEqual(metadata.reasons, []);
  });

  it("projcache 缺失/版本不符/identity 不符 → 元数据不可用并给出原因", () => {
    const entries = discoverReadableSessions(HEALTHY_HOME, fakeCatalog);
    assert.equal(entries.success, true);
    if (!entries.success) return;
    assert.deepEqual(entries.data.skipped, []);
    const cases: Array<[string, RegExp]> = [
      ["session-fixture-nocache-09", /缺失/u],
      ["session-fixture-version-08", /版本不匹配/u],
      ["session-fixture-identity-07", /identity 不匹配/u],
    ];
    for (const [id, pattern] of cases) {
      const entry = findEntry(entries.data.entries, id);
      const cache = loadProjCache(HEALTHY_HOME, entry.id, entry.header);
      const metadata = buildMetadata(cache);
      assert.equal(metadata.available, false);
      assert.equal(metadata.title.unavailable, true);
      assert.equal(
        metadata.reasons.some((reason) => pattern.test(reason)),
        true,
        `原因不匹配: ${id}`,
      );
    }
  });

  it("projcache 部分行缺失：缺失行标注不可用、其它行可用", () => {
    const entries = discoverReadableSessions(HEALTHY_HOME, fakeCatalog);
    assert.equal(entries.success, true);
    if (!entries.success) return;
    assert.deepEqual(entries.data.skipped, []);
    const entry = findEntry(entries.data.entries, "session-fixture-partial-06");
    const cache = loadProjCache(HEALTHY_HOME, entry.id, entry.header);
    const metadata = buildMetadata(cache);
    assert.equal(metadata.available, true);
    assert.equal(metadata.turns.unavailable, true);
    assert.equal(metadata.tokens.unavailable, false);
    assert.equal(
      metadata.reasons.some((reason) => /sessionStats/u.test(reason)),
      true,
    );
  });
});

describe("loadWorkspaceIndex", () => {
  it("读取工作区标题与路径", () => {
    const workspaces = loadWorkspaceIndex(HEALTHY_HOME);
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].title, "user_projects");
    assert.equal(workspaces[0].path, MAIN_CWD);
  });

  it("缺失时返回空表", () => {
    assert.deepEqual(loadWorkspaceIndex(join(TEMP_ROOT, "no-such-home")), []);
  });
});

describe("buildList", () => {
  it("默认隐藏空会话并统计匹配/扫描数", () => {
    const outcome = buildList(contextOf(HEALTHY_HOME), defaultFilters());
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.scannedCount, 9);
    assert.equal(outcome.data.hiddenBlankCount, 1);
    assert.equal(outcome.data.matchedCount, 8);
    assert.equal(
      outcome.data.entries.some((entry) => entry.id === "session-fixture-blank-05"),
      false,
    );
  });

  it("--include-blank 显示空会话", () => {
    const outcome = buildList(contextOf(HEALTHY_HOME), defaultFilters({ includeBlank: true }));
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.entries.length, 9);
    assert.equal(outcome.data.hiddenBlankCount, 0);
  });

  it("origin 过滤 main/subagent", () => {
    const subagents = buildList(contextOf(HEALTHY_HOME), defaultFilters({ origin: "subagent" }));
    assert.equal(subagents.success, true);
    if (!subagents.success) return;
    assert.equal(subagents.data.entries.length, 1);
    assert.equal(subagents.data.entries[0].type, "subagent");
    const mains = buildList(contextOf(HEALTHY_HOME), defaultFilters({ origin: "main" }));
    assert.equal(mains.success, true);
    if (!mains.success) return;
    assert.equal(
      mains.data.entries.every((entry) => entry.type === "main"),
      true,
    );
  });

  it("工作区过滤：标题精确匹配与路径归一化匹配", () => {
    const byTitle = buildList(
      contextOf(HEALTHY_HOME),
      defaultFilters({ workspace: "user_projects" }),
    );
    assert.equal(byTitle.success, true);
    if (!byTitle.success) return;
    assert.deepEqual(byTitle.data.entries.map((entry) => entry.id).sort(), [
      "bbbb1111-2222-3333-4444-555566667777",
      "session-fixture-main-01",
    ]);
    const byPath = buildList(
      contextOf(HEALTHY_HOME),
      defaultFilters({ workspace: "c:\\users\\alice" }),
    );
    assert.equal(byPath.success, true);
    if (!byPath.success) return;
    assert.equal(byPath.data.matchedCount, 6);
    assert.equal(
      byPath.data.entries.every((entry) => entry.cwd === OTHER_CWD),
      true,
    );
  });

  it("工作区过滤值无匹配 → 目标不存在", () => {
    const outcome = buildList(
      contextOf(HEALTHY_HOME),
      defaultFilters({ workspace: "no-such-workspace" }),
    );
    assert.equal(outcome.success, false);
    if (!outcome.success) assert.equal(outcome.error.category, "target-missing");
  });

  it("时间过滤按最近活动（lastPromptAt，缺失取 createdAt）", () => {
    const since = buildList(contextOf(HEALTHY_HOME), defaultFilters({ since: 1000 }));
    assert.equal(since.success, true);
    if (!since.success) return;
    assert.deepEqual(
      since.data.entries.map((entry) => entry.id).sort(),
      [
        "session-fixture-main-01",
        "session-fixture-nocache-09",
        "session-fixture-version-08",
        "bbbb1111-2222-3333-4444-555566667777",
      ].sort(),
    );
    const until = buildList(contextOf(HEALTHY_HOME), defaultFilters({ until: 800 }));
    assert.equal(until.success, true);
    if (!until.success) return;
    assert.deepEqual(until.data.entries.map((entry) => entry.id).sort(), [
      "session-fixture-multigen-04",
      "session-fixture-partial-06",
      "session-fixture-plain-03",
    ]);
  });

  it("标题子串过滤不区分大小写", () => {
    const outcome = buildList(contextOf(HEALTHY_HOME), defaultFilters({ title: "title" }));
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.deepEqual(
      outcome.data.entries.map((entry) => entry.id),
      ["session-fixture-multigen-04"],
    );
  });

  it("排序：time/created 降序、title 升序、limit 作用于显示", () => {
    const byTime = buildList(contextOf(HEALTHY_HOME), defaultFilters());
    assert.equal(byTime.success, true);
    if (!byTime.success) return;
    assert.equal(byTime.data.entries[0].id, "session-fixture-main-01");
    assert.equal(
      byTime.data.entries[byTime.data.entries.length - 1].id,
      "session-fixture-plain-03",
    );

    const byCreated = buildList(contextOf(HEALTHY_HOME), defaultFilters({ sort: "created" }));
    assert.equal(byCreated.success, true);
    if (!byCreated.success) return;
    assert.equal(byCreated.data.entries[0].id, "bbbb1111-2222-3333-4444-555566667777");

    const byTitle = buildList(contextOf(HEALTHY_HOME), defaultFilters({ sort: "title" }));
    assert.equal(byTitle.success, true);
    if (!byTitle.success) return;
    assert.equal(
      byTitle.data.entries[byTitle.data.entries.length - 1].id,
      "session-fixture-main-01",
    );

    const limited = buildList(contextOf(HEALTHY_HOME), defaultFilters({ limit: 2 }));
    assert.equal(limited.success, true);
    if (!limited.success) return;
    assert.equal(limited.data.entries.length, 2);
    assert.equal(limited.data.matchedCount, 8);
  });

  it("工作区标题与可用性标记进入条目", () => {
    const outcome = buildList(
      contextOf(HEALTHY_HOME),
      defaultFilters({ workspace: "user_projects" }),
    );
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    const main = outcome.data.entries.find((entry) => entry.id === "session-fixture-main-01");
    assert.equal(main?.workspaceTitle, "user_projects");
    const sub = outcome.data.entries.find((entry) => entry.type === "subagent");
    assert.equal(sub?.workspaceTitle, "user_projects");
  });
});

describe("resolveSessionTarget", () => {
  it("完整 id 与裸 uuid 前缀均可解析", () => {
    const ctx = contextOf(HEALTHY_HOME);
    const full = resolveSessionTarget(ctx, "session-fixture-main-01");
    assert.equal(full.success, true);
    if (!full.success) return;
    assert.equal(full.data.id, "session-fixture-main-01");
    const prefix = resolveSessionTarget(ctx, "fixture-main-01");
    assert.equal(prefix.success, true);
    if (!prefix.success) return;
    assert.equal(prefix.data.id, "session-fixture-main-01");
  });

  it("前缀过短 → argument-invalid；无匹配 → target-missing", () => {
    const ctx = contextOf(HEALTHY_HOME);
    const short = resolveSessionTarget(ctx, "abc");
    assert.equal(short.success, false);
    if (!short.success) assert.equal(short.error.category, "argument-invalid");
    const none = resolveSessionTarget(ctx, "zzzzzzzz");
    assert.equal(none.success, false);
    if (!none.success) assert.equal(none.error.category, "target-missing");
  });

  it("歧义前缀报候选数", () => {
    const result = resolveSessionTarget(contextOf(HEALTHY_HOME), "session-fixture");
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.error.category, "ambiguous");
    assert.equal(result.error.candidates, 8);
  });

  it("last 解析为主会话中最近活动者", () => {
    const result = resolveSessionTarget(contextOf(HEALTHY_HOME), "last");
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.id, "session-fixture-main-01");
  });
});

describe("readSessionFile / buildSessionNode", () => {
  it("读取完整解码日志（事件数/帧数）", () => {
    const entries = discoverReadableSessions(HEALTHY_HOME, fakeCatalog);
    assert.equal(entries.success, true);
    if (!entries.success) return;
    assert.deepEqual(entries.data.skipped, []);
    const entry = findEntry(entries.data.entries, "session-fixture-main-01");
    const file = readSessionFile(entry, fakeCatalog);
    assert.equal(file.success, true);
    if (!file.success) return;
    assert.equal(file.data.decoded.events.length, 14);
    assert.equal(file.data.frames, 6);
    assert.equal(file.data.tornStart, undefined);
  });

  it("结构损坏文件报数据不可读", () => {
    const refs = enumerateSessionFiles(BROKEN_HOME);
    assert.equal(refs.success, true);
    if (!refs.success) return;
    const ref = refs.data.find((candidate) => candidate.idFromDir === "session-broken-corrupt-08");
    assert.notEqual(ref, undefined);
    if (ref === undefined) return;
    const file = readSessionFile({ ...ref, id: ref.idFromDir, header: {} }, fakeCatalog);
    assert.equal(file.success, false);
    if (!file.success) assert.equal(file.error.category, "data-unreadable");
  });

  it("撕裂尾：完整帧事件可读并记入 anomalies", () => {
    const refs = enumerateSessionFiles(BROKEN_HOME);
    assert.equal(refs.success, true);
    if (!refs.success) return;
    const ref = refs.data.find((candidate) => candidate.idFromDir === "session-broken-torn-06");
    assert.notEqual(ref, undefined);
    if (ref === undefined) return;
    const file = readSessionFile({ ...ref, id: ref.idFromDir, header: {} }, fakeCatalog);
    assert.equal(file.success, true);
    if (!file.success) return;
    assert.equal(file.data.decoded.events.length, 3);
    assert.equal(
      file.data.decoded.anomalies.some((anomaly) => anomaly.kind === "torn-tail"),
      true,
    );
  });

  it("子代理树递归构建", () => {
    const entries = discoverReadableSessions(HEALTHY_HOME, fakeCatalog);
    assert.equal(entries.success, true);
    if (!entries.success) return;
    assert.deepEqual(entries.data.skipped, []);
    const main = findEntry(entries.data.entries, "session-fixture-main-01");
    const node = buildSessionNode(contextOf(HEALTHY_HOME), main, entries.data.entries, new Set());
    assert.equal(node.success, true);
    if (!node.success) return;
    assert.equal(node.data.children.length, 1);
    assert.equal(node.data.children[0].entry.id, "bbbb1111-2222-3333-4444-555566667777");
  });
});

describe("runSearch", () => {
  const scopeFilters = { origin: "all" as const };
  const baseOptions = { caseSensitive: false, context: 20, limit: 0 };

  it("scope=text：仅用户/助手正文", () => {
    const outcome = runSearch(contextOf(HEALTHY_HOME), "needle", scopeFilters, {
      ...baseOptions,
      scope: "text",
    });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.totalHits, 2);
    assert.deepEqual(outcome.data.hits.map((hit) => hit.label).sort(), ["assistant", "user"]);
  });

  it("scope=tools：另含工具参数与结果", () => {
    const outcome = runSearch(contextOf(HEALTHY_HOME), "needle", scopeFilters, {
      ...baseOptions,
      scope: "tools",
    });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.totalHits, 4);
    assert.deepEqual([...new Set(outcome.data.hits.map((hit) => hit.label))].sort(), [
      "assistant",
      "tool/call",
      "tool/result",
      "user",
    ]);
  });

  it("scope=all：覆盖推理/系统/压缩/命令/标题请求/交付物", () => {
    const outcome = runSearch(contextOf(HEALTHY_HOME), "needle", scopeFilters, {
      ...baseOptions,
      scope: "all",
    });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    const labels = new Set(outcome.data.hits.map((hit) => hit.label));
    for (const label of [
      "assistant/reasoning",
      "system",
      "compaction/summary",
      "command/run",
      "command/done",
      "title-request",
      "deliverables",
    ]) {
      assert.equal(labels.has(label), true, `缺少 label: ${label}`);
    }
    const userHit = outcome.data.hits.find((hit) => hit.label === "user");
    assert.equal(userHit?.excerpt, "Alpha Needle here");
  });

  it("大小写敏感开关", () => {
    const sensitive = runSearch(contextOf(HEALTHY_HOME), "Needle", scopeFilters, {
      ...baseOptions,
      scope: "text",
      caseSensitive: true,
    });
    assert.equal(sensitive.success, true);
    if (!sensitive.success) return;
    assert.equal(sensitive.data.totalHits, 1);
  });

  it("limit 截断显示但总数保持全量", () => {
    const outcome = runSearch(contextOf(HEALTHY_HOME), "needle", scopeFilters, {
      ...baseOptions,
      scope: "text",
      limit: 1,
    });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.hits.length, 1);
    assert.equal(outcome.data.totalHits, 2);
    assert.equal(outcome.data.truncated, true);
  });

  it("范围过滤生效（origin=subagent 时主会话命中不计）", () => {
    const outcome = runSearch(
      contextOf(HEALTHY_HOME),
      "needle",
      { origin: "subagent" },
      { ...baseOptions, scope: "all" },
    );
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.totalHits, 0);
  });
});

describe("runStats", () => {
  it("全局聚合：轮次/步数/令牌/空会话/不可用列表", () => {
    const outcome = runStats(contextOf(HEALTHY_HOME), undefined, { origin: "all" });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.kind, "global");
    assert.equal(outcome.data.sessionCount, 9);
    assert.equal(outcome.data.blankCount, 1);
    assert.equal(outcome.data.turns, 3);
    assert.equal(outcome.data.steps, 3);
    assert.equal(outcome.data.toolCalls, 1);
    assert.deepEqual(outcome.data.tokens, {
      uncachedInputTokens: 600,
      outputTokens: 300,
      cacheReadTokens: 150,
      cacheWriteTokens: 30,
    });
    assert.equal(outcome.data.earliestCreatedAt, 500);
    assert.equal(outcome.data.latestActivityAt, 2000);
    assert.equal(outcome.data.totalSizeBytes > 0, true);
    assert.equal(outcome.data.unavailable.length, 4);
  });

  it("单会话统计", () => {
    const outcome = runStats(contextOf(HEALTHY_HOME), "fixture-main-01", { origin: "all" });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.kind, "single");
    const single = outcome.data.single;
    assert.notEqual(single, null);
    if (single === null) return;
    assert.equal(single.id, "session-fixture-main-01");
    assert.equal(single.title.value, "夹具标题 A");
    assert.equal(single.turns.value, 2);
    assert.equal(single.toolCalls, 1);
    assert.equal(single.metadataAvailable, true);
  });
});

describe("runCheck", () => {
  it("健康数据：无异常", () => {
    const outcome = runCheck(contextOf(HEALTHY_HOME), undefined);
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.sessions.length, 9);
    assert.equal(outcome.data.anomalyCount, 0);
    assert.equal(
      outcome.data.sessions.every((session) => session.structure === "完整"),
      true,
    );
  });

  it("异常数据：撕裂尾/seq 不连续/结构损坏逐项报告", () => {
    const outcome = runCheck(contextOf(BROKEN_HOME), undefined);
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.sessions.length, 3);
    assert.equal(outcome.data.anomalyCount >= 3, true);
    const torn = outcome.data.sessions.find((session) => session.id === "session-broken-torn-06");
    assert.equal(torn?.structure.startsWith("tornStart@"), true);
    const gap = outcome.data.sessions.find((session) => session.id === "session-broken-gap-07");
    assert.equal(gap?.seqContiguous, false);
    const corrupt = outcome.data.sessions.find(
      (session) => session.id === "session-broken-corrupt-08",
    );
    assert.equal(corrupt?.structure, "结构损坏");
  });

  it("指定目标时只检查该会话", () => {
    const outcome = runCheck(contextOf(HEALTHY_HOME), "fixture-main-01");
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.sessions.length, 1);
    assert.equal(outcome.data.anomalyCount, 0);
  });
});

describe("边界与分支", () => {
  it("discoverReadableSessions 跳过不可读 header 并记录原因", () => {
    const result = discoverReadableSessions(BROKEN_HOME, fakeCatalog);
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.entries.length, 2);
    assert.equal(result.data.skipped.length, 1);
    assert.equal(result.data.skipped[0].idFromDir, "session-broken-corrupt-08");
  });

  it("空 zstd 文件 / 撕裂 header 帧 → data-unreadable", () => {
    const emptyHome = join(TEMP_ROOT, "edge-empty");
    writeFixtureHome(emptyHome, {
      sessions: [
        {
          id: "session-edge-empty-01",
          projectDir: PROJECT_OTHER,
          cwd: OTHER_CWD,
          createdAt: 1,
          events: singleEvent(),
        },
      ],
    });
    const emptyLog = join(
      emptyHome,
      "sessions",
      PROJECT_OTHER,
      "session-edge-empty-01",
      "session.v3.jsonl.zstd",
    );
    writeFileSync(emptyLog, Buffer.alloc(0));
    const empty = discoverReadableSessions(emptyHome, fakeCatalog);
    assert.equal(empty.success, true);
    if (!empty.success) return;
    assert.equal(empty.data.entries.length, 0);
    assert.equal(empty.data.skipped.length, 1);

    const tornHome = join(TEMP_ROOT, "edge-torn");
    writeFixtureHome(tornHome, {
      sessions: [
        {
          id: "session-edge-torn-02",
          projectDir: PROJECT_OTHER,
          cwd: OTHER_CWD,
          createdAt: 1,
          events: singleEvent(),
        },
      ],
    });
    const tornLog = join(
      tornHome,
      "sessions",
      PROJECT_OTHER,
      "session-edge-torn-02",
      "session.v3.jsonl.zstd",
    );
    const fullFrame = zstdCompressSync(
      Buffer.from(
        '{"type":"session","version":3,"id":"session-edge-torn-02","createdAt":1,"isSeeded":false,"delegationDepth":0}\n',
        "utf8",
      ),
    );
    writeFileSync(tornLog, fullFrame.subarray(0, 12));
    const torn = discoverReadableSessions(tornHome, fakeCatalog);
    assert.equal(torn.success, true);
    if (!torn.success) return;
    assert.equal(torn.data.entries.length, 0);
    assert.equal(torn.data.skipped.length, 1);
  });

  it("buildMetadata 行结构异常 → 字段级不可用并给原因", () => {
    const cache = {
      available: true,
      reason: null,
      rows: {
        title: { ver: 1, seq: 0, val: 123 },
        sessionListMetadata: { ver: 1, seq: 0, val: { blank: "yes", lastPromptAt: "x" } },
        sessionStats: { ver: 1, seq: 0, val: { turns: 1 } },
        agentPreset: { ver: 1, seq: 0, val: 7 },
        modelSelection: { ver: 1, seq: 0, val: { lastUsed: { provider: "p" } } },
        tokenUsage: { ver: 1, seq: 0, val: { totals: { uncachedInputTokens: 1 } } },
      },
    };
    const metadata = buildMetadata(cache);
    assert.equal(metadata.title.value, null);
    assert.equal(metadata.title.unavailable, false);
    assert.equal(metadata.blank.unavailable, true);
    assert.equal(metadata.turns.value, 1);
    assert.equal(metadata.steps.unavailable, true);
    assert.equal(metadata.agentPreset.value, null);
    assert.equal(metadata.model.unavailable, true);
    assert.equal(metadata.tokens.unavailable, true);
    assert.equal(metadata.reasons.length >= 4, true);
  });

  it("排序 size/turns 分支", () => {
    const bySize = buildList(contextOf(HEALTHY_HOME), defaultFilters({ sort: "size" }));
    assert.equal(bySize.success, true);
    if (!bySize.success) return;
    const sizes = bySize.data.entries.map((entry) => entry.sizeBytes);
    assert.deepEqual(
      sizes,
      [...sizes].sort((left, right) => right - left),
    );
    const byTurns = buildList(contextOf(HEALTHY_HOME), defaultFilters({ sort: "turns" }));
    assert.equal(byTurns.success, true);
    if (!byTurns.success) return;
    assert.equal(byTurns.data.entries[0].id, "session-fixture-main-01");
    assert.equal(byTurns.data.entries[1].id, "bbbb1111-2222-3333-4444-555566667777");
  });

  it("runSearch context=0 无省略号且命中位置正确", () => {
    const outcome = runSearch(
      contextOf(HEALTHY_HOME),
      "Needle",
      { origin: "all" },
      {
        scope: "text",
        caseSensitive: true,
        context: 0,
        limit: 5,
      },
    );
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.hits[0].excerpt, "…Needle…");
    assert.equal(outcome.data.truncated, false);
  });

  it("runStats 目标不存在时返回 target-missing", () => {
    const outcome = runStats(contextOf(HEALTHY_HOME), "zzzzzzzz", { origin: "all" });
    assert.equal(outcome.success, false);
    if (!outcome.success) assert.equal(outcome.error.category, "target-missing");
  });
});

describe("审查修订补充：不可用口径 / 码点切片 / 边界分支", () => {
  function contextWith(home: string, catalog: SessionFormatCatalog): StoreContext {
    return { dshHome: home, catalog };
  }

  function plainHeader(id: string): string {
    return `${JSON.stringify({ type: "session", version: 3, id, createdAt: 1, isSeeded: false, delegationDepth: 0 })}\n`;
  }

  function writePlainSession(root: string, id: string, content: string): void {
    const dir = join(root, "sessions", PROJECT_OTHER, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.v3.jsonl"), content, "utf8");
  }

  function writeZstdSession(root: string, id: string, buffer: Buffer): void {
    const dir = join(root, "sessions", PROJECT_OTHER, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.v3.jsonl.zstd"), buffer);
  }

  /** 手工构造"结构完整但解压必然失败"的单帧（compressed 块 + 全 0xFF 垃圾载荷）。 */
  function garbageFrame(payloadLength: number): Buffer {
    const buffer = Buffer.alloc(9 + payloadLength, 0xff);
    buffer.writeUInt32LE(4247762216, 0);
    buffer.writeUInt8(0, 4);
    buffer.writeUInt8(0, 5);
    buffer.writeUIntLE(1 | (2 << 1) | (payloadLength << 3), 6, 3);
    return buffer;
  }

  it("stats：不可用指标不静默显 0；全局附未计入会话数", () => {
    const partial = runStats(contextOf(HEALTHY_HOME), "session-fixture-partial-06", {
      origin: "all",
    });
    assert.equal(partial.success, true);
    if (!partial.success) return;
    assert.equal(partial.data.single?.blank.unavailable, true);
    assert.equal(partial.data.single?.turns.unavailable, true);
    assert.equal(partial.data.excludedMetricSessions, 0);

    const nocache = runStats(contextOf(HEALTHY_HOME), "session-fixture-nocache-09", {
      origin: "all",
    });
    assert.equal(nocache.success, true);
    if (!nocache.success) return;
    assert.equal(nocache.data.single?.tokens.unavailable, true);

    const blank = runStats(contextOf(HEALTHY_HOME), "session-fixture-blank-05", {
      origin: "all",
    });
    assert.equal(blank.success, true);
    if (!blank.success) return;
    assert.equal(blank.data.blankCount, 1);

    const global = runStats(contextOf(HEALTHY_HOME), undefined, { origin: "all" });
    assert.equal(global.success, true);
    if (!global.success) return;
    // partial-06 / identity-07 / version-08 / nocache-09 的轮次或步数不可用 → 未计入总和。
    assert.equal(global.data.excludedMetricSessions, 4);
    assert.equal(global.data.turns, 3);
  });

  it("workspace.json 不可解析时返回空表", () => {
    const home = join(TEMP_ROOT, "bad-workspace-dsh");
    resetTempDir(home);
    mkdirSync(join(home, "storages"), { recursive: true });
    writeFileSync(join(home, "storages", "workspace.json"), "not-json", "utf8");
    assert.deepEqual(loadWorkspaceIndex(home), []);
  });

  it("search 摘录按码点切片：代理对不被切断", () => {
    const home = join(TEMP_ROOT, "surrogate-dsh");
    resetTempDir(home);
    writeFixtureHome(home, {
      sessions: [
        {
          id: "session-surrogate-01",
          projectDir: PROJECT_OTHER,
          cwd: OTHER_CWD,
          createdAt: 1000,
          events: [
            event(
              "user/message",
              0,
              10,
              { role: "user", content: [{ type: "text", text: "😀😀target😀😀" }] },
              { surfaceOp: "append" },
            ),
          ],
          title: null,
          turns: 0,
          steps: 0,
          lastPromptAt: null,
        },
      ],
    });
    const outcome = runSearch(
      contextOf(home),
      "target",
      { origin: "all" },
      { scope: "text", caseSensitive: false, context: 1, limit: 0 },
    );
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.hits.length, 1);
    assert.equal(outcome.data.hits[0].excerpt, "…😀target😀…");
    assert.equal(outcome.data.hits[0].excerpt.includes("\uFFFD"), false);
  });

  it("帧边界：解压失败 / 截断 header 帧 / 跨 64KiB 容量增长", () => {
    const home = join(TEMP_ROOT, "frame-edge-dsh");
    resetTempDir(home);
    writeZstdSession(home, "session-frame-fail-01", garbageFrame(8));
    const compressed = zstdCompressSync(Buffer.from(plainHeader("session-frame-torn-02")));
    writeZstdSession(
      home,
      "session-frame-torn-02",
      compressed.subarray(0, Math.max(8, Math.floor(compressed.length / 2))),
    );
    const big = `${JSON.stringify({
      type: "session",
      version: 3,
      id: "session-frame-big-03",
      createdAt: 1,
      isSeeded: false,
      delegationDepth: 0,
      pad: randomBytes(300_000).toString("base64"),
    })}\n`;
    writeZstdSession(home, "session-frame-big-03", zstdCompressSync(Buffer.from(big)));

    const discovered = discoverReadableSessions(home, fakeCatalog);
    assert.equal(discovered.success, true);
    if (!discovered.success) return;
    const skipped = discovered.data.skipped;
    assert.equal(
      skipped.some((entry) => entry.error.includes("header 帧解压失败")),
      true,
    );
    assert.equal(
      skipped.some((entry) => entry.error.includes("header 帧不完整")),
      true,
    );
    assert.equal(
      discovered.data.entries.some((entry) => entry.id === "session-frame-big-03"),
      true,
    );

    const refs = enumerateSessionFiles(home);
    assert.equal(refs.success, true);
    if (!refs.success) return;
    const ref = refs.data.find((entry) => entry.idFromDir === "session-frame-fail-01");
    assert.notEqual(ref, undefined);
    if (ref === undefined) return;
    const result = readSessionFile(
      {
        id: "session-frame-fail-01",
        projectDirName: ref.projectDirName,
        dirPath: ref.dirPath,
        logPath: ref.logPath,
        logVersion: ref.logVersion,
        logCompressed: ref.logCompressed,
        sizeBytes: ref.sizeBytes,
        header: {},
      },
      fakeCatalog,
    );
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.category, "data-unreadable");

    const checked = runCheck(contextOf(home), undefined);
    assert.equal(checked.success, true);
    if (!checked.success) return;
    const failed = checked.data.sessions.find((entry) => entry.id === "session-frame-fail-01");
    assert.equal(
      failed?.anomalies.some((value) => value.includes("帧解压失败")),
      true,
    );
  });

  it("check 边界：空日志 / 坏行 / 缺 seq / 分类 malformed", () => {
    const home = join(TEMP_ROOT, "check-edge-dsh");
    resetTempDir(home);
    writePlainSession(home, "session-edge-empty-01", "");
    writePlainSession(
      home,
      "session-edge-bad-02",
      `${plainHeader("session-edge-bad-02")}not-json\n{\n`,
    );
    writePlainSession(
      home,
      "session-edge-noseq-03",
      `${plainHeader("session-edge-noseq-03")}${JSON.stringify({ type: "turn/start", time: 1, data: {} })}\n`,
    );
    const checked = runCheck(contextOf(home), undefined);
    assert.equal(checked.success, true);
    if (!checked.success) return;
    const empty = checked.data.sessions.find((entry) => entry.id === "session-edge-empty-01");
    assert.equal(empty?.anomalies.includes("日志为空"), true);
    const bad = checked.data.sessions.find((entry) => entry.id === "session-edge-bad-02");
    assert.equal(bad?.badLineCount, 2);
    const noseq = checked.data.sessions.find((entry) => entry.id === "session-edge-noseq-03");
    assert.equal(
      noseq?.anomalies.some((value) => value.includes("缺少 seq")),
      true,
    );
    writePlainSession(home, "session-edge-badheader-05", "not-json\n");
    const checkedAgain = runCheck(contextOf(home), undefined);
    assert.equal(checkedAgain.success, true);
    if (!checkedAgain.success) return;
    const badHeader = checkedAgain.data.sessions.find(
      (item) => item.id === "session-edge-badheader-05",
    );
    assert.equal(badHeader?.anomalies.includes("header 行不是合法 JSON"), true);

    const malformedHome = join(TEMP_ROOT, "check-malformed-dsh");
    resetTempDir(malformedHome);
    writePlainSession(
      malformedHome,
      "session-edge-malformed-04",
      plainHeader("session-edge-malformed-04"),
    );
    const malformed = runCheck(
      contextWith(malformedHome, createFakeCatalog({ status: "malformed" })),
      undefined,
    );
    assert.equal(malformed.success, true);
    if (!malformed.success) return;
    const entry = malformed.data.sessions.find((item) => item.id === "session-edge-malformed-04");
    assert.equal(entry?.classification, "malformed");
    assert.equal(
      entry?.anomalies.some((value) => value.includes("header 分类: malformed")),
      true,
    );
  });

  it("discoverReadableSessions：坏 JSON / 缺 id / 分类缺逻辑 header 的跳过分支", () => {
    const home = join(TEMP_ROOT, "discovery-edge-dsh");
    resetTempDir(home);
    writePlainSession(home, "session-disc-badjson-01", "not-json\n");
    writePlainSession(
      home,
      "session-disc-noid-02",
      `${JSON.stringify({ type: "session", version: 3 })}\n`,
    );
    const discovered = discoverReadableSessions(home, fakeCatalog);
    assert.equal(discovered.success, true);
    if (!discovered.success) return;
    assert.equal(discovered.data.entries.length, 0);
    assert.equal(
      discovered.data.skipped.some((entry) => entry.error === "header 行不是合法 JSON"),
      true,
    );
    assert.equal(
      discovered.data.skipped.some((entry) => entry.error === "header 缺少 id"),
      true,
    );

    const noHeaderCatalog: SessionFormatCatalog = {
      currentVersion: 3,
      readHeader: () => ({ status: "current", storedVersion: 3, targetVersion: 3 }),
      createRestore: () => {
        throw new Error("该测试不应触发 createRestore");
      },
    };
    const noHeader = discoverReadableSessions(home, noHeaderCatalog);
    assert.equal(noHeader.success, true);
    if (!noHeader.success) return;
    assert.equal(
      noHeader.data.skipped.some((entry) => entry.error === "header 分类缺少逻辑 header"),
      true,
    );

    const malformedCatalog = createFakeCatalog({ status: "malformed" });
    const malformed = discoverReadableSessions(home, malformedCatalog);
    assert.equal(malformed.success, true);
    if (!malformed.success) return;
    assert.equal(
      malformed.data.skipped.some((entry) => entry.error === "header 分类 malformed"),
      true,
    );
  });

  it("标识解析：裸 id 与 session- 前缀同时精确匹配 → 歧义", () => {
    const home = join(TEMP_ROOT, "ambiguous-exact-dsh");
    resetTempDir(home);
    writeFixtureHome(home, {
      sessions: [
        {
          id: "e2e1e2e1",
          projectDir: PROJECT_OTHER,
          cwd: OTHER_CWD,
          createdAt: 1,
          events: singleEvent(),
          title: null,
          turns: 0,
          steps: 0,
          lastPromptAt: null,
        },
        {
          id: "session-e2e1e2e1",
          projectDir: PROJECT_OTHER,
          cwd: OTHER_CWD,
          createdAt: 2,
          events: singleEvent(),
          title: null,
          turns: 0,
          steps: 0,
          lastPromptAt: null,
        },
      ],
    });
    const resolved = resolveSessionTarget(contextOf(home), "e2e1e2e1");
    assert.equal(resolved.success, false);
    if (!resolved.success) assert.equal(resolved.error.category, "ambiguous");
  });

  it("loadProjCache：JSON 不可解析 → projcache 读取失败", () => {
    const home = join(TEMP_ROOT, "bad-projcache-dsh");
    resetTempDir(home);
    writeFixtureHome(home, {
      sessions: [
        {
          id: "session-badcache-01",
          projectDir: PROJECT_OTHER,
          cwd: OTHER_CWD,
          createdAt: 1,
          events: singleEvent(),
          title: null,
          turns: 0,
          steps: 0,
          lastPromptAt: null,
        },
      ],
    });
    writeFileSync(
      join(home, "storages", "session_projcache", "sessions", "session-badcache-01.json"),
      "not-json",
      "utf8",
    );
    const state = loadProjCache(home, "session-badcache-01", {
      version: 3,
      createdAt: 1,
      cwd: OTHER_CWD,
      isSeeded: false,
    });
    assert.equal(state.available, false);
    assert.equal(state.reason, "projcache 读取失败");
  });

  it("同版本 .zstd 与明文并存：排序同版本分支（优先 .zstd）", () => {
    const home = join(TEMP_ROOT, "same-version-dsh");
    resetTempDir(home);
    writeFixtureHome(home, {
      sessions: [
        {
          id: "session-samever-01",
          projectDir: PROJECT_OTHER,
          cwd: OTHER_CWD,
          createdAt: 1,
          events: singleEvent(),
          title: null,
          turns: 0,
          steps: 0,
          lastPromptAt: null,
          extraFiles: [
            {
              fileName: "session.v3.jsonl",
              content: Buffer.from(plainHeader("session-samever-01"), "utf8"),
            },
          ],
        },
      ],
    });
    const refs = enumerateSessionFiles(home);
    assert.equal(refs.success, true);
    if (!refs.success) return;
    const entry = refs.data.find((item) => item.idFromDir === "session-samever-01");
    assert.equal(entry?.logCompressed, true);
  });
});
