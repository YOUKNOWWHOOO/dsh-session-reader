// 路径、时间与输出命名工具：DSH_HOME 解析、sessions 根、lib 锚点、时间解析/格式化、路径归一化、输出文件名。
// 本模块不依赖其它 lib 模块（最底层），Result 类型在此定义并被其它模块复用。
import { randomInt } from "node:crypto";
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

/** 官方格式库默认解析锚点。 */
export function defaultLibRoot(dshHome: string): string {
  return join(dshHome, "profiles", "node_modules");
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

/** 统计内容行数（末尾换行不计入空行）。 */
export function countLines(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}
