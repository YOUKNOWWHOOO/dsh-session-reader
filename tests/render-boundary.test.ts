// 结构纪律与边界补充：role 过滤与子代理嵌套、循环引用载荷、列表/统计不可用列、扫描摘要与命中分布、--probe 规模探测、show 范围筛选与载荷截断、CR/CRLF 归一化。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeTabs } from "../scripts/lib/render-core.ts";
import { renderSearchJson, renderShowJson, renderStatsJson } from "../scripts/lib/render-json.ts";
import { renderListMd, renderSearchMd, renderStatsMd } from "../scripts/lib/render-md.ts";
import { renderShowMd } from "../scripts/lib/render-show-md.ts";
import type {
  ListOutcome,
  ModelView,
  ScanSummary,
  SearchOutcome,
  SessionNode,
  StatsOutcome,
  TokenTotals,
} from "../scripts/lib/store-types.ts";
import {
  assertDocumentShape,
  coverage,
  decodedFile,
  field,
  listEntry,
  metadata,
  node,
  RENDER_EVENTS,
  scanSummary,
  sessionEntry,
  showMd,
  showOptions,
} from "./render-helpers.ts";

describe("render 边界与分支", () => {
  it("role=assistant 过滤；JSON 含子代理嵌套", () => {
    const child: SessionNode = {
      entry: { ...sessionEntry(), id: "cafe1111-2222-3333-4444-555566667777" },
      file: decodedFile(),
      children: [],
    };
    const parent = node([child]);
    const md = showMd(parent, showOptions({ role: "assistant" }));
    assert.equal(md.content.includes("助手内容 ASSIST-TEXT"), true);
    assert.equal(md.content.includes("用户内容 USER-TEXT"), false);
    const document = JSON.parse(
      renderShowJson(parent, { summary: false, subagents: true, unattributable: [] }).content,
    ) as {
      subagents: Array<Record<string, unknown>>;
    };
    assert.equal(document.subagents.length, 1);
  });

  it("事件 data 不可序列化 → 直接抛错（禁止用占位文案掩盖缺陷）", () => {
    const circular: Record<string, unknown> = { turn: 1 };
    circular.self = circular;
    const events = [...RENDER_EVENTS, { type: "custom/unknown", seq: 9, time: 19, data: circular }];
    // 载荷不可序列化说明上游已偏离契约：必须让异常抛到 CLI 顶层映射为 `内部错误`，
    // 而不是把 `[不可序列化]` 这类占位文案混进产物冒充正文。
    assert.throws(() => renderShowMd(node([], events), showOptions({ events: true })));
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
      scan: scanSummary(),
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
    assert.equal(singleMd.content.includes("元数据不完整：`projcache 记录缺失`"), true);

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
          source: null,
        },
      ],
      totalHits: 1,
      scannedSessions: 1,
      truncated: false,
      searchedSessions: 1,
      scope: "text",
      totalIsExact: true,
      coverage: coverage({ includedCount: 1 }),
      scan: scanSummary(),
      distribution: [],
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
      rendered.content.includes("元数据不完整：`session-ccc-03`（`identity 不符`）"),
      true,
    );
  });

  it("search 扫描摘要与每会话命中分布（0 命中的分母 + 剔除污染的依据）", () => {
    const outcome: SearchOutcome = {
      hits: [
        {
          sessionId: "session-mine-01",
          seq: 3,
          time: 10,
          label: "assistant",
          excerpt: "…我的笔记里写过 write failed…",
          source: null,
        },
      ],
      totalHits: 3,
      scannedSessions: 3,
      truncated: false,
      searchedSessions: 3,
      scope: "all",
      totalIsExact: true,
      coverage: coverage({ includedCount: 3, excluded: [{ id: "x-09", reason: "解码失败" }] }),
      scan: scanSummary({
        logsDecoded: 3,
        eventsRead: 120,
        decodeFailures: 1,
        frameFailures: 2,
        observedFrom: 1_700_000_000_000,
        observedTo: 1_700_000_060_000,
      }),
      distribution: [
        { sessionId: "session-mine-01", type: "main", title: "我的调查会话", hits: 3 },
        { sessionId: "session-target-02", type: "main", title: "被调查会话", hits: 0 },
        { sessionId: "child-03", type: "subagent", title: null, hits: 0 },
      ],
    };
    const md = renderSearchMd(outcome);
    assertDocumentShape(md.content);
    // 分母：读了什么、读了多少、失败多少、覆盖到什么时间。
    assert.equal(
      md.content.includes(
        "扫描明细：解码日志 3 份；读到事件 120 个；解码失败 1 份；帧解压失败 2 帧",
      ),
      true,
    );
    assert.match(
      md.content,
      /事件时间范围：\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} ~ /u,
    );
    // 污染可见：逐会话分布含 0 命中项，且给出剔除手段。
    assert.equal(md.content.includes("## 每会话命中分布"), true);
    assert.equal(
      md.content.includes("| 会话 | 类型 | 标题 | 命中 |\n| --- | --- | --- | --- |"),
      true,
    );
    assert.match(md.content, /\| `session-mine-01` \| 主 \| `我的调查会话` \| 3 \|/u);
    assert.match(md.content, /\| `session-target-02` \| 主 \| `被调查会话` \| 0 \|/u);
    assert.match(md.content, /\| `child-03` \| 子 \| - \| 0 \|/u);
    assert.equal(
      md.content.includes("用 --exclude-session <标识> 排除调用方自己的会话及其子代理子树。"),
      true,
    );
    const document = JSON.parse(renderSearchJson(outcome).content) as {
      scan: ScanSummary;
      distribution: Array<{ sessionId: string; hits: number }>;
    };
    assert.equal(document.scan.eventsRead, 120);
    assert.deepEqual(
      document.distribution.map((item) => item.hits),
      [3, 0, 0],
    );
  });

  it("search 分布为空时不输出分布区块（避免空表触发 MD055）", () => {
    const outcome: SearchOutcome = {
      hits: [],
      totalHits: 0,
      scannedSessions: 0,
      truncated: false,
      searchedSessions: 0,
      scope: "text",
      totalIsExact: true,
      coverage: coverage(),
      scan: scanSummary(),
      distribution: [],
    };
    const md = renderSearchMd(outcome);
    assertDocumentShape(md.content);
    assert.equal(md.content.includes("每会话命中分布"), false);
    assert.equal(md.content.includes("事件时间范围：- ~ -"), true);
  });

  it("stats 全局与单会话都带扫描摘要", () => {
    const global: StatsOutcome = {
      kind: "global",
      sessionCount: 1,
      blankCount: 0,
      turns: 0,
      steps: 0,
      toolCalls: 0,
      tokens: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      earliestCreatedAt: null,
      latestActivityAt: null,
      totalSizeBytes: 0,
      unavailable: [],
      excludedMetricSessions: 0,
      coverage: coverage({ includedCount: 1 }),
      scan: scanSummary({ logsDecoded: 1, eventsRead: 7 }),
      single: null,
    };
    const md = renderStatsMd(global);
    assertDocumentShape(md.content);
    assert.equal(
      md.content.includes("扫描明细：解码日志 1 份；读到事件 7 个；解码失败 0 份；帧解压失败 0 帧"),
      true,
    );
    const json = JSON.parse(renderStatsJson(global).content) as { scan: ScanSummary };
    assert.equal(json.scan.logsDecoded, 1);
  });

  it("--probe：只给规模摘要，正文不落盘且预计字节数等于完整导出的字节数", () => {
    // 预计字节数必须等于"以同一组选项做完整导出"的字节数，因此对照物要用默认选项渲染。
    const full = showMd(node(), showOptions());
    const probed = showMd(node(), showOptions({ probe: true }));
    assertDocumentShape(probed.content);
    assert.equal(probed.content.includes("- 预计字节数："), true);
    assert.equal(probed.content.includes("- 消息数：1 用户 / 1 助手"), true);
    assert.equal(probed.content.includes("## 时间线"), false);
    assert.equal(probed.content.includes("用户内容 USER-TEXT"), false);
    assert.equal(
      probed.content.includes(
        `- 预计字节数：${Buffer.byteLength(full.content, "utf8")}（完整导出正文大小，按 UTF-8 计）`,
      ),
      true,
    );
    assert.match(probed.summary, /（规模探测）；事件 \d+ 个；预计正文 \d+ 字节$/u);
  });

  it("--probe：正文规模越大，探测产物的相对开销越小", () => {
    // 用多轮消息把正文撑大：探测产物只随轮次大纲以外的头部增长，而完整导出随正文线性增长。
    const manyEvents: Record<string, unknown>[] = [];
    for (let turn = 1; turn <= 40; turn += 1) {
      manyEvents.push({ type: "turn/start", seq: (turn - 1) * 2, time: turn, data: { turn } });
      manyEvents.push({
        type: "user/message",
        seq: (turn - 1) * 2 + 1,
        time: turn,
        data: { role: "user", content: [{ type: "text", text: `第 ${turn} 轮正文`.repeat(40) }] },
      });
    }
    const full = showMd(node([], manyEvents), showOptions());
    const probed = showMd(node([], manyEvents), showOptions({ probe: true }));
    assert.equal(probed.content.length * 10 < full.content.length, true);
    assert.equal(
      probed.content.includes(
        `- 预计字节数：${Buffer.byteLength(full.content, "utf8")}（完整导出正文大小，按 UTF-8 计）`,
      ),
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
        data: {
          role: "user",
          content: [{ type: "text", text: "T1-PROMPT" }],
          source: { kind: "user" },
        },
      },
      { type: "turn/end", seq: 2, time: 12, data: { turn: 1 } },
      { type: "turn/start", seq: 3, time: 13, data: { turn: 2 } },
      {
        type: "user/message",
        seq: 4,
        time: 14,
        data: {
          role: "user",
          content: [{ type: "text", text: "T2-PROMPT" }],
          source: { kind: "user" },
        },
      },
      { type: "turn/end", seq: 5, time: 15, data: { turn: 2 } },
    ];
    const turnFiltered = showMd(node([], events), showOptions({ turnRange: { from: 2, to: 2 } }));
    assertDocumentShape(turnFiltered.content);
    assert.equal(turnFiltered.content.includes("T2-PROMPT"), true);
    assert.equal(turnFiltered.content.includes("T1-PROMPT"), false);
    // 条目以"标签行 + 正文围栏"为一个单位计数（见 renderTimelineMd）：一条消息 = 1 条条目。
    assert.equal(
      turnFiltered.content.includes(
        "筛选：turn 2-2；显示 1 条时间线条目（区间内事件 3 个，共 6 个事件）",
      ),
      true,
    );

    const seqFiltered = showMd(node([], events), showOptions({ seqRange: { from: 1, to: 4 } }));
    assert.equal(seqFiltered.content.includes("T1-PROMPT"), true);
    assert.equal(seqFiltered.content.includes("T2-PROMPT"), true);
    assert.equal(
      seqFiltered.content.includes(
        "筛选：seq 1-4；显示 2 条时间线条目（区间内事件 4 个，共 6 个事件）",
      ),
      true,
    );

    const seqNarrow = showMd(node([], events), showOptions({ seqRange: { from: 0, to: 1 } }));
    assert.equal(seqNarrow.content.includes("T1-PROMPT"), true);
    assert.equal(seqNarrow.content.includes("T2-PROMPT"), false);
    assert.equal(
      seqNarrow.content.includes(
        "筛选：seq 0-1；显示 1 条时间线条目（区间内事件 2 个，共 6 个事件）",
      ),
      true,
    );

    const headFiltered = showMd(node([], events), showOptions({ head: 1 }));
    // 首 1 条是**完整**的一条：标签行与其正文围栏必须同时保留（禁止截出孤立标签行）。
    assert.equal(headFiltered.content.includes("T1-PROMPT"), true);
    assert.equal(headFiltered.content.includes("**用户**："), true);
    assert.equal(headFiltered.content.includes("T2-PROMPT"), false);
    assert.equal(
      headFiltered.content.includes(
        "筛选：首 1 条；显示 1 条时间线条目（区间内事件 6 个，共 6 个事件）",
      ),
      true,
    );

    const tailFiltered = showMd(node([], events), showOptions({ tail: 1 }));
    // 末 1 条同样是完整条目：正文围栏与它的标签行都必须保留（禁止截出无标签围栏块）。
    assert.equal(tailFiltered.content.includes("T2-PROMPT"), true);
    assert.equal(tailFiltered.content.includes("**用户**："), true);
    assert.equal(tailFiltered.content.includes("T1-PROMPT"), false);
    assert.equal(
      tailFiltered.content.includes(
        "筛选：末 1 条；显示 1 条时间线条目（区间内事件 6 个，共 6 个事件）",
      ),
      true,
    );

    const both = showMd(
      node([], events),
      showOptions({ turnRange: { from: 1, to: 2 }, seqRange: { from: 4, to: 5 } }),
    );
    assert.equal(both.content.includes("T2-PROMPT"), true);
    assert.equal(both.content.includes("T1-PROMPT"), false);
  });

  it("show 未筛选时不输出筛选说明行", () => {
    const plain = showMd(node(), showOptions());
    assert.equal(plain.content.includes("筛选："), false);
  });

  it("子代理块的筛选说明行不得出现只作用于根块的 `首/末 N 条`", () => {
    const child: SessionNode = {
      entry: { ...sessionEntry(), id: "cafe1111-2222-3333-4444-555566667777" },
      file: decodedFile(),
      children: [],
    };
    const parent = node([child]);
    const filtered = showMd(parent, showOptions({ head: 1, subagents: true }));
    // `--head` 只裁剪根块：子代理块既没有被裁剪，就不得在同一行里声称"首 1 条"，
    // 否则会出现「首 1 条；显示 N 条时间线条目」这种自相矛盾的外观。
    const filterLines = filtered.content.split("\n").filter((line) => line.startsWith("筛选："));
    assert.equal(filterLines.length, 1);
    assert.equal(filterLines[0].startsWith("筛选：首 1 条；显示 1 条时间线条目"), true);
    // 子代理块本身仍完整呈现（`--head` 不作用于它）。
    assert.equal(filtered.content.includes("## 子代理 1"), true);
  });

  it("事件载荷截断由 --truncate 决定：0 即不截断", () => {
    const payload = "X".repeat(400);
    const events: Record<string, unknown>[] = [
      { type: "custom/unknown", seq: 0, time: 10, data: { blob: payload } },
    ];
    const unlimited = showMd(node([], events), showOptions({ events: true }));
    assert.equal(unlimited.content.includes(payload), true);
    const limited = showMd(node([], events), showOptions({ events: true, truncate: 10 }));
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
    const rendered = showMd(node([], events), showOptions());
    assert.equal(rendered.content.includes("\r"), false);
    assert.equal(rendered.content.includes("line1\nline2\nline3"), true);
  });
});
