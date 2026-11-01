// CLI 集成测试的共享夹具与运行器：合成 DSH_HOME（健康库与损坏库）、子进程跑真实 CLI、
// stdout 两行契约的解析，以及官方格式库锚点的取用。
// 命名为 cli-helpers.ts（非 *.test.ts），避免被 node --test 收集而污染测试数。
// 设计约束：夹具作用域按调用方给出的名字划分（tests/.tmp/cli-<名字>），每个测试文件独占一份，
// 因为 node --test 以进程隔离并行跑文件，共用作用域会互相清理对方的夹具。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultLibRoot } from "../scripts/lib/paths.ts";
import {
  type FixtureEvent,
  type FixtureHomeSpec,
  resetTempDir,
  writeFixtureHome,
} from "./fixtures.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/session-reader.ts", import.meta.url));

/** 官方格式库锚点：定位不到时为 undefined，由 `requireLibRoot` 在用例执行期给出可执行诊断。 */
export const LIB_ROOT = defaultLibRoot();

/**
 * 官方格式库锚点：取不到时直接失败。
 *
 * 不在模块顶层抛出：顶层抛错会让整个文件以"加载失败"呈现，看不出是哪条用例依赖它。
 */
export function requireLibRoot(): string {
  if (LIB_ROOT === undefined) {
    throw new Error(
      "默认锚点未能定位桌面版安装内的官方格式库，CLI 集成测试无法运行；请用 --lib-root 或修复安装树定位",
    );
  }
  return LIB_ROOT;
}

/** 一个 CLI 测试文件独占的夹具集合。 */
export interface CliFixtures {
  /** 该文件独占的测试临时根（tests/.tmp/cli-<名字>）。 */
  readonly tempRoot: string;
  /** 产物输出目录（每个文件不同，互不影响）。 */
  readonly outDir: string;
  /** 健康库：5 个可读会话 + 工作区登记。 */
  readonly healthyHome: string;
  /** 损坏库：撕裂尾、seq 缺口、帧损坏各一个会话。 */
  readonly brokenHome: string;
}

/** 为指定名字生成夹具路径（不落盘）。 */
export function cliFixtures(scope: string): CliFixtures {
  const tempRoot = fileURLToPath(new URL(`./.tmp/cli-${scope}`, import.meta.url));
  return {
    tempRoot,
    outDir: join(tempRoot, "out"),
    healthyHome: join(tempRoot, "healthy-dsh"),
    brokenHome: join(tempRoot, "broken-dsh"),
  };
}

/** 清理并重建该文件的夹具（由测试文件在 before 中调用一次）。 */
export function initCliFixtures(fixtures: CliFixtures): void {
  resetTempDir(fixtures.tempRoot);
  writeFixtureHome(fixtures.healthyHome, healthySpec());
  writeFixtureHome(fixtures.brokenHome, brokenSpec());
  mkdirSync(fixtures.outDir, { recursive: true });
}

export interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** 以子进程运行真实 CLI；`ELECTRON_RUN_AS_NODE` 让桌面版宿主以 Node 形态启动（普通 Node 忽略它）。 */
export function runCli(args: readonly string[], env?: NodeJS.ProcessEnv): CliResult {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** stdout 两行契约的解析结果。 */
export interface OutputContract {
  readonly path: string;
  readonly summary: string;
  readonly fileLines: number;
}

/** 断言 stdout 两行契约并读取输出文件行数。 */
export function readContract(stdout: string): OutputContract {
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

/** 读取输出文件内容（两行契约解析失败即用例失败）。 */
export function readOutput(stdout: string): string {
  return readFileSync(readContract(stdout).path, "utf8");
}

/** 公共参数：数据根、官方格式库与产物目录。 */
export function baseArgs(outDir: string, home: string): string[] {
  return ["--dsh-home", home, "--lib-root", requireLibRoot(), "--output-dir", outDir];
}

/** 夹具事件构造器：user/message 统一补上 `{ kind: "user" }` 来源（缺来源会被默认可见性排除）。 */
export function ev(
  type: string,
  seq: number,
  time: number,
  data: Record<string, unknown>,
  extra?: Partial<Pick<FixtureEvent, "surfaceOp" | "sourceEventSeqs">>,
): FixtureEvent {
  // 真实日志的 user/message 恒带 source，缺 source 无法证明来源，默认可见性会排除它（见 visibility.ts
  // 的 isInjectedUserMessage）。需要缺 source 形态的用例必须显式传一个 `source` 键。
  const withSource =
    type === "user/message" && !("source" in data) ? { ...data, source: { kind: "user" } } : data;
  return { type, seq, time, data: withSource, ...extra };
}

/** 健康主会话事件：两轮问答、一次工具调用、标题、压缩摘要、命令与 web 请求等全类型样本。 */
export function mainEvents(): FixtureEvent[] {
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
          // 当前格式的工具结果是“工具”角色的一级消息：toolCallId 与 isError 是消息字段。
          role: "tool",
          id: "fixture-tool-result-1",
          toolCallId: "call_1",
          isError: false,
          source: { kind: "tool", callId: "call_1" },
          content: [{ type: "text", text: "file alpha content" }],
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

/** 项目目录名在夹具里固定为这两个（与 cwd 一一对应）。 */
export const PROJECT_MAIN = "--C-Users-Alice-user_projects--";
export const PROJECT_OTHER = "--C-Users-Alice--";
export const MAIN_CWD = "C:\\Users\\Alice\\user_projects";
export const OTHER_CWD = "C:\\Users\\Alice";

/** 健康库：主会话 + 子代理 + 明文会话 + 多代并存 + 空会话。 */
export function healthySpec(): FixtureHomeSpec {
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
            // 旧代日志文件与当前代并存：只用于验证"取最高版本"，内容不会被读取。
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

/** 损坏库：撕裂尾、seq 缺口、帧损坏（header 不可读）各一个会话。 */
export function brokenSpec(): FixtureHomeSpec {
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
