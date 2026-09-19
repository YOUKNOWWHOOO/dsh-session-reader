// list 渲染：精简/完整列表的 Markdown 列与页脚（隐藏空会话、元数据不可用、覆盖声明）以及 JSON 列字段与顶层覆盖声明。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderListJson } from "../scripts/lib/render-json.ts";
import { renderListMd } from "../scripts/lib/render-md.ts";
import type { ListOutcome, SessionCoverage } from "../scripts/lib/store-types.ts";
import { assertDocumentShape, coverage, field, listEntry, metadata } from "./render-helpers.ts";

describe("renderListMd / renderListJson", () => {
  it("精简列：表头/分隔行/数据行 + 页脚（含隐藏空会话、元数据不可用与覆盖声明）", () => {
    const outcome: ListOutcome = {
      entries: [
        listEntry("session-aaa-01"),
        listEntry(
          "session-bbb-02",
          {},
          metadata({
            available: false,
            reasons: ["projcache 记录缺失"],
            title: field<string>(null, true),
          }),
        ),
      ],
      matchedCount: 2,
      scannedCount: 3,
      hiddenBlankCount: 1,
      coverage: coverage({
        includedCount: 2,
        excluded: [{ id: "session-ccc-03", reason: "header 分类 malformed" }],
      }),
    };
    const rendered = renderListMd(outcome, { full: false });
    assertDocumentShape(rendered.content);
    assert.equal(rendered.content.startsWith("# 会话列表\n\n"), true);
    assert.equal(
      rendered.content.includes(
        "| ID | 标题 | 工作区 | 最近活动 | 轮次 | 类型 | 大小 |\n| --- | --- | --- | --- | --- | --- | --- |",
      ),
      true,
    );
    // 显示值必须与可传值同源：输出完整 id（此前输出 12 字符截断值，子代理 id 会因此歧义）。
    assert.equal(rendered.content.includes("| `session-aaa-01` |"), true);
    assert.equal(rendered.content.includes("| `session-bbb-02` |"), true);
    assert.equal(rendered.content.includes("`测试标题`"), true);
    assert.equal(rendered.content.includes("合计：匹配 2 个会话，显示 2 个（共扫描 3 个）"), true);
    assert.equal(rendered.content.includes("已隐藏空会话 1 个（--include-blank 显示）"), true);
    assert.equal(
      rendered.content.includes("元数据不可用：`session-bbb-02`（`projcache 记录缺失`）"),
      true,
    );
    assert.equal(rendered.content.includes("扫描会话 3 个；纳入 2 个；排除 1 个"), true);
    assert.equal(
      rendered.content.includes("排除会话：`session-ccc-03`（`header 分类 malformed`）"),
      true,
    );
    assert.equal(rendered.summary, "匹配会话 2 个，显示 2 个");
  });

  it("标题含管道符转义；空结果表格仍成立", () => {
    const piped: ListOutcome = {
      entries: [listEntry("session-aaa-01", {}, metadata({ title: field("a|b") }))],
      matchedCount: 1,
      scannedCount: 1,
      hiddenBlankCount: 0,
      coverage: coverage({ includedCount: 1 }),
    };
    assert.equal(renderListMd(piped, { full: false }).content.includes("`a\\|b`"), true);

    const empty: ListOutcome = {
      entries: [],
      matchedCount: 0,
      scannedCount: 0,
      hiddenBlankCount: 0,
      coverage: coverage(),
    };
    const rendered = renderListMd(empty, { full: false });
    assertDocumentShape(rendered.content);
    assert.equal(rendered.content.includes("合计：匹配 0 个会话，显示 0 个（共扫描 0 个）"), true);
    assert.equal(rendered.content.includes("扫描会话 0 个；纳入 0 个；排除 0 个"), true);
  });

  it("--full：列表形态（首行 + 两空格缩进续行）", () => {
    const outcome: ListOutcome = {
      entries: [listEntry("session-aaa-01")],
      matchedCount: 1,
      scannedCount: 1,
      hiddenBlankCount: 0,
      coverage: coverage({ includedCount: 1 }),
    };
    const rendered = renderListMd(outcome, { full: true });
    assertDocumentShape(rendered.content);
    assert.equal(rendered.content.includes("# 会话列表（完整）"), true);
    assert.equal(rendered.content.includes("- `session-aaa-01`：`测试标题`（主）"), true);
    assert.equal(rendered.content.includes("  **工作区**：`user_projects`"), true);
    assert.match(rendered.content, /^ {2}\*\*最近活动\*\*：\d{4}-\d{2}-\d{2}T/mu);
    assert.equal(rendered.content.includes("  **轮次**：3"), true);
    assert.equal(rendered.content.includes("  **大小**：2.0 KB"), true);
    assert.equal(rendered.content.includes("  **模型**：`provider-x/model-y`"), true);
    assert.equal(rendered.content.includes("  **令牌**：10/20/30/40"), true);
    assert.equal(rendered.content.includes("  **元数据**：projcache"), true);
  });

  it("JSON 含全部列字段、可用性标记与覆盖声明", () => {
    const outcome: ListOutcome = {
      entries: [listEntry("session-aaa-01")],
      matchedCount: 1,
      scannedCount: 1,
      hiddenBlankCount: 0,
      coverage: coverage({ includedCount: 1 }),
    };
    const document = JSON.parse(renderListJson(outcome)) as {
      sessions: Array<Record<string, unknown>>;
      coverage: SessionCoverage;
    };
    assert.equal(document.sessions.length, 1);
    assert.equal(document.sessions[0].id, "session-aaa-01");
    assert.equal("shortId" in document.sessions[0], false);
    assert.equal(document.sessions[0].title, "测试标题");
    assert.deepEqual(document.sessions[0].metadata, { available: true, reasons: [] });
    assert.deepEqual(document.coverage, { scannedCount: 1, includedCount: 1, excluded: [] });
  });
});
