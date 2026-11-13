// 调用入口负责定位桌面运行时并逐字转发参数和进程输出。
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveDesktopExecutable, runDesktopNode } from "./lib/desktop-runtime.ts";

/** 启动会话读取 CLI，返回其退出码或启动失败码。 */
export async function main(args: readonly string[]): Promise<number> {
  const executable = resolveDesktopExecutable(process.env.LOCALAPPDATA);
  if (!executable.success) {
    process.stderr.write(`错误: 内部错误（${executable.error}）\n`);
    return 3;
  }
  const cliPath = fileURLToPath(new URL("./session-reader.ts", import.meta.url));
  const result = await runDesktopNode(executable.data, [cliPath, ...args]);
  if (!result.success) {
    process.stderr.write(`错误: 内部错误（${result.error}）\n`);
    return 3;
  }
  return result.data;
}

const executedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (executedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
