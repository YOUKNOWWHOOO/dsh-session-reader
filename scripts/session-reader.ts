// session-reader CLI 入口：选项表驱动的解析/校验/帮助/分派/输出落盘。
// 契约（方案 §2.4/§2.5/§3）：
// - 所有命令必须显式 --output-dir（缺省退出 2）；工具对该目录零假定；
// - 输出文件必须不存在（已存在拒绝）；唯一临时文件关闭后同卷原子移动；UTF-8 无 BOM；
// - stdout 固定两行（完整输出已保存到: <绝对路径> / <摘要>；输出文件共 N 行）；终端不显示正文；
// - stderr 只输出 `错误: <分类>`（分类全集见 §2.5；歧义目标附候选数）；
// - 退出码：0 成功、1 目标不存在、2 参数错误、3 数据/IO 错误。
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadCatalog, type SessionFormatCatalog } from "./lib/decode.ts";
import {
  countLines,
  defaultLibRoot,
  type IntegerRange,
  parseIntegerRange,
  parseTimeArg,
  type Result,
  randomOutputSuffix,
  resolveDshHome,
  resolveOutputFileName,
  validateOutputName,
} from "./lib/paths.ts";
import type { ShowMdOptions } from "./lib/render-core.ts";
import {
  renderCheckJson,
  renderListJson,
  renderSearchJson,
  renderShowJson,
  renderShowJsonl,
  renderStatsJson,
} from "./lib/render-json.ts";
import { renderCheckMd, renderListMd, renderSearchMd, renderStatsMd } from "./lib/render-md.ts";
import { renderShowMd } from "./lib/render-show-md.ts";
import { runCheck } from "./lib/store-check.ts";
import { discoverReadableSessions, prepareCatalogs } from "./lib/store-discovery.ts";
import { buildList } from "./lib/store-list.ts";
import { runSearch } from "./lib/store-search.ts";
import { runStats } from "./lib/store-stats.ts";
import { buildSessionNode, resolveSessionTarget } from "./lib/store-target.ts";
import type { ListFilters, ScopeFilters, StoreContext, StoreError } from "./lib/store-types.ts";

interface OptionSpec {
  readonly name: string;
  readonly alias?: string;
  readonly kind: "value" | "switch";
  readonly valueName?: string;
  readonly valueKind?: "string" | "integer" | "enum";
  readonly values?: readonly string[];
  readonly description: string;
  readonly defaultText?: string;
}

interface PositionalSpec {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
}

interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly positional: PositionalSpec | null;
  readonly options: readonly OptionSpec[];
}

const ORIGIN_VALUES = ["all", "main", "subagent"] as const;
const SORT_VALUES = ["time", "created", "title", "size", "turns"] as const;
const SCOPE_VALUES = ["text", "tools", "all"] as const;
const ROLE_VALUES = ["user", "assistant"] as const;

function commonOptions(formatValues: readonly string[]): OptionSpec[] {
  return [
    {
      name: "--dsh-home",
      kind: "value",
      valueName: "<路径>",
      valueKind: "string",
      description: "dsh 主目录（决定 sessions 根）",
      defaultText: "$DSH_HOME，否则 ~\\.dsh",
    },
    {
      name: "--lib-root",
      kind: "value",
      valueName: "<目录>",
      valueKind: "string",
      description: "官方格式库解析锚点（兼容覆盖）",
      defaultText: "按 dsh 安装锚点自动定位；无法唯一定位时用 --lib-root 覆盖",
    },
    {
      name: "--output-dir",
      kind: "value",
      valueName: "<目录>",
      valueKind: "string",
      description: "输出目录（必填；完全由使用方填写，工具不做校验）",
    },
    {
      name: "--name",
      kind: "value",
      valueName: "<basename>",
      valueKind: "string",
      description: "产物 basename（不含扩展名；给出时覆盖同名产物）",
    },
    {
      name: "--format",
      kind: "value",
      valueName: `<${formatValues.join("|")}>`,
      valueKind: "enum",
      values: formatValues,
      description: "输出格式",
      defaultText: "md",
    },
    { name: "--help", alias: "-h", kind: "switch", description: "显示帮助" },
  ];
}

const WORKSPACE_OPTION: OptionSpec = {
  name: "--workspace",
  kind: "value",
  valueName: "<路径|标题>",
  valueKind: "string",
  description: "工作区过滤（路径归一化精确匹配或标题精确匹配）",
};
const SINCE_OPTION: OptionSpec = {
  name: "--since",
  kind: "value",
  valueName: "<时间>",
  valueKind: "string",
  description: "最近活动时间下界（UTC；毫秒数或严格 ISO）",
};
const UNTIL_OPTION: OptionSpec = {
  name: "--until",
  kind: "value",
  valueName: "<时间>",
  valueKind: "string",
  description: "最近活动时间上界（UTC；毫秒数或严格 ISO）",
};
const ORIGIN_OPTION: OptionSpec = {
  name: "--origin",
  kind: "value",
  valueName: "<all|main|subagent>",
  valueKind: "enum",
  values: ORIGIN_VALUES,
  description: "会话类型过滤",
  defaultText: "all",
};

/** 全部子命令定义（选项表是解析、校验、帮助的单一真值源）。 */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "list",
    summary: "列出会话",
    positional: null,
    options: [
      ...commonOptions(["md", "json"]),
      WORKSPACE_OPTION,
      SINCE_OPTION,
      UNTIL_OPTION,
      {
        name: "--title",
        kind: "value",
        valueName: "<关键词>",
        valueKind: "string",
        description: "标题子串过滤（不区分大小写）",
      },
      ORIGIN_OPTION,
      { name: "--include-blank", kind: "switch", description: "包含空会话（默认隐藏）" },
      {
        name: "--limit",
        kind: "value",
        valueName: "<N>",
        valueKind: "integer",
        description: "最多显示条数（0=不限）",
        defaultText: "100",
      },
      {
        name: "--sort",
        kind: "value",
        valueName: "<time|created|title|size|turns>",
        valueKind: "enum",
        values: SORT_VALUES,
        description: "排序键（time/created/size/turns 降序；title 升序）",
        defaultText: "time",
      },
      {
        name: "--full",
        kind: "switch",
        description: "逐会话块列出全部字段（替代精简表格；仅 md）",
      },
    ],
  },
  {
    name: "show",
    summary: "读取并导出单个会话",
    positional: {
      name: "<会话标识>",
      required: true,
      description: "完整 id／唯一前缀（大小写不敏感，session- 计入，最短 8 字符）／last",
    },
    options: [
      ...commonOptions(["md", "json", "jsonl"]),
      {
        name: "--summary",
        kind: "switch",
        description: "仅摘要（头部+统计+轮次大纲；jsonl 禁止）",
      },
      {
        name: "--role",
        kind: "value",
        valueName: `<${ROLE_VALUES.join("|")}>`,
        valueKind: "enum",
        values: ROLE_VALUES,
        description: "仅显示指定角色（仅 md）",
      },
      { name: "--thinking", kind: "switch", description: "显示推理内容（仅 md；默认隐藏）" },
      { name: "--tools", kind: "switch", description: "显示工具调用与结果（仅 md；默认隐藏）" },
      { name: "--events", kind: "switch", description: "显示生命周期事件（仅 md；默认隐藏）" },
      { name: "--subagents", kind: "switch", description: "追加导出子代理会话（jsonl 禁止）" },
      { name: "--headers", kind: "switch", description: "显示每条消息的 seq 与时间（仅 md）" },
      {
        name: "--truncate",
        kind: "value",
        valueName: "<N>",
        valueKind: "integer",
        description: "文本截断字符数（0=不截断；仅 md）",
        defaultText: "0",
      },
      {
        name: "--turn",
        kind: "value",
        valueName: "<A-B|A>",
        valueKind: "string",
        description: "只呈现指定 turn 区间（含端点；仅 md）",
      },
      {
        name: "--seq",
        kind: "value",
        valueName: "<A-B|A>",
        valueKind: "string",
        description: "只呈现指定 seq 区间（含端点；仅 md）",
      },
      {
        name: "--head",
        kind: "value",
        valueName: "<N>",
        valueKind: "integer",
        description: "只呈现根块筛选后的首 N 条时间线条目（0=不限；仅 md）",
      },
      {
        name: "--tail",
        kind: "value",
        valueName: "<N>",
        valueKind: "integer",
        description: "只呈现根块筛选后的末 N 条时间线条目（0=不限；仅 md）",
      },
      {
        name: "--probe",
        kind: "switch",
        description: "只给规模摘要（轮次/消息数/预计字节数），不落正文（仅 md）",
      },
    ],
  },
  {
    name: "search",
    summary: "跨会话内容检索",
    positional: { name: "<关键词>", required: true, description: "检索关键词（必填非空）" },
    options: [
      ...commonOptions(["md", "json"]),
      {
        name: "--scope",
        kind: "value",
        valueName: `<${SCOPE_VALUES.join("|")}>`,
        valueKind: "enum",
        values: SCOPE_VALUES,
        description:
          "检索范围（text=用户/助手正文；tools=另含工具参数与结果；all=另含推理/系统/压缩/命令/标题请求/web 请求/交付物/待办/代理信箱与每条事件载荷）",
        defaultText: "text",
      },
      { name: "--case-sensitive", kind: "switch", description: "区分大小写（默认不区分）" },
      {
        name: "--context",
        kind: "value",
        valueName: "<N>",
        valueKind: "integer",
        description: "命中处两侧上下文字符数",
        defaultText: "60",
      },
      {
        name: "--limit",
        kind: "value",
        valueName: "<N>",
        valueKind: "integer",
        description: "命中显示上限（0=不限；末行汇总始终为全量总命中数）",
        defaultText: "100",
      },
      {
        name: "--session",
        kind: "value",
        valueName: "<会话标识>",
        valueKind: "string",
        description: "只检索该会话及其子代理子树（与 show 目标同语法）",
      },
      {
        name: "--exclude-session",
        kind: "value",
        valueName: "<会话标识>",
        valueKind: "string",
        description: "排除该会话及其子代理子树（用于剔除调用方自己的语料；与 show 目标同语法）",
      },
      WORKSPACE_OPTION,
      SINCE_OPTION,
      UNTIL_OPTION,
      ORIGIN_OPTION,
    ],
  },
  {
    name: "stats",
    summary: "统计（全局聚合或单会话）",
    positional: {
      name: "[<会话标识>]",
      required: false,
      description: "缺省=全局聚合；提供时=单会话统计",
    },
    options: [
      ...commonOptions(["md", "json"]),
      WORKSPACE_OPTION,
      SINCE_OPTION,
      UNTIL_OPTION,
      ORIGIN_OPTION,
    ],
  },
  {
    name: "check",
    summary: "完整性校验（结构扫描/行/seq/坏行）",
    positional: {
      name: "[<会话标识>]",
      required: false,
      description: "缺省=全部会话；提供时=单会话",
    },
    options: [...commonOptions(["md", "json"])],
  },
];

/** 解析后的命令行。 */
export interface ParsedCommand {
  readonly command: string;
  readonly options: ReadonlyMap<string, string | boolean>;
  readonly positional: readonly string[];
}

/** 解析结果：帮助 / 已解析 / 参数错误。 */
export type ParseResult =
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "parsed"; readonly value: ParsedCommand }
  | { readonly kind: "error"; readonly message: string };

function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}

function findOption(command: CommandSpec, name: string): OptionSpec | undefined {
  return command.options.find((option) => option.name === name || option.alias === name);
}

function formatOptionLine(spec: OptionSpec): string {
  const flags = spec.alias === undefined ? spec.name : `${spec.alias}, ${spec.name}`;
  const valuePart = spec.kind === "value" ? ` ${spec.valueName ?? "<值>"}` : "";
  const defaultPart = spec.defaultText === undefined ? "" : `（默认: ${spec.defaultText}）`;
  return `  ${(flags + valuePart).padEnd(34)} ${spec.description}${defaultPart}`;
}

/** 构建子命令帮助文本（与选项表同源）。 */
export function buildCommandHelp(command: CommandSpec): string {
  const usage =
    command.positional === null
      ? `node session-reader.ts ${command.name} [选项]`
      : `node session-reader.ts ${command.name} ${command.positional.name} [选项]`;
  const lines = [`用法: ${usage}`, "", command.summary, ""];
  if (command.positional !== null) {
    lines.push("参数:");
    lines.push(`  ${command.positional.name.padEnd(20)} ${command.positional.description}`);
    lines.push("");
  }
  lines.push("选项:");
  for (const option of command.options) lines.push(formatOptionLine(option));
  lines.push("");
  lines.push("选项终止符：`--` 之后的所有 token 一律作为位置参数（用于以 `-` 开头的关键词等）。");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/** 构建总帮助文本。 */
export function buildGeneralHelp(): string {
  const lines = [
    "用法: node session-reader.ts <命令> [选项]",
    "",
    "列出/读取/检索/统计/校验 dsh 会话历史（离线、只读、无模型调用）。",
    "",
    "命令:",
  ];
  for (const command of COMMANDS) {
    const positional = command.positional === null ? "" : ` ${command.positional.name}`;
    lines.push(`  ${`${command.name}${positional}`.padEnd(20)} ${command.summary}`);
  }
  lines.push("");
  lines.push("所有命令都必须显式指定 --output-dir（工具不提供默认输出位置）。");
  lines.push("默认参数组合：仅需『命令 + 目标（如有） + --output-dir』；其余选项均有默认值。");
  lines.push("选项终止符：`--` 之后的所有 token 一律作为位置参数（用于以 `-` 开头的关键词等）。");
  lines.push("用 `<命令> --help` 查看某命令的全部选项。");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function validateOptionValue(spec: OptionSpec, value: string): string | null {
  if (spec.valueKind === "enum") {
    if (spec.values === undefined || !spec.values.includes(value)) {
      return `选项值无效: ${spec.name}`;
    }
    return null;
  }
  if (spec.valueKind === "integer") {
    if (!/^\d+$/u.test(value)) return `选项值必须是整数: ${spec.name}`;
    if (!Number.isSafeInteger(Number(value))) return `选项值超出范围: ${spec.name}`;
    return null;
  }
  return null;
}

/** 解析 argv（不含 node/脚本路径）；帮助优先于其它校验；`--` 为选项终止符（其后 token 一律作为位置参数）。 */
export function parseCommandLine(argv: readonly string[]): ParseResult {
  const first = argv[0];
  if (first === undefined) return { kind: "error", message: "缺少子命令" };
  if (first === "-h" || first === "--help") return { kind: "help", text: buildGeneralHelp() };
  if (first.startsWith("-")) return { kind: "error", message: `未知选项: ${first}` };
  const command = findCommand(first);
  if (command === undefined) return { kind: "error", message: `未知子命令: ${first}` };
  const rest = argv.slice(1);
  // 帮助识别只扫描选项终止符之前的 token：`search -- --help` 中 "--help" 是关键词而非帮助请求。
  const terminatorAt = rest.indexOf("--");
  const helpScope = terminatorAt === -1 ? rest : rest.slice(0, terminatorAt);
  if (helpScope.includes("-h") || helpScope.includes("--help")) {
    return { kind: "help", text: buildCommandHelp(command) };
  }
  const options = new Map<string, string | boolean>();
  const positional: string[] = [];
  let positionalOnly = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!positionalOnly && token === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && token.startsWith("--")) {
      const equalsAt = token.indexOf("=");
      const name = equalsAt === -1 ? token : token.slice(0, equalsAt);
      const inlineValue = equalsAt === -1 ? undefined : token.slice(equalsAt + 1);
      const spec = findOption(command, name);
      if (spec === undefined) return { kind: "error", message: `未知选项: ${name}` };
      if (options.has(spec.name)) return { kind: "error", message: `重复选项: ${name}` };
      if (spec.kind === "switch") {
        if (inlineValue !== undefined)
          return { kind: "error", message: `开关选项不接受值: ${name}` };
        options.set(spec.name, true);
      } else {
        let value = inlineValue;
        if (value === undefined) {
          const next = rest[index + 1];
          if (next === undefined) return { kind: "error", message: `选项缺少值: ${name}` };
          value = next;
          index += 1;
        }
        if (value.length === 0) return { kind: "error", message: `选项值为空: ${name}` };
        const invalid = validateOptionValue(spec, value);
        if (invalid !== null) return { kind: "error", message: invalid };
        options.set(spec.name, value);
      }
    } else if (!positionalOnly && token.startsWith("-")) {
      return { kind: "error", message: `未知选项: ${token}` };
    } else {
      positional.push(token);
    }
  }
  if (command.positional === null) {
    if (positional.length > 0) return { kind: "error", message: "该命令不接受位置参数" };
  } else {
    if (command.positional.required && positional.length === 0) {
      return { kind: "error", message: `缺少位置参数: ${command.positional.name}` };
    }
    if (positional.length > 1) return { kind: "error", message: "位置参数过多" };
  }
  return { kind: "parsed", value: { command: command.name, options, positional } };
}

// ------------------------- 命令执行 -------------------------

interface RunFailure {
  readonly classification: string;
  readonly exitCode: number;
  /** 歧义目标的候选数（与 detail 互斥；优先渲染）。 */
  readonly candidates?: number;
  /** 分类后的括号说明：冲突选项名、缺失的必填选项，或调用方自身提供的子命令位/选项位 token。 */
  readonly detail?: string;
}

type RunOutcome =
  | {
      readonly kind: "rendered";
      readonly content: string;
      readonly summary: string;
      readonly exitCode: number;
    }
  | { readonly kind: "failure"; readonly failure: RunFailure };

function failure(classification: string, exitCode: number, detail?: string): RunOutcome {
  return detail === undefined
    ? { kind: "failure", failure: { classification, exitCode } }
    : { kind: "failure", failure: { classification, exitCode, detail } };
}

function mapStoreError(error: StoreError): RunFailure {
  // 只有 argument-invalid 的 detail 是固定模板（无路径、无会话 ID、无用户名），可安全外显；
  // target-missing/data-unreadable 的 detail 含会话目录名或绝对路径，按 CLI 契约不得进入 stderr。
  if (error.category === "argument-invalid") {
    return error.detail === undefined
      ? { classification: "参数无效", exitCode: 2 }
      : { classification: "参数无效", exitCode: 2, detail: error.detail };
  }
  if (error.category === "target-missing") return { classification: "目标不存在", exitCode: 1 };
  if (error.category === "ambiguous") {
    return { classification: "目标不存在", exitCode: 1, candidates: error.candidates ?? 0 };
  }
  if (error.category === "data-unreadable") return { classification: "数据不可读", exitCode: 3 };
  return { classification: "内部错误", exitCode: 3 };
}

function optionValue(parsed: ParsedCommand, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function optionSwitch(parsed: ParsedCommand, name: string): boolean {
  return parsed.options.get(name) === true;
}

function optionInteger(parsed: ParsedCommand, name: string, fallback: number): number {
  const value = optionValue(parsed, name);
  return value === undefined ? fallback : Number(value);
}

/**
 * 读取区间选项；取值合法性已由 `validateCommandOptions` 前置校验，此处读取失败仅可能来自内部调用顺序错误，
 * 因此返回 null（不筛选）并保持"不做二次猜测"的单一职责。
 */
function readRange(parsed: ParsedCommand, name: string, minimum: number): IntegerRange | null {
  const raw = optionValue(parsed, name);
  if (raw === undefined) return null;
  const parsedRange = parseIntegerRange(raw, minimum, name);
  return parsedRange.success ? parsedRange.data : null;
}

interface TimeBounds {
  readonly since: number | undefined;
  readonly until: number | undefined;
}

const TIME_FORMAT_HINT = "取值应为毫秒数或 ISO 时间（如 2026-09-15 或 2026-09-15T21:30:00Z）";

/**
 * 读取时间上/下界。
 *
 * 解析失败必须给出**哪个选项**与**合法格式**：`parseTimeArg` 的返回值是固定模板（只含"月份超出范围"
 * 一类诊断，不含调用方数据），因此可安全外显；丢弃它会让调用方只看到裸的"参数无效"而无从修正。
 */
function readTimeBounds(parsed: ParsedCommand): Result<TimeBounds, string> {
  const sinceRaw = optionValue(parsed, "--since");
  const untilRaw = optionValue(parsed, "--until");
  let since: number | undefined;
  let until: number | undefined;
  if (sinceRaw !== undefined) {
    const parsedTime = parseTimeArg(sinceRaw);
    if (!parsedTime.success)
      return { success: false, error: `--since ${parsedTime.error}；${TIME_FORMAT_HINT}` };
    since = parsedTime.data;
  }
  if (untilRaw !== undefined) {
    const parsedTime = parseTimeArg(untilRaw);
    if (!parsedTime.success)
      return { success: false, error: `--until ${parsedTime.error}；${TIME_FORMAT_HINT}` };
    until = parsedTime.data;
  }
  return { success: true, data: { since, until } };
}

function readOrigin(parsed: ParsedCommand): "all" | "main" | "subagent" {
  const value = optionValue(parsed, "--origin");
  if (value === "main") return "main";
  if (value === "subagent") return "subagent";
  return "all";
}

function readScopeFilters(parsed: ParsedCommand): Result<ScopeFilters, string> {
  const bounds = readTimeBounds(parsed);
  if (!bounds.success) return bounds;
  return {
    success: true,
    data: {
      workspace: optionValue(parsed, "--workspace"),
      since: bounds.data.since,
      until: bounds.data.until,
      origin: readOrigin(parsed),
    },
  };
}

/**
 * 校验命令级选项组合：`--name` 取值；呈现类开关仅 md；内容范围开关 jsonl 禁止；stats 单会话不接受范围过滤。
 * 其中只有组合冲突分支需要给出合法替代写法（调用方只有一次调用机会，禁止只报冲突不报出路）；
 * 取值诊断分支（`--name`、`--turn`、`--seq` 等）按规范只说明合法格式，不提供替代写法。
 */
export function validateCommandOptions(parsed: ParsedCommand): RunFailure | null {
  const outputName = optionValue(parsed, "--name");
  if (outputName !== undefined) {
    const nameError = validateOutputName(outputName);
    if (nameError !== null) {
      return { classification: "参数无效", exitCode: 2, detail: nameError };
    }
  }
  if (parsed.command === "stats") {
    const rangeFilters = ["--workspace", "--since", "--until", "--origin"];
    const present = rangeFilters.filter((name) => parsed.options.has(name));
    if (parsed.positional.length > 0 && present.length > 0) {
      return {
        classification: "参数无效",
        exitCode: 2,
        detail: `单会话统计不接受范围过滤选项 ${present.join("、")}；去掉 ${present.join("、")}，或去掉会话目标改用全局聚合`,
      };
    }
    return null;
  }
  if (parsed.command !== "show") return null;
  const format = optionValue(parsed, "--format") ?? "md";
  const presentation = [
    "--role",
    "--thinking",
    "--tools",
    "--events",
    "--headers",
    "--truncate",
    "--turn",
    "--seq",
    "--head",
    "--tail",
    "--probe",
  ];
  const presentPresentation = presentation.filter((name) => parsed.options.has(name));
  if (format !== "md" && presentPresentation.length > 0) {
    return {
      classification: "参数无效",
      exitCode: 2,
      detail: `呈现类开关 ${presentPresentation.join("、")} 仅 md 可用；去掉 ${presentPresentation.join("、")}，或把 --format 改为 md`,
    };
  }
  const scopeSwitches = ["--summary", "--subagents"];
  const presentScope = scopeSwitches.filter((name) => parsed.options.has(name));
  if (format === "jsonl" && presentScope.length > 0) {
    return {
      classification: "参数无效",
      exitCode: 2,
      detail: `${presentScope.join("、")} 不能与 --format jsonl 同时使用；去掉 ${presentScope.join("、")}，或把 --format 改为 json`,
    };
  }
  const rangeOptions = ["--turn", "--seq", "--head", "--tail"];
  const presentRange = rangeOptions.filter((name) => parsed.options.has(name));
  if (parsed.options.has("--head") && parsed.options.has("--tail")) {
    return {
      classification: "参数无效",
      exitCode: 2,
      detail: "--head 与 --tail 不能同时使用；只保留其中一个",
    };
  }
  // --probe 与 --subagents 互斥：探测的意义是"读之前先问规模"，而 --subagents 会把产物扩展到整棵
  // 子代理树（每棵子树各自是一份正文），两者同用既非探测也非导出。其余呈现类开关与范围开关**允许**
  // 与 --probe 同用：探测会按同一组开关渲染一份副本并据实报告字节数，因此调用方可以用
  // `--probe --events --truncate 500` 这样的组合量出"带这些选项的完整导出有多大"，正是本能力的用途。
  if (parsed.options.has("--probe") && parsed.options.has("--subagents")) {
    return {
      classification: "参数无效",
      exitCode: 2,
      detail: "--probe 只给规模摘要，与 --subagents 不能同时使用；去掉 --subagents，或去掉 --probe",
    };
  }
  if (presentRange.length === 0) return null;
  // --summary 呈现的是整会话轮次大纲，区间选择对其无意义：静默忽略会掩盖调用方意图，故显式拒绝。
  if (parsed.options.has("--summary")) {
    return {
      classification: "参数无效",
      exitCode: 2,
      detail: `--summary 与 ${presentRange.join("、")} 不能同时使用；去掉 ${presentRange.join("、")}，或去掉 --summary`,
    };
  }
  const turnRaw = optionValue(parsed, "--turn");
  if (turnRaw !== undefined) {
    const parsedTurn = parseIntegerRange(turnRaw, 1, "--turn");
    if (!parsedTurn.success) {
      return {
        classification: "参数无效",
        exitCode: 2,
        detail: "--turn 取值应为 <A-B> 或 <A>（正整数，B 不小于 A）",
      };
    }
  }
  const seqRaw = optionValue(parsed, "--seq");
  if (seqRaw !== undefined) {
    const parsedSeq = parseIntegerRange(seqRaw, 0, "--seq");
    if (!parsedSeq.success) {
      return {
        classification: "参数无效",
        exitCode: 2,
        detail: "--seq 取值应为 <A-B> 或 <A>（非负整数，B 不小于 A）",
      };
    }
  }
  return null;
}

function renderList(parsed: ParsedCommand, ctx: StoreContext, format: "md" | "json"): RunOutcome {
  const bounds = readTimeBounds(parsed);
  if (!bounds.success) return failure("参数无效", 2, bounds.error);
  const filters: ListFilters = {
    workspace: optionValue(parsed, "--workspace"),
    since: bounds.data.since,
    until: bounds.data.until,
    title: optionValue(parsed, "--title"),
    origin: readOrigin(parsed),
    includeBlank: optionSwitch(parsed, "--include-blank"),
    limit: optionInteger(parsed, "--limit", 100),
    sort: ((): ListFilters["sort"] => {
      const value = optionValue(parsed, "--sort");
      if (value === "created" || value === "title" || value === "size" || value === "turns")
        return value;
      return "time";
    })(),
  };
  const outcome = buildList(ctx, filters);
  if (!outcome.success) {
    const mapped = mapStoreError(outcome.error);
    return { kind: "failure", failure: mapped };
  }
  const rendered =
    format === "json"
      ? renderListJson(outcome.data)
      : renderListMd(outcome.data, { full: optionSwitch(parsed, "--full") });
  return { kind: "rendered", content: rendered.content, summary: rendered.summary, exitCode: 0 };
}

function renderShow(
  parsed: ParsedCommand,
  ctx: StoreContext,
  format: "md" | "json" | "jsonl",
): RunOutcome {
  const target = parsed.positional[0];
  if (target === undefined) return failure("参数无效", 2);
  const resolved = resolveSessionTarget(ctx, target);
  if (!resolved.success) return { kind: "failure", failure: mapStoreError(resolved.error) };
  const includeSubagents = optionSwitch(parsed, "--subagents");
  let allEntries: Awaited<ReturnType<typeof discoverReadableSessions>> | null = null;
  if (includeSubagents) {
    allEntries = discoverReadableSessions(ctx.dshHome, ctx.catalog);
    if (!allEntries.success) return { kind: "failure", failure: mapStoreError(allEntries.error) };
  }
  const node = buildSessionNode(
    ctx,
    resolved.data,
    allEntries === null ? [] : allEntries.data.entries,
    new Set(),
  );
  if (!node.success) return { kind: "failure", failure: mapStoreError(node.error) };
  // header 不可读的会话既取不到逻辑 id，也无从取得 parentSession，因此无法判定它是否属于本目标子树：
  // 它不能进 `coverage.excluded`（那会污染 N/M/K 恒等式的含义），只能作为「归属未知」显式声明。
  const unattributable =
    allEntries === null
      ? []
      : allEntries.data.skipped.map((skipped) => ({
          id: skipped.idFromDir,
          reason: skipped.error,
        }));
  const summaryFlag = optionSwitch(parsed, "--summary");
  if (format === "jsonl") {
    const rendered = renderShowJsonl(node.data);
    return { kind: "rendered", content: rendered.content, summary: rendered.summary, exitCode: 0 };
  }
  if (format === "json") {
    const rendered = renderShowJson(node.data, {
      summary: summaryFlag,
      subagents: includeSubagents,
      unattributable,
    });
    return { kind: "rendered", content: rendered.content, summary: rendered.summary, exitCode: 0 };
  }
  const roleValue = optionValue(parsed, "--role");
  const showOptions: ShowMdOptions = {
    summary: summaryFlag,
    role: roleValue === "user" || roleValue === "assistant" ? roleValue : null,
    thinking: optionSwitch(parsed, "--thinking"),
    tools: optionSwitch(parsed, "--tools"),
    events: optionSwitch(parsed, "--events"),
    headers: optionSwitch(parsed, "--headers"),
    truncate: optionInteger(parsed, "--truncate", 0),
    subagents: includeSubagents,
    unattributable,
    probe: optionSwitch(parsed, "--probe"),
    turnRange: readRange(parsed, "--turn", 1),
    seqRange: readRange(parsed, "--seq", 0),
    head: optionInteger(parsed, "--head", 0),
    tail: optionInteger(parsed, "--tail", 0),
  };
  const rendered = renderShowMd(node.data, showOptions);
  return { kind: "rendered", content: rendered.content, summary: rendered.summary, exitCode: 0 };
}

function renderSearch(parsed: ParsedCommand, ctx: StoreContext, format: "md" | "json"): RunOutcome {
  const keyword = parsed.positional[0];
  if (keyword === undefined || keyword.length === 0) return failure("参数无效", 2);
  const scopeFilters = readScopeFilters(parsed);
  if (!scopeFilters.success) return failure("参数无效", 2, scopeFilters.error);
  const scopeValue = optionValue(parsed, "--scope");
  const outcome = runSearch(
    ctx,
    keyword,
    scopeFilters.data,
    {
      scope: scopeValue === "tools" || scopeValue === "all" ? scopeValue : "text",
      caseSensitive: optionSwitch(parsed, "--case-sensitive"),
      context: optionInteger(parsed, "--context", 60),
      limit: optionInteger(parsed, "--limit", 100),
    },
    optionValue(parsed, "--session"),
    optionValue(parsed, "--exclude-session"),
  );
  if (!outcome.success) return { kind: "failure", failure: mapStoreError(outcome.error) };
  const rendered =
    format === "json" ? renderSearchJson(outcome.data) : renderSearchMd(outcome.data);
  return { kind: "rendered", content: rendered.content, summary: rendered.summary, exitCode: 0 };
}

function renderStats(parsed: ParsedCommand, ctx: StoreContext, format: "md" | "json"): RunOutcome {
  const scopeFilters = readScopeFilters(parsed);
  if (!scopeFilters.success) return failure("参数无效", 2, scopeFilters.error);
  const outcome = runStats(ctx, parsed.positional[0], scopeFilters.data);
  if (!outcome.success) return { kind: "failure", failure: mapStoreError(outcome.error) };
  if (format === "json") {
    const rendered = renderStatsJson(outcome.data);
    return { kind: "rendered", content: rendered.content, summary: rendered.summary, exitCode: 0 };
  }
  const rendered = renderStatsMd(outcome.data);
  return { kind: "rendered", content: rendered.content, summary: rendered.summary, exitCode: 0 };
}

function renderCheck(parsed: ParsedCommand, ctx: StoreContext, format: "md" | "json"): RunOutcome {
  const outcome = runCheck(ctx, parsed.positional[0]);
  if (!outcome.success) return { kind: "failure", failure: mapStoreError(outcome.error) };
  const rendered = format === "json" ? renderCheckJson(outcome.data) : renderCheckMd(outcome.data);
  return {
    kind: "rendered",
    content: rendered.content,
    summary: rendered.summary,
    exitCode: outcome.data.anomalyCount > 0 ? 3 : 0,
  };
}

function dispatchCommand(
  parsed: ParsedCommand,
  ctx: StoreContext,
  format: "md" | "json" | "jsonl",
): RunOutcome {
  if (parsed.command === "list") return renderList(parsed, ctx, format === "json" ? "json" : "md");
  if (parsed.command === "show") return renderShow(parsed, ctx, format);
  if (parsed.command === "search")
    return renderSearch(parsed, ctx, format === "json" ? "json" : "md");
  if (parsed.command === "stats")
    return renderStats(parsed, ctx, format === "json" ? "json" : "md");
  return renderCheck(parsed, ctx, format === "json" ? "json" : "md");
}

// ------------------------- 输出落盘 -------------------------

interface WriteSuccess {
  readonly path: string;
  readonly lines: number;
}

function removeFileIfExists(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    // 清理失败无输出通道（stderr 被错误分类契约占用）；不影响主错误分类。
    return false;
  }
}

/**
 * 输出协议：目录不存在则创建；写入唯一临时文件后同卷原子移动。
 *
 * 覆盖语义由 `overwrite` 决定，二者都不是"竞争窗口内的侥幸"，而是明确的契约：
 * - `overwrite=false`（未给 `--name`）：目标文件必须不存在，已存在即拒绝（退出 2）且不得改动原文件。
 *   命名唯一性（UTC 毫秒时间戳 + 随机 6 位后缀）使该拒绝在实践中只可能由调用方手工放同名文件触发。
 * - `overwrite=true`（给出 `--name`）：允许替换调用方自己指定的那一个路径。
 *   Windows 的 `renameSync` 走 `MOVEFILE_REPLACE_EXISTING`，替换是原子的：任何时刻目标文件要么是
 *   旧内容、要么是新内容，不会出现半截文件。覆盖范围严格限于 `<output-dir>/<name>.<ext>`。
 *
 * 失败返回错误分类（输出文件已存在→2；目录创建/写入/移动失败→3）。
 * 导出以便测试直接覆盖"已存在拒绝/原子提交/覆盖提交"路径。
 */
export function writeOutputFile(
  outputDir: string,
  fileName: string,
  content: string,
  overwrite: boolean,
):
  | { readonly ok: true; readonly value: WriteSuccess }
  | { readonly ok: false; readonly failure: RunFailure } {
  try {
    mkdirSync(outputDir, { recursive: true });
  } catch {
    return { ok: false, failure: { classification: "输出目录创建失败", exitCode: 3 } };
  }
  const targetPath = resolve(outputDir, fileName);
  if (!overwrite && existsSync(targetPath)) {
    return { ok: false, failure: { classification: "输出文件已存在", exitCode: 2 } };
  }
  const tempPath = resolve(outputDir, `.${fileName}.${randomOutputSuffix()}.tmp`);
  let handle: number;
  try {
    handle = openSync(tempPath, "wx");
  } catch {
    return { ok: false, failure: { classification: "输出写入失败", exitCode: 3 } };
  }
  try {
    writeSync(handle, content, null, "utf8");
    closeSync(handle);
  } catch {
    removeFileIfExists(tempPath);
    return { ok: false, failure: { classification: "输出写入失败", exitCode: 3 } };
  }
  try {
    renameSync(tempPath, targetPath);
  } catch {
    removeFileIfExists(tempPath);
    return { ok: false, failure: { classification: "输出移动失败", exitCode: 3 } };
  }
  return { ok: true, value: { path: targetPath, lines: countLines(content) } };
}

// ------------------------- 主流程 -------------------------

function printFailure(failureValue: RunFailure): void {
  const suffix =
    failureValue.candidates !== undefined
      ? `（候选 ${failureValue.candidates} 个）`
      : failureValue.detail === undefined
        ? ""
        : `（${failureValue.detail}）`;
  process.stderr.write(`错误: ${failureValue.classification}${suffix}\n`);
}

async function runParsedCommand(parsed: ParsedCommand): Promise<RunOutcome> {
  const commandSpec = findCommand(parsed.command);
  if (commandSpec === undefined) return failure("内部错误", 3);
  const combinationFailure = validateCommandOptions(parsed);
  if (combinationFailure !== null) return { kind: "failure", failure: combinationFailure };
  const outputDir = optionValue(parsed, "--output-dir");
  if (outputDir === undefined) return failure("参数无效", 2, "缺少 --output-dir");
  const dshHome = resolveDshHome(optionValue(parsed, "--dsh-home"), process.env, homedir());
  if (!existsSync(dshHome)) return failure("目标不存在", 1);
  const libRootOption = optionValue(parsed, "--lib-root");
  const libRoot = libRootOption ?? defaultLibRoot(dshHome);
  if (libRoot === undefined)
    return failure(
      "内部错误",
      3,
      "找不到官方格式库：默认锚点处（安装树的 @deepseek-ai 作用域目录）未能唯一确定，请用 --lib-root <目录> 指定含 @deepseek-ai 的 node_modules 目录",
    );
  const catalogResult = await loadCatalog(libRoot);
  if (!catalogResult.success)
    return failure("内部错误", 3, `官方格式库加载失败，解析锚点为 ${libRoot}`);
  const catalog: SessionFormatCatalog = catalogResult.data;
  const prepared =
    parsed.command === "list" || parsed.command === "check"
      ? {
          success: true as const,
          data: {
            catalogsBySessionId: new Map<string, SessionFormatCatalog>(),
            historicalChildFailuresBySessionId: new Map<string, readonly string[]>(),
          },
        }
      : prepareCatalogs(dshHome, catalog);
  if (!prepared.success) return { kind: "failure", failure: mapStoreError(prepared.error) };
  const ctx: StoreContext = {
    dshHome,
    catalog,
    catalogsBySessionId: prepared.data.catalogsBySessionId,
    historicalChildFailuresBySessionId: prepared.data.historicalChildFailuresBySessionId,
  };
  const formatRaw = optionValue(parsed, "--format") ?? "md";
  const format = formatRaw === "json" ? "json" : formatRaw === "jsonl" ? "jsonl" : "md";
  const outcome = dispatchCommand(parsed, ctx, format);
  if (outcome.kind === "failure") return outcome;
  const outputName = optionValue(parsed, "--name");
  const fileName = resolveOutputFileName(
    parsed.command,
    format,
    outputName,
    new Date(),
    randomOutputSuffix(),
  );
  const writeResult = writeOutputFile(
    outputDir,
    fileName,
    outcome.content,
    outputName !== undefined,
  );
  if (!writeResult.ok) return { kind: "failure", failure: writeResult.failure };
  process.stdout.write(`完整输出已保存到: ${writeResult.value.path}\n`);
  process.stdout.write(`${outcome.summary}；输出文件共 ${writeResult.value.lines} 行\n`);
  return outcome;
}

/** CLI 主入口：返回退出码。 */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseCommandLine(argv);
  if (parsed.kind === "help") {
    process.stdout.write(parsed.text);
    return 0;
  }
  if (parsed.kind === "error") {
    printFailure({ classification: "参数无效", exitCode: 2, detail: parsed.message });
    return 2;
  }
  try {
    const outcome = await runParsedCommand(parsed.value);
    if (outcome.kind === "failure") {
      printFailure(outcome.failure);
      return outcome.failure.exitCode;
    }
    return outcome.exitCode;
  } catch {
    printFailure({ classification: "内部错误", exitCode: 3 });
    return 3;
  }
}

const executedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (executedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
