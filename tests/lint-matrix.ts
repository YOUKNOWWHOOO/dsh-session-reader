// 全组合穷尽 lint 门禁（f2 lint 合规 spike §5 方案的可执行实现）。
// 目的：证明"任意会话内容 × 任意有效参数组合"生成的 md 产物真实通过全局 markdownlint 基线，
// 并对 json/jsonl 做结构回归、对手写结构白名单做断言、对确定性/错误路径做验证。
// 用法（Windows；Node v26 原生执行 TypeScript）：
//   node tests/lint-matrix.ts --workdir <工作目录> [--lint-config <markdownlint 配置>]
//                             [--markdownlint-js <markdownlint-cli 入口 js>]
//                             [--real-home <dsh 主目录>] [--skip-real]
// 判据：脚本退出 0 当且仅当全部断言通过；md 产物 lint 必须退出 0 且 stdout/stderr 无输出。
// lint 以参数数组直接调用 markdownlint-cli 的 JS 入口（不经 shell）；入口默认从 workdir 的
// node_modules 链解析，解析失败时以显式错误要求 --markdownlint-js。
// 留档：<workdir>/fixture-healthy、<workdir>/fixture-broken、<workdir>/out（全部产物）、
//       <workdir>/matrix-summary.json（逐组合结果）、<workdir>/lint-output.txt。
// 工作目录内只清理/重建上述固定子路径；真实 dsh 主目录全程只读。
//
// 模块划分（拆分后每个文件 ≤1200 行；入口仍是 node tests/lint-matrix.ts）：
//   tests/matrix-paths.ts       共享路径与运行时锚点（技能根/CLI 入口/lint 配置/官方库锚点/超时）
//   tests/matrix-fixtures.ts    敌意内容集、会话夹具定义、合成 DSH_HOME 构造与字段注入
//   tests/matrix-cases.ts       组合矩阵词汇表与 list/show 组合定义
//   tests/matrix-cases-query.ts search/stats/check 组合定义
//   tests/matrix-assert.ts      产物断言库（md 结构白名单、json/jsonl 回归）与 markdownlint 调用
// 本文件只保留：CLI 参数解析、逐组合执行、确定性复跑、真实会话组合、汇总与退出码。
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { countLines } from "../scripts/lib/paths.ts";
import {
  asRecord,
  checkJsonlStructure,
  checkJsonStructure,
  checkMarkdownStructure,
  MARKERS,
  MULTILINE_MARKERS,
  resolveMarkdownlintJs,
  runLint,
} from "./matrix-assert.ts";
import { listCases, type MatrixCase, mcase, showCases } from "./matrix-cases.ts";
import { checkCases, searchCases, statsCases } from "./matrix-cases-query.ts";
import { buildFixtureHomes, MAIN_ID } from "./matrix-fixtures.ts";
import { DEFAULT_LINT_CONFIG, LIB_ROOT, RUN_TIMEOUT_MS, SESSION_READER } from "./matrix-paths.ts";

// ------------------------- 执行与断言 -------------------------

interface CaseResult {
  readonly id: string;
  readonly args: string[];
  readonly exit: number | null;
  readonly outputPath: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface MatrixContext {
  readonly workdir: string;
  readonly outDir: string;
  readonly problems: string[];
  readonly results: CaseResult[];
  readonly markersSeen: Set<string>;
  readonly multiLineMarkersSeen: Set<string>;
  readonly homes: Map<string, string>;
}

function runRaw(args: readonly string[]): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError: string | null;
} {
  const result = spawnSync(process.execPath, [SESSION_READER, ...args], {
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    spawnError: result.error === undefined ? null : String(result.error),
  };
}

/** 追加 --output-dir 时尊重选项终止符：必须插在 `--` 之前，否则会被当作位置参数。 */
function withOutputDir(args: readonly string[], outDir: string): string[] {
  const terminatorAt = args.indexOf("--");
  if (terminatorAt === -1) return [...args, "--output-dir", outDir];
  return [...args.slice(0, terminatorAt), "--output-dir", outDir, ...args.slice(terminatorAt)];
}

function parseContract(
  caseId: string,
  stdout: string,
  problems: string[],
): { readonly path: string; readonly lines: number } | null {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  if (lines.length !== 2) {
    problems.push(`${caseId}: stdout 非两行契约: ${JSON.stringify(stdout)}`);
    return null;
  }
  const pathMatch = /^完整输出已保存到: (.+)$/u.exec(lines[0]);
  const summaryMatch = /^(.+)；输出文件共 (\d+) 行$/u.exec(lines[1]);
  if (pathMatch === null || summaryMatch === null) {
    problems.push(`${caseId}: stdout 契约行格式错误: ${JSON.stringify(stdout)}`);
    return null;
  }
  return { path: pathMatch[1], lines: Number(summaryMatch[2]) };
}

function executeCase(ctx: MatrixContext, item: MatrixCase): void {
  const resolved = item.args.map((arg) => ctx.homes.get(arg) ?? arg);
  const args = item.omitOutputDir ? resolved : withOutputDir(resolved, ctx.outDir);
  const outDir = ctx.outDir;
  const before = readdirSync(outDir).length;
  const raw = runRaw(args);
  const result: CaseResult = {
    id: item.id,
    args,
    exit: raw.status,
    outputPath: null,
    stdout: raw.stdout,
    stderr: raw.stderr,
  };
  if (raw.spawnError !== null) {
    ctx.problems.push(`${item.id}: 子进程启动失败 ${raw.spawnError}`);
    ctx.results.push(result);
    return;
  }
  if (raw.status !== item.expectExit) {
    ctx.problems.push(
      `${item.id}: 退出码 ${String(raw.status)} ≠ 期望 ${item.expectExit}（stderr=${JSON.stringify(raw.stderr)}）`,
    );
  }
  if (!item.expectOutput) {
    if (raw.stdout !== "")
      ctx.problems.push(`${item.id}: 错误路径不应有 stdout: ${JSON.stringify(raw.stdout)}`);
    if (raw.stderr !== item.expectStderr) {
      ctx.problems.push(
        `${item.id}: stderr 与期望全文不一致（实际=${JSON.stringify(raw.stderr)} 期望=${JSON.stringify(item.expectStderr)}）`,
      );
    }
    const after = readdirSync(outDir).length;
    if (after !== before) ctx.problems.push(`${item.id}: 错误路径不应产生输出文件`);
    ctx.results.push(result);
    return;
  }
  if (raw.stderr !== "") {
    ctx.problems.push(`${item.id}: 成功路径不应有 stderr: ${JSON.stringify(raw.stderr)}`);
  }
  const contract = parseContract(item.id, raw.stdout, ctx.problems);
  if (contract === null) {
    ctx.results.push(result);
    return;
  }
  if (!existsSync(contract.path)) {
    ctx.problems.push(`${item.id}: 输出文件不存在: ${contract.path}`);
    ctx.results.push(result);
    return;
  }
  const content = readFileSync(contract.path, "utf8");
  const actualLines = countLines(content);
  if (actualLines !== contract.lines) {
    ctx.problems.push(
      `${item.id}: 行数契约不一致（文件 ${actualLines} ≠ stdout ${contract.lines}）`,
    );
  }
  const updated: CaseResult = { ...result, outputPath: contract.path };
  ctx.results.push(updated);
  if (item.kind === "md")
    checkMarkdownStructure(
      item.id,
      content,
      ctx.problems,
      ctx.markersSeen,
      ctx.multiLineMarkersSeen,
    );
  else if (item.kind === "json") checkJsonStructure(item.id, item.shape, content, ctx.problems);
  else if (item.kind === "jsonl") checkJsonlStructure(item.id, content, ctx.problems);
}

// ------------------------- 参数与主流程 -------------------------

interface MatrixOptions {
  readonly workdir: string;
  readonly lintConfig: string;
  readonly markdownlintJs: string | null;
  readonly realHome: string;
  readonly skipReal: boolean;
}

function parseOptions(argv: readonly string[]): MatrixOptions | null {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--skip-real") {
      values.set(token, "true");
      continue;
    }
    if (
      token === "--workdir" ||
      token === "--lint-config" ||
      token === "--markdownlint-js" ||
      token === "--real-home"
    ) {
      const value = argv[index + 1];
      if (value === undefined) return null;
      values.set(token, value);
      index += 1;
      continue;
    }
    return null;
  }
  const workdir = values.get("--workdir");
  if (workdir === undefined) return null;
  const markdownlintJs = values.get("--markdownlint-js");
  return {
    workdir: resolve(workdir),
    lintConfig: resolve(values.get("--lint-config") ?? DEFAULT_LINT_CONFIG),
    markdownlintJs: markdownlintJs === undefined ? null : resolve(markdownlintJs),
    realHome: resolve(values.get("--real-home") ?? join(homedir(), ".dsh")),
    skipReal: values.get("--skip-real") === "true",
  };
}

/** 确定性复跑产生的额外 md 产物数（list 与 show 各跑两次）。 */
const DETERMINISM_MD_ARTIFACTS = 4;

async function main(argv: readonly string[]): Promise<number> {
  const options = parseOptions(argv);
  if (options === null) {
    process.stderr.write(
      "用法: node tests/lint-matrix.ts --workdir <目录> [--lint-config <配置>] [--markdownlint-js <入口>] [--real-home <dsh 主目录>] [--skip-real]\n",
    );
    return 2;
  }
  for (const [label, path] of [
    ["官方格式库锚点", join(LIB_ROOT, "@deepseek-ai", "dsh-session-format-catalog")],
    ["lint 配置", options.lintConfig],
  ] as const) {
    if (!existsSync(path)) throw new Error(`${label}不存在: ${path}`);
  }
  if (!options.skipReal && !existsSync(options.realHome)) {
    throw new Error(`真实 dsh 主目录不存在: ${options.realHome}`);
  }
  const { healthyHome, brokenHome, outDir } = buildFixtureHomes(options.workdir, LIB_ROOT);

  const ctx: MatrixContext = {
    workdir: options.workdir,
    outDir,
    problems: [],
    results: [],
    markersSeen: new Set<string>(),
    multiLineMarkersSeen: new Set<string>(),
    homes: new Map([
      ["HEALTHY", healthyHome],
      ["BROKEN", brokenHome],
      ["NO_SUCH_HOME", join(options.workdir, "no-such-home")],
    ]),
  };

  const staticCases: MatrixCase[] = [
    ...listCases(),
    ...showCases(),
    ...searchCases(),
    ...statsCases(),
    ...checkCases(),
  ];
  for (const item of staticCases) {
    executeCase(ctx, item);
  }

  if (!options.skipReal) {
    await runRealCases(ctx, options);
  }

  // 确定性：同一输入两次渲染（文件名除外）逐字节一致。
  // 两个命令各跑两次，因此 out 目录内会多出 4 个 md 产物；该数量由下面的常量与断言共同约束。
  const listArgs = [
    "list",
    "--dsh-home",
    healthyHome,
    "--lib-root",
    LIB_ROOT,
    "--output-dir",
    outDir,
  ];
  const firstList = runRaw(listArgs);
  const secondList = runRaw(listArgs);
  compareDeterministic(
    "determinism-list",
    firstList.stdout,
    secondList.stdout,
    outDir,
    ctx.problems,
  );
  const showArgs = [
    "show",
    MAIN_ID,
    "--dsh-home",
    healthyHome,
    "--lib-root",
    LIB_ROOT,
    "--output-dir",
    outDir,
  ];
  const firstShow = runRaw(showArgs);
  const secondShow = runRaw(showArgs);
  compareDeterministic(
    "determinism-show",
    firstShow.stdout,
    secondShow.stdout,
    outDir,
    ctx.problems,
  );

  // md 产物 lint：目录整跑 + 显式文件分批（后者给出实际处理文件数）。
  const markdownlintJs = resolveMarkdownlintJs(options);
  const lint = runLint(markdownlintJs, options.lintConfig, outDir, options.workdir);
  if (lint.status !== 0) {
    ctx.problems.push(`markdownlint 退出码 ${String(lint.status)}`);
    const detail = `${lint.stdout}${lint.stderr}`.trim().split("\n").slice(0, 60).join("\n");
    if (detail.length > 0) ctx.problems.push(`markdownlint 输出（截断 60 行）:\n${detail}`);
  }
  if (lint.stdout.trim() !== "" || lint.stderr.trim() !== "") {
    ctx.problems.push("markdownlint 输出非空（要求无 stdout/stderr）");
  }

  const mdCount = ctx.results.filter((entry) => entry.outputPath?.endsWith(".md") === true).length;
  const jsonCount = ctx.results.filter(
    (entry) => entry.outputPath?.endsWith(".json") === true,
  ).length;
  const jsonlCount = ctx.results.filter(
    (entry) => entry.outputPath?.endsWith(".jsonl") === true,
  ).length;
  // 实际处理文件数断言：out 内 md = 用例 md 产物 + 确定性复跑产物；且显式分批覆盖全部文件。
  if (lint.mdFiles !== mdCount + DETERMINISM_MD_ARTIFACTS) {
    ctx.problems.push(
      `out 内 md 文件数 ${lint.mdFiles} ≠ 用例 md ${mdCount} + 确定性 ${DETERMINISM_MD_ARTIFACTS}`,
    );
  }
  if (lint.processedFiles !== lint.mdFiles) {
    ctx.problems.push(
      `markdownlint 实际处理文件数 ${lint.processedFiles} ≠ md 文件数 ${lint.mdFiles}`,
    );
  }
  if (lint.mdFiles === 0 || lint.batches < 1) {
    ctx.problems.push("markdownlint 未处理任何 md 文件");
  }

  // 全部敌意标记必须真实进入过产物（确保组合覆盖到位）。
  for (const marker of MARKERS) {
    if (!ctx.markersSeen.has(marker)) {
      ctx.problems.push(`敌意标记未出现在任何 md 产物: ${marker}`);
    }
  }
  for (const marker of MULTILINE_MARKERS) {
    if (!ctx.multiLineMarkersSeen.has(marker)) {
      ctx.problems.push(`跨行敌意标记未出现在任何 md 产物: ${JSON.stringify(marker)}`);
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    workdir: options.workdir,
    lintConfig: options.lintConfig,
    markdownlintJs,
    realHome: options.skipReal ? null : options.realHome,
    counts: {
      cases: ctx.results.length,
      md: mdCount,
      json: jsonCount,
      jsonl: jsonlCount,
      structureViolations: ctx.problems.length,
    },
    lint: {
      exit: lint.status,
      stdoutEmpty: lint.stdout.trim() === "",
      stderrEmpty: lint.stderr.trim() === "",
      mdFiles: lint.mdFiles,
      processedFiles: lint.processedFiles,
      batches: lint.batches,
    },
    problems: ctx.problems,
    cases: ctx.results.map((entry) => ({
      id: entry.id,
      args: entry.args,
      exit: entry.exit,
      outputPath: entry.outputPath,
    })),
  };
  writeFileSync(
    join(options.workdir, "matrix-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `组合 ${ctx.results.length}（md ${mdCount} / json ${jsonCount} / jsonl ${jsonlCount}）；lint exit=${String(lint.status)}；问题 ${ctx.problems.length}\n`,
  );
  for (const problem of ctx.problems) process.stdout.write(`问题: ${problem}\n`);
  return ctx.problems.length === 0 ? 0 : 1;
}

function compareDeterministic(
  id: string,
  firstStdout: string,
  secondStdout: string,
  outDir: string,
  problems: string[],
): void {
  const first = parseContract(id, firstStdout, problems);
  const second = parseContract(`${id}-重复`, secondStdout, problems);
  if (first === null || second === null) return;
  const firstContent = readFileSync(first.path, "utf8");
  const secondContent = readFileSync(second.path, "utf8");
  if (firstContent !== secondContent) {
    problems.push(`${id}: 两次渲染内容不一致（输出目录 ${outDir}）`);
  }
}

async function runRealCases(ctx: MatrixContext, options: MatrixOptions): Promise<void> {
  const base = ["--dsh-home", options.realHome, "--lib-root", LIB_ROOT];
  const listCase = mcase(
    "real-list-json",
    ["list", ...base, "--format", "json"],
    "json",
    "list",
    0,
  );
  executeCase(ctx, listCase);
  const listResult = ctx.results[ctx.results.length - 1];
  if (listResult.outputPath === null) {
    ctx.problems.push("real-list-json: 无法获取真实会话清单，跳过真实会话组合");
    return;
  }
  const doc = asRecord(JSON.parse(readFileSync(listResult.outputPath, "utf8")));
  const sessions = Array.isArray(doc?.sessions) ? doc.sessions : [];
  const ids = sessions
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === "string");
  if (ids.length === 0) {
    ctx.problems.push("real-list-json: 真实会话清单为空");
    return;
  }
  const realCases: MatrixCase[] = [
    mcase("real-list-md", ["list", ...base], "md", null, 0),
    mcase("real-list-md-full", ["list", ...base, "--full"], "md", null, 0),
    mcase("real-stats-md", ["stats", ...base], "md", null, 0),
    mcase("real-search-md", ["search", "a", ...base], "md", null, 0),
    mcase("real-check-md", ["check", ...base], "md", null, 0),
  ];
  ids.forEach((id, index) => {
    realCases.push(
      mcase(`real-show-md-${index}-${id.slice(0, 8)}`, ["show", id, ...base], "md", null, 0),
    );
    if (index < 3) {
      realCases.push(
        mcase(
          `real-show-md-summary-${index}-${id.slice(0, 8)}`,
          ["show", id, ...base, "--summary"],
          "md",
          null,
          0,
        ),
      );
    }
  });
  realCases.push(
    mcase(
      "real-show-md-visible",
      ["show", ids[0], ...base, "--thinking", "--tools", "--events", "--headers"],
      "md",
      null,
      0,
    ),
    mcase("real-show-json", ["show", ids[0], ...base, "--format", "json"], "json", "show", 0),
  );
  for (const item of realCases) {
    executeCase(ctx, item);
  }
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
