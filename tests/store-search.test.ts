// 检索单元测试：runSearch 的 scope（text/tools/all）、大小写敏感开关、limit 截断显示但
// 总数保持全量、范围过滤（origin 时主会话命中不计）与命中摘录标签。

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { runSearch } from "../scripts/lib/store-search.ts";
import { contextOf, initStoreFixtures, storeFixtures } from "./store-helpers.ts";

const fixtures = storeFixtures("search");
const HEALTHY_HOME = fixtures.healthyHome;

before(() => {
  initStoreFixtures(fixtures);
});

describe("runSearch", () => {
  const scopeFilters = { origin: "all" as const };
  const baseOptions = { caseSensitive: false, context: 20, limit: 0 };

  it("scope=text：仅用户/助手正文", () => {
    const outcome = runSearch(contextOf(HEALTHY_HOME), "needle", scopeFilters, {
      ...baseOptions,
      scope: "text",
    });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.totalHits, 2);
    assert.deepEqual(outcome.data.hits.map((hit) => hit.label).sort(), ["assistant", "user"]);
  });

  it("scope=tools：另含工具参数与结果", () => {
    const outcome = runSearch(contextOf(HEALTHY_HOME), "needle", scopeFilters, {
      ...baseOptions,
      scope: "tools",
    });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.totalHits, 4);
    assert.deepEqual([...new Set(outcome.data.hits.map((hit) => hit.label))].sort(), [
      "assistant",
      "tool/call",
      "tool/result",
      "user",
    ]);
  });

  it("scope=all：覆盖推理/系统/压缩/命令/标题请求/交付物", () => {
    const outcome = runSearch(contextOf(HEALTHY_HOME), "needle", scopeFilters, {
      ...baseOptions,
      scope: "all",
    });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    const labels = new Set(outcome.data.hits.map((hit) => hit.label));
    for (const label of [
      "assistant/reasoning",
      "system",
      "compaction/summary",
      "command/run",
      "command/done",
      "title-request",
      "deliverables",
    ]) {
      assert.equal(labels.has(label), true, `缺少 label: ${label}`);
    }
    const userHit = outcome.data.hits.find((hit) => hit.label === "user");
    assert.equal(userHit?.excerpt, "Alpha Needle here");
  });

  it("大小写敏感开关", () => {
    const sensitive = runSearch(contextOf(HEALTHY_HOME), "Needle", scopeFilters, {
      ...baseOptions,
      scope: "text",
      caseSensitive: true,
    });
    assert.equal(sensitive.success, true);
    if (!sensitive.success) return;
    assert.equal(sensitive.data.totalHits, 1);
  });

  it("limit 截断显示但总数保持全量", () => {
    const outcome = runSearch(contextOf(HEALTHY_HOME), "needle", scopeFilters, {
      ...baseOptions,
      scope: "text",
      limit: 1,
    });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.hits.length, 1);
    assert.equal(outcome.data.totalHits, 2);
    assert.equal(outcome.data.truncated, true);
  });

  it("范围过滤生效（origin=subagent 时主会话命中不计）", () => {
    const outcome = runSearch(
      contextOf(HEALTHY_HOME),
      "needle",
      { origin: "subagent" },
      { ...baseOptions, scope: "all" },
    );
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.totalHits, 0);
  });
});
