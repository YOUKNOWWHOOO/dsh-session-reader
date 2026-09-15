// render.ts 单元测试：lint-safe Markdown 渲染（载体/归一化/结构）、JSON/JSONL 渲染、可见性表、截断、摘要文案。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fenceBlock,
  formatSize,
  inlineCodeSpan,
  inlineValue,
  neutralizeMd014,
  normalizeTabs,
  renderCheckJson,
  renderCheckMd,
  renderListJson,
  renderListMd,
  renderSearchJson,
  renderSearchMd,
  renderShowJson,
  renderShowJsonl,
  renderShowMd,
  renderStatsJson,
  renderStatsMd,
  type ShowMdOptions,
  tableCellValue,
  truncateText,
  wouldTriggerMd014,
} from "../scripts/lib/render.ts";
import type {
  CheckOutcome,
  DecodedSessionFile,
  FieldValue,
  ListEntry,
  ListOutcome,
  MetadataView,
  ModelView,
  SearchOutcome,
  SessionCoverage,
  SessionEntry,
  SessionNode,
  SingleSessionStats,
  StatsOutcome,
  TokenTotals,
} from "../scripts/lib/store.ts";

function field<T>(value: T | null, unavailable = false): FieldValue<T> {
  return { value, unavailable };
}

function metadata(overrides: Partial<MetadataView> = {}): MetadataView {
  return {
    available: true,
    reasons: [],
    title: field("测试标题"),
    blank: field(false),
    lastPromptAt: field(1000),
    turns: field(3),
    steps: field(5),
    agentPreset: field("standard"),
    model: field({ provider: "provider-x", model: "model-y", reasoningEffort: "max" }),
    tokens: field({
      uncachedInputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
    }),
    ...overrides,
  };
}

function listEntry(
  id: string,
  overrides: Partial<ListEntry> = {},
  meta: MetadataView = metadata(),
): ListEntry {
  return {
    id,
    type: "main",
    cwd: "C:\\Users\\ZHANG\\user_projects",
    workspaceTitle: "user_projects",
    createdAt: 1000,
    lastActivityAt: 2000,
    sizeBytes: 2048,
    metadata: meta,
    ...overrides,
  };
}

/** 覆盖声明：默认"扫描=纳入、无排除"；测试按需注入排除项。 */
function coverage(overrides: Partial<SessionCoverage> = {}): SessionCoverage {
  const includedCount = overrides.includedCount ?? 0;
  const excluded = overrides.excluded ?? [];
  return {
    scannedCount: overrides.scannedCount ?? includedCount + excluded.length,
    includedCount,
    excluded,
  };
}

const HEADER = {
  version: 3,
  id: "session-render-01",
  createdAt: 1000,
  cwd: "C:\\Users\\ZHANG\\user_projects",
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: "standard",
};

const RENDER_EVENTS: Record<string, unknown>[] = [
  { type: "turn/start", seq: 0, time: 10, data: { turn: 1 } },
  {
    type: "user/message",
    seq: 1,
    time: 11,
    data: { role: "user", content: [{ type: "text", text: "用户内容 USER-TEXT" }] },
    surfaceOp: "append",
  },
  {
    type: "assistant/message",
    seq: 2,
    time: 12,
    data: {
      turn: 1,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "助手内容 ASSIST-TEXT" },
          { type: "reasoning", text: "推理内容 THINK-TEXT" },
        ],
      },
    },
    surfaceOp: "append",
  },
  {
    type: "tool/call",
    seq: 3,
    time: 13,
    data: { callId: "c1", name: "read", arguments: '{"path":"x"}' },
  },
  {
    type: "tool/result",
    seq: 4,
    time: 14,
    data: {
      message: {
        role: "user",
        content: [{ type: "tool-result", content: [{ type: "text", text: "结果 RESULT-TEXT" }] }],
      },
    },
    surfaceOp: "append",
  },
  {
    type: "system/message",
    seq: 5,
    time: 15,
    data: { message: { role: "system", content: [{ type: "text", text: "系统 SYSTEM-TEXT" }] } },
    surfaceOp: "append",
  },
  { type: "session/title", seq: 6, time: 16, data: { title: "渲染标题" } },
  { type: "session/title-llm-request", seq: 7, time: 17, data: { system: "标题请求" } },
  { type: "turn/end", seq: 8, time: 18, data: { turn: 1 } },
];

function decodedFile(events: Record<string, unknown>[] = RENDER_EVENTS): DecodedSessionFile {
  return {
    decoded: {
      header: HEADER,
      events,
      inheritedEventCount: 0,
      anomalies: [],
      lineCount: events.length + 1,
      eventLineCount: events.length,
      parsedEventCount: events.length,
    },
    frames: 3,
    tornStart: undefined,
    sizeBytes: 2048,
  };
}

function sessionEntry(): SessionEntry {
  return {
    id: "session-render-01",
    projectDirName: "p",
    dirPath: "d",
    logPath: "C:\\logs\\session-render-01\\session.v3.jsonl.zstd",
    logVersion: 3,
    logCompressed: true,
    sizeBytes: 2048,
    header: HEADER,
  };
}

function node(children: SessionNode[] = [], events?: Record<string, unknown>[]): SessionNode {
  return {
    entry: sessionEntry(),
    file: events === undefined ? decodedFile() : decodedFile(events),
    children,
  };
}

function showOptions(overrides: Partial<ShowMdOptions> = {}): ShowMdOptions {
  return {
    summary: false,
    role: null,
    thinking: false,
    tools: false,
    events: false,
    headers: false,
    truncate: 0,
    subagents: false,
    turnRange: null,
    seqRange: null,
    head: 0,
    tail: 0,
    ...overrides,
  };
}

/** 结构纪律断言：末尾恰一个换行、无连续空行。 */
function assertDocumentShape(content: string): void {
  assert.equal(content.endsWith("\n"), true);
  assert.equal(content.endsWith("\n\n"), false);
  assert.equal(content.includes("\n\n\n"), false);
}

describe("formatSize / truncateText", () => {
  it("字节大小格式化", () => {
    assert.equal(formatSize(500), "500 B");
    assert.equal(formatSize(1024), "1.0 KB");
    assert.equal(formatSize(19442), "19.0 KB");
    assert.equal(formatSize(1053118), "1.0 MB");
  });

  it("按码点截断并附加省略号", () => {
    assert.equal(truncateText("abcdef", 3), "abc…");
    assert.equal(truncateText("abc", 3), "abc");
    assert.equal(truncateText("abcdef", 0), "abcdef");
    assert.equal(truncateText("😀😀😀", 2), "😀😀…");
  });
});

describe("lint-safe 载体与归一化", () => {
  it("normalizeTabs：制表符替换为 4 空格", () => {
    assert.equal(normalizeTabs("a\tb"), "a    b");
    assert.equal(normalizeTabs("\tindent"), "    indent");
    assert.equal(normalizeTabs("no-tab"), "no-tab");
  });

  it("wouldTriggerMd014：全部非空行以 $ + 空白开头才触发", () => {
    assert.equal(wouldTriggerMd014("$ echo hello"), true);
    assert.equal(wouldTriggerMd014("$ ls\n$ pwd"), true);
    assert.equal(wouldTriggerMd014("$ echo hello\nhello"), false);
    assert.equal(wouldTriggerMd014("$ a\n\n$ b"), true);
    assert.equal(wouldTriggerMd014(""), false);
    assert.equal(wouldTriggerMd014("\n\n"), false);
  });

  it("neutralizeMd014：触发时在末尾追加一行单个空格", () => {
    assert.equal(neutralizeMd014("$ ls\n$ pwd"), "$ ls\n$ pwd\n ");
    assert.equal(neutralizeMd014("$ ls\nout"), "$ ls\nout");
  });

  it("fenceBlock：动态反引号长度、语言固定 text、归一化生效", () => {
    assert.equal(fenceBlock("plain"), "```text\nplain\n```");
    assert.equal(fenceBlock("a\n```\nb"), "````text\na\n```\nb\n````");
    assert.equal(fenceBlock("$ a\n$ b"), "```text\n$ a\n$ b\n \n```");
    assert.equal(fenceBlock("a\tb"), "```text\na    b\n```");
  });

  it("inlineCodeSpan：动态反引号、反引号边界加内边距", () => {
    assert.equal(inlineCodeSpan("x"), "`x`");
    assert.equal(inlineCodeSpan("`x`"), "`` `x` ``");
    assert.equal(inlineCodeSpan("``"), "``` `` ```");
    assert.equal(inlineCodeSpan(""), "``");
  });

  it("inlineValue：折叠换行、制表符、去除首尾空白；全空白保留", () => {
    assert.equal(inlineValue("  a\tb  "), "`a    b`");
    assert.equal(inlineValue("a\nb\rc"), "`a b c`");
    assert.equal(inlineValue("x"), "`x`");
    assert.equal(inlineValue("   "), "`   `");
    assert.equal(inlineValue(""), "``");
  });

  it("tableCellValue：管道符转义", () => {
    assert.equal(tableCellValue("a|b"), "`a\\|b`");
    assert.equal(tableCellValue("plain"), "`plain`");
  });
});

describe("renderListMd / renderListJson", () => {
  it("精简列：表头/分隔行/数据行 + 页脚（含隐藏空会话、元数据不可用与覆盖声明）", () => {
    const outcome: ListOutcome = {
      entries: [
        listEntry("session-aaa-01"),
        listEntry(
          "session-bbb-02",
          {},
          metadata({
            available: false,
            reasons: ["projcache 记录缺失"],
            title: field<string>(null, true),
          }),
        ),
      ],
      matchedCount: 2,
      scannedCount: 3,
      hiddenBlankCount: 1,
      coverage: coverage({
        includedCount: 2,
        excluded: [{ id: "session-ccc-03", reason: "header 分类 malformed" }],
      }),
    };
    const rendered = renderListMd(outcome, { full: false });
    assertDocumentShape(rendered.content);
    assert.equal(rendered.content.startsWith("# 会话列表\n\n"), true);
    assert.equal(
      rendered.content.includes(
        "| ID | 标题 | 工作区 | 最近活动 | 轮次 | 类型 | 大小 |\n| --- | --- | --- | --- | --- | --- | --- |",
      ),
      true,
    );
    // 显示值必须与可传值同源：输出完整 id（此前输出 12 字符截断值，子代理 id 会因此歧义）。
    assert.equal(rendered.content.includes("| `session-aaa-01` |"), true);
    assert.equal(rendered.content.includes("| `session-bbb-02` |"), true);
    assert.equal(rendered.content.includes("`测试标题`"), true);
    assert.equal(rendered.content.includes("合计：匹配 2 个会话，显示 2 个（共扫描 3 个）"), true);
    assert.equal(rendered.content.includes("已隐藏空会话 1 个（--include-blank 显示）"), true);
    assert.equal(
      rendered.content.includes("元数据不可用：`session-bbb-02`（`projcache 记录缺失`）"),
      true,
    );
    assert.equal(rendered.content.includes("扫描会话 3 个；纳入 2 个；排除 1 个"), true);
    assert.equal(
      rendered.content.includes("排除会话：`session-ccc-03`（`header 分类 malformed`）"),
      true,
    );
    assert.equal(rendered.summary, "匹配会话 2 个，显示 2 个");
  });

  it("标题含管道符转义；空结果表格仍成立", () => {
    const piped: ListOutcome = {
      entries: [listEntry("session-aaa-01", {}, metadata({ title: field("a|b") }))],
      matchedCount: 1,
      scannedCount: 1,
      hiddenBlankCount: 0,
      coverage: coverage({ includedCount: 1 }),
    };
    assert.equal(renderListMd(piped, { full: false }).content.includes("`a\\|b`"), true);

    const empty: ListOutcome = {
      entries: [],
      matchedCount: 0,
      scannedCount: 0,
      hiddenBlankCount: 0,
      coverage: coverage(),
    };
    const rendered = renderListMd(empty, { full: false });
    assertDocumentShape(rendered.content);
    assert.equal(rendered.content.includes("合计：匹配 0 个会话，显示 0 个（共扫描 0 个）"), true);
    assert.equal(rendered.content.includes("扫描会话 0 个；纳入 0 个；排除 0 个"), true);
  });

  it("--full：列表形态（首行 + 两空格缩进续行）", () => {
    const outcome: ListOutcome = {
      entries: [listEntry("session-aaa-01")],
      matchedCount: 1,
      scannedCount: 1,
      hiddenBlankCount: 0,
      coverage: coverage({ includedCount: 1 }),
    };
    const rendered = renderListMd(outcome, { full: true });
    assertDocumentShape(rendered.content);
    assert.equal(rendered.content.includes("# 会话列表（完整）"), true);
    assert.equal(rendered.content.includes("- `session-aaa-01`：`测试标题`（主）"), true);
    assert.equal(rendered.content.includes("  **工作区**：`user_projects`"), true);
    assert.match(rendered.content, /^ {2}\*\*最近活动\*\*：\d{4}-\d{2}-\d{2}T/mu);
    assert.equal(rendered.content.includes("  **轮次**：3"), true);
    assert.equal(rendered.content.includes("  **大小**：2.0 KB"), true);
    assert.equal(rendered.content.includes("  **模型**：`provider-x/model-y`"), true);
    assert.equal(rendered.content.includes("  **令牌**：10/20/30/40"), true);
    assert.equal(rendered.content.includes("  **元数据**：projcache"), true);
  });

  it("JSON 含全部列字段、可用性标记与覆盖声明", () => {
    const outcome: ListOutcome = {
      entries: [listEntry("session-aaa-01")],
      matchedCount: 1,
      scannedCount: 1,
      hiddenBlankCount: 0,
      coverage: coverage({ includedCount: 1 }),
    };
    const document = JSON.parse(renderListJson(outcome)) as {
      sessions: Array<Record<string, unknown>>;
      coverage: SessionCoverage;
    };
    assert.equal(document.sessions.length, 1);
    assert.equal(document.sessions[0].id, "session-aaa-01");
    assert.equal("shortId" in document.sessions[0], false);
    assert.equal(document.sessions[0].title, "测试标题");
    assert.deepEqual(document.sessions[0].metadata, { available: true, reasons: [] });
    assert.deepEqual(document.coverage, { scannedCount: 1, includedCount: 1, excluded: [] });
  });
});

describe("renderShowMd", () => {
  it("默认可见性：正文经围栏承载、推理/工具/事件隐藏并给出摘要", () => {
    const rendered = renderShowMd(node(), showOptions());
    assertDocumentShape(rendered.content);
    assert.equal(rendered.content.startsWith("# 会话记录\n\n"), true);
    assert.equal(rendered.content.includes("- ID：`session-render-01`"), true);
    assert.equal(rendered.content.includes("- 标题：`渲染标题`"), true);
    assert.equal(rendered.content.includes("## 时间线"), true);
    assert.equal(rendered.content.includes("**用户**：\n\n```text\n用户内容 USER-TEXT\n```"), true);
    assert.equal(
      rendered.content.includes("**助手**：\n\n```text\n助手内容 ASSIST-TEXT\n```"),
      true,
    );
    assert.equal(rendered.content.includes("**推理**"), false);
    assert.equal(rendered.content.includes("**工具调用**"), false);
    assert.equal(rendered.content.includes("**事件**"), false);
    assert.equal(rendered.content.includes("摘要：已隐藏 1 条推理内容（--thinking 显示）"), true);
    assert.equal(rendered.content.includes("已隐藏 2 条工具调用/结果（--tools 显示）"), true);
    assert.match(rendered.content, /已隐藏 \d+ 条生命周期事件（--events 显示）/u);
    assert.match(rendered.summary, /事件 9 个/u);
  });

  it("开关全部打开：推理/工具/事件/系统消息可见；--headers 附 seq 与时间", () => {
    const rendered = renderShowMd(
      node(),
      showOptions({ thinking: true, tools: true, events: true, headers: true }),
    );
    assertDocumentShape(rendered.content);
    assert.match(
      rendered.content,
      /\*\*推理\*\*（seq 2；[0-9T:+-]+）：\n\n```text\n推理内容 THINK-TEXT\n```/u,
    );
    assert.match(rendered.content, /\*\*工具调用\*\*（`read`）（seq 3；[0-9T:+-]+）：/u);
    assert.equal(rendered.content.includes('```text\n{"path":"x"}\n```'), true);
    assert.match(
      rendered.content,
      /\*\*工具结果\*\*（seq 4；[0-9T:+-]+）：\n\n```text\n结果 RESULT-TEXT\n```/u,
    );
    assert.match(rendered.content, /\*\*系统消息\*\*（seq 5；[0-9T:+-]+）：/u);
    assert.match(
      rendered.content,
      /\*\*事件\*\*（seq 0；[0-9T:+-]+）：`turn\/start` `\{"turn":1\}`/u,
    );
    assert.match(rendered.content, /\*\*用户\*\*（seq 1；[0-9T:+-]+）：/u);
    assert.equal(rendered.content.includes("摘要："), false);
  });

  it("--role 过滤与 --truncate 截断（截断先于围栏）", () => {
    const rendered = renderShowMd(node(), showOptions({ role: "user", truncate: 4 }));
    assert.equal(rendered.content.includes("```text\n用户内容…\n```"), true);
    assert.equal(rendered.content.includes("**助手**"), false);
    assert.equal(rendered.content.includes("已按 --role user 过滤对话消息"), true);
    assert.equal(rendered.content.includes("文本已截断为 4 字符"), true);
  });

  it("--summary 输出轮次大纲", () => {
    const rendered = renderShowMd(node(), showOptions({ summary: true }));
    assertDocumentShape(rendered.content);
    assert.equal(rendered.content.includes("## 轮次大纲"), true);
    assert.equal(
      rendered.content.includes("- T1（seq 0）：`用户内容 USER-TEXT` → `助手内容 ASSIST-TEXT`"),
      true,
    );
    assert.equal(rendered.content.includes("## 时间线"), false);
    assert.match(rendered.summary, /（摘要）/u);
  });

  it("--subagents 追加子代理块（## 子代理 路径编号）", () => {
    const child: SessionNode = {
      entry: { ...sessionEntry(), id: "cafe1111-2222-3333-4444-555566667777" },
      file: decodedFile(),
      children: [],
    };
    const rendered = renderShowMd(node([child]), showOptions({ subagents: true }));
    assertDocumentShape(rendered.content);
    assert.equal(rendered.content.includes("## 子代理 1"), true);
    assert.equal(rendered.content.includes("### 时间线"), true);
    assert.equal(rendered.content.includes("cafe1111-2222-3333-4444-555566667777"), true);
    assert.match(rendered.summary, /子代理 1 个/u);
  });

  it("围栏动态长度：正文含 ``` 与更长反引号串时围栏加长", () => {
    const events: Record<string, unknown>[] = [
      {
        type: "user/message",
        seq: 0,
        time: 10,
        data: { role: "user", content: [{ type: "text", text: "a\n```\nb" }] },
      },
      {
        type: "user/message",
        seq: 1,
        time: 11,
        data: { role: "user", content: [{ type: "text", text: "x ```` y" }] },
      },
    ];
    const rendered = renderShowMd(node([], events), showOptions());
    assert.equal(rendered.content.includes("````text\na\n```\nb\n````"), true);
    assert.equal(rendered.content.includes("`````text\nx ```` y\n`````"), true);
  });

  it("MD014 中和：全 $ 载荷末尾追加空格行；制表符归一化", () => {
    const events: Record<string, unknown>[] = [
      {
        type: "user/message",
        seq: 0,
        time: 10,
        data: { role: "user", content: [{ type: "text", text: "$ ls\n$ pwd" }] },
      },
      {
        type: "user/message",
        seq: 1,
        time: 11,
        data: { role: "user", content: [{ type: "text", text: "a\tb" }] },
      },
    ];
    const rendered = renderShowMd(node([], events), showOptions());
    assert.equal(rendered.content.includes("```text\n$ ls\n$ pwd\n \n```"), true);
    assert.equal(rendered.content.includes("```text\na    b\n```"), true);
  });

  it("空事件节点：轮次大纲为空、KV 规模行为零", () => {
    const rendered = renderShowMd(node([], []), showOptions({ summary: true }));
    assert.equal(rendered.content.includes("## 轮次大纲\n\n无"), true);
    assert.match(rendered.content, /规模：.*；0 事件/u);
  });
});

describe("renderShowJson / renderShowJsonl", () => {
  it("JSON 结构：session/meta/turns/messages/subagents", () => {
    const document = JSON.parse(renderShowJson(node(), { summary: false })) as Record<
      string,
      unknown
    >;
    const session = document.session as Record<string, unknown>;
    assert.equal(session.id, "session-render-01");
    assert.equal(session.title, "渲染标题");
    const meta = document.meta as Record<string, unknown>;
    assert.equal(meta.eventCount, RENDER_EVENTS.length);
    assert.equal((document.turns as unknown[]).length, 1);
    assert.equal((document.messages as unknown[]).length >= 5, true);
    assert.deepEqual(document.subagents, []);
  });

  it("--summary 时 messages 为空", () => {
    const document = JSON.parse(renderShowJson(node(), { summary: true })) as Record<
      string,
      unknown
    >;
    assert.deepEqual(document.messages, []);
  });

  it("JSONL：首行逻辑 header，其后逐事件", () => {
    const rendered = renderShowJsonl(node());
    const lines = rendered.content.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 1 + RENDER_EVENTS.length);
    const header = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(header.id, "session-render-01");
    assert.equal(header.type, undefined);
    const event = JSON.parse(lines[1]) as Record<string, unknown>;
    assert.equal(event.seq, 0);
  });
});

describe("renderSearchMd / renderStatsMd / renderCheckMd", () => {
  it("search md 与 JSON", () => {
    const outcome: SearchOutcome = {
      hits: [
        {
          sessionId: "session-aaa-01",
          seq: 3,
          time: 10,
          label: "user",
          excerpt: "…命中片段…",
        },
      ],
      totalHits: 4,
      scannedSessions: 2,
      truncated: true,
      searchedSessions: 2,
      scope: "all",
      totalIsExact: true,
      coverage: coverage({ includedCount: 2 }),
    };
    const md = renderSearchMd(outcome);
    assertDocumentShape(md.content);
    assert.equal(md.content.startsWith("# 检索结果\n\n"), true);
    assert.equal(md.content.includes("- `session-aaa-01`（seq 3）`user`：`…命中片段…`"), true);
    assert.equal(md.content.includes("命中总数：4；已截断显示 1 条（--limit 0 显示全部）"), true);
    assert.equal(
      md.content.includes(
        "检索范围：all（穷尽（另含推理/系统/压缩/命令/标题请求/web 请求/交付物/待办/代理信箱与每条事件载荷））；命中总数 4 为精确值",
      ),
      true,
    );
    assert.equal(md.content.includes("扫描会话 2 个；纳入 2 个；排除 0 个"), true);
    assert.equal(md.summary, "命中 4 处，显示 1 处");
    const document = JSON.parse(renderSearchJson(outcome)) as Record<string, unknown>;
    assert.equal(document.total, 4);
    assert.equal(document.truncated, true);
    assert.equal(document.scope, "all");
    assert.equal(document.totalIsExact, true);
    assert.deepEqual(document.coverage, { scannedCount: 2, includedCount: 2, excluded: [] });
  });

  it("search 未截断时无截断标注，且排除项逐条列出", () => {
    const outcome: SearchOutcome = {
      hits: [],
      totalHits: 0,
      scannedSessions: 1,
      truncated: false,
      searchedSessions: 1,
      scope: "text",
      totalIsExact: true,
      coverage: coverage({
        includedCount: 1,
        excluded: [{ id: "session-bad-09", reason: "解码失败" }],
      }),
    };
    const md = renderSearchMd(outcome);
    assertDocumentShape(md.content);
    assert.equal(md.content.includes("命中总数：0\n"), true);
    assert.equal(md.content.includes("已截断显示"), false);
    assert.equal(md.content.includes("扫描会话 2 个；纳入 1 个；排除 1 个"), true);
    assert.equal(md.content.includes("排除会话：`session-bad-09`（`解码失败`）"), true);
  });

  it("stats 全局/单会话 md 与 JSON", () => {
    const global: StatsOutcome = {
      kind: "global",
      sessionCount: 3,
      blankCount: 1,
      turns: 5,
      steps: 7,
      toolCalls: 9,
      tokens: {
        uncachedInputTokens: 11,
        outputTokens: 22,
        cacheReadTokens: 33,
        cacheWriteTokens: 44,
      },
      earliestCreatedAt: 1000,
      latestActivityAt: 2000,
      totalSizeBytes: 2048,
      unavailable: [{ id: "session-bbb-02", reasons: ["projcache 记录缺失"] }],
      excludedMetricSessions: 0,
      coverage: coverage({ includedCount: 3 }),
      single: null,
    };
    const md = renderStatsMd(global);
    assertDocumentShape(md.content);
    assert.equal(md.content.startsWith("# 统计\n\n"), true);
    assert.equal(md.content.includes("- 会话数：3"), true);
    assert.equal(md.content.includes("- 工具调用总数：9"), true);
    assert.equal(
      md.content.includes("元数据不可用：`session-bbb-02`（`projcache 记录缺失`）"),
      true,
    );
    assert.equal(md.summary, "会话 3 个；总轮次 5；工具调用 9");
    const globalExcluded = renderStatsMd({ ...global, excludedMetricSessions: 2 });
    assert.equal(
      globalExcluded.summary,
      "会话 3 个；总轮次 5；工具调用 9（2 个会话未计入，原因见输出文件）",
    );
    const json = JSON.parse(renderStatsJson(global)) as Record<string, unknown>;
    assert.equal(json.kind, "global");
    assert.equal(json.sessionCount, 3);

    const single: StatsOutcome = {
      ...global,
      kind: "single",
      single: {
        id: "session-aaa-01",
        title: field("单会话标题"),
        blank: field(false),
        turns: field(2),
        steps: field(3),
        agentPreset: field("standard"),
        model: field({ provider: "p", model: "m", reasoningEffort: null }),
        tokens: field({
          uncachedInputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
        }),
        toolCalls: 1,
        createdAt: 1000,
        lastActivityAt: 2000,
        metadataAvailable: true,
        metadataReasons: [],
        logPath: "C:\\logs\\x",
        logVersion: 3,
        logCompressed: true,
        sizeBytes: 100,
      },
    };
    const singleMd = renderStatsMd(single);
    assertDocumentShape(singleMd.content);
    assert.equal(singleMd.content.includes("- 标题：`单会话标题`"), true);
    assert.equal(singleMd.summary, "会话 session-aaa-01；轮次 2；工具调用 1");
    const singleJson = JSON.parse(renderStatsJson(single)) as { session: Record<string, unknown> };
    assert.equal(singleJson.session.id, "session-aaa-01");
  });

  it("stats 单会话：blank/turns 不可用与空值口径（不静默显 -/0）", () => {
    const singleStats: SingleSessionStats = {
      id: "session-aaa-01",
      title: field<string>(null, true),
      blank: field<boolean>(null, true),
      turns: field<number>(null, true),
      steps: field<number>(null, true),
      agentPreset: field<string>(null, true),
      model: field<ModelView>(null, true),
      tokens: field<TokenTotals>(null, true),
      toolCalls: 0,
      createdAt: 0,
      lastActivityAt: 0,
      metadataAvailable: false,
      metadataReasons: ["projcache 记录缺失"],
      logPath: "C:\\logs\\x",
      logVersion: 3,
      logCompressed: true,
      sizeBytes: 0,
    };
    const base: StatsOutcome = {
      kind: "single",
      sessionCount: 1,
      blankCount: 0,
      turns: 0,
      steps: 0,
      toolCalls: 0,
      tokens: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      earliestCreatedAt: 0,
      latestActivityAt: 0,
      totalSizeBytes: 0,
      unavailable: [],
      excludedMetricSessions: 0,
      coverage: coverage({ includedCount: 1 }),
      single: singleStats,
    };
    const unavailableMd = renderStatsMd(base);
    assert.equal(unavailableMd.content.includes("- 空会话：元数据不可用"), true);
    assert.equal(unavailableMd.summary, "会话 session-aaa-01；轮次 元数据不可用；工具调用 0");

    const nullStats: SingleSessionStats = {
      ...singleStats,
      blank: field<boolean>(null, false),
      turns: field<number>(null, false),
    };
    const nullMd = renderStatsMd({ ...base, single: nullStats });
    assert.equal(nullMd.content.includes("- 空会话：-"), true);
    assert.equal(nullMd.summary, "会话 session-aaa-01；轮次 -；工具调用 0");
  });

  it("check md 与 JSON（含异常展开与结论行）", () => {
    const outcome: CheckOutcome = {
      sessions: [
        {
          id: "session-aaa-01",
          logPath: "C:\\logs\\a",
          formatVersion: 3,
          classification: "current",
          structure: "完整",
          structureDetail: null,
          frames: 2,
          lineCount: 5,
          seqContiguous: true,
          badLineCount: 0,
          anomalies: [],
        },
        {
          id: "session-bbb-02",
          logPath: "C:\\logs\\b",
          formatVersion: null,
          classification: null,
          structure: "结构损坏",
          structureDetail: "帧魔数无效",
          frames: null,
          lineCount: null,
          seqContiguous: null,
          badLineCount: 0,
          anomalies: ["结构损坏: 帧魔数无效"],
        },
      ],
      anomalyCount: 1,
      coverage: coverage({ includedCount: 2 }),
    };
    const md = renderCheckMd(outcome);
    assertDocumentShape(md.content);
    assert.equal(md.content.startsWith("# 完整性校验\n\n"), true);
    assert.equal(
      md.content.includes(
        "- `session-aaa-01`：v=3；结构=完整；帧=2；行=5；seq=连续；坏行=0；异常=0",
      ),
      true,
    );
    assert.equal(md.content.includes("异常详情：`结构损坏: 帧魔数无效`"), true);
    assert.equal(md.content.includes("结论：发现 1 项异常"), true);
    assert.equal(md.content.includes("扫描会话 2 个；纳入 2 个；排除 0 个"), true);
    assert.equal(md.summary, "会话 2 个；异常 1 项");
    const json = JSON.parse(renderCheckJson(outcome)) as {
      anomalyCount: number;
      coverage: SessionCoverage;
    };
    assert.equal(json.anomalyCount, 1);
    assert.deepEqual(json.coverage, { scannedCount: 2, includedCount: 2, excluded: [] });

    const clean = renderCheckMd({ sessions: [], anomalyCount: 0, coverage: coverage() });
    assert.equal(clean.content.includes("结论：无异常"), true);
  });
});

describe("render 边界与分支", () => {
  it("role=assistant 过滤；JSON 含子代理嵌套", () => {
    const child: SessionNode = {
      entry: { ...sessionEntry(), id: "cafe1111-2222-3333-4444-555566667777" },
      file: decodedFile(),
      children: [],
    };
    const parent = node([child]);
    const md = renderShowMd(parent, showOptions({ role: "assistant" }));
    assert.equal(md.content.includes("助手内容 ASSIST-TEXT"), true);
    assert.equal(md.content.includes("用户内容 USER-TEXT"), false);
    const document = JSON.parse(renderShowJson(parent, { summary: false })) as {
      subagents: Array<Record<string, unknown>>;
    };
    assert.equal(document.subagents.length, 1);
  });

  it("事件 data 循环引用 → [不可序列化]", () => {
    const circular: Record<string, unknown> = { turn: 1 };
    circular.self = circular;
    const events = [...RENDER_EVENTS, { type: "custom/unknown", seq: 9, time: 19, data: circular }];
    const md = renderShowMd(node([], events), showOptions({ events: true }));
    assert.equal(md.content.includes("[不可序列化]"), true);
  });

  it("list 全量模式：模型/令牌不可用列显示元数据不可用", () => {
    const outcome: ListOutcome = {
      entries: [
        listEntry(
          "session-aaa-01",
          {},
          metadata({
            reasons: ["tokenUsage 结构无效"],
            model: field<ModelView>(null, true),
            tokens: field<TokenTotals>(null, true),
          }),
        ),
      ],
      matchedCount: 1,
      scannedCount: 1,
      hiddenBlankCount: 0,
      coverage: coverage({ includedCount: 1 }),
    };
    const rendered = renderListMd(outcome, { full: true });
    assert.equal(rendered.content.includes("元数据不可用"), true);
    assert.equal(rendered.content.includes("部分缺失"), true);
  });

  it("stats 单会话附原因；全局空时间跨度显示 -", () => {
    const singleOutcome: StatsOutcome = {
      kind: "single",
      sessionCount: 1,
      blankCount: 0,
      turns: 1,
      steps: 0,
      toolCalls: 0,
      tokens: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      earliestCreatedAt: 0,
      latestActivityAt: 0,
      totalSizeBytes: 0,
      unavailable: [],
      excludedMetricSessions: 0,
      coverage: coverage({ includedCount: 1 }),
      single: {
        id: "session-aaa-01",
        title: field<string>(null, true),
        blank: field<boolean>(null, true),
        turns: field<number>(null, true),
        steps: field<number>(null, true),
        agentPreset: field<string>(null, true),
        model: field<ModelView>(null, true),
        tokens: field<TokenTotals>(null, true),
        toolCalls: 0,
        createdAt: 0,
        lastActivityAt: 0,
        metadataAvailable: false,
        metadataReasons: ["projcache 记录缺失"],
        logPath: "C:\\logs\\x",
        logVersion: 3,
        logCompressed: true,
        sizeBytes: 10,
      },
    };
    const singleMd = renderStatsMd(singleOutcome);
    assert.equal(singleMd.content.includes("元数据不可用：`projcache 记录缺失`"), true);

    const emptyGlobal: StatsOutcome = {
      ...singleOutcome,
      kind: "global",
      single: null,
      earliestCreatedAt: null,
      latestActivityAt: null,
    };
    const globalMd = renderStatsMd(emptyGlobal);
    assert.equal(globalMd.content.includes("- 时间跨度：- ~ -"), true);
  });

  it("search 未截断时无截断标注", () => {
    const outcome: SearchOutcome = {
      hits: [
        {
          sessionId: "session-aaa-01",
          seq: 1,
          time: 10,
          label: "user",
          excerpt: "片段",
        },
      ],
      totalHits: 1,
      scannedSessions: 1,
      truncated: false,
      searchedSessions: 1,
      scope: "text",
      totalIsExact: true,
      coverage: coverage({ includedCount: 1 }),
    };
    const md = renderSearchMd(outcome);
    assert.equal(md.content.includes("已截断"), false);
    assert.match(md.content, /命中总数：1$/mu);
  });

  it("元数据不可用会话的 list 页脚说明（reasons 非空）", () => {
    const outcome: ListOutcome = {
      entries: [
        listEntry("session-ccc-03", {}, metadata({ available: false, reasons: ["identity 不符"] })),
      ],
      matchedCount: 1,
      scannedCount: 1,
      hiddenBlankCount: 0,
      coverage: coverage({ includedCount: 1 }),
    };
    const rendered = renderListMd(outcome, { full: false });
    assert.equal(
      rendered.content.includes("元数据不可用：`session-ccc-03`（`identity 不符`）"),
      true,
    );
  });

  it("show 范围筛选：turn/seq 区间、首尾截取与筛选说明行", () => {
    const events: Record<string, unknown>[] = [
      { type: "turn/start", seq: 0, time: 10, data: { turn: 1 } },
      {
        type: "user/message",
        seq: 1,
        time: 11,
        data: { role: "user", content: [{ type: "text", text: "T1-PROMPT" }] },
      },
      { type: "turn/end", seq: 2, time: 12, data: { turn: 1 } },
      { type: "turn/start", seq: 3, time: 13, data: { turn: 2 } },
      {
        type: "user/message",
        seq: 4,
        time: 14,
        data: { role: "user", content: [{ type: "text", text: "T2-PROMPT" }] },
      },
      { type: "turn/end", seq: 5, time: 15, data: { turn: 2 } },
    ];
    const turnFiltered = renderShowMd(
      node([], events),
      showOptions({ turnRange: { from: 2, to: 2 } }),
    );
    assertDocumentShape(turnFiltered.content);
    assert.equal(turnFiltered.content.includes("T2-PROMPT"), true);
    assert.equal(turnFiltered.content.includes("T1-PROMPT"), false);
    // 条目数按"已写入产物的 md 行/段"计（标签行 + 围栏 + 载荷），因此一条消息对应 3 条条目。
    assert.equal(
      turnFiltered.content.includes(
        "筛选：turn 2-2；显示 2 条时间线条目（区间内事件 3 个，共 6 个事件）",
      ),
      true,
    );

    const seqFiltered = renderShowMd(
      node([], events),
      showOptions({ seqRange: { from: 1, to: 4 } }),
    );
    assert.equal(seqFiltered.content.includes("T1-PROMPT"), true);
    assert.equal(seqFiltered.content.includes("T2-PROMPT"), true);
    assert.equal(
      seqFiltered.content.includes(
        "筛选：seq 1-4；显示 4 条时间线条目（区间内事件 4 个，共 6 个事件）",
      ),
      true,
    );

    const seqNarrow = renderShowMd(node([], events), showOptions({ seqRange: { from: 0, to: 1 } }));
    assert.equal(seqNarrow.content.includes("T1-PROMPT"), true);
    assert.equal(seqNarrow.content.includes("T2-PROMPT"), false);
    assert.equal(
      seqNarrow.content.includes(
        "筛选：seq 0-1；显示 2 条时间线条目（区间内事件 2 个，共 6 个事件）",
      ),
      true,
    );

    const headFiltered = renderShowMd(node([], events), showOptions({ head: 1 }));
    assert.equal(headFiltered.content.includes("T1-PROMPT"), false);
    assert.equal(headFiltered.content.includes("**用户**："), true);
    assert.equal(
      headFiltered.content.includes(
        "筛选：首 1 条；显示 1 条时间线条目（区间内事件 6 个，共 6 个事件）",
      ),
      true,
    );

    const tailFiltered = renderShowMd(node([], events), showOptions({ tail: 1 }));
    // 末 1 条 = 最后一个条目（围栏块本身），因此只保留 T2 的正文载荷，标签行被截掉。
    assert.equal(tailFiltered.content.includes("T2-PROMPT"), true);
    assert.equal(tailFiltered.content.includes("T1-PROMPT"), false);
    assert.equal(
      tailFiltered.content.includes(
        "筛选：末 1 条；显示 1 条时间线条目（区间内事件 6 个，共 6 个事件）",
      ),
      true,
    );

    const both = renderShowMd(
      node([], events),
      showOptions({ turnRange: { from: 1, to: 2 }, seqRange: { from: 4, to: 5 } }),
    );
    assert.equal(both.content.includes("T2-PROMPT"), true);
    assert.equal(both.content.includes("T1-PROMPT"), false);
  });

  it("show 未筛选时不输出筛选说明行", () => {
    const plain = renderShowMd(node(), showOptions());
    assert.equal(plain.content.includes("筛选："), false);
  });

  it("事件载荷截断由 --truncate 决定：0 即不截断", () => {
    const payload = "X".repeat(400);
    const events: Record<string, unknown>[] = [
      { type: "custom/unknown", seq: 0, time: 10, data: { blob: payload } },
    ];
    const unlimited = renderShowMd(node([], events), showOptions({ events: true }));
    assert.equal(unlimited.content.includes(payload), true);
    const limited = renderShowMd(node([], events), showOptions({ events: true, truncate: 10 }));
    assert.equal(limited.content.includes(payload), false);
    assert.equal(limited.content.includes("…"), true);
  });

  it("CR/CRLF 归一化为 LF（输出契约要求 LF-only）", () => {
    assert.equal(normalizeTabs("a\r\nb"), "a\nb");
    assert.equal(normalizeTabs("a\rb"), "a\nb");
    const events: Record<string, unknown>[] = [
      {
        type: "user/message",
        seq: 0,
        time: 10,
        data: { role: "user", content: [{ type: "text", text: "line1\r\nline2\rline3" }] },
      },
    ];
    const rendered = renderShowMd(node([], events), showOptions());
    assert.equal(rendered.content.includes("\r"), false);
    assert.equal(rendered.content.includes("line1\nline2\nline3"), true);
  });
});
