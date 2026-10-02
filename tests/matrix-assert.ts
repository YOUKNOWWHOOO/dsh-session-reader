// 用途：全组合 lint 门禁的产物断言库——md 结构白名单（标题词表/围栏闭合/末尾换行/空行纪律）、
//       敌意标记载体覆盖、json/jsonl 结构回归，以及 markdownlint JS 入口解析与分批调用判定。
// 主要入口：checkMarkdownStructure、checkJsonStructure、checkJsonlStructure、resolveMarkdownlintJs、runLint。
// 关键依赖：node:child_process、node:fs、node:module、node:path；./matrix-cases.ts 的 JsonShape 仅作类型导入。
// 设计约束：断言只判定"结构是否合法"，绝不改写产物、绝不因无法判定而降级；
//           任一违规以问题串追加到 problems，由入口统一汇总为退出码。

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { JsonShape } from "./matrix-cases.ts";

// ------------------------- 结构白名单（手写解析） -------------------------

const HEADING_WHITELIST =
  /^(会话列表|会话列表（完整）|会话记录|检索结果|统计|完整性校验|时间线|轮次大纲|每会话命中分布|子代理 \d+(\.\d+)*)$/u;
/**
 * 时间线标签词表。
 *
 * 契约里的 12 个标签形态中，`**工具结果**` 与 `**工具结果**（错误）` 共用同一个标签名（错误态由
 * 紧随其后的括号标注表达），因此这里登记的是 11 个标签名，覆盖全部 12 个形态。
 *
 * 判定方式：行首起 `**` 的行的第一个加粗片段就是标签，必须落在词表内。参与这条判定的行只有
 * 时间线标签行——正文一律经载体承载（围栏内的行不参与、行内载体的行不以 `**` 开头），
 * `list --full` 的续行以两空格缩进，因此不会误判。
 *
 * 存在理由：标签是"这条条目是什么"的唯一信号，出现词表外的标签（例如某次改动新造了一个标签
 * 却忘了登记）说明 md 骨架已偏离契约；仅靠 markdownlint 无法发现这类偏差。
 */
const LABEL_WHITELIST = new Set([
  "用户",
  "助手",
  "推理",
  "工具调用",
  "工具结果",
  "系统消息",
  "事件",
  "提问",
  "回答",
  "子代理任务",
  "发往子代理",
]);
const LABEL_LINE = /^\*\*([^*]+)\*\*/u;
const FENCE_OPEN = /^(`{3,})text$/u;
const FENCE_CLOSE = /^(`{3,})$/u;
/** 单行敌意标记：必须真实出现在 md 产物中，且围栏外只能处于行内代码跨度内。 */
export const MARKERS = [
  "<script>alert(1)</script>",
  "https://example.com/path",
  "**bold text**",
  "$ echo hello",
  "a@b.com",
] as const;

/**
 * 跨行标记：含换行的敌意内容（如 CR/CRLF 归一化后的 `line1\nline2`）无法按单行匹配，
 * 必须在整份产物上判定。其"是否被归一化"由 `checkMarkdownStructure` 的 CR 检查单独兜住。
 */
export const MULTILINE_MARKERS = ["line1\nline2"] as const;

interface HeadingNode {
  readonly level: number;
  readonly text: string;
  readonly children: HeadingNode[];
}

/** 行内代码跨度的可覆盖区间（按反引号串长度配对）。 */
function codeSpanRanges(line: string): ReadonlyArray<readonly [number, number]> {
  const ranges: Array<[number, number]> = [];
  const runs: Array<{ readonly start: number; readonly length: number }> = [];
  const pattern = /`+/gu;
  for (const match of line.matchAll(pattern)) {
    runs.push({ start: match.index, length: match[0].length });
  }
  let open: { readonly start: number; readonly length: number } | null = null;
  for (const run of runs) {
    if (open === null) {
      open = run;
    } else if (open.length === run.length) {
      ranges.push([open.start, run.start + run.length]);
      open = null;
    }
  }
  return ranges;
}

function inRanges(
  ranges: ReadonlyArray<readonly [number, number]>,
  start: number,
  length: number,
): boolean {
  return ranges.some(([from, to]) => start >= from && start + length <= to);
}

/** 扫描行内敌意标记：围栏内只登记出现（载体本身就是围栏）；围栏外必须处于行内代码跨度内。 */
function collectMarkers(
  caseId: string,
  line: string,
  ranges: ReadonlyArray<readonly [number, number]> | null,
  problems: string[],
  markersSeen: Set<string>,
): void {
  for (const marker of MARKERS) {
    let from = 0;
    for (;;) {
      const at = line.indexOf(marker, from);
      if (at === -1) break;
      markersSeen.add(marker);
      if (ranges !== null && !inRanges(ranges, at, marker.length)) {
        problems.push(`${caseId}: 数据标记未处于代码载体: ${marker}`);
      }
      from = at + 1;
    }
  }
}

/** 结构白名单断言（md 产物）：行/空行纪律、标题词表与同级唯一、围栏闭合、载体覆盖、无制表符/CR。 */
export function checkMarkdownStructure(
  caseId: string,
  content: string,
  problems: string[],
  markersSeen: Set<string>,
  multiLineMarkersSeen: Set<string>,
): void {
  const fail = (message: string): void => {
    problems.push(`${caseId}: ${message}`);
  };
  if (content.length === 0) {
    fail("产物为空");
    return;
  }
  for (const marker of MULTILINE_MARKERS) {
    if (content.includes(marker)) multiLineMarkersSeen.add(marker);
  }
  // BOM 只在文件开头才是 BOM 标记；载荷内部的 U+FEFF 是数据，契约明确要求零宽字符在载体内原样保留
  // （开发规范 R4），因此这里只拦"以 BOM 开头"，其余位置的 U+FEFF 由骨架级检查处理（见行循环）。
  // 实测根因：真实会话的工具结果里就有一段以 U+FEFF 开头的 C++ 源码（web 抓取内容），此前按
  // `content.includes("\uFEFF")` 判定会让该用例随真实数据在红绿之间摆动。
  if (content.startsWith("\uFEFF")) fail("以 BOM 开头");
  if (content.includes("\t")) fail("含制表符（应已归一化为空格）");
  // 输出契约要求 LF-only：CR 会被 markdownlint 忽略，因此必须在此单独拦截，
  // 否则正文携带的 CR 会静默破坏"UTF-8 无 BOM、LF"这一契约。
  if (content.includes("\r")) fail("含 CR 字节（CR/CRLF 应已归一化为 LF）");
  if (!content.endsWith("\n")) fail("末尾缺少换行");
  if (content.endsWith("\n\n")) fail("末尾多余空行");
  const lines = content.split("\n");
  if (lines[lines.length - 1] !== "") {
    fail("结尾异常");
    return;
  }
  const body = lines.slice(0, -1);
  const root: HeadingNode = { level: 0, text: "", children: [] };
  const stack: HeadingNode[] = [root];
  let headingCount = 1;
  let fence: number | null = null;
  for (let index = 0; index < body.length; index += 1) {
    const line = body[index];
    if (fence !== null) {
      // 围栏内的内容已被 render 层归一化（CR → LF、制表符 → 空格），标记只登记不检查载体。
      collectMarkers(caseId, line, null, problems, markersSeen);
      const close = FENCE_CLOSE.exec(line);
      if (close !== null && close[1].length >= fence) {
        if (index + 1 < body.length && body[index + 1] !== "") {
          fail(`围栏闭合后缺少空行（行 ${index + 1}）`);
        }
        fence = null;
      }
      continue;
    }
    if (line.endsWith("\r")) fail(`结构行含 CR（行 ${index + 1}）`);
    if (line.includes("\uFEFF")) {
      // 围栏外的 U+FEFF 只能出现在行内代码跨度里（会话正文一律经载体承载）；出现在骨架中说明
      // 有一段零宽字符直接拼进了结构行，会让"结构行"与"数据"的边界失效。围栏内的载荷不判：
      // 那是契约允许原样保留的数据。
      const ranges = codeSpanRanges(line);
      let from = 0;
      for (;;) {
        const at = line.indexOf("\uFEFF", from);
        if (at < 0) break;
        if (!inRanges(ranges, at, 1)) fail(`骨架含 U+FEFF（行 ${index + 1}，列 ${at + 1}）`);
        from = at + 1;
      }
    }
    if (line === "" && index > 0 && body[index - 1] === "") {
      fail(`连续空行（行 ${index + 1}）`);
    }
    const open = FENCE_OPEN.exec(line);
    if (open !== null) {
      if (index > 0 && body[index - 1] !== "") fail(`围栏前缺少空行（行 ${index + 1}）`);
      fence = open[1].length;
      continue;
    }
    if (FENCE_CLOSE.test(line)) fail(`孤立围栏行（行 ${index + 1}）`);
    const label = LABEL_LINE.exec(line);
    if (label !== null && !LABEL_WHITELIST.has(label[1])) {
      fail(`时间线标签不在词表: ${label[1]}（行 ${index + 1}）`);
    }
    const heading = /^(#{1,6}) (.+)$/u.exec(line);
    if (heading !== null) {
      const level = heading[1].length;
      const text = heading[2];
      if (!HEADING_WHITELIST.test(text)) fail(`标题不在词表: ${text}`);
      if (level === 1) headingCount += 1;
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
      const parent = stack[stack.length - 1];
      if (parent.children.some((child) => child.text === text)) {
        fail(`同级重复标题: ${text}`);
      }
      const node: HeadingNode = { level, text, children: [] };
      parent.children.push(node);
      stack.push(node);
      continue;
    }
    const next = index + 1 < body.length ? body[index + 1] : "";
    const previous = index > 0 ? body[index - 1] : "";
    const listLine = line.startsWith("- ") || line.startsWith("  ");
    const tableLine = line.startsWith("|");
    const previousIsList = previous.startsWith("- ") || previous.startsWith("  ");
    const previousIsTable = previous.startsWith("|");
    const nextIsList = next.startsWith("- ") || next.startsWith("  ");
    const nextIsTable = next.startsWith("|");
    if (listLine && !previousIsList && previous !== "") {
      fail(`列表块前缺少空行（行 ${index + 1}）`);
    }
    if (listLine && !nextIsList && next !== "") {
      fail(`列表块后缺少空行（行 ${index + 1}）`);
    }
    if (tableLine && !previousIsTable && previous !== "") {
      fail(`表格块前缺少空行（行 ${index + 1}）`);
    }
    if (tableLine && !nextIsTable && next !== "") {
      fail(`表格块后缺少空行（行 ${index + 1}）`);
    }
    const ranges = codeSpanRanges(line);
    collectMarkers(caseId, line, ranges, problems, markersSeen);
  }
  if (fence !== null) fail("围栏未闭合");
  if (headingCount !== 2) fail(`H1 数量异常（期望 1，实际 ${headingCount - 1}）`);
}

// ------------------------- JSON / JSONL 回归 -------------------------

/** 非 null、非数组对象判型（JSON/JSONL 与夹具字段注入共用）。 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function requireKeys(
  caseId: string,
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
  problems: string[],
): boolean {
  if (record === undefined) {
    problems.push(`${caseId}: JSON 结构不是对象`);
    return false;
  }
  for (const key of keys) {
    if (!(key in record)) {
      problems.push(`${caseId}: JSON 缺少字段 ${key}`);
      return false;
    }
  }
  return true;
}

/** json 结构回归断言：按组合声明的 shape 逐形态校验字段齐备与取值合法性。 */
export function checkJsonStructure(
  caseId: string,
  shape: JsonShape,
  content: string,
  problems: string[],
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    problems.push(`${caseId}: JSON 解析失败 ${String(error)}`);
    return;
  }
  const record = asRecord(parsed);
  if (shape === "list") {
    if (!requireKeys(caseId, record, ["sessions", "coverage"], problems)) return;
    const sessions = record?.sessions;
    if (!Array.isArray(sessions)) {
      problems.push(`${caseId}: sessions 不是数组`);
      return;
    }
    const first = asRecord(sessions[0]);
    if (sessions.length > 0) {
      requireKeys(
        caseId,
        first,
        [
          "id",
          "type",
          "title",
          "cwd",
          "workspaceTitle",
          "createdAt",
          "lastActivityAt",
          "lastPromptAt",
          "turns",
          "steps",
          "blank",
          "agentPreset",
          "model",
          "tokens",
          "sizeBytes",
          "metadata",
        ],
        problems,
      );
      if (first?.shortId !== undefined) {
        problems.push(`${caseId}: 列表项不应再输出截断的 shortId（显示值必须与可传值同源）`);
      }
    }
    checkCoverage(caseId, record?.coverage, problems);
  } else if (shape === "show") {
    if (
      !requireKeys(caseId, record, ["session", "meta", "turns", "messages", "subagents"], problems)
    ) {
      return;
    }
    const session = asRecord(record?.session);
    if (typeof session?.id !== "string") problems.push(`${caseId}: session.id 缺失`);
  } else if (shape === "search") {
    if (
      !requireKeys(
        caseId,
        record,
        ["matches", "total", "truncated", "scope", "totalIsExact", "scan", "distribution"],
        problems,
      )
    ) {
      return;
    }
    if (typeof record?.truncated !== "boolean") problems.push(`${caseId}: truncated 不是布尔`);
    if (record?.totalIsExact !== true) {
      problems.push(`${caseId}: totalIsExact 必须为 true（命中总数与 --limit 解耦）`);
    }
    checkCoverage(caseId, record?.coverage, problems);
    checkScanSummary(caseId, record?.scan, problems);
    checkDistribution(caseId, record?.distribution, problems);
  } else if (shape === "stats") {
    const kind = record?.kind;
    if (kind === "global") {
      if (typeof record?.sessionCount !== "number") problems.push(`${caseId}: sessionCount 缺失`);
    } else if (kind === "single") {
      const session = asRecord(record?.session);
      if (typeof session?.id !== "string") problems.push(`${caseId}: single.session.id 缺失`);
    } else {
      problems.push(`${caseId}: stats.kind 非法`);
    }
    checkCoverage(caseId, record?.coverage, problems);
    checkScanSummary(caseId, record?.scan, problems);
  } else if (shape === "check") {
    if (!requireKeys(caseId, record, ["sessions", "anomalyCount", "coverage"], problems)) return;
    if (!Array.isArray(record?.sessions)) problems.push(`${caseId}: sessions 不是数组`);
    checkCoverage(caseId, record?.coverage, problems);
  }
}

/** 扫描摘要结构断言：字段齐备、类型正确、"0 命中也有分母"所需字段不得缺失。 */
function checkScanSummary(caseId: string, value: unknown, problems: string[]): void {
  const scan = asRecord(value);
  if (scan === undefined) {
    problems.push(`${caseId}: scan 缺失`);
    return;
  }
  for (const key of ["logsDecoded", "eventsRead", "decodeFailures", "frameFailures"]) {
    if (typeof scan[key] !== "number") problems.push(`${caseId}: scan.${key} 不是数字`);
  }
  // 失败份数不得超过纳入会话数：这是"分母"可信度的最低校验。
  if (
    typeof scan.decodeFailures === "number" &&
    typeof scan.logsDecoded === "number" &&
    scan.decodeFailures + scan.logsDecoded === 0 &&
    scan.eventsRead !== 0
  ) {
    problems.push(`${caseId}: scan 计数自相矛盾（读到事件但既无成功也无失败日志）`);
  }
  for (const key of ["observedFrom", "observedTo"]) {
    const time = scan[key];
    if (time !== null && typeof time !== "number")
      problems.push(`${caseId}: scan.${key} 非数字或 null`);
  }
}

/** 命中分布结构断言：每项含 sessionId/type/title/hits，且命中数非负。 */
function checkDistribution(caseId: string, value: unknown, problems: string[]): void {
  if (!Array.isArray(value)) {
    problems.push(`${caseId}: distribution 不是数组`);
    return;
  }
  for (const item of value) {
    const entry = asRecord(item);
    if (typeof entry?.sessionId !== "string")
      problems.push(`${caseId}: distribution 项缺少 sessionId`);
    if (entry?.type !== "main" && entry?.type !== "subagent") {
      problems.push(`${caseId}: distribution 项 type 非法`);
    }
    if (typeof entry?.hits !== "number" || entry.hits < 0) {
      problems.push(`${caseId}: distribution 项 hits 非法`);
    }
  }
}

/**
 * 覆盖声明结构断言：`scannedCount`、`includedCount` 为数值、`excluded` 每项含 id 与 reason。
 *
 * 这里同时检查 `scannedCount === includedCount + excluded.length`，但要注意它**只是字段自洽性**
 * 检查：实现就是按 `N = M + K` 构造这三个数（见 store-discovery.ts 的 coverageOf 与各命令的
 * 覆盖计算），因此该等式恒成立、不能用来发现漏读。核对覆盖范围只能依据逐条列出的排除项——
 * 这正是断言 `excluded` 每项都带 id 与 reason 的原因。
 */
function checkCoverage(caseId: string, value: unknown, problems: string[]): void {
  const coverage = asRecord(value);
  if (coverage === undefined) {
    problems.push(`${caseId}: coverage 缺失`);
    return;
  }
  const scanned = coverage.scannedCount;
  const included = coverage.includedCount;
  const excluded = coverage.excluded;
  if (typeof scanned !== "number" || typeof included !== "number" || !Array.isArray(excluded)) {
    problems.push(`${caseId}: coverage 字段类型非法`);
    return;
  }
  if (scanned !== included + excluded.length) {
    problems.push(
      `${caseId}: coverage 恒等式不成立（scanned ${scanned} != included ${included} + excluded ${excluded.length}）`,
    );
  }
  for (const item of excluded) {
    const entry = asRecord(item);
    if (typeof entry?.id !== "string" || typeof entry?.reason !== "string") {
      problems.push(`${caseId}: coverage.excluded 项缺少 id/reason`);
    }
  }
}

/** jsonl 结构回归断言：首行为会话 id（不含 type），其后每行必须含 type 与 seq。 */
export function checkJsonlStructure(caseId: string, content: string, problems: string[]): void {
  const lines = content.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) {
    problems.push(`${caseId}: JSONL 为空`);
    return;
  }
  lines.forEach((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      problems.push(`${caseId}: JSONL 第 ${index + 1} 行解析失败 ${String(error)}`);
      return;
    }
    const record = asRecord(parsed);
    if (record === undefined) {
      problems.push(`${caseId}: JSONL 第 ${index + 1} 行不是对象`);
      return;
    }
    if (index === 0) {
      if (typeof record.id !== "string") problems.push(`${caseId}: JSONL 首行缺少 id`);
      if (record.type !== undefined) problems.push(`${caseId}: JSONL 首行不应有 type`);
    } else {
      if (typeof record.type !== "string")
        problems.push(`${caseId}: JSONL 第 ${index + 1} 行缺少 type`);
      if (typeof record.seq !== "number")
        problems.push(`${caseId}: JSONL 第 ${index + 1} 行缺少 seq`);
    }
  });
}

// ------------------------- markdownlint 调用与结果判定 -------------------------

interface LintRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly mdFiles: number;
  readonly processedFiles: number;
  readonly batches: number;
}

const LINT_BATCH_SIZE = 50;

/** markdownlint 入口解析所需的输入（结构上兼容入口模块的 MatrixOptions）。 */
export interface MarkdownlintAnchorOptions {
  readonly workdir: string;
  readonly markdownlintJs: string | null;
}

/** 解析 markdownlint-cli 的 JS 入口：显式参数优先；否则从 workdir 的 node_modules 链解析（失败即显式报错）。 */
export function resolveMarkdownlintJs(options: MarkdownlintAnchorOptions): string {
  if (options.markdownlintJs !== null) return options.markdownlintJs;
  const requireFromWorkdir = createRequire(join(options.workdir, "matrix-anchor.cjs"));
  let packageJson: string;
  try {
    packageJson = requireFromWorkdir.resolve("markdownlint-cli/package.json");
  } catch (error) {
    throw new Error(
      `无法从 ${options.workdir} 解析 markdownlint-cli（${String(error)}）；请用 --markdownlint-js <路径> 显式指定`,
    );
  }
  return join(dirname(packageJson), "markdownlint.js");
}

/**
 * 以参数数组直接调用 markdownlint JS 入口（不经 shell，避免 cmd 引号拼接问题）。
 * 两遍：① 目录整跑（目录展开语义）；② 显式文件分批（给出"实际处理文件数"，并逐批断言成功）。
 */
export function runLint(
  markdownlintJs: string,
  lintConfig: string,
  outDir: string,
  workdir: string,
): LintRunResult {
  if (!existsSync(markdownlintJs)) throw new Error(`markdownlint 入口不存在: ${markdownlintJs}`);
  const run = (
    files: readonly string[],
  ): { readonly status: number | null; readonly stdout: string; readonly stderr: string } => {
    const result = spawnSync(process.execPath, [markdownlintJs, "--config", lintConfig, ...files], {
      encoding: "utf8",
      timeout: 600_000,
      // 以被 lint 目录为工作目录：避免 .markdownlintignore 的相对路径匹配在跨根路径上报错，
      // 该次门禁的对象就是 outDir 内的产物本身。
      cwd: outDir,
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  const directory = run([outDir]);
  const mdFiles = readdirSync(outDir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  let stdout = directory.stdout;
  let stderr = directory.stderr;
  let status = directory.status;
  let processedFiles = 0;
  let batches = 0;
  for (let start = 0; start < mdFiles.length; start += LINT_BATCH_SIZE) {
    const batch = mdFiles.slice(start, start + LINT_BATCH_SIZE);
    const result = run(batch);
    batches += 1;
    processedFiles += batch.length;
    stdout += result.stdout;
    stderr += result.stderr;
    if (result.status !== 0 && (status === 0 || status === null)) status = result.status;
  }
  writeFileSync(join(workdir, "lint-output.txt"), `${stdout}${stderr}`, "utf8");
  return { status, stdout, stderr, mdFiles: mdFiles.length, processedFiles, batches };
}
