// 目标解析与子树单元测试：完整 id、裸 uuid 前缀与 last 的解析及其失败分类（前缀过短/
// 无匹配/歧义），会话文件读取（完整解码、结构损坏、撕裂尾）与子代理树递归构建。

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  discoverReadableSessions,
  enumerateSessionFiles,
  readSessionFile,
} from "../scripts/lib/store-discovery.ts";
import { buildSessionNode, resolveSessionTarget } from "../scripts/lib/store-target.ts";
import {
  contextOf,
  fakeCatalog,
  findEntry,
  initStoreFixtures,
  storeFixtures,
} from "./store-helpers.ts";

const fixtures = storeFixtures("target");
const HEALTHY_HOME = fixtures.healthyHome;
const BROKEN_HOME = fixtures.brokenHome;

before(() => {
  initStoreFixtures(fixtures);
});

describe("resolveSessionTarget", () => {
  it("完整 id 与裸 uuid 前缀均可解析", () => {
    const ctx = contextOf(HEALTHY_HOME);
    const full = resolveSessionTarget(ctx, "session-fixture-main-01");
    assert.equal(full.success, true);
    if (!full.success) return;
    assert.equal(full.data.id, "session-fixture-main-01");
    const prefix = resolveSessionTarget(ctx, "fixture-main-01");
    assert.equal(prefix.success, true);
    if (!prefix.success) return;
    assert.equal(prefix.data.id, "session-fixture-main-01");
  });

  it("前缀过短 → argument-invalid；无匹配 → target-missing", () => {
    const ctx = contextOf(HEALTHY_HOME);
    const short = resolveSessionTarget(ctx, "abc");
    assert.equal(short.success, false);
    if (!short.success) assert.equal(short.error.category, "argument-invalid");
    const none = resolveSessionTarget(ctx, "zzzzzzzz");
    assert.equal(none.success, false);
    if (!none.success) assert.equal(none.error.category, "target-missing");
  });

  it("歧义前缀报候选数", () => {
    const result = resolveSessionTarget(contextOf(HEALTHY_HOME), "session-fixture");
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.error.category, "ambiguous");
    assert.equal(result.error.candidates, 8);
  });

  it("last 解析为主会话中最近活动者", () => {
    const result = resolveSessionTarget(contextOf(HEALTHY_HOME), "last");
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.id, "session-fixture-main-01");
  });
});

describe("readSessionFile / buildSessionNode", () => {
  it("读取完整解码日志（事件数/帧数）", () => {
    const entries = discoverReadableSessions(HEALTHY_HOME, fakeCatalog);
    assert.equal(entries.success, true);
    if (!entries.success) return;
    assert.deepEqual(entries.data.skipped, []);
    const entry = findEntry(entries.data.entries, "session-fixture-main-01");
    const file = readSessionFile(entry, fakeCatalog);
    assert.equal(file.success, true);
    if (!file.success) return;
    assert.equal(file.data.decoded.events.length, 14);
    assert.equal(file.data.frames, 6);
    assert.equal(file.data.tornStart, undefined);
  });

  it("结构损坏文件报数据不可读", () => {
    const refs = enumerateSessionFiles(BROKEN_HOME);
    assert.equal(refs.success, true);
    if (!refs.success) return;
    const ref = refs.data.find((candidate) => candidate.idFromDir === "session-broken-corrupt-08");
    assert.notEqual(ref, undefined);
    if (ref === undefined) return;
    const file = readSessionFile({ ...ref, id: ref.idFromDir, header: {} }, fakeCatalog);
    assert.equal(file.success, false);
    if (!file.success) assert.equal(file.error.category, "data-unreadable");
  });

  it("撕裂尾：完整帧事件可读并记入 anomalies", () => {
    const refs = enumerateSessionFiles(BROKEN_HOME);
    assert.equal(refs.success, true);
    if (!refs.success) return;
    const ref = refs.data.find((candidate) => candidate.idFromDir === "session-broken-torn-06");
    assert.notEqual(ref, undefined);
    if (ref === undefined) return;
    const file = readSessionFile({ ...ref, id: ref.idFromDir, header: {} }, fakeCatalog);
    assert.equal(file.success, true);
    if (!file.success) return;
    assert.equal(file.data.decoded.events.length, 3);
    assert.equal(
      file.data.decoded.anomalies.some((anomaly) => anomaly.kind === "torn-tail"),
      true,
    );
  });

  it("子代理树递归构建", () => {
    const entries = discoverReadableSessions(HEALTHY_HOME, fakeCatalog);
    assert.equal(entries.success, true);
    if (!entries.success) return;
    assert.deepEqual(entries.data.skipped, []);
    const main = findEntry(entries.data.entries, "session-fixture-main-01");
    const node = buildSessionNode(contextOf(HEALTHY_HOME), main, entries.data.entries, new Set());
    assert.equal(node.success, true);
    if (!node.success) return;
    assert.equal(node.data.children.length, 1);
    assert.equal(node.data.children[0].entry.id, "bbbb1111-2222-3333-4444-555566667777");
  });
});
