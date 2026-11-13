// 端到端测试：通过 Node 入口启动桌面运行时并转发参数。
// 覆盖三类契约：参数逐字保真（含 `&`、`%` 与 `--` 终止符）、退出码与 stderr 透传、桌面版安装定位的三条
// 失败形态（零候选、多候选、缺同名可执行文件）。
// 全部用例经 Node 运行真实入口脚本，不复制入口逻辑，也不 mock 子进程。
// 环境隔离：CLI 夹具沿用 cli-helpers 的 `launcher` 作用域；定位用例各用一份独立的
// `tests/.tmp/launcher-*` 外套 LOCALAPPDATA，互不影响。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cliFixtures, ev, initCliFixtures } from "./cli-helpers.ts";
import { resetTempDir, writeFixtureHome } from "./fixtures.ts";

const LAUNCHER = fileURLToPath(new URL("../scripts/run-session-reader.ts", import.meta.url));

/** 帮助文本里的入口行：入口脚本相对技能目录，调用方据此拼自己的绝对路径。 */
const ENTRY_LINE = '用法: node "<skill_dir>/scripts/run-session-reader.ts"';

const fixtures = cliFixtures("launcher");
const TEMP_ROOT = fixtures.tempRoot;
const HEALTHY_HOME = fixtures.healthyHome;
const OUT_DIR = fixtures.outDir;
/** 定位用例的夹具根：与 CLI 夹具平级，都落在 `tests/.tmp` 下，名字统一以 `launcher-` 开头。 */
const LAUNCHER_TMP = fileURLToPath(new URL("./.tmp/", import.meta.url));
const SEARCH_HOME = join(TEMP_ROOT, "special-search-dsh");
const SEARCH_TEXT = "- 参数&百分%100";

/** 子进程结果：stdout/stderr 已按 UTF-8 解码。 */
interface LauncherResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 运行真实入口脚本。
 *
 * 参数一律经数组传递，不经字符串拼接，因此用例里给出的
 * `&`、`%`、`--` 与 `- item` 与调用方手工输入时完全相同。
 *
 * @param args 转发给 CLI 的参数。
 * @param env 额外环境（定位用例用它替换 LOCALAPPDATA）。
 */
function runLauncher(args: readonly string[], env?: NodeJS.ProcessEnv): LauncherResult {
  const result = spawnSync("node", [LAUNCHER, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
  // 启动失败（Node 不在 PATH 等）会让 status 为 null 且 stderr 为空，与"脚本自身以非零退出"混淆；
  // 显式报出底层原因，避免用例看起来只是断言失败。
  if (result.error !== undefined) {
    throw new Error(`无法启动 Node 运行入口脚本: ${result.error.message}`);
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** 解析 stdout 两行契约并返回产物路径，同时断言行数与首行形态。 */
function parseOutputPath(stdout: string): string {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 2, `stdout 必须固定两行: ${JSON.stringify(stdout)}`);
  const match = /^完整输出已保存到: (.+)$/u.exec(lines[0]);
  assert.notEqual(match, null, `第一行不符合契约: ${lines[0]}`);
  if (match === null) throw new Error("unreachable");
  return match[1];
}

/** 建一个只含 `Programs` 的假 LOCALAPPDATA（用于零候选用例）。 */
function emptyLocalAppData(): string {
  const root = resetTempDir(join(LAUNCHER_TMP, "launcher-localappdata-empty"));
  mkdirSync(join(root, "Programs"), { recursive: true });
  return root;
}

/**
 * 建一个含指定安装目录的假 LOCALAPPDATA。
 *
 * @param name 夹具名（决定目录名，用例间互不覆盖）。
 * @param installs 安装目录名与"是否同时放同名 exe"。
 */
function localAppDataWithInstalls(
  name: string,
  installs: readonly { readonly dir: string; readonly exe: boolean }[],
): string {
  const root = resetTempDir(join(LAUNCHER_TMP, `launcher-localappdata-${name}`));
  const programs = join(root, "Programs");
  mkdirSync(programs, { recursive: true });
  for (const install of installs) {
    const installRoot = join(programs, install.dir);
    mkdirSync(join(installRoot, "resources", "runtime", "bin"), { recursive: true });
    // 定位判据只看该文件是否存在，内容不参与判定；写空内容即可，且不放进可执行语义。
    writeFileSync(join(installRoot, "resources", "runtime", "bin", "node.cmd"), "", "utf8");
    if (install.exe) writeFileSync(join(installRoot, `${install.dir}.exe`), "", "utf8");
  }
  return root;
}

before(() => {
  initCliFixtures(fixtures);
  writeFixtureHome(SEARCH_HOME, {
    sessions: [
      {
        id: "session-launcher-search",
        projectDir: "launcher-project",
        createdAt: 1000,
        events: [
          ev(
            "user/message",
            0,
            10,
            { role: "user", content: [{ type: "text", text: SEARCH_TEXT }] },
            { surfaceOp: "append" },
          ),
        ],
      },
    ],
  });
});

after(() => {
  for (const path of [
    TEMP_ROOT,
    join(LAUNCHER_TMP, "launcher-localappdata-empty"),
    join(LAUNCHER_TMP, "launcher-localappdata-multi"),
    join(LAUNCHER_TMP, "launcher-localappdata-noexe"),
  ]) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("入口脚本：帮助与载体说明", () => {
  it("总帮助退出 0，用法行指向入口脚本，stderr 为空", () => {
    const result = runLauncher(["--help"]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes(ENTRY_LINE), true, `stdout 缺少用法行: ${result.stdout}`);
  });

  it("子命令帮助退出 0，用法行同样指向入口脚本", () => {
    const result = runLauncher(["list", "--help"]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes(ENTRY_LINE), true, `stdout 缺少用法行: ${result.stdout}`);
  });
});

describe("入口脚本：退出码与 stderr 透传", () => {
  it("目标不存在时退出码 1 原样回传", () => {
    const result = runLauncher([
      "list",
      "--dsh-home",
      join(TEMP_ROOT, "no-such-home"),
      "--output-dir",
      OUT_DIR,
    ]);
    assert.equal(result.status, 1, `stderr: ${result.stderr}`);
    assert.equal(result.stderr.includes("错误: 目标不存在"), true, `stderr: ${result.stderr}`);
  });

  it("非法的 `--name` 值被拒绝", () => {
    // 此用例验证非法文件名被拒绝；参数逐字传递由下方实际检索命中的用例验证。
    const result = runLauncher(["list", "--output-dir", OUT_DIR, "--name", "a&b"]);
    assert.equal(result.status, 2, `stderr: ${result.stderr}`);
    assert.equal(result.stderr.includes("--name"), true, `stderr: ${result.stderr}`);
    assert.equal(
      result.stderr.includes("该命令不接受位置参数"),
      false,
      `参数被拆分了: ${result.stderr}`,
    );
  });

  it("含特殊字符的关键词经 `--` 逐字传递并命中会话", () => {
    const result = runLauncher([
      "search",
      "--output-dir",
      OUT_DIR,
      "--dsh-home",
      SEARCH_HOME,
      "--",
      SEARCH_TEXT,
    ]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stderr, "");
    const outputPath = parseOutputPath(result.stdout);
    assert.equal(existsSync(outputPath), true, `产物不存在: ${outputPath}`);
    const content = readFileSync(outputPath, "utf8");
    assert.equal(content.includes("命中总数：1"), true);
    assert.equal(
      content
        .split("\n")
        .some((line) => line.includes("session-launcher-search") && line.includes(SEARCH_TEXT)),
      true,
    );
  });

  it("`--` 终止符与其后的 `- item` 作为关键词原样到达", () => {
    const result = runLauncher([
      "search",
      "--output-dir",
      OUT_DIR,
      "--dsh-home",
      HEALTHY_HOME,
      "--",
      "- item",
    ]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const outputPath = parseOutputPath(result.stdout);
    assert.equal(existsSync(outputPath), true, `产物不存在: ${outputPath}`);
    const content = readFileSync(outputPath, "utf8");
    assert.equal(
      content.includes("命中总数：0"),
      true,
      `产物缺少零命中行: ${content.slice(0, 400)}`,
    );
  });
});

describe("桌面版定位：三条失败形态", () => {
  it("零候选退出 3，stdout 为空且 stderr 报告命中 0 个", () => {
    const localAppData = emptyLocalAppData();
    const outputDir = join(TEMP_ROOT, "out-no-install");
    const result = runLauncher(["list", "--output-dir", outputDir], { LOCALAPPDATA: localAppData });
    assert.equal(result.status, 3, `stderr: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr.replaceAll("\r\n", "\n"),
      "错误: 内部错误（未能在 %LOCALAPPDATA%\\Programs 下唯一定位桌面版安装，命中 0 个候选）\n",
    );
    assert.equal(result.stderr.includes(localAppData), false);
    assert.equal(existsSync(outputDir), false);
  });

  it("两个候选退出 3，stderr 报告命中 2 个", () => {
    const localAppData = localAppDataWithInstalls("multi", [
      { dir: "InstallOne", exe: true },
      { dir: "InstallTwo", exe: true },
    ]);
    const outputDir = join(TEMP_ROOT, "out-multiple-installs");
    const result = runLauncher(["list", "--output-dir", outputDir], { LOCALAPPDATA: localAppData });
    assert.equal(result.status, 3, `stderr: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr.replaceAll("\r\n", "\n"),
      "错误: 内部错误（未能在 %LOCALAPPDATA%\\Programs 下唯一定位桌面版安装，命中 2 个候选）\n",
    );
    assert.equal(result.stderr.includes(localAppData), false);
    assert.equal(existsSync(outputDir), false);
  });

  it("候选缺同名可执行文件时退出 3 并给出对应诊断", () => {
    const localAppData = localAppDataWithInstalls("noexe", [{ dir: "InstallSolo", exe: false }]);
    const result = runLauncher(["--help"], { LOCALAPPDATA: localAppData });
    assert.equal(result.status, 3, `stderr: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr.includes("缺少与目录同名的可执行文件"),
      true,
      `stderr: ${result.stderr}`,
    );
  });
});
