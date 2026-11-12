// 发现与元数据单元测试：canonical generation 枚举（多代取最高版本、明文标记）、会话发现与
// header 读取容错（不可读 header 记入 skipped）、projcache 三源元数据（缺失/版本不匹配/
// identity 不匹配/部分行缺失）与 workspace.json 索引。

import assert from "node:assert/strict";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { discoverReadableSessions, enumerateSessionFiles } from "../scripts/lib/store-discovery.ts";
import { buildList } from "../scripts/lib/store-list.ts";
import { buildMetadata, loadProjCache, loadWorkspaceIndex } from "../scripts/lib/store-metadata.ts";
import { runSearch } from "../scripts/lib/store-search.ts";
import { runStats } from "../scripts/lib/store-stats.ts";
import { resolveSessionTarget } from "../scripts/lib/store-target.ts";
import { CURRENT_LOG_VERSION, resetTempDir, writeFixtureHome } from "./fixtures.ts";
import {
  contextOf,
  defaultFilters,
  event,
  fakeCatalog,
  findEntry,
  initStoreFixtures,
  MAIN_CWD,
  OTHER_CWD,
  PROJECT_OTHER,
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
    assert.equal(Object.hasOwn(metadata, "turns"), false);
    assert.equal(Object.hasOwn(metadata, "tokens"), false);
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
    assert.equal(metadata.blank.unavailable, true);
    assert.equal(
      metadata.reasons.some((reason) => /sessionStats/u.test(reason)),
      false,
    );
  });
});

describe("数据命令只消费 ctx.discovery（发现只做一次）", () => {
  it("快照之后再写入会话：list/search/stats/目标解析都看不到它", () => {
    const home = join(TEMP_ROOT, "snapshot-dsh");
    resetTempDir(home);
    writeFixtureHome(home, {
      sessions: [
        {
          id: "session-snapshot-01",
          projectDir: PROJECT_OTHER,
          cwd: OTHER_CWD,
          createdAt: 1000,
          events: [
            event("turn/start", 0, 10, { turn: 1 }),
            event(
              "user/message",
              1,
              11,
              { role: "user", content: [{ type: "text", text: "快照检索词" }] },
              { surfaceOp: "append" },
            ),
          ],
          title: "快照会话",
          turns: 1,
          steps: 0,
          lastPromptAt: 2000,
        },
      ],
    });
    const ctx = contextOf(home);
    // 快照生成之后再写入第二个会话：任何"再发现一次"的实现都会看到两个会话，
    // 因此下面四条断言同时证明了发现只做一次。
    writeFixtureHome(home, {
      sessions: [
        {
          id: "session-snapshot-02",
          projectDir: PROJECT_OTHER,
          cwd: OTHER_CWD,
          createdAt: 3000,
          events: [event("turn/start", 0, 10, { turn: 1 })],
          title: "后写入会话",
          turns: 0,
          steps: 0,
          lastPromptAt: 4000,
        },
      ],
    });

    const listed = buildList(ctx, defaultFilters());
    assert.equal(listed.success, true, listed.success ? "" : `list 失败: ${listed.error.category}`);
    if (!listed.success) return;
    assert.equal(listed.data.matchedCount, 1);
    assert.equal(listed.data.entries[0].id, "session-snapshot-01");

    const searched = runSearch(
      ctx,
      "快照检索词",
      { origin: "all" },
      {
        scope: "text",
        caseSensitive: false,
        context: 10,
        limit: 0,
      },
    );
    assert.equal(
      searched.success,
      true,
      searched.success ? "" : `search 失败: ${searched.error.category}`,
    );
    if (!searched.success) return;
    assert.equal(searched.data.distribution.length, 1);
    assert.equal(searched.data.distribution[0].sessionId, "session-snapshot-01");

    const stats = runStats(ctx, undefined, { origin: "all" });
    assert.equal(stats.success, true, stats.success ? "" : `stats 失败: ${stats.error.category}`);
    if (!stats.success) return;
    assert.equal(stats.data.sessionCount, 1);

    const absent = resolveSessionTarget(ctx, "session-snapshot-02");
    assert.equal(absent.success, false);
    if (!absent.success) assert.equal(absent.error.category, "target-missing");
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
