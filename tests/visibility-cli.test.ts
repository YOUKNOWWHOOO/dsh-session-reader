// 测试：默认参数下的注入过滤端到端行为——show 默认视图、`--events` 恢复、`--tools` 与注入过滤的
// 相互独立、子代理任务与发往子代理条目的呈现、调度回执隐藏、排除计数、search 默认档同口径。
// 依据：默认参数只保留携带真实交流内容的消息（判定真值源 scripts\lib\visibility.ts）。
// 说明：本文件用合成 DSH_HOME 与真实官方格式库跑 CLI，断言的是"产物里有什么、没有什么"。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultLibRoot, resolveDshHome } from "../scripts/lib/paths.ts";
import { type FixtureEvent, resetTempDir, writeFixtureHome } from "./fixtures.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/session-reader.ts", import.meta.url));
const LIB_ROOT = defaultLibRoot(resolveDshHome(undefined, process.env, homedir()));
// 该套用例要用真实的官方格式库；定位不到时立刻失败，不进入后续以 undefined 为入参的路径。
if (LIB_ROOT === undefined) {
  throw new Error(
    "默认锚点未能唯一确定官方格式库，visibility-cli.test.ts 无法运行；请用 --lib-root 或修复安装树定位",
  );
}
// 显式收窄一次：函数体内的使用点不会被顶层守卫的收窄覆盖，因此在此固定为字符串。
const REQUIRED_LIB_ROOT: string = LIB_ROOT;
const TEMP_ROOT = fileURLToPath(new URL("./.tmp/visibility-cli", import.meta.url));
const HOME = join(TEMP_ROOT, "visibility-dsh");
const OUT_DIR = join(TEMP_ROOT, "out");
const PROJECT_DIR = "--C-Users-Alice-user_projects--";

const MAIN_ID = "session-visibility-main-01";
const CHILD_ID = "visibility-child-aaaa-1111-222233334444";
const OUTLINE_ID = "session-visibility-outline-02";

const CALL_ID = "call_subagent_1";
const PROMPT = "子代理任务正文 PROMT-MARK";
const SEND_MESSAGE = "后续消息正文 SEND-MARK";
const RECEIPT = "started subagent visibility-child-aaaa-1111-222233334444";

function ev(
  type: string,
  seq: number,
  time: number,
  data: Record<string, unknown>,
  extra?: { readonly surfaceOp?: unknown; readonly sourceEventSeqs?: readonly number[] },
): FixtureEvent {
  return { type, seq, time, data, ...extra };
}

/** 主会话事件：四类注入 + 子代理调度 + 回执 + 用户与助手正文，并按配对关系给出 tool/result。 */
function mainEvents(): FixtureEvent[] {
  return [
    ev("turn/start", 0, 10, { turn: 1 }),
    ev(
      "user/message",
      1,
      11,
      {
        role: "user",
        content: [{ type: "text", text: "用户正文 USER-MARK" }],
        source: { kind: "user" },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "user/message",
      2,
      12,
      {
        role: "user",
        content: [{ type: "text", text: "Current runtime context. This snapshot …" }],
        source: { kind: "runtime-context" },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "user/message",
      3,
      13,
      {
        role: "user",
        content: [{ type: "text", text: "<system-reminder>技能目录 CATALOG-MARK" }],
        source: { kind: "skill-catalog" },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "user/message",
      4,
      14,
      {
        role: "user",
        content: [
          { type: "text", text: '<dsh-injection kind="tool-jobs" src="tool-jobs">JOB-MARK' },
        ],
        source: { kind: "tool-jobs" },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "user/message",
      5,
      15,
      {
        role: "user",
        content: [{ type: "text", text: "[model changed: …] MODEL-MARK" }],
        source: { kind: "model-selection" },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "user/message",
      6,
      16,
      {
        role: "user",
        content: [{ type: "text", text: "子代理结算 SETTLED-MARK" }],
        source: { kind: "subagent-settled", senderSessionId: CHILD_ID },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "tool/call",
      7,
      17,
      {
        turn: 1,
        step: 1,
        callId: CALL_ID,
        name: "subagent",
        arguments: JSON.stringify({
          description: "审计测试术语",
          provider: "p",
          model: "m",
          prompt: PROMPT,
        }),
      },
      { surfaceOp: "append" },
    ),
    ev(
      "tool/result",
      8,
      18,
      {
        turn: 1,
        step: 1,
        message: {
          role: "tool",
          source: { kind: "tool", callId: CALL_ID },
          toolCallId: CALL_ID,
          isError: false,
          content: [{ type: "text", text: RECEIPT }],
        },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "tool/call",
      9,
      19,
      {
        turn: 1,
        step: 1,
        callId: "call_send_1",
        name: "send_message",
        arguments: JSON.stringify({ agent_id: CHILD_ID, message: SEND_MESSAGE }),
      },
      { surfaceOp: "append" },
    ),
    ev(
      "tool/result",
      10,
      20,
      {
        turn: 1,
        step: 1,
        message: {
          role: "tool",
          source: { kind: "tool", callId: "call_send_1" },
          toolCallId: "call_send_1",
          isError: false,
          content: [{ type: "text", text: "消息已送达 DELIVERED-MARK" }],
        },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "assistant/message",
      11,
      21,
      {
        turn: 1,
        message: { role: "assistant", content: [{ type: "text", text: "助手正文 ASSIST-MARK" }] },
      },
      { surfaceOp: "append" },
    ),
    ev("session/title", 12, 22, {
      title: "可见性夹具",
      messageSeqs: [1],
      source: { kind: "fallback" },
    }),
    ev("turn/end", 13, 23, { turn: 1 }),
  ];
}

/** 子会话事件：同样含一条注入与一条用户正文，用于验证子代理块沿用同一可见性。 */
function childEvents(): FixtureEvent[] {
  return [
    ev("turn/start", 0, 10, { turn: 1 }),
    ev(
      "user/message",
      1,
      11,
      {
        role: "user",
        content: [{ type: "text", text: "子代理收到的任务 CHILD-TASK-MARK" }],
        source: { kind: "user" },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "user/message",
      2,
      12,
      {
        role: "user",
        content: [{ type: "text", text: "Current runtime context. CHILD-SNAPSHOT-MARK" }],
        source: { kind: "runtime-context" },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "assistant/message",
      3,
      13,
      {
        turn: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "子代理回复 CHILD-REPLY-MARK" }],
        },
      },
      { surfaceOp: "append" },
    ),
    ev("turn/end", 4, 14, { turn: 1 }),
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

function searchMd(keyword: string, extra: readonly string[] = []): string {
  const result = runCli(["search", keyword, ...baseArgs(), ...extra]);
  assert.equal(result.status, 0, `search 失败: ${result.stderr}`);
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  const pathMatch = /^完整输出已保存到: (.+)$/u.exec(lines[0]);
  assert.notEqual(pathMatch, null);
  if (pathMatch === null) throw new Error("unreachable");
  return readFileSync(pathMatch[1], "utf8");
}

before(() => {
  resetTempDir(TEMP_ROOT);
  writeFixtureHome(HOME, {
    sessions: [
      {
        id: MAIN_ID,
        projectDir: PROJECT_DIR,
        createdAt: 1000,
        events: mainEvents(),
        title: "可见性夹具",
        turns: 1,
        steps: 1,
        lastPromptAt: 2000,
      },
      {
        id: CHILD_ID,
        projectDir: PROJECT_DIR,
        createdAt: 1100,
        events: childEvents(),
        parentSession: MAIN_ID,
        origin: "subagent",
        title: "子代理夹具",
        turns: 1,
        steps: 1,
        lastPromptAt: 2100,
      },
    ],
  });
});

describe("默认参数的注入过滤", () => {
  it("默认视图保留用户与助手正文、子代理结算，排除四类注入", () => {
    const { content } = showMd();
    assert.equal(content.includes("USER-MARK"), true);
    assert.equal(content.includes("ASSIST-MARK"), true);
    assert.equal(content.includes("SETTLED-MARK"), true);
    for (const marker of ["CATALOG-MARK", "JOB-MARK", "MODEL-MARK", "This snapshot"]) {
      assert.equal(content.includes(marker), false, `${marker} 不应出现在默认视图`);
    }
    assert.equal(content.includes("已排除 4 条框架注入（--events 显示）"), true);
    assert.equal(content.includes("已排除 1 条子代理调度回执（--tools 显示）"), true);
  });

  it("--events 恢复被排除的注入，且不再计入排除数", () => {
    const { content } = showMd(["--events"]);
    for (const marker of ["CATALOG-MARK", "JOB-MARK", "MODEL-MARK", "This snapshot"]) {
      assert.equal(content.includes(marker), true, `${marker} 应在 --events 下出现`);
    }
    assert.equal(content.includes("已排除 4 条框架注入"), false);
  });

  it("子代理任务与发往子代理的正文默认呈现，调度回执默认不呈现", () => {
    const { content } = showMd();
    assert.equal(content.includes("**子代理任务**（`审计测试术语`）："), true);
    assert.equal(content.includes(PROMPT), true);
    assert.equal(content.includes("**发往子代理**（"), true);
    assert.equal(content.includes(SEND_MESSAGE), true);
    assert.equal(content.includes(RECEIPT), false);
  });

  it("--tools 不解除注入过滤，也不改变子代理任务的专用条目", () => {
    const { content } = showMd(["--tools"]);
    assert.equal(content.includes("CATALOG-MARK"), false);
    assert.equal(content.includes("JOB-MARK"), false);
    assert.equal(content.includes("**子代理任务**（`审计测试术语`）："), true);
    assert.equal(content.includes(RECEIPT), true, "--tools 下回执作为原始工具结果可见");
    // 同一调用不重复呈现：专用条目取代原始工具条目。
    assert.equal(content.includes("**工具调用**（`subagent`）"), false);
  });

  it("--subagents 的子代理块沿用同一可见性", () => {
    const { content } = showMd(["--subagents"]);
    assert.equal(content.includes("CHILD-TASK-MARK"), true);
    assert.equal(content.includes("CHILD-REPLY-MARK"), true);
    assert.equal(content.includes("CHILD-SNAPSHOT-MARK"), false);
  });

  it("search 默认档与默认提取同口径：注入不可命中，--scope all 可取回", () => {
    const byDefault = searchMd("CATALOG-MARK");
    assert.equal(byDefault.includes("命中总数：0"), true);
    // 排除量按**库内纳入会话**累加：主会话 4 条注入 + 子会话 1 条注入、回执 1 条（主会话）。
    assert.equal(
      byDefault.includes("已排除 5 条框架注入与 1 条子代理调度回执（--scope all 可检索）"),
      true,
    );
    const exhaustive = searchMd("CATALOG-MARK", ["--scope", "all"]);
    assert.equal(exhaustive.includes("命中总数：0"), false);
    assert.equal(exhaustive.includes("已排除"), false, "穷尽档不做排除，也不声明排除量");
    // `tools` 档同样排除注入与回执：两档的排除量一致，与 `all` 档的穷尽性形成对照。
    const tools = searchMd("CATALOG-MARK", ["--scope", "tools"]);
    assert.equal(tools.includes("命中总数：0"), true);
    assert.equal(
      tools.includes("已排除 5 条框架注入与 1 条子代理调度回执（--scope all 可检索）"),
      true,
    );
    const receipt = searchMd("started subagent");
    assert.equal(receipt.includes("命中总数：0"), true, "回执在默认档不可命中");
  });

  it("show --format json 的 messages 与默认视图同口径", () => {
    const result = runCli(["show", MAIN_ID, ...baseArgs(), "--format", "json"]);
    assert.equal(result.status, 0, `show json 失败: ${result.stderr}`);
    const lines = result.stdout.split("\n").filter((line) => line.length > 0);
    const pathMatch = /^完整输出已保存到: (.+)$/u.exec(lines[0]);
    assert.notEqual(pathMatch, null);
    if (pathMatch === null) throw new Error("unreachable");
    const document = JSON.parse(readFileSync(pathMatch[1], "utf8")) as {
      messages: { type: string; text: string }[];
    };
    const texts = document.messages.map((entry) => entry.text).join("\n");
    assert.equal(texts.includes("USER-MARK"), true);
    assert.equal(texts.includes("SETTLED-MARK"), true);
    assert.equal(texts.includes("CATALOG-MARK"), false);
    assert.equal(texts.includes("JOB-MARK"), false);
    assert.equal(texts.includes(RECEIPT), false);
  });

  it("轮次大纲与 json 的 turns 也不把注入消息当成用户提问", () => {
    // 主会话首轮：turn/start 之后紧跟两条注入，再跟真实用户消息。若轮次大纲不过滤注入，
    // 首轮 prompt 就会落到注入内容上，而时间线里看不到它（实测某会话落到 user-approval 通知）。
    const events: FixtureEvent[] = [
      ev("turn/start", 0, 10, { turn: 1 }),
      ev(
        "user/message",
        1,
        11,
        {
          role: "user",
          content: [{ type: "text", text: "注入快照 OUTLINE-SNAPSHOT-MARK" }],
          source: { kind: "runtime-context" },
        },
        { surfaceOp: "append" },
      ),
      ev(
        "user/message",
        2,
        12,
        {
          role: "user",
          content: [{ type: "text", text: "用户真提问 OUTLINE-PROMPT-MARK" }],
          source: { kind: "user" },
        },
        { surfaceOp: "append" },
      ),
      ev(
        "assistant/message",
        3,
        13,
        {
          turn: 1,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "助手回答 OUTLINE-REPLY-MARK" }],
          },
        },
        { surfaceOp: "append" },
      ),
      ev("turn/end", 4, 14, { turn: 1 }),
    ];
    // 独立子目录：与主夹具的 DSH_HOME 平级隔离，避免两者互相影响。
    const home = join(TEMP_ROOT, "outline", "outline-dsh");
    writeFixtureHome(home, {
      sessions: [
        {
          id: OUTLINE_ID,
          projectDir: PROJECT_DIR,
          createdAt: 1000,
          events,
          title: "轮次大纲夹具",
          turns: 1,
          steps: 1,
          lastPromptAt: 2000,
        },
      ],
    });
    const args = ["--dsh-home", home, "--lib-root", REQUIRED_LIB_ROOT, "--output-dir", OUT_DIR];
    const mdResult = runCli(["show", OUTLINE_ID, ...args, "--summary"]);
    assert.equal(mdResult.status, 0, `show --summary 失败: ${mdResult.stderr}`);
    const mdLines = mdResult.stdout.split("\n").filter((line) => line.length > 0);
    const mdPath = /^完整输出已保存到: (.+)$/u.exec(mdLines[0])?.[1];
    assert.notEqual(mdPath, undefined);
    const outline = readFileSync(mdPath ?? "", "utf8");
    assert.equal(outline.includes("OUTLINE-PROMPT-MARK"), true);
    assert.equal(outline.includes("OUTLINE-REPLY-MARK"), true);
    assert.equal(outline.includes("OUTLINE-SNAPSHOT-MARK"), false, "注入内容不得成为轮次 prompt");

    const jsonResult = runCli(["show", OUTLINE_ID, ...args, "--summary", "--format", "json"]);
    assert.equal(jsonResult.status, 0, `show --summary --format json 失败: ${jsonResult.stderr}`);
    const jsonLines = jsonResult.stdout.split("\n").filter((line) => line.length > 0);
    const jsonPath = /^完整输出已保存到: (.+)$/u.exec(jsonLines[0])?.[1];
    assert.notEqual(jsonPath, undefined);
    const document = JSON.parse(readFileSync(jsonPath ?? "", "utf8")) as {
      turns: { prompt: string | null; response: string | null }[];
    };
    assert.equal(document.turns[0]?.prompt?.includes("OUTLINE-PROMPT-MARK"), true);
    assert.equal(document.turns[0]?.prompt?.includes("OUTLINE-SNAPSHOT-MARK"), false);
  });
});
