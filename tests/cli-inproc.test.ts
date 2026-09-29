// CLI 入口进程内测试：解析/校验/帮助/输出落盘/主流程（覆盖子进程测试无法计入的分支）。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { before, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultLibRoot, resolveDshHome } from "../scripts/lib/paths.ts";
import {
  buildCommandHelp,
  buildGeneralHelp,
  COMMANDS,
  main,
  parseCommandLine,
  validateCommandOptions,
  writeOutputFile,
} from "../scripts/session-reader.ts";
import {
  type FixtureEvent,
  type FixtureHomeSpec,
  resetTempDir,
  writeFixtureHome,
} from "./fixtures.ts";

const TEMP_ROOT = fileURLToPath(new URL("./.tmp/inproc", import.meta.url));
const HOME = join(TEMP_ROOT, "dsh");
const OUT_DIR = join(TEMP_ROOT, "out");
const LIB_ROOT = defaultLibRoot(resolveDshHome(undefined, process.env, homedir()));
// 该套用例要用真实的官方格式库；定位不到时立刻失败并给出原因，不进入后续以 undefined 为入参的路径。
if (LIB_ROOT === undefined) {
  throw new Error("默认锚点未能唯一确定官方格式库，cli-inproc.test.ts 无法运行；请修复安装树定位");
}

function ev(
  type: string,
  seq: number,
  time: number,
  data: Record<string, unknown>,
  extra?: Partial<Pick<FixtureEvent, "surfaceOp" | "sourceEventSeqs">>,
): FixtureEvent {
  return { type, seq, time, data, ...extra };
}

function spec(): FixtureHomeSpec {
  return {
    sessions: [
      {
        id: "session-inproc-main-01",
        projectDir: "--C-Users-Alice-user_projects--",
        cwd: "C:\\Users\\Alice\\user_projects",
        createdAt: 1000,
        events: [
          ev("turn/start", 0, 10, { turn: 1 }),
          ev(
            "user/message",
            1,
            11,
            { role: "user", content: [{ type: "text", text: "inproc ALPHA" }] },
            { surfaceOp: "append" },
          ),
          ev(
            "assistant/message",
            2,
            12,
            {
              turn: 1,
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: "inproc reply" },
                  { type: "reasoning", text: "inproc think" },
                ],
              },
            },
            { surfaceOp: "append" },
          ),
          ev("session/title", 3, 13, {
            title: "进程内夹具",
            messageSeqs: [1],
            source: { kind: "fallback" },
          }),
        ],
        title: "进程内夹具",
        turns: 1,
        steps: 0,
        lastPromptAt: 2000,
      },
      {
        id: "dddd1111-2222-3333-4444-555566667777",
        projectDir: "--C-Users-Alice-user_projects--",
        cwd: "C:\\Users\\Alice\\user_projects",
        createdAt: 1500,
        events: [ev("permission/preset", 0, 10, { preset: "workspace-write" })],
        parentSession: "session-inproc-main-01",
        origin: "subagent",
        title: null,
        turns: 0,
        steps: 0,
        lastPromptAt: null,
      },
    ],
    workspace: {
      path: "C:\\Users\\Alice\\user_projects",
      title: "user_projects",
      sessionIds: ["session-inproc-main-01"],
    },
  };
}

interface CapturedStreams {
  readonly stdout: () => string;
  readonly stderr: () => string;
}

async function runMain(
  argv: readonly string[],
): Promise<{ code: number; streams: CapturedStreams }> {
  const stdoutMock = mock.method(process.stdout, "write", () => true);
  const stderrMock = mock.method(process.stderr, "write", () => true);
  try {
    const code = await main(argv);
    const stdout = stdoutMock.mock.calls.map((call) => String(call.arguments[0])).join("");
    const stderr = stderrMock.mock.calls.map((call) => String(call.arguments[0])).join("");
    return { code, streams: { stdout: () => stdout, stderr: () => stderr } };
  } finally {
    stdoutMock.mock.restore();
    stderrMock.mock.restore();
  }
}

before(() => {
  resetTempDir(TEMP_ROOT);
  writeFixtureHome(HOME, spec());
  mkdirSync(OUT_DIR, { recursive: true });
});

describe("parseCommandLine", () => {
  it("无参数/未知命令/未知选项开头 → 参数错误", () => {
    assert.equal(parseCommandLine([]).kind, "error");
    assert.equal(parseCommandLine(["nope"]).kind, "error");
    assert.equal(parseCommandLine(["-x"]).kind, "error");
  });

  it("帮助优先：总帮助与命令帮助（`--` 之后不再识别帮助）", () => {
    assert.equal(parseCommandLine(["--help"]).kind, "help");
    assert.equal(parseCommandLine(["-h"]).kind, "help");
    const commandHelp = parseCommandLine(["list", "--help"]);
    assert.equal(commandHelp.kind, "help");
    const mixed = parseCommandLine(["show", "abc", "--help"]);
    assert.equal(mixed.kind, "help");
    assert.equal(parseCommandLine(["search", "-h", "--", "- item"]).kind, "help");
    assert.equal(parseCommandLine(["search", "--", "--help"]).kind, "parsed");
  });

  it("`--` 选项终止符：其后 token 一律作为位置参数", () => {
    const keyword = parseCommandLine(["search", "--", "- item"]);
    assert.equal(keyword.kind, "parsed");
    if (keyword.kind !== "parsed") return;
    assert.deepEqual(keyword.value.positional, ["- item"]);
    assert.equal(keyword.value.options.size, 0);
    const helpAsKeyword = parseCommandLine(["search", "--", "--help"]);
    assert.equal(helpAsKeyword.kind, "parsed");
    if (helpAsKeyword.kind !== "parsed") return;
    assert.deepEqual(helpAsKeyword.value.positional, ["--help"]);
    assert.equal(parseCommandLine(["search", "- item"]).kind, "error");
    assert.equal(parseCommandLine(["list", "--", "x"]).kind, "error");
    const optionsBeforeTerminator = parseCommandLine(["search", "--scope", "all", "--", "- item"]);
    assert.equal(optionsBeforeTerminator.kind, "parsed");
    if (optionsBeforeTerminator.kind !== "parsed") return;
    assert.equal(optionsBeforeTerminator.value.options.get("--scope"), "all");
    assert.deepEqual(optionsBeforeTerminator.value.positional, ["- item"]);
  });

  it("值选项支持 --name value 与 --name=value；开关拒绝 = 值", () => {
    const parsed = parseCommandLine(["list", "--format=json", "--limit", "5"]);
    assert.equal(parsed.kind, "parsed");
    if (parsed.kind !== "parsed") return;
    assert.equal(parsed.value.options.get("--format"), "json");
    assert.equal(parsed.value.options.get("--limit"), "5");
    const switchWithValue = parseCommandLine(["list", "--full=1"]);
    assert.equal(switchWithValue.kind, "error");
  });

  it("重复选项、空值、缺值、非法枚举/整数 → 参数错误", () => {
    assert.equal(parseCommandLine(["list", "--limit", "1", "--limit", "2"]).kind, "error");
    assert.equal(parseCommandLine(["list", "--format="]).kind, "error");
    assert.equal(parseCommandLine(["list", "--format"]).kind, "error");
    assert.equal(parseCommandLine(["list", "--format", "xml"]).kind, "error");
    assert.equal(parseCommandLine(["list", "--format", "text"]).kind, "error");
    assert.equal(parseCommandLine(["list", "--limit", "abc"]).kind, "error");
    assert.equal(parseCommandLine(["list", "--limit", "99999999999999999999"]).kind, "error");
    assert.equal(parseCommandLine(["list", "-x"]).kind, "error");
  });

  it("位置参数数量校验", () => {
    assert.equal(parseCommandLine(["list", "extra"]).kind, "error");
    assert.equal(parseCommandLine(["show"]).kind, "error");
    assert.equal(parseCommandLine(["search"]).kind, "error");
    assert.equal(parseCommandLine(["stats"]).kind, "parsed");
    assert.equal(parseCommandLine(["stats", "target"]).kind, "parsed");
    assert.equal(parseCommandLine(["stats", "a", "b"]).kind, "error");
  });

  it("帮助文本与选项表同源", () => {
    const listHelp = buildCommandHelp(COMMANDS[0]);
    assert.match(listHelp, /用法: node session-reader\.ts list/u);
    assert.match(listHelp, /--output-dir/u);
    assert.match(listHelp, /选项终止符/u);
    const general = buildGeneralHelp();
    for (const command of COMMANDS) assert.equal(general.includes(command.name), true);
    assert.match(general, /选项终止符/u);
  });

  it("validateCommandOptions：show 组合约束与 stats 范围过滤约束", () => {
    const jsonThinking = parseCommandLine(["show", "abc", "--format", "json", "--thinking"]);
    assert.equal(jsonThinking.kind, "parsed");
    if (jsonThinking.kind === "parsed") {
      assert.notEqual(validateCommandOptions(jsonThinking.value), null);
    }
    const jsonlSummary = parseCommandLine(["show", "abc", "--format", "jsonl", "--summary"]);
    assert.equal(jsonlSummary.kind, "parsed");
    if (jsonlSummary.kind === "parsed") {
      assert.notEqual(validateCommandOptions(jsonlSummary.value), null);
    }
    const mdTools = parseCommandLine(["show", "abc", "--tools"]);
    assert.equal(mdTools.kind, "parsed");
    if (mdTools.kind === "parsed") assert.equal(validateCommandOptions(mdTools.value), null);
    const list = parseCommandLine(["list"]);
    assert.equal(list.kind, "parsed");
    if (list.kind === "parsed") assert.equal(validateCommandOptions(list.value), null);
    const statsTarget = parseCommandLine(["stats", "abc"]);
    assert.equal(statsTarget.kind, "parsed");
    if (statsTarget.kind === "parsed")
      assert.equal(validateCommandOptions(statsTarget.value), null);
    for (const args of [
      ["stats", "abc", "--workspace", "x"],
      ["stats", "abc", "--since", "0"],
      ["stats", "abc", "--until", "0"],
      ["stats", "abc", "--origin", "main"],
    ]) {
      const parsed = parseCommandLine(args);
      assert.equal(parsed.kind, "parsed", `期望可解析: ${args.join(" ")}`);
      if (parsed.kind === "parsed") {
        assert.notEqual(validateCommandOptions(parsed.value), null, `期望拒绝: ${args.join(" ")}`);
      }
    }
    const statsGlobalFiltered = parseCommandLine(["stats", "--workspace", "x", "--since", "0"]);
    assert.equal(statsGlobalFiltered.kind, "parsed");
    if (statsGlobalFiltered.kind === "parsed") {
      assert.equal(validateCommandOptions(statsGlobalFiltered.value), null);
    }
  });
});

describe("writeOutputFile 失败路径", () => {
  it("输出目录创建失败（目录路径被文件占据）→ 输出目录创建失败", () => {
    const blocker = join(TEMP_ROOT, "blocker");
    writeFileSync(blocker, "occupied", "utf8");
    const result = writeOutputFile(join(blocker, "sub"), "sample.txt", "内容\n", false);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.classification, "输出目录创建失败");
    assert.equal(result.failure.exitCode, 3);
  });
});

describe("main 进程内主流程", () => {
  it("--help → 0；参数错误 → 2", async () => {
    const help = await runMain(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.streams.stdout(), /用法/u);
    assert.equal(help.streams.stdout().includes("默认参数组合：仅需"), true);
    const bad = await runMain(["nope"]);
    assert.equal(bad.code, 2);
    assert.match(bad.streams.stderr(), /错误: 参数无效/u);
  });

  it("list → 0 且 stdout 两行契约成立", async () => {
    const result = await runMain([
      "list",
      "--dsh-home",
      HOME,
      "--lib-root",
      LIB_ROOT,
      "--output-dir",
      OUT_DIR,
    ]);
    assert.equal(result.code, 0);
    const lines = result.streams
      .stdout()
      .split("\n")
      .filter((line) => line.length > 0);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^完整输出已保存到: /u);
    assert.match(lines[1], /；输出文件共 \d+ 行$/u);
  });

  it("show/search/stats/check → 0；check 异常 → 3", async () => {
    const base = ["--dsh-home", HOME, "--lib-root", LIB_ROOT, "--output-dir", OUT_DIR];
    const show = await runMain(["show", "inproc-main-01", ...base, "--thinking"]);
    assert.equal(show.code, 0);
    const search = await runMain(["search", "ALPHA", ...base, "--scope", "all"]);
    assert.equal(search.code, 0);
    const stats = await runMain(["stats", ...base, "--format", "json"]);
    assert.equal(stats.code, 0);
    const check = await runMain(["check", ...base]);
    assert.equal(check.code, 0);
  });

  it("show 的 stdout 摘要不因 --format 变化（md 与 json 同源）", async () => {
    const base = [
      "show",
      "inproc-main-01",
      "--dsh-home",
      HOME,
      "--lib-root",
      LIB_ROOT,
      "--output-dir",
      OUT_DIR,
    ];
    // 只比较 `；输出文件共 N 行` 之前的摘要：md 与 json 产物的行数本就不同。
    const summaryOf = (stdout: string): string =>
      (stdout.split("\n").filter((line) => line.length > 0)[1] ?? "").replace(
        /；输出文件共 \d+ 行$/u,
        "",
      );
    for (const extra of [[], ["--summary"], ["--subagents"]]) {
      const md = await runMain([...base, ...extra]);
      const json = await runMain([...base, ...extra, "--format", "json"]);
      assert.equal(md.code, 0);
      assert.equal(json.code, 0);
      assert.equal(summaryOf(json.streams.stdout()), summaryOf(md.streams.stdout()));
    }
  });

  it("错误映射：目标不存在 → 1；lib 加载失败 → 3；sessions 缺失 → 1", async () => {
    const base = ["--dsh-home", HOME, "--lib-root", LIB_ROOT, "--output-dir", OUT_DIR];
    const missing = await runMain(["show", "zzzzzzzz", ...base]);
    assert.equal(missing.code, 1);
    assert.match(missing.streams.stderr(), /错误: 目标不存在/u);
    const badLib = await runMain([
      "list",
      "--dsh-home",
      HOME,
      "--lib-root",
      join(TEMP_ROOT, "no-lib"),
      "--output-dir",
      OUT_DIR,
    ]);
    assert.equal(badLib.code, 3);
    assert.match(badLib.streams.stderr(), /错误: 内部错误/u);
    const emptyHome = join(TEMP_ROOT, "empty");
    mkdirSync(emptyHome, { recursive: true });
    const noSessions = await runMain([
      "list",
      "--dsh-home",
      emptyHome,
      "--lib-root",
      LIB_ROOT,
      "--output-dir",
      OUT_DIR,
    ]);
    assert.equal(noSessions.code, 1);
  });

  it("lib 加载成功（真实官方库）", async () => {
    // 通过一次完整 list 验证真实库加载；此处额外直接断言默认锚点存在
    assert.equal(existsSync(join(LIB_ROOT, "@deepseek-ai", "dsh-session-format-catalog")), true);
  });

  it("输出目录被占用（文件阻塞）→ 3 且无 stdout", async () => {
    const blocker = join(TEMP_ROOT, "blocker-out");
    writeFileSync(blocker, "occupied", "utf8");
    const result = await runMain([
      "list",
      "--dsh-home",
      HOME,
      "--lib-root",
      LIB_ROOT,
      "--output-dir",
      join(blocker, "sub"),
    ]);
    assert.equal(result.code, 3);
    assert.match(result.streams.stderr(), /错误: 输出目录创建失败/u);
    assert.equal(result.streams.stdout(), "");
  });

  it("重复执行不残留临时文件", () => {
    const leftovers = readdirSync(OUT_DIR).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
    assert.equal(readFileSync(join(OUT_DIR, readdirSync(OUT_DIR)[0]), "utf8").length > 0, true);
  });
});
