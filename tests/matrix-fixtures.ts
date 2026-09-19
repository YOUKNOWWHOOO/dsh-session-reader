// 用途：全组合 lint 门禁的敌意内容集、合成 DSH_HOME 的会话夹具定义与夹具 home 构造。
// 主要入口：buildFixtureHomes（清理并重建健康/损坏两套夹具 home 与官方库 junction，注入敌意模型字段）、
//           healthySpec/brokenSpec（夹具根定义，供组合矩阵与入口复用）。
// 关键依赖：./fixtures.ts（FixtureEvent/FixtureHomeSpec/writeFixtureHome）、./matrix-assert.ts（asRecord 判型）。
// 设计约束：夹具只写 workdir 下的固定子路径（fixture-healthy、fixture-broken、out），真实 dsh 主目录全程只读；
//           敌意内容集逐条对应 f2 §2.1 的 67 条，禁止增删或改写，注入点分散于消息/工具/系统/压缩/命令/
//           标题请求/web/交付物字段，注入后的 home 由端到端门禁逐产物复查。

import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FixtureEvent, type FixtureHomeSpec, writeFixtureHome } from "./fixtures.ts";
import { asRecord } from "./matrix-assert.ts";

// ------------------------- 敌意内容集（f2 §2.1 的 67 条，逐条复制） -------------------------

const CONTENTS: readonly string[] = [
  "a\tb",
  "\tindented tab line",
  "line with 2 trailing spaces  ",
  "line with 3 trailing spaces   ",
  "line with 1 trailing space ",
  "para1\n\n\npara2",
  "a\n\n\n\n\nb",
  "visit https://example.com/path now",
  "(https://example.com)",
  "$ echo hello",
  "$ ls\n$ pwd",
  "$ echo hello\nhello",
  "**bold text**",
  "**注意**：",
  '<div class="x">a</div>',
  "<script>alert(1)</script>",
  "```",
  "````",
  "code `x` here",
  "odd ` backtick",
  "# not a title",
  "#### deep",
  "#nospace",
  "## 用户\n\nx\n\n## 用户",
  `long ${"A".repeat(3000)}`,
  "(x)[y]",
  "[text][ref] and [shortcut]",
  "[]() and [](https://example.com)",
  "![](https://example.com/a.png)",
  "** bold **",
  "` x `",
  "[ x ](https://example.com)",
  "_italic_",
  "__bold__",
  "---",
  "Title\n=====",
  "> quoted",
  "- item",
  "+ item",
  "* item",
  "2. item",
  "<!-- note -->",
  "abc\u202Edef\u200Fghi",
  "a\u0301b\u0301",
  "a\u0001b\u0007c",
  "a\u0000b",
  "line1\r\nline2",
  "line1\rline2",
  "a\u000Bb",
  "a\u000Cc",
  "a\u200Bb",
  "http://x.com/a_b_c",
  "<https://example.com>",
  "**start\nend**",
  "```js\ncode\n```",
  "a | b | c",
  "| a | b |",
  "    - four space item",
  "line\\",
  "（全角）",
  "👉🏽 ok",
  "Title ends with!",
  "{a} [b] (c)",
  "www.example.com",
  "a@b.com",
  "结束。",
  "```text",
];

// ------------------------- 夹具定义 -------------------------

const PROJECT_DIR = "--C-Users-Alice-user-projects--";
const GRAND_ID = "session-adv-grand-08";

/** 夹具主会话 id：组合矩阵的 show/stats 目标与前缀歧义候选数都基于它。 */
export const MAIN_ID = "session-adv-main-01";
/** 夹具子代理会话 id（continuable，带子代）。 */
export const CHILD_ID = "session-adv-child-07";
/** 夹具主/子会话共用的工作目录（含空格、方括号与井号）。 */
export const MAIN_CWD = "C:\\Users\\Alice\\user projects [v2] #tag_under";

function ev(
  type: string,
  seq: number,
  time: number,
  data: Record<string, unknown>,
  extra?: { readonly surfaceOp?: unknown; readonly sourceEventSeqs?: readonly number[] },
): FixtureEvent {
  return { type, seq, time, data, ...extra };
}

/** 主会话事件：把敌意内容分散注入到消息/工具/系统/压缩/命令/标题请求/web/交付物字段。 */
function mainEvents(): FixtureEvent[] {
  return [
    ev("turn/start", 0, 10, { turn: 1 }),
    ev("step/start", 1, 11, { turn: 1, step: 1 }),
    ev(
      "system/message",
      2,
      12,
      {
        turn: 1,
        step: 1,
        message: {
          id: "sys-1",
          role: "system",
          source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" },
          content: [{ type: "text", text: CONTENTS[22] }],
        },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "user/message",
      3,
      13,
      {
        role: "user",
        content: [{ type: "text", text: "needle ALPHA plain text" }],
        // 该夹具是"用户消息"位，但刻意给出非用户来源：门禁因此会 lint 到带来源标注的标签行
        // （含入行内载体的 senderSessionId），使标注的载体规则也在全组合层面受检。
        source: {
          kind: "agent-message",
          form: "relay",
          senderSessionId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
        },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "assistant/message",
      4,
      14,
      {
        turn: 1,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: `needle reply ${CONTENTS[12]}` },
            { type: "reasoning", text: CONTENTS[18] },
          ],
        },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, reasoningTokens: 1 },
      },
      { surfaceOp: "append" },
    ),
    ev("tool/call", 5, 15, {
      turn: 1,
      step: 1,
      callId: "call_1",
      name: "read",
      arguments: CONTENTS[19],
    }),
    ev(
      "tool/result",
      6,
      16,
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
              content: [{ type: "text", text: CONTENTS[7] }],
              isError: false,
            },
          ],
        },
      },
      { surfaceOp: "append", sourceEventSeqs: [5] },
    ),
    ev("turn/end", 7, 17, { turn: 1, reason: { kind: "completed" } }),
    ev("turn/start", 8, 18, { turn: 2 }),
    ev(
      "user/message",
      9,
      19,
      { role: "user", content: [{ type: "text", text: `second needle ${CONTENTS[13]}` }] },
      { surfaceOp: "append" },
    ),
    ev("compaction/summary", 10, 20, {
      summary: [{ type: "text", text: CONTENTS[20] }],
      rawOutput: [{ type: "text", text: CONTENTS[21] }],
    }),
    ev("command/run", 11, 21, {
      commandId: "cmd-1",
      name: "compact",
      args: { x: CONTENTS[37] },
      source: { kind: "user" },
    }),
    ev("command/done", 12, 22, {
      commandId: "cmd-1",
      kind: "text",
      text: CONTENTS[38],
      sourceEventSeq: 11,
    }),
    ev("session/title-llm-request", 13, 23, {
      titleProvider: "p",
      messageSeqs: [3],
      route: { provider: "prov_/slash", model: "mod-el/x" },
      system: CONTENTS[41],
      messages: [{ role: "user", content: [{ type: "text", text: "title msg" }] }],
      maxTokens: 100,
    }),
    ev("web/deepseek-search-llm-request", 14, 24, {
      endpoint: "e",
      apiVersion: "v",
      body: {
        model: "m",
        max_tokens: 1,
        messages: [{ role: "user", content: [{ type: "text", text: CONTENTS[64] }] }],
        tools: [],
      },
    }),
    ev("deliverables/presented", 15, 25, {
      turn: 1,
      callId: "call_1",
      files: [{ path: "a.txt", description: CONTENTS[65] }],
    }),
    ev(
      "assistant/message",
      16,
      26,
      { turn: 2, message: { role: "assistant", content: [{ type: "text", text: "bye needle" }] } },
      { surfaceOp: "append" },
    ),
    ev("session/title", 17, 27, {
      title: CONTENTS[14],
      messageSeqs: [3],
      source: { kind: "fallback" },
    }),
    ev("turn/end", 18, 28, { turn: 2, reason: { kind: "completed" } }),
  ];
}

function specialEvents(texts: readonly string[], title: string): FixtureEvent[] {
  const events: FixtureEvent[] = [];
  let seq = 0;
  for (const text of texts) {
    events.push(
      ev(
        "user/message",
        seq,
        10 + seq,
        { role: "user", content: [{ type: "text", text }] },
        { surfaceOp: "append" },
      ),
    );
    seq += 1;
    events.push(
      ev(
        "assistant/message",
        seq,
        10 + seq,
        { turn: 1, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
        { surfaceOp: "append" },
      ),
    );
    seq += 1;
  }
  events.push(ev("session/title", seq, 10 + seq, { title, messageSeqs: [0] }));
  return events;
}

/** 健康夹具：13 个会话（含子代理两代、空会话、projcache 缺失/版本/identity/部分四态）。 */
export function healthySpec(): FixtureHomeSpec {
  return {
    sessions: [
      {
        id: MAIN_ID,
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 1000,
        events: mainEvents(),
        agentPreset: "standard `code` preset",
        title: CONTENTS[0],
        turns: 2,
        steps: 1,
        lastPromptAt: 2000,
      },
      {
        id: "session-adv-lines-02",
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 1100,
        events: specialEvents([CONTENTS.join("\n")], CONTENTS[5]),
        title: CONTENTS[5],
        turns: 1,
        steps: 0,
        lastPromptAt: 2100,
      },
      {
        id: "session-adv-dollar-03",
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 1200,
        events: specialEvents(["$ ls\n$ pwd", "$ echo hello\nhello", "$x\n$y"], CONTENTS[9]),
        title: CONTENTS[9],
        turns: 1,
        steps: 0,
        lastPromptAt: 2200,
      },
      {
        id: "session-adv-tab-04",
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 1300,
        events: specialEvents(["a\tb", "\tlead", "\t"], CONTENTS[1]),
        title: CONTENTS[1],
        turns: 1,
        steps: 0,
        lastPromptAt: 2300,
      },
      {
        id: "session-adv-crlf-05",
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 1400,
        events: specialEvents(["line1\r\nline2", "line1\rline2"], CONTENTS[46]),
        title: CONTENTS[46],
        turns: 1,
        steps: 0,
        lastPromptAt: 2400,
      },
      {
        id: "session-adv-blank-06",
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 1500,
        events: specialEvents(["   ", "\t "], CONTENTS[4]),
        title: CONTENTS[4],
        turns: 1,
        steps: 0,
        lastPromptAt: 2500,
      },
      {
        id: CHILD_ID,
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 1600,
        events: [
          ev("subagent/descriptor", 0, 10, {
            version: 3,
            mode: "continuable",
            label: "子代理 `label` https://example.com/path",
            provider: "spawn",
            agentProvider: "prov_/slash",
            agentModel: "mod-el/x",
            agentReasoningEffort: "max",
          }),
          ev(
            "user/message",
            1,
            11,
            { role: "user", content: [{ type: "text", text: "$ echo child" }] },
            { surfaceOp: "append" },
          ),
          ev(
            "assistant/message",
            2,
            12,
            {
              turn: 1,
              message: {
                role: "assistant",
                content: [{ type: "text", text: "reply\twith tab" }],
              },
            },
            { surfaceOp: "append" },
          ),
          ev("session/title", 3, 13, { title: "(x)[y]", messageSeqs: [1] }),
        ],
        parentSession: MAIN_ID,
        origin: "subagent",
        title: null,
        turns: 1,
        steps: 0,
        lastPromptAt: null,
      },
      {
        id: GRAND_ID,
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 1700,
        events: [
          ev(
            "user/message",
            0,
            10,
            { role: "user", content: [{ type: "text", text: "grand `x` reply" }] },
            { surfaceOp: "append" },
          ),
        ],
        parentSession: CHILD_ID,
        origin: "subagent",
        title: CONTENTS[25],
        turns: 0,
        steps: 0,
        lastPromptAt: null,
      },
      {
        id: "session-adv-empty-09",
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 1800,
        events: [],
        title: null,
        turns: 0,
        steps: 0,
        lastPromptAt: null,
      },
      {
        id: "session-adv-nopc-10",
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 1900,
        events: specialEvents(["no projcache needle"], CONTENTS[2]),
        projcache: "missing",
        title: CONTENTS[2],
        turns: 1,
        steps: 0,
        lastPromptAt: 2600,
      },
      {
        id: "session-adv-pcver-11",
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 2000,
        events: specialEvents(["version mismatch needle"], CONTENTS[3]),
        projcache: "version",
        title: CONTENTS[3],
        turns: 1,
        steps: 0,
        lastPromptAt: 2700,
      },
      {
        id: "session-adv-pcid-12",
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 2100,
        events: specialEvents(["identity mismatch needle"], CONTENTS[6]),
        projcache: "identity",
        title: CONTENTS[6],
        turns: 1,
        steps: 0,
        lastPromptAt: 2800,
      },
      {
        id: "session-adv-pcpart-13",
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 2200,
        events: specialEvents(["partial projcache needle"], CONTENTS[17]),
        projcache: "partial",
        title: CONTENTS[17],
        turns: 1,
        steps: 0,
        lastPromptAt: 2900,
      },
    ],
    workspace: {
      path: MAIN_CWD,
      title: "user_projects",
      sessionIds: [MAIN_ID, CHILD_ID, GRAND_ID],
    },
  };
}

/** 损坏夹具：撕裂尾、事件断号、首帧魔数损坏三态。 */
export function brokenSpec(): FixtureHomeSpec {
  return {
    sessions: [
      {
        id: "session-brk-torn-14",
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 3000,
        events: specialEvents(["torn needle"], CONTENTS[15]),
        tornTail: true,
      },
      {
        id: "session-brk-gap-15",
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 3100,
        events: [
          ev("permission/preset", 0, 10, { preset: "workspace-write" }),
          ev(
            "user/message",
            1,
            11,
            { role: "user", content: [{ type: "text", text: "gap needle" }] },
            { surfaceOp: "append" },
          ),
          ev(
            "assistant/message",
            3,
            12,
            {
              turn: 1,
              message: { role: "assistant", content: [{ type: "text", text: "gap reply" }] },
            },
            { surfaceOp: "append" },
          ),
        ],
      },
      {
        id: "session-brk-corrupt-16",
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 3200,
        events: [ev("permission/preset", 0, 10, { preset: "workspace-write" })],
        corrupt: true,
      },
    ],
  };
}

/** 覆写 projcache 的 modelSelection 为含下划线/斜杠的敌意值（f2 §5.2 字段级注入）。 */
function patchProjCacheModel(home: string, sessionId: string): void {
  const file = join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`);
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const rows = asRecord(asRecord(asRecord(parsed)?.record)?.rows);
  const value = asRecord(asRecord(rows?.modelSelection)?.val);
  const lastUsed = asRecord(value?.lastUsed);
  if (lastUsed === undefined) throw new Error(`projcache 结构异常，无法注入模型字段: ${sessionId}`);
  lastUsed.provider = "prov_/slash";
  lastUsed.model = "mod-el/x";
  writeFileSync(file, JSON.stringify(parsed), "utf8");
}

/** 夹具 home 与产物目录的落点。 */
export interface FixtureHomes {
  readonly healthyHome: string;
  readonly brokenHome: string;
  readonly outDir: string;
}

/**
 * 合成 DSH_HOME 构造：先清理 workdir 内固定子路径，再重建两套夹具 home、
 * 以 junction 挂上官方格式库锚点，并对主/子会话注入敌意模型字段。
 */
export function buildFixtureHomes(workdir: string, libRoot: string): FixtureHomes {
  const healthyHome = join(workdir, "fixture-healthy");
  const brokenHome = join(workdir, "fixture-broken");
  const outDir = join(workdir, "out");
  for (const path of [
    healthyHome,
    brokenHome,
    outDir,
    join(workdir, "lint-output.txt"),
    join(workdir, "matrix-summary.json"),
  ]) {
    rmSync(path, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });
  writeFixtureHome(healthyHome, healthySpec());
  writeFixtureHome(brokenHome, brokenSpec());
  const fixtureLibParent = join(healthyHome, "profiles", "node_modules", "@deepseek-ai");
  mkdirSync(fixtureLibParent, { recursive: true });
  symlinkSync(
    join(libRoot, "@deepseek-ai", "dsh-session-format-catalog"),
    join(fixtureLibParent, "dsh-session-format-catalog"),
    "junction",
  );
  patchProjCacheModel(healthyHome, MAIN_ID);
  patchProjCacheModel(healthyHome, CHILD_ID);
  return { healthyHome, brokenHome, outDir };
}
