// 用途：命令级摘要文案（stdout 第二行的唯一真值源）——list/show/show --format jsonl/search/stats/check
// 各一句话摘要；md 渲染器的产物摘要与 CLI 的 json 路径摘要共用同一份措辞，避免 md/json 两条路径漂移。
// 主要入口：listSummary / showSummary / showJsonlSummary / searchSummary / formatStatsSummary / checkSummary。
// 关键依赖：render-core.ts（空值与"元数据不可用"文案、ShowMdOptions、会话派生统计类型、countNodes）、
// store-types.ts（各命令 outcome 类型）。
// 设计约束：摘要只描述产物的规模与口径，不得引入产物未支撑的断言；文案与标点是面向用户的对外契约，
// 不得改写；本模块不渲染正文，因此对 md 载体零依赖。show 的 `probeBytes` 以惰性回调传入：
// 只有规模探测分支需要量一次完整副本，常规导出若提前求值就会白做一次完整渲染。
import {
  countNodes,
  EMPTY_VALUE,
  METADATA_UNAVAILABLE_TEXT,
  type SessionEventStats,
  type ShowMdOptions,
} from "./render-core.ts";
import type {
  CheckOutcome,
  ListOutcome,
  SearchOutcome,
  SessionNode,
  StatsOutcome,
} from "./store-types.ts";

/** list 命令级摘要。 */
export function listSummary(outcome: ListOutcome): string {
  return `匹配会话 ${outcome.matchedCount} 个，显示 ${outcome.entries.length} 个`;
}

/**
 * show 命令级摘要（正文导出/摘要导出/规模探测三种形态）。
 *
 * `probeBytes` 只在探测分支被调用：该分支的字节数来自"以同一组选项渲染一份不探测的副本"，
 * 非探测路径调用它只会白白多渲染一份完整正文。
 */
export function showSummary(
  node: SessionNode,
  options: ShowMdOptions,
  stats: SessionEventStats,
  probeBytes: () => number,
): string {
  return options.probe
    ? `会话 ${node.entry.id}（规模探测）；事件 ${node.file.decoded.events.length} 个；预计正文 ${probeBytes()} 字节`
    : options.summary
      ? `会话 ${node.entry.id}（摘要）；轮次 ${stats.turns} 个`
      : `会话 ${node.entry.id}；事件 ${node.file.decoded.events.length} 个` +
        (options.subagents ? `；子代理 ${countNodes(node) - 1} 个` : "");
}

/** show --format jsonl 命令级摘要（逐事件穷尽导出，产物不含子代理）。 */
export function showJsonlSummary(node: SessionNode): string {
  return `会话 ${node.entry.id}；事件 ${node.file.decoded.events.length} 个`;
}

/** search 命令级摘要。 */
export function searchSummary(outcome: SearchOutcome): string {
  return `命中 ${outcome.totalHits} 处，显示 ${outcome.hits.length} 处`;
}

/**
 * stats 命令级摘要（md 摘要行与 CLI json 路径共用，单一真值源）。
 * 不可用指标不再静默显 0：unavailable → `元数据不可用`、value=null → `-`；
 * 全局聚合的轮次/步数只累计可用值，未计入会话数显式附注（原因见输出文件）。
 */
export function formatStatsSummary(outcome: StatsOutcome): string {
  if (outcome.single !== null) {
    const single = outcome.single;
    const turns = single.turns.unavailable
      ? METADATA_UNAVAILABLE_TEXT
      : single.turns.value === null
        ? EMPTY_VALUE
        : String(single.turns.value);
    return `会话 ${single.id}；轮次 ${turns}；工具调用 ${single.toolCalls}`;
  }
  const excluded =
    outcome.excludedMetricSessions > 0
      ? `（${outcome.excludedMetricSessions} 个会话未计入，原因见输出文件）`
      : "";
  return `会话 ${outcome.sessionCount} 个；总轮次 ${outcome.turns}；工具调用 ${outcome.toolCalls}${excluded}`;
}

/** check 命令级摘要。 */
export function checkSummary(outcome: CheckOutcome): string {
  return `会话 ${outcome.sessions.length} 个；异常 ${outcome.anomalyCount} 项`;
}
