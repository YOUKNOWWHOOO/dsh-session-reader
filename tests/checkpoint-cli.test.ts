// 标准模式官方压缩检查点的端到端行为：合成 DSH_HOME + 真实官方格式库驱动 CLI。
// 覆盖：**上下文摘要** 标签、不受 --role 控制、轮次大纲跳过摘要正文、json 不新增条目类型、
// search 的 text 档以 `上下文摘要` 标签命中摘要可读文本。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultLibRoot } from "../scripts/lib/paths.ts";
import { type FixtureEvent, resetTempDir, writeFixtureHome } from "./fixtures.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/session-reader.ts", import.meta.url));
const LIB_ROOT = defaultLibRoot();
if (LIB_ROOT === undefined) {
  throw new Error("默认锚点未能定位桌面版安装内的官方格式库，checkpoint-cli.test.ts 无法运行");
}
const REQUIRED_LIB_ROOT: string = LIB_ROOT;
const TEMP_ROOT = fileURLToPath(new URL("./.tmp/checkpoint-cli", import.meta.url));
const HOME = join(TEMP_ROOT, "checkpoint-dsh");
const OUT_DIR = join(TEMP_ROOT, "out");
const PROJECT_DIR = "--C-Users-Alice-user_projects--";
const MAIN_ID = "session-checkpoint-main-01";
const SUMMARY_MARK = "压缩摘要 SUMMARY-MARK";

function ev(type: string, seq: number, data: Record<string, unknown>): FixtureEvent {
  return { type, seq, time: 1000 + seq, data };
}

function checkpointEvents(): FixtureEvent[] {
  return [
    ev("turn/start", 0, { turn: 1 }),
    ev("user/message", 1, {
      role: "user",
      content: [{ type: "text", text: "压缩前的用户消息 USER-BEFORE" }],
      source: { kind: "user" },
    }),
    ev("compaction/start", 2, { compactionId: "c1" }),
    ev("compaction/summary", 3, { summary: [{ type: "text", text: SUMMARY_MARK }] }),
    ev("user/message", 4, {
      role: "user",
      content: [
        {
          type: "text",
          text: `自动生成的检查点前言。\n\n<compacted-summary>\n${SUMMARY_MARK}\n</compacted-summary>`,
        },
      ],
      source: { kind: "compact-checkpoint" },
    }),
    ev("assistant/message", 5, {
      turn: 1,
      message: { role: "assistant", content: [{ type: "text", text: "压缩后的回答 AFTER" }] },
    }),
    ev("turn/end", 6, { turn: 1 }),
  ];
}

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[]): CliResult {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function baseArgs(): string[] {
  return ["--dsh-home", HOME, "--lib-root", REQUIRED_LIB_ROOT, "--output-dir", OUT_DIR];
}

function outputPath(result: CliResult): string {
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  const match = /^完整输出已保存到: (.+)$/u.exec(lines[0]);
  assert.notEqual(match, null, `stdout 首行不符合契约: ${lines[0]}`);
  if (match === null) throw new Error("unreachable");
  return match[1];
}

before(() => {
  resetTempDir(TEMP_ROOT);
  writeFixtureHome(HOME, {
    sessions: [
      {
        id: MAIN_ID,
        projectDir: PROJECT_DIR,
        createdAt: 1000,
        events: checkpointEvents(),
        title: "压缩检查点夹具",
        turns: 1,
        steps: 1,
        lastPromptAt: 2000,
        agentPreset: "standard",
      },
    ],
  });
});

describe("标准模式压缩检查点", () => {
  it("默认视图渲染为 **上下文摘要**，正文只出现一次", () => {
    const result = runCli(["show", MAIN_ID, ...baseArgs()]);
    assert.equal(result.status, 0, result.stderr);
    const content = readFileSync(outputPath(result), "utf8");
    assert.equal(content.includes("**上下文摘要**："), true);
    assert.equal(content.split(SUMMARY_MARK).length - 1, 1);
    assert.equal(content.includes("**用户**：\n\n```text\n自动生成的检查点前言"), false);
  });

  it("--role 不影响摘要条目", () => {
    const result = runCli(["show", MAIN_ID, ...baseArgs(), "--role", "assistant"]);
    assert.equal(result.status, 0, result.stderr);
    const content = readFileSync(outputPath(result), "utf8");
    assert.equal(content.includes("**上下文摘要**："), true);
    assert.equal(content.includes("压缩前的用户消息 USER-BEFORE"), false);
  });

  it("--summary 不把摘要正文当成用户 prompt", () => {
    const result = runCli(["show", MAIN_ID, ...baseArgs(), "--summary"]);
    assert.equal(result.status, 0, result.stderr);
    const content = readFileSync(outputPath(result), "utf8");
    assert.equal(content.includes(SUMMARY_MARK), false);
    assert.equal(content.includes("压缩前的用户消息 USER-BEFORE"), true);
  });

  it("--format json 的 messages 仍按 user/message 分类", () => {
    const result = runCli(["show", MAIN_ID, ...baseArgs(), "--format", "json"]);
    assert.equal(result.status, 0, result.stderr);
    const document = JSON.parse(readFileSync(outputPath(result), "utf8")) as {
      messages: { type: string; text: string }[];
    };
    const checkpoint = document.messages.find((message) => message.text.includes(SUMMARY_MARK));
    assert.notEqual(checkpoint, undefined);
    assert.equal(checkpoint?.type, "user/message");
  });

  it("search 的 text 档以 上下文摘要 标签命中摘要可读文本", () => {
    const result = runCli([
      "search",
      SUMMARY_MARK,
      ...baseArgs(),
      "--scope",
      "text",
      "--format",
      "json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const document = JSON.parse(readFileSync(outputPath(result), "utf8")) as {
      matches: { label: string }[];
      total: number;
    };
    assert.equal(document.total > 0, true);
    assert.equal(
      document.matches.some((match) => match.label === "上下文摘要"),
      true,
    );
    assert.equal(
      document.matches.some((match) => match.label === "user"),
      false,
    );
  });
});
