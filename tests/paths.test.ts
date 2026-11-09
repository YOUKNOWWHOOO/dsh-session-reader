// paths.ts 单元测试：DSH_HOME 解析、路径归一化、时间解析/格式化、输出文件名、行计数。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  countLines,
  defaultLibRoot,
  formatLocalIso,
  formatUtcStamp,
  normalizePathForCompare,
  outputFileName,
  parseIntegerRange,
  parseTimeArg,
  randomOutputSuffix,
  resolveDshHome,
  resolveOutputFileName,
  sessionsRoot,
  validateOutputName,
} from "../scripts/lib/paths.ts";
import { resetTempDir } from "./fixtures.ts";

/** 本文件的夹具根（技能目录下的 tests/.tmp，不用系统临时目录）。 */
const PATHS_TMP = fileURLToPath(new URL("./.tmp", import.meta.url));

describe("resolveDshHome", () => {
  it("显式参数优先于环境变量与默认值", () => {
    assert.equal(
      resolveDshHome("C:\\explicit", { DSH_HOME: "C:\\env" }, "C:\\home"),
      "C:\\explicit",
    );
  });

  it("环境变量 DSH_HOME 次优先", () => {
    assert.equal(resolveDshHome(undefined, { DSH_HOME: "C:\\env" }, "C:\\home"), "C:\\env");
  });

  it("缺省回落到 <用户主目录>\\.dsh", () => {
    assert.equal(resolveDshHome(undefined, {}, "C:\\home"), join("C:\\home", ".dsh"));
  });

  it("环境变量为空串时回落到默认值", () => {
    assert.equal(resolveDshHome(undefined, { DSH_HOME: "" }, "C:\\home"), join("C:\\home", ".dsh"));
  });
});

describe("sessionsRoot", () => {
  it("sessions 根路径正确", () => {
    const dshHome = join("C:\\", "home", ".dsh");
    assert.equal(sessionsRoot(dshHome), join(dshHome, "sessions"));
  });
});

describe("defaultLibRoot 的桌面版安装锚点定位", () => {
  /** 桌面版安装内 dsh 的 node_modules 路径（与 paths.ts 的结构定位一致）。 */
  function desktopNodeModules(localAppData: string, installDirName: string): string {
    return join(
      localAppData,
      "Programs",
      installDirName,
      "resources",
      "app.asar",
      "dsh",
      "node_modules",
    );
  }

  /**
   * 在一个假 LOCALAPPDATA 下按桌面安装结构造出指定包的锚点目录。
   *
   * 必须逐级创建（不能用一次跨层的 `mkdirSync(p, { recursive: true })`）：Electron 改写了
   * `node:fs`，路径中出现既有的 `app.asar` 目录段时，其递归创建会以 `ENOTDIR` 失败（实测）；
   * 逐级创建绕开该改写。
   */
  function writeDesktopLib(
    localAppData: string,
    installDirName: string,
    packages: readonly string[],
  ): string {
    const levels = ["Programs", installDirName, "resources", "app.asar", "dsh", "node_modules"];
    let current = localAppData;
    for (const level of levels) {
      current = join(current, level);
      mkdirSync(current, { recursive: true });
    }
    const scope = join(current, "@deepseek-ai");
    mkdirSync(scope, { recursive: true });
    for (const pkg of packages) {
      const dir = join(scope, pkg);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), "{}\n", "utf8");
    }
    return current;
  }

  it("缺少 LOCALAPPDATA 或非 Windows 时返回 undefined，不猜别的目录", () => {
    const localAppData = resetTempDir(join(PATHS_TMP, "paths-missing-localappdata"));
    // 环境里没有 LOCALAPPDATA：无法定位唯一锚点，返回 undefined 而不是猜一个。
    assert.equal(defaultLibRoot({}, "win32"), undefined);
    assert.equal(defaultLibRoot({ LOCALAPPDATA: "" }, "win32"), undefined);
    // 非 Windows 平台即使安装结构齐备，也不适用该安装布局。
    const nodeModules = writeDesktopLib(localAppData, "Desktop Install B", [
      "dsh",
      "dsh-session-format-catalog",
    ]);
    assert.equal(existsSync(join(nodeModules, "@deepseek-ai", "dsh", "package.json")), true);
    assert.equal(defaultLibRoot({ LOCALAPPDATA: localAppData }, "linux"), undefined);
  });

  it("恰好一棵安装树且两个锚点包齐备时返回其 node_modules，与安装目录名无关", () => {
    const localAppData = resetTempDir(join(PATHS_TMP, "paths-single-install"));
    // 目录名故意不使用任何产品名：定位若仍依赖写死的产品目录名，本用例会返回 undefined。
    const installDirName = "Desktop Install A";
    const nodeModules = writeDesktopLib(localAppData, installDirName, [
      "dsh",
      "dsh-session-format-catalog",
    ]);
    const expected = desktopNodeModules(localAppData, installDirName);
    assert.equal(nodeModules, expected);
    assert.equal(defaultLibRoot({ LOCALAPPDATA: localAppData }, "win32"), expected);
  });

  it("Programs 不存在或为空目录时返回 undefined", () => {
    const missing = resetTempDir(join(PATHS_TMP, "paths-no-programs"));
    // Programs 整个不存在：没有任何安装树可定位。
    assert.equal(defaultLibRoot({ LOCALAPPDATA: missing }, "win32"), undefined);
    const empty = resetTempDir(join(PATHS_TMP, "paths-empty-programs"));
    mkdirSync(join(empty, "Programs"), { recursive: true });
    // Programs 存在但没有子目录：同样没有安装树可定位。
    assert.equal(defaultLibRoot({ LOCALAPPDATA: empty }, "win32"), undefined);
  });

  it("两棵安装树都完整时返回 undefined（候选不唯一）", () => {
    const localAppData = resetTempDir(join(PATHS_TMP, "paths-two-installs"));
    const first = writeDesktopLib(localAppData, "Install A", ["dsh", "dsh-session-format-catalog"]);
    const second = writeDesktopLib(localAppData, "Install B", [
      "dsh",
      "dsh-session-format-catalog",
    ]);
    assert.notEqual(first, second);
    assert.equal(existsSync(join(first, "@deepseek-ai", "dsh", "package.json")), true);
    assert.equal(
      existsSync(join(first, "@deepseek-ai", "dsh-session-format-catalog", "package.json")),
      true,
    );
    assert.equal(existsSync(join(second, "@deepseek-ai", "dsh", "package.json")), true);
    assert.equal(
      existsSync(join(second, "@deepseek-ai", "dsh-session-format-catalog", "package.json")),
      true,
    );
    // 两棵都完整：无法判断哪一棵与当前桌面版同版，不得猜一棵。
    assert.equal(defaultLibRoot({ LOCALAPPDATA: localAppData }, "win32"), undefined);
  });

  it("只装了其中一个包时返回 undefined（缺任一项都不算可用的安装树）", () => {
    const localAppData = resetTempDir(join(PATHS_TMP, "paths-single-package"));
    const anchorOnly = writeDesktopLib(localAppData, "Install Anchor Only", ["dsh"]);
    const libraryOnly = writeDesktopLib(localAppData, "Install Library Only", [
      "dsh-session-format-catalog",
    ]);
    assert.equal(existsSync(join(anchorOnly, "@deepseek-ai", "dsh", "package.json")), true);
    assert.equal(
      existsSync(join(libraryOnly, "@deepseek-ai", "dsh-session-format-catalog", "package.json")),
      true,
    );
    assert.equal(defaultLibRoot({ LOCALAPPDATA: localAppData }, "win32"), undefined);
  });

  it("默认锚点不读 npm 缓存的 npx 安装树：该树再完整也返回 undefined", () => {
    const localAppData = resetTempDir(join(PATHS_TMP, "paths-npx"));
    // 造出一棵完整但位于 npm 缓存里的 npx 安装树，并给出会指向它的缓存环境变量。
    const npxScope = join(
      localAppData,
      "cache",
      "_npx",
      "aaaa1111",
      "node_modules",
      "@deepseek-ai",
    );
    for (const pkg of ["dsh", "dsh-session-format-catalog"]) {
      mkdirSync(join(npxScope, pkg), { recursive: true });
      writeFileSync(join(npxScope, pkg, "package.json"), "{}\n", "utf8");
    }
    assert.equal(existsSync(join(npxScope, "dsh", "package.json")), true);
    assert.equal(existsSync(join(npxScope, "dsh-session-format-catalog", "package.json")), true);
    // 默认形态是唯一锚点：只认 Programs 下的安装结构，npx 安装树一律不参与。
    assert.equal(
      defaultLibRoot(
        { LOCALAPPDATA: localAppData, npm_config_cache: join(localAppData, "cache") },
        "win32",
      ),
      undefined,
    );
  });
});

describe("normalizePathForCompare", () => {
  it("反斜杠转正斜杠、去尾斜杠、小写化", () => {
    assert.equal(
      normalizePathForCompare("C:\\Users\\Alice\\user_projects\\"),
      "c:/users/alice/user_projects",
    );
  });

  it("已经是正斜杠时保持", () => {
    assert.equal(normalizePathForCompare("c:/a/b"), "c:/a/b");
  });
});

describe("parseTimeArg", () => {
  it("纯十进制毫秒数按原值解析", () => {
    assert.deepEqual(parseTimeArg("1789296543846"), { success: true, data: 1789296543846 });
    assert.deepEqual(parseTimeArg("0"), { success: true, data: 0 });
  });

  it("YYYY-MM-DD 按 UTC 零点解析", () => {
    assert.deepEqual(parseTimeArg("2026-09-11"), { success: true, data: Date.UTC(2026, 8, 11) });
  });

  it("无时区的日期时间按 UTC 解析", () => {
    assert.deepEqual(parseTimeArg("2026-09-11T20:29:28"), {
      success: true,
      data: Date.UTC(2026, 8, 11, 20, 29, 28),
    });
  });

  it("Z 后缀等价于 UTC", () => {
    const withZ = parseTimeArg("2026-09-11T20:29:28Z");
    const withoutZ = parseTimeArg("2026-09-11T20:29:28");
    assert.equal(withZ.success, true);
    assert.equal(withoutZ.success, true);
    if (withZ.success && withoutZ.success) assert.equal(withZ.data, withoutZ.data);
  });

  it("+08:00 后缀按偏移折算为 UTC 时刻", () => {
    assert.deepEqual(parseTimeArg("2026-09-11T20:29:28+08:00"), {
      success: true,
      data: Date.UTC(2026, 8, 11, 12, 29, 28),
    });
  });

  it("负偏移与毫秒小数", () => {
    assert.deepEqual(parseTimeArg("2026-09-11T20:29:28.123-05:00"), {
      success: true,
      data: Date.UTC(2026, 8, 12, 1, 29, 28, 123),
    });
  });

  it("省略秒与分钟形式", () => {
    assert.deepEqual(parseTimeArg("2026-09-11T20:29"), {
      success: true,
      data: Date.UTC(2026, 8, 11, 20, 29),
    });
  });

  it("非法值报错：空、非数字、非日期、越界、坏时区", () => {
    for (const value of [
      "",
      "abc",
      "2026-02-30",
      "2026-13-01",
      "2026-09-11T25:00",
      "2026-09-11T20:29+25:00",
    ]) {
      const parsed = parseTimeArg(value);
      assert.equal(parsed.success, false, `期望非法: ${value}`);
    }
  });
});

describe("formatLocalIso / formatUtcStamp", () => {
  it("本地时间格式含时区偏移且能还原原始时刻", () => {
    const text = formatLocalIso(1789296543000);
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-])(\d{2}):(\d{2})$/u.exec(
      text,
    );
    assert.notEqual(match, null);
    if (match === null) return;
    const offsetMinutes = (Number(match[8]) * 60 + Number(match[9])) * (match[7] === "+" ? 1 : -1);
    const restored =
      Date.UTC(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6]),
      ) -
      offsetMinutes * 60_000;
    assert.equal(restored, 1789296543000);
  });

  it("UTC 时间戳格式固定", () => {
    assert.equal(formatUtcStamp(new Date(0)), "19700101T000000000Z");
    assert.equal(formatUtcStamp(new Date(1789296543846)), "20260913T104903846Z");
  });
});

describe("outputFileName / randomOutputSuffix / countLines", () => {
  it("文件名模式与扩展名映射", () => {
    assert.equal(
      outputFileName("list", "md", new Date(0), "abc123"),
      "session-reader-list-19700101T000000000Z-abc123.md",
    );
    assert.equal(
      outputFileName("show", "json", new Date(0), "abc123"),
      "session-reader-show-19700101T000000000Z-abc123.json",
    );
    assert.equal(
      outputFileName("show", "jsonl", new Date(0), "abc123"),
      "session-reader-show-19700101T000000000Z-abc123.jsonl",
    );
  });

  it("随机后缀为 6 位 [a-z0-9]", () => {
    const suffix = randomOutputSuffix();
    assert.match(suffix, /^[a-z0-9]{6}$/u);
    assert.equal(randomOutputSuffix().length, 6);
  });

  it("行计数忽略末尾换行产生的空行", () => {
    assert.equal(countLines(""), 0);
    assert.equal(countLines("a"), 1);
    assert.equal(countLines("a\n"), 1);
    assert.equal(countLines("a\nb"), 2);
    assert.equal(countLines("a\nb\n"), 2);
  });
});

describe("validateOutputName", () => {
  it("接受字母数字下划线连字符与中文", () => {
    for (const value of ["probe", "probe-2", "probe_2", "调查报告", "报告-2026_a"]) {
      assert.equal(validateOutputName(value), null, `期望合法: ${value}`);
    }
    // 扩展平面的汉字同样是"中文"，不得因手写 \uXXXX 区间只覆盖基本平面而被误拒。
    for (const value of ["𠮷", "𠮷野家"]) {
      assert.equal(validateOutputName(value), null, `期望合法: ${value}`);
    }
  });

  it("拒绝非 Han 的非 ASCII 字符", () => {
    for (const value of ["Ω", "Ж", "한", "😀"]) {
      assert.notEqual(validateOutputName(value), null, `期望非法: ${value}`);
    }
  });

  it("拒绝空值与超长值", () => {
    assert.equal(validateOutputName(""), "--name 不能为空");
    assert.notEqual(validateOutputName("a".repeat(65)), null);
    assert.equal(validateOutputName("a".repeat(64)), null);
  });

  it("拒绝路径穿越与双重扩展名相关字符", () => {
    for (const value of ["a.b", "..", "../x", "a/b", "a\\b", "a:b", "a b", "a*b", "a?b"]) {
      assert.notEqual(validateOutputName(value), null, `期望非法: ${value}`);
    }
    assert.match(String(validateOutputName("a.b")), /扩展名由 --format 决定/u);
  });

  it("拒绝控制字符与零宽字符", () => {
    for (const value of ["a\u0000b", "a\tb", "a\u200Bb", "a\nb"]) {
      assert.notEqual(validateOutputName(value), null, `期望非法: ${JSON.stringify(value)}`);
    }
  });

  it("拒绝 Windows 保留设备名（含大小写变体）", () => {
    for (const value of ["CON", "con", "Nul", "COM1", "lpt9", "AUX", "PRN"]) {
      assert.notEqual(validateOutputName(value), null, `期望非法: ${value}`);
    }
    assert.equal(validateOutputName("CONS"), null);
    assert.equal(validateOutputName("COM10"), null);
  });
});

describe("resolveOutputFileName", () => {
  it("未指定 --name 时回落时间戳命名", () => {
    assert.equal(
      resolveOutputFileName("list", "md", undefined, new Date(0), "abc123"),
      "session-reader-list-19700101T000000000Z-abc123.md",
    );
  });

  it("指定 --name 时按格式派生扩展名", () => {
    assert.equal(resolveOutputFileName("list", "md", "probe", new Date(0), "abc123"), "probe.md");
    assert.equal(
      resolveOutputFileName("show", "json", "probe", new Date(0), "abc123"),
      "probe.json",
    );
    assert.equal(
      resolveOutputFileName("show", "jsonl", "probe", new Date(0), "abc123"),
      "probe.jsonl",
    );
  });
});

describe("parseIntegerRange", () => {
  it("单值等价于 [A,A]", () => {
    assert.deepEqual(parseIntegerRange("7", 0, "--seq"), {
      success: true,
      data: { from: 7, to: 7 },
    });
    assert.deepEqual(parseIntegerRange("2", 1, "--turn"), {
      success: true,
      data: { from: 2, to: 2 },
    });
  });

  it("区间形式两端含端点", () => {
    assert.deepEqual(parseIntegerRange("2-5", 1, "--turn"), {
      success: true,
      data: { from: 2, to: 5 },
    });
    assert.deepEqual(parseIntegerRange("0-0", 0, "--seq"), {
      success: true,
      data: { from: 0, to: 0 },
    });
  });

  it("拒绝格式错误", () => {
    for (const value of ["", "a", "1-", "-1", "1-2-3", "1 ", " 1", "1.5", "0x10"]) {
      const parsed = parseIntegerRange(value, 0, "--seq");
      assert.equal(parsed.success, false, `期望非法: ${JSON.stringify(value)}`);
    }
  });

  it("拒绝下界越界与上界小于下界", () => {
    const tooSmall = parseIntegerRange("0", 1, "--turn");
    assert.equal(tooSmall.success, false);
    if (!tooSmall.success) assert.equal(tooSmall.error, "--turn 下界不得小于 1");
    const inverted = parseIntegerRange("5-2", 0, "--seq");
    assert.equal(inverted.success, false);
    if (!inverted.success) assert.equal(inverted.error, "--seq 上界不得小于下界");
  });

  it("拒绝超出安全整数范围的值", () => {
    const parsed = parseIntegerRange("99999999999999999999", 0, "--seq");
    assert.equal(parsed.success, false);
  });
});
