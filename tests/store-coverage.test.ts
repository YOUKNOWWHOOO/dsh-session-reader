// 覆盖声明的纳入口径测试：search/stats 对「header 可读但解码失败」的会话只计 excluded，
// list 对发现阶段跳过者同样计入排除；纳入数与排除数互斥且不双计。

import assert from "node:assert/strict";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { buildList } from "../scripts/lib/store-list.ts";
import { runSearch } from "../scripts/lib/store-search.ts";
import { runStats } from "../scripts/lib/store-stats.ts";
import { resetTempDir, writeFixtureHome } from "./fixtures.ts";
import {
  contextOf,
  defaultFilters,
  initStoreFixtures,
  MAIN_CWD,
  mainEvents,
  PROJECT_MAIN,
  storeFixtures,
} from "./store-helpers.ts";

const fixtures = storeFixtures("coverage");
const TEMP_ROOT = fixtures.tempRoot;
const BROKEN_HOME = fixtures.brokenHome;

before(() => {
  initStoreFixtures(fixtures);
});

describe("覆盖声明的纳入口径：解码失败者只计排除", () => {
  const home = join(TEMP_ROOT, "coverage-dsh");

  before(() => {
    resetTempDir(home);
    writeFixtureHome(home, {
      sessions: [
        {
          id: "session-cov-ok-01",
          projectDir: PROJECT_MAIN,
          cwd: MAIN_CWD,
          createdAt: 100,
          events: mainEvents(),
        },
        {
          id: "session-cov-bad-02",
          projectDir: PROJECT_MAIN,
          cwd: MAIN_CWD,
          createdAt: 200,
          events: mainEvents(),
          corruptTail: true,
        },
      ],
    });
  });

  it("search：header 可读但解码失败的会话只进 excluded", () => {
    const outcome = runSearch(
      contextOf(home),
      "needle",
      { origin: "all" },
      {
        caseSensitive: false,
        context: 20,
        limit: 0,
        scope: "text",
      },
    );
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    const coverage = outcome.data.coverage;
    assert.equal(coverage.scannedCount, 2);
    assert.equal(coverage.includedCount, 1);
    assert.deepEqual(
      coverage.excluded.map((item) => [item.id, item.reason]),
      [["session-cov-bad-02", "解码失败"]],
    );
    // 恒等式与"不得双计"必须同时成立：`includedCount` 与被排除者互斥。
    assert.equal(coverage.scannedCount, coverage.includedCount + coverage.excluded.length);
    assert.equal(
      outcome.data.distribution.some((item) => item.sessionId === "session-cov-bad-02"),
      false,
    );
  });

  it("stats 全局：与 search 同口径", () => {
    const outcome = runStats(contextOf(home), undefined, { origin: "all" });
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    const coverage = outcome.data.coverage;
    assert.equal(coverage.scannedCount, 2);
    assert.equal(coverage.includedCount, 1);
    assert.deepEqual(
      coverage.excluded.map((item) => [item.id, item.reason]),
      [["session-cov-bad-02", "解码失败"]],
    );
    assert.equal(coverage.scannedCount, coverage.includedCount + coverage.excluded.length);
  });

  it("list：发现阶段跳过者仍计入排除，纳入数不受影响", () => {
    const outcome = buildList(contextOf(BROKEN_HOME), defaultFilters());
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    const coverage = outcome.data.coverage;
    assert.equal(coverage.scannedCount, coverage.includedCount + coverage.excluded.length);
    assert.equal(
      coverage.excluded.some((item) => item.id === "session-broken-corrupt-08"),
      true,
    );
  });
});
