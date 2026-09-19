// render-core 基础规则：字节大小格式化、按码点截断，lint-safe 载体与归一化（制表符/CRLF、MD014、围栏、内联代码与内联值、表格单元格）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fenceBlock,
  formatSize,
  inlineCodeSpan,
  inlineValue,
  neutralizeMd014,
  normalizeTabs,
  tableCellValue,
  truncateText,
  wouldTriggerMd014,
} from "../scripts/lib/render-core.ts";

describe("formatSize / truncateText", () => {
  it("字节大小格式化", () => {
    assert.equal(formatSize(500), "500 B");
    assert.equal(formatSize(1024), "1.0 KB");
    assert.equal(formatSize(19442), "19.0 KB");
    assert.equal(formatSize(1053118), "1.0 MB");
  });

  it("按码点截断并附加省略号", () => {
    assert.equal(truncateText("abcdef", 3), "abc…");
    assert.equal(truncateText("abc", 3), "abc");
    assert.equal(truncateText("abcdef", 0), "abcdef");
    assert.equal(truncateText("😀😀😀", 2), "😀😀…");
  });
});

describe("lint-safe 载体与归一化", () => {
  it("normalizeTabs：制表符替换为 4 空格", () => {
    assert.equal(normalizeTabs("a\tb"), "a    b");
    assert.equal(normalizeTabs("\tindent"), "    indent");
    assert.equal(normalizeTabs("no-tab"), "no-tab");
  });

  it("wouldTriggerMd014：全部非空行以 $ + 空白开头才触发", () => {
    assert.equal(wouldTriggerMd014("$ echo hello"), true);
    assert.equal(wouldTriggerMd014("$ ls\n$ pwd"), true);
    assert.equal(wouldTriggerMd014("$ echo hello\nhello"), false);
    assert.equal(wouldTriggerMd014("$ a\n\n$ b"), true);
    assert.equal(wouldTriggerMd014(""), false);
    assert.equal(wouldTriggerMd014("\n\n"), false);
  });

  it("neutralizeMd014：触发时在末尾追加一行单个空格", () => {
    assert.equal(neutralizeMd014("$ ls\n$ pwd"), "$ ls\n$ pwd\n ");
    assert.equal(neutralizeMd014("$ ls\nout"), "$ ls\nout");
  });

  it("fenceBlock：动态反引号长度、语言固定 text、归一化生效", () => {
    assert.equal(fenceBlock("plain"), "```text\nplain\n```");
    assert.equal(fenceBlock("a\n```\nb"), "````text\na\n```\nb\n````");
    assert.equal(fenceBlock("$ a\n$ b"), "```text\n$ a\n$ b\n \n```");
    assert.equal(fenceBlock("a\tb"), "```text\na    b\n```");
  });

  it("inlineCodeSpan：动态反引号、反引号边界加内边距", () => {
    assert.equal(inlineCodeSpan("x"), "`x`");
    assert.equal(inlineCodeSpan("`x`"), "`` `x` ``");
    assert.equal(inlineCodeSpan("``"), "``` `` ```");
    assert.equal(inlineCodeSpan(""), "``");
  });

  it("inlineValue：折叠换行、制表符、去除首尾空白；全空白保留", () => {
    assert.equal(inlineValue("  a\tb  "), "`a    b`");
    assert.equal(inlineValue("a\nb\rc"), "`a b c`");
    assert.equal(inlineValue("x"), "`x`");
    assert.equal(inlineValue("   "), "`   `");
    assert.equal(inlineValue(""), "``");
  });

  it("tableCellValue：管道符转义", () => {
    assert.equal(tableCellValue("a|b"), "`a\\|b`");
    assert.equal(tableCellValue("plain"), "`plain`");
  });
});
