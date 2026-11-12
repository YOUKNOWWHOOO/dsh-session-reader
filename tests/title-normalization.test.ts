// 标题归一化的跨层验证：部署标记残片在两个标题来源（projcache 的 title 字段与日志里最后一个
// session/title 事件）上都收敛为"没有标题"，四个呈现面（list、show、stats 单会话、每会话命中分布）
// 的 md 与 json 给出同一份空值形态（md 显示 `-`，json 为 null）。
// 设计约束：归一化判据只允许出现在 scripts\lib\deployment-text.ts 的 normalizeSessionTitle；
// 本文件的断言全部通过渲染与元数据入口间接验证它，不复制判据。
import assert from "node:assert/strict";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { renderListJson, renderShowJson, renderStatsJson } from "../scripts/lib/render-json.ts";
import { renderListMd, renderSearchMd, renderStatsMd } from "../scripts/lib/render-md.ts";
import { renderShowMd } from "../scripts/lib/render-show-md.ts";
import { discoverReadableSessions } from "../scripts/lib/store-discovery.ts";
import { buildMetadata, loadProjCache } from "../scripts/lib/store-metadata.ts";
import type {
  ListOutcome,
  SearchOutcome,
  SessionHitCount,
  SingleSessionStats,
  StatsOutcome,
} from "../scripts/lib/store-types.ts";
import { resetTempDir, writeFixtureHome } from "./fixtures.ts";
import {
  coverage,
  field,
  listEntry,
  metadata,
  node,
  scanSummary,
  showOptions,
} from "./render-helpers.ts";
import { event, fakeCatalog, findEntry, OTHER_CWD, PROJECT_OTHER } from "./store-helpers.ts";

/** 真实库里出现过的残片形态：起点行被上游截断，只剩前缀与部分属性。 */
const MARKER_TITLE = '<dsh-injection kind="subagent-task" src=';
const TEMP_ROOT = fileURLToPath(new URL("./.tmp/title", import.meta.url));
const HOME = join(TEMP_ROOT, "marker-title-dsh");
const SESSION_ID = "session-marker-title-01";

before(() => {
  resetTempDir(TEMP_ROOT);
  writeFixtureHome(HOME, {
    sessions: [
      {
        id: SESSION_ID,
        projectDir: PROJECT_OTHER,
        cwd: OTHER_CWD,
        createdAt: 1000,
        events: [
          event("turn/start", 0, 10, { turn: 1 }),
          event("session/title", 1, 11, { title: MARKER_TITLE, messageSeqs: [] }),
        ],
        title: MARKER_TITLE,
        turns: 0,
        steps: 0,
        lastPromptAt: null,
      },
    ],
  });
});

describe("projcache 标题来源", () => {
  it("标记残片视为没有标题，且不表现为元数据不完整", () => {
    const discovered = discoverReadableSessions(HOME, fakeCatalog);
    assert.equal(discovered.success, true);
    if (!discovered.success) return;
    const entry = findEntry(discovered.data.entries, SESSION_ID);
    const view = buildMetadata(loadProjCache(HOME, entry.id, entry.header));
    assert.equal(view.title.value, null);
    assert.equal(view.title.unavailable, false);
    assert.deepEqual(view.reasons, []);
    assert.equal(view.available, true);
  });
});

describe("list 呈现", () => {
  function listOutcome(): ListOutcome {
    return {
      entries: [listEntry(SESSION_ID, {}, metadata({ title: field<string>(null) }))],
      matchedCount: 1,
      scannedCount: 1,
      hiddenBlankCount: 0,
      coverage: coverage({ includedCount: 1 }),
    };
  }

  it("md 表格的标题列显示 -，不显示标记残片", () => {
    const content = renderListMd(listOutcome(), { full: false }).content;
    assert.match(content, /^\| `session-marker-title-01` \| - \|/mu);
    assert.equal(content.includes("dsh-injection"), false);
  });

  it("json 的 title 为 null", () => {
    const document = JSON.parse(renderListJson(listOutcome()).content) as {
      sessions: Array<Record<string, unknown>>;
    };
    assert.equal(document.sessions[0].title, null);
  });
});

describe("show 呈现", () => {
  function showNode() {
    return node(
      [],
      [
        { type: "turn/start", seq: 0, time: 10, data: { turn: 1 } },
        { type: "session/title", seq: 1, time: 11, data: { title: MARKER_TITLE } },
      ],
    );
  }

  it("md 头部的标题显示 -", () => {
    const rendered = renderShowMd(showNode(), showOptions());
    assert.equal(rendered.success, true);
    if (!rendered.success) return;
    assert.equal(rendered.data.content.includes("- 标题：-"), true);
    assert.equal(rendered.data.content.includes("subagent-task"), false);
  });

  it("json 的 session.title 为 null", () => {
    const document = JSON.parse(
      renderShowJson(showNode(), { summary: false, subagents: false, unattributable: [] }).content,
    ) as { session: Record<string, unknown> };
    assert.equal(document.session.title, null);
  });
});

describe("stats 单会话与每会话命中分布", () => {
  function singleStats(): SingleSessionStats {
    return {
      id: SESSION_ID,
      title: field<string>(null),
      blank: field(false),
      agentPreset: field("standard"),
      model: field({ provider: "p", model: "m", reasoningEffort: null }),
      hasToolCalls: false,
      createdAt: 1000,
      lastActivityAt: 1000,
      metadataAvailable: true,
      metadataReasons: [],
      logPath: "C:\\logs\\x",
      logVersion: 4,
      logCompressed: true,
      sizeBytes: 100,
    };
  }

  function statsOutcome(): StatsOutcome {
    return {
      kind: "single",
      sessionCount: 1,
      blankCount: 0,
      hasToolCalls: false,
      earliestCreatedAt: 1000,
      latestActivityAt: 1000,
      totalSizeBytes: 100,
      unavailable: [],
      coverage: coverage({ includedCount: 1 }),
      scan: scanSummary(),
      single: singleStats(),
    };
  }

  it("stats 单会话的 md 标题显示 -，json 的 title 为 null", () => {
    assert.equal(renderStatsMd(statsOutcome()).content.includes("- 标题：-"), true);
    const document = JSON.parse(renderStatsJson(statsOutcome()).content) as {
      session: Record<string, unknown>;
    };
    assert.equal(document.session.title, null);
  });

  it("命中分布的 md 标题列显示 -", () => {
    const distribution: SessionHitCount[] = [
      { sessionId: SESSION_ID, type: "main", title: null, hits: 0 },
    ];
    const outcome: SearchOutcome = {
      hits: [],
      totalHits: 0,
      truncated: false,
      scope: "text",
      totalIsExact: true,
      excludedInjections: { userMessages: 0, subagentReceipts: 0 },
      coverage: coverage({ includedCount: 1 }),
      scan: scanSummary(),
      distribution,
    };
    const content = renderSearchMd(outcome).content;
    assert.match(content, /^\| `session-marker-title-01` \| 主 \| - \| 0 \|$/mu);
  });
});
