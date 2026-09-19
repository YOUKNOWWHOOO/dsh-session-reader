// 校验单元测试：runCheck 对健康数据报无异常、对异常数据（撕裂尾/seq 不连续/结构损坏）
// 逐项报告，以及指定目标时只检查该会话。

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { runCheck } from "../scripts/lib/store-check.ts";
import { contextOf, initStoreFixtures, storeFixtures } from "./store-helpers.ts";

const fixtures = storeFixtures("check");
const HEALTHY_HOME = fixtures.healthyHome;
const BROKEN_HOME = fixtures.brokenHome;

before(() => {
  initStoreFixtures(fixtures);
});

describe("runCheck", () => {
  it("健康数据：无异常", () => {
    const outcome = runCheck(contextOf(HEALTHY_HOME), undefined);
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.sessions.length, 9);
    assert.equal(outcome.data.anomalyCount, 0);
    assert.equal(
      outcome.data.sessions.every((session) => session.structure === "完整"),
      true,
    );
  });

  it("异常数据：撕裂尾/seq 不连续/结构损坏逐项报告", () => {
    const outcome = runCheck(contextOf(BROKEN_HOME), undefined);
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.sessions.length, 3);
    assert.equal(outcome.data.anomalyCount >= 3, true);
    const torn = outcome.data.sessions.find((session) => session.id === "session-broken-torn-06");
    assert.equal(torn?.structure.startsWith("tornStart@"), true);
    const gap = outcome.data.sessions.find((session) => session.id === "session-broken-gap-07");
    assert.equal(gap?.seqContiguous, false);
    const corrupt = outcome.data.sessions.find(
      (session) => session.id === "session-broken-corrupt-08",
    );
    assert.equal(corrupt?.structure, "结构损坏");
  });

  it("指定目标时只检查该会话", () => {
    const outcome = runCheck(contextOf(HEALTHY_HOME), "fixture-main-01");
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.sessions.length, 1);
    assert.equal(outcome.data.anomalyCount, 0);
  });
});
