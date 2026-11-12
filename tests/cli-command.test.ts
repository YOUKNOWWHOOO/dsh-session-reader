// CLI 集成测试（命令契约）：帮助与参数校验、list、show、show 对异常数据、默认参数组合。
// 与 cli-query-output.test.ts 的分工按职责划分：本文件只覆盖"命令如何解析与呈现会话"，
// 检索/统计/校验与输出落盘在另一个文件。共享夹具与运行器见 cli-helpers.ts。
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { countLines } from "../scripts/lib/paths.ts";
import {
  baseArgs as baseArgsOf,
  cliFixtures,
  initCliFixtures,
  PROJECT_OTHER,
  readContract,
  requireLibRoot,
  runCli,
} from "./cli-helpers.ts";
import { CURRENT_LOG_VERSION, resetTempDir } from "./fixtures.ts";

const fixtures = cliFixtures("command");
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

describe("CLI 帮助与参数校验", () => {
  it("总帮助与各命令帮助退出 0", () => {
    for (const args of [
      ["--help"],
      ["list", "--help"],
      ["show", "--help"],
      ["search", "--help"],
      ["stats", "--help"],
      ["check", "--help"],
    ]) {
      const result = runCli(args);
      assert.equal(result.status, 0, `help 失败: ${args.join(" ")}`);
      assert.match(result.stdout, /用法: & "<skill_dir>\\scripts\\session-reader\.ps1"/u);
      assert.match(result.stdout, /Electron-as-Node/u);
    }
  });

  it("未知命令/未知选项/缺位置参数/前缀过短 → 退出 2", () => {
    assert.equal(runCli(["nope", ...baseArgs(HEALTHY_HOME)]).status, 2);
    assert.equal(runCli(["list", ...baseArgs(HEALTHY_HOME), "--unknown"]).status, 2);
    assert.equal(runCli(["show", ...baseArgs(HEALTHY_HOME)]).status, 2);
    const short = runCli(["show", "abc", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(short.status, 2);
    assert.equal(short.stderr.includes("错误: 参数无效"), true);
  });

  it("缺少 --output-dir → 退出 2", () => {
    const result = runCli(["list", "--dsh-home", HEALTHY_HOME, "--lib-root", requireLibRoot()]);
    assert.equal(result.status, 2);
    assert.equal(result.stderr.includes("错误: 参数无效"), true);
  });

  it("呈现类开关与 json/jsonl 组合非法 → 退出 2", () => {
    assert.equal(
      runCli([
        "show",
        "session-fixture-main-01",
        ...baseArgs(HEALTHY_HOME),
        "--format",
        "json",
        "--thinking",
      ]).status,
      2,
    );
    assert.equal(
      runCli([
        "show",
        "session-fixture-main-01",
        ...baseArgs(HEALTHY_HOME),
        "--format",
        "jsonl",
        "--summary",
      ]).status,
      2,
    );
    assert.equal(runCli(["list", ...baseArgs(HEALTHY_HOME), "--format", "jsonl"]).status, 2);
    assert.equal(runCli(["list", ...baseArgs(HEALTHY_HOME), "--format", "text"]).status, 2);
    assert.equal(
      runCli(["show", "session-fixture-main-01", ...baseArgs(HEALTHY_HOME), "--format", "text"])
        .status,
      2,
    );
  });

  it("无效 lib-root → 退出 3（内部错误）", () => {
    const result = runCli([
      "list",
      "--dsh-home",
      HEALTHY_HOME,
      "--lib-root",
      join(TEMP_ROOT, "no-lib"),
      "--output-dir",
      OUT_DIR,
    ]);
    assert.equal(result.status, 3);
    assert.equal(result.stderr.includes("错误: 内部错误"), true);
  });

  it("dsh-home 不存在或 sessions 缺失 → 退出 1", () => {
    const missingHome = runCli([
      "list",
      "--dsh-home",
      join(TEMP_ROOT, "no-such-home"),
      "--lib-root",
      requireLibRoot(),
      "--output-dir",
      OUT_DIR,
    ]);
    assert.equal(missingHome.status, 1);
    assert.equal(missingHome.stderr.includes("错误: 目标不存在"), true);
    const emptyHome = join(TEMP_ROOT, "empty-home");
    mkdirSync(emptyHome, { recursive: true });
    const noSessions = runCli([
      "list",
      "--dsh-home",
      emptyHome,
      "--lib-root",
      requireLibRoot(),
      "--output-dir",
      OUT_DIR,
    ]);
    assert.equal(noSessions.status, 1);
  });

  it("未知目标 → 退出 1；歧义前缀 → 退出 1 并报候选数", () => {
    const unknown = runCli(["show", "zzzzzzzz", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(unknown.status, 1);
    assert.equal(unknown.stderr.includes("错误: 目标不存在"), true);
    const ambiguous = runCli(["show", "session-fixture", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /候选 4 个/u);
  });
});

describe("CLI list", () => {
  it("Markdown 输出：两行契约、行数一致、默认隐藏空会话", () => {
    const result = runCli(["list", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(result.status, 0);
    const contract = readContract(result.stdout);
    const content = readFileSync(contract.path, "utf8");
    assert.equal(countLines(content), contract.fileLines);
    assert.equal(content.startsWith("# 会话列表\n\n"), true);
    assert.equal(content.includes("| ID | 标题 | 工作区 | 最近活动 | 类型 | 大小 |"), true);
    // 显示值必须与可传值同源：产物中的 id 可直接交给 show（见下方"显示值即可传值"用例）。
    assert.equal(content.includes("`session-fixture-main-01`"), true);
    assert.equal(content.includes("夹具会话 A"), true);
    assert.equal(content.includes("user_projects"), true);
    assert.equal(content.includes("session-fixture-blank-05"), false);
    assert.match(content, /合计：匹配 4 个会话，显示 4 个/u);
    assert.match(content, /已隐藏空会话 1 个（--include-blank 显示）/u);
    // 覆盖声明描述"本次检查了哪些会话"（与 --limit 无关）：5 个可读会话全部纳入，无排除项。
    assert.match(content, /扫描会话 5 个；纳入 5 个；排除 0 个/u);
    assert.equal(contract.summary, "匹配会话 4 个，显示 4 个");
    const leftover = readdirSync(OUT_DIR).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftover, []);
  });

  it("显示值即可传值：list 产物中的 id 直接交给 show 成功", () => {
    const listResult = runCli(["list", ...baseArgs(HEALTHY_HOME), "--limit", "1"]);
    assert.equal(listResult.status, 0);
    const listContract = readContract(listResult.stdout);
    const listed = readFileSync(listContract.path, "utf8");
    const idMatch = /^\| `(session-[^`]+)` \|/mu.exec(listed);
    assert.notEqual(idMatch, null, "list 表格首列应为完整 id");
    if (idMatch === null) return;
    const shown = runCli(["show", idMatch[1], ...baseArgs(HEALTHY_HOME), "--summary"]);
    assert.equal(shown.status, 0, `显示值应可直接传值: ${idMatch[1]}`);
    const shownContract = readContract(shown.stdout);
    const shownContent = readFileSync(shownContract.path, "utf8");
    assert.equal(shownContent.includes(`- ID：\`${idMatch[1]}\``), true);
  });

  it("--full 显示 cwd；--include-blank 显示空会话", () => {
    const full = runCli(["list", ...baseArgs(HEALTHY_HOME), "--full", "--include-blank"]);
    assert.equal(full.status, 0);
    const contract = readContract(full.stdout);
    const content = readFileSync(contract.path, "utf8");
    assert.equal(content.includes("# 会话列表（完整）"), true);
    assert.equal(content.includes("- `session-fixture-main-01`："), true);
    assert.equal(content.includes("**工作区**：`user_projects`"), true);
    assert.equal(content.includes("**最近活动**："), true);
    assert.equal(content.includes("**轮次**："), false);
    assert.equal(content.includes("**大小**："), true);
    assert.equal(content.includes("**令牌**："), false);
    assert.equal(content.includes("**cwd**：`C:\\Users\\Alice\\user_projects`"), true);
    assert.equal(content.includes("session-fixture-blank-05"), true);
  });

  it("JSON 输出：字段与元数据可用性标记", () => {
    const result = runCli(["list", ...baseArgs(HEALTHY_HOME), "--format", "json"]);
    assert.equal(result.status, 0);
    const contract = readContract(result.stdout);
    const document = JSON.parse(readFileSync(contract.path, "utf8")) as {
      sessions: Array<Record<string, unknown>>;
    };
    assert.equal(document.sessions.length, 4);
    const main = document.sessions.find((session) => session.id === "session-fixture-main-01");
    assert.notEqual(main, undefined);
    assert.equal(main?.title, "夹具会话 A");
    assert.deepEqual(main?.metadata, { available: true, reasons: [] });
    assert.equal(Object.hasOwn(main ?? {}, "turns"), false);
    assert.equal(Object.hasOwn(main ?? {}, "tokens"), false);
  });

  it("工作区/类型/limit 过滤", () => {
    const workspace = runCli([
      "list",
      ...baseArgs(HEALTHY_HOME),
      "--format",
      "json",
      "--workspace",
      "user_projects",
    ]);
    assert.equal(workspace.status, 0);
    const workspaceDoc = JSON.parse(readFileSync(readContract(workspace.stdout).path, "utf8")) as {
      sessions: Array<Record<string, unknown>>;
    };
    assert.equal(workspaceDoc.sessions.length, 2);

    const subagent = runCli([
      "list",
      ...baseArgs(HEALTHY_HOME),
      "--format",
      "json",
      "--origin",
      "subagent",
    ]);
    const subagentDoc = JSON.parse(readFileSync(readContract(subagent.stdout).path, "utf8")) as {
      sessions: Array<Record<string, unknown>>;
    };
    assert.equal(subagentDoc.sessions.length, 1);
    assert.equal(subagentDoc.sessions[0].type, "subagent");

    const limited = runCli([
      "list",
      ...baseArgs(HEALTHY_HOME),
      "--format",
      "json",
      "--limit",
      "1",
      "--sort",
      "created",
    ]);
    const limitedDoc = JSON.parse(readFileSync(readContract(limited.stdout).path, "utf8")) as {
      sessions: Array<Record<string, unknown>>;
    };
    assert.equal(limitedDoc.sessions.length, 1);
    assert.equal(limitedDoc.sessions[0].id, "cafe1111-2222-3333-4444-555566667777");

    const badWorkspace = runCli(["list", ...baseArgs(HEALTHY_HOME), "--workspace", "no-such"]);
    assert.equal(badWorkspace.status, 1);
  });
});

describe("CLI show", () => {
  it("按唯一前缀读取主会话（Markdown 围栏承载正文）", () => {
    const result = runCli(["show", "fixture-main-01", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(result.status, 0);
    const contract = readContract(result.stdout);
    const content = readFileSync(contract.path, "utf8");
    assert.equal(countLines(content), contract.fileLines);
    assert.equal(content.startsWith("# 会话记录\n\n"), true);
    assert.equal(content.includes("- ID：`session-fixture-main-01`"), true);
    assert.equal(content.includes("- 标题：`夹具会话 A`"), true);
    assert.equal(content.includes("- 包含工具调用：是"), true);
    assert.equal(content.includes("```text\nhello ALPHA world\n```"), true);
    assert.equal(content.includes("```text\nreply BETA text\n```"), true);
    assert.equal(content.includes("**推理**"), false);
    assert.equal(content.includes("**工具调用**"), false);
    assert.match(content, /摘要：/u);
  });

  it("--summary 输出轮次大纲", () => {
    const result = runCli(["show", "fixture-main-01", ...baseArgs(HEALTHY_HOME), "--summary"]);
    assert.equal(result.status, 0);
    const content = readFileSync(readContract(result.stdout).path, "utf8");
    assert.equal(content.includes("## 轮次大纲"), true);
    assert.equal(content.includes("T1（seq 0）"), true);
    assert.equal(content.includes("```text"), false);
  });

  it("--thinking --tools --events --truncate/--headers 生效", () => {
    const result = runCli([
      "show",
      "fixture-main-01",
      ...baseArgs(HEALTHY_HOME),
      "--thinking",
      "--tools",
      "--events",
      "--headers",
      "--truncate",
      "100",
    ]);
    assert.equal(result.status, 0);
    const content = readFileSync(readContract(result.stdout).path, "utf8");
    assert.equal(content.includes("```text\nthink GAMMA\n```"), true);
    assert.match(content, /\*\*工具调用\*\*（`read`）（seq 4；[0-9T:+-]+）：/u);
    assert.equal(content.includes("```text\nfile alpha content\n```"), true);
    // 用户本人的消息不带来源标注（`来源 未标注` 是缺 source 的容错标注，该形态在
    // tests\source-annotation.test.ts 的 `--events` 用例中覆盖）。
    assert.match(content, /\*\*用户\*\*（seq 2；[0-9T:+-]+）：/u);
    assert.match(content, /\*\*事件\*\*（seq \d+；[0-9T:+-]+）：`turn\/start`/u);
  });

  it("--role 过滤对话消息", () => {
    const result = runCli(["show", "fixture-main-01", ...baseArgs(HEALTHY_HOME), "--role", "user"]);
    assert.equal(result.status, 0);
    const content = readFileSync(readContract(result.stdout).path, "utf8");
    assert.equal(content.includes("```text\nhello ALPHA world\n```"), true);
    assert.equal(content.includes("```text\nreply BETA text\n```"), false);
  });

  it("jsonl：首行 header、其后每行事件", () => {
    const result = runCli([
      "show",
      "session-fixture-main-01",
      ...baseArgs(HEALTHY_HOME),
      "--format",
      "jsonl",
    ]);
    assert.equal(result.status, 0);
    const contract = readContract(result.stdout);
    const lines = readFileSync(contract.path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    assert.equal(lines.length, 1 + 19);
    const header = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(header.id, "session-fixture-main-01");
    assert.equal(header.version, CURRENT_LOG_VERSION);
    const firstEvent = JSON.parse(lines[1]) as Record<string, unknown>;
    assert.equal(firstEvent.seq, 0);
  });

  it("--subagents --format json：父子嵌套结构", () => {
    const result = runCli([
      "show",
      "fixture-main-01",
      ...baseArgs(HEALTHY_HOME),
      "--subagents",
      "--format",
      "json",
    ]);
    assert.equal(result.status, 0);
    const document = JSON.parse(readFileSync(readContract(result.stdout).path, "utf8")) as {
      session: Record<string, unknown>;
      turns: unknown[];
      messages: unknown[];
      subagents: Array<{ session: Record<string, unknown> }>;
    };
    assert.equal(document.session.id, "session-fixture-main-01");
    assert.equal(document.turns.length, 2);
    assert.equal(document.subagents.length, 1);
    assert.equal(document.subagents[0].session.id, "cafe1111-2222-3333-4444-555566667777");
  });

  it("裸 uuid 前缀读取子代理会话；last 解析最近活动主会话", () => {
    const subagent = runCli(["show", "cafe1111", ...baseArgs(HEALTHY_HOME), "--format", "json"]);
    assert.equal(subagent.status, 0);
    const subagentDoc = JSON.parse(readFileSync(readContract(subagent.stdout).path, "utf8")) as {
      session: Record<string, unknown>;
    };
    assert.equal(subagentDoc.session.id, "cafe1111-2222-3333-4444-555566667777");
    const last = runCli(["show", "last", ...baseArgs(HEALTHY_HOME), "--format", "json"]);
    assert.equal(last.status, 0);
    const lastDoc = JSON.parse(readFileSync(readContract(last.stdout).path, "utf8")) as {
      session: Record<string, unknown>;
    };
    assert.equal(lastDoc.session.id, "session-fixture-main-01");
  });

  it("--probe：只落规模摘要，预计字节数与完整导出一致", () => {
    const probed = runCli([
      "show",
      "session-fixture-main-01",
      ...baseArgs(HEALTHY_HOME),
      "--probe",
    ]);
    assert.equal(probed.status, 0);
    const probedContract = readContract(probed.stdout);
    const probedContent = readFileSync(probedContract.path, "utf8");
    assert.equal(probedContent.includes("## 时间线"), false);
    assert.equal(probedContent.includes("用户内容"), false);
    const estimate = Number(/- 预计字节数：(\d+)（/u.exec(probedContent)?.[1] ?? "-1");
    assert.equal(estimate > 0, true);
    assert.match(probedContract.summary, /（规模探测）；事件 \d+ 个；预计正文 \d+ 字节$/u);
    assert.equal(probedContent.includes(`- 预计字节数：${estimate}（`), true);

    // 同一目标、同一选项做完整导出：其正文字节数必须等于探测给出的预计字节数。
    const full = runCli(["show", "session-fixture-main-01", ...baseArgs(HEALTHY_HOME)]);
    assert.equal(full.status, 0);
    const fullPath = readContract(full.stdout).path;
    assert.equal(readFileSync(fullPath).length, estimate);
  });

  it("--probe 与 --subagents 同用即拒绝（退出 2，附替代写法）", () => {
    const result = runCli([
      "show",
      "session-fixture-main-01",
      ...baseArgs(HEALTHY_HOME),
      "--probe",
      "--subagents",
    ]);
    assert.equal(result.status, 2);
    assert.equal(
      result.stderr,
      "错误: 参数无效（--probe 只给规模摘要，与 --subagents 不能同时使用；去掉 --subagents，或去掉 --probe）\n",
    );
    assert.equal(result.stdout, "");
  });

  it("--probe 可与呈现类开关同用：预计字节数随开关变化并等于同选项的完整导出", () => {
    const probed = runCli([
      "show",
      "session-fixture-main-01",
      ...baseArgs(HEALTHY_HOME),
      "--probe",
      "--tools",
      "--events",
      "--truncate",
      "20",
    ]);
    assert.equal(probed.status, 0);
    const probedContent = readFileSync(readContract(probed.stdout).path, "utf8");
    assert.equal(probedContent.includes("## 时间线"), false);
    const estimate = Number(/- 预计字节数：(\d+)（/u.exec(probedContent)?.[1] ?? "-1");
    assert.equal(estimate > 0, true);

    const full = runCli([
      "show",
      "session-fixture-main-01",
      ...baseArgs(HEALTHY_HOME),
      "--tools",
      "--events",
      "--truncate",
      "20",
    ]);
    assert.equal(full.status, 0);
    assert.equal(readFileSync(readContract(full.stdout).path).length, estimate);
  });
});

describe("CLI show 对异常数据", () => {
  it("撕裂尾：完整帧成功解码并显式标注异常", () => {
    const result = runCli(["show", "session-broken-torn-06", ...baseArgs(BROKEN_HOME)]);
    assert.equal(result.status, 0);
    const content = readFileSync(readContract(result.stdout).path, "utf8");
    assert.equal(content.includes("- 异常："), true);
    assert.equal(content.includes("尾部未完整帧已丢弃"), true);
  });

  it("show --subagents：header 不可读的会话以归属未知声明，不静默消失", () => {
    const result = runCli([
      "show",
      "session-broken-torn-06",
      ...baseArgs(BROKEN_HOME),
      "--subagents",
    ]);
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    const content = readFileSync(readContract(result.stdout).path, "utf8");
    // 归属未知项不计入 N/M/K：作用域内的节点只有目标自身。
    assert.equal(content.includes("扫描会话 1 个；纳入 1 个；排除 0 个"), true);
    assert.match(content, /归属未知：`session-broken-corrupt-08`（`[^`]+`）/u);
  });

  it("seq 缺口：show 保留逻辑读取，check 报告物理 seq 异常", () => {
    const showResult = runCli(["show", "session-broken-gap-07", ...baseArgs(BROKEN_HOME)]);
    assert.equal(showResult.status, 0, `stderr=${showResult.stderr}`);
    const checkResult = runCli(["check", "session-broken-gap-07", ...baseArgs(BROKEN_HOME)]);
    assert.equal(checkResult.status, 3, `stderr=${checkResult.stderr}`);
    const content = readFileSync(readContract(checkResult.stdout).path, "utf8");
    assert.match(content, /seq 不连续/u);
  });

  it("结构损坏会话：list 容错跳过并逐条声明排除（退出 0）", () => {
    const result = runCli(["list", ...baseArgs(BROKEN_HOME)]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const contract = readContract(result.stdout);
    const content = readFileSync(contract.path, "utf8");
    // 容错语义：单个 header 不可读的会话不再阻断对其余会话的浏览，但必须显式声明排除了谁、为什么。
    assert.match(content, /扫描会话 3 个；纳入 2 个；排除 1 个/u);
    assert.match(content, /排除会话：`session-broken-corrupt-08`（`帧魔数无效（偏移 0）`）/u);
  });

  it("旧版本 header：show 退出 3 且分类为数据不可读，check 记为异常而不崩溃", () => {
    // 技能只支持当前格式：更早的日志由官方库分类为 migration-required，必须显式失败，
    // 不得走迁移分支，也不得被当成"不存在"。
    const oldHome = join(TEMP_ROOT, "old-version-dsh");
    resetTempDir(oldHome);
    const oldId = "session-old-version-01";
    const dir = join(oldHome, "sessions", PROJECT_OTHER, oldId);
    mkdirSync(dir, { recursive: true });
    const header = JSON.stringify({
      type: "session",
      version: CURRENT_LOG_VERSION - 1,
      id: oldId,
      createdAt: 1000,
      isSeeded: false,
      delegationDepth: 0,
    });
    writeFileSync(
      join(dir, `session.v${CURRENT_LOG_VERSION - 1}.jsonl`),
      `${header}\n${JSON.stringify({ type: "turn/start", seq: 0, time: 10, data: { turn: 1 } })}\n`,
      "utf8",
    );

    const shown = runCli(["show", oldId, ...baseArgs(oldHome)]);
    assert.equal(shown.status, 3, `stderr=${shown.stderr}`);
    assert.equal(shown.stderr, "错误: 数据不可读\n");
    assert.equal(shown.stdout, "");
    // 目标存在但读不到，必须与"确实不存在"区分开。
    assert.equal(runCli(["show", "session-absent-99", ...baseArgs(oldHome)]).status, 1);

    const checked = runCli(["check", ...baseArgs(oldHome), "--format", "json"]);
    assert.equal(checked.status, 3, `stderr=${checked.stderr}`);
    const document = JSON.parse(readFileSync(readContract(checked.stdout).path, "utf8")) as {
      sessions: Array<Record<string, unknown>>;
    };
    const entry = document.sessions.find((session) => session.id === oldId);
    assert.equal(entry?.formatVersion, CURRENT_LOG_VERSION - 1);
    assert.equal(entry?.classification, "migration-required");
    const anomalies = (entry?.anomalies ?? []) as string[];
    assert.equal(
      anomalies.some((value) => value.includes("header 分类: migration-required")),
      true,
    );

    const listed = runCli(["list", ...baseArgs(oldHome)]);
    assert.equal(listed.status, 0, `stderr=${listed.stderr}`);
    const listedContent = readFileSync(readContract(listed.stdout).path, "utf8");
    assert.match(listedContent, /扫描会话 1 个；纳入 0 个；排除 1 个/u);
    assert.match(
      listedContent,
      /排除会话：`session-old-version-01`（`header 分类 migration-required`）/u,
    );
  });

  it("header 不可读但目录存在：按前缀取目标报数据不可读（退出 3），与真不存在可区分", () => {
    // 三态可区分性的独立验证：同一命令、同一前缀形态，存在的损坏会话与不存在的标识必须给出不同分类。
    const unreadable = runCli(["show", "session-broken-corrupt-08", ...baseArgs(BROKEN_HOME)]);
    assert.equal(unreadable.status, 3, `stderr=${unreadable.stderr}`);
    assert.equal(unreadable.stderr, "错误: 数据不可读\n");
    assert.equal(unreadable.stdout, "");

    const missing = runCli(["show", "session-broken-nope-99", ...baseArgs(BROKEN_HOME)]);
    assert.equal(missing.status, 1, `stderr=${missing.stderr}`);
    assert.equal(missing.stderr, "错误: 目标不存在\n");
    assert.equal(missing.stdout, "");
  });
});

describe("默认参数组合（默认调用）", () => {
  it("list：仅命令 + --output-dir（DSH_HOME 提供主目录）", () => {
    const result = runCli(["list", "--output-dir", OUT_DIR], { DSH_HOME: HEALTHY_HOME });
    assert.equal(result.status, 0);
    const contract = readContract(result.stdout);
    const content = readFileSync(contract.path, "utf8");
    assert.equal(countLines(content), contract.fileLines);
    assert.match(contract.path, /\.md$/u);
    assert.equal(content.startsWith("# 会话列表\n\n"), true);
    assert.equal(content.includes("夹具会话 A"), true);
    assert.equal(content.includes("session-fixture-blank-05"), false);
    assert.match(content, /合计：匹配 4 个会话，显示 4 个/u);
  });

  it("show：仅目标 + --output-dir（默认可见性/格式/不截断/尾部摘要提示）", () => {
    const result = runCli(["show", "fixture-main-01", "--output-dir", OUT_DIR], {
      DSH_HOME: HEALTHY_HOME,
    });
    assert.equal(result.status, 0);
    const contract = readContract(result.stdout);
    assert.match(contract.path, /\.md$/u);
    assert.equal(contract.summary.includes("事件 19 个"), true);
    const content = readFileSync(contract.path, "utf8");
    assert.equal(content.includes("```text\nhello ALPHA world\n```"), true);
    assert.equal(content.includes("```text\nreply BETA text\n```"), true);
    assert.equal(content.includes("**推理**"), false);
    assert.equal(content.includes("**工具调用**"), false);
    assert.match(content, /摘要：已隐藏 1 条推理内容（--thinking 显示）/u);
    assert.match(content, /已隐藏 2 条工具调用\/结果（--tools 显示）/u);
    assert.match(content, /已隐藏 \d+ 条生命周期事件（--events 显示）/u);
  });

  it("search 与 stats：默认锚点同样可用（不传 --lib-root）", () => {
    const searched = runCli(["search", "hello", "--output-dir", OUT_DIR], {
      DSH_HOME: HEALTHY_HOME,
    });
    assert.equal(searched.status, 0, searched.stderr);
    assert.equal(readContract(searched.stdout).path.endsWith(".md"), true);
    const stats = runCli(["stats", "--output-dir", OUT_DIR], { DSH_HOME: HEALTHY_HOME });
    assert.equal(stats.status, 0, stats.stderr);
    assert.equal(readContract(stats.stdout).path.endsWith(".md"), true);
  });
});
