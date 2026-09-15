// paths.ts 单元测试：DSH_HOME 解析、路径归一化、时间解析/格式化、输出文件名、行计数。
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
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

describe("sessionsRoot / defaultLibRoot", () => {
  it("sessions 根与 lib 锚点路径正确", () => {
    const dshHome = join("C:\\", "home", ".dsh");
    assert.equal(sessionsRoot(dshHome), join(dshHome, "sessions"));
    assert.equal(defaultLibRoot(dshHome), join(dshHome, "profiles", "node_modules"));
  });
});

describe("normalizePathForCompare", () => {
  it("反斜杠转正斜杠、去尾斜杠、小写化", () => {
    assert.equal(
      normalizePathForCompare("C:\\Users\\ZHANG\\user_projects\\"),
      "c:/users/zhang/user_projects",
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
