// 全组合穷尽 lint 门禁（f2 lint 合规 spike §5 方案的可执行实现）。
// 目的：证明"任意会话内容 × 任意有效参数组合"生成的 md 产物真实通过全局 markdownlint 基线，
// 并对 json/jsonl 做结构回归、对手写结构白名单做断言、对确定性/错误路径做验证。
// 用法（Windows；Node v26 原生执行 TypeScript）：
//   node tests/lint-matrix.ts --workdir <工作目录> [--lint-config <markdownlint 配置>]
//                             [--markdownlint-js <markdownlint-cli 入口 js>]
//                             [--real-home <dsh 主目录>] [--skip-real]
// 判据：脚本退出 0 当且仅当全部断言通过；md 产物 lint 必须退出 0 且 stdout/stderr 无输出。
// lint 以参数数组直接调用 markdownlint-cli 的 JS 入口（不经 shell）；入口默认从 workdir 的
// node_modules 链解析，解析失败时以显式错误要求 --markdownlint-js。
// 留档：<workdir>/fixture-healthy、<workdir>/fixture-broken、<workdir>/out（全部产物）、
//       <workdir>/matrix-summary.json（逐组合结果）、<workdir>/lint-output.txt。
// 工作目录内只清理/重建上述固定子路径；真实 dsh 主目录全程只读。
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { countLines } from "../scripts/lib/paths.ts";
import { type FixtureEvent, type FixtureHomeSpec, writeFixtureHome } from "./fixtures.ts";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const SKILL_ROOT = resolve(SCRIPT_DIR, "..");
const SESSION_READER = join(SKILL_ROOT, "scripts", "session-reader.ts");
const DEFAULT_LINT_CONFIG = join(SKILL_ROOT, ".markdownlint.jsonc");
const LIB_ROOT = join(homedir(), ".dsh", "profiles", "node_modules");
const RUN_TIMEOUT_MS = 120_000;

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

const PROJECT_DIR = "--C-Users-ZHANG-user-projects--";
const MAIN_ID = "session-adv-main-01";
const CHILD_ID = "session-adv-child-07";
const GRAND_ID = "session-adv-grand-08";
const MAIN_CWD = "C:\\Users\\ZHANG\\user projects [v2] #tag_under";

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
      { role: "user", content: [{ type: "text", text: "needle ALPHA plain text" }] },
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

function healthySpec(): FixtureHomeSpec {
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

function brokenSpec(): FixtureHomeSpec {
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

// ------------------------- 组合矩阵定义 -------------------------

type OutputKind = "md" | "json" | "jsonl" | "none";
type JsonShape = "list" | "show" | "search" | "stats" | "check" | "jsonl" | null;

interface MatrixCase {
  readonly id: string;
  readonly args: readonly string[];
  readonly kind: OutputKind;
  readonly shape: JsonShape;
  readonly expectExit: number;
  readonly expectOutput: boolean;
  /** true 时不为该组合自动追加 --output-dir（用于"缺少输出目录"错误路径）。 */
  readonly omitOutputDir: boolean;
  /** 期望的 stderr 全文：错误路径必填（含候选数形态）；成功路径必须为空串。 */
  readonly expectStderr: string;
}

/** 歧义前缀 "session-adv-" 可匹配的健康夹具会话数（全部 13 个会话 id 均以该前缀开头）。 */
const HEALTHY_SESSION_COUNT = healthySpec().sessions.length;

const LIST_SORTS = ["time", "created", "title", "size", "turns"] as const;
const ORIGINS = ["all", "main", "subagent"] as const;
const SHOW_SWITCHES = [
  "--summary",
  "--thinking",
  "--tools",
  "--events",
  "--subagents",
  "--headers",
] as const;
const SHOW_TARGETS = [MAIN_ID, CHILD_ID, "adv-main", "last"] as const;
const SPECIAL_IDS = [
  "session-adv-lines-02",
  "session-adv-dollar-03",
  "session-adv-tab-04",
  "session-adv-crlf-05",
  "session-adv-blank-06",
  "session-adv-empty-09",
  "session-adv-nopc-10",
  "session-adv-pcver-11",
  "session-adv-pcid-12",
  "session-adv-pcpart-13",
] as const;

interface MatrixCaseOptions {
  readonly omitOutputDir?: boolean;
  readonly expectStderr?: string;
}

function mcase(
  id: string,
  args: readonly string[],
  kind: OutputKind,
  shape: JsonShape,
  expectExit: number,
  options: MatrixCaseOptions = {},
): MatrixCase {
  return {
    id,
    args,
    kind,
    shape,
    expectExit,
    expectOutput: kind !== "none",
    omitOutputDir: options.omitOutputDir ?? false,
    expectStderr: options.expectStderr ?? "",
  };
}

function healthyBase(): string[] {
  return ["--dsh-home", "HEALTHY", "--lib-root", LIB_ROOT];
}

function listCases(): MatrixCase[] {
  const cases: MatrixCase[] = [];
  const workspaces = [null, "user_projects", MAIN_CWD] as const;
  const bounds = [null, "0", "9999999999999"] as const;
  const titles = [null, "needle", "zzznomatch"] as const;
  const limits = [0, 1, 100] as const;
  for (let index = 0; index < 20; index += 1) {
    const args = ["list", ...healthyBase()];
    if (index % 2 === 1) args.push("--include-blank");
    if (index >= 10) args.push("--full");
    args.push("--sort", LIST_SORTS[index % 5], "--origin", ORIGINS[index % 3]);
    const workspace = workspaces[index % 3];
    if (workspace !== null) args.push("--workspace", workspace);
    const since = bounds[index % 3];
    if (since !== null) args.push("--since", since);
    const until = bounds[(index + 1) % 3];
    if (until !== null) args.push("--until", until);
    const title = titles[index % 3];
    if (title !== null) args.push("--title", title);
    args.push("--limit", String(limits[index % 3]));
    cases.push(mcase(`list-md-${index}`, args, "md", null, 0));
  }
  cases.push(
    mcase("list-md-default", ["list", ...healthyBase()], "md", null, 0),
    mcase("list-md-explicit-format", ["list", ...healthyBase(), "--format", "md"], "md", null, 0),
    mcase(
      "list-md-boundary-since-until",
      ["list", ...healthyBase(), "--since", "0", "--until", "0"],
      "md",
      null,
      0,
    ),
    mcase("list-md-include-blank", ["list", ...healthyBase(), "--include-blank"], "md", null, 0),
    mcase(
      "list-md-limit-1-created",
      ["list", ...healthyBase(), "--limit", "1", "--sort", "created"],
      "md",
      null,
      0,
    ),
    mcase(
      "list-md-zero-match-title",
      ["list", ...healthyBase(), "--title", "zzznomatch"],
      "md",
      null,
      0,
    ),
    mcase("list-md-default-lib-anchor", ["list", "--dsh-home", "HEALTHY"], "md", null, 0),
  );
  for (let index = 0; index < 5; index += 1) {
    const args = ["list", ...healthyBase(), "--format", "json"];
    if (index % 2 === 0) args.push("--include-blank");
    if (index >= 3) args.push("--full");
    args.push("--origin", ORIGINS[index % 3], "--limit", ["0", "100"][index % 2]);
    cases.push(mcase(`list-json-${index}`, args, "json", "list", 0));
  }
  cases.push(
    mcase("err-list-jsonl", ["list", ...healthyBase(), "--format", "jsonl"], "none", null, 2, {
      expectStderr: "错误: 参数无效（选项值无效: --format）\n",
    }),
    mcase("err-list-text", ["list", ...healthyBase(), "--format", "text"], "none", null, 2, {
      expectStderr: "错误: 参数无效（选项值无效: --format）\n",
    }),
    mcase("err-list-no-output-dir", ["list", "--dsh-home", "HEALTHY"], "none", null, 2, {
      omitOutputDir: true,
      expectStderr: "错误: 参数无效（缺少 --output-dir）\n",
    }),
    mcase(
      "err-list-missing-home",
      ["list", "--dsh-home", "NO_SUCH_HOME", "--lib-root", LIB_ROOT],
      "none",
      null,
      1,
      { expectStderr: "错误: 目标不存在\n" },
    ),
    mcase(
      "err-list-bad-workspace",
      ["list", ...healthyBase(), "--workspace", "no-such-workspace"],
      "none",
      null,
      1,
      { expectStderr: "错误: 目标不存在\n" },
    ),
  );
  return cases;
}

function showCases(): MatrixCase[] {
  const cases: MatrixCase[] = [];
  const roles = [null, "user", "assistant"] as const;
  const truncates = [0, 1, 50, 2000] as const;
  // 全笛卡尔：6 开关 64 组合 × 角色 3 × 截断 4 = 768（排列目标 × 角色 × 截断以分散目标覆盖）。
  for (let switchIndex = 0; switchIndex < 64; switchIndex += 1) {
    for (let roleIndex = 0; roleIndex < roles.length; roleIndex += 1) {
      for (let truncateIndex = 0; truncateIndex < truncates.length; truncateIndex += 1) {
        const target = SHOW_TARGETS[(switchIndex + roleIndex + truncateIndex) % 4];
        const args = ["show", target, ...healthyBase()];
        for (let bit = 0; bit < 6; bit += 1) {
          if (((switchIndex >> bit) & 1) === 1) args.push(SHOW_SWITCHES[bit]);
        }
        const role = roles[roleIndex];
        if (role !== null) args.push("--role", role);
        const truncate = truncates[truncateIndex];
        if (truncate !== 0) args.push("--truncate", String(truncate));
        cases.push(
          mcase(`show-md-${switchIndex}-${roleIndex}-${truncateIndex}`, args, "md", null, 0),
        );
      }
    }
  }
  for (const id of SPECIAL_IDS) {
    cases.push(
      mcase(`show-md-special-default-${id}`, ["show", id, ...healthyBase()], "md", null, 0),
    );
    cases.push(
      mcase(
        `show-md-special-visible-${id}`,
        ["show", id, ...healthyBase(), "--thinking", "--tools", "--events", "--headers"],
        "md",
        null,
        0,
      ),
    );
    cases.push(
      mcase(
        `show-md-special-range-${id}`,
        ["show", id, ...healthyBase(), "--turn", "1-2", "--seq", "0-3", "--events"],
        "md",
        null,
        0,
      ),
    );
  }
  // 范围选择穷尽：--turn/--seq 区间与单值形态 × --head/--tail × 可见性开关。
  const turnArgs = ["1", "1-1", "1-2", "0-1"] as const;
  const seqArgs = ["0", "0-0", "0-2", "2-4"] as const;
  for (let index = 0; index < 16; index += 1) {
    const args = ["show", SHOW_TARGETS[index % 4], ...healthyBase()];
    if (index % 4 !== 3) args.push("--turn", turnArgs[index % 4]);
    if (index % 4 !== 2) args.push("--seq", seqArgs[index % 4]);
    if (index % 3 === 0) args.push("--events", "--headers");
    if (index % 3 === 1) args.push("--thinking", "--tools");
    if (index % 5 === 0) args.push("--head", "2");
    if (index % 5 === 1) args.push("--tail", "2");
    cases.push(mcase(`show-md-range-${index}`, args, "md", null, 0));
  }
  cases.push(
    mcase("show-md-head-zero", ["show", MAIN_ID, ...healthyBase(), "--head", "0"], "md", null, 0),
    mcase("show-md-tail-zero", ["show", MAIN_ID, ...healthyBase(), "--tail", "0"], "md", null, 0),
    mcase(
      "show-md-range-with-subagents",
      ["show", MAIN_ID, ...healthyBase(), "--subagents", "--turn", "1-1"],
      "md",
      null,
      0,
    ),
    mcase(
      "show-md-range-out-of-bounds",
      ["show", MAIN_ID, ...healthyBase(), "--turn", "98-99"],
      "md",
      null,
      0,
    ),
    mcase(
      "err-show-head-tail",
      ["show", MAIN_ID, ...healthyBase(), "--head", "1", "--tail", "1"],
      "none",
      null,
      2,
      { expectStderr: "错误: 参数无效（--head 与 --tail 不能同时使用；只保留其中一个）\n" },
    ),
    mcase(
      "err-show-summary-turn",
      ["show", MAIN_ID, ...healthyBase(), "--summary", "--turn", "1"],
      "none",
      null,
      2,
      {
        expectStderr:
          "错误: 参数无效（--summary 与 --turn 不能同时使用；去掉 --turn，或去掉 --summary）\n",
      },
    ),
    mcase(
      "err-show-bad-turn",
      ["show", MAIN_ID, ...healthyBase(), "--turn", "0"],
      "none",
      null,
      2,
      { expectStderr: "错误: 参数无效（--turn 取值应为 <A-B> 或 <A>（正整数，B 不小于 A））\n" },
    ),
    mcase(
      "err-show-bad-seq",
      ["show", MAIN_ID, ...healthyBase(), "--seq", "3-1"],
      "none",
      null,
      2,
      { expectStderr: "错误: 参数无效（--seq 取值应为 <A-B> 或 <A>（非负整数，B 不小于 A））\n" },
    ),
    mcase(
      "err-show-json-turn",
      ["show", MAIN_ID, ...healthyBase(), "--format", "json", "--turn", "1"],
      "none",
      null,
      2,
      {
        expectStderr:
          "错误: 参数无效（呈现类开关 --turn 仅 md 可用；去掉 --turn，或把 --format 改为 md）\n",
      },
    ),
  );
  cases.push(
    mcase(
      "show-md-grandchild-subagents",
      ["show", CHILD_ID, ...healthyBase(), "--subagents"],
      "md",
      null,
      0,
    ),
    mcase(
      "show-md-explicit-format",
      ["show", MAIN_ID, ...healthyBase(), "--format", "md"],
      "md",
      null,
      0,
    ),
    mcase(
      "show-md-main-subagents-headers",
      ["show", MAIN_ID, ...healthyBase(), "--subagents", "--headers"],
      "md",
      null,
      0,
    ),
    mcase("show-md-default-lib-anchor", ["show", MAIN_ID, "--dsh-home", "HEALTHY"], "md", null, 0),
    mcase(
      "show-md-truncate-1-header",
      ["show", MAIN_ID, ...healthyBase(), "--truncate", "1", "--headers"],
      "md",
      null,
      0,
    ),
  );
  for (let index = 0; index < 4; index += 1) {
    const args = ["show", MAIN_ID, ...healthyBase(), "--format", "json"];
    if (index % 2 === 0) args.push("--summary");
    if (index >= 2) args.push("--subagents");
    cases.push(mcase(`show-json-${index}`, args, "json", "show", 0));
  }
  cases.push(
    mcase(
      "show-jsonl-main",
      ["show", MAIN_ID, ...healthyBase(), "--format", "jsonl"],
      "jsonl",
      "jsonl",
      0,
    ),
    mcase(
      "show-jsonl-child",
      ["show", CHILD_ID, ...healthyBase(), "--format", "jsonl"],
      "jsonl",
      "jsonl",
      0,
    ),
    mcase(
      "err-show-json-thinking",
      ["show", MAIN_ID, ...healthyBase(), "--format", "json", "--thinking"],
      "none",
      null,
      2,
      {
        expectStderr:
          "错误: 参数无效（呈现类开关 --thinking 仅 md 可用；去掉 --thinking，或把 --format 改为 md）\n",
      },
    ),
    mcase(
      "err-show-jsonl-summary",
      ["show", MAIN_ID, ...healthyBase(), "--format", "jsonl", "--summary"],
      "none",
      null,
      2,
      {
        expectStderr:
          "错误: 参数无效（--summary 不能与 --format jsonl 同时使用；去掉 --summary，或把 --format 改为 json）\n",
      },
    ),
    mcase(
      "err-show-jsonl-subagents",
      ["show", MAIN_ID, ...healthyBase(), "--format", "jsonl", "--subagents"],
      "none",
      null,
      2,
      {
        expectStderr:
          "错误: 参数无效（--subagents 不能与 --format jsonl 同时使用；去掉 --subagents，或把 --format 改为 json）\n",
      },
    ),
    mcase("err-show-missing-target", ["show", "zzzzzzzz", ...healthyBase()], "none", null, 1, {
      expectStderr: "错误: 目标不存在\n",
    }),
    mcase("err-show-short-prefix", ["show", "adv", ...healthyBase()], "none", null, 2, {
      expectStderr: "错误: 参数无效（会话前缀至少 8 个字符）\n",
    }),
    mcase(
      "err-show-ambiguous-prefix",
      ["show", "session-adv-", ...healthyBase()],
      "none",
      null,
      1,
      { expectStderr: `错误: 目标不存在（候选 ${HEALTHY_SESSION_COUNT} 个）\n` },
    ),
  );
  return cases;
}

function searchCases(): MatrixCase[] {
  const cases: MatrixCase[] = [];
  const keywords = ["needle", "example.com", "<script>", "$ echo", "zzznomatch"] as const;
  const scopes = ["text", "tools", "all"] as const;
  for (let index = 0; index < 12; index += 1) {
    const args = ["search", keywords[index % 5], ...healthyBase()];
    args.push("--scope", scopes[index % 3]);
    if (index % 2 === 1) args.push("--case-sensitive");
    const origin = ORIGINS[index % 3];
    if (origin !== "all") args.push("--origin", origin);
    args.push("--context", String([0, 60][index % 2]));
    args.push("--limit", String([0, 1][index % 2]));
    cases.push(mcase(`search-md-${index}`, args, "md", null, 0));
  }
  cases.push(
    mcase(
      "search-md-workspace-filter",
      ["search", "needle", ...healthyBase(), "--workspace", "user_projects"],
      "md",
      null,
      0,
    ),
    mcase(
      "search-md-since-filter",
      ["search", "needle", ...healthyBase(), "--since", "0", "--until", "9999999999999"],
      "md",
      null,
      0,
    ),
    mcase(
      "search-md-zero-hit",
      ["search", "zzznomatch", ...healthyBase(), "--scope", "all"],
      "md",
      null,
      0,
    ),
    mcase(
      "search-md-case-sensitive-zero",
      ["search", "NEEDLE", ...healthyBase(), "--case-sensitive"],
      "md",
      null,
      0,
    ),
    mcase(
      "search-md-dash-keyword",
      ["search", "--scope", "all", ...healthyBase(), "--", "- item"],
      "md",
      null,
      0,
    ),
    mcase(
      "search-md-dash-keyword-context",
      ["search", "--context", "0", ...healthyBase(), "--", "--fix"],
      "md",
      null,
      0,
    ),
  );
  for (let index = 0; index < 4; index += 1) {
    const args = [
      "search",
      ["needle", "example.com"][index % 2],
      ...healthyBase(),
      "--format",
      "json",
    ];
    args.push("--scope", scopes[index % 3], "--limit", ["1", "0"][index % 2]);
    cases.push(mcase(`search-json-${index}`, args, "json", "search", 0));
  }
  // --session 限定：主会话自身与子树、子代理自身、前缀形态、以及无匹配路径。
  cases.push(
    mcase(
      "search-md-session-main",
      ["search", "needle", ...healthyBase(), "--scope", "all", "--session", MAIN_ID],
      "md",
      null,
      0,
    ),
    mcase(
      "search-md-session-child",
      ["search", "needle", ...healthyBase(), "--scope", "all", "--session", CHILD_ID],
      "md",
      null,
      0,
    ),
    mcase(
      "search-md-session-prefix",
      ["search", "needle", ...healthyBase(), "--session", "adv-main"],
      "md",
      null,
      0,
    ),
    mcase(
      "search-md-session-last",
      ["search", "needle", ...healthyBase(), "--session", "last"],
      "md",
      null,
      0,
    ),
    mcase(
      "search-md-session-with-workspace",
      [
        "search",
        "needle",
        ...healthyBase(),
        "--session",
        MAIN_ID,
        "--workspace",
        "user_projects",
        "--since",
        "0",
      ],
      "md",
      null,
      0,
    ),
    mcase(
      "search-json-session",
      ["search", "needle", ...healthyBase(), "--session", MAIN_ID, "--format", "json"],
      "json",
      "search",
      0,
    ),
    mcase(
      "err-search-session-unknown",
      ["search", "needle", ...healthyBase(), "--session", "zzzzzzzz"],
      "none",
      null,
      1,
      { expectStderr: "错误: 目标不存在\n" },
    ),
    mcase(
      "err-search-session-short-prefix",
      ["search", "needle", ...healthyBase(), "--session", "adv"],
      "none",
      null,
      2,
      { expectStderr: "错误: 参数无效（会话前缀至少 8 个字符）\n" },
    ),
  );
  cases.push(
    mcase("err-search-missing-keyword", ["search", ...healthyBase()], "none", null, 2, {
      expectStderr: "错误: 参数无效（缺少位置参数: <关键词>）\n",
    }),
    mcase(
      "err-search-bad-scope",
      ["search", "needle", ...healthyBase(), "--scope", "bad"],
      "none",
      null,
      2,
      { expectStderr: "错误: 参数无效（选项值无效: --scope）\n" },
    ),
    mcase(
      "err-search-dash-without-terminator",
      ["search", "- item", ...healthyBase()],
      "none",
      null,
      2,
      { expectStderr: "错误: 参数无效（未知选项: - item）\n" },
    ),
    mcase(
      "err-search-unknown-target",
      ["search", "needle", "--dsh-home", "NO_SUCH_HOME", "--lib-root", LIB_ROOT],
      "none",
      null,
      1,
      { expectStderr: "错误: 目标不存在\n" },
    ),
  );
  return cases;
}

function statsCases(): MatrixCase[] {
  const cases: MatrixCase[] = [];
  for (let index = 0; index < 3; index += 1) {
    cases.push(
      mcase(
        `stats-md-global-${index}`,
        ["stats", ...healthyBase(), "--origin", ORIGINS[index]],
        "md",
        null,
        0,
      ),
    );
  }
  cases.push(
    mcase(
      "stats-md-global-workspace",
      ["stats", ...healthyBase(), "--workspace", "user_projects"],
      "md",
      null,
      0,
    ),
    mcase(
      "stats-md-global-zero",
      ["stats", ...healthyBase(), "--since", "9999999999999"],
      "md",
      null,
      0,
    ),
    mcase("stats-md-single-main", ["stats", MAIN_ID, ...healthyBase()], "md", null, 0),
    mcase("stats-md-single-child", ["stats", CHILD_ID, ...healthyBase()], "md", null, 0),
    mcase("stats-md-single-prefix", ["stats", "adv-main", ...healthyBase()], "md", null, 0),
    mcase(
      "stats-md-single-nopc",
      ["stats", "session-adv-nopc-10", ...healthyBase()],
      "md",
      null,
      0,
    ),
    mcase(
      "stats-md-single-pcpart",
      ["stats", "session-adv-pcpart-13", ...healthyBase()],
      "md",
      null,
      0,
    ),
  );
  cases.push(
    mcase("stats-json-global", ["stats", ...healthyBase(), "--format", "json"], "json", "stats", 0),
    mcase(
      "stats-json-global-origin",
      ["stats", ...healthyBase(), "--origin", "subagent", "--format", "json"],
      "json",
      "stats",
      0,
    ),
    mcase(
      "stats-json-single",
      ["stats", MAIN_ID, ...healthyBase(), "--format", "json"],
      "json",
      "stats",
      0,
    ),
    mcase(
      "stats-json-single-pcver",
      ["stats", "session-adv-pcver-11", ...healthyBase(), "--format", "json"],
      "json",
      "stats",
      0,
    ),
  );
  cases.push(
    mcase("err-stats-unknown-target", ["stats", "zzzzzzzz", ...healthyBase()], "none", null, 1, {
      expectStderr: "错误: 目标不存在\n",
    }),
    mcase(
      "err-stats-single-filter-since",
      ["stats", MAIN_ID, ...healthyBase(), "--since", "0"],
      "none",
      null,
      2,
      {
        expectStderr:
          "错误: 参数无效（单会话统计不接受范围过滤选项 --since；去掉 --since，或去掉会话目标改用全局聚合）\n",
      },
    ),
    mcase(
      "err-stats-single-filter-origin",
      ["stats", MAIN_ID, ...healthyBase(), "--origin", "main"],
      "none",
      null,
      2,
      {
        expectStderr:
          "错误: 参数无效（单会话统计不接受范围过滤选项 --origin；去掉 --origin，或去掉会话目标改用全局聚合）\n",
      },
    ),
    mcase(
      "err-stats-single-filter-workspace",
      ["stats", MAIN_ID, ...healthyBase(), "--workspace", "user_projects"],
      "none",
      null,
      2,
      {
        expectStderr:
          "错误: 参数无效（单会话统计不接受范围过滤选项 --workspace；去掉 --workspace，或去掉会话目标改用全局聚合）\n",
      },
    ),
  );
  return cases;
}

function checkCases(): MatrixCase[] {
  return [
    mcase("check-md-healthy", ["check", ...healthyBase()], "md", null, 0),
    mcase("check-md-single-main", ["check", MAIN_ID, ...healthyBase()], "md", null, 0),
    mcase(
      "check-md-single-nopc",
      ["check", "session-adv-nopc-10", ...healthyBase()],
      "md",
      null,
      0,
    ),
    mcase(
      "check-md-broken",
      ["check", "--dsh-home", "BROKEN", "--lib-root", LIB_ROOT],
      "md",
      null,
      3,
    ),
    mcase(
      "check-md-broken-torn",
      ["check", "session-brk-torn-14", "--dsh-home", "BROKEN", "--lib-root", LIB_ROOT],
      "md",
      null,
      3,
    ),
    mcase(
      "check-json-broken",
      ["check", "--dsh-home", "BROKEN", "--lib-root", LIB_ROOT, "--format", "json"],
      "json",
      "check",
      3,
    ),
    mcase(
      "show-md-broken-torn",
      ["show", "session-brk-torn-14", "--dsh-home", "BROKEN", "--lib-root", LIB_ROOT],
      "md",
      null,
      0,
    ),
    mcase(
      "err-show-broken-gap",
      ["show", "session-brk-gap-15", "--dsh-home", "BROKEN", "--lib-root", LIB_ROOT],
      "none",
      null,
      3,
      { expectStderr: "错误: 数据不可读\n" },
    ),
    mcase(
      "err-show-broken-corrupt",
      ["show", "session-brk-corrupt-16", "--dsh-home", "BROKEN", "--lib-root", LIB_ROOT],
      "none",
      null,
      3,
      // P7 根因修复：会话目录存在于磁盘上、只是 header 不可读，必须与"确实不存在"可区分
      // （后者退出 1）。二者此前都落到"目标不存在"，使全量扫描误判为漏读。
      { expectStderr: "错误: 数据不可读\n" },
    ),
    mcase(
      "err-show-broken-corrupt-unknown",
      ["show", "session-brk-zzzz", "--dsh-home", "BROKEN", "--lib-root", LIB_ROOT],
      "none",
      null,
      1,
      { expectStderr: "错误: 目标不存在\n" },
    ),
    mcase(
      "list-md-broken-tolerant",
      ["list", "--dsh-home", "BROKEN", "--lib-root", LIB_ROOT],
      "md",
      null,
      0,
    ),
  ];
}

// ------------------------- 结构白名单（手写解析） -------------------------

const HEADING_WHITELIST =
  /^(会话列表|会话列表（完整）|会话记录|检索结果|统计|完整性校验|时间线|轮次大纲|子代理 \d+(\.\d+)*)$/u;
const FENCE_OPEN = /^(`{3,})text$/u;
const FENCE_CLOSE = /^(`{3,})$/u;
const MARKERS = [
  "<script>alert(1)</script>",
  "https://example.com/path",
  "**bold text**",
  "$ echo hello",
  "a@b.com",
] as const;

/**
 * 跨行标记：含换行的敌意内容（如 CR/CRLF 归一化后的 `line1\nline2`）无法按单行匹配，
 * 必须在整份产物上判定。其"是否被归一化"由 `checkMarkdownStructure` 的 CR 检查单独兜住。
 */
const MULTILINE_MARKERS = ["line1\nline2"] as const;

interface HeadingNode {
  readonly level: number;
  readonly text: string;
  readonly children: HeadingNode[];
}

/** 行内代码跨度的可覆盖区间（按反引号串长度配对）。 */
function codeSpanRanges(line: string): ReadonlyArray<readonly [number, number]> {
  const ranges: Array<[number, number]> = [];
  const runs: Array<{ readonly start: number; readonly length: number }> = [];
  const pattern = /`+/gu;
  for (const match of line.matchAll(pattern)) {
    runs.push({ start: match.index, length: match[0].length });
  }
  let open: { readonly start: number; readonly length: number } | null = null;
  for (const run of runs) {
    if (open === null) {
      open = run;
    } else if (open.length === run.length) {
      ranges.push([open.start, run.start + run.length]);
      open = null;
    }
  }
  return ranges;
}

function inRanges(
  ranges: ReadonlyArray<readonly [number, number]>,
  start: number,
  length: number,
): boolean {
  return ranges.some(([from, to]) => start >= from && start + length <= to);
}

/** 扫描行内敌意标记：围栏内只登记出现（载体本身就是围栏）；围栏外必须处于行内代码跨度内。 */
function collectMarkers(
  caseId: string,
  line: string,
  ranges: ReadonlyArray<readonly [number, number]> | null,
  problems: string[],
  markersSeen: Set<string>,
): void {
  for (const marker of MARKERS) {
    let from = 0;
    for (;;) {
      const at = line.indexOf(marker, from);
      if (at === -1) break;
      markersSeen.add(marker);
      if (ranges !== null && !inRanges(ranges, at, marker.length)) {
        problems.push(`${caseId}: 数据标记未处于代码载体: ${marker}`);
      }
      from = at + 1;
    }
  }
}

/** 结构白名单断言（md 产物）：行/空行纪律、标题词表与同级唯一、围栏闭合、载体覆盖、无制表符/CR。 */
function checkMarkdownStructure(
  caseId: string,
  content: string,
  problems: string[],
  markersSeen: Set<string>,
  multiLineMarkersSeen: Set<string>,
): void {
  const fail = (message: string): void => {
    problems.push(`${caseId}: ${message}`);
  };
  if (content.length === 0) {
    fail("产物为空");
    return;
  }
  for (const marker of MULTILINE_MARKERS) {
    if (content.includes(marker)) multiLineMarkersSeen.add(marker);
  }
  if (content.includes("\uFEFF")) fail("含 BOM");
  if (content.includes("\t")) fail("含制表符（应已归一化为空格）");
  // 输出契约要求 LF-only：CR 会被 markdownlint 忽略，因此必须在此单独拦截，
  // 否则正文携带的 CR 会静默破坏"UTF-8 无 BOM、LF"这一契约。
  if (content.includes("\r")) fail("含 CR 字节（CR/CRLF 应已归一化为 LF）");
  if (!content.endsWith("\n")) fail("末尾缺少换行");
  if (content.endsWith("\n\n")) fail("末尾多余空行");
  const lines = content.split("\n");
  if (lines[lines.length - 1] !== "") {
    fail("结尾异常");
    return;
  }
  const body = lines.slice(0, -1);
  const root: HeadingNode = { level: 0, text: "", children: [] };
  const stack: HeadingNode[] = [root];
  let headingCount = 1;
  let fence: number | null = null;
  for (let index = 0; index < body.length; index += 1) {
    const line = body[index];
    if (fence !== null) {
      // 围栏内的内容已被 render 层归一化（CR → LF、制表符 → 空格），标记只登记不检查载体。
      collectMarkers(caseId, line, null, problems, markersSeen);
      const close = FENCE_CLOSE.exec(line);
      if (close !== null && close[1].length >= fence) {
        if (index + 1 < body.length && body[index + 1] !== "") {
          fail(`围栏闭合后缺少空行（行 ${index + 1}）`);
        }
        fence = null;
      }
      continue;
    }
    if (line.endsWith("\r")) fail(`结构行含 CR（行 ${index + 1}）`);
    if (line === "" && index > 0 && body[index - 1] === "") {
      fail(`连续空行（行 ${index + 1}）`);
    }
    const open = FENCE_OPEN.exec(line);
    if (open !== null) {
      if (index > 0 && body[index - 1] !== "") fail(`围栏前缺少空行（行 ${index + 1}）`);
      fence = open[1].length;
      continue;
    }
    if (FENCE_CLOSE.test(line)) fail(`孤立围栏行（行 ${index + 1}）`);
    const heading = /^(#{1,6}) (.+)$/u.exec(line);
    if (heading !== null) {
      const level = heading[1].length;
      const text = heading[2];
      if (!HEADING_WHITELIST.test(text)) fail(`标题不在词表: ${text}`);
      if (level === 1) headingCount += 1;
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
      const parent = stack[stack.length - 1];
      if (parent.children.some((child) => child.text === text)) {
        fail(`同级重复标题: ${text}`);
      }
      const node: HeadingNode = { level, text, children: [] };
      parent.children.push(node);
      stack.push(node);
      continue;
    }
    const next = index + 1 < body.length ? body[index + 1] : "";
    const previous = index > 0 ? body[index - 1] : "";
    const listLine = line.startsWith("- ") || line.startsWith("  ");
    const tableLine = line.startsWith("|");
    const previousIsList = previous.startsWith("- ") || previous.startsWith("  ");
    const previousIsTable = previous.startsWith("|");
    const nextIsList = next.startsWith("- ") || next.startsWith("  ");
    const nextIsTable = next.startsWith("|");
    if (listLine && !previousIsList && previous !== "") {
      fail(`列表块前缺少空行（行 ${index + 1}）`);
    }
    if (listLine && !nextIsList && next !== "") {
      fail(`列表块后缺少空行（行 ${index + 1}）`);
    }
    if (tableLine && !previousIsTable && previous !== "") {
      fail(`表格块前缺少空行（行 ${index + 1}）`);
    }
    if (tableLine && !nextIsTable && next !== "") {
      fail(`表格块后缺少空行（行 ${index + 1}）`);
    }
    const ranges = codeSpanRanges(line);
    collectMarkers(caseId, line, ranges, problems, markersSeen);
  }
  if (fence !== null) fail("围栏未闭合");
  if (headingCount !== 2) fail(`H1 数量异常（期望 1，实际 ${headingCount - 1}）`);
}

// ------------------------- JSON / JSONL 回归 -------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function requireKeys(
  caseId: string,
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
  problems: string[],
): boolean {
  if (record === undefined) {
    problems.push(`${caseId}: JSON 结构不是对象`);
    return false;
  }
  for (const key of keys) {
    if (!(key in record)) {
      problems.push(`${caseId}: JSON 缺少字段 ${key}`);
      return false;
    }
  }
  return true;
}

function checkJsonStructure(
  caseId: string,
  shape: JsonShape,
  content: string,
  problems: string[],
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    problems.push(`${caseId}: JSON 解析失败 ${String(error)}`);
    return;
  }
  const record = asRecord(parsed);
  if (shape === "list") {
    if (!requireKeys(caseId, record, ["sessions", "coverage"], problems)) return;
    const sessions = record?.sessions;
    if (!Array.isArray(sessions)) {
      problems.push(`${caseId}: sessions 不是数组`);
      return;
    }
    const first = asRecord(sessions[0]);
    if (sessions.length > 0) {
      requireKeys(
        caseId,
        first,
        [
          "id",
          "type",
          "title",
          "cwd",
          "workspaceTitle",
          "createdAt",
          "lastActivityAt",
          "lastPromptAt",
          "turns",
          "steps",
          "blank",
          "agentPreset",
          "model",
          "tokens",
          "sizeBytes",
          "metadata",
        ],
        problems,
      );
      if (first?.shortId !== undefined) {
        problems.push(`${caseId}: 列表项不应再输出截断的 shortId（显示值必须与可传值同源）`);
      }
    }
    checkCoverage(caseId, record?.coverage, problems);
  } else if (shape === "show") {
    if (
      !requireKeys(caseId, record, ["session", "meta", "turns", "messages", "subagents"], problems)
    ) {
      return;
    }
    const session = asRecord(record?.session);
    if (typeof session?.id !== "string") problems.push(`${caseId}: session.id 缺失`);
  } else if (shape === "search") {
    if (
      !requireKeys(
        caseId,
        record,
        ["matches", "total", "truncated", "scope", "totalIsExact"],
        problems,
      )
    ) {
      return;
    }
    if (typeof record?.truncated !== "boolean") problems.push(`${caseId}: truncated 不是布尔`);
    if (record?.totalIsExact !== true) {
      problems.push(`${caseId}: totalIsExact 必须为 true（命中总数与 --limit 解耦）`);
    }
    checkCoverage(caseId, record?.coverage, problems);
  } else if (shape === "stats") {
    const kind = record?.kind;
    if (kind === "global") {
      if (typeof record?.sessionCount !== "number") problems.push(`${caseId}: sessionCount 缺失`);
    } else if (kind === "single") {
      const session = asRecord(record?.session);
      if (typeof session?.id !== "string") problems.push(`${caseId}: single.session.id 缺失`);
    } else {
      problems.push(`${caseId}: stats.kind 非法`);
    }
    checkCoverage(caseId, record?.coverage, problems);
  } else if (shape === "check") {
    if (!requireKeys(caseId, record, ["sessions", "anomalyCount", "coverage"], problems)) return;
    if (!Array.isArray(record?.sessions)) problems.push(`${caseId}: sessions 不是数组`);
    checkCoverage(caseId, record?.coverage, problems);
  }
}

/** 覆盖声明结构断言：scannedCount = includedCount + excluded.length，且排除项含 id 与 reason。 */
function checkCoverage(caseId: string, value: unknown, problems: string[]): void {
  const coverage = asRecord(value);
  if (coverage === undefined) {
    problems.push(`${caseId}: coverage 缺失`);
    return;
  }
  const scanned = coverage.scannedCount;
  const included = coverage.includedCount;
  const excluded = coverage.excluded;
  if (typeof scanned !== "number" || typeof included !== "number" || !Array.isArray(excluded)) {
    problems.push(`${caseId}: coverage 字段类型非法`);
    return;
  }
  if (scanned !== included + excluded.length) {
    problems.push(
      `${caseId}: coverage 恒等式不成立（scanned ${scanned} != included ${included} + excluded ${excluded.length}）`,
    );
  }
  for (const item of excluded) {
    const entry = asRecord(item);
    if (typeof entry?.id !== "string" || typeof entry?.reason !== "string") {
      problems.push(`${caseId}: coverage.excluded 项缺少 id/reason`);
    }
  }
}

function checkJsonlStructure(caseId: string, content: string, problems: string[]): void {
  const lines = content.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) {
    problems.push(`${caseId}: JSONL 为空`);
    return;
  }
  lines.forEach((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      problems.push(`${caseId}: JSONL 第 ${index + 1} 行解析失败 ${String(error)}`);
      return;
    }
    const record = asRecord(parsed);
    if (record === undefined) {
      problems.push(`${caseId}: JSONL 第 ${index + 1} 行不是对象`);
      return;
    }
    if (index === 0) {
      if (typeof record.id !== "string") problems.push(`${caseId}: JSONL 首行缺少 id`);
      if (record.type !== undefined) problems.push(`${caseId}: JSONL 首行不应有 type`);
    } else {
      if (typeof record.type !== "string")
        problems.push(`${caseId}: JSONL 第 ${index + 1} 行缺少 type`);
      if (typeof record.seq !== "number")
        problems.push(`${caseId}: JSONL 第 ${index + 1} 行缺少 seq`);
    }
  });
}

// ------------------------- 执行与断言 -------------------------

interface CaseResult {
  readonly id: string;
  readonly args: string[];
  readonly exit: number | null;
  readonly outputPath: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface MatrixContext {
  readonly workdir: string;
  readonly outDir: string;
  readonly problems: string[];
  readonly results: CaseResult[];
  readonly markersSeen: Set<string>;
  readonly multiLineMarkersSeen: Set<string>;
  readonly homes: Map<string, string>;
}

function runRaw(args: readonly string[]): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError: string | null;
} {
  const result = spawnSync(process.execPath, [SESSION_READER, ...args], {
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    spawnError: result.error === undefined ? null : String(result.error),
  };
}

/** 追加 --output-dir 时尊重选项终止符：必须插在 `--` 之前，否则会被当作位置参数。 */
function withOutputDir(args: readonly string[], outDir: string): string[] {
  const terminatorAt = args.indexOf("--");
  if (terminatorAt === -1) return [...args, "--output-dir", outDir];
  return [...args.slice(0, terminatorAt), "--output-dir", outDir, ...args.slice(terminatorAt)];
}

function parseContract(
  caseId: string,
  stdout: string,
  problems: string[],
): { readonly path: string; readonly lines: number } | null {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  if (lines.length !== 2) {
    problems.push(`${caseId}: stdout 非两行契约: ${JSON.stringify(stdout)}`);
    return null;
  }
  const pathMatch = /^完整输出已保存到: (.+)$/u.exec(lines[0]);
  const summaryMatch = /^(.+)；输出文件共 (\d+) 行$/u.exec(lines[1]);
  if (pathMatch === null || summaryMatch === null) {
    problems.push(`${caseId}: stdout 契约行格式错误: ${JSON.stringify(stdout)}`);
    return null;
  }
  return { path: pathMatch[1], lines: Number(summaryMatch[2]) };
}

function executeCase(ctx: MatrixContext, item: MatrixCase): void {
  const resolved = item.args.map((arg) => ctx.homes.get(arg) ?? arg);
  const args = item.omitOutputDir ? resolved : withOutputDir(resolved, ctx.outDir);
  const outDir = ctx.outDir;
  const before = readdirSync(outDir).length;
  const raw = runRaw(args);
  const result: CaseResult = {
    id: item.id,
    args,
    exit: raw.status,
    outputPath: null,
    stdout: raw.stdout,
    stderr: raw.stderr,
  };
  if (raw.spawnError !== null) {
    ctx.problems.push(`${item.id}: 子进程启动失败 ${raw.spawnError}`);
    ctx.results.push(result);
    return;
  }
  if (raw.status !== item.expectExit) {
    ctx.problems.push(
      `${item.id}: 退出码 ${String(raw.status)} ≠ 期望 ${item.expectExit}（stderr=${JSON.stringify(raw.stderr)}）`,
    );
  }
  if (!item.expectOutput) {
    if (raw.stdout !== "")
      ctx.problems.push(`${item.id}: 错误路径不应有 stdout: ${JSON.stringify(raw.stdout)}`);
    if (raw.stderr !== item.expectStderr) {
      ctx.problems.push(
        `${item.id}: stderr 与期望全文不一致（实际=${JSON.stringify(raw.stderr)} 期望=${JSON.stringify(item.expectStderr)}）`,
      );
    }
    const after = readdirSync(outDir).length;
    if (after !== before) ctx.problems.push(`${item.id}: 错误路径不应产生输出文件`);
    ctx.results.push(result);
    return;
  }
  if (raw.stderr !== "") {
    ctx.problems.push(`${item.id}: 成功路径不应有 stderr: ${JSON.stringify(raw.stderr)}`);
  }
  const contract = parseContract(item.id, raw.stdout, ctx.problems);
  if (contract === null) {
    ctx.results.push(result);
    return;
  }
  if (!existsSync(contract.path)) {
    ctx.problems.push(`${item.id}: 输出文件不存在: ${contract.path}`);
    ctx.results.push(result);
    return;
  }
  const content = readFileSync(contract.path, "utf8");
  const actualLines = countLines(content);
  if (actualLines !== contract.lines) {
    ctx.problems.push(
      `${item.id}: 行数契约不一致（文件 ${actualLines} ≠ stdout ${contract.lines}）`,
    );
  }
  const updated: CaseResult = { ...result, outputPath: contract.path };
  ctx.results.push(updated);
  if (item.kind === "md")
    checkMarkdownStructure(
      item.id,
      content,
      ctx.problems,
      ctx.markersSeen,
      ctx.multiLineMarkersSeen,
    );
  else if (item.kind === "json") checkJsonStructure(item.id, item.shape, content, ctx.problems);
  else if (item.kind === "jsonl") checkJsonlStructure(item.id, content, ctx.problems);
}

// ------------------------- 参数与主流程 -------------------------

interface MatrixOptions {
  readonly workdir: string;
  readonly lintConfig: string;
  readonly markdownlintJs: string | null;
  readonly realHome: string;
  readonly skipReal: boolean;
}

function parseOptions(argv: readonly string[]): MatrixOptions | null {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--skip-real") {
      values.set(token, "true");
      continue;
    }
    if (
      token === "--workdir" ||
      token === "--lint-config" ||
      token === "--markdownlint-js" ||
      token === "--real-home"
    ) {
      const value = argv[index + 1];
      if (value === undefined) return null;
      values.set(token, value);
      index += 1;
      continue;
    }
    return null;
  }
  const workdir = values.get("--workdir");
  if (workdir === undefined) return null;
  const markdownlintJs = values.get("--markdownlint-js");
  return {
    workdir: resolve(workdir),
    lintConfig: resolve(values.get("--lint-config") ?? DEFAULT_LINT_CONFIG),
    markdownlintJs: markdownlintJs === undefined ? null : resolve(markdownlintJs),
    realHome: resolve(values.get("--real-home") ?? join(homedir(), ".dsh")),
    skipReal: values.get("--skip-real") === "true",
  };
}

/** 解析 markdownlint-cli 的 JS 入口：显式参数优先；否则从 workdir 的 node_modules 链解析（失败即显式报错）。 */
function resolveMarkdownlintJs(options: MatrixOptions): string {
  if (options.markdownlintJs !== null) return options.markdownlintJs;
  const requireFromWorkdir = createRequire(join(options.workdir, "matrix-anchor.cjs"));
  let packageJson: string;
  try {
    packageJson = requireFromWorkdir.resolve("markdownlint-cli/package.json");
  } catch (error) {
    throw new Error(
      `无法从 ${options.workdir} 解析 markdownlint-cli（${String(error)}）；请用 --markdownlint-js <路径> 显式指定`,
    );
  }
  return join(dirname(packageJson), "markdownlint.js");
}

interface LintRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly mdFiles: number;
  readonly processedFiles: number;
  readonly batches: number;
}

const LINT_BATCH_SIZE = 50;

/** 确定性复跑产生的额外 md 产物数（list 与 show 各跑两次）。 */
const DETERMINISM_MD_ARTIFACTS = 4;

/**
 * 以参数数组直接调用 markdownlint JS 入口（不经 shell，避免 cmd 引号拼接问题）。
 * 两遍：① 目录整跑（目录展开语义）；② 显式文件分批（给出"实际处理文件数"，并逐批断言成功）。
 */
function runLint(
  markdownlintJs: string,
  lintConfig: string,
  outDir: string,
  workdir: string,
): LintRunResult {
  if (!existsSync(markdownlintJs)) throw new Error(`markdownlint 入口不存在: ${markdownlintJs}`);
  const run = (
    files: readonly string[],
  ): { readonly status: number | null; readonly stdout: string; readonly stderr: string } => {
    const result = spawnSync(process.execPath, [markdownlintJs, "--config", lintConfig, ...files], {
      encoding: "utf8",
      timeout: 600_000,
      // 以被 lint 目录为工作目录：避免 .markdownlintignore 的相对路径匹配在跨根路径上报错，
      // 该次门禁的对象就是 outDir 内的产物本身。
      cwd: outDir,
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  const directory = run([outDir]);
  const mdFiles = readdirSync(outDir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  let stdout = directory.stdout;
  let stderr = directory.stderr;
  let status = directory.status;
  let processedFiles = 0;
  let batches = 0;
  for (let start = 0; start < mdFiles.length; start += LINT_BATCH_SIZE) {
    const batch = mdFiles.slice(start, start + LINT_BATCH_SIZE);
    const result = run(batch);
    batches += 1;
    processedFiles += batch.length;
    stdout += result.stdout;
    stderr += result.stderr;
    if (result.status !== 0 && (status === 0 || status === null)) status = result.status;
  }
  writeFileSync(join(workdir, "lint-output.txt"), `${stdout}${stderr}`, "utf8");
  return { status, stdout, stderr, mdFiles: mdFiles.length, processedFiles, batches };
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseOptions(argv);
  if (options === null) {
    process.stderr.write(
      "用法: node tests/lint-matrix.ts --workdir <目录> [--lint-config <配置>] [--markdownlint-js <入口>] [--real-home <dsh 主目录>] [--skip-real]\n",
    );
    return 2;
  }
  for (const [label, path] of [
    ["官方格式库锚点", join(LIB_ROOT, "@deepseek-ai", "dsh-session-format-catalog")],
    ["lint 配置", options.lintConfig],
  ] as const) {
    if (!existsSync(path)) throw new Error(`${label}不存在: ${path}`);
  }
  if (!options.skipReal && !existsSync(options.realHome)) {
    throw new Error(`真实 dsh 主目录不存在: ${options.realHome}`);
  }
  const healthyHome = join(options.workdir, "fixture-healthy");
  const brokenHome = join(options.workdir, "fixture-broken");
  const outDir = join(options.workdir, "out");
  for (const path of [
    healthyHome,
    brokenHome,
    outDir,
    join(options.workdir, "lint-output.txt"),
    join(options.workdir, "matrix-summary.json"),
  ]) {
    rmSync(path, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });
  writeFixtureHome(healthyHome, healthySpec());
  writeFixtureHome(brokenHome, brokenSpec());
  const fixtureLibParent = join(healthyHome, "profiles", "node_modules", "@deepseek-ai");
  mkdirSync(fixtureLibParent, { recursive: true });
  symlinkSync(
    join(LIB_ROOT, "@deepseek-ai", "dsh-session-format-catalog"),
    join(fixtureLibParent, "dsh-session-format-catalog"),
    "junction",
  );
  patchProjCacheModel(healthyHome, MAIN_ID);
  patchProjCacheModel(healthyHome, CHILD_ID);

  const ctx: MatrixContext = {
    workdir: options.workdir,
    outDir,
    problems: [],
    results: [],
    markersSeen: new Set<string>(),
    multiLineMarkersSeen: new Set<string>(),
    homes: new Map([
      ["HEALTHY", healthyHome],
      ["BROKEN", brokenHome],
      ["NO_SUCH_HOME", join(options.workdir, "no-such-home")],
    ]),
  };

  const staticCases: MatrixCase[] = [
    ...listCases(),
    ...showCases(),
    ...searchCases(),
    ...statsCases(),
    ...checkCases(),
  ];
  for (const item of staticCases) {
    executeCase(ctx, item);
  }

  if (!options.skipReal) {
    await runRealCases(ctx, options);
  }

  // 确定性：同一输入两次渲染（文件名除外）逐字节一致。
  // 两个命令各跑两次，因此 out 目录内会多出 4 个 md 产物；该数量由下面的常量与断言共同约束。
  const listArgs = [
    "list",
    "--dsh-home",
    healthyHome,
    "--lib-root",
    LIB_ROOT,
    "--output-dir",
    outDir,
  ];
  const firstList = runRaw(listArgs);
  const secondList = runRaw(listArgs);
  compareDeterministic(
    "determinism-list",
    firstList.stdout,
    secondList.stdout,
    outDir,
    ctx.problems,
  );
  const showArgs = [
    "show",
    MAIN_ID,
    "--dsh-home",
    healthyHome,
    "--lib-root",
    LIB_ROOT,
    "--output-dir",
    outDir,
  ];
  const firstShow = runRaw(showArgs);
  const secondShow = runRaw(showArgs);
  compareDeterministic(
    "determinism-show",
    firstShow.stdout,
    secondShow.stdout,
    outDir,
    ctx.problems,
  );

  // md 产物 lint：目录整跑 + 显式文件分批（后者给出实际处理文件数）。
  const markdownlintJs = resolveMarkdownlintJs(options);
  const lint = runLint(markdownlintJs, options.lintConfig, outDir, options.workdir);
  if (lint.status !== 0) {
    ctx.problems.push(`markdownlint 退出码 ${String(lint.status)}`);
    const detail = `${lint.stdout}${lint.stderr}`.trim().split("\n").slice(0, 60).join("\n");
    if (detail.length > 0) ctx.problems.push(`markdownlint 输出（截断 60 行）:\n${detail}`);
  }
  if (lint.stdout.trim() !== "" || lint.stderr.trim() !== "") {
    ctx.problems.push("markdownlint 输出非空（要求无 stdout/stderr）");
  }

  const mdCount = ctx.results.filter((entry) => entry.outputPath?.endsWith(".md") === true).length;
  const jsonCount = ctx.results.filter(
    (entry) => entry.outputPath?.endsWith(".json") === true,
  ).length;
  const jsonlCount = ctx.results.filter(
    (entry) => entry.outputPath?.endsWith(".jsonl") === true,
  ).length;
  // 实际处理文件数断言：out 内 md = 用例 md 产物 + 确定性复跑产物；且显式分批覆盖全部文件。
  if (lint.mdFiles !== mdCount + DETERMINISM_MD_ARTIFACTS) {
    ctx.problems.push(
      `out 内 md 文件数 ${lint.mdFiles} ≠ 用例 md ${mdCount} + 确定性 ${DETERMINISM_MD_ARTIFACTS}`,
    );
  }
  if (lint.processedFiles !== lint.mdFiles) {
    ctx.problems.push(
      `markdownlint 实际处理文件数 ${lint.processedFiles} ≠ md 文件数 ${lint.mdFiles}`,
    );
  }
  if (lint.mdFiles === 0 || lint.batches < 1) {
    ctx.problems.push("markdownlint 未处理任何 md 文件");
  }

  // 全部敌意标记必须真实进入过产物（确保组合覆盖到位）。
  for (const marker of MARKERS) {
    if (!ctx.markersSeen.has(marker)) {
      ctx.problems.push(`敌意标记未出现在任何 md 产物: ${marker}`);
    }
  }
  for (const marker of MULTILINE_MARKERS) {
    if (!ctx.multiLineMarkersSeen.has(marker)) {
      ctx.problems.push(`跨行敌意标记未出现在任何 md 产物: ${JSON.stringify(marker)}`);
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    workdir: options.workdir,
    lintConfig: options.lintConfig,
    markdownlintJs,
    realHome: options.skipReal ? null : options.realHome,
    counts: {
      cases: ctx.results.length,
      md: mdCount,
      json: jsonCount,
      jsonl: jsonlCount,
      structureViolations: ctx.problems.length,
    },
    lint: {
      exit: lint.status,
      stdoutEmpty: lint.stdout.trim() === "",
      stderrEmpty: lint.stderr.trim() === "",
      mdFiles: lint.mdFiles,
      processedFiles: lint.processedFiles,
      batches: lint.batches,
    },
    problems: ctx.problems,
    cases: ctx.results.map((entry) => ({
      id: entry.id,
      args: entry.args,
      exit: entry.exit,
      outputPath: entry.outputPath,
    })),
  };
  writeFileSync(
    join(options.workdir, "matrix-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `组合 ${ctx.results.length}（md ${mdCount} / json ${jsonCount} / jsonl ${jsonlCount}）；lint exit=${String(lint.status)}；问题 ${ctx.problems.length}\n`,
  );
  for (const problem of ctx.problems) process.stdout.write(`问题: ${problem}\n`);
  return ctx.problems.length === 0 ? 0 : 1;
}

function compareDeterministic(
  id: string,
  firstStdout: string,
  secondStdout: string,
  outDir: string,
  problems: string[],
): void {
  const first = parseContract(id, firstStdout, problems);
  const second = parseContract(`${id}-重复`, secondStdout, problems);
  if (first === null || second === null) return;
  const firstContent = readFileSync(first.path, "utf8");
  const secondContent = readFileSync(second.path, "utf8");
  if (firstContent !== secondContent) {
    problems.push(`${id}: 两次渲染内容不一致（输出目录 ${outDir}）`);
  }
}

async function runRealCases(ctx: MatrixContext, options: MatrixOptions): Promise<void> {
  const base = ["--dsh-home", options.realHome, "--lib-root", LIB_ROOT];
  const listCase = mcase(
    "real-list-json",
    ["list", ...base, "--format", "json"],
    "json",
    "list",
    0,
  );
  executeCase(ctx, listCase);
  const listResult = ctx.results[ctx.results.length - 1];
  if (listResult.outputPath === null) {
    ctx.problems.push("real-list-json: 无法获取真实会话清单，跳过真实会话组合");
    return;
  }
  const doc = asRecord(JSON.parse(readFileSync(listResult.outputPath, "utf8")));
  const sessions = Array.isArray(doc?.sessions) ? doc.sessions : [];
  const ids = sessions
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === "string");
  if (ids.length === 0) {
    ctx.problems.push("real-list-json: 真实会话清单为空");
    return;
  }
  const realCases: MatrixCase[] = [
    mcase("real-list-md", ["list", ...base], "md", null, 0),
    mcase("real-list-md-full", ["list", ...base, "--full"], "md", null, 0),
    mcase("real-stats-md", ["stats", ...base], "md", null, 0),
    mcase("real-search-md", ["search", "a", ...base], "md", null, 0),
    mcase("real-check-md", ["check", ...base], "md", null, 0),
  ];
  ids.forEach((id, index) => {
    realCases.push(
      mcase(`real-show-md-${index}-${id.slice(0, 8)}`, ["show", id, ...base], "md", null, 0),
    );
    if (index < 3) {
      realCases.push(
        mcase(
          `real-show-md-summary-${index}-${id.slice(0, 8)}`,
          ["show", id, ...base, "--summary"],
          "md",
          null,
          0,
        ),
      );
    }
  });
  realCases.push(
    mcase(
      "real-show-md-visible",
      ["show", ids[0], ...base, "--thinking", "--tools", "--events", "--headers"],
      "md",
      null,
      0,
    ),
    mcase("real-show-json", ["show", ids[0], ...base, "--format", "json"], "json", "show", 0),
  );
  for (const item of realCases) {
    executeCase(ctx, item);
  }
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

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
