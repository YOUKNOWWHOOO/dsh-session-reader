// CLI 集成测试：合成 DSH_HOME + 真实官方格式库，以子进程跑真实 CLI 全命令；
// 断言 stdout 两行契约、输出文件行数一致、退出码、错误分类与输出策略。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { countLines, defaultLibRoot, resolveDshHome } from "../scripts/lib/paths.ts";
import { writeOutputFile } from "../scripts/session-reader.ts";
import {
  type FixtureEvent,
  type FixtureHomeSpec,
  resetTempDir,
  writeFixtureHome,
} from "./fixtures.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/session-reader.ts", import.meta.url));
const LIB_ROOT = defaultLibRoot(resolveDshHome(undefined, process.env, homedir()));
const TEMP_ROOT = fileURLToPath(new URL("./.tmp/cli", import.meta.url));
const HEALTHY_HOME = join(TEMP_ROOT, "healthy-dsh");
const BROKEN_HOME = join(TEMP_ROOT, "broken-dsh");
const OUT_DIR = join(TEMP_ROOT, "out");
const PROJECT_MAIN = "--C-Users-Alice-user_projects--";
const PROJECT_OTHER = "--C-Users-Alice--";
const MAIN_CWD = "C:\\Users\\Alice\\user_projects";
const OTHER_CWD = "C:\\Users\\Alice";

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[], env?: NodeJS.ProcessEnv): CliResult {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

interface OutputContract {
  readonly path: string;
  readonly summary: string;
  readonly fileLines: number;
}

/** 断言 stdout 两行契约并读取输出文件行数。 */
function readContract(stdout: string): OutputContract {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 2, `stdout 必须固定两行: ${JSON.stringify(stdout)}`);
  const pathMatch = /^完整输出已保存到: (.+)$/u.exec(lines[0]);
  assert.notEqual(pathMatch, null, `第一行不符合契约: ${lines[0]}`);
  const summaryMatch = /^(.*)；输出文件共 (\d+) 行$/u.exec(lines[1]);
  assert.notEqual(summaryMatch, null, `第二行不符合契约: ${lines[1]}`);
  if (pathMatch === null || summaryMatch === null) throw new Error("unreachable");
  const outputPath = pathMatch[1];
  assert.equal(existsSync(outputPath), true, `输出文件不存在: ${outputPath}`);
  return { path: outputPath, summary: summaryMatch[1], fileLines: Number(summaryMatch[2]) };
}

function baseArgs(home: string): string[] {
  return ["--dsh-home", home, "--lib-root", LIB_ROOT, "--output-dir", OUT_DIR];
}

function ev(
  type: string,
  seq: number,
  time: number,
  data: Record<string, unknown>,
  extra?: Partial<Pick<FixtureEvent, "surfaceOp" | "sourceEventSeqs">>,
): FixtureEvent {
  return { type, seq, time, data, ...extra };
}

function mainEvents(): FixtureEvent[] {
  return [
    ev("turn/start", 0, 10, { turn: 1 }),
    ev("step/start", 1, 11, { turn: 1, step: 1 }),
    ev(
      "user/message",
      2,
      12,
      { role: "user", content: [{ type: "text", text: "hello ALPHA world" }] },
      { surfaceOp: "append" },
    ),
    ev(
      "assistant/message",
      3,
      13,
      {
        turn: 1,
        step: 1,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "reply BETA text" },
            { type: "reasoning", text: "think GAMMA" },
          ],
        },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, reasoningTokens: 1 },
      },
      { surfaceOp: "append" },
    ),
    ev("tool/call", 4, 14, {
      turn: 1,
      step: 1,
      callId: "call_1",
      name: "read",
      arguments: '{"path":"alpha.txt"}',
    }),
    ev(
      "tool/result",
      5,
      15,
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
              content: [{ type: "text", text: "file alpha content" }],
              isError: false,
            },
          ],
        },
      },
      { surfaceOp: "append", sourceEventSeqs: [4] },
    ),
    ev("turn/end", 6, 16, { turn: 1, reason: { kind: "completed" } }),
    ev("turn/start", 7, 17, { turn: 2 }),
    ev(
      "user/message",
      8,
      18,
      { role: "user", content: [{ type: "text", text: "second prompt DELTA" }] },
      { surfaceOp: "append" },
    ),
    ev(
      "assistant/message",
      9,
      19,
      {
        turn: 2,
        message: { role: "assistant", content: [{ type: "text", text: "second reply EPSILON" }] },
      },
      { surfaceOp: "append" },
    ),
    ev("turn/end", 10, 20, { turn: 2, reason: { kind: "completed" } }),
    ev("session/title", 11, 21, {
      title: "夹具会话 A",
      messageSeqs: [2],
      source: { kind: "fallback" },
    }),
    ev("compaction/summary", 12, 22, {
      summary: [{ type: "text", text: "compaction ZETA" }],
      rawOutput: [{ type: "text", text: "raw ETA" }],
    }),
    ev("command/run", 13, 23, {
      commandId: "cmd-1",
      name: "compact",
      args: { a: 1 },
      source: { kind: "user" },
    }),
    ev("command/done", 14, 24, {
      commandId: "cmd-1",
      kind: "text",
      text: "done THETA",
      sourceEventSeq: 13,
    }),
    ev("session/title-llm-request", 15, 25, {
      titleProvider: "p",
      messageSeqs: [2],
      route: { provider: "p", model: "m" },
      system: "title req IOTA",
      messages: [{ role: "user", content: [{ type: "text", text: "title msg" }] }],
      maxTokens: 100,
    }),
    ev("web/deepseek-search-llm-request", 16, 26, {
      endpoint: "e",
      apiVersion: "v",
      body: {
        model: "m",
        max_tokens: 1,
        messages: [{ role: "user", content: [{ type: "text", text: "KAPPA" }] }],
        tools: [],
      },
    }),
    ev("deliverables/presented", 17, 27, {
      turn: 1,
      callId: "call_1",
      files: [{ path: "alpha.txt", description: "deliverable LAMBDA" }],
    }),
    ev("permission/preset", 18, 28, { preset: "workspace-write" }),
  ];
}

function healthySpec(): FixtureHomeSpec {
  return {
    sessions: [
      {
        id: "session-fixture-main-01",
        projectDir: PROJECT_MAIN,
        cwd: MAIN_CWD,
        createdAt: 1000,
        events: mainEvents(),
        agentPreset: "standard",
        title: "夹具会话 A",
        turns: 2,
        steps: 1,
        lastPromptAt: 2000,
      },
      {
        id: "cafe1111-2222-3333-4444-555566667777",
        projectDir: PROJECT_MAIN,
        cwd: MAIN_CWD,
        createdAt: 1500,
        events: [
          ev("subagent/descriptor", 0, 10, {
            version: 3,
            mode: "continuable",
            label: "子代理 B",
            provider: "spawn",
            agentProvider: "p",
            agentModel: "m",
            agentReasoningEffort: "max",
          }),
          ev(
            "user/message",
            1,
            11,
            { role: "user", content: [{ type: "text", text: "sub prompt" }] },
            { surfaceOp: "append" },
          ),
          ev(
            "assistant/message",
            2,
            12,
            {
              turn: 1,
              message: { role: "assistant", content: [{ type: "text", text: "sub reply" }] },
            },
            { surfaceOp: "append" },
          ),
        ],
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
        events: [
          ev(
            "user/message",
            0,
            10,
            { role: "user", content: [{ type: "text", text: "plain OMEGA text" }] },
            { surfaceOp: "append" },
          ),
        ],
        plaintext: true,
        title: "Plain 会话 C",
        turns: 0,
        steps: 0,
        lastPromptAt: null,
      },
      {
        id: "session-fixture-multigen-04",
        projectDir: PROJECT_OTHER,
        cwd: OTHER_CWD,
        createdAt: 600,
        events: [ev("permission/preset", 0, 10, { preset: "workspace-write" })],
        title: "MultiGen 会话 D",
        turns: 0,
        steps: 0,
        lastPromptAt: null,
        extraFiles: [
          {
            fileName: "session.v1.jsonl.zstd",
            content: Buffer.from("legacy-v1-generation-not-read", "utf8"),
          },
        ],
      },
      {
        id: "session-fixture-blank-05",
        projectDir: PROJECT_OTHER,
        cwd: OTHER_CWD,
        createdAt: 700,
        events: [
          ev("permission/preset", 0, 10, { preset: "workspace-write" }),
          ev("sandbox/mode", 1, 11, { mode: "workspace-write" }),
          ev("approval/policy", 2, 12, { policy: "ask" }),
        ],
        title: null,
        blank: true,
        turns: 0,
        steps: 0,
        lastPromptAt: null,
      },
    ],
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
          ev("permission/preset", 0, 10, { preset: "workspace-write" }),
          ev(
            "user/message",
            1,
            11,
            { role: "user", content: [{ type: "text", text: "torn" }] },
            { surfaceOp: "append" },
          ),
          ev(
            "assistant/message",
            2,
            12,
            {
              turn: 1,
              message: { role: "assistant", content: [{ type: "text", text: "torn reply" }] },
            },
            { surfaceOp: "append" },
          ),
          ev("session/title", 3, 13, {
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
          ev("permission/preset", 0, 10, { preset: "workspace-write" }),
          ev(
            "user/message",
            1,
            11,
            { role: "user", content: [{ type: "text", text: "gap" }] },
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
        id: "session-broken-corrupt-08",
        projectDir: PROJECT_OTHER,
        cwd: OTHER_CWD,
        createdAt: 3000,
        events: [ev("permission/preset", 0, 10, { preset: "workspace-write" })],
        corrupt: true,
      },
    ],
  };
}

before(() => {
  resetTempDir(TEMP_ROOT);
  writeFixtureHome(HEALTHY_HOME, healthySpec());
  writeFixtureHome(BROKEN_HOME, brokenSpec());
  mkdirSync(OUT_DIR, { recursive: true });
  // 默认组合测试用：夹具 dsh-home 内建立官方库解析锚点（Junction 指向本机真实库；
  // 清理安全已实测：rmSync 递归删除仅移除链接本身，不触碰目标）。
  const fixtureLibParent = join(HEALTHY_HOME, "profiles", "node_modules", "@deepseek-ai");
  mkdirSync(fixtureLibParent, { recursive: true });
  symlinkSync(
    join(LIB_ROOT, "@deepseek-ai", "dsh-session-format-catalog"),
    join(fixtureLibParent, "dsh-session-format-catalog"),
    "junction",
  );
});

describe("CLI 帮助与参数校验", () => {
  it("总帮助与各命令帮助退出 0", () => {
    for (const args of [
      ["--help"],
      ["list", "--help"],
      ["show", "--help"],
      ["search", "--help"],
      ["stats", "--help"],
      ["check", "--help"],
    ]) {
      const result = runCli(args);
      assert.equal(result.status, 0, `help 失败: ${args.join(" ")}`);
      assert.match(result.stdout, /用法: node session-reader\.ts/u);
    }
  });

  it("未知命令/未知选项/缺位置参数/前缀过短 → 退出 2", () => {
    assert.equal(runCli(["nope", ...baseArgs(HEALTHY_HOME)]).status, 2);
    assert.equal(runCli(["list", ...baseArgs(HEALTHY_HOME), "--unknown"]).status, 2);
    assert.equal(runCli(["show", ...baseArgs(HEALTHY_HOME)]).status, 2);
    const short = runCli(["show", "abc", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(short.status, 2);
    assert.equal(short.stderr.includes("错误: 参数无效"), true);
  });

  it("缺少 --output-dir → 退出 2", () => {
    const result = runCli(["list", "--dsh-home", HEALTHY_HOME, "--lib-root", LIB_ROOT]);
    assert.equal(result.status, 2);
    assert.equal(result.stderr.includes("错误: 参数无效"), true);
  });

  it("呈现类开关与 json/jsonl 组合非法 → 退出 2", () => {
    assert.equal(
      runCli([
        "show",
        "session-fixture-main-01",
        ...baseArgs(HEALTHY_HOME),
        "--format",
        "json",
        "--thinking",
      ]).status,
      2,
    );
    assert.equal(
      runCli([
        "show",
        "session-fixture-main-01",
        ...baseArgs(HEALTHY_HOME),
        "--format",
        "jsonl",
        "--summary",
      ]).status,
      2,
    );
    assert.equal(runCli(["list", ...baseArgs(HEALTHY_HOME), "--format", "jsonl"]).status, 2);
    assert.equal(runCli(["list", ...baseArgs(HEALTHY_HOME), "--format", "text"]).status, 2);
    assert.equal(
      runCli(["show", "session-fixture-main-01", ...baseArgs(HEALTHY_HOME), "--format", "text"])
        .status,
      2,
    );
  });

  it("无效 lib-root → 退出 3（内部错误）", () => {
    const result = runCli([
      "list",
      "--dsh-home",
      HEALTHY_HOME,
      "--lib-root",
      join(TEMP_ROOT, "no-lib"),
      "--output-dir",
      OUT_DIR,
    ]);
    assert.equal(result.status, 3);
    assert.equal(result.stderr.includes("错误: 内部错误"), true);
  });

  it("dsh-home 不存在或 sessions 缺失 → 退出 1", () => {
    const missingHome = runCli([
      "list",
      "--dsh-home",
      join(TEMP_ROOT, "no-such-home"),
      "--lib-root",
      LIB_ROOT,
      "--output-dir",
      OUT_DIR,
    ]);
    assert.equal(missingHome.status, 1);
    assert.equal(missingHome.stderr.includes("错误: 目标不存在"), true);
    const emptyHome = join(TEMP_ROOT, "empty-home");
    mkdirSync(emptyHome, { recursive: true });
    const noSessions = runCli([
      "list",
      "--dsh-home",
      emptyHome,
      "--lib-root",
      LIB_ROOT,
      "--output-dir",
      OUT_DIR,
    ]);
    assert.equal(noSessions.status, 1);
  });

  it("未知目标 → 退出 1；歧义前缀 → 退出 1 并报候选数", () => {
    const unknown = runCli(["show", "zzzzzzzz", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(unknown.status, 1);
    assert.equal(unknown.stderr.includes("错误: 目标不存在"), true);
    const ambiguous = runCli(["show", "session-fixture", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /候选 4 个/u);
  });
});

describe("CLI list", () => {
  it("Markdown 输出：两行契约、行数一致、默认隐藏空会话", () => {
    const result = runCli(["list", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(result.status, 0);
    const contract = readContract(result.stdout);
    const content = readFileSync(contract.path, "utf8");
    assert.equal(countLines(content), contract.fileLines);
    assert.equal(content.startsWith("# 会话列表\n\n"), true);
    assert.equal(content.includes("| ID | 标题 | 工作区 | 最近活动 | 轮次 | 类型 | 大小 |"), true);
    // 显示值必须与可传值同源：产物中的 id 可直接交给 show（见下方"显示值即可传值"用例）。
    assert.equal(content.includes("`session-fixture-main-01`"), true);
    assert.equal(content.includes("夹具会话 A"), true);
    assert.equal(content.includes("user_projects"), true);
    assert.equal(content.includes("session-fixture-blank-05"), false);
    assert.match(content, /合计：匹配 4 个会话，显示 4 个/u);
    assert.match(content, /已隐藏空会话 1 个（--include-blank 显示）/u);
    // 覆盖声明描述"本次检查了哪些会话"（与 --limit 无关）：5 个可读会话全部纳入，无排除项。
    assert.match(content, /扫描会话 5 个；纳入 5 个；排除 0 个/u);
    assert.equal(contract.summary, "匹配会话 4 个，显示 4 个");
    const leftover = readdirSync(OUT_DIR).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftover, []);
  });

  it("显示值即可传值：list 产物中的 id 直接交给 show 成功", () => {
    const listResult = runCli(["list", ...baseArgs(HEALTHY_HOME), "--limit", "1"]);
    assert.equal(listResult.status, 0);
    const listContract = readContract(listResult.stdout);
    const listed = readFileSync(listContract.path, "utf8");
    const idMatch = /^\| `(session-[^`]+)` \|/mu.exec(listed);
    assert.notEqual(idMatch, null, "list 表格首列应为完整 id");
    if (idMatch === null) return;
    const shown = runCli(["show", idMatch[1], ...baseArgs(HEALTHY_HOME), "--summary"]);
    assert.equal(shown.status, 0, `显示值应可直接传值: ${idMatch[1]}`);
    const shownContract = readContract(shown.stdout);
    const shownContent = readFileSync(shownContract.path, "utf8");
    assert.equal(shownContent.includes(`- ID：\`${idMatch[1]}\``), true);
  });

  it("--full 增加 cwd/令牌列；--include-blank 显示空会话", () => {
    const full = runCli(["list", ...baseArgs(HEALTHY_HOME), "--full", "--include-blank"]);
    assert.equal(full.status, 0);
    const contract = readContract(full.stdout);
    const content = readFileSync(contract.path, "utf8");
    assert.equal(content.includes("# 会话列表（完整）"), true);
    assert.equal(content.includes("- `session-fixture-main-01`："), true);
    assert.equal(content.includes("**工作区**：`user_projects`"), true);
    assert.equal(content.includes("**最近活动**："), true);
    assert.equal(content.includes("**轮次**：2"), true);
    assert.equal(content.includes("**大小**："), true);
    assert.equal(content.includes("100/50/25/5"), true);
    assert.equal(content.includes("**cwd**：`C:\\Users\\Alice\\user_projects`"), true);
    assert.equal(content.includes("session-fixture-blank-05"), true);
  });

  it("JSON 输出：字段与元数据可用性标记", () => {
    const result = runCli(["list", ...baseArgs(HEALTHY_HOME), "--format", "json"]);
    assert.equal(result.status, 0);
    const contract = readContract(result.stdout);
    const document = JSON.parse(readFileSync(contract.path, "utf8")) as {
      sessions: Array<Record<string, unknown>>;
    };
    assert.equal(document.sessions.length, 4);
    const main = document.sessions.find((session) => session.id === "session-fixture-main-01");
    assert.notEqual(main, undefined);
    assert.equal(main?.title, "夹具会话 A");
    assert.equal(main?.turns, 2);
    assert.deepEqual(main?.metadata, { available: true, reasons: [] });
    const tokens = main?.tokens as Record<string, number>;
    assert.equal(tokens.uncachedInputTokens, 100);
  });

  it("工作区/类型/limit 过滤", () => {
    const workspace = runCli([
      "list",
      ...baseArgs(HEALTHY_HOME),
      "--format",
      "json",
      "--workspace",
      "user_projects",
    ]);
    assert.equal(workspace.status, 0);
    const workspaceDoc = JSON.parse(readFileSync(readContract(workspace.stdout).path, "utf8")) as {
      sessions: Array<Record<string, unknown>>;
    };
    assert.equal(workspaceDoc.sessions.length, 2);

    const subagent = runCli([
      "list",
      ...baseArgs(HEALTHY_HOME),
      "--format",
      "json",
      "--origin",
      "subagent",
    ]);
    const subagentDoc = JSON.parse(readFileSync(readContract(subagent.stdout).path, "utf8")) as {
      sessions: Array<Record<string, unknown>>;
    };
    assert.equal(subagentDoc.sessions.length, 1);
    assert.equal(subagentDoc.sessions[0].type, "subagent");

    const limited = runCli([
      "list",
      ...baseArgs(HEALTHY_HOME),
      "--format",
      "json",
      "--limit",
      "1",
      "--sort",
      "created",
    ]);
    const limitedDoc = JSON.parse(readFileSync(readContract(limited.stdout).path, "utf8")) as {
      sessions: Array<Record<string, unknown>>;
    };
    assert.equal(limitedDoc.sessions.length, 1);
    assert.equal(limitedDoc.sessions[0].id, "cafe1111-2222-3333-4444-555566667777");

    const badWorkspace = runCli(["list", ...baseArgs(HEALTHY_HOME), "--workspace", "no-such"]);
    assert.equal(badWorkspace.status, 1);
  });
});

describe("CLI show", () => {
  it("按唯一前缀读取主会话（Markdown 围栏承载正文）", () => {
    const result = runCli(["show", "fixture-main-01", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(result.status, 0);
    const contract = readContract(result.stdout);
    const content = readFileSync(contract.path, "utf8");
    assert.equal(countLines(content), contract.fileLines);
    assert.equal(content.startsWith("# 会话记录\n\n"), true);
    assert.equal(content.includes("- ID：`session-fixture-main-01`"), true);
    assert.equal(content.includes("- 标题：`夹具会话 A`"), true);
    assert.equal(content.includes("- 轮次：2；步数：1；工具调用：1"), true);
    assert.equal(content.includes("```text\nhello ALPHA world\n```"), true);
    assert.equal(content.includes("```text\nreply BETA text\n```"), true);
    assert.equal(content.includes("**推理**"), false);
    assert.equal(content.includes("**工具调用**"), false);
    assert.match(content, /摘要：/u);
  });

  it("--summary 输出轮次大纲", () => {
    const result = runCli(["show", "fixture-main-01", ...baseArgs(HEALTHY_HOME), "--summary"]);
    assert.equal(result.status, 0);
    const content = readFileSync(readContract(result.stdout).path, "utf8");
    assert.equal(content.includes("## 轮次大纲"), true);
    assert.equal(content.includes("T1（seq 0）"), true);
    assert.equal(content.includes("```text"), false);
  });

  it("--thinking --tools --events --truncate/--headers 生效", () => {
    const result = runCli([
      "show",
      "fixture-main-01",
      ...baseArgs(HEALTHY_HOME),
      "--thinking",
      "--tools",
      "--events",
      "--headers",
      "--truncate",
      "100",
    ]);
    assert.equal(result.status, 0);
    const content = readFileSync(readContract(result.stdout).path, "utf8");
    assert.equal(content.includes("```text\nthink GAMMA\n```"), true);
    assert.match(content, /\*\*工具调用\*\*（`read`）（seq 4；[0-9T:+-]+）：/u);
    assert.equal(content.includes("```text\nfile alpha content\n```"), true);
    assert.match(content, /\*\*用户\*\*（seq 2；[0-9T:+-]+）：/u);
    assert.match(content, /\*\*事件\*\*（seq \d+；[0-9T:+-]+）：`turn\/start`/u);
  });

  it("--role 过滤对话消息", () => {
    const result = runCli(["show", "fixture-main-01", ...baseArgs(HEALTHY_HOME), "--role", "user"]);
    assert.equal(result.status, 0);
    const content = readFileSync(readContract(result.stdout).path, "utf8");
    assert.equal(content.includes("```text\nhello ALPHA world\n```"), true);
    assert.equal(content.includes("```text\nreply BETA text\n```"), false);
  });

  it("jsonl：首行 header、其后每行事件", () => {
    const result = runCli([
      "show",
      "session-fixture-main-01",
      ...baseArgs(HEALTHY_HOME),
      "--format",
      "jsonl",
    ]);
    assert.equal(result.status, 0);
    const contract = readContract(result.stdout);
    const lines = readFileSync(contract.path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    assert.equal(lines.length, 1 + 19);
    const header = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(header.id, "session-fixture-main-01");
    assert.equal(header.version, 3);
    const firstEvent = JSON.parse(lines[1]) as Record<string, unknown>;
    assert.equal(firstEvent.seq, 0);
  });

  it("--subagents --format json：父子嵌套结构", () => {
    const result = runCli([
      "show",
      "fixture-main-01",
      ...baseArgs(HEALTHY_HOME),
      "--subagents",
      "--format",
      "json",
    ]);
    assert.equal(result.status, 0);
    const document = JSON.parse(readFileSync(readContract(result.stdout).path, "utf8")) as {
      session: Record<string, unknown>;
      turns: unknown[];
      messages: unknown[];
      subagents: Array<{ session: Record<string, unknown> }>;
    };
    assert.equal(document.session.id, "session-fixture-main-01");
    assert.equal(document.turns.length, 2);
    assert.equal(document.subagents.length, 1);
    assert.equal(document.subagents[0].session.id, "cafe1111-2222-3333-4444-555566667777");
  });

  it("裸 uuid 前缀读取子代理会话；last 解析最近活动主会话", () => {
    const subagent = runCli(["show", "cafe1111", ...baseArgs(HEALTHY_HOME), "--format", "json"]);
    assert.equal(subagent.status, 0);
    const subagentDoc = JSON.parse(readFileSync(readContract(subagent.stdout).path, "utf8")) as {
      session: Record<string, unknown>;
    };
    assert.equal(subagentDoc.session.id, "cafe1111-2222-3333-4444-555566667777");
    const last = runCli(["show", "last", ...baseArgs(HEALTHY_HOME), "--format", "json"]);
    assert.equal(last.status, 0);
    const lastDoc = JSON.parse(readFileSync(readContract(last.stdout).path, "utf8")) as {
      session: Record<string, unknown>;
    };
    assert.equal(lastDoc.session.id, "session-fixture-main-01");
  });
});

describe("CLI search", () => {
  it("默认 text 范围：大小写不敏感、末行汇总", () => {
    const result = runCli(["search", "alpha", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(result.status, 0);
    const content = readFileSync(readContract(result.stdout).path, "utf8");
    assert.equal(content.startsWith("# 检索结果\n\n"), true);
    assert.match(content, /命中总数：1$/mu);
    assert.equal(content.includes("`session-fixt"), true);
  });

  it("`--` 选项终止符：以 - 开头的关键词可表达", () => {
    const withoutTerminator = runCli(["search", "- item", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(withoutTerminator.status, 2);
    assert.equal(withoutTerminator.stderr, "错误: 参数无效（未知选项: - item）\n");
    const result = runCli(["search", "--scope", "all", ...baseArgs(HEALTHY_HOME), "--", "- item"]);
    assert.equal(result.status, 0);
    const content = readFileSync(readContract(result.stdout).path, "utf8");
    assert.match(content, /命中总数：\d+$/mu);
  });

  it("--case-sensitive 与 --scope tools/all", () => {
    const sensitive = runCli(["search", "ALPHA", ...baseArgs(HEALTHY_HOME), "--case-sensitive"]);
    const sensitiveContent = readFileSync(readContract(sensitive.stdout).path, "utf8");
    assert.match(sensitiveContent, /命中总数：1$/mu);

    const scopeTools = runCli([
      "search",
      "alpha",
      ...baseArgs(HEALTHY_HOME),
      "--scope",
      "tools",
      "--format",
      "json",
    ]);
    const toolsDoc = JSON.parse(readFileSync(readContract(scopeTools.stdout).path, "utf8")) as {
      total: number;
      scope: string;
      totalIsExact: boolean;
      matches: Array<{ label: string }>;
    };
    assert.equal(toolsDoc.total >= 3, true);
    assert.equal(toolsDoc.scope, "tools");
    assert.equal(toolsDoc.totalIsExact, true);
    assert.equal(
      toolsDoc.matches.some((match) => match.label === "tool/call"),
      true,
    );

    const scopeAll = runCli([
      "search",
      "ZETA",
      ...baseArgs(HEALTHY_HOME),
      "--scope",
      "all",
      "--format",
      "json",
    ]);
    const allDoc = JSON.parse(readFileSync(readContract(scopeAll.stdout).path, "utf8")) as {
      total: number;
      matches: Array<{ label: string }>;
    };
    // all 档同时产出语义单元（compaction/summary）与整条事件载荷（label = 事件类型），
    // 因此同一处文本会被两个单元各命中一次；关键是语义单元必须仍然可见。
    assert.equal(allDoc.total >= 1, true);
    assert.equal(
      allDoc.matches.some((match) => match.label === "compaction/summary"),
      true,
    );

    const textScope = runCli(["search", "ZETA", ...baseArgs(HEALTHY_HOME), "--format", "json"]);
    assert.equal(
      (JSON.parse(readFileSync(readContract(textScope.stdout).path, "utf8")) as { total: number })
        .total,
      0,
    );
  });

  it("limit 截断显示但汇总为全量", () => {
    const result = runCli([
      "search",
      "alpha",
      ...baseArgs(HEALTHY_HOME),
      "--scope",
      "all",
      "--limit",
      "1",
      "--format",
      "json",
    ]);
    assert.equal(result.status, 0);
    const document = JSON.parse(readFileSync(readContract(result.stdout).path, "utf8")) as {
      total: number;
      truncated: boolean;
      matches: unknown[];
    };
    assert.equal(document.matches.length, 1);
    assert.equal(document.total >= 2, true);
    assert.equal(document.truncated, true);
  });
});

describe("CLI stats", () => {
  it("全局聚合 Markdown", () => {
    const result = runCli(["stats", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(result.status, 0);
    const content = readFileSync(readContract(result.stdout).path, "utf8");
    assert.equal(content.startsWith("# 统计\n\n"), true);
    assert.match(content, /- 会话数：5/u);
    assert.match(content, /- 空会话数：1/u);
    assert.match(content, /- 工具调用总数：1/u);
    assert.match(content, /- 时间跨度：/u);
  });

  it("单会话统计与 JSON", () => {
    const single = runCli(["stats", "fixture-main-01", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(single.status, 0);
    const content = readFileSync(readContract(single.stdout).path, "utf8");
    assert.equal(content.includes("夹具会话 A"), true);

    const json = runCli(["stats", ...baseArgs(HEALTHY_HOME), "--format", "json"]);
    const document = JSON.parse(readFileSync(readContract(json.stdout).path, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(document.kind, "global");
    assert.equal(document.sessionCount, 5);
  });

  it("单会话拒绝范围过滤（参数无效，退出 2）；全局聚合可用", () => {
    for (const extra of [
      ["--workspace", "user_projects"],
      ["--since", "0"],
      ["--until", "0"],
      ["--origin", "main"],
    ]) {
      const result = runCli(["stats", "fixture-main-01", ...baseArgs(HEALTHY_HOME), ...extra]);
      assert.equal(result.status, 2, `期望拒绝: ${extra.join(" ")}`);
      assert.equal(
        result.stderr,
        `错误: 参数无效（单会话统计不接受范围过滤选项 ${extra[0]}；去掉 ${extra[0]}，或去掉会话目标改用全局聚合）\n`,
      );
      assert.equal(result.stdout, "");
    }
    const globalFiltered = runCli(["stats", ...baseArgs(HEALTHY_HOME), "--origin", "main"]);
    assert.equal(globalFiltered.status, 0);
  });
});

describe("CLI check", () => {
  it("健康数据：无异常、退出 0", () => {
    const result = runCli(["check", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(result.status, 0);
    const content = readFileSync(readContract(result.stdout).path, "utf8");
    assert.equal(content.startsWith("# 完整性校验\n\n"), true);
    assert.match(content, /结论：无异常/u);
  });

  it("异常数据：结构损坏/撕裂尾/seq 不连续、退出 3", () => {
    const result = runCli(["check", ...baseArgs(BROKEN_HOME)]);
    assert.equal(result.status, 3);
    const contract = readContract(result.stdout);
    const content = readFileSync(contract.path, "utf8");
    assert.equal(content.includes("结构损坏"), true);
    assert.match(content, /tornStart@\d+/u);
    assert.equal(content.includes("seq=不连续"), true);
    assert.match(content, /结论：发现 \d+ 项异常/u);
  });

  it("JSON 输出逐会话异常项", () => {
    const result = runCli(["check", ...baseArgs(BROKEN_HOME), "--format", "json"]);
    assert.equal(result.status, 3);
    const document = JSON.parse(readFileSync(readContract(result.stdout).path, "utf8")) as {
      sessions: Array<Record<string, unknown>>;
      anomalyCount: number;
    };
    assert.equal(document.sessions.length, 3);
    assert.equal(document.anomalyCount >= 3, true);
    const corrupt = document.sessions.find((session) => session.id === "session-broken-corrupt-08");
    assert.equal(corrupt?.structure, "结构损坏");
  });
});

describe("CLI show 对异常数据", () => {
  it("撕裂尾：完整帧成功解码并显式标注异常", () => {
    const result = runCli(["show", "session-broken-torn-06", ...baseArgs(BROKEN_HOME)]);
    assert.equal(result.status, 0);
    const content = readFileSync(readContract(result.stdout).path, "utf8");
    assert.equal(content.includes("- 异常："), true);
    assert.equal(content.includes("尾部未完整帧已丢弃"), true);
  });

  it("seq 缺口：一致性失败 → 退出 3 数据不可读", () => {
    const result = runCli(["show", "session-broken-gap-07", ...baseArgs(BROKEN_HOME)]);
    assert.equal(result.status, 3);
    assert.equal(result.stderr.includes("错误: 数据不可读"), true);
  });

  it("结构损坏会话：list 容错跳过并逐条声明排除（退出 0）", () => {
    const result = runCli(["list", ...baseArgs(BROKEN_HOME)]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const contract = readContract(result.stdout);
    const content = readFileSync(contract.path, "utf8");
    // 容错语义：单个 header 不可读的会话不再阻断对其余会话的浏览，但必须显式声明排除了谁、为什么。
    assert.match(content, /扫描会话 3 个；纳入 2 个；排除 1 个/u);
    assert.match(content, /排除会话：`session-broken-corrupt-08`（`帧魔数无效（偏移 0）`）/u);
  });

  it("header 不可读但目录存在：按前缀取目标报数据不可读（退出 3），与真不存在可区分", () => {
    // P7 根因修复的独立验证：同一命令、同一前缀形态，存在的损坏会话与不存在的标识必须给出不同分类。
    const unreadable = runCli(["show", "session-broken-corrupt-08", ...baseArgs(BROKEN_HOME)]);
    assert.equal(unreadable.status, 3, `stderr=${unreadable.stderr}`);
    assert.equal(unreadable.stderr, "错误: 数据不可读\n");
    assert.equal(unreadable.stdout, "");

    const missing = runCli(["show", "session-broken-nope-99", ...baseArgs(BROKEN_HOME)]);
    assert.equal(missing.status, 1, `stderr=${missing.stderr}`);
    assert.equal(missing.stderr, "错误: 目标不存在\n");
    assert.equal(missing.stdout, "");
  });
});

describe("默认参数组合（默认调用）", () => {
  it("list：仅命令 + --output-dir（DSH_HOME 提供主目录）", () => {
    const result = runCli(["list", "--output-dir", OUT_DIR], { DSH_HOME: HEALTHY_HOME });
    assert.equal(result.status, 0);
    const contract = readContract(result.stdout);
    const content = readFileSync(contract.path, "utf8");
    assert.equal(countLines(content), contract.fileLines);
    assert.match(contract.path, /\.md$/u);
    assert.equal(content.startsWith("# 会话列表\n\n"), true);
    assert.equal(content.includes("夹具会话 A"), true);
    assert.equal(content.includes("session-fixture-blank-05"), false);
    assert.match(content, /合计：匹配 4 个会话，显示 4 个/u);
  });

  it("show：仅目标 + --output-dir（默认可见性/格式/不截断/尾部摘要提示）", () => {
    const result = runCli(["show", "fixture-main-01", "--output-dir", OUT_DIR], {
      DSH_HOME: HEALTHY_HOME,
    });
    assert.equal(result.status, 0);
    const contract = readContract(result.stdout);
    assert.match(contract.path, /\.md$/u);
    assert.equal(contract.summary.includes("事件 19 个"), true);
    const content = readFileSync(contract.path, "utf8");
    assert.equal(content.includes("```text\nhello ALPHA world\n```"), true);
    assert.equal(content.includes("```text\nreply BETA text\n```"), true);
    assert.equal(content.includes("**推理**"), false);
    assert.equal(content.includes("**工具调用**"), false);
    assert.match(content, /摘要：已隐藏 1 条推理内容（--thinking 显示）/u);
    assert.match(content, /已隐藏 2 条工具调用\/结果（--tools 显示）/u);
    assert.match(content, /已隐藏 \d+ 条生命周期事件（--events 显示）/u);
  });
});

describe("输出策略", () => {
  it("writeOutputFile：原子创建、拒绝覆盖、无临时残留", () => {
    const dir = join(TEMP_ROOT, "writer");
    const first = writeOutputFile(dir, "sample.txt", "第一行\n第二行\n", false);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.value.lines, 2);
    const second = writeOutputFile(dir, "sample.txt", "覆盖尝试\n", false);
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.failure.classification, "输出文件已存在");
    assert.equal(second.failure.exitCode, 2);
    assert.equal(readFileSync(first.value.path, "utf8"), "第一行\n第二行\n");
    const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  it("writeOutputFile：overwrite=true 原子替换同名产物且无临时残留", () => {
    const dir = join(TEMP_ROOT, "writer-overwrite");
    const first = writeOutputFile(dir, "sample.txt", "第一版\n", true);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = writeOutputFile(dir, "sample.txt", "第二版\n", true);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.value.path, first.value.path);
    assert.equal(readFileSync(second.value.path, "utf8"), "第二版\n");
    const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  it("writeOutputFile：输出目录不存在时递归创建", () => {
    const nested = join(TEMP_ROOT, "writer-nested", "a", "b");
    const result = writeOutputFile(nested, "sample.txt", "内容\n", false);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(existsSync(result.value.path), true);
  });

  it("CLI 输出文件 UTF-8 无 BOM 且以换行结尾", () => {
    const result = runCli(["list", ...baseArgs(HEALTHY_HOME)]);
    const contract = readContract(result.stdout);
    const bytes = readFileSync(contract.path);
    assert.equal(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, false);
    assert.equal(bytes[bytes.length - 1], 0x0a);
  });

  it("测试自清理：writeFixtureHome 可覆写", () => {
    // 覆写同一夹具根不抛错（before 已执行过一次写入）
    writeFixtureHome(join(TEMP_ROOT, "rewrite-check"), healthySpec());
    assert.equal(existsSync(join(TEMP_ROOT, "rewrite-check", "sessions")), true);
  });
});
