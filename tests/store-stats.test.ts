// 统计单元测试：runStats 全局聚合（轮次/步数/工具调用/令牌/时间范围/不可用列表）
// 与单会话统计。

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { runStats } from "../scripts/lib/store-stats.ts";
import { contextOf, initStoreFixtures, storeFixtures } from "./store-helpers.ts";

const fixtures = storeFixtures("stats");
const HEALTHY_HOME = fixtures.healthyHome;

before(() => {
  initStoreFixtures(fixtures);
});

describe("runStats", () => {
  it("全局聚合：轮次/步数/令牌/空会话/不可用列表", () => {
    const outcome = runStats(contextOf(HEALTHY_HOME), undefined, { origin: "all" });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.kind, "global");
    assert.equal(outcome.data.sessionCount, 9);
    assert.equal(outcome.data.blankCount, 1);
    assert.equal(outcome.data.turns, 3);
    assert.equal(outcome.data.steps, 3);
    assert.equal(outcome.data.toolCalls, 1);
    assert.deepEqual(outcome.data.tokens, {
      uncachedInputTokens: 600,
      outputTokens: 300,
      cacheReadTokens: 150,
      cacheWriteTokens: 30,
    });
    assert.equal(outcome.data.earliestCreatedAt, 500);
    assert.equal(outcome.data.latestActivityAt, 2000);
    assert.equal(outcome.data.totalSizeBytes > 0, true);
    assert.equal(outcome.data.unavailable.length, 4);
  });

  it("单会话统计", () => {
    const outcome = runStats(contextOf(HEALTHY_HOME), "fixture-main-01", { origin: "all" });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.kind, "single");
    const single = outcome.data.single;
    assert.notEqual(single, null);
    if (single === null) return;
    assert.equal(single.id, "session-fixture-main-01");
    assert.equal(single.title.value, "夹具标题 A");
    assert.equal(single.turns.value, 2);
    assert.equal(single.toolCalls, 1);
    assert.equal(single.metadataAvailable, true);
  });
});
