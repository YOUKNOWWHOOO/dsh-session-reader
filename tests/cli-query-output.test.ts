// CLI 集成测试（检索、统计、校验与输出落盘）：search、stats、check、标题空值语义与输出策略。
// 与 cli-command.test.ts 的分工按职责划分：本文件覆盖"命令产出什么数据、产物如何落盘"。
// 共享夹具与运行器见 cli-helpers.ts。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import {
  outputFailure,
  removeTempFileIfExists,
  writeOutputFile,
} from "../scripts/session-reader.ts";
import {
  baseArgs as baseArgsOf,
  cliFixtures,
  ev,
  healthySpec,
  initCliFixtures,
  OTHER_CWD,
  PROJECT_OTHER,
  readContract,
  readOutput,
  runCli,
} from "./cli-helpers.ts";
import { resetTempDir, writeFixtureHome } from "./fixtures.ts";

const fixtures = cliFixtures("query");
const TEMP_ROOT = fixtures.tempRoot;
const HEALTHY_HOME = fixtures.healthyHome;
const BROKEN_HOME = fixtures.brokenHome;
const OUT_DIR = fixtures.outDir;

function baseArgs(home: string): string[] {
  return baseArgsOf(OUT_DIR, home);
}

before(() => {
  initCliFixtures(fixtures);
});

describe("CLI search", () => {
  it("默认 text 范围：大小写不敏感、末行汇总", () => {
    const result = runCli(["search", "alpha", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(result.status, 0);
    const content = readOutput(result.stdout);
    assert.equal(content.startsWith("# 检索结果\n\n"), true);
    assert.match(content, /命中总数：1$/mu);
    assert.equal(content.includes("`session-fixt"), true);
  });

  it("`--` 选项终止符：以 - 开头的关键词可表达", () => {
    const withoutTerminator = runCli(["search", "- item", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(withoutTerminator.status, 2);
    assert.equal(withoutTerminator.stderr, "错误: 参数无效（未知选项: - item）\n");
    const result = runCli(["search", "--scope", "all", ...baseArgs(HEALTHY_HOME), "--", "- item"]);
    assert.equal(result.status, 0);
    const content = readOutput(result.stdout);
    assert.match(content, /命中总数：\d+$/mu);
  });

  it("--case-sensitive 与 --scope tools/all", () => {
    const sensitive = runCli(["search", "ALPHA", ...baseArgs(HEALTHY_HOME), "--case-sensitive"]);
    const sensitiveContent = readOutput(sensitive.stdout);
    assert.match(sensitiveContent, /命中总数：1$/mu);

    const scopeTools = runCli([
      "search",
      "alpha",
      ...baseArgs(HEALTHY_HOME),
      "--scope",
      "tools",
      "--format",
      "json",
    ]);
    const toolsDoc = JSON.parse(readOutput(scopeTools.stdout)) as {
      total: number;
      scope: string;
      totalIsExact: boolean;
      matches: Array<{ label: string }>;
    };
    assert.equal(toolsDoc.total >= 3, true);
    assert.equal(toolsDoc.scope, "tools");
    assert.equal(toolsDoc.totalIsExact, true);
    assert.equal(
      toolsDoc.matches.some((match) => match.label === "tool/call"),
      true,
    );

    const scopeAll = runCli([
      "search",
      "ZETA",
      ...baseArgs(HEALTHY_HOME),
      "--scope",
      "all",
      "--format",
      "json",
    ]);
    const allDoc = JSON.parse(readOutput(scopeAll.stdout)) as {
      total: number;
      matches: Array<{ label: string }>;
    };
    // all 档同时产出语义单元（compaction/summary）与整条事件载荷（label = 事件类型），
    // 因此同一处文本会被两个单元各命中一次；关键是语义单元必须仍然可见。
    assert.equal(allDoc.total >= 1, true);
    assert.equal(
      allDoc.matches.some((match) => match.label === "compaction/summary"),
      true,
    );

    const textScope = runCli(["search", "ZETA", ...baseArgs(HEALTHY_HOME), "--format", "json"]);
    assert.equal((JSON.parse(readOutput(textScope.stdout)) as { total: number }).total, 0);
  });

  it("limit 截断显示但汇总为全量", () => {
    const result = runCli([
      "search",
      "alpha",
      ...baseArgs(HEALTHY_HOME),
      "--scope",
      "all",
      "--limit",
      "1",
      "--format",
      "json",
    ]);
    assert.equal(result.status, 0);
    const document = JSON.parse(readOutput(result.stdout)) as {
      total: number;
      truncated: boolean;
      matches: unknown[];
    };
    assert.equal(document.matches.length, 1);
    assert.equal(document.total >= 2, true);
    assert.equal(document.truncated, true);
  });

  it("扫描摘要与每会话命中分布进入产物（0 命中也有分母）", () => {
    const result = runCli(["search", "zzznomatch", ...baseArgs(HEALTHY_HOME), "--scope", "all"]);
    assert.equal(result.status, 0);
    const content = readOutput(result.stdout);
    assert.match(
      content,
      /扫描明细：解码日志 \d+ 份；读到事件 \d+ 个；解码失败 \d+ 份；帧解压失败 \d+ 帧/u,
    );
    assert.match(content, /事件时间范围：\d{4}-\d{2}-\d{2}T/u);
    assert.match(content, /## 每会话命中分布/u);
    // 0 命中的纳入会话也必须出现在分布表中，否则"没搜到"会被当成"不存在"。
    assert.match(content, /\| `session-fixture-main-01` \| 主 \| `夹具会话 A` \| 0 \|/u);
  });

  it("--exclude-session 剔除指定会话及其子代理子树", () => {
    // 默认 text 档下 "ALPHA" 只出现在主会话的用户消息里（scope=all 会因事件载荷重复计数），
    // 因此排除主会话后命中必然为 0（而非仅"变少"）。
    const scope = ["--scope", "text"] as const;
    const all = runCli(["search", "ALPHA", ...baseArgs(HEALTHY_HOME), ...scope]);
    const allContent = readOutput(all.stdout);
    assert.equal(Number(/^命中总数：(\d+)/mu.exec(allContent)?.[1] ?? "-1"), 1);

    const excluded = runCli([
      "search",
      "ALPHA",
      ...baseArgs(HEALTHY_HOME),
      ...scope,
      "--exclude-session",
      "session-fixture-main-01",
    ]);
    assert.equal(excluded.status, 0);
    const excludedContent = readOutput(excluded.stdout);
    assert.equal(Number(/^命中总数：(\d+)/mu.exec(excludedContent)?.[1] ?? "-1"), 0);
    // 被排除的会话自身与它的子代理都不应再出现在分布表中（子树语义）。
    assert.equal(excludedContent.includes("`session-fixture-main-01`"), false);
    assert.equal(excludedContent.includes("`cafe1111-2222-3333-4444-555566667777`"), false);
    // 覆盖声明仍成立，且纳入数已扣掉整棵子树。
    assert.match(excludedContent, /扫描会话 \d+ 个；纳入 \d+ 个；排除 \d+ 个/u);
  });

  it("--exclude-session 目标不存在时退出 1（不静默忽略）", () => {
    const result = runCli([
      "search",
      "needle",
      ...baseArgs(HEALTHY_HOME),
      "--exclude-session",
      "zzzzzzzz",
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "错误: 目标不存在\n");
    assert.equal(result.stdout, "");
  });
});

describe("CLI stats", () => {
  it("全局聚合 Markdown", () => {
    const result = runCli(["stats", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(result.status, 0);
    const content = readOutput(result.stdout);
    assert.equal(content.startsWith("# 统计\n\n"), true);
    assert.match(content, /- 会话数：5/u);
    assert.match(content, /- 空会话数：1/u);
    assert.match(content, /- 工具调用总数：1/u);
    assert.match(content, /- 时间跨度：/u);
  });

  it("单会话统计与 JSON（两种 kind 都带 excludedMetricSessions）", () => {
    const single = runCli(["stats", "fixture-main-01", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(single.status, 0);
    const content = readOutput(single.stdout);
    assert.equal(content.includes("夹具会话 A"), true);

    const json = runCli(["stats", ...baseArgs(HEALTHY_HOME), "--format", "json"]);
    const document = JSON.parse(readOutput(json.stdout)) as Record<string, unknown>;
    assert.equal(document.kind, "global");
    assert.equal(document.sessionCount, 5);
    // md 摘要行说"未计入"时必须能在 json 里读到同一个数。
    assert.equal(document.excludedMetricSessions, 0);

    const singleJson = runCli([
      "stats",
      "fixture-main-01",
      ...baseArgs(HEALTHY_HOME),
      "--format",
      "json",
    ]);
    const singleDocument = JSON.parse(readOutput(singleJson.stdout)) as Record<string, unknown>;
    assert.equal(singleDocument.kind, "single");
    assert.equal(singleDocument.excludedMetricSessions, 0);
  });

  it("单会话拒绝范围过滤（参数无效，退出 2）；全局聚合可用", () => {
    for (const extra of [
      ["--workspace", "user_projects"],
      ["--since", "0"],
      ["--until", "0"],
      ["--origin", "main"],
    ]) {
      const result = runCli(["stats", "fixture-main-01", ...baseArgs(HEALTHY_HOME), ...extra]);
      assert.equal(result.status, 2, `期望拒绝: ${extra.join(" ")}`);
      assert.equal(
        result.stderr,
        `错误: 参数无效（单会话统计不接受范围过滤选项 ${extra[0]}；去掉 ${extra[0]}，或去掉会话目标改用全局聚合）\n`,
      );
      assert.equal(result.stdout, "");
    }
    const globalFiltered = runCli(["stats", ...baseArgs(HEALTHY_HOME), "--origin", "main"]);
    assert.equal(globalFiltered.status, 0);
  });
});

describe("CLI check", () => {
  it("健康数据：无异常、退出 0", () => {
    const result = runCli(["check", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(result.status, 0);
    const content = readOutput(result.stdout);
    assert.equal(content.startsWith("# 完整性校验\n\n"), true);
    assert.match(content, /结论：无异常/u);
  });

  it("异常数据：结构损坏/撕裂尾/seq 不连续、退出 3", () => {
    const result = runCli(["check", ...baseArgs(BROKEN_HOME)]);
    assert.equal(result.status, 3);
    const content = readOutput(result.stdout);
    assert.equal(content.includes("结构损坏"), true);
    assert.match(content, /tornStart@\d+/u);
    assert.equal(content.includes("seq=不连续"), true);
    assert.match(content, /结论：发现 \d+ 项异常/u);
  });

  it("JSON 输出逐会话异常项", () => {
    const result = runCli(["check", ...baseArgs(BROKEN_HOME), "--format", "json"]);
    assert.equal(result.status, 3);
    const document = JSON.parse(readOutput(result.stdout)) as {
      sessions: Array<Record<string, unknown>>;
      anomalyCount: number;
    };
    assert.equal(document.sessions.length, 3);
    assert.equal(document.anomalyCount >= 3, true);
    const corrupt = document.sessions.find((session) => session.id === "session-broken-corrupt-08");
    assert.equal(corrupt?.structure, "结构损坏");
  });
});

describe("标题空值语义（CLI 层）", () => {
  const MARKER_TITLE = '<dsh-injection kind="subagent-task" src=';
  const MARKER_ID = "session-marker-title-01";
  const markerHome = join(TEMP_ROOT, "marker-title-dsh");

  before(() => {
    resetTempDir(markerHome);
    writeFixtureHome(markerHome, {
      sessions: [
        {
          id: MARKER_ID,
          projectDir: PROJECT_OTHER,
          cwd: OTHER_CWD,
          createdAt: 1000,
          events: [
            ev("turn/start", 0, 10, { turn: 1 }),
            ev("session/title", 1, 11, { title: MARKER_TITLE, messageSeqs: [] }),
          ],
          title: MARKER_TITLE,
          turns: 0,
          steps: 0,
          lastPromptAt: null,
        },
      ],
    });
  });

  it("list：md 标题列为 -、json 的 title 为 null", () => {
    const md = runCli(["list", ...baseArgs(markerHome)]);
    assert.equal(md.status, 0, `stderr=${md.stderr}`);
    const mdContent = readOutput(md.stdout);
    assert.match(mdContent, /^\| `session-marker-title-01` \| - \|/mu);
    assert.equal(mdContent.includes("subagent-task"), false);

    const json = runCli(["list", ...baseArgs(markerHome), "--format", "json"]);
    const document = JSON.parse(readOutput(json.stdout)) as {
      sessions: Array<Record<string, unknown>>;
    };
    assert.equal(document.sessions[0].title, null);
  });

  it("show：md 标题为 -、json 的 title 为 null", () => {
    const md = runCli(["show", MARKER_ID, ...baseArgs(markerHome)]);
    assert.equal(md.status, 0, `stderr=${md.stderr}`);
    const mdContent = readOutput(md.stdout);
    assert.equal(mdContent.includes("- 标题：-"), true);
    assert.equal(mdContent.includes("subagent-task"), false);

    const json = runCli(["show", MARKER_ID, ...baseArgs(markerHome), "--format", "json"]);
    const document = JSON.parse(readOutput(json.stdout)) as {
      session: Record<string, unknown>;
    };
    assert.equal(document.session.title, null);
  });

  it("stats 单会话：md 标题为 -、json 的 title 为 null", () => {
    const md = runCli(["stats", MARKER_ID, ...baseArgs(markerHome)]);
    assert.equal(md.status, 0, `stderr=${md.stderr}`);
    assert.equal(readOutput(md.stdout).includes("- 标题：-"), true);

    const json = runCli(["stats", MARKER_ID, ...baseArgs(markerHome), "--format", "json"]);
    const document = JSON.parse(readOutput(json.stdout)) as {
      session: Record<string, unknown>;
    };
    assert.equal(document.session.title, null);
  });

  it("search 的每会话命中分布：标题列为 -", () => {
    const result = runCli(["search", "zzznomatch", ...baseArgs(markerHome)]);
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    const content = readOutput(result.stdout);
    assert.match(content, /^\| `session-marker-title-01` \| 主 \| - \| 0 \|$/mu);
  });

  it("--title 对标记残片不命中（退出 0、零结果）", () => {
    const result = runCli(["list", ...baseArgs(markerHome), "--title", "dsh-injection"]);
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    const content = readOutput(result.stdout);
    assert.match(content, /合计：匹配 0 个会话，显示 0 个/u);
    assert.equal(content.includes("session-marker-title-01"), false);
  });
});

describe("输出策略", () => {
  it("writeOutputFile：原子创建、拒绝覆盖、无临时残留", () => {
    const dir = join(TEMP_ROOT, "writer");
    const first = writeOutputFile(dir, "sample.txt", "第一行\n第二行\n", false);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.value.lines, 2);
    const second = writeOutputFile(dir, "sample.txt", "覆盖尝试\n", false);
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.failure.classification, "输出文件已存在");
    assert.equal(second.failure.exitCode, 2);
    assert.equal(readFileSync(first.value.path, "utf8"), "第一行\n第二行\n");
    const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  it("writeOutputFile：overwrite=true 原子替换同名产物且无临时残留", () => {
    const dir = join(TEMP_ROOT, "writer-overwrite");
    const first = writeOutputFile(dir, "sample.txt", "第一版\n", true);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = writeOutputFile(dir, "sample.txt", "第二版\n", true);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.value.path, first.value.path);
    assert.equal(readFileSync(second.value.path, "utf8"), "第二版\n");
    const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  it("writeOutputFile：输出目录不存在时递归创建", () => {
    const nested = join(TEMP_ROOT, "writer-nested", "a", "b");
    const result = writeOutputFile(nested, "sample.txt", "内容\n", false);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(existsSync(result.value.path), true);
  });

  it("outputFailure：两条固定说明与退出码（不含任何路径）", () => {
    assert.deepEqual(outputFailure("write", true), {
      classification: "输出写入失败",
      exitCode: 3,
    });
    assert.deepEqual(outputFailure("write", false), {
      classification: "输出写入失败（临时文件未清理）",
      exitCode: 3,
    });
    assert.deepEqual(outputFailure("move", true), {
      classification: "输出移动失败",
      exitCode: 3,
    });
    assert.deepEqual(outputFailure("move", false), {
      classification: "输出移动失败（临时文件未清理）",
      exitCode: 3,
    });
  });

  it("removeTempFileIfExists：存在即删除、缺失按成功、目录删除失败", () => {
    const dir = join(TEMP_ROOT, "cleanup");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "temp.tmp");
    writeFileSync(file, "内容\n", "utf8");
    assert.equal(existsSync(file), true);
    assert.equal(removeTempFileIfExists(file), true);
    assert.equal(existsSync(file), false);
    // 不存在按成功处理（rmSync 的 force 语义），否则清理会把"本来就干净"当成失败。
    assert.equal(removeTempFileIfExists(join(dir, "missing.tmp")), true);
    // 目录不是临时文件：删除失败必须返回 false，且目录仍在。
    const sub = join(dir, "sub");
    mkdirSync(sub, { recursive: true });
    assert.equal(removeTempFileIfExists(sub), false);
    assert.equal(existsSync(sub), true);
  });

  it("移动失败路径：分类无多余后缀、退出 3、无临时残留", () => {
    const dir = join(TEMP_ROOT, "move-fail");
    // 目标路径是已有非空目录：同卷移动必然失败，临时文件能被正常清理。
    mkdirSync(join(dir, "target.md", "child"), { recursive: true });
    const result = writeOutputFile(dir, "target.md", "内容\n", true);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.failure, { classification: "输出移动失败", exitCode: 3 });
    const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  it("CLI：移动失败时 stderr 为固定分类、退出 3、不落产物", () => {
    const occupied = join(OUT_DIR, "occupied.md");
    mkdirSync(join(occupied, "child"), { recursive: true });
    const result = runCli(["list", ...baseArgs(HEALTHY_HOME), "--name", "occupied"]);
    assert.equal(result.status, 3, `stderr=${result.stderr}`);
    assert.equal(result.stderr, "错误: 输出移动失败\n");
    assert.equal(result.stdout, "");
    const leftovers = readdirSync(OUT_DIR).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  it("CLI 输出文件 UTF-8 无 BOM 且以换行结尾", () => {
    const result = runCli(["list", ...baseArgs(HEALTHY_HOME)]);
    const contract = readContract(result.stdout);
    const bytes = readFileSync(contract.path);
    assert.equal(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, false);
    assert.equal(bytes[bytes.length - 1], 0x0a);
  });

  it("测试自清理：writeFixtureHome 可覆写", () => {
    // 覆写同一夹具根不抛错（before 已执行过一次写入）
    writeFixtureHome(join(TEMP_ROOT, "rewrite-check"), healthySpec());
    assert.equal(existsSync(join(TEMP_ROOT, "rewrite-check", "sessions")), true);
  });
});
