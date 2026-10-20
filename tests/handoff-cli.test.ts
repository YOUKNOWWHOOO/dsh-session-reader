// 交接条目的端到端行为：合成 DSH_HOME + 真实官方格式库驱动 CLI，断言产物里出现什么、不出现什么。
//
// 覆盖的三条对外契约：
// 1. `**交接**` 默认可见、不受 `--thinking`/`--tools`/`--events` 控制，且同一事件只产出一条条目
//    （`--events` 打开时不得再以通用 `**事件**` 形态出现第二次）；
// 2. 条目只给结构事实，不复制交接正文——正文由相邻 `**助手**` 条目承载，避免同一段内容出现两次；
// 3. 非 handoff 型的 `developer/message`（`tool-registry`）不进交接条目，仍由 `--events` 控制。
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
  throw new Error(
    "默认锚点未能定位桌面版安装内的官方格式库，handoff-cli.test.ts 无法运行；请用 --lib-root 或修复安装树定位",
  );
}
const REQUIRED_LIB_ROOT: string = LIB_ROOT;
const TEMP_ROOT = fileURLToPath(new URL("./.tmp/handoff-cli", import.meta.url));
const HOME = join(TEMP_ROOT, "handoff-dsh");
const OUT_DIR = join(TEMP_ROOT, "out");
const PROJECT_DIR = "--C-Users-Alice-user_projects--";
const MAIN_ID = "session-handoff-main-01";

const BODY_MARK = "交接正文 HANDOFF-BODY-MARK";
const NORMAL_MARK = "普通回答 NORMAL-MARK";

function ev(
  type: string,
  seq: number,
  data: Record<string, unknown>,
  extra?: { readonly surfaceOp?: unknown; readonly sourceEventSeqs?: readonly number[] },
): FixtureEvent {
  return { type, seq, time: 1000 + seq, data, ...extra };
}

/** 交接正文 + 交接边界 + 投递 + 非交接型 developer/message 的完整会话。 */
function handoffEvents(): FixtureEvent[] {
  return [
    ev("turn/start", 0, { turn: 1 }),
    ev(
      "user/message",
      1,
      {
        role: "user",
        content: [{ type: "text", text: "用户正文 USER-MARK" }],
        source: { kind: "user" },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "assistant/message",
      2,
      {
        role: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: BODY_MARK }] },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "developer/message",
      3,
      {
        turn: 1,
        step: 1,
        message: { role: "developer", source: { kind: "handoff" }, content: [] },
      },
      { surfaceOp: { op: "replace", startSeq: 0, endSeq: 2 }, sourceEventSeqs: [0, 1, 2] },
    ),
    ev("agent/inbox/spliced", 4, {
      target: "next-step",
      start: 0,
      inserted: [
        {
          role: "user",
          source: { kind: "user" },
          content: [
            {
              type: "text",
              text: "<compacted-summary>\n投递正文 SPLICED-MARK\n</compacted-summary>",
            },
          ],
        },
      ],
    }),
    ev("developer/message", 5, {
      turn: 1,
      step: 2,
      message: { role: "developer", source: { kind: "tool-registry" }, content: [] },
    }),
    ev(
      "assistant/message",
      6,
      {
        role: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: NORMAL_MARK }] },
      },
      { surfaceOp: "append" },
    ),
    ev("turn/end", 7, { turn: 1 }),
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

function showMd(extra: readonly string[] = []): { content: string; summary: string } {
  const result = runCli(["show", MAIN_ID, ...baseArgs(), ...extra]);
  assert.equal(result.status, 0, `show 失败: ${result.stderr}`);
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  const pathMatch = /^完整输出已保存到: (.+)$/u.exec(lines[0]);
  assert.notEqual(pathMatch, null, `stdout 首行不符合契约: ${lines[0]}`);
  if (pathMatch === null) throw new Error("unreachable");
  return {
    content: readFileSync(pathMatch[1], "utf8"),
    summary: /^(.*)；输出文件共 \d+ 行$/u.exec(lines[1])?.[1] ?? "",
  };
}

/** 统计子串出现次数（用于断言"只出现一次"）。 */
function countOf(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

before(() => {
  resetTempDir(TEMP_ROOT);
  writeFixtureHome(HOME, {
    sessions: [
      {
        id: MAIN_ID,
        projectDir: PROJECT_DIR,
        createdAt: 1000,
        events: handoffEvents(),
        title: "交接夹具",
        turns: 1,
        steps: 2,
        lastPromptAt: 2000,
      },
    ],
  });
});

describe("交接条目的默认呈现", () => {
  it("默认视图含且仅含一条交接条目，结构事实逐行给出", () => {
    const { content } = showMd();
    assert.equal(countOf(content, "**交接**："), 1);
    assert.equal(content.includes("轮次 1／步 1"), true);
    assert.equal(content.includes("历史替换 seq 0-2（3 条事件）"), true);
    assert.equal(
      content.includes(`投递 next-step；正文 seq 2（${String([...BODY_MARK].length)} 字符）`),
      true,
    );
  });

  it("不复制交接正文：正文只由助手条目出现一次", () => {
    const { content } = showMd();
    assert.equal(countOf(content, BODY_MARK), 1);
    // 投递正文不进默认视图（它在 spliced 事件里，属框架注入路径）。
    assert.equal(content.includes("SPLICED-MARK"), false);
  });

  it("非 handoff 型 developer/message 不进交接条目，且计入隐藏的生命周期事件", () => {
    const { content } = showMd();
    assert.equal(content.includes("tool-registry"), false);
    // 夹具里默认不可见的事件恰为四条：turn/start、turn/end、agent/inbox/spliced，
    // 以及 tool-registry 型的 developer/message（后者不得因新增交接条目而被顺手呈现）。
    // 摘要行是产物内文本，不是 stdout 的命令级摘要。
    assert.equal(content.includes("摘要：已隐藏 4 条生命周期事件"), true);
  });

  it("--tools 不改变交接条目，也不解除生命周期事件隐藏", () => {
    const { content } = showMd(["--tools"]);
    assert.equal(countOf(content, "**交接**："), 1);
    assert.equal(content.includes("轮次 1／步 1"), true);
  });

  it("--events 下交接条目仍只有一条，且不再以通用事件形态重复出现", () => {
    const { content } = showMd(["--events"]);
    assert.equal(countOf(content, "**交接**："), 1);
    assert.equal(countOf(content, "developer/message"), 1);
    assert.equal(content.includes("tool-registry"), true);
  });

  it("--summary 视图不输出交接条目", () => {
    const { content } = showMd(["--summary"]);
    assert.equal(content.includes("**交接**"), false);
    assert.equal(content.includes("轮次 1／步 1"), false);
  });

  it("--role 不影响交接条目", () => {
    const { content } = showMd(["--role", "user"]);
    assert.equal(countOf(content, "**交接**："), 1);
    assert.equal(content.includes(BODY_MARK), false);
  });

  it("--format json 不新增条目类型：messages 里没有 developer/message", () => {
    const result = runCli(["show", MAIN_ID, ...baseArgs(), "--format", "json"]);
    assert.equal(result.status, 0, `show --format json 失败: ${result.stderr}`);
    const lines = result.stdout.split("\n").filter((line) => line.length > 0);
    const pathMatch = /^完整输出已保存到: (.+)$/u.exec(lines[0]);
    if (pathMatch === null) throw new Error("stdout 首行不符合契约");
    const document = JSON.parse(readFileSync(pathMatch[1], "utf8")) as {
      messages: { type: string }[];
    };
    const types = document.messages.map((message) => message.type);
    assert.equal(types.includes("developer/message"), false);
    assert.equal(types.includes("user/message"), true);
    assert.equal(types.includes("assistant/message"), true);
  });
});
