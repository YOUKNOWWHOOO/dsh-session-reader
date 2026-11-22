// 测试：默认参数下的注入过滤端到端行为，show 默认视图、`--events` 恢复、`--tools` 与注入过滤的
// 相互独立、子代理任务与发往代理条目的呈现、调度回执隐藏、排除计数、search 默认档同口径。
// 依据：默认参数只保留携带真实交流内容的消息（判定真值源 scripts\lib\visibility.ts）。
// 说明：本文件用合成 DSH_HOME 与真实官方格式库跑 CLI，断言的是"产物里有什么、没有什么"。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { asArray, asRecord, readNumber, readString } from "../scripts/lib/decode.ts";
import { defaultLibRoot } from "../scripts/lib/paths.ts";
import { type FixtureEvent, resetTempDir, writeFixtureHome } from "./fixtures.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/session-reader.ts", import.meta.url));
const LIB_ROOT = defaultLibRoot();
// 该套用例要用真实的官方格式库；定位不到时立刻失败，不进入后续以 undefined 为入参的路径。
if (LIB_ROOT === undefined) {
  throw new Error(
    "默认锚点未能定位桌面版安装内的官方格式库，visibility-cli.test.ts 无法运行；请用 --lib-root 或修复安装树定位",
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
const FORK_CALL_ID = "call_subagent_fork_1";
const FORK_PROMPT = "子代理任务正文 FORK-PROMPT-MARK";
const FORK_DESCRIPTION = "并行审计";
const SEND_MESSAGE = "后续消息正文 SEND-MARK";
const RECEIPT = "started subagent visibility-child-aaaa-1111-222233334444";
const FORK_RECEIPT = "started subagent visibility-fork-child-bbbb-5555-666677778888";
const PROVIDER_ARG = "PROVIDER-ARG-MARK";

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
          provider: PROVIDER_ARG,
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
        callId: FORK_CALL_ID,
        name: "subagent_fork",
        arguments: JSON.stringify({
          description: FORK_DESCRIPTION,
          prompt: FORK_PROMPT,
        }),
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
          source: { kind: "tool", callId: FORK_CALL_ID },
          toolCallId: FORK_CALL_ID,
          isError: false,
          content: [{ type: "text", text: FORK_RECEIPT }],
        },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "tool/call",
      11,
      21,
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
      12,
      22,
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
      13,
      23,
      {
        turn: 1,
        message: { role: "assistant", content: [{ type: "text", text: "助手正文 ASSIST-MARK" }] },
      },
      { surfaceOp: "append" },
    ),
    ev("session/title", 14, 24, {
      title: "可见性夹具",
      messageSeqs: [1],
      source: { kind: "fallback" },
    }),
    ev("turn/end", 15, 25, { turn: 1 }),
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
    // process.execPath 可能是桌面版 Electron 可执行文件；该变量让子进程以 Node 形态运行
    // （普通 Node 忽略它）。
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

function searchMd(keyword: string, extra: readonly string[] = []): string {
  const result = runCli(["search", keyword, ...baseArgs(), ...extra]);
  assert.equal(result.status, 0, `search 失败: ${result.stderr}`);
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  const pathMatch = /^完整输出已保存到: (.+)$/u.exec(lines[0]);
  assert.notEqual(pathMatch, null);
  if (pathMatch === null) throw new Error("unreachable");
  return readFileSync(pathMatch[1], "utf8");
}

/** 检索 JSON 产物：只取断言需要的命中标签与命中总数。 */
interface SearchDocument {
  readonly labels: string[];
  readonly total: number;
  readonly excludedAgentMessages: number;
}

function searchJson(
  keyword: string,
  scope: "text" | "tools" | "all" = "text",
  extra: readonly string[] = [],
): SearchDocument {
  const result = runCli([
    "search",
    keyword,
    ...baseArgs(),
    "--scope",
    scope,
    "--format",
    "json",
    ...extra,
  ]);
  assert.equal(result.status, 0, `search --format json 失败: ${result.stderr}`);
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  const pathMatch = /^完整输出已保存到: (.+)$/u.exec(lines[0]);
  assert.notEqual(pathMatch, null);
  if (pathMatch === null) throw new Error("unreachable");
  const parsed: unknown = JSON.parse(readFileSync(pathMatch[1], "utf8"));
  const document = asRecord(parsed);
  assert.notEqual(document, undefined, "检索 JSON 顶层不是对象");
  if (document === undefined) throw new Error("检索 JSON 顶层不是对象");
  const matches = asArray(document.matches);
  assert.notEqual(matches, undefined, "检索 JSON 缺少 matches 数组");
  if (matches === undefined) throw new Error("检索 JSON 缺少 matches 数组");
  const total = readNumber(document, "total");
  assert.notEqual(total, undefined, "检索 JSON 缺少 total 数字");
  if (total === undefined) throw new Error("检索 JSON 缺少 total 数字");
  const labels: string[] = [];
  for (const match of matches) {
    const record = asRecord(match);
    assert.notEqual(record, undefined, "检索命中项不是对象");
    if (record === undefined) throw new Error("检索命中项不是对象");
    const label = readString(record, "label");
    assert.notEqual(label, undefined, "检索命中项缺少字符串 label");
    if (label === undefined) throw new Error("检索命中项缺少字符串 label");
    labels.push(label);
  }
  const excludedAgentMessages = readNumber(document, "excludedAgentMessages");
  assert.notEqual(excludedAgentMessages, undefined);
  if (excludedAgentMessages === undefined) throw new Error("检索 JSON 缺少通信排除数");
  return { labels, total, excludedAgentMessages };
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

after(() => rmSync(TEMP_ROOT, { recursive: true, force: true }));

describe("默认参数的注入过滤", () => {
  it("默认视图保留用户与助手正文，排除代理通信和四类注入", () => {
    const { content } = showMd();
    assert.equal(content.includes("USER-MARK"), true);
    assert.equal(content.includes("ASSIST-MARK"), true);
    assert.equal(content.includes("SETTLED-MARK"), false);
    assert.equal(content.includes("已排除 5 条与其它 agent 的通信"), true);
    for (const marker of ["CATALOG-MARK", "JOB-MARK", "MODEL-MARK", "This snapshot"]) {
      assert.equal(content.includes(marker), false, `${marker} 不应出现在默认视图`);
    }
    assert.equal(content.includes("已排除 4 条框架注入（--events 显示）"), true);
    assert.equal(content.includes("已排除 2 条子代理调度回执（--tools 显示）"), true);
  });

  it("--events 恢复被排除的注入，且不再计入排除数", () => {
    const { content } = showMd(["--events"]);
    for (const marker of ["CATALOG-MARK", "JOB-MARK", "MODEL-MARK", "This snapshot"]) {
      assert.equal(content.includes(marker), true, `${marker} 应在 --events 下出现`);
    }
    assert.equal(content.includes("已排除 4 条框架注入"), false);
    assert.equal(content.includes("SETTLED-MARK"), false);
  });

  it("通信计数不受 role、events、tools 和 head 影响", () => {
    for (const extra of [
      ["--role", "user"],
      ["--role", "assistant"],
      ["--events", "--tools"],
      ["--head", "1"],
    ]) {
      const content = showMd(extra).content;
      assert.ok(content.includes("已排除 5 条与其它 agent 的通信"));
      assert.equal(content.includes("SETTLED-MARK"), false);
      assert.equal(content.includes("DELIVERED-MARK"), false);
    }
  });

  it("--turn 与 --seq 范围精确计数，--head 不改变区间计数", () => {
    const turn = showMd(["--turn", "1"]).content;
    assert.equal(turn.includes("已排除 5 条与其它 agent 的通信"), true);

    // seq 6-10 包含 settled、subagent、fork 及其两条创建回执，通信事件为 3 条，回执为 2 条。
    const ranged = showMd(["--seq", "6-10"]).content;
    assert.equal(ranged.includes("已排除 3 条与其它 agent 的通信"), true);
    assert.equal(ranged.includes("已排除 2 条子代理调度回执"), true);

    const rangedHead = showMd(["--seq", "6-10", "--head", "1"]).content;
    assert.equal(rangedHead.includes("已排除 3 条与其它 agent 的通信"), true);
    assert.equal(rangedHead.includes("已排除 2 条子代理调度回执"), true);
  });

  it("显式开启后呈现两个创建工具的任务和发往代理的消息", () => {
    const { content } = showMd(["--include-agent-comm"]);
    assert.equal(content.includes("**子代理任务**（`审计测试术语`）："), true);
    assert.equal(content.includes(PROMPT), true);
    assert.equal(content.includes(`**子代理任务**（\`${FORK_DESCRIPTION}\`）：`), true);
    assert.equal(content.includes(FORK_PROMPT), true);
    assert.equal(content.includes("**发往代理**（"), true);
    assert.equal(content.includes(SEND_MESSAGE), true);
    assert.equal(content.includes(RECEIPT), false);
    assert.equal(content.includes(FORK_RECEIPT), false);
    // 调度参数不是交流内容，默认视图不呈现。
    assert.equal(content.includes(PROVIDER_ARG), false);
  });

  it("--tools 不恢复通信，创建回执仍按工具结果展示", () => {
    const { content } = showMd(["--tools"]);
    assert.equal(content.includes("CATALOG-MARK"), false);
    assert.equal(content.includes("JOB-MARK"), false);
    assert.equal(content.includes(PROMPT), false);
    assert.equal(content.includes(FORK_PROMPT), false);
    assert.equal(content.includes(SEND_MESSAGE), false);
    assert.equal(content.includes(RECEIPT), true, "--tools 下回执作为原始工具结果可见");
    assert.equal(content.includes(FORK_RECEIPT), true, "--tools 下回执作为原始工具结果可见");
    assert.equal(content.includes("DELIVERED-MARK"), false);
    // 同一调用不重复呈现：专用条目取代原始工具条目。
    assert.equal(content.includes("**工具调用**（`subagent`）"), false);
    assert.equal(content.includes("**工具调用**（`subagent_fork`）"), false);
    assert.equal(content.includes("**工具调用**（`send_message`）"), false);
  });

  it("通信开关与 --tools 同时打开时发送结果可见", () => {
    const { content } = showMd(["--include-agent-comm", "--tools"]);
    assert.equal(content.includes("DELIVERED-MARK"), true);
    assert.equal(content.includes(RECEIPT), true);
    assert.equal(content.includes(FORK_RECEIPT), true);
  });

  it("--subagents 的子代理块沿用同一可见性", () => {
    const { content } = showMd(["--subagents"]);
    assert.equal(content.includes("CHILD-TASK-MARK"), false);
    assert.equal(content.includes("CHILD-REPLY-MARK"), false);
    assert.equal(content.includes("CHILD-SNAPSHOT-MARK"), false);
    const included = showMd(["--subagents", "--include-agent-comm"]).content;
    assert.equal(included.includes("CHILD-TASK-MARK"), true);
    assert.equal(included.includes("CHILD-REPLY-MARK"), true);
  });

  it("search 默认档与默认提取同口径：注入不可命中，--scope all 可取回", () => {
    const byDefault = searchMd("CATALOG-MARK");
    assert.equal(byDefault.includes("命中总数：0"), true);
    // 排除量按**库内纳入会话**累加：主会话 4 条注入 + 子会话 1 条注入；创建回执 2 条（主会话）。
    // `send_message` 的结果不是创建回执，不进入该计数。
    assert.equal(
      byDefault.includes("已排除 5 条框架注入与 2 条子代理调度回执（--scope all 可检索）"),
      true,
    );
    const exhaustive = searchMd("CATALOG-MARK", ["--scope", "all"]);
    assert.equal(exhaustive.includes("命中总数：0"), false);
    assert.equal(exhaustive.includes("已排除"), false, "穷尽档不做排除，也不声明排除量");
    // `tools` 档同样排除注入与回执：两档的排除量一致，与 `all` 档的穷尽性形成对照。
    const tools = searchMd("CATALOG-MARK", ["--scope", "tools"]);
    assert.equal(tools.includes("命中总数：0"), true);
    assert.equal(
      tools.includes("已排除 5 条框架注入与 2 条子代理调度回执（--scope all 可检索）"),
      true,
    );
    const receipt = searchMd("started subagent");
    assert.equal(receipt.includes("命中总数：0"), true, "回执在默认档不可命中");
  });

  it("search text 与 tools 排除通信，all 保留通信标签", () => {
    const subagent = searchJson(PROMPT);
    assert.deepEqual(subagent.labels, []);
    assert.equal(subagent.total, 0);
    const fork = searchJson(FORK_PROMPT);
    assert.deepEqual(fork.labels, []);
    assert.equal(fork.total, 0);
    const send = searchJson(SEND_MESSAGE);
    assert.deepEqual(send.labels, []);
    assert.equal(send.total, 0);
    assert.ok(searchJson(SEND_MESSAGE, "all").labels.includes("发往代理"));
    assert.equal(searchJson(PROVIDER_ARG).total, 0);
    assert.equal(searchJson(PROVIDER_ARG, "tools").total, 0);
    assert.ok(searchJson(PROVIDER_ARG, "all").total > 0);
  });

  it("search 排除数按会话记录计数，与限制条数无关，all 为零", () => {
    for (const scope of ["text", "tools"] as const) {
      assert.equal(searchJson("USER-MARK", scope).excludedAgentMessages, 7);
      assert.equal(searchJson("USER-MARK", scope, ["--limit", "1"]).excludedAgentMessages, 7);
    }
    assert.equal(searchJson("USER-MARK", "all").excludedAgentMessages, 0);
    assert.ok(
      searchMd("USER-MARK").includes("已排除 7 条与其它 agent 的通信（--scope all 可检索）"),
    );
  });

  it("search 的 tools 与 all 档在专用正文之外保留原始参数与整条事件载荷", () => {
    const tools = searchJson(PROMPT, "tools");
    assert.equal(tools.total, 0);
    const all = searchJson(PROMPT, "all");
    // 专用正文单元 + tool/call 原始参数单元 + 整条事件载荷单元。
    assert.equal(all.total, 3);
    assert.equal(all.labels.includes("子代理任务"), true);
    assert.equal(all.labels.includes("tool/call"), true);
    // send_message 的正文在 tools/all 档同样保留原始参数，计数按检索单元累计。
    assert.equal(searchJson(SEND_MESSAGE, "tools").total, 0);
    assert.equal(searchJson(SEND_MESSAGE, "all").total, 3);
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
    assert.equal(texts.includes("SETTLED-MARK"), false);
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

  it("--summary 的通信开关同步控制 md 与 json turns", () => {
    const COMM_OUTLINE_ID = "session-visibility-outline-comm-04";
    const home = join(TEMP_ROOT, "outline-comm", "outline-comm-dsh");
    const events: FixtureEvent[] = [
      ev("turn/start", 0, 10, { turn: 1 }),
      ev(
        "user/message",
        1,
        11,
        {
          role: "user",
          content: [{ type: "text", text: "通信提问 OUTLINE-COMM-PROMPT-MARK" }],
          source: { kind: "agent-message" },
        },
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
            content: [{ type: "text", text: "通信回答 OUTLINE-COMM-RESPONSE-MARK" }],
          },
        },
        { surfaceOp: "append" },
      ),
      ev("turn/end", 3, 13, { turn: 1 }),
    ];
    writeFixtureHome(home, {
      sessions: [
        {
          id: COMM_OUTLINE_ID,
          projectDir: PROJECT_DIR,
          createdAt: 1000,
          events,
          origin: "subagent",
          title: "通信轮次大纲夹具",
          turns: 1,
          steps: 1,
          lastPromptAt: 2000,
        },
      ],
    });
    const args = ["--dsh-home", home, "--lib-root", REQUIRED_LIB_ROOT, "--output-dir", OUT_DIR];
    const readOutput = (stdout: string): string => {
      const path = /^完整输出已保存到: (.+)$/u.exec(
        stdout.split("\n").filter((line) => line.length > 0)[0],
      )?.[1];
      assert.notEqual(path, undefined);
      return readFileSync(path ?? "", "utf8");
    };

    const hiddenMd = runCli(["show", COMM_OUTLINE_ID, ...args, "--summary"]);
    assert.equal(hiddenMd.status, 0, `默认摘要失败: ${hiddenMd.stderr}`);
    const hiddenMdContent = readOutput(hiddenMd.stdout);
    assert.equal(hiddenMdContent.includes("OUTLINE-COMM-PROMPT-MARK"), false);
    assert.equal(hiddenMdContent.includes("OUTLINE-COMM-RESPONSE-MARK"), false);

    const includedMd = runCli([
      "show",
      COMM_OUTLINE_ID,
      ...args,
      "--summary",
      "--include-agent-comm",
    ]);
    assert.equal(includedMd.status, 0, `通信摘要失败: ${includedMd.stderr}`);
    const includedMdContent = readOutput(includedMd.stdout);
    assert.equal(includedMdContent.includes("OUTLINE-COMM-PROMPT-MARK"), true);
    assert.equal(includedMdContent.includes("OUTLINE-COMM-RESPONSE-MARK"), true);

    const hiddenJson = runCli(["show", COMM_OUTLINE_ID, ...args, "--summary", "--format", "json"]);
    assert.equal(hiddenJson.status, 0, `默认 JSON 摘要失败: ${hiddenJson.stderr}`);
    const hiddenDocument = JSON.parse(readOutput(hiddenJson.stdout)) as {
      turns: { prompt: string | null; response: string | null }[];
    };
    assert.deepEqual(hiddenDocument.turns[0], { turn: 1, seq: 0, prompt: null, response: null });

    const includedJson = runCli([
      "show",
      COMM_OUTLINE_ID,
      ...args,
      "--summary",
      "--include-agent-comm",
      "--format",
      "json",
    ]);
    assert.equal(includedJson.status, 0, `通信 JSON 摘要失败: ${includedJson.stderr}`);
    const includedDocument = JSON.parse(readOutput(includedJson.stdout)) as {
      turns: { prompt: string | null; response: string | null }[];
    };
    assert.equal(includedDocument.turns[0]?.prompt?.includes("OUTLINE-COMM-PROMPT-MARK"), true);
    assert.equal(includedDocument.turns[0]?.response?.includes("OUTLINE-COMM-RESPONSE-MARK"), true);
  });
});

describe("内层引用的消息标记（subagent-settled 形态）", () => {
  const NESTED_ID = "session-visibility-nested-03";
  const NESTED_HOME = join(TEMP_ROOT, "nested", "nested-dsh");
  const INNER_OPEN = '<dsh-message role="assistant" id="deadbeef" ts="2026-10-29T22:59:56+08:00">';
  const INNER_CLOSE = "<\\/dsh-message>";
  const SETTLED_BODY = "子代理最终回复 SETTLED-BODY-MARK";
  const QUOTED = "引用正文 QUOTED-MARK";

  /** 一条注入消息整段引用子代理收尾发言：外层注入信封，内层带转义终点的消息标记行对。 */
  function nestedEvents(): FixtureEvent[] {
    const text = [
      '<dsh-injection kind="subagent-settled" src="child" id="1a2b3c4d" ts="2026-10-29T22:59:57+08:00">',
      SETTLED_BODY,
      INNER_OPEN,
      QUOTED,
      INNER_CLOSE,
      "</dsh-injection>",
    ].join("\n");
    return [
      ev("turn/start", 0, 10, { turn: 1 }),
      ev(
        "user/message",
        1,
        11,
        {
          role: "user",
          content: [{ type: "text", text }],
          source: { kind: "subagent-settled", senderSessionId: CHILD_ID },
        },
        { surfaceOp: "append" },
      ),
      ev("turn/end", 2, 12, { turn: 1 }),
    ];
  }

  function readOutput(stdout: string): string {
    const lines = stdout.split("\n").filter((line) => line.length > 0);
    const pathMatch = /^完整输出已保存到: (.+)$/u.exec(lines[0]);
    assert.notEqual(pathMatch, null, `stdout 首行不符合契约: ${lines[0]}`);
    if (pathMatch === null) throw new Error("unreachable");
    return readFileSync(pathMatch[1], "utf8");
  }

  before(() => {
    writeFixtureHome(NESTED_HOME, {
      sessions: [
        {
          id: NESTED_ID,
          projectDir: PROJECT_DIR,
          createdAt: 1000,
          events: nestedEvents(),
          title: "内层标记夹具",
          turns: 1,
          steps: 0,
          lastPromptAt: 2000,
        },
      ],
    });
  });

  function args(): string[] {
    return [
      "--dsh-home",
      NESTED_HOME,
      "--lib-root",
      REQUIRED_LIB_ROOT,
      "--output-dir",
      join(TEMP_ROOT, "nested", "out"),
    ];
  }

  it("show 的 md 不含内层标记行，引用正文与收尾回复都在", () => {
    const result = runCli(["show", NESTED_ID, ...args(), "--include-agent-comm"]);
    assert.equal(result.status, 0, `show 失败: ${result.stderr}`);
    const content = readOutput(result.stdout);
    assert.equal(content.includes(SETTLED_BODY), true);
    assert.equal(content.includes(QUOTED), true);
    assert.equal(content.includes("<dsh-message"), false);
    assert.equal(content.includes("<\\/dsh-message>"), false);
  });

  it("show --format json 的 text 字段同样清理", () => {
    const result = runCli([
      "show",
      NESTED_ID,
      ...args(),
      "--format",
      "json",
      "--include-agent-comm",
    ]);
    assert.equal(result.status, 0, `show json 失败: ${result.stderr}`);
    const document = JSON.parse(readOutput(result.stdout)) as {
      messages: Array<{ text: string }>;
    };
    const texts = document.messages.map((entry) => entry.text).join("\n");
    assert.equal(texts.includes(SETTLED_BODY), true);
    assert.equal(texts.includes(QUOTED), true);
    assert.equal(texts.includes("<dsh-message"), false);
    assert.equal(texts.includes("<\\/dsh-message>"), false);
  });

  it("search 的 all 档保留被过滤的通信", () => {
    const result = runCli(["search", "QUOTED-MARK", ...args(), "--scope", "all"]);
    assert.equal(result.status, 0, `search 失败: ${result.stderr}`);
    const content = readOutput(result.stdout);
    assert.equal(content.includes("QUOTED-MARK"), true);
    assert.equal(content.includes("命中总数：0"), false);
  });
});
