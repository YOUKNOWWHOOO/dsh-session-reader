// 验证桌面安装结构定位与桌面 Node 进程的退出结果。
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveDesktopExecutable, runDesktopNode } from "../scripts/lib/desktop-runtime.ts";

const root = fileURLToPath(new URL("./.tmp/desktop-runtime/", import.meta.url));
const programs = join(root, "Programs");

/** 创建一个具有桌面运行时标记的合成安装。 */
function createInstall(name: string, executable: boolean): string {
  const install = join(programs, name);
  const marker = join(install, "resources", "runtime", "bin");
  mkdirSync(marker, { recursive: true });
  writeFileSync(join(marker, "node.cmd"), "");
  const exe = join(install, `${name}.exe`);
  if (executable) writeFileSync(exe, "");
  return exe;
}

before(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(programs, { recursive: true });
});
after(() => rmSync(root, { recursive: true, force: true }));

test("定位唯一安装并拒绝零个、多个和缺失可执行文件", () => {
  const empty = resolveDesktopExecutable(root);
  assert.deepEqual(empty, {
    success: false,
    error: "未能在 %LOCALAPPDATA%\\Programs 下唯一定位桌面版安装，命中 0 个候选",
  });
  const exe = createInstall("Desktop One", true);
  assert.deepEqual(resolveDesktopExecutable(root), { success: true, data: exe });
  createInstall("Desktop Two", true);
  const multiple = resolveDesktopExecutable(root);
  assert.deepEqual(multiple, {
    success: false,
    error: "未能在 %LOCALAPPDATA%\\Programs 下唯一定位桌面版安装，命中 2 个候选",
  });
  rmSync(join(programs, "Desktop Two"), { recursive: true });
  rmSync(exe);
  const missing = resolveDesktopExecutable(root);
  assert.deepEqual(missing, {
    success: false,
    error: "桌面版安装目录根部缺少与目录同名的可执行文件",
  });
  for (const result of [empty, multiple, missing, resolveDesktopExecutable(undefined)]) {
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.includes(root), false);
  }
});

test("运行器返回正常退出码并报告启动失败", async () => {
  const script = join(root, "exit.ts");
  writeFileSync(script, "process.exitCode = Number(process.argv[2]);\n");
  assert.deepEqual(await runDesktopNode(process.execPath, [script, "0"]), {
    success: true,
    data: 0,
  });
  assert.deepEqual(await runDesktopNode(process.execPath, [script, "7"]), {
    success: true,
    data: 7,
  });
  const failure = await runDesktopNode(join(root, "missing.exe"), []);
  assert.equal(failure.success, false);
  if (!failure.success) {
    assert.equal(failure.error.includes("启动桌面版执行载体失败"), true);
    assert.equal(failure.error.includes(root), false);
  }
});
