// search/stats/check 的 Markdown 与 JSON：命中与截断标注、检索范围、扫描摘要与每会话分布、统计全局与单会话口径、校验异常展开与结论行。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderCheckJson, renderSearchJson, renderStatsJson } from "../scripts/lib/render-json.ts";
import { renderCheckMd, renderSearchMd, renderStatsMd } from "../scripts/lib/render-md.ts";
import type {
  CheckOutcome,
  ModelView,
  SearchOutcome,
  SessionCoverage,
  SingleSessionStats,
  StatsOutcome,
  TokenTotals,
} from "../scripts/lib/store-types.ts";
import { assertDocumentShape, coverage, field, scanSummary } from "./render-helpers.ts";

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
          source: null,
        },
      ],
      totalHits: 4,
      truncated: true,
      scope: "all",
      totalIsExact: true,
      excludedInjections: { userMessages: 0, subagentReceipts: 0 },
      coverage: coverage({ includedCount: 2 }),
      scan: scanSummary(),
      distribution: [],
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
    const rendered = renderSearchJson(outcome);
    const document = JSON.parse(rendered.content) as Record<string, unknown>;
    assert.equal(document.total, 4);
    assert.equal(document.truncated, true);
    assert.equal(document.scope, "all");
    assert.equal(document.totalIsExact, true);
    assert.deepEqual(document.coverage, { scannedCount: 2, includedCount: 2, excluded: [] });
    // 摘要与 md 同源：同一 outcome 的 md 摘要为“命中 4 处，显示 1 处”。
    assert.equal(rendered.summary, md.summary);
  });

  it("检索范围文案逐项列出 text 档的四类合成条目、三类子代理交互正文与默认排除", () => {
    // 覆盖面描述是调用方判断"0 命中能否当作不存在"的唯一依据：漏写某一类单元会让调用方
    // 把该类的命中读成不属于本档、把该类的 0 命中读成不存在。因此这里逐项锁定四类合成条目
    // 与 subagent/subagent_fork/send_message 的可读正文，防止文案再次漂移回只列部分载体。
    const outcome: SearchOutcome = {
      hits: [],
      totalHits: 0,
      truncated: false,
      scope: "text",
      totalIsExact: true,
      excludedInjections: { userMessages: 0, subagentReceipts: 0 },
      coverage: coverage({ includedCount: 1 }),
      scan: scanSummary(),
      distribution: [],
    };
    const content = renderSearchMd(outcome).content;
    assert.equal(
      content.includes(
        "检索范围：text（用户与助手正文、提问与回答、上下文摘要、交接通知、交接指令、子代理任务与发往子代理的可读正文（subagent/subagent_fork 的任务正文与 send_message 的消息正文均覆盖；不含框架注入与子代理调度回执））；命中总数 0 为精确值",
      ),
      true,
    );
    for (const label of ["上下文摘要", "交接通知", "交接指令", "子代理任务"]) {
      assert.equal(content.includes(label), true, label);
    }
    assert.equal(content.includes("不含框架注入与子代理调度回执"), true);
  });

  it("search 未截断时无截断标注，且排除项逐条列出", () => {
    const outcome: SearchOutcome = {
      hits: [],
      totalHits: 0,
      truncated: false,
      scope: "text",
      totalIsExact: true,
      excludedInjections: { userMessages: 0, subagentReceipts: 0 },
      coverage: coverage({
        includedCount: 1,
        excluded: [{ id: "session-bad-09", reason: "解码失败" }],
      }),
      scan: scanSummary({ logsDecoded: 1, eventsRead: 3 }),
      distribution: [{ sessionId: "session-aaa-01", type: "main", title: "测试标题", hits: 0 }],
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
      scan: scanSummary(),
      single: null,
    };
    const md = renderStatsMd(global);
    assertDocumentShape(md.content);
    assert.equal(md.content.startsWith("# 统计\n\n"), true);
    assert.equal(md.content.includes("- 会话数：3"), true);
    assert.equal(md.content.includes("- 工具调用总数：9"), true);
    assert.equal(
      md.content.includes("元数据不完整：`session-bbb-02`（`projcache 记录缺失`）"),
      true,
    );
    assert.equal(md.summary, "会话 3 个；总轮次 5；工具调用 9");
    const globalExcluded = renderStatsMd({ ...global, excludedMetricSessions: 2 });
    assert.equal(
      globalExcluded.summary,
      "会话 3 个；总轮次 5；工具调用 9（2 个会话未计入，原因见输出文件）",
    );
    const globalJson = renderStatsJson(global);
    const json = JSON.parse(globalJson.content) as Record<string, unknown>;
    assert.equal(json.kind, "global");
    assert.equal(json.sessionCount, 3);
    // 摘要里出现的"未计入会话数"必须同时进入 json：md 说了 N 个，machine 侧要拿到同一个数。
    assert.equal(json.excludedMetricSessions, 0);
    assert.equal(
      (
        JSON.parse(renderStatsJson({ ...global, excludedMetricSessions: 2 }).content) as {
          excludedMetricSessions: number;
        }
      ).excludedMetricSessions,
      2,
    );
    // 摘要与 md 同源：json 形态的 stdout 第二行必须与 md 摘要逐字一致。
    assert.equal(globalJson.summary, md.summary);

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
    const singleJsonRendered = renderStatsJson(single);
    const singleJson = JSON.parse(singleJsonRendered.content) as {
      session: Record<string, unknown>;
      excludedMetricSessions: number;
    };
    assert.equal(singleJson.session.id, "session-aaa-01");
    // 单会话恒为 0，但字段必须存在，否则两种 kind 的 json 形状不一致。
    assert.equal(singleJson.excludedMetricSessions, 0);
    assert.equal(singleJsonRendered.summary, singleMd.summary);
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
      scan: scanSummary(),
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
    const checkJson = renderCheckJson(outcome);
    const json = JSON.parse(checkJson.content) as {
      anomalyCount: number;
      coverage: SessionCoverage;
    };
    assert.equal(json.anomalyCount, 1);
    assert.deepEqual(json.coverage, { scannedCount: 2, includedCount: 2, excluded: [] });
    assert.equal(checkJson.summary, md.summary);

    const clean = renderCheckMd({ sessions: [], anomalyCount: 0, coverage: coverage() });
    assert.equal(clean.content.includes("结论：无异常"), true);
  });
});
