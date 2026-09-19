// 列表单元测试：buildList 默认隐藏空会话与匹配/扫描计数、origin/工作区/时间/标题过滤、
// 排序（time/created/title）与 limit 只作用于显示、工作区标题与可用性标记。

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { buildList } from "../scripts/lib/store-list.ts";
import {
  contextOf,
  defaultFilters,
  initStoreFixtures,
  OTHER_CWD,
  storeFixtures,
} from "./store-helpers.ts";

const fixtures = storeFixtures("list");
const HEALTHY_HOME = fixtures.healthyHome;

before(() => {
  initStoreFixtures(fixtures);
});

describe("buildList", () => {
  it("默认隐藏空会话并统计匹配/扫描数", () => {
    const outcome = buildList(contextOf(HEALTHY_HOME), defaultFilters());
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.scannedCount, 9);
    assert.equal(outcome.data.hiddenBlankCount, 1);
    assert.equal(outcome.data.matchedCount, 8);
    assert.equal(
      outcome.data.entries.some((entry) => entry.id === "session-fixture-blank-05"),
      false,
    );
  });

  it("--include-blank 显示空会话", () => {
    const outcome = buildList(contextOf(HEALTHY_HOME), defaultFilters({ includeBlank: true }));
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.entries.length, 9);
    assert.equal(outcome.data.hiddenBlankCount, 0);
  });

  it("origin 过滤 main/subagent", () => {
    const subagents = buildList(contextOf(HEALTHY_HOME), defaultFilters({ origin: "subagent" }));
    assert.equal(subagents.success, true);
    if (!subagents.success) return;
    assert.equal(subagents.data.entries.length, 1);
    assert.equal(subagents.data.entries[0].type, "subagent");
    const mains = buildList(contextOf(HEALTHY_HOME), defaultFilters({ origin: "main" }));
    assert.equal(mains.success, true);
    if (!mains.success) return;
    assert.equal(
      mains.data.entries.every((entry) => entry.type === "main"),
      true,
    );
  });

  it("工作区过滤：标题精确匹配与路径归一化匹配", () => {
    const byTitle = buildList(
      contextOf(HEALTHY_HOME),
      defaultFilters({ workspace: "user_projects" }),
    );
    assert.equal(byTitle.success, true);
    if (!byTitle.success) return;
    assert.deepEqual(byTitle.data.entries.map((entry) => entry.id).sort(), [
      "bbbb1111-2222-3333-4444-555566667777",
      "session-fixture-main-01",
    ]);
    const byPath = buildList(
      contextOf(HEALTHY_HOME),
      defaultFilters({ workspace: "c:\\users\\zhang" }),
    );
    assert.equal(byPath.success, true);
    if (!byPath.success) return;
    assert.equal(byPath.data.matchedCount, 6);
    assert.equal(
      byPath.data.entries.every((entry) => entry.cwd === OTHER_CWD),
      true,
    );
  });

  it("工作区过滤值无匹配 → 目标不存在", () => {
    const outcome = buildList(
      contextOf(HEALTHY_HOME),
      defaultFilters({ workspace: "no-such-workspace" }),
    );
    assert.equal(outcome.success, false);
    if (!outcome.success) assert.equal(outcome.error.category, "target-missing");
  });

  it("时间过滤按最近活动（lastPromptAt，缺失取 createdAt）", () => {
    const since = buildList(contextOf(HEALTHY_HOME), defaultFilters({ since: 1000 }));
    assert.equal(since.success, true);
    if (!since.success) return;
    assert.deepEqual(
      since.data.entries.map((entry) => entry.id).sort(),
      [
        "session-fixture-main-01",
        "session-fixture-nocache-09",
        "session-fixture-version-08",
        "bbbb1111-2222-3333-4444-555566667777",
      ].sort(),
    );
    const until = buildList(contextOf(HEALTHY_HOME), defaultFilters({ until: 800 }));
    assert.equal(until.success, true);
    if (!until.success) return;
    assert.deepEqual(until.data.entries.map((entry) => entry.id).sort(), [
      "session-fixture-multigen-04",
      "session-fixture-partial-06",
      "session-fixture-plain-03",
    ]);
  });

  it("标题子串过滤不区分大小写", () => {
    const outcome = buildList(contextOf(HEALTHY_HOME), defaultFilters({ title: "title" }));
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.deepEqual(
      outcome.data.entries.map((entry) => entry.id),
      ["session-fixture-multigen-04"],
    );
  });

  it("排序：time/created 降序、title 升序、limit 作用于显示", () => {
    const byTime = buildList(contextOf(HEALTHY_HOME), defaultFilters());
    assert.equal(byTime.success, true);
    if (!byTime.success) return;
    assert.equal(byTime.data.entries[0].id, "session-fixture-main-01");
    assert.equal(
      byTime.data.entries[byTime.data.entries.length - 1].id,
      "session-fixture-plain-03",
    );

    const byCreated = buildList(contextOf(HEALTHY_HOME), defaultFilters({ sort: "created" }));
    assert.equal(byCreated.success, true);
    if (!byCreated.success) return;
    assert.equal(byCreated.data.entries[0].id, "bbbb1111-2222-3333-4444-555566667777");

    const byTitle = buildList(contextOf(HEALTHY_HOME), defaultFilters({ sort: "title" }));
    assert.equal(byTitle.success, true);
    if (!byTitle.success) return;
    assert.equal(
      byTitle.data.entries[byTitle.data.entries.length - 1].id,
      "session-fixture-main-01",
    );

    const limited = buildList(contextOf(HEALTHY_HOME), defaultFilters({ limit: 2 }));
    assert.equal(limited.success, true);
    if (!limited.success) return;
    assert.equal(limited.data.entries.length, 2);
    assert.equal(limited.data.matchedCount, 8);
  });

  it("工作区标题与可用性标记进入条目", () => {
    const outcome = buildList(
      contextOf(HEALTHY_HOME),
      defaultFilters({ workspace: "user_projects" }),
    );
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    const main = outcome.data.entries.find((entry) => entry.id === "session-fixture-main-01");
    assert.equal(main?.workspaceTitle, "user_projects");
    const sub = outcome.data.entries.find((entry) => entry.type === "subagent");
    assert.equal(sub?.workspaceTitle, "user_projects");
  });
});
