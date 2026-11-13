// 按安装结构定位桌面可执行文件，并以 Electron-as-Node 启动子进程。
// 此模块不读取会话，也不更改调用方的工作目录或持久环境。
import { spawn } from "node:child_process";
import { type Dirent, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Result } from "./paths.ts";

/** 返回文件状态；不存在的路径不是文件，其他文件系统错误继续向调用方报告。 */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return false;
    throw error;
  }
}

/** 按唯一结构定位桌面版可执行文件；失败诊断不包含实际路径。 */
export function resolveDesktopExecutable(localAppData: string | undefined): Result<string, string> {
  const notUnique = (count: number): Result<string, string> => ({
    success: false,
    error: `未能在 %LOCALAPPDATA%\\Programs 下唯一定位桌面版安装，命中 ${count} 个候选`,
  });
  if (localAppData === undefined || localAppData.length === 0) return notUnique(0);
  const programs = resolve(localAppData, "Programs");
  try {
    let entries: readonly Dirent[];
    try {
      entries = readdirSync(programs, { withFileTypes: true });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      )
        return notUnique(0);
      throw error;
    }
    const candidates = entries.filter(
      (entry) =>
        entry.isDirectory() &&
        isFile(join(programs, entry.name, "resources", "runtime", "bin", "node.cmd")),
    );
    if (candidates.length !== 1) return notUnique(candidates.length);
    const candidate = candidates[0];
    const executable = join(programs, candidate.name, `${candidate.name}.exe`);
    if (!isFile(executable)) {
      return { success: false, error: "桌面版安装目录根部缺少与目录同名的可执行文件" };
    }
    return { success: true, data: executable };
  } catch {
    return { success: false, error: "读取桌面版安装目录失败" };
  }
}

/** 启动桌面 Node 并继承标准流，返回真实退出码或不含路径的失败诊断。 */
export async function runDesktopNode(
  executablePath: string,
  args: readonly string[],
): Promise<Result<number, string>> {
  try {
    return await new Promise((resolveResult) => {
      const child = spawn(executablePath, ["--expose-internals", ...args], {
        shell: false,
        windowsHide: true,
        stdio: "inherit",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      // 父进程退出时终止仍在运行的子进程，正常结束后移除监听器。
      const cleanup = (): void => {
        child.kill();
      };
      process.once("exit", cleanup);
      child.once("error", (error) => {
        process.removeListener("exit", cleanup);
        const code = "code" in error && typeof error.code === "string" ? `（${error.code}）` : "";
        resolveResult({ success: false, error: `启动桌面版执行载体失败${code}` });
      });
      child.once("close", (code) => {
        process.removeListener("exit", cleanup);
        resolveResult(
          code === null
            ? { success: false, error: "桌面版执行载体未正常退出" }
            : { success: true, data: code },
        );
      });
    });
  } catch {
    return { success: false, error: "启动桌面版执行载体失败" };
  }
}
