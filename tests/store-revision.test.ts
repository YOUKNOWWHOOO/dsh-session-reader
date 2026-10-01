// 审查修订补充测试：不可用指标不静默显 0、workspace.json 不可解析、search 摘录按码点切片、
// 帧边界（解压失败/截断 header 帧/跨 64KiB 容量增长）、check 与发现阶段的分支、
// 标识解析精确歧义、projcache JSON 不可解析、同版本 .zstd 与明文并存。

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { zstdCompressSync } from "node:zlib";
import type { SessionFormatCatalog } from "../scripts/lib/decode.ts";
import { runCheck } from "../scripts/lib/store-check.ts";
import {
  discoverReadableSessions,
  enumerateSessionFiles,
  readSessionFile,
} from "../scripts/lib/store-discovery.ts";
import { loadProjCache, loadWorkspaceIndex } from "../scripts/lib/store-metadata.ts";
import { runSearch } from "../scripts/lib/store-search.ts";
import { runStats } from "../scripts/lib/store-stats.ts";
import { resolveSessionTarget } from "../scripts/lib/store-target.ts";
import type { StoreContext } from "../scripts/lib/store-types.ts";
import {
  CURRENT_LOG_VERSION,
  createFakeCatalog,
  resetTempDir,
  writeFixtureHome,
} from "./fixtures.ts";
import {
  contextOf,
  event,
  fakeCatalog,
  initStoreFixtures,
  OTHER_CWD,
  PROJECT_OTHER,
  singleEvent,
  storeFixtures,
} from "./store-helpers.ts";

const fixtures = storeFixtures("revision");
const TEMP_ROOT = fixtures.tempRoot;
const HEALTHY_HOME = fixtures.healthyHome;

before(() => {
  initStoreFixtures(fixtures);
});

describe("审查修订补充：不可用口径 / 码点切片 / 边界分支", () => {
  function contextWith(home: string, catalog: SessionFormatCatalog): StoreContext {
    return {
      dshHome: home,
      catalog,
      catalogsBySessionId: new Map(),
      historicalChildFailuresBySessionId: new Map(),
    };
  }

  function plainHeader(id: string): string {
    return `${JSON.stringify({ type: "session", version: CURRENT_LOG_VERSION, id, createdAt: 1, isSeeded: false, delegationDepth: 0 })}\n`;
  }

  function writePlainSession(root: string, id: string, content: string): void {
    const dir = join(root, "sessions", PROJECT_OTHER, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `session.v${CURRENT_LOG_VERSION}.jsonl`), content, "utf8");
  }

  function writeZstdSession(root: string, id: string, buffer: Buffer): void {
    const dir = join(root, "sessions", PROJECT_OTHER, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `session.v${CURRENT_LOG_VERSION}.jsonl.zstd`), buffer);
  }

  /** 手工构造"结构完整但解压必然失败"的单帧（compressed 块 + 全 0xFF 垃圾载荷）。 */
  function garbageFrame(payloadLength: number): Buffer {
    const buffer = Buffer.alloc(9 + payloadLength, 0xff);
    buffer.writeUInt32LE(4247762216, 0);
    buffer.writeUInt8(0, 4);
    buffer.writeUInt8(0, 5);
    buffer.writeUIntLE(1 | (2 << 1) | (payloadLength << 3), 6, 3);
    return buffer;
  }

  it("stats：不可用指标不静默显 0；全局附未计入会话数", () => {
    const partial = runStats(contextOf(HEALTHY_HOME), "session-fixture-partial-06", {
      origin: "all",
    });
    assert.equal(partial.success, true);
    if (!partial.success) return;
    assert.equal(partial.data.single?.blank.unavailable, true);
    assert.equal(partial.data.single?.turns.unavailable, true);
    assert.equal(partial.data.excludedMetricSessions, 0);

    const nocache = runStats(contextOf(HEALTHY_HOME), "session-fixture-nocache-09", {
      origin: "all",
    });
    assert.equal(nocache.success, true);
    if (!nocache.success) return;
    assert.equal(nocache.data.single?.tokens.unavailable, true);

    const blank = runStats(contextOf(HEALTHY_HOME), "session-fixture-blank-05", {
      origin: "all",
    });
    assert.equal(blank.success, true);
    if (!blank.success) return;
    assert.equal(blank.data.blankCount, 1);

    const global = runStats(contextOf(HEALTHY_HOME), undefined, { origin: "all" });
    assert.equal(global.success, true);
    if (!global.success) return;
    // partial-06 / identity-07 / version-08 / nocache-09 的轮次或步数不可用 → 未计入总和。
    assert.equal(global.data.excludedMetricSessions, 4);
    assert.equal(global.data.turns, 3);
  });

  it("workspace.json 不可解析时返回空表", () => {
    const home = join(TEMP_ROOT, "bad-workspace-dsh");
    resetTempDir(home);
    mkdirSync(join(home, "storages"), { recursive: true });
    writeFileSync(join(home, "storages", "workspace.json"), "not-json", "utf8");
    assert.deepEqual(loadWorkspaceIndex(home), []);
  });

  it("search 摘录按码点切片：代理对不被切断", () => {
    const home = join(TEMP_ROOT, "surrogate-dsh");
    resetTempDir(home);
    writeFixtureHome(home, {
      sessions: [
        {
          id: "session-surrogate-01",
          projectDir: PROJECT_OTHER,
          cwd: OTHER_CWD,
          createdAt: 1000,
          events: [
            event(
              "user/message",
              0,
              10,
              { role: "user", content: [{ type: "text", text: "😀😀target😀😀" }] },
              { surfaceOp: "append" },
            ),
          ],
          title: null,
          turns: 0,
          steps: 0,
          lastPromptAt: null,
        },
      ],
    });
    const outcome = runSearch(
      contextOf(home),
      "target",
      { origin: "all" },
      { scope: "text", caseSensitive: false, context: 1, limit: 0 },
    );
    assert.equal(outcome.success, true);
    if (!outcome.success) return;
    assert.equal(outcome.data.hits.length, 1);
    assert.equal(outcome.data.hits[0].excerpt, "…😀target😀…");
    assert.equal(outcome.data.hits[0].excerpt.includes("\uFFFD"), false);
  });

  it("帧边界：解压失败 / 截断 header 帧 / 跨 64KiB 容量增长", () => {
    const home = join(TEMP_ROOT, "frame-edge-dsh");
    resetTempDir(home);
    writeZstdSession(home, "session-frame-fail-01", garbageFrame(8));
    const compressed = zstdCompressSync(Buffer.from(plainHeader("session-frame-torn-02")));
    writeZstdSession(
      home,
      "session-frame-torn-02",
      compressed.subarray(0, Math.max(8, Math.floor(compressed.length / 2))),
    );
    const big = `${JSON.stringify({
      type: "session",
      version: 3,
      id: "session-frame-big-03",
      createdAt: 1,
      isSeeded: false,
      delegationDepth: 0,
      pad: randomBytes(300_000).toString("base64"),
    })}\n`;
    writeZstdSession(home, "session-frame-big-03", zstdCompressSync(Buffer.from(big)));

    const discovered = discoverReadableSessions(home, fakeCatalog);
    assert.equal(discovered.success, true);
    if (!discovered.success) return;
    const skipped = discovered.data.skipped;
    assert.equal(
      skipped.some((entry) => entry.error.includes("header 帧解压失败")),
      true,
    );
    assert.equal(
      skipped.some((entry) => entry.error.includes("header 帧不完整")),
      true,
    );
    assert.equal(
      discovered.data.entries.some((entry) => entry.id === "session-frame-big-03"),
      true,
    );

    const refs = enumerateSessionFiles(home);
    assert.equal(refs.success, true);
    if (!refs.success) return;
    const ref = refs.data.find((entry) => entry.idFromDir === "session-frame-fail-01");
    assert.notEqual(ref, undefined);
    if (ref === undefined) return;
    const result = readSessionFile(
      {
        id: "session-frame-fail-01",
        projectDirName: ref.projectDirName,
        dirPath: ref.dirPath,
        logPath: ref.logPath,
        logVersion: ref.logVersion,
        logCompressed: ref.logCompressed,
        sizeBytes: ref.sizeBytes,
        header: {},
      },
      fakeCatalog,
    );
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.category, "data-unreadable");

    const checked = runCheck(contextOf(home), undefined);
    assert.equal(checked.success, true);
    if (!checked.success) return;
    const failed = checked.data.sessions.find((entry) => entry.id === "session-frame-fail-01");
    assert.equal(
      failed?.anomalies.some((value) => value.includes("帧解压失败")),
      true,
    );
  });

  it("check 边界：空日志 / 坏行 / 缺 seq / 分类 malformed", () => {
    const home = join(TEMP_ROOT, "check-edge-dsh");
    resetTempDir(home);
    writePlainSession(home, "session-edge-empty-01", "");
    writePlainSession(
      home,
      "session-edge-bad-02",
      `${plainHeader("session-edge-bad-02")}not-json\n{\n`,
    );
    writePlainSession(
      home,
      "session-edge-noseq-03",
      `${plainHeader("session-edge-noseq-03")}${JSON.stringify({ type: "turn/start", time: 1, data: {} })}\n`,
    );
    const checked = runCheck(contextOf(home), undefined);
    assert.equal(checked.success, true);
    if (!checked.success) return;
    const empty = checked.data.sessions.find((entry) => entry.id === "session-edge-empty-01");
    assert.equal(empty?.anomalies.includes("日志为空"), true);
    const bad = checked.data.sessions.find((entry) => entry.id === "session-edge-bad-02");
    assert.equal(bad?.badLineCount, 2);
    const noseq = checked.data.sessions.find((entry) => entry.id === "session-edge-noseq-03");
    assert.equal(
      noseq?.anomalies.some((value) => value.includes("缺少 seq")),
      true,
    );
    writePlainSession(home, "session-edge-badheader-05", "not-json\n");
    const checkedAgain = runCheck(contextOf(home), undefined);
    assert.equal(checkedAgain.success, true);
    if (!checkedAgain.success) return;
    const badHeader = checkedAgain.data.sessions.find(
      (item) => item.id === "session-edge-badheader-05",
    );
    assert.equal(badHeader?.anomalies.includes("header 行不是合法 JSON"), true);

    const malformedHome = join(TEMP_ROOT, "check-malformed-dsh");
    resetTempDir(malformedHome);
    writePlainSession(
      malformedHome,
      "session-edge-malformed-04",
      plainHeader("session-edge-malformed-04"),
    );
    const malformed = runCheck(
      contextWith(malformedHome, createFakeCatalog({ status: "malformed" })),
      undefined,
    );
    assert.equal(malformed.success, true);
    if (!malformed.success) return;
    const entry = malformed.data.sessions.find((item) => item.id === "session-edge-malformed-04");
    assert.equal(entry?.classification, "malformed");
    assert.equal(
      entry?.anomalies.some((value) => value.includes("header 分类: malformed")),
      true,
    );
  });

  it("discoverReadableSessions：坏 JSON / 缺 id / 分类缺逻辑 header 的跳过分支", () => {
    const home = join(TEMP_ROOT, "discovery-edge-dsh");
    resetTempDir(home);
    writePlainSession(home, "session-disc-badjson-01", "not-json\n");
    writePlainSession(
      home,
      "session-disc-noid-02",
      `${JSON.stringify({ type: "session", version: 3 })}\n`,
    );
    const discovered = discoverReadableSessions(home, fakeCatalog);
    assert.equal(discovered.success, true);
    if (!discovered.success) return;
    assert.equal(discovered.data.entries.length, 0);
    assert.equal(
      discovered.data.skipped.some((entry) => entry.error === "header 行不是合法 JSON"),
      true,
    );
    assert.equal(
      discovered.data.skipped.some((entry) => entry.error === "header 缺少 id"),
      true,
    );

    const noHeaderCatalog: SessionFormatCatalog = {
      currentVersion: 3,
      readHeader: () => ({ status: "current", storedVersion: 3, targetVersion: 3 }),
      createRestore: () => {
        throw new Error("该测试不应触发 createRestore");
      },
    };
    const noHeader = discoverReadableSessions(home, noHeaderCatalog);
    assert.equal(noHeader.success, true);
    if (!noHeader.success) return;
    assert.equal(
      noHeader.data.skipped.some((entry) => entry.error === "header 分类缺少逻辑 header"),
      true,
    );

    const malformedCatalog = createFakeCatalog({ status: "malformed" });
    const malformed = discoverReadableSessions(home, malformedCatalog);
    assert.equal(malformed.success, true);
    if (!malformed.success) return;
    assert.equal(
      malformed.data.skipped.some((entry) => entry.error === "header 分类 malformed"),
      true,
    );
  });

  it("标识解析：裸 id 与 session- 前缀同时精确匹配 → 歧义", () => {
    const home = join(TEMP_ROOT, "ambiguous-exact-dsh");
    resetTempDir(home);
    writeFixtureHome(home, {
      sessions: [
        {
          id: "e2e1e2e1",
          projectDir: PROJECT_OTHER,
          cwd: OTHER_CWD,
          createdAt: 1,
          events: singleEvent(),
          title: null,
          turns: 0,
          steps: 0,
          lastPromptAt: null,
        },
        {
          id: "session-e2e1e2e1",
          projectDir: PROJECT_OTHER,
          cwd: OTHER_CWD,
          createdAt: 2,
          events: singleEvent(),
          title: null,
          turns: 0,
          steps: 0,
          lastPromptAt: null,
        },
      ],
    });
    const resolved = resolveSessionTarget(contextOf(home), "e2e1e2e1");
    assert.equal(resolved.success, false);
    if (!resolved.success) assert.equal(resolved.error.category, "ambiguous");
  });

  it("loadProjCache：JSON 不可解析 → projcache 读取失败", () => {
    const home = join(TEMP_ROOT, "bad-projcache-dsh");
    resetTempDir(home);
    writeFixtureHome(home, {
      sessions: [
        {
          id: "session-badcache-01",
          projectDir: PROJECT_OTHER,
          cwd: OTHER_CWD,
          createdAt: 1,
          events: singleEvent(),
          title: null,
          turns: 0,
          steps: 0,
          lastPromptAt: null,
        },
      ],
    });
    writeFileSync(
      join(home, "storages", "session_projcache", "sessions", "session-badcache-01.json"),
      "not-json",
      "utf8",
    );
    const state = loadProjCache(home, "session-badcache-01", {
      version: 3,
      createdAt: 1,
      cwd: OTHER_CWD,
      isSeeded: false,
    });
    assert.equal(state.available, false);
    assert.equal(state.reason, "projcache 读取失败");
  });

  it("同版本 .zstd 与明文并存：排序同版本分支（优先 .zstd）", () => {
    const home = join(TEMP_ROOT, "same-version-dsh");
    resetTempDir(home);
    writeFixtureHome(home, {
      sessions: [
        {
          id: "session-samever-01",
          projectDir: PROJECT_OTHER,
          cwd: OTHER_CWD,
          createdAt: 1,
          events: singleEvent(),
          title: null,
          turns: 0,
          steps: 0,
          lastPromptAt: null,
          extraFiles: [
            {
              fileName: `session.v${CURRENT_LOG_VERSION}.jsonl`,
              content: Buffer.from(plainHeader("session-samever-01"), "utf8"),
            },
          ],
        },
      ],
    });
    const refs = enumerateSessionFiles(home);
    assert.equal(refs.success, true);
    if (!refs.success) return;
    const entry = refs.data.find((item) => item.idFromDir === "session-samever-01");
    assert.equal(entry?.logCompressed, true);
  });
});
