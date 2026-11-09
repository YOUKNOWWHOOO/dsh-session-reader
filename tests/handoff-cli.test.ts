// 交接条目的端到端行为：合成 DSH_HOME + 真实官方格式库驱动 CLI，断言产物里出现什么、不出现什么。
//
// 覆盖的对外契约：
// 1. `**交接**` 默认可见、不受 `--thinking`/`--tools`/`--events` 控制，且同一事件只产出一条条目
//    （`--events` 打开时不得再以通用 `**事件**` 形态出现第二次）；
// 2. `**交接**` 只给三行结构事实：轮次/步、历史替换、前置助手消息与交接通知的定位；条目不承载正文；
// 3. 文件式交接不投递摘要：助手完成说明保留在 `**助手**` 条目，`context-compacted` 通知由
//    `**交接通知**` 单独承载；维护指令经多步工具往返后仍被定位为 `**交接指令**`；
// 4. 非 handoff 型的 `developer/message`（`tool-registry`）不进交接条目，仍由 `--events` 控制。
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
/** 文件式交接夹具会话 id：与主夹具分处两个会话，两种期望互不覆盖。 */
const NOTICE_ID = "session-handoff-notice-02";

const BODY_MARK = "助手回复 HANDOFF-BODY-MARK";
const MAIN_INSTRUCTION_MARK = "维护指令 MAIN-INSTRUCTION-MARK";
const MAIN_NOTICE_MARK = "压缩通知 MAIN-NOTICE-MARK";
const NORMAL_MARK = "普通回答 NORMAL-MARK";
const NOTICE_INSTRUCTION_MARK = "维护指令 NOTICE-INSTRUCTION-MARK";
const NOTICE_MARK = "压缩通知 NOTICE-MARK";
const NOTICE_BODY_MARK = "维护完成说明 NOTICE-BODY-MARK";
const NOTICE_CONTINUE_MARK = "继续 NOTICE-CONTINUE-MARK";

/** 部署侧消息时间标记的固定时间戳，形态取自 `preset-lib/injection-boundary.mjs` 的 RFC 3339 秒级带偏移。 */
const MESSAGE_TS = "2026-10-29T22:59:57+08:00";

/**
 * 给对话消息正文套上部署侧的消息信封。
 *
 * 当期部署在会话 `append` 包装层给真实用户消息与带文本块的助手消息各加一对 `<dsh-message>`
 * （纯工具调用的 assistant 消息不包裹）。夹具必须复现这一形态：前置助手消息的字符数必须按
 * 剥净后的正文计算，带信封的形态才能暴露把信封长度算进坐标的缺陷。`id` 取值不是解析判据
 * （剥离只认形态），此处用固定值保持夹具确定性。
 *
 * @param role 消息角色，取 `user` 或 `assistant`。
 * @param text 原始正文（已被部署侧转义前的形态）。
 * @returns 起点行、正文与终点行三段组成的信封形态。
 */
function enveloped(role: "user" | "assistant", text: string): string {
  return `<dsh-message role="${role}" id="abcdef12" ts="${MESSAGE_TS}">\n${text}\n</dsh-message>`;
}

/**
 * 部署侧注入信封（文件式交接的两条协议消息都由交接插件自己包裹）。
 *
 * 形态取自 `preset-lib/injection-boundary.mjs`：起点单独成行、正文另起一行、终点单独成行。
 * `kind` 是合成条目判定的结构锚点；`src` 恒为 `handoff`。
 *
 * @param kind 注入类别，取 `handoff-instruction` 或 `context-compacted`。
 * @param text 原始正文。
 * @returns 起止标记包裹后的文本。
 */
function injected(kind: string, text: string): string {
  return `<dsh-injection kind="${kind}" src="handoff" id="abcdef12" ts="${MESSAGE_TS}">\n${text}\n</dsh-injection>`;
}

function ev(
  type: string,
  seq: number,
  data: Record<string, unknown>,
  extra?: { readonly surfaceOp?: unknown; readonly sourceEventSeqs?: readonly number[] },
): FixtureEvent {
  return { type, seq, time: 1000 + seq, data, ...extra };
}

/** 文件式交接：维护指令注入 + 助手正文 + 交接边界 + 压缩通知 + 非交接型 developer/message。 */
function handoffEvents(): FixtureEvent[] {
  return [
    ev("turn/start", 0, { turn: 1 }),
    ev(
      "user/message",
      1,
      {
        role: "user",
        content: [{ type: "text", text: injected("handoff-instruction", MAIN_INSTRUCTION_MARK) }],
        source: { kind: "handoff" },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "assistant/message",
      2,
      {
        role: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: enveloped("assistant", BODY_MARK) }],
        },
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
    ev("agent/inbox/spliced", 4, { target: "next-step", start: 0, inserted: [] }),
    ev(
      "user/message",
      5,
      {
        role: "user",
        content: [{ type: "text", text: injected("context-compacted", MAIN_NOTICE_MARK) }],
        source: { kind: "handoff" },
      },
      { surfaceOp: "append" },
    ),
    ev("developer/message", 6, {
      turn: 1,
      step: 2,
      message: { role: "developer", source: { kind: "tool-registry" }, content: [] },
    }),
    ev(
      "assistant/message",
      7,
      {
        role: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: enveloped("assistant", NORMAL_MARK) }],
        },
      },
      { surfaceOp: "append" },
    ),
    ev("turn/end", 8, { turn: 1 }),
  ];
}

/**
 * 文件式交接：维护指令 → 多步工具往返 → 最终回复 → 交接事件 → 代理信箱拼接事件 →
 * `context-compacted` 通知。
 *
 * 生成阶段刻意跨两个步骤（第一步只有工具调用、第二步才是最终文本），复现真实日志里"维护指令与
 * 最终回复不相邻"的形态；只看前一条事件的判据在这里会失败，因此本夹具能拦住该回归。
 */
function handoffNoticeEvents(): FixtureEvent[] {
  return [
    ev("turn/start", 0, { turn: 1 }),
    ev("step/start", 1, { turn: 1, step: 1 }),
    ev(
      "user/message",
      2,
      {
        role: "user",
        content: [{ type: "text", text: injected("handoff-instruction", NOTICE_INSTRUCTION_MARK) }],
        source: { kind: "handoff" },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "assistant/message",
      3,
      {
        turn: 1,
        message: {
          role: "assistant",
          content: [{ type: "tool-call", id: "call-1", name: "read", arguments: '{"path":"x"}' }],
        },
      },
      { surfaceOp: "append" },
    ),
    ev("tool/call", 4, {
      turn: 1,
      step: 1,
      callId: "call-1",
      name: "read",
      arguments: '{"path":"x"}',
    }),
    ev(
      "tool/result",
      5,
      {
        turn: 1,
        step: 1,
        message: {
          role: "tool",
          source: { kind: "tool", callId: "call-1" },
          toolCallId: "call-1",
          isError: false,
          content: [{ type: "text", text: "工具结果" }],
        },
      },
      { surfaceOp: "append" },
    ),
    ev("step/end", 6, { turn: 1, step: 1 }),
    ev("step/start", 7, { turn: 1, step: 2 }),
    ev(
      "assistant/message",
      8,
      {
        turn: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: enveloped("assistant", NOTICE_BODY_MARK) }],
        },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "developer/message",
      9,
      {
        turn: 1,
        step: 2,
        message: { role: "developer", source: { kind: "handoff" }, content: [] },
      },
      { surfaceOp: { op: "replace", startSeq: 2, endSeq: 8 }, sourceEventSeqs: [2, 8] },
    ),
    ev("agent/inbox/spliced", 10, { target: "next-step", start: 0, inserted: [] }),
    ev("step/end", 11, { turn: 1, step: 2 }),
    ev("step/start", 12, { turn: 1, step: 3 }),
    ev(
      "user/message",
      13,
      {
        role: "user",
        content: [{ type: "text", text: injected("context-compacted", NOTICE_MARK) }],
        source: { kind: "handoff" },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "user/message",
      14,
      {
        role: "user",
        content: [{ type: "text", text: enveloped("user", NOTICE_CONTINUE_MARK) }],
        source: { kind: "user" },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "assistant/message",
      15,
      {
        turn: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: enveloped("assistant", "文件式交接后的回答") }],
        },
      },
      { surfaceOp: "append" },
    ),
    ev("turn/end", 16, { turn: 1 }),
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

function showMd(
  extra: readonly string[] = [],
  target = MAIN_ID,
): { content: string; summary: string } {
  const result = runCli(["show", target, ...baseArgs(), ...extra]);
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

/**
 * 执行 show 并解析 JSON 产物（--format json）。
 *
 * `text` 是可选的：`tool/call` 条目只有 arguments，没有 text 字段。
 */
function showJson(target: string): {
  messages: Array<{ type: string; text?: string }>;
} {
  const result = runCli(["show", target, ...baseArgs(), "--format", "json"]);
  assert.equal(result.status, 0, `show --format json 失败: ${result.stderr}`);
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  const pathMatch = /^完整输出已保存到: (.+)$/u.exec(lines[0]);
  if (pathMatch === null) throw new Error("stdout 首行不符合契约");
  return JSON.parse(readFileSync(pathMatch[1], "utf8")) as {
    messages: Array<{ type: string; text?: string }>;
  };
}

/** 执行 search 并返回指定会话在 json 产物里的命中标签。 */
function searchLabels(keyword: string, target: string): string[] {
  const result = runCli(["search", keyword, ...baseArgs(), "--format", "json"]);
  assert.equal(result.status, 0, `search 失败: ${result.stderr}`);
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  const pathMatch = /^完整输出已保存到: (.+)$/u.exec(lines[0]);
  if (pathMatch === null) throw new Error("stdout 首行不符合契约");
  const document = JSON.parse(readFileSync(pathMatch[1], "utf8")) as {
    matches: Array<{ sessionId: string; label: string }>;
  };
  return document.matches.filter((match) => match.sessionId === target).map((match) => match.label);
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
        title: "文件式交接主夹具",
        turns: 1,
        steps: 2,
        lastPromptAt: 2000,
      },
      {
        id: NOTICE_ID,
        projectDir: PROJECT_DIR,
        createdAt: 900,
        events: handoffNoticeEvents(),
        title: "文件式交接夹具",
        turns: 1,
        steps: 3,
        lastPromptAt: 1900,
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
      content.includes(
        `前置助手消息 seq 2（${String([...BODY_MARK].length)} 字符）；交接通知 seq 5`,
      ),
      true,
    );
  });

  it("助手回复只出现一次，不产生上下文摘要，维护指令与通知各自成条", () => {
    const { content } = showMd();
    assert.equal(countOf(content, BODY_MARK), 1);
    assert.equal(countOf(content, "**上下文摘要**："), 0);
    assert.equal(countOf(content, "**交接指令**："), 1);
    assert.equal(content.includes(MAIN_INSTRUCTION_MARK), true);
    assert.equal(countOf(content, "**交接通知**："), 1);
    assert.equal(content.includes(MAIN_NOTICE_MARK), true);
    // 消息信封与注入标记都是传输层形态：任何可读正文都不得带它们的起点行或终点行。
    assert.equal(content.includes("<dsh-message"), false);
    assert.equal(content.includes("</dsh-message>"), false);
    assert.equal(content.includes("<dsh-injection"), false);
    // 旧自定义摘要投递已删除：默认视图不再出现 `<compacted-summary>` 标签。
    assert.equal(content.includes("<compacted-summary>"), false);
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
    // 轮次大纲的 response 同样取剥离后的助手正文，不得带信封标记。
    assert.equal(content.includes(NORMAL_MARK), true);
    assert.equal(content.includes("<dsh-message"), false);
  });

  it("--role 不影响交接条目与交接通知，但助手正文按角色过滤", () => {
    const { content } = showMd(["--role", "user"]);
    assert.equal(countOf(content, "**交接**："), 1);
    assert.equal(countOf(content, "**交接通知**："), 1);
    assert.equal(content.includes(MAIN_NOTICE_MARK), true);
    assert.equal(content.includes(BODY_MARK), false);
  });

  it("--format json 不新增条目类型：messages 里没有 developer/message，助手正文只出现一次", () => {
    const result = runCli(["show", MAIN_ID, ...baseArgs(), "--format", "json"]);
    assert.equal(result.status, 0, `show --format json 失败: ${result.stderr}`);
    const lines = result.stdout.split("\n").filter((line) => line.length > 0);
    const pathMatch = /^完整输出已保存到: (.+)$/u.exec(lines[0]);
    if (pathMatch === null) throw new Error("stdout 首行不符合契约");
    const document = JSON.parse(readFileSync(pathMatch[1], "utf8")) as {
      messages: { type: string; text: string }[];
    };
    const types = document.messages.map((message) => message.type);
    assert.equal(types.includes("developer/message"), false);
    assert.equal(types.includes("user/message"), true);
    assert.equal(types.includes("assistant/message"), true);
    assert.equal(document.messages.filter((message) => message.text.includes(BODY_MARK)).length, 1);
  });
});

describe("文件式交接的默认呈现", () => {
  it("维护指令、交接结构、通知与助手回复各自成条，正文只出现一次", () => {
    const { content } = showMd([], NOTICE_ID);
    assert.equal(countOf(content, "**交接**："), 1);
    assert.equal(
      content.includes(
        `前置助手消息 seq 8（${String([...NOTICE_BODY_MARK].length)} 字符）；交接通知 seq 13`,
      ),
      true,
    );
    assert.equal(countOf(content, "**交接指令**："), 1);
    assert.equal(content.includes(NOTICE_INSTRUCTION_MARK), true);
    assert.equal(countOf(content, "**交接通知**："), 1);
    assert.equal(content.includes(NOTICE_MARK), true);
    // 文件式交接不投递摘要，助手回复只由助手条目承载。
    assert.equal(countOf(content, "**上下文摘要**："), 0);
    assert.equal(countOf(content, NOTICE_BODY_MARK), 1);
    // 注入标记是传输层形态，任何可读正文都不得带它。
    assert.equal(content.includes("<dsh-injection"), false);
  });

  it("维护指令与压缩通知不进入轮次大纲，用户继续成为 prompt", () => {
    const { content } = showMd(["--summary"], NOTICE_ID);
    assert.equal(content.includes("**交接**"), false);
    assert.equal(content.includes("**交接指令**"), false);
    assert.equal(content.includes("**交接通知**"), false);
    assert.equal(content.includes(NOTICE_MARK), false);
    assert.equal(content.includes(NOTICE_CONTINUE_MARK), true);
  });

  it("--role user 不影响交接通知，但助手正文按角色过滤", () => {
    const { content } = showMd(["--role", "user"], NOTICE_ID);
    assert.equal(countOf(content, "**交接通知**："), 1);
    assert.equal(content.includes(NOTICE_MARK), true);
    assert.equal(content.includes(NOTICE_BODY_MARK), false);
  });

  it("--events 下交接条目仍只有一条，且不再以通用事件形态重复出现", () => {
    const { content } = showMd(["--events"], NOTICE_ID);
    assert.equal(countOf(content, "**交接**："), 1);
    // 本会话没有非 handoff 型的 developer/message，因此 `--events` 下不得再出现通用事件形态。
    assert.equal(countOf(content, "developer/message"), 0);
  });

  it("JSON messages 里通知与维护指令都是 user/message，正文已剥离注入信封", () => {
    const document = showJson(NOTICE_ID);
    const noticeEntry = document.messages.find((message) => message.text?.includes(NOTICE_MARK));
    assert.equal(noticeEntry?.type, "user/message");
    assert.equal(noticeEntry?.text, NOTICE_MARK);
    const instructionEntry = document.messages.find((message) =>
      message.text?.includes(NOTICE_INSTRUCTION_MARK),
    );
    assert.equal(instructionEntry?.type, "user/message");
    assert.equal(instructionEntry?.text, NOTICE_INSTRUCTION_MARK);
    assert.equal(
      document.messages.filter((message) => message.text === NOTICE_BODY_MARK).length,
      1,
    );
    assert.equal(
      document.messages.some((message) => message.type === "developer/message"),
      false,
    );
  });

  it("search 的 text 档按新标签命中，各合成消息互不混淆", () => {
    assert.deepEqual(searchLabels(NOTICE_MARK, NOTICE_ID), ["交接通知"]);
    assert.deepEqual(searchLabels(NOTICE_INSTRUCTION_MARK, NOTICE_ID), ["交接指令"]);
    assert.deepEqual(searchLabels(NOTICE_BODY_MARK, NOTICE_ID), ["assistant"]);
    assert.deepEqual(searchLabels(NOTICE_CONTINUE_MARK, NOTICE_ID), ["user"]);
  });
});
