// 用途：聚合命令的 Markdown 渲染——list 的精简表格/`--full` 记录块、search 的命中列表与口径说明、
// stats 的全局/单会话 KV、check 的逐会话诊断，以及各命令共用的 md 片段（覆盖声明、扫描摘要、
// 每会话命中分布）。show 的 md 单独在 render-show-md.ts（它有独立的可见性/范围/截断管线），但复用
// 这里的覆盖声明片段。
// 主要入口：renderListMd / renderSearchMd / renderStatsMd / renderCheckMd；共用片段 coverageSections /
// scanSections / distributionSections。
// 关键依赖：render-core.ts（载体、归一化、字段值与文档装配）、render-summary.ts（命令级摘要文案）、
// paths.ts（本地时间）、store-types.ts（outcome 类型）。json/jsonl 与载体的层规则见 render-core.ts 文件头。
// 设计约束：结构骨架只用固定词表，任意会话来源文本一律经载体承载；覆盖声明必须逐条列出排除项
// （`N = M + K` 是"未被列出者即为已覆盖"的唯一依据，禁止合并成计数）；摘要文案不在本模块内联，
// 统一取自 render-summary.ts，避免 md 与 json 两条路径的措辞漂移。
import { formatLocalIso } from "./paths.ts";
import {
  assembleDocument,
  EMPTY_VALUE,
  fieldValueText,
  formatSize,
  inlineValue,
  METADATA_UNAVAILABLE_TEXT,
  modelText,
  type RenderedOutput,
  tableCellValue,
  tokenTotalsText,
  truncateText,
} from "./render-core.ts";
import { checkSummary, formatStatsSummary, listSummary, searchSummary } from "./render-summary.ts";
import type {
  CheckOutcome,
  ListEntry,
  ListOutcome,
  ScanSummary,
  SearchOutcome,
  SessionCoverage,
  SessionHitCount,
  SingleSessionStats,
  StatsOutcome,
} from "./store-types.ts";

/** 每会话命中分布表格里标题的最大长度（超出按码点截断，避免单行无界增长）。 */
const DISTRIBUTION_TITLE_LIMIT = 40;

// ------------------------- 覆盖声明（P2/P3/P7） -------------------------

/**
 * 覆盖声明的 md 片段。
 *
 * 契约：`扫描会话 N 个；纳入 M 个；排除 K 个`，随后逐条 `排除会话：<完整 id>（<原因>）`，
 * 再逐条 `归属未知：<id>（<原因>）`（仅 `show` 可能有内容）。
 * 恒等式 `N = M + K` 必须成立——调用方据此核对是否存在未列出的漏读；这是"未被列出者即为已覆盖"
 * 这一推断的唯一依据，因此排除项必须逐条列出，禁止合并成计数。归属未知项不计入 `N`/`M`/`K`：
 * 连"是否属于本次作用域"都无法判定，把它算进任何一项都会让恒等式失去含义。
 */
export function coverageSections(coverage: SessionCoverage): string[] {
  const sections = [
    `扫描会话 ${coverage.scannedCount} 个；纳入 ${coverage.includedCount} 个；排除 ${coverage.excluded.length} 个`,
  ];
  for (const excluded of coverage.excluded) {
    sections.push(`排除会话：${inlineValue(excluded.id)}（${inlineValue(excluded.reason)}）`);
  }
  const unattributable = coverage.unattributable;
  if (unattributable !== undefined) {
    for (const unknown of unattributable) {
      sections.push(`归属未知：${inlineValue(unknown.id)}（${inlineValue(unknown.reason)}）`);
    }
  }
  return sections;
}

/**
 * 扫描摘要的 md 片段（"0 命中"的分母）：
 * 解码日志份数、读到的事件数、解码失败份数、帧解压失败帧数、观测到的事件时间范围。
 * 时间范围为空时显示 `-`（禁止留空或省字段，否则调用方无法区分"没有事件"与"没统计"）。
 */
export function scanSections(scan: ScanSummary): string[] {
  const from = scan.observedFrom === null ? EMPTY_VALUE : formatLocalIso(scan.observedFrom);
  const to = scan.observedTo === null ? EMPTY_VALUE : formatLocalIso(scan.observedTo);
  return [
    `扫描明细：解码日志 ${scan.logsDecoded} 份；读到事件 ${scan.eventsRead} 个；解码失败 ${scan.decodeFailures} 份；帧解压失败 ${scan.frameFailures} 帧`,
    `事件时间范围：${from} ~ ${to}`,
  ];
}

/**
 * 每会话命中分布的 md 表格（含 0 命中的纳入会话）。
 *
 * 存在理由（对应"检索被调用方自己的语料污染"）：检索在全库上做，发起检索的会话与它派出的子代理
 * 会话也在库里，调查结论与复述过的错误串都会被命中。只给一个总数会把污染藏起来；给出逐会话分布，
 * 调用方才能区分"真实会话命中"与"自己的笔记命中"。
 */
export function distributionSections(distribution: readonly SessionHitCount[]): string[] {
  if (distribution.length === 0) return [];
  const rows = distribution.map((item) => {
    const title =
      item.title === null
        ? EMPTY_VALUE
        : tableCellValue(truncateText(item.title, DISTRIBUTION_TITLE_LIMIT));
    return `| ${tableCellValue(item.sessionId)} | ${item.type === "subagent" ? "子" : "主"} | ${title} | ${item.hits} |`;
  });
  return [
    "## 每会话命中分布",
    ["| 会话 | 类型 | 标题 | 命中 |", "| --- | --- | --- | --- |", ...rows].join("\n"),
    "用 --exclude-session <标识> 排除调用方自己的会话及其子代理子树。",
  ];
}

// ------------------------- list -------------------------

/** list Markdown：表格式精简列；--full 使用记录列表（含两空格缩进的续行；f2 R1-6/R2-4）。 */
export function renderListMd(
  outcome: ListOutcome,
  options: { readonly full: boolean },
): RenderedOutput {
  const sections: string[] = [];
  if (!options.full) {
    sections.push("# 会话列表");
    const titleCell = (entry: ListEntry): string =>
      entry.metadata.title.unavailable
        ? METADATA_UNAVAILABLE_TEXT
        : entry.metadata.title.value === null
          ? EMPTY_VALUE
          : tableCellValue(entry.metadata.title.value);
    const rows = outcome.entries.map((entry) => {
      const cells = [
        // 显示值必须与可传值同源：输出完整 id，调用方可直接交给 show/stats/check/--session。
        tableCellValue(entry.id),
        titleCell(entry),
        entry.workspaceTitle === null ? EMPTY_VALUE : tableCellValue(entry.workspaceTitle),
        formatLocalIso(entry.lastActivityAt),
        fieldValueText(entry.metadata.turns, String),
        entry.type === "subagent" ? "子" : "主",
        formatSize(entry.sizeBytes),
      ];
      return `| ${cells.join(" | ")} |`;
    });
    sections.push(
      [
        "| ID | 标题 | 工作区 | 最近活动 | 轮次 | 类型 | 大小 |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        ...rows,
      ].join("\n"),
    );
  } else {
    sections.push("# 会话列表（完整）");
    for (const entry of outcome.entries) {
      const title = entry.metadata.title.unavailable
        ? METADATA_UNAVAILABLE_TEXT
        : entry.metadata.title.value === null
          ? EMPTY_VALUE
          : inlineValue(entry.metadata.title.value);
      const firstLine = `- ${inlineValue(entry.id)}：${title}（${entry.type === "subagent" ? "子" : "主"}）`;
      const detailLines = [
        `  **工作区**：${entry.workspaceTitle === null ? EMPTY_VALUE : inlineValue(entry.workspaceTitle)}`,
        `  **最近活动**：${formatLocalIso(entry.lastActivityAt)}`,
        `  **轮次**：${fieldValueText(entry.metadata.turns, String)}`,
        `  **大小**：${formatSize(entry.sizeBytes)}`,
        `  **创建**：${formatLocalIso(entry.createdAt)}`,
        `  **cwd**：${entry.cwd === null ? EMPTY_VALUE : inlineValue(entry.cwd)}`,
        `  **预设**：${fieldValueText(entry.metadata.agentPreset, (value) => inlineValue(value))}`,
        `  **模型**：${fieldValueText(entry.metadata.model, (model) => inlineValue(modelText(model)))}`,
        `  **令牌**：${fieldValueText(entry.metadata.tokens, tokenTotalsText)}`,
        `  **元数据**：${
          entry.metadata.available
            ? entry.metadata.reasons.length > 0
              ? "部分缺失"
              : "projcache"
            : "不可用"
        }`,
      ];
      sections.push(`${firstLine}\n${detailLines.join("\n")}`);
    }
  }
  sections.push(
    `合计：匹配 ${outcome.matchedCount} 个会话，显示 ${outcome.entries.length} 个（共扫描 ${outcome.scannedCount} 个）`,
  );
  if (outcome.hiddenBlankCount > 0) {
    sections.push(`已隐藏空会话 ${outcome.hiddenBlankCount} 个（--include-blank 显示）`);
  }
  for (const entry of outcome.entries) {
    if (entry.metadata.reasons.length > 0) {
      sections.push(
        `元数据不可用：${inlineValue(entry.id)}（${entry.metadata.reasons
          .map((reason) => inlineValue(reason))
          .join("；")}）`,
      );
    }
  }
  sections.push(...coverageSections(outcome.coverage));
  return {
    content: assembleDocument(sections),
    summary: listSummary(outcome),
  };
}

// ------------------------- search -------------------------

/** 检索范围的覆盖面描述（使"0 命中"不被误读为"不存在"：只有 all 档才覆盖任意事件记录）。 */
const SCOPE_COVERAGE_TEXT: Record<SearchOutcome["scope"], string> = {
  text: "仅用户/助手正文",
  tools: "另含工具参数与结果",
  all: "穷尽（另含推理/系统/压缩/命令/标题请求/web 请求/交付物/待办/代理信箱与每条事件载荷）",
};

/**
 * search Markdown：命中列表（单行载体）+ 统计口径 + 覆盖声明。
 * 统计口径含 `--scope` 取值、其覆盖面描述与"命中总数是否为精确值"，
 * 使调用方无需读源码即可判断"0 命中"能否当作"不存在"。
 */
export function renderSearchMd(outcome: SearchOutcome): RenderedOutput {
  const sections = ["# 检索结果"];
  for (const hit of outcome.hits) {
    const seqText = hit.seq === null ? EMPTY_VALUE : String(hit.seq);
    sections.push(
      `- ${inlineValue(hit.sessionId)}（seq ${seqText}）${inlineValue(hit.label)}：${inlineValue(hit.excerpt)}`,
    );
  }
  const truncatedNote = outcome.truncated
    ? `；已截断显示 ${outcome.hits.length} 条（--limit 0 显示全部）`
    : "";
  sections.push(`命中总数：${outcome.totalHits}${truncatedNote}`);
  sections.push(
    `检索范围：${outcome.scope}（${SCOPE_COVERAGE_TEXT[outcome.scope]}）；命中总数 ${outcome.totalHits} 为${outcome.totalIsExact ? "精确值" : "下界"}`,
  );
  sections.push(...coverageSections(outcome.coverage));
  sections.push(...scanSections(outcome.scan));
  sections.push(...distributionSections(outcome.distribution));
  return {
    content: assembleDocument(sections),
    summary: searchSummary(outcome),
  };
}

// ------------------------- stats -------------------------

/** stats Markdown：全局=KV 列表；单会话=KV 列表。 */
export function renderStatsMd(outcome: StatsOutcome): RenderedOutput {
  const sections = ["# 统计"];
  if (outcome.single !== null) {
    const single: SingleSessionStats = outcome.single;
    sections.push(
      [
        `- 会话：${inlineValue(single.id)}`,
        `- 空会话：${fieldValueText(single.blank, (value) => (value ? "是" : "否"))}`,
        `- 轮次：${fieldValueText(single.turns, String)}`,
        `- 步数：${fieldValueText(single.steps, String)}`,
        `- 工具调用：${single.toolCalls}`,
        `- 令牌：未缓存输入 ${fieldValueText(single.tokens, (tokens) => String(tokens.uncachedInputTokens))}；输出 ${fieldValueText(single.tokens, (tokens) => String(tokens.outputTokens))}；缓存读 ${fieldValueText(single.tokens, (tokens) => String(tokens.cacheReadTokens))}；缓存写 ${fieldValueText(single.tokens, (tokens) => String(tokens.cacheWriteTokens))}`,
        `- 创建：${formatLocalIso(single.createdAt)}`,
        `- 最近活动：${formatLocalIso(single.lastActivityAt)}`,
        `- 标题：${fieldValueText(single.title, (value) => inlineValue(value))}`,
        `- 预设：${fieldValueText(single.agentPreset, (value) => inlineValue(value))}`,
        `- 模型：${fieldValueText(single.model, (model) => inlineValue(modelText(model)))}`,
        `- 日志：${inlineValue(single.logPath)}`,
        `- 大小：${formatSize(single.sizeBytes)}`,
      ].join("\n"),
    );
    if (single.metadataReasons.length > 0) {
      sections.push(
        `元数据不可用：${single.metadataReasons.map((reason) => inlineValue(reason)).join("；")}`,
      );
    }
    sections.push(...coverageSections(outcome.coverage));
    sections.push(...scanSections(outcome.scan));
    return {
      content: assembleDocument(sections),
      summary: formatStatsSummary(outcome),
    };
  }
  const earliest =
    outcome.earliestCreatedAt === null ? EMPTY_VALUE : formatLocalIso(outcome.earliestCreatedAt);
  const latest =
    outcome.latestActivityAt === null ? EMPTY_VALUE : formatLocalIso(outcome.latestActivityAt);
  sections.push(
    [
      `- 会话数：${outcome.sessionCount}`,
      `- 空会话数：${outcome.blankCount}`,
      `- 总轮次：${outcome.turns}`,
      `- 总步数：${outcome.steps}`,
      `- 工具调用总数：${outcome.toolCalls}`,
      `- 令牌-未缓存输入：${outcome.tokens.uncachedInputTokens}`,
      `- 令牌-输出：${outcome.tokens.outputTokens}`,
      `- 令牌-缓存读：${outcome.tokens.cacheReadTokens}`,
      `- 令牌-缓存写：${outcome.tokens.cacheWriteTokens}`,
      `- 时间跨度：${earliest} ~ ${latest}`,
      `- 日志总大小：${formatSize(outcome.totalSizeBytes)}`,
    ].join("\n"),
  );
  for (const unavailable of outcome.unavailable) {
    sections.push(
      `元数据不可用：${inlineValue(unavailable.id)}（${unavailable.reasons
        .map((reason) => inlineValue(reason))
        .join("；")}）`,
    );
  }
  sections.push(...coverageSections(outcome.coverage));
  sections.push(...scanSections(outcome.scan));
  return {
    content: assembleDocument(sections),
    summary: formatStatsSummary(outcome),
  };
}

// ------------------------- check -------------------------

/** check Markdown：逐会话一条（异常详情同行）；结论段落。 */
export function renderCheckMd(outcome: CheckOutcome): RenderedOutput {
  const sections = ["# 完整性校验"];
  for (const session of outcome.sessions) {
    const seqText =
      session.seqContiguous === null ? EMPTY_VALUE : session.seqContiguous ? "连续" : "不连续";
    const fields = [
      `v=${session.formatVersion === null ? EMPTY_VALUE : String(session.formatVersion)}`,
      `结构=${session.structure}`,
      `帧=${session.frames === null ? EMPTY_VALUE : String(session.frames)}`,
      `行=${session.lineCount === null ? EMPTY_VALUE : String(session.lineCount)}`,
      `seq=${seqText}`,
      `坏行=${session.badLineCount}`,
      `异常=${session.anomalies.length}`,
    ];
    let line = `- ${inlineValue(session.id)}：${fields.join("；")}`;
    if (session.anomalies.length > 0) {
      line += `；异常详情：${session.anomalies.map((anomaly) => inlineValue(anomaly)).join("；")}`;
    }
    sections.push(line);
  }
  sections.push(
    outcome.anomalyCount === 0 ? "结论：无异常" : `结论：发现 ${outcome.anomalyCount} 项异常`,
  );
  sections.push(...coverageSections(outcome.coverage));
  return {
    content: assembleDocument(sections),
    summary: checkSummary(outcome),
  };
}
