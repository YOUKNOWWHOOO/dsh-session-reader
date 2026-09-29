// 发现与元数据单元测试：canonical generation 枚举（多代取最高版本、明文标记）、会话发现与
// header 读取容错（不可读 header 记入 skipped）、projcache 三源元数据（缺失/版本不匹配/
// identity 不匹配/部分行缺失）与 workspace.json 索引。

import assert from "node:assert/strict";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { discoverReadableSessions, enumerateSessionFiles } from "../scripts/lib/store-discovery.ts";
import { buildMetadata, loadProjCache, loadWorkspaceIndex } from "../scripts/lib/store-metadata.ts";
import {
  CURRENT_LOG_VERSION,
  fakeCatalog,
  findEntry,
  initStoreFixtures,
  MAIN_CWD,
  storeFixtures,
} from "./store-helpers.ts";

const fixtures = storeFixtures("discovery");
const TEMP_ROOT = fixtures.tempRoot;
const HEALTHY_HOME = fixtures.healthyHome;
const BROKEN_HOME = fixtures.brokenHome;

before(() => {
  initStoreFixtures(fixtures);
});

describe("enumerateSessionFiles / discoverReadableSessions", () => {
  it("枚举全部 canonical generation 文件（多代取最高版本、明文标记）", () => {
    const refs = enumerateSessionFiles(HEALTHY_HOME);
    assert.equal(refs.success, true);
    if (!refs.success) return;
    assert.equal(refs.data.length, 9);
    const multigen = refs.data.find((ref) => ref.idFromDir === "session-fixture-multigen-04");
    assert.equal(multigen?.logVersion, CURRENT_LOG_VERSION);
    assert.equal(multigen?.logCompressed, true);
    const plain = refs.data.find((ref) => ref.idFromDir === "session-fixture-plain-03");
    assert.equal(plain?.logCompressed, false);
  });

  it("发现会话并读取 header（id/cwd/大小），不跳过任何会话", () => {
    const result = discoverReadableSessions(HEALTHY_HOME, fakeCatalog);
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.entries.length, 9);
    assert.deepEqual(result.data.skipped, []);
    const main = findEntry(result.data.entries, "session-fixture-main-01");
    assert.equal(main.header.cwd, MAIN_CWD);
    assert.equal(main.sizeBytes > 0, true);
  });

  it("sessions 根缺失报目标不存在", () => {
    const result = discoverReadableSessions(join(TEMP_ROOT, "no-such-home"), fakeCatalog);
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.category, "target-missing");
  });

  it("header 不可读的会话记入 skipped 而非整体失败（容错语义）", () => {
    const result = discoverReadableSessions(BROKEN_HOME, fakeCatalog);
    assert.equal(result.success, true);
    if (!result.success) return;
    // 夹具中只有 corrupt 会话的 header 帧被破坏；tornTail 只截断末帧、gap 只缺 seq，二者 header 仍可读。
    assert.equal(result.data.entries.length, 2);
    assert.equal(result.data.skipped.length, 1);
    assert.equal(result.data.skipped[0].idFromDir, "session-broken-corrupt-08");
  });
});

describe("loadProjCache / buildMetadata", () => {
  it("有效 projcache：identity 校验通过、行值可读", () => {
    const entries = discoverReadableSessions(HEALTHY_HOME, fakeCatalog);
    assert.equal(entries.success, true);
    if (!entries.success) return;
    assert.deepEqual(entries.data.skipped, []);
    const main = findEntry(entries.data.entries, "session-fixture-main-01");
    const cache = loadProjCache(HEALTHY_HOME, main.id, main.header);
    assert.equal(cache.available, true);
    const metadata = buildMetadata(cache);
    assert.equal(metadata.title.value, "夹具标题 A");
    assert.equal(metadata.title.unavailable, false);
    assert.equal(metadata.turns.value, 2);
    assert.equal(metadata.tokens.value?.uncachedInputTokens, 100);
    assert.equal(metadata.model.value?.provider, "fixture-provider");
    assert.deepEqual(metadata.reasons, []);
  });

  it("projcache 缺失/版本不符/identity 不符 → 元数据不可用并给出原因", () => {
    const entries = discoverReadableSessions(HEALTHY_HOME, fakeCatalog);
    assert.equal(entries.success, true);
    if (!entries.success) return;
    assert.deepEqual(entries.data.skipped, []);
    const cases: Array<[string, RegExp]> = [
      ["session-fixture-nocache-09", /缺失/u],
      ["session-fixture-version-08", /版本不匹配/u],
      ["session-fixture-identity-07", /identity 不匹配/u],
    ];
    for (const [id, pattern] of cases) {
      const entry = findEntry(entries.data.entries, id);
      const cache = loadProjCache(HEALTHY_HOME, entry.id, entry.header);
      const metadata = buildMetadata(cache);
      assert.equal(metadata.available, false);
      assert.equal(metadata.title.unavailable, true);
      assert.equal(
        metadata.reasons.some((reason) => pattern.test(reason)),
        true,
        `原因不匹配: ${id}`,
      );
    }
  });

  it("projcache 部分行缺失：缺失行标注不可用、其它行可用", () => {
    const entries = discoverReadableSessions(HEALTHY_HOME, fakeCatalog);
    assert.equal(entries.success, true);
    if (!entries.success) return;
    assert.deepEqual(entries.data.skipped, []);
    const entry = findEntry(entries.data.entries, "session-fixture-partial-06");
    const cache = loadProjCache(HEALTHY_HOME, entry.id, entry.header);
    const metadata = buildMetadata(cache);
    assert.equal(metadata.available, true);
    assert.equal(metadata.turns.unavailable, true);
    assert.equal(metadata.tokens.unavailable, false);
    assert.equal(
      metadata.reasons.some((reason) => /sessionStats/u.test(reason)),
      true,
    );
  });
});

describe("loadWorkspaceIndex", () => {
  it("读取工作区标题与路径", () => {
    const workspaces = loadWorkspaceIndex(HEALTHY_HOME);
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].title, "user_projects");
    assert.equal(workspaces[0].path, MAIN_CWD);
  });

  it("缺失时返回空表", () => {
    assert.deepEqual(loadWorkspaceIndex(join(TEMP_ROOT, "no-such-home")), []);
  });
});
