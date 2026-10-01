// CLI 集成测试（问答契约）：以子进程跑真实 CLI + 真实官方格式库 + 合成 DSH_HOME，
// 断言 提问/回答 条目的默认可见性、与 --tools/--role/范围选择的交互、--probe 的问答数、
// 载荷结构不符时的整体失败（退出 3、无产物）与检索侧的排除声明。
// 事件夹具全部取自 tests\fixtures.ts 的问答构造器，与单元测试、全组合门禁同源。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ASK_USER_PAYLOAD_MISMATCH_REASON } from "../scripts/lib/ask-user.ts";
import { defaultLibRoot, resolveDshHome } from "../scripts/lib/paths.ts";
import {
  askSampleErrorResult,
  askSampleMalformed,
  askSamplePaired,
  askSampleUnpaired,
  resetTempDir,
  writeFixtureHome,
} from "./fixtures.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/session-reader.ts", import.meta.url));
const LIB_ROOT = defaultLibRoot(resolveDshHome(undefined, process.env, homedir()));
// 该套用例要用真实的官方格式库；定位不到时立刻失败，不进入后续以 undefined 为入参的路径。
if (LIB_ROOT === undefined) {
  throw new Error(
    "默认锚点未能唯一确定官方格式库，cli-ask.test.ts 无法运行；请用 --lib-root 或修复安装树定位",
  );
}
const TEMP_ROOT = fileURLToPath(new URL("./.tmp/cli-ask", import.meta.url));
const HOME = join(TEMP_ROOT, "dsh");
const OUT_DIR = join(TEMP_ROOT, "out");
const PROJECT_DIR = "--C-Users-Alice-user_projects--";

const PAIRED_ID = "session-cli-ask-paired-01";
const UNPAIRED_ID = "session-cli-ask-unpaired-02";
const ERROR_ID = "session-cli-ask-error-03";
const MALFORMED_ID = "session-cli-ask-malformed-04";

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[]): CliResult {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function baseArgs(): string[] {
  return ["--dsh-home", HOME, "--lib-root", LIB_ROOT as string, "--output-dir", OUT_DIR];
}

/** 断言 stdout 两行契约并读回产物正文。 */
function readOutput(stdout: string): { readonly content: string; readonly summary: string } {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 2, `stdout 必须固定两行: ${JSON.stringify(stdout)}`);
  const pathMatch = /^完整输出已保存到: (.+)$/u.exec(lines[0]);
  const summaryMatch = /^(.*)；输出文件共 (\d+) 行$/u.exec(lines[1]);
  assert.notEqual(pathMatch, null, `第一行不符合契约: ${lines[0]}`);
  assert.notEqual(summaryMatch, null, `第二行不符合契约: ${lines[1]}`);
  if (pathMatch === null || summaryMatch === null) throw new Error("unreachable");
  const content = readFileSync(pathMatch[1], "utf8");
  assert.equal(content.split("\n").length - 1, Number(summaryMatch[2]), "行数契约不一致");
  return { content, summary: summaryMatch[1] };
}

function showMd(target: string, extra: readonly string[] = []): string {
  const result = runCli(["show", target, ...baseArgs(), ...extra]);
  assert.equal(result.status, 0, `show 失败: ${result.stderr}`);
  assert.equal(result.stderr, "");
  return readOutput(result.stdout).content;
}

function searchMd(keyword: string, extra: readonly string[] = []): string {
  const result = runCli(["search", keyword, ...baseArgs(), ...extra]);
  assert.equal(result.status, 0, `search 失败: ${result.stderr}`);
  assert.equal(result.stderr, "");
  return readOutput(result.stdout).content;
}

before(() => {
  resetTempDir(TEMP_ROOT);
  writeFixtureHome(HOME, {
    sessions: [
      {
        id: PAIRED_ID,
        projectDir: PROJECT_DIR,
        createdAt: 1000,
        events: askSamplePaired(),
        title: "问答：成对",
        turns: 1,
        steps: 1,
        lastPromptAt: 2000,
      },
      {
        id: UNPAIRED_ID,
        projectDir: PROJECT_DIR,
        createdAt: 1100,
        events: askSampleUnpaired(),
        title: "问答：未配对",
        turns: 1,
        steps: 1,
        lastPromptAt: 2100,
      },
      {
        id: ERROR_ID,
        projectDir: PROJECT_DIR,
        createdAt: 1200,
        events: askSampleErrorResult(),
        title: "问答：错误态",
        turns: 1,
        steps: 1,
        lastPromptAt: 2200,
      },
      {
        id: MALFORMED_ID,
        projectDir: PROJECT_DIR,
        createdAt: 1300,
        events: askSampleMalformed(),
        title: "问答：结构不符",
        turns: 1,
        steps: 1,
        lastPromptAt: 2300,
      },
    ],
  });
});

describe("CLI 问答条目", () => {
  it("默认参数下含 提问 与 回答，且不计入隐藏的工具条目数", () => {
    const content = showMd(PAIRED_ID);
    assert.equal(content.includes("**提问**：\n\n```text"), true);
    assert.equal(content.includes("**回答**：\n\n```text"), true);
    assert.equal(content.includes("[1] 确认事项 `x`（id：ask_one）"), true);
    assert.equal(content.includes("[1] id：ask_one\n选择：选项 A"), true);
    assert.equal(content.includes("[2] id：ask_three\n未作答"), true);
    // 原始工具条目仍默认隐藏，但问答事件不得因此计入"已隐藏 N 条工具调用/结果"。
    assert.equal(content.includes("**工具调用**"), false);
    assert.equal(content.includes("工具调用/结果"), false);
  });

  it("--tools 打开时同一事件同时以原始工具条目与问答条目出现", () => {
    const content = showMd(PAIRED_ID, ["--tools"]);
    assert.equal(content.includes("**工具调用**（`ask_user_question`）"), true);
    assert.equal(content.includes("**工具结果**"), true);
    assert.equal(content.includes("**提问**"), true);
    assert.equal(content.includes("**回答**"), true);
  });

  it("--role 不影响问答条目，仍作用于对话消息", () => {
    const asUser = showMd(PAIRED_ID, ["--role", "user"]);
    assert.equal(asUser.includes("**提问**"), true);
    assert.equal(asUser.includes("**回答**"), true);
    assert.equal(asUser.includes("问答夹具提问前置"), true);
    const asAssistant = showMd(PAIRED_ID, ["--role", "assistant"]);
    assert.equal(asAssistant.includes("**提问**"), true);
    assert.equal(asAssistant.includes("问答夹具提问前置"), false);
  });

  it("仍受 --seq 范围选择影响", () => {
    const narrowed = showMd(PAIRED_ID, ["--seq", "0-1"]);
    assert.equal(narrowed.includes("**提问**"), false);
    assert.equal(narrowed.includes("**回答**"), false);
    assert.equal(narrowed.includes("筛选：seq 0-1；显示 1 条时间线条目"), true);
  });

  it("--probe 给出问答数（成对 2/2、未配对 1/0、错误态 1/0）", () => {
    assert.equal(showMd(PAIRED_ID, ["--probe"]).includes("- 问答数：2 提问 / 2 回答"), true);
    assert.equal(showMd(UNPAIRED_ID, ["--probe"]).includes("- 问答数：1 提问 / 0 回答"), true);
    assert.equal(showMd(ERROR_ID, ["--probe"]).includes("- 问答数：1 提问 / 0 回答"), true);
  });

  it("未配对提问照常呈现；错误态结果只呈现提问且不触发失败", () => {
    const unpaired = showMd(UNPAIRED_ID);
    assert.equal(unpaired.includes("**提问**"), true);
    assert.equal(unpaired.includes("**回答**"), false);
    const errored = showMd(ERROR_ID);
    assert.equal(errored.includes("**提问**"), true);
    assert.equal(errored.includes("**回答**"), false);
    assert.equal(errored.includes("- 异常："), false);
    // 错误态结果本身是普通工具结果：默认隐藏但照常计数，用 --tools 才能看到它为何没有回答。
    assert.equal(errored.includes("已隐藏 1 条工具调用/结果（--tools 显示）"), true);
    assert.equal(showMd(ERROR_ID, ["--tools"]).includes("**工具结果**（错误）"), true);
  });

  it("载荷结构不符时整体失败：退出 3、stdout 空、stderr 单行、不产出文件", () => {
    const before = readdirSync(OUT_DIR).length;
    const result = runCli(["show", MALFORMED_ID, ...baseArgs()]);
    assert.equal(result.status, 3);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "错误: 数据不可读\n");
    assert.equal(readdirSync(OUT_DIR).length, before);
    // --tools 与 --probe 都不能把它变成"部分可用"。
    for (const extra of [["--tools"], ["--probe"], ["--summary"]]) {
      const errored = runCli(["show", MALFORMED_ID, ...baseArgs(), ...extra]);
      // --summary 不呈现问答条目，因此不做抽取、照常成功；其余两种形态必须失败。
      if (extra[0] === "--summary") {
        assert.equal(errored.status, 0, `--summary 不应受载荷结构影响: ${errored.stderr}`);
      } else {
        assert.equal(errored.status, 3, `${extra[0]} 应整体失败`);
        assert.equal(errored.stderr, "错误: 数据不可读\n");
      }
    }
  });

  it("--format json 与 jsonl 不做问答抽取，原始载荷照常导出", () => {
    const json = runCli(["show", MALFORMED_ID, ...baseArgs(), "--format", "json"]);
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(readOutput(json.stdout).content) as {
      messages: { type: string; arguments?: string }[];
    };
    const call = parsed.messages.find((message) => message.type === "tool/call");
    assert.equal(call?.arguments, '{"questions": [');
    const jsonl = runCli(["show", MALFORMED_ID, ...baseArgs(), "--format", "jsonl"]);
    assert.equal(jsonl.status, 0, jsonl.stderr);
    assert.equal(
      readOutput(jsonl.stdout).content.includes('"arguments":"{\\"questions\\": ["'),
      true,
    );
  });
});

describe("CLI 检索的问答单元", () => {
  it("默认档命中 提问 与 回答，标签正确", () => {
    const content = searchMd("选项 A");
    assert.equal(content.includes("`提问`："), true);
    assert.equal(content.includes("`回答`："), true);
    assert.equal(content.includes("`tool/call`："), false);
  });

  it("tools 档另含原始载荷（tool/call 与 tool/result）", () => {
    const content = searchMd("选项 A", ["--scope", "tools"]);
    assert.equal(content.includes("`提问`："), true);
    assert.equal(content.includes("`tool/call`："), true);
    assert.equal(content.includes("`tool/result`："), true);
  });

  it("结构不符的会话逐条列入排除项，不影响其余会话的命中", () => {
    const content = searchMd("选项 A");
    assert.equal(
      content.includes(`排除会话：\`${MALFORMED_ID}\`（\`${ASK_USER_PAYLOAD_MISMATCH_REASON}\`）`),
      true,
    );
    assert.equal(content.includes("扫描会话 4 个；纳入 3 个；排除 1 个"), true);
    const json = runCli(["search", "选项 A", ...baseArgs(), "--format", "json"]);
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(readOutput(json.stdout).content) as {
      coverage: { includedCount: number; excluded: { id: string; reason: string }[] };
    };
    assert.deepEqual(parsed.coverage.excluded, [
      { id: MALFORMED_ID, reason: ASK_USER_PAYLOAD_MISMATCH_REASON },
    ]);
    assert.equal(parsed.coverage.includedCount, 3);
  });

  it("0 命中时仍给出覆盖声明（排除项不因无命中而消失）", () => {
    const content = searchMd("zzznomatch");
    assert.equal(content.includes("命中总数：0"), true);
    assert.equal(content.includes(`排除会话：\`${MALFORMED_ID}\``), true);
    assert.equal(existsSync(OUT_DIR), true);
  });
});
