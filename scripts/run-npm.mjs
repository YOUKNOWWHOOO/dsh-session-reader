// 使用当前 Node.js 随附的 npm 转发命令参数。
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const npmCliPath = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const result = spawnSync(process.execPath, [npmCliPath, ...process.argv.slice(2)], {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
