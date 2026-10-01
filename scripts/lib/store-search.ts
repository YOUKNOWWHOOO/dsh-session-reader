// 检索层：检索单元构造（text/tools/all 三档单调包含）、逐会话全量计数检索、上下文切片、每会话命中分布。
// 主要入口：runSearch（search 命令数据）；collectSearchUnits 定义三档覆盖范围。
// 关键依赖：ask-user.ts（提问与回答的可读文本抽取，与 md 条目同源）、decode.ts（事件类型与正文/推理/
// 工具结果取值）、store-discovery.ts（发现、读取与扫描摘要）、store-list.ts（会话视图收集）、
// store-target.ts（--session/--exclude-session 子树展开）、store-types.ts。
// 设计约束：--limit 只限制 hits 数组的收集上限，totalHits 对纳入会话全量计数且不做任何提前终止
// （totalIsExact 恒为 true）；单会话解码失败记入 coverage.excluded 并继续，而不是让整次检索失败；
// scope=all 必须把整条事件记录的完整 JSON 载荷纳入检索单元（按类型枚举字段必然有遗漏）；
// 上下文章节按 Unicode 码点切片，避免在代理对中间切片。数据契约见 store-types.ts 文件头。

import {
  ASK_USER_PAYLOAD_MISMATCH_REASON,
  type AskUserEntry,
  analyzeAskUserEvents,
} from "./ask-user.ts";
import {
  asArray,
  asRecord,
  type EventRecord,
  eventSeq,
  eventTime,
  eventType,
  readString,
  reasoningFromBlocks,
  textFromBlocks,
  toolResultText,
} from "./decode.ts";
import { attributeSource, type SourceAttribution } from "./message-source.ts";
import type { Result } from "./paths.ts";
import {
  accumulateScanSummary,
  coverageOf,
  discoverReadableSessions,
  emptyScanSummary,
  entryIsSubagent,
  readSessionFile,
} from "./store-discovery.ts";
import { collectSessionViews } from "./store-list.ts";
import { collectSubtreeEntries, resolveTargetWithin } from "./store-target.ts";
import type {
  ScopeFilters,
  SearchHit,
  SearchOptions,
  SearchOutcome,
  SessionHitCount,
  StoreContext,
  StoreError,
} from "./store-types.ts";
import { catalogForEntry } from "./store-types.ts";

interface SearchUnit {
  readonly label: string;
  readonly text: string;
  /** 该单元所属事件的来源归属（仅 `user/message` 事件有值），随命中传给渲染层。 */
  readonly source: SourceAttribution | null;
}

/** 挂载来源前的中间形态：来源是事件级事实，`collectSearchUnits` 出口处统一挂载到全部单元。 */
interface TextUnit {
  readonly label: string;
  readonly text: string;
}

function joinTextParts(parts: string[]): string {
  return parts.filter((part) => part.length > 0).join("\n");
}

function messageContent(event: EventRecord): unknown {
  const message = asRecord(asRecord(event.data)?.message);
  return message === undefined ? undefined : message.content;
}

/**
 * 收集单个事件的可检索文本单元。
 *
 * 三档语义（单调包含）：
 * - `text`：用户/助手正文，以及 `ask` 给出的提问/回答可读文本；
 * - `tools`：另含工具调用参数与工具结果（含问答的原始载荷——问答事件本身就是工具的调用与结果）；
 * - `all`：另含推理、系统消息、压缩摘要、命令、标题请求、web 检索请求、交付物、待办、代理信箱，
 *   **以及整条事件记录的完整 JSON 载荷**（label 取事件类型）。
 *
 * `ask` 必须由调用方从 `ask-user.ts` 的分析结果里按事件取回，而不是在这里自行解析载荷：
 * 检索单元与 md 条目必须是同一份抽取的产物，否则调用方会读到"呈现里有、检索里没有"这类不一致
 * （或反过来）。三档都包含问答可读文本，是 `text ⊆ tools ⊆ all` 这一单调包含关系的要求。
 *
 * `all` 档的穷尽性是"检索 0 命中 ⇒ 不存在"这一推断成立的前提：按类型枚举字段必然有遗漏
 * （实测 `assistant/attempt` 与 `llm/retry` 的 `data.failure` 内嵌上游错误体，此前任何 scope 都检索不到），
 * 只有把整条记录纳入检索才能保证任意事件的任意字符串都可命中。
 *
 * 返回的每个单元都带上所属事件的来源归属（仅 `user/message` 事件非 null）：命中行的 `user` 标签
 * 会把子代理中继与插件注入显示成用户消息，来源归属是调用方区分它们的唯一依据。
 */
function collectSearchUnits(
  event: EventRecord,
  scope: "text" | "tools" | "all",
  ask: AskUserEntry | null,
): SearchUnit[] {
  const type = eventType(event);
  const units: TextUnit[] = [];
  if (type === "user/message") {
    const text = textFromBlocks(asRecord(event.data)?.content);
    if (text.length > 0) units.push({ label: "user", text });
  } else if (type === "assistant/message") {
    const text = textFromBlocks(messageContent(event));
    if (text.length > 0) units.push({ label: "assistant", text });
  } else if (scope !== "text" && type === "tool/call") {
    const argumentsText = readString(asRecord(event.data) ?? {}, "arguments");
    if (argumentsText !== undefined && argumentsText.length > 0) {
      units.push({ label: "tool/call", text: argumentsText });
    }
  } else if (scope !== "text" && type === "tool/result") {
    const text = toolResultText(event);
    if (text.length > 0) units.push({ label: "tool/result", text });
  }
  // 问答可读文本：单元名即时间线标签（`提问`/`回答`），文本与 md 条目逐字同源。
  if (ask !== null) units.push({ label: ask.label, text: ask.text });
  if (scope === "all") {
    if (type === "assistant/message") {
      const reasoning = reasoningFromBlocks(messageContent(event));
      if (reasoning.length > 0) units.push({ label: "assistant/reasoning", text: reasoning });
    } else if (type === "system/message") {
      const text = textFromBlocks(messageContent(event));
      if (text.length > 0) units.push({ label: "system", text });
    } else if (type === "compaction/summary") {
      const data = asRecord(event.data) ?? {};
      const text = joinTextParts([textFromBlocks(data.summary), textFromBlocks(data.rawOutput)]);
      if (text.length > 0) units.push({ label: "compaction/summary", text });
    } else if (type === "command/run") {
      const data = asRecord(event.data) ?? {};
      const name = readString(data, "name") ?? "";
      const args = data.args === undefined ? "" : JSON.stringify(data.args);
      const text = `${name} ${args}`.trim();
      if (text.length > 0) units.push({ label: "command/run", text });
    } else if (type === "command/done") {
      const text = readString(asRecord(event.data) ?? {}, "text") ?? "";
      if (text.length > 0) units.push({ label: "command/done", text });
    } else if (type === "session/title-llm-request") {
      const data = asRecord(event.data) ?? {};
      const system = readString(data, "system") ?? "";
      const messages = asArray(data.messages) ?? [];
      const parts = [system];
      for (const message of messages) {
        const record = asRecord(message);
        if (record === undefined) continue;
        parts.push(textFromBlocks(record.content));
      }
      const text = joinTextParts(parts);
      if (text.length > 0) units.push({ label: "title-request", text });
    } else if (type === "web/deepseek-search-llm-request") {
      const body = asRecord(event.data)?.body;
      if (body !== undefined) {
        const text = JSON.stringify(body);
        if (text.length > 0) units.push({ label: "web-search-request", text });
      }
    } else if (type === "deliverables/presented") {
      const files = asArray(asRecord(event.data)?.files) ?? [];
      const parts: string[] = [];
      for (const file of files) {
        const record = asRecord(file);
        if (record === undefined) continue;
        const description = readString(record, "description");
        const path = readString(record, "path");
        if (description !== undefined) parts.push(description);
        if (path !== undefined) parts.push(path);
      }
      const text = joinTextParts(parts);
      if (text.length > 0) units.push({ label: "deliverables", text });
    } else if (type === "todo/write") {
      const todos = asArray(asRecord(event.data)?.todos) ?? [];
      const parts: string[] = [];
      for (const todo of todos) {
        const record = asRecord(todo);
        if (record === undefined) continue;
        const content = readString(record, "content");
        const status = readString(record, "status");
        if (content !== undefined) parts.push(content);
        if (status !== undefined) parts.push(status);
      }
      const text = joinTextParts(parts);
      if (text.length > 0) units.push({ label: "todo", text });
    } else if (type === "agent/inbox/spliced") {
      const inserted = asArray(asRecord(event.data)?.inserted) ?? [];
      const parts: string[] = [];
      for (const message of inserted) {
        const record = asRecord(message);
        if (record === undefined) continue;
        parts.push(textFromBlocks(record.content));
      }
      const text = joinTextParts(parts);
      if (text.length > 0) units.push({ label: "agent/inbox", text });
    }
    // 穷尽兜底：把整条事件记录的完整 JSON 载荷作为检索单元。
    // 这是"检索 0 命中 ⇒ 不存在"能够成立的前提——上面按类型枚举的字段必然有遗漏
    // （实测遗漏的类型包括 assistant/attempt 与 llm/retry，其 data.failure 里内嵌了上游错误体），
    // 只有覆盖整条记录才能保证任意事件的任意字符串都可被检索到。label 取事件类型本身，便于定位。
    const raw = eventPayloadJson(event);
    if (raw.length > 0) units.push({ label: type.length === 0 ? "(未知类型)" : type, text: raw });
  }
  // 来源归属是**事件级**事实，一条事件的所有检索单元（含 all 档的整条载荷单元）共享同一份归属，
  // 因此在此统一挂载，避免各单元各自判别来源而产生不一致的答案。
  const source = type === "user/message" ? attributeSource(asRecord(event.data)?.source) : null;
  return units.map((unit) => ({ label: unit.label, text: unit.text, source }));
}

/**
 * 事件记录的完整 JSON 序列化载荷。
 *
 * 序列化失败不做兜底、直接抛出：`scope=all` 的穷尽性（"0 命中 ⇒ 不存在"）正是建立在"每个事件的
 * 完整记录都成为一个检索单元"之上，静默返回空串会让该承诺在没有任何信号的情况下失效——调用方
 * 会把"检索不到"读成"不存在"。这与 `render-show-md.ts` 的 `eventDataJson` 是同一选择（异常显性
 * 暴露，由 CLI 顶层映射为 `内部错误`）；官方库解码出的事件都是纯 JSON 值，异常在当前数据下不可达。
 */
function eventPayloadJson(event: EventRecord): string {
  return JSON.stringify(event);
}

/**
 * search 命令数据：按范围过滤会话，逐会话解码并按 scope 检索。
 *
 * 关键契约：
 * 1. `--limit` 只限制 `hits` 数组的收集上限，`totalHits` 对纳入会话全量计数且不做任何提前终止，
 *    因此"命中总数"不是显示条数的副产品（`totalIsExact` 恒为 true，证据见该字段注释）。
 * 2. 单个会话解码失败不会让整次检索失败，而是记入 `coverage.excluded`（原因="解码失败"）并继续。
 *    问答载荷结构不符的会话同样逐条列入排除项（原因=固定文本 `问答载荷结构不符合预期`）。两种情况
 *    都继续而不是整体失败，这是"未被列出者即为已覆盖"这一推断成立的前提——静默跳过或整体失败
 *    都会让调用方无法判断"0 命中"到底是"不存在"还是"没读到"。
 * 3. `distribution` 逐会话给出命中数（含 0 命中的纳入会话），使调用方能把自己会话与子代理会话的
 *    命中从结论中剔除；`excludeSessionTarget` 提供同一件事的自动化形式。
 *
 * @param sessionTarget 只检索该会话及其子代理子树；undefined 表示不限。
 * @param excludeSessionTarget 排除该会话及其子代理子树（与 `sessionTarget` 以差集生效）。
 */
export function runSearch(
  ctx: StoreContext,
  keyword: string,
  scopeFilters: ScopeFilters,
  options: SearchOptions,
  sessionTarget?: string,
  excludeSessionTarget?: string,
): Result<SearchOutcome, StoreError> {
  const discovery = discoverReadableSessions(ctx.dshHome, ctx.catalog);
  if (!discovery.success) return discovery;
  const discoveryCoverage = coverageOf(discovery.data);

  // `--session`/`--exclude-session` 的子树展开与目标解析共用同一次发现结果，
  // 避免重复扫描造成两次读取之间的一致性漂移。
  const subtreeIds = (target: string): Result<Set<string>, StoreError> => {
    const resolved = resolveTargetWithin(discovery.data, target, ctx.dshHome);
    if (!resolved.success) return resolved;
    const subtree = collectSubtreeEntries(resolved.data, discovery.data.entries);
    return { success: true, data: new Set(subtree.map((entry) => entry.id)) };
  };
  let sessionIds: Set<string> | null = null;
  if (sessionTarget !== undefined) {
    const resolved = subtreeIds(sessionTarget);
    if (!resolved.success) return resolved;
    sessionIds = resolved.data;
  }
  let excludedIds: Set<string> | null = null;
  if (excludeSessionTarget !== undefined) {
    const resolved = subtreeIds(excludeSessionTarget);
    if (!resolved.success) return resolved;
    excludedIds = resolved.data;
  }

  const selection = collectSessionViews(ctx, {
    workspace: scopeFilters.workspace,
    since: scopeFilters.since,
    until: scopeFilters.until,
    origin: scopeFilters.origin,
    includeBlank: true,
    limit: 0,
    sort: "time",
  });
  if (!selection.success) return selection;
  const views = selection.data.views.filter(
    (view) =>
      (sessionIds === null || sessionIds.has(view.entry.id)) &&
      (excludedIds === null || !excludedIds.has(view.entry.id)),
  );

  const needle = options.caseSensitive ? keyword : keyword.toLowerCase();
  const hits: SearchHit[] = [];
  let totalHits = 0;
  const excludedSessions: { id: string; reason: string }[] = [];
  const distribution: SessionHitCount[] = [];
  let scan = emptyScanSummary();
  for (const view of views) {
    const file = readSessionFile(view.entry, catalogForEntry(ctx, view.entry), {
      historicalChildFailures: ctx.historicalChildFailuresBySessionId.get(view.entry.id),
    });
    if (!file.success) {
      excludedSessions.push({ id: view.entry.id, reason: "解码失败" });
      scan = accumulateScanSummary(scan, {
        success: false,
        frameFailures: file.error.frameFailures ?? 0,
      });
      continue;
    }
    scan = accumulateScanSummary(scan, file.data.metrics);
    // 问答载荷结构不符：该会话不能进入本次结论（它的可读文本没被算出来，检索覆盖面因此不完整），
    // 但**不中断整条检索**——一份有问题的载荷不该让调用方无法检索其余会话。它与解码失败一样逐条
    // 列入 `coverage.excluded` 并排除出 `M`；日志本身解码成功，因此扫描摘要仍照常计入它。
    const askAnalysis = analyzeAskUserEvents(file.data.decoded.events);
    if (!askAnalysis.success) {
      excludedSessions.push({ id: view.entry.id, reason: ASK_USER_PAYLOAD_MISMATCH_REASON });
      continue;
    }
    const askEntries = new Map<EventRecord, AskUserEntry>();
    for (const entry of askAnalysis.data.entries) askEntries.set(entry.event, entry);
    let sessionHits = 0;
    for (const event of file.data.decoded.events) {
      for (const unit of collectSearchUnits(event, options.scope, askEntries.get(event) ?? null)) {
        const haystack = options.caseSensitive ? unit.text : unit.text.toLowerCase();
        let from = 0;
        for (;;) {
          const at = haystack.indexOf(needle, from);
          if (at < 0) break;
          totalHits += 1;
          sessionHits += 1;
          if (options.limit === 0 || hits.length < options.limit) {
            // 按 Unicode 码点计算上下文窗口（与 truncateText 同口径；先把 UTF-16 索引折算为码点数），
            // 避免在代理对（surrogate pair）中间切片产生孤立代理项（UTF-8 落盘后会变为 U+FFFD）。
            const points = [...unit.text];
            const startPoint = Math.max(0, [...unit.text.slice(0, at)].length - options.context);
            const endPoint = Math.min(
              points.length,
              [...unit.text.slice(0, at + needle.length)].length + options.context,
            );
            const excerpt = `${startPoint > 0 ? "…" : ""}${points.slice(startPoint, endPoint).join("")}${endPoint < points.length ? "…" : ""}`;
            hits.push({
              sessionId: view.entry.id,
              seq: eventSeq(event) ?? null,
              time: eventTime(event) ?? null,
              label: unit.label,
              // 文本输出要求“每命中一条”独占一行：片段内换行折叠为空格。
              excerpt: excerpt.replaceAll("\n", " "),
              source: unit.source,
            });
          }
          from = at + needle.length;
        }
      }
    }
    distribution.push({
      sessionId: view.entry.id,
      type: entryIsSubagent(view.entry) ? "subagent" : "main",
      title: view.metadata.title.value,
      hits: sessionHits,
    });
  }
  distribution.sort((left, right) => {
    if (left.hits !== right.hits) return right.hits - left.hits;
    return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0;
  });
  const shown = hits.length;
  const excluded = [...discoveryCoverage.excluded, ...excludedSessions];
  // 被排除的会话（解码失败或问答载荷结构不符）已逐条进入 `excluded`，`includedCount` 必须扣除它们：
  // 同一会话同时出现在"纳入"与"排除"两个数字里，会让 `N = M + K` 虽成立却失去"未被列出者即为
  // 已覆盖"的含义。两种排除各自只记一条，因此扣除条数即扣除会话数。
  const includedCount = views.length - excludedSessions.length;
  return {
    success: true,
    data: {
      hits,
      totalHits,
      scannedSessions: views.length,
      truncated: totalHits > shown,
      searchedSessions: views.length,
      scope: options.scope,
      totalIsExact: true,
      // `scannedCount` 由 `includedCount + excluded.length` 构造（`list`/`stats` 同此），因此恒等式
      // 必然成立、**不具备核对能力**：核对覆盖范围只能依据逐条列出的排除项。禁止把它表述为
      // "调用方据此核对是否存在未列出的漏读"（见 doc\开发规范.md 的覆盖声明契约）。
      coverage: {
        scannedCount: includedCount + excluded.length,
        includedCount,
        excluded,
      },
      scan,
      distribution,
    },
  };
}
