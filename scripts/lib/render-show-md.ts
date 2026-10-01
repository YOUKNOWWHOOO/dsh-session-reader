// 用途：show 的 Markdown 渲染——头部 KV 块、时间线（推理/工具/生命周期可见性、问答条目、turn/seq
// 范围筛选、head/tail 首尾截取、按码点截断、隐藏计数摘要）、轮次大纲，以及以 H2 序列 + 路径编号
// 表达父子关系的子代理块；`--probe` 只落头部 KV 与三项规模数字。
// 主要入口：renderShowMd（返回 Result：问答载荷结构不符时以错误上抛，由 CLI 映射为 `数据不可读`）；
// 范围筛选入口 selectEvents（供时间线取"呈现哪些事件"）。
// 关键依赖：ask-user.ts（问答条目的唯一抽取真值源）、render-core.ts（载体、ShowMdOptions/RenderedOutput、
// 会话派生事实）、render-md.ts（覆盖声明片段）、render-summary.ts（摘要文案）、decode.ts、paths.ts、
// store-types.ts。
// 设计约束：范围选择只改变"呈现哪些事件"，不改变 KV 块与轮次大纲所描述的整会话统计，并由筛选说明行
// 显式给出"显示 M 条 / 区间内 N 个 / 共 K 个"三个数字；`--turn`/`--seq` 作用于每个节点（子代理按自身
// 事件流计轮次），`--head`/`--tail` 只作用于根节点，`--probe` 只作用于根节点；任何会话来源文本都必须经
// 载体承载，禁止直接拼进骨架。层规则见 render-core.ts 文件头。
import { type AskUserAnalysis, type AskUserEntry, analyzeAskUserEvents } from "./ask-user.ts";
import {
  asRecord,
  type EventRecord,
  eventSeq,
  eventTime,
  eventType,
  readNumber,
  readString,
  reasoningFromBlocks,
  textFromBlocks,
  toolResultText,
} from "./decode.ts";
import { attributeSource, describeSource } from "./message-source.ts";
import { formatLocalIso, type Result } from "./paths.ts";
import {
  assembleDocument,
  computeEventStats,
  computeTurns,
  countNodes,
  EMPTY_VALUE,
  fenceBlock,
  findSessionTitle,
  formatSize,
  inlineValue,
  type RenderedOutput,
  type ShowMdOptions,
  sumUsage,
  truncateText,
} from "./render-core.ts";
import { coverageSections } from "./render-md.ts";
import { showProbeSummary, showSummary } from "./render-summary.ts";
import type { SessionNode } from "./store-types.ts";

// ------------------------- show -------------------------

interface HiddenCounts {
  reasoning: number;
  tools: number;
  events: number;
}

/**
 * 规模探测的三项读数。
 *
 * 三项都由调用方先量或先算后传入，而不是在这里内联求值：`estimatedBytes` 需要真的渲染一份
 * 完整副本（CPU 换确定性），问答计数需要先跑一遍问答抽取，两者都只在探测分支才值得付出。
 */
interface ProbeReadout {
  /** 以同一组选项渲染完整导出的正文字节数（UTF-8）。 */
  readonly estimatedBytes: number;
  /** 本会话的提问事件数（`P`）。 */
  readonly askQuestions: number;
  /** 本会话产出回答条目的结果数（`Q`；未配对或提问被中止/取消时小于 `P`）。 */
  readonly askAnswers: number;
}

/**
 * 事件载荷的 JSON 文本。
 *
 * 这里**不**捕获 `JSON.stringify` 的异常：一旦出现不可序列化的载荷，就说明上一步（官方库解码
 * 或夹具构造）已经偏离契约，任何占位文案都会以"看起来像正文"的形式混进产物，把真正的缺陷
 * 掩盖起来。让它抛错、由 CLI 顶层映射为 `内部错误`（退出 3），问题才会在第一时间显性暴露。
 */
function eventDataJson(event: EventRecord): string {
  return event.data === undefined ? "{}" : JSON.stringify(event.data);
}

function optionalInline(valueText: string | undefined): string {
  return valueText === undefined ? EMPTY_VALUE : inlineValue(valueText);
}

/**
 * show 头部 KV 块（一个多行段落；值经载体隔离；f2 R2-4）。
 *
 * `probe` 仅在规模探测时为非 null：探测会先做一次完整渲染来量出正文字节数（以"它自己的完整副本"
 * 为准，而不是估算公式），并给出问答事件计数；常规导出传 null，避免"顺手算一遍完整正文"的隐性成本。
 */
function nodeKvBlock(node: SessionNode, probe: ProbeReadout | null): string {
  const header = node.file.decoded.header;
  const usage = sumUsage(node.file);
  const stats = computeEventStats(node.file);
  const title = findSessionTitle(node.file);
  const origin = readString(header, "origin");
  const createdAt = readNumber(header, "createdAt");
  const lines: string[] = [
    `- ID：${inlineValue(node.entry.id)}`,
    `- 标题：${title === null ? EMPTY_VALUE : inlineValue(title)}`,
    `- 工作区：${optionalInline(readString(header, "cwd"))}`,
    // 缺 `createdAt` 时显示 `-`，禁止兜底到 0：兜底会把"字段缺失"伪装成一个有效时间（1970），
    // 与「空值显示 -」的契约冲突，也与同段 `- 深度：` 的口径不一致。
    `- 创建：${createdAt === undefined ? EMPTY_VALUE : formatLocalIso(createdAt)}`,
  ];
  if (origin === "subagent") {
    lines.push("- 类型：子代理");
    lines.push(`- 父会话：${optionalInline(readString(header, "parentSession"))}`);
    lines.push(`- 深度：${String(readNumber(header, "delegationDepth") ?? EMPTY_VALUE)}`);
  } else {
    lines.push("- 类型：主会话");
  }
  lines.push(`- 预设：${optionalInline(readString(header, "agentPreset"))}`);
  lines.push(`- 日志：${inlineValue(node.entry.logPath)}`);
  lines.push(
    `- 规模：${formatSize(node.entry.sizeBytes)}；v${String(node.entry.logVersion)}；${node.file.frames} 帧；${node.file.decoded.lineCount} 行；${node.file.decoded.events.length} 事件`,
  );
  lines.push(`- 轮次：${stats.turns}；步数：${stats.steps}；工具调用：${stats.toolCalls}`);
  lines.push(
    `- 令牌：输入 ${usage.input}；输出 ${usage.output}；缓存读 ${usage.cacheRead}；推理 ${usage.reasoning}`,
  );
  if (probe !== null) {
    lines.push(`- 预计字节数：${probe.estimatedBytes}（完整导出正文大小，按 UTF-8 计）`);
    lines.push(`- 消息数：${stats.userMessages} 用户 / ${stats.assistantMessages} 助手`);
    // 事件数口径：未配对、或提问被中止/取消时回答数小于提问数。计数只作用于主会话块（探测只作用于根块）。
    lines.push(`- 问答数：${probe.askQuestions} 提问 / ${probe.askAnswers} 回答`);
  }
  const anomalyDetails = node.file.decoded.anomalies.map((anomaly) => inlineValue(anomaly.detail));
  if (anomalyDetails.length > 0) lines.push(`- 异常：${anomalyDetails.join("；")}`);
  return lines.join("\n");
}

/**
 * 加粗标签行：禁止独立成段（MD036），恒以 `：` 收尾。
 * 括号内的标注项顺序固定为 `seq N` → 本地时间 → 来源；前两项仅 `--headers` 出现，来源项恒出现
 * （仅 `user/message` 事件、且来源不是用户本人时）。无任何标注项时括号整体不出现。
 */
function labelLine(base: string, event: EventRecord, options: ShowMdOptions): string {
  const items: string[] = [];
  if (options.headers) {
    const seq = eventSeq(event);
    const time = eventTime(event);
    items.push(`seq ${seq === undefined ? EMPTY_VALUE : String(seq)}`);
    items.push(time === undefined ? EMPTY_VALUE : formatLocalIso(time));
  }
  const source = sourceAnnotationOf(event);
  if (source !== null) items.push(source);
  return items.length === 0 ? `${base}：` : `${base}（${items.join("；")}）：`;
}

/**
 * 事件的来源标注：只有 `user/message` 事件需要它——它被渲染成 `**用户**`，会把子代理中继、
 * 插件注入等显示成用户消息；`**工具结果**`、`**系统消息**`、`**事件**`、`**提问**`、`**回答**`
 * 各有独立标签，不存在该歧义（问答条目的标签已表达"这是提问工具说的"）。
 */
function sourceAnnotationOf(event: EventRecord): string | null {
  if (eventType(event) !== "user/message") return null;
  return describeSource(attributeSource(asRecord(event.data)?.source));
}

function fencedItem(
  base: string,
  event: EventRecord,
  options: ShowMdOptions,
  payloadRaw: string,
): string[] {
  return [labelLine(base, event, options), fenceBlock(payloadRaw)];
}

/**
 * 事件所属轮次：优先取 `data.turn`；缺失时沿用"当前轮次"，由 `turn/start` 推进
 * （缺失 `data.turn` 的 `turn/start` 以计数 +1 推进）。与 `computeTurns` 同口径，
 * 避免同一事件在时间线与轮次大纲里归属不同轮次。
 * 首个 `turn/start` 之前的事件（权限、会话标题等）不归属任何轮次，返回 undefined。
 */
function eventTurnOf(
  event: EventRecord,
  currentTurn: number,
  previousTurnStarts: number,
): number | undefined {
  const explicit = readNumber(asRecord(event.data) ?? {}, "turn");
  if (explicit !== undefined) return explicit;
  if (isTurnStart(event)) return previousTurnStarts + 1;
  return currentTurn === 0 ? undefined : currentTurn;
}

function isTurnStart(event: EventRecord): boolean {
  return eventType(event) === "turn/start";
}

/**
 * 依 `--turn`／`--seq` 筛选事件序列（交集语义，区间含端点）。
 *
 * 语义分层的理由：范围选择只改变"呈现哪些事件"，不改变会话统计——KV 块与轮次大纲仍描述整会话，
 * 并由 `filterSummaryMd` 显式给出"显示 M 条事件（共 N 个事件）"，避免调用方把局部读成整体。
 */
export function selectEvents(
  events: readonly EventRecord[],
  options: ShowMdOptions,
): EventRecord[] {
  const turnRange = options.turnRange;
  const seqRange = options.seqRange;
  if (turnRange === null && seqRange === null) return [...events];
  const selected: EventRecord[] = [];
  let currentTurn = 0;
  let turnStarts = 0;
  for (const event of events) {
    const turnStart = isTurnStart(event);
    const turn = eventTurnOf(event, currentTurn, turnStarts);
    if (turnStart) turnStarts += 1;
    if (turn !== undefined) currentTurn = turn;
    if (turnRange !== null) {
      if (turn === undefined || turn < turnRange.from || turn > turnRange.to) continue;
    }
    if (seqRange !== null) {
      const seq = eventSeq(event);
      if (seq === undefined || seq < seqRange.from || seq > seqRange.to) continue;
    }
    selected.push(event);
  }
  return selected;
}

/**
 * 筛选说明行：仅在筛选生效时输出。三个数字必须同时给出，调用方才能区分
 * "筛选后的事件数"与"最终显示的时间线条目数"，不会把局部读成整体：
 * - `displayed`：最终写入产物的时间线条目数（已受 head/tail 影响）；
 * - `selected`：范围筛选（turn/seq）后的事件数；
 * - `total`：整会话事件数。
 */
function filterSummaryMd(
  options: ShowMdOptions,
  isRoot: boolean,
  displayed: number,
  selected: number,
  total: number,
): string | null {
  const parts: string[] = [];
  if (options.turnRange !== null) {
    parts.push(`turn ${options.turnRange.from}-${options.turnRange.to}`);
  }
  if (options.seqRange !== null) parts.push(`seq ${options.seqRange.from}-${options.seqRange.to}`);
  // `--head`/`--tail` 只裁剪根块（见 renderTimelineMd 的 limitItems）：子代理块必须省略这两段，
  // 否则会出现「首 3 条；显示 50 条时间线条目」这种同一行内自相矛盾的外观。
  if (isRoot && options.head > 0) parts.push(`首 ${options.head} 条`);
  if (isRoot && options.tail > 0) parts.push(`末 ${options.tail} 条`);
  if (parts.length === 0) return null;
  return `筛选：${parts.join("；")}；显示 ${displayed} 条时间线条目（区间内事件 ${selected} 个，共 ${total} 个事件）`;
}

/**
 * 渲染一条时间线条目（标签行 ＋ 正文载体），或计入隐藏计数，或返回 null（该事件不产出条目）。
 *
 * 拆分动机：`--head`/`--tail` 按"呈现条目数"截取，而不是按"事件数"截取——`turn/start`、
 * `turn/end`、`session/title` 等事件不产生条目，若先按事件截取会出现"要 5 条却一条都没显示"。
 *
 * 问答条目（`ask` 非 null）与原始工具条目是同一事件的两种形态：`--tools` 打开时先出原始条目、
 * 再出问答条目；关闭时该事件仍然产出问答条目。因此问答事件在 `--tools` 关闭时**不得**计入
 * `已隐藏 N 条工具调用/结果`——那会让调用方以为问答条目也被藏起来了，而它其实就在下一行。
 * `--role` 只过滤对话消息，工具与事件（含问答）不受影响。
 */
function timelineItem(
  event: EventRecord,
  options: ShowMdOptions,
  hidden: HiddenCounts,
  ask: AskUserEntry | null,
): string[] | null {
  const type = eventType(event);
  const data = asRecord(event.data) ?? {};
  const items: string[] = [];
  if (type === "user/message") {
    if (options.role === "assistant") return null;
    const text = textFromBlocks(data.content);
    if (text.length === 0) return null;
    return fencedItem("**用户**", event, options, truncateText(text, options.truncate));
  }
  if (type === "assistant/message") {
    if (options.role === "user") return null;
    const content = asRecord(data.message)?.content;
    const text = textFromBlocks(content);
    if (text.length > 0) {
      items.push(...fencedItem("**助手**", event, options, truncateText(text, options.truncate)));
    }
    const reasoning = reasoningFromBlocks(content);
    if (reasoning.length > 0) {
      if (options.thinking) {
        items.push(
          ...fencedItem("**推理**", event, options, truncateText(reasoning, options.truncate)),
        );
      } else {
        hidden.reasoning += 1;
      }
    }
    return items.length > 0 ? items : null;
  }
  if (type === "tool/call") {
    if (options.tools) {
      const name = readString(data, "name") ?? EMPTY_VALUE;
      const argumentsText = readString(data, "arguments") ?? "";
      items.push(
        ...fencedItem(
          `**工具调用**（${inlineValue(name)}）`,
          event,
          options,
          truncateText(argumentsText, options.truncate),
        ),
      );
    } else if (ask === null) {
      hidden.tools += 1;
    }
  } else if (type === "tool/result") {
    if (options.tools) {
      const isError = asRecord(data.error) !== undefined;
      items.push(
        ...fencedItem(
          `**工具结果**${isError ? "（错误）" : ""}`,
          event,
          options,
          truncateText(toolResultText(event), options.truncate),
        ),
      );
    } else if (ask === null) {
      hidden.tools += 1;
    }
  } else if (type === "system/message") {
    if (!options.events) {
      hidden.events += 1;
      return null;
    }
    return fencedItem(
      "**系统消息**",
      event,
      options,
      truncateText(textFromBlocks(asRecord(data.message)?.content), options.truncate),
    );
  } else {
    if (!options.events) {
      hidden.events += 1;
      return null;
    }
    // 事件载荷的截断口径与其它文本一致：由 `--truncate` 单独决定，`0` 即不截断。
    // 此前固定截到 200 字符且不读 `--truncate`，使"默认不截断"的契约在事件视图下静默失效。
    const payload = truncateText(eventDataJson(event), options.truncate);
    return [`${labelLine("**事件**", event, options)}${inlineValue(type)} ${inlineValue(payload)}`];
  }
  if (ask !== null) {
    items.push(
      ...fencedItem(`**${ask.label}**`, event, options, truncateText(ask.text, options.truncate)),
    );
  }
  return items.length > 0 ? items : null;
}

/**
 * 问答条目按"事件身份"索引。
 *
 * 键取事件对象本身而不是 seq：`--turn`/`--seq` 筛选返回的是同一批事件引用，因此按身份取回
 * 就自动继承事件级筛选，不需要为问答条目另写一套范围判断（另写一套必然会与事件筛选漂移）。
 */
function askEntriesByEvent(analysis: AskUserAnalysis): ReadonlyMap<EventRecord, AskUserEntry> {
  const map = new Map<EventRecord, AskUserEntry>();
  for (const entry of analysis.entries) map.set(entry.event, entry);
  return map;
}

/**
 * 渲染时间线：按事件顺序产出**条目**；`limitItems` 为真时按 `head`/`tail` 对**条目序列**做首尾截取。
 *
 * 条目的单位是"一个 `string[]`"（标签行 ＋ 正文围栏／单行载荷），而不是数组元素：`--head N` 的
 * `N` 在文档里定义为条目数，若对扁平的 `string[]` 做 `slice`，截断点会落在条目内部，产出
 * 孤立标签行或无标签围栏块，且说明行的计数与实物不符（`shownItems` 因此按条目计数）。
 * `head` 与 `tail` 互斥由 CLI 校验保证，此处按 head 优先处理，不做静默合并。
 */
function renderTimelineMd(
  options: ShowMdOptions,
  events: readonly EventRecord[],
  limitItems: boolean,
  askEntries: ReadonlyMap<EventRecord, AskUserEntry>,
): { sections: string[]; hidden: HiddenCounts; shownItems: number } {
  const hidden: HiddenCounts = { reasoning: 0, tools: 0, events: 0 };
  const items: string[][] = [];
  for (const event of events) {
    const item = timelineItem(event, options, hidden, askEntries.get(event) ?? null);
    if (item !== null) items.push(item);
  }
  let shown = items;
  if (limitItems && options.head > 0) {
    shown = items.slice(0, options.head);
  } else if (limitItems && options.tail > 0) {
    shown = items.slice(Math.max(0, items.length - options.tail));
  }
  return { sections: shown.flat(), hidden, shownItems: shown.length };
}

function hiddenSummaryMd(hidden: HiddenCounts, options: ShowMdOptions): string {
  const parts: string[] = [];
  if (hidden.reasoning > 0) parts.push(`已隐藏 ${hidden.reasoning} 条推理内容（--thinking 显示）`);
  if (hidden.tools > 0) parts.push(`已隐藏 ${hidden.tools} 条工具调用/结果（--tools 显示）`);
  if (hidden.events > 0) parts.push(`已隐藏 ${hidden.events} 条生命周期事件（--events 显示）`);
  if (options.role !== null) parts.push(`已按 --role ${options.role} 过滤对话消息`);
  if (options.truncate > 0) parts.push(`文本已截断为 ${options.truncate} 字符`);
  return parts.length > 0 ? `摘要：${parts.join("；")}` : "";
}

/**
 * 轮次大纲条目：`- T<turn>（seq <seq>）：<prompt> → <response>`。
 *
 * 截断口径与其它文本载体完全一致（`--truncate`，按码点，0 即不截断）：开发规范 R5 禁止为任何
 * 载体另设固定上限——"0 即不截断"若在某载体上被固定上限覆盖，调用方据 `--truncate 0` 推断全文
 * 就会读错。换行折叠为空格是单行载体的要求（每轮一条）。
 */
function outlineSections(node: SessionNode, options: ShowMdOptions): string[] {
  const turns = computeTurns(node.file);
  if (turns.length === 0) return ["无"];
  return turns.map((turn) => {
    const prompt =
      turn.prompt === null
        ? EMPTY_VALUE
        : inlineValue(truncateText(turn.prompt.replaceAll("\n", " "), options.truncate));
    const response =
      turn.response === null
        ? EMPTY_VALUE
        : inlineValue(truncateText(turn.response.replaceAll("\n", " "), options.truncate));
    return `- T${turn.turn}（seq ${turn.seq}）：${prompt} → ${response}`;
  });
}

/**
 * 单节点渲染：KV 块 →（摘要模式）轮次大纲 /（默认）时间线 → 子代理块（H2 序列、路径编号唯一）。
 * 主节点区块为 H2，子节点内容为各自 H2 下的 H3（MD024 同级唯一由路径编号保证）。
 *
 * 范围语义：`--turn`/`--seq` 作用于每个节点（含子代理，各自以自身事件流计轮次）；
 * `--head`/`--tail` 只作用于根节点——子代理被 `--subagents` 显式要求导出，静默截掉它们会让
 * "导出了全部子代理"这一预期落空，且产物中无从察觉。该不对称由 SKILL.md 显式声明。
 *
 * `--probe` 只作用于根节点：探测规模是一次"读之前"的动作，对子代理再各给一份正文就失去了意义。
 *
 * 返回 Result 而不是 `string[]` 的理由：问答载荷结构不符必须让整条命令失败（契约要求不产出任何
 * 降级内容），而失败可能来自任意一个子代理块，因此必须沿递归原路上抛，不能就地吞掉或跳过
 * ——那正是"静默丢弃"。
 */
function renderNodeSections(
  node: SessionNode,
  options: ShowMdOptions,
  level: number,
  childPath: string,
  isRoot: boolean,
): Result<string[], string> {
  const timelineMode = !options.probe && !options.summary;
  const probeMode = isRoot && options.probe;
  let askEntries: ReadonlyMap<EventRecord, AskUserEntry> = new Map();
  let probe: ProbeReadout | null = null;
  // 问答抽取只在"会用到"时进行：时间线模式需要条目；探测模式需要计数（并会连带渲染完整副本，
  // 因此结构不符同样要在探测阶段暴露）。`--summary` 不输出这两类条目，`json`/`jsonl` 不走本函数。
  if (timelineMode || probeMode) {
    const computed = analyzeAskUserEvents(node.file.decoded.events);
    if (!computed.success) return computed;
    if (probeMode) {
      const measured = probeSizeOf(node, options);
      if (!measured.success) return measured;
      probe = {
        estimatedBytes: measured.data,
        askQuestions: computed.data.questionCount,
        askAnswers: computed.data.answerCount,
      };
    }
    if (timelineMode) askEntries = askEntriesByEvent(computed.data);
  }
  const sections: string[] = [nodeKvBlock(node, probe)];
  if (options.probe) {
    // 探测模式下不输出任何会话正文：产物只回答"有多大、有多少条"。
  } else if (options.summary) {
    sections.push(`${"#".repeat(level)} 轮次大纲`);
    sections.push(...outlineSections(node, options));
  } else {
    sections.push(`${"#".repeat(level)} 时间线`);
    const ranged = selectEvents(node.file.decoded.events, options);
    const timeline = renderTimelineMd(options, ranged, isRoot, askEntries);
    sections.push(...timeline.sections);
    const filterText = filterSummaryMd(
      options,
      isRoot,
      timeline.shownItems,
      ranged.length,
      node.file.decoded.events.length,
    );
    if (filterText !== null) sections.push(filterText);
    const summaryText = hiddenSummaryMd(timeline.hidden, options);
    if (summaryText.length > 0) sections.push(summaryText);
  }
  if (options.subagents) {
    for (let index = 0; index < node.children.length; index += 1) {
      const child = node.children[index];
      const path = childPath.length === 0 ? String(index + 1) : `${childPath}.${index + 1}`;
      const childSections = renderNodeSections(child, options, 3, path, false);
      if (!childSections.success) return childSections;
      sections.push(`## 子代理 ${path}`);
      sections.push(...childSections.data);
    }
  }
  return { success: true, data: sections };
}

/** show Markdown：头部 KV + 时间线/轮次大纲 + 覆盖声明；子代理可选追加。 */
export function renderShowMd(
  node: SessionNode,
  options: ShowMdOptions,
): Result<RenderedOutput, string> {
  const nodeSections = renderNodeSections(node, options, 2, "", true);
  if (!nodeSections.success) return nodeSections;
  const sections = ["# 会话记录", ...nodeSections.data];
  if (!options.probe) {
    // 覆盖声明属于"边界可自证"契约，show 同样必须给出（开发规范「覆盖声明契约」）。作用域是本目标
    // 及其子树，纳入数即渲染出的节点数；子代理解码失败会让整条命令显式失败（退出 3），因此可归属的
    // 排除项恒为空，header 不可读的子代理只能以「归属未知」声明。`--probe` 产物按规模探测条款
    // 只含头部 KV 与三项，故不追加。
    const nodes = countNodes(node);
    sections.push(
      ...coverageSections({
        scannedCount: nodes,
        includedCount: nodes,
        excluded: [],
        unattributable: options.unattributable,
      }),
    );
  }
  const stats = computeEventStats(node.file);
  // 探测分支才量正文字节数：`probeSizeOf` 会再渲染一份完整副本，非探测路径不得提前求值。
  if (!options.probe) {
    return {
      success: true,
      data: { content: assembleDocument(sections), summary: showSummary(node, options, stats) },
    };
  }
  const measured = probeSizeOf(node, options);
  if (!measured.success) return measured;
  return {
    success: true,
    data: {
      content: assembleDocument(sections),
      summary: showProbeSummary(node, measured.data),
    },
  };
}

/**
 * 完整导出的正文字节数（UTF-8），供 `--probe` 给出"读之前"的规模。
 *
 * 实现取"以同一组选项渲染一份不探测的副本"的字节长度，而不是估算公式：
 * 估算要重复渲染规则（含围栏动态长度、截断、归一化），必然与真实产出漂移，
 * 而"预计 N 字节"一旦漂移就会让调用方的容量判断失效。代价是探测时多做一次渲染（CPU 换确定性）。
 * 副本渲染同样是单目标渲染，因此问答载荷结构不符时它也失败——"预计字节数"不能建立在一份
 * 本来就不该产出的正文之上。
 */
function probeSizeOf(node: SessionNode, options: ShowMdOptions): Result<number, string> {
  const full = renderShowMd(node, { ...options, probe: false });
  if (!full.success) return full;
  return { success: true, data: Buffer.byteLength(full.data.content, "utf8") };
}
