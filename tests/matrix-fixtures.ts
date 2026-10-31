// 用途：全组合 lint 门禁的敌意内容集、合成 DSH_HOME 的会话夹具定义与夹具 home 构造。
// 主要入口：buildFixtureHomes（清理并重建健康/损坏两套夹具 home，注入敌意模型字段）、
//           healthySpec/brokenSpec（夹具根定义，供组合矩阵与入口复用）。
// 关键依赖：./fixtures.ts（FixtureEvent/FixtureHomeSpec/writeFixtureHome）、./matrix-assert.ts（asRecord 判型）。
// 设计约束：夹具只写 workdir 下的固定子路径（fixture-healthy、fixture-broken、out），真实 dsh 主目录全程只读；
//           敌意内容集逐条对应 f2 §2.1 的 67 条，禁止增删或改写，注入点分散于消息/工具/系统/压缩/命令/
//           标题请求/web/交付物字段，注入后的 home 由端到端门禁逐产物复查。

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  askSampleErrorResult,
  askSampleMalformed,
  askSamplePaired,
  askSampleUnpaired,
  type FixtureEvent,
  type FixtureHomeSpec,
  writeFixtureHome,
} from "./fixtures.ts";
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
/**
 * 问答夹具会话 id：成对问答、未配对提问、错误态结果、结构不符的载荷。
 *
 * 四者必须是不同会话：前三个都必须能在默认参数下完整导出（其中错误态样本只呈现提问、
 * 不产出回答条目），第四个必须让单目标导出整体失败——把任何两者放进同一会话，
 * 就会让"可导出"与"必须失败"这两种行为互相覆盖而失去覆盖力。
 */
export const ASK_PAIRED_ID = "session-adv-ask-paired-17";
export const ASK_UNPAIRED_ID = "session-adv-ask-unpaired-18";
export const ASK_ERROR_ID = "session-adv-ask-error-19";
export const ASK_MALFORMED_ID = "session-adv-ask-malformed-20";
/**
 * 交接夹具会话 id：一次完整交接（助手正文 → handoff 型 `developer/message` → 投递）加一个
 * 非 handoff 型（`tool-registry`）`developer/message`。两者必须在同一会话里，门禁才能同时断言
 * 「进 `**交接**` 条目」与「仍由 `--events` 按通用事件呈现」两条路径。
 */
export const HANDOFF_ID = "session-adv-handoff-21";
/**
 * 新格式交接夹具会话 id：维护指令（来源 `handoff` 的 `handoff-instruction` 注入）→ 助手正文 →
 * handoff 型 `developer/message` → 投递 → `context-compacted` 通知。
 *
 * 与 `HANDOFF_ID` 分处两个会话：旧格式的正文由 `**上下文摘要**` 承载且抑制助手副本，新格式的正文
 * 保留在 `**助手**`、通知单独成条；混在同一会话里会让两种期望互相覆盖。
 */
export const HANDOFF_NOTICE_ID = "session-adv-handoff-notice-22";
/** 夹具主/子会话共用的工作目录（含空格、方括号与井号）。 */
export const MAIN_CWD = "C:\\Users\\Alice\\user projects [v2] #tag_under";

function ev(
  type: string,
  seq: number,
  time: number,
  data: Record<string, unknown>,
  extra?: { readonly surfaceOp?: unknown; readonly sourceEventSeqs?: readonly number[] },
): FixtureEvent {
  // 真实日志的 user/message 恒带 source，缺 source 无法证明来源，默认可见性会排除它（见 visibility.ts
  // 的 isInjectedUserMessage）。夹具因此统一补上 `{ kind: "user" }`；需要缺 source 形态的用例
  // 必须显式传一个 `source` 键（传 undefined 也会被视为已声明），以免本补全把它掩盖掉。
  const withSource =
    type === "user/message" && !("source" in data) ? { ...data, source: { kind: "user" } } : data;
  return { type, seq, time, data: withSource, ...extra };
}

/** 部署侧消息时间标记的固定时间戳；形态取自 `preset-lib/injection-boundary.mjs` 的 RFC 3339 秒级带偏移。 */
const MESSAGE_TS = "2026-10-29T22:59:57+08:00";

/**
 * 给对话消息正文套上部署侧的消息信封。
 *
 * 门禁夹具必须复现当期部署形态：真实用户消息与带文本块的 assistant 消息在会话 `append` 包装层
 * 各被加一对 `<dsh-message>`（纯工具调用的 assistant 消息不包裹）。夹具只在交接样本上使用它——
 * 其余样本的价值在于敌意内容本身，加信封只会让命中片段与快照更难对照。
 *
 * @param role 消息角色，取 `user` 或 `assistant`。
 * @param text 原始正文。
 * @returns 起点行、正文与终点行组成的信封形态。
 */
function enveloped(role: "user" | "assistant", text: string): string {
  return `<dsh-message role="${role}" id="abcdef12" ts="${MESSAGE_TS}">\n${text}\n</dsh-message>`;
}

/**
 * 投递摘要的内层：助手落账文本被原样复制进来，终点被外层包裹转义。
 *
 * 真实数据里投递消息的内层带着 `<dsh-message role="assistant">` 起点行，终点则是
 * `<\/dsh-message>`（`preset-lib/injection-boundary.mjs` 的 `wrapSegments` 对外层正文的三种终点
 * 统一转义）。门禁夹具必须复现这一形态，否则摘要正文的标记清理与助手副本抑制会在假形态下通过。
 *
 * @param text 交接正文。
 * @returns 带助手消息标记、终点已转义的文本。
 */
function deliveryInner(text: string): string {
  return enveloped("assistant", text).replace("</dsh-message>", "<\\/dsh-message>");
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
          // 该夹具刻意携带插件名（含会破坏骨架的反引号与换行由 CONTENTS 注入）：来源标注必须把
          // 插件名放进行内载体。**kind 不能写 plugin**——v4 要求 source.kind 由具体生产者声明，
          // 不存在万能类，写 plugin 会让整条日志解码失败（实测报错「requires a producer-owned
          // source kind」），门禁因此会把夹具问题当成产品缺陷。
          source: { kind: "time-context", plugin: "@deepseek-ai/dsh-system-prompt" },
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
          // v4 的工具结果是「工具」角色的一级消息：toolCallId 与 isError 是消息字段。
          role: "tool",
          id: "fixture-tool-result-1",
          toolCallId: "call_1",
          isError: false,
          source: { kind: "tool", callId: "call_1" },
          content: [{ type: "text", text: CONTENTS[7] }],
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

/**
 * 交接样本事件：生成指令 → 助手正文 → handoff 型 `developer/message` → `agent/inbox/spliced` 投递 →
 * 投递消息（正文为 `<compacted-summary>` 信封），另加一个非 handoff 型（`tool-registry`）
 * `developer/message`。
 *
 * 正文只由 `**上下文摘要**` 条目承载：助手的生成副本被抑制，投递消息是模型可见正文的落点；
 * 生成指令渲染为 `**交接指令**`（它的结构位置就是"生成正文的前一条、来源为 user、不带 rpcId"）。
 * `developer/message` 的正文保持空数组（与当期插件写入形态一致），`**交接**` 条目只呈现结构事实
 * 并用 seq 指向投递消息。非 handoff 型样本与它同处一个会话是有意的：门禁据此覆盖
 * 「进条目」与「仍由 `--events` 呈现」两条路径。
 */
function handoffSampleEvents(): FixtureEvent[] {
  return [
    ev("turn/start", 0, 10, { turn: 1 }),
    ev(
      "user/message",
      1,
      11,
      {
        role: "user",
        // 生成正文的前一条且不带 rpcId：按合成上下文消息契约，它就是交接生成指令，
        // 门禁据此覆盖 `**交接指令**` 标签。
        content: [
          {
            type: "text",
            text: enveloped("user", "从现在起，你唯一的任务是给出交接指令 PROMPT-MARK"),
          },
        ],
        source: { kind: "user" },
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
          content: [{ type: "text", text: enveloped("assistant", "交接正文 `code`\n第二行") }],
        },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "developer/message",
      3,
      13,
      {
        turn: 1,
        step: 1,
        message: { role: "developer", source: { kind: "handoff" }, content: [] },
      },
      { surfaceOp: { op: "replace", startSeq: 0, endSeq: 2 }, sourceEventSeqs: [0, 1, 2] },
    ),
    ev("agent/inbox/spliced", 4, 14, {
      target: "next-step",
      start: 0,
      inserted: [
        {
          role: "user",
          source: { kind: "user" },
          content: [
            {
              type: "text",
              text: "<compacted-summary>\n交接正文 `code`\n第二行\n</compacted-summary>",
            },
          ],
        },
      ],
    }),
    ev(
      "user/message",
      5,
      15,
      {
        role: "user",
        content: [
          {
            type: "text",
            text: enveloped(
              "user",
              `<compacted-summary>\n${deliveryInner("交接正文 `code`\n第二行")}\n</compacted-summary>`,
            ),
          },
        ],
        source: { kind: "user" },
      },
      { surfaceOp: "append" },
    ),
    ev("developer/message", 6, 16, {
      turn: 1,
      step: 2,
      message: { role: "developer", source: { kind: "tool-registry" }, content: [] },
    }),
    ev(
      "assistant/message",
      7,
      17,
      {
        turn: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: enveloped("assistant", "交接后的普通回答") }],
        },
      },
      { surfaceOp: "append" },
    ),
    ev("turn/end", 8, 18, { turn: 1, reason: { kind: "completed" } }),
  ];
}

/**
 * 新格式交接样本事件：维护指令注入 → 助手正文 → handoff 型 `developer/message` → 投递 →
 * `context-compacted` 通知。
 *
 * 两条协议消息都带部署侧的注入标记（来源 `handoff`），门禁据此覆盖 `**交接指令**` 与
 * `**交接通知**` 两个新标签；助手正文不被抑制，因此同一段正文只由 `**助手**` 承载一次。
 * 注入正文里带反引号与换行，使围栏长度与多行载体的规则也在新标签上受检。
 */
function handoffNoticeSampleEvents(): FixtureEvent[] {
  const ts = "2026-10-31T12:44:50+08:00";
  const injected = (kind: string, text: string): string =>
    `<dsh-injection kind="${kind}" src="handoff" id="abcdef12" ts="${ts}">\n${text}\n</dsh-injection>`;
  return [
    ev("turn/start", 0, 10, { turn: 1 }),
    ev(
      "user/message",
      1,
      11,
      {
        role: "user",
        content: [
          {
            type: "text",
            text: injected(
              "handoff-instruction",
              "从现在起，你唯一的任务是完成对交接文件的维护 `code`\n第二行",
            ),
          },
        ],
        source: { kind: "handoff" },
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
          content: [
            { type: "text", text: enveloped("assistant", "新格式交接正文 `code`\n第二行") },
          ],
        },
      },
      { surfaceOp: "append" },
    ),
    ev(
      "developer/message",
      3,
      13,
      {
        turn: 1,
        step: 1,
        message: { role: "developer", source: { kind: "handoff" }, content: [] },
      },
      { surfaceOp: { op: "replace", startSeq: 0, endSeq: 2 }, sourceEventSeqs: [0, 1, 2] },
    ),
    ev("agent/inbox/spliced", 4, 14, {
      target: "next-step",
      start: 0,
      inserted: [
        {
          role: "user",
          source: { kind: "handoff" },
          content: [
            {
              type: "text",
              text: injected(
                "context-compacted",
                "本会话刚才发生了上下文压缩，你是接续会话。你必须完整读取 C:\\Users\\Alice\\tmp\\交接指令.md，依据其中的所有内容继续原任务。",
              ),
            },
          ],
        },
      ],
    }),
    ev(
      "user/message",
      5,
      15,
      {
        role: "user",
        content: [
          {
            type: "text",
            text: injected(
              "context-compacted",
              "本会话刚才发生了上下文压缩，你是接续会话。你必须完整读取 C:\\Users\\Alice\\tmp\\交接指令.md，依据其中的所有内容继续原任务。",
            ),
          },
        ],
        source: { kind: "handoff" },
      },
      { surfaceOp: "append" },
    ),
    ev("turn/end", 6, 16, { turn: 1, reason: { kind: "completed" } }),
  ];
}

/** 健康夹具：含子代理两代、空会话、projcache 四态、问答样本与交接样本。 */ export function healthySpec(): FixtureHomeSpec {
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
      // 问答四样本。createdAt 与 lastPromptAt 都取现有最小值以下：`last`（最近活动的主会话）
      // 仍指向 pcpart-13，因此 `show last` 这类组合不会意外落到问答样本上（那会让"默认可见"
      // 与"结构不符必须失败"两种期望混在同一组用例里）。
      {
        id: ASK_PAIRED_ID,
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 600,
        events: askSamplePaired(),
        title: CONTENTS[12],
        turns: 1,
        steps: 1,
        lastPromptAt: 700,
      },
      {
        id: ASK_UNPAIRED_ID,
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 610,
        events: askSampleUnpaired(),
        title: CONTENTS[13],
        turns: 1,
        steps: 1,
        lastPromptAt: 710,
      },
      {
        id: ASK_ERROR_ID,
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 620,
        events: askSampleErrorResult(),
        title: CONTENTS[19],
        turns: 1,
        steps: 1,
        lastPromptAt: 720,
      },
      {
        id: ASK_MALFORMED_ID,
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 630,
        events: askSampleMalformed(),
        title: CONTENTS[14],
        turns: 1,
        steps: 1,
        lastPromptAt: 730,
      },
      // 交接样本。createdAt 与 lastPromptAt 同样取在现有最小值以下，`last` 仍指向 pcpart-13，
      // 因此 `show last` 这类组合不会落到本样本上（本样本的期望是默认导出成功并产出交接条目）。
      {
        id: HANDOFF_ID,
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 640,
        events: handoffSampleEvents(),
        title: "交接夹具",
        turns: 1,
        steps: 2,
        lastPromptAt: 740,
      },
      // 新格式交接样本：与旧格式样本同样的 createdAt/lastPromptAt 取值区间，不影响 `last` 的指向。
      {
        id: HANDOFF_NOTICE_ID,
        projectDir: PROJECT_DIR,
        cwd: MAIN_CWD,
        createdAt: 650,
        events: handoffNoticeSampleEvents(),
        title: "新格式交接夹具",
        turns: 1,
        steps: 1,
        lastPromptAt: 750,
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
 * 合成 DSH_HOME 构造：先清理 workdir 内固定子路径，再重建两套夹具 home，
 * 并对主/子会话注入敌意模型字段。
 *
 * 不再在夹具内挂指向官方库的 junction：默认锚点是桌面版安装内的绝对路径，与合成 home 无关；
 * 需要官方库的组合一律由用例显式传 `--lib-root`（见 `matrix-cases.ts` 的 `healthyBase`）。
 * 另外，指向 `app.asar` 内部的 junction 在 Electron-as-Node 下无法被 `rmSync` 可靠清除
 * （`existsSync` 对它也返回 false），第二次运行会以 `EEXIST` 在 `symlinkSync` 处整体失败（实测）。
 */
export function buildFixtureHomes(workdir: string): FixtureHomes {
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
  patchProjCacheModel(healthyHome, MAIN_ID);
  patchProjCacheModel(healthyHome, CHILD_ID);
  return { healthyHome, brokenHome, outDir };
}
