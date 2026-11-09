// 用途：全组合 lint 门禁的共享路径与运行时锚点（叶子模块，不依赖同目录其它门禁模块）。
// 主要入口：无函数入口，仅导出常量（SESSION_READER / DEFAULT_LINT_CONFIG / LIB_ROOT / RUN_TIMEOUT_MS）。
// 关键依赖：node:path、node:url、scripts/lib/paths.ts。
// 设计约束：技能根、CLI 入口、lint 配置与官方库锚点在拆分后必须只定义一次；
//           这些常量被入口、组合矩阵与夹具三处共用，集中在此可避免矩阵模块反向依赖入口形成循环导入。

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultLibRoot } from "../scripts/lib/paths.ts";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const SKILL_ROOT = resolve(SCRIPT_DIR, "..");

/** 被门禁端到端驱动的 CLI 入口。 */
export const SESSION_READER = join(SKILL_ROOT, "scripts", "session-reader.ts");

/** 默认 markdownlint 配置（技能根 .markdownlint.jsonc）。 */
export const DEFAULT_LINT_CONFIG = join(SKILL_ROOT, ".markdownlint.jsonc");

/**
 * 官方格式库锚点：与 CLI 的默认锚点同源，由 `scripts/lib/paths.ts` 的 `defaultLibRoot` 按
 * `%LOCALAPPDATA%\Programs` 下唯一一棵桌面安装结构定位。
 *
 * 不写死某个具体机器的安装路径与产品目录名：锚点由 `paths.ts` 按结构派生，夹具与门禁取同一函数，
 * 避免两处各写一份路径算术。取不到时本函数直接抛错并给出可执行的下一步：
 * 门禁的每一组组合都要真实加载官方库，没有它继续跑只会让每组各自失败、把根因淹没在成百条失败里。
 */
export function libRoot(): string {
  const root = defaultLibRoot();
  if (root === undefined) {
    throw new Error(
      "默认锚点未能定位桌面版安装内的官方格式库，全组合门禁无法运行；请修复安装树定位（见 scripts/lib/paths.ts）",
    );
  }
  return root;
}

/** 单次 CLI 子进程超时。 */
export const RUN_TIMEOUT_MS = 120_000;
