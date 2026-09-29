// 边界与分支单元测试：发现阶段跳过不可读 header 并记录原因、空 zstd 文件与撕裂 header 帧、
// buildMetadata 行结构异常、排序 size/turns 分支、runSearch context=0、runStats 目标不存在。

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { discoverReadableSessions } from "../scripts/lib/store-discovery.ts";
import { buildList } from "../scripts/lib/store-list.ts";
import { buildMetadata } from "../scripts/lib/store-metadata.ts";
import { runSearch } from "../scripts/lib/store-search.ts";
import { runStats } from "../scripts/lib/store-stats.ts";
import { CURRENT_LOG_VERSION, writeFixtureHome } from "./fixtures.ts";
import {
  contextOf,
  defaultFilters,
  fakeCatalog,
  initStoreFixtures,
  OTHER_CWD,
  PROJECT_OTHER,
  singleEvent,
  storeFixtures,
} from "./store-helpers.ts";

const fixtures = storeFixtures("edge-cases");
const TEMP_ROOT = fixtures.tempRoot;
const HEALTHY_HOME = fixtures.healthyHome;
const BROKEN_HOME = fixtures.brokenHome;

before(() => {
  initStoreFixtures(fixtures);
});

describe("边界与分支", () => {
  it("discoverReadableSessions 跳过不可读 header 并记录原因", () => {
    const result = discoverReadableSessions(BROKEN_HOME, fakeCatalog);
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.entries.length, 2);
    assert.equal(result.data.skipped.length, 1);
    assert.equal(result.data.skipped[0].idFromDir, "session-broken-corrupt-08");
  });

  it("空 zstd 文件 / 撕裂 header 帧 → data-unreadable", () => {
    const emptyHome = join(TEMP_ROOT, "edge-empty");
    writeFixtureHome(emptyHome, {
      sessions: [
        {
          id: "session-edge-empty-01",
          projectDir: PROJECT_OTHER,
          cwd: OTHER_CWD,
          createdAt: 1,
          events: singleEvent(),
        },
      ],
    });
    const emptyLog = join(
      emptyHome,
      "sessions",
      PROJECT_OTHER,
      "session-edge-empty-01",
      `session.v${CURRENT_LOG_VERSION}.jsonl.zstd`,
    );
    writeFileSync(emptyLog, Buffer.alloc(0));
    const empty = discoverReadableSessions(emptyHome, fakeCatalog);
    assert.equal(empty.success, true);
    if (!empty.success) return;
    assert.equal(empty.data.entries.length, 0);
    assert.equal(empty.data.skipped.length, 1);

    const tornHome = join(TEMP_ROOT, "edge-torn");
    writeFixtureHome(tornHome, {
      sessions: [
        {
          id: "session-edge-torn-02",
          projectDir: PROJECT_OTHER,
          cwd: OTHER_CWD,
          createdAt: 1,
          events: singleEvent(),
        },
      ],
    });
    const tornLog = join(
      tornHome,
      "sessions",
      PROJECT_OTHER,
      "session-edge-torn-02",
      `session.v${CURRENT_LOG_VERSION}.jsonl.zstd`,
    );
    const fullFrame = zstdCompressSync(
      Buffer.from(
        `${JSON.stringify({ type: "session", version: CURRENT_LOG_VERSION, id: "session-edge-torn-02", createdAt: 1, isSeeded: false, delegationDepth: 0 })}\n`,
        "utf8",
      ),
    );
    writeFileSync(tornLog, fullFrame.subarray(0, 12));
    const torn = discoverReadableSessions(tornHome, fakeCatalog);
    assert.equal(torn.success, true);
    if (!torn.success) return;
    assert.equal(torn.data.entries.length, 0);
    assert.equal(torn.data.skipped.length, 1);
  });

  it("buildMetadata 行结构异常 → 字段级不可用并给原因", () => {
    const cache = {
      available: true,
      reason: null,
      rows: {
        title: { ver: 1, seq: 0, val: 123 },
        sessionListMetadata: { ver: 1, seq: 0, val: { blank: "yes", lastPromptAt: "x" } },
        sessionStats: { ver: 1, seq: 0, val: { turns: 1 } },
        agentPreset: { ver: 1, seq: 0, val: 7 },
        modelSelection: { ver: 1, seq: 0, val: { lastUsed: { provider: "p" } } },
        tokenUsage: { ver: 1, seq: 0, val: { totals: { uncachedInputTokens: 1 } } },
      },
    };
    const metadata = buildMetadata(cache);
    assert.equal(metadata.title.value, null);
    assert.equal(metadata.title.unavailable, false);
    assert.equal(metadata.blank.unavailable, true);
    assert.equal(metadata.turns.value, 1);
    assert.equal(metadata.steps.unavailable, true);
    assert.equal(metadata.agentPreset.value, null);
    assert.equal(metadata.model.unavailable, true);
    assert.equal(metadata.tokens.unavailable, true);
    assert.equal(metadata.reasons.length >= 4, true);
  });

  it("排序 size/turns 分支", () => {
    const bySize = buildList(contextOf(HEALTHY_HOME), defaultFilters({ sort: "size" }));
    assert.equal(bySize.success, true);
    if (!bySize.success) return;
    const sizes = bySize.data.entries.map((entry) => entry.sizeBytes);
    assert.deepEqual(
      sizes,
      [...sizes].sort((left, right) => right - left),
    );
    const byTurns = buildList(contextOf(HEALTHY_HOME), defaultFilters({ sort: "turns" }));
    assert.equal(byTurns.success, true);
    if (!byTurns.success) return;
    assert.equal(byTurns.data.entries[0].id, "session-fixture-main-01");
    assert.equal(byTurns.data.entries[1].id, "bbbb1111-2222-3333-4444-555566667777");
  });

  it("runSearch context=0 无省略号且命中位置正确", () => {
    const outcome = runSearch(
      contextOf(HEALTHY_HOME),
      "Needle",
      { origin: "all" },
      {
        scope: "text",
        caseSensitive: true,
        context: 0,
        limit: 5,
      },
    );
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.hits[0].excerpt, "…Needle…");
    assert.equal(outcome.data.truncated, false);
  });

  it("runStats 目标不存在时返回 target-missing", () => {
    const outcome = runStats(contextOf(HEALTHY_HOME), "zzzzzzzz", { origin: "all" });
    assert.equal(outcome.success, false);
    if (!outcome.success) assert.equal(outcome.error.category, "target-missing");
  });
});
