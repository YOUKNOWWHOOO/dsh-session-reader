// 路径、时间与输出命名工具：DSH_HOME 解析、sessions 根、lib 锚点、时间解析/格式化、路径归一化、
// 输出文件名（时间戳命名与调用方指定的 basename）、`--name` 与区间参数校验。
// 本模块不依赖其它 lib 模块（最底层），Result 类型在此定义并被其它模块复用。
import { randomInt } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 统一的 Result 风格错误返回；error 为内部诊断文本，绝不直接输出到 stderr。 */
export type Result<T, E = string> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: E };

/** 依据优先级解析 dsh 主目录：显式参数 > 环境变量 DSH_HOME > <用户主目录>\.dsh。 */
export function resolveDshHome(
  cliValue: string | undefined,
  env: { readonly DSH_HOME?: string },
  homeDirectory: string,
): string {
  if (cliValue !== undefined) return cliValue;
  const fromEnv = env.DSH_HOME;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return join(homeDirectory, ".dsh");
}

/** sessions 根目录。 */
export function sessionsRoot(dshHome: string): string {
  return join(dshHome, "sessions");
}

/** `profiles/node_modules` 下的官方作用域目录（旧布局的解析锚点）。 */
function profilesScopeDir(dshHome: string): string {
  return join(dshHome, "profiles", "node_modules", "@deepseek-ai");
}

/** npm 缓存下 npx 临时安装的父目录名；目录名本身（checkout 哈希）不写死。 */
const NPX_CACHE_DIR = "_npx";
/** 探测安装树时使用的锚点包：它必定存在于 dsh 实际使用的那棵树里。 */
const INSTALL_ANCHOR_PACKAGE = "dsh";
/** 本技能加载官方格式库所需的包名（限定在 `@deepseek-ai` 作用域内）。 */
const LIBRARY_PACKAGE = "dsh-session-format-catalog";

/**
 * npm 缓存根目录。
 *
 * 默认 `%LOCALAPPDATA%\npm-cache`（Windows 上 npm 的默认缓存位置），可用 `npm_config_cache`
 * 覆盖。返回 undefined 表示无法定位（既没有该环境变量，也没有 `LOCALAPPDATA`）。
 */
function npmCacheDir(env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env.npm_config_cache;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const localAppData = env.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.length === 0) return undefined;
  return join(localAppData, "npm-cache");
}

/**
 * 在 npm 缓存的 npx 目录下找出「同时含安装锚点包与官方格式库」的 node_modules 目录。
 *
 * 判据与 dsh 自身的安装锚点同源：dsh 的锚点是它自己的 `package.json`（`@deepseek-ai/dsh`），
 * 因此逐个 checkout 探这两个包目录即可，不必写死 checkout 名（那是 npm 依包规格算出的哈希）。
 * @returns 命中的绝对路径数组（0、1 或多个）；无法定位 npm 缓存时为空数组。
 */
function installNodeModulesCandidates(dshHome: string, env: NodeJS.ProcessEnv): readonly string[] {
  const hits: string[] = [];
  const legacy = profilesScopeDir(dshHome);
  const caches: string[] = [];
  const cacheRoot = npmCacheDir(env);
  if (cacheRoot !== undefined) caches.push(cacheRoot);
  for (const cache of caches) {
    const npxRoot = join(cache, NPX_CACHE_DIR);
    if (!existsSync(npxRoot)) continue;
    let entries;
    try {
      entries = readdirSync(npxRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nodeModules = join(npxRoot, entry.name, "node_modules");
      const scope = join(nodeModules, "@deepseek-ai");
      const hasAnchor = existsSync(join(scope, INSTALL_ANCHOR_PACKAGE, "package.json"));
      const hasLibrary = existsSync(join(scope, LIBRARY_PACKAGE, "package.json"));
      if (hasAnchor && hasLibrary) hits.push(nodeModules);
    }
  }
  // 旧布局（`<dsh-home>/profiles/node_modules`）只在其作用域目录同时含这两个包时才参与。
  if (existsSync(join(legacy, INSTALL_ANCHOR_PACKAGE, "package.json")) && existsSync(join(legacy, LIBRARY_PACKAGE, "package.json"))) {
    hits.push(join(dshHome, "profiles", "node_modules"));
  }
  return hits;
}

/**
 * 官方格式库默认解析锚点：**含 `@deepseek-ai` 作用域目录的 `node_modules`**。
 *
 * 为什么不能直接返回 `<dsh-home>/profiles/node_modules`：dsh 自 `0.1.7-rc.2` 起不再在该位置
 * 建 junction 链接农场（本机该目录已整体消失），新布局下 profile 依赖由 pnpm 管理、模块解析走
 * 运行时拦截层。因此这里按 dsh 自身的安装锚点探测实际在用的安装树。
 *
 * 命中数不是 1 时返回 undefined，由调用方给出可执行的诊断——**不挑一个用**：挑错会让后续解码
 * 用错版本的格式库，而那时错误已经离根因很远。调用方也可用 `--lib-root` 显式指定。
 * @returns 可直接作为 `libRoot` 的目录，或 undefined（本环境未能唯一确定）。
 */
export function defaultLibRoot(dshHome: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const hits = installNodeModulesCandidates(dshHome, env);
  if (hits.length !== 1) return undefined;
  return hits[0];
}

/** 路径比较用归一化：反斜杠转正斜杠、去尾部斜杠、转小写（大小写不敏感）。 */
export function normalizePathForCompare(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

const EPOCH_MS_PATTERN = /^\d+$/u;
const ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/u;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * 严格解析时间参数：纯十进制毫秒数，或 ISO 形式（YYYY-MM-DD、[T]HH:mm[:ss[.小数]][Z|±HH:mm]）。
 * 无时区后缀按 UTC 解析（过滤参数一律按 UTC）。校验日历有效性（如 2026-02-30 非法）。
 */
export function parseTimeArg(value: string): Result<number, string> {
  if (value.length === 0) return { success: false, error: "时间参数为空" };
  if (EPOCH_MS_PATTERN.test(value)) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) return { success: false, error: "毫秒数超出安全整数范围" };
    return { success: true, data: parsed };
  }
  const match = ISO_PATTERN.exec(value);
  if (match === null) return { success: false, error: "无法解析的时间格式" };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const fractionText = match[7];
  const milliseconds =
    fractionText === undefined ? 0 : Number(fractionText.padEnd(3, "0").slice(0, 3));
  if (month < 1 || month > 12) return { success: false, error: "月份超出范围" };
  if (day < 1 || day > daysInMonth(year, month)) return { success: false, error: "日期超出范围" };
  if (hour > 23 || minute > 59 || second > 59) return { success: false, error: "时间超出范围" };
  let offsetMinutes = 0;
  const offsetText = match[8];
  if (offsetText !== undefined && offsetText !== "Z") {
    const offsetHours = Number(offsetText.slice(1, 3));
    const offsetRemainder = Number(offsetText.slice(4, 6));
    if (offsetHours > 23 || offsetRemainder > 59)
      return { success: false, error: "时区偏移超出范围" };
    offsetMinutes = offsetHours * 60 + offsetRemainder;
    if (offsetText.startsWith("-")) offsetMinutes = -offsetMinutes;
  }
  const epochMs =
    Date.UTC(year, month - 1, day, hour, minute, second, milliseconds) - offsetMinutes * 60_000;
  return { success: true, data: epochMs };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 格式化为含时区偏移的 ISO 8601 本地时间（例：2026-09-13T22:31:00+08:00）。 */
export function formatLocalIso(timestampMs: number): string {
  const date = new Date(timestampMs);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = pad2(Math.floor(absoluteOffset / 60));
  const offsetRemainder = pad2(absoluteOffset % 60);
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `${sign}${offsetHours}:${offsetRemainder}`
  );
}

/** 输出文件名中的 UTC 时间戳（例：20260914T083015123Z）。 */
export function formatUtcStamp(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
    `T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}` +
    `${String(date.getUTCMilliseconds()).padStart(3, "0")}Z`
  );
}

const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** 随机 6 位后缀（[a-z0-9]）。 */
export function randomOutputSuffix(): string {
  let suffix = "";
  for (let index = 0; index < 6; index += 1) {
    suffix += SUFFIX_ALPHABET.charAt(randomInt(0, SUFFIX_ALPHABET.length));
  }
  return suffix;
}

/** 输出格式到文件扩展名的映射：md→md、json→json、jsonl→jsonl。 */
export function extensionForFormat(format: "md" | "json" | "jsonl"): string {
  if (format === "md") return "md";
  if (format === "json") return "json";
  return "jsonl";
}

/** 输出文件名：session-reader-<命令>-<UTC 时间戳>-<随机 6 位>.<ext>。 */
export function outputFileName(
  command: string,
  format: "md" | "json" | "jsonl",
  date: Date,
  suffix: string,
): string {
  return `session-reader-${command}-${formatUtcStamp(date)}-${suffix}.${extensionForFormat(format)}`;
}

/**
 * `--name` 允许的字符集：ASCII 字母数字、下划线、连字符，以及全部汉字。
 *
 * 汉字用 Unicode 属性 `Script=Han` 表达，而不是手写 `\uXXXX` 区间：手写区间只能覆盖基本平面
 * （基本区、扩展 A、兼容区），会把扩展 B 及以后的正常汉字（如 `𠮷` U+20BB7）误判为非法，
 * 而报错文案与 `SKILL.md` 承诺的正是"中文"。属性转义随 Unicode 数据更新，是"中文可用"
 * 这一要求的直接表达；本白名单仍是白名单——`.`、路径分隔符、`:`、空白与控制字符一律不在内。
 */
const OUTPUT_NAME_PATTERN = /^[A-Za-z0-9_\-\p{Script=Han}]+$/u;

/** Windows 保留设备名（不区分大小写；写入这些名字会被系统重定向到设备）。 */
const RESERVED_DEVICE_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

const OUTPUT_NAME_MAX_LENGTH = 64;

/**
 * 校验 `--name`（产物 basename，不含扩展名）。
 *
 * 设计约束：产物路径必须恒为 `--output-dir` 的直接子文件。因此字符集是白名单而非黑名单——
 * `.` 被排除（否则 `a.md` 与 `--format` 派生的扩展名形成双重歧义，且 `..` 可越出输出目录），
 * 路径分隔符与 `:` 被排除（否则可写到输出目录之外或落到 NTFS 备用数据流）。
 * 保留设备名单独拒绝：它们不含非法字符，但会被 Windows 重定向到设备而静默丢失产物。
 *
 * @param value 调用方给出的 basename。
 * @returns 合法返回 null，否则返回可在 stderr 括号说明中回显的错误文本（只含选项名与规则，不含调用方数据）。
 */
export function validateOutputName(value: string): string | null {
  if (value.length === 0) return "--name 不能为空";
  if (value.length > OUTPUT_NAME_MAX_LENGTH) {
    return `--name 最长 ${OUTPUT_NAME_MAX_LENGTH} 个字符`;
  }
  if (!OUTPUT_NAME_PATTERN.test(value)) {
    return "--name 只允许 ASCII 字母、数字、下划线、连字符与中文；产物名固定为 <name>.<扩展名>，扩展名由 --format 决定";
  }
  if (RESERVED_DEVICE_NAMES.has(value.toUpperCase())) {
    return `--name 不得使用 Windows 保留设备名 ${value.toUpperCase()}；请换一个名字`;
  }
  return null;
}

/**
 * 生成产物文件名：给出 `--name` 时返回 `<name>.<ext>`；未给出时回落时间戳命名。
 *
 * @param command 子命令名（仅时间戳命名使用）。
 * @param format 输出格式（决定扩展名）。
 * @param name 调用方指定的 basename；undefined 表示未指定。
 * @param date 当前时间（仅时间戳命名使用）。
 * @param suffix 随机后缀（仅时间戳命名使用）。
 * @returns 产物文件名（不含目录）。
 */
export function resolveOutputFileName(
  command: string,
  format: "md" | "json" | "jsonl",
  name: string | undefined,
  date: Date,
  suffix: string,
): string {
  if (name === undefined) return outputFileName(command, format, date, suffix);
  return `${name}.${extensionForFormat(format)}`;
}

/** 整数区间（含两端）。 */
export interface IntegerRange {
  readonly from: number;
  readonly to: number;
}

const RANGE_PATTERN = /^(\d+)(?:-(\d+))?$/u;

/**
 * 解析区间参数 `<A-B>` 或 `<A>`（单值等价于 `[A,A]`）。
 *
 * 约束：只接受十进制非负整数；`A >= minimum`；`B >= A`。不做"空区间自动放宽"，
 * 越界即报错，避免调用方以为筛选生效而实际读到全部内容。
 *
 * @param value 调用方给出的原始 token。
 * @param minimum 下界允许的最小值（turn 为 1，seq 为 0）。
 * @param optionName 出错时回显的选项名（只回显选项名，不回显选项值）。
 * @returns 合法返回区间，否则返回错误文本。
 */
export function parseIntegerRange(
  value: string,
  minimum: number,
  optionName: string,
): Result<IntegerRange, string> {
  const match = RANGE_PATTERN.exec(value);
  if (match === null) return { success: false, error: `${optionName} 格式应为 <A-B> 或 <A>` };
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
    return { success: false, error: `${optionName} 数值超出安全整数范围` };
  }
  if (from < minimum) return { success: false, error: `${optionName} 下界不得小于 ${minimum}` };
  if (to < from) return { success: false, error: `${optionName} 上界不得小于下界` };
  return { success: true, data: { from, to } };
}

/** 统计内容行数（末尾换行不计入空行）。 */
export function countLines(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}
