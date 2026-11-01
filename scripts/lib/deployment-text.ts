// 用途：部署侧边界标记的解析与剥离，`<dsh-injection …>…</dsh-injection>`（用户角色注入消息）、
// `<dsh-message role="…" …>…</dsh-message>`（真实用户消息与带文本块的 assistant 消息，即消息时间
// 标记）、`<dsh-result …>…</dsh-result>`（普通工具结果），以及普通消息交接的 `<compacted-summary>` 信封。
// 主要入口：stripInjectionEnvelopes（宽松：完整才剥离，不完整原样返回）、stripMessageEnvelope（宽松：
// 消息信封最多一个且位于最外层）、stripResultEnvelope（严格：不完整返回 null，供问答载荷解析显式
// 失败）、stripResultEnvelopeLenient（宽松：不完整原样返回）、compactedSummaryBody（完整信封时取内层
// 正文）、stripNestedMessageEnvelope（交接摘要内层的消息信封残形）、cleanCompactedSummary（清理摘要
// 内层残形并保留标签）、stripNestedMessageMarkers（正文里内联引用的整段标记行对）、
// normalizeSessionTitle（把部署标记残片标题收敛为“没有标题”）。
// 关键依赖：无（纯字符串函数，不依赖事件模型，便于单测与复用）。
// 设计约束：
// 1. 标记形态、转义规则与幂等判据的唯一实现处是 `$DSH_HOME/preset-lib/injection-boundary.mjs`；
//    本文件只解析它产出的形态，不生成标记，也不维护第二份形态定义。写入侧把正文里的终点字面量
//    转义为 `<\/…>`，因此“第一个未转义的终点”就是真实终点。
// 2. 完整信封的判据只有三条且缺一不可：以起点前缀加一个空格开头、起点行在首个换行处结束、
//    终点前有一个换行且其后紧接文本结尾或另一个换行（允许两个注入信封顺序排列）。三种信封共用
//    这一组判据，只有起点前缀与终点字面量不同。剥离只认完整信封；不完整或形态异常时**原样返回**，
//    不尽力截取，半截信封下截出的任何内容都不再等于被记录的那份正文。
// 3. 严格版 stripResultEnvelope 保留旧行为：不以起点开头按原正文返回，以起点开头但不完整返回 null。
//    问答载荷是内容载体，解析不出来必须整体失败；普通工具结果的展示没有这个依赖，因此用宽松版。
// 4. 消息信封没有严格版：它不承载需要解析的结构化载荷，展示面与检索面一律用宽松版。消息信封最多
//    一个且是真实用户消息或 assistant 消息的最外层，因此不做顺序排列的循环；终点之后还有内容时
//    不是完整信封，原样返回。
// 5. 只有两类内层形态允许剥“非完整”结构，判据都是确定的写入结果而不是尽力截取：
//    其一是 `<compacted-summary>` 内层的消息信封残形，判据三条缺一不可（消息起点前缀、起点行以
//    `>` 收尾、末尾是换行加转义终点）；其二是正文里内联引用整段发言时出现的一对标记行，判据两条
//    （起点行独占一行且以 `>` 收尾、其后第一个转义终点行也独占一行），只删这两行、中间正文逐字
//    保留，找不到成对时整段原样返回。两者都不反转义。
// 6. 本模块不判断"该不该显示某条消息"（那是 visibility.ts 的职责），只负责把部署包装从可读正文中剥离。
//    是否剥离由调用方按展示面决定：md/json/search 剥离，`--format jsonl` 保留原始事件。

/** 注入标记的起点前缀（含一个空格，避免匹配到 `<dsh-injection-extra` 之类同前缀文本）。 */
export const INJECTION_OPEN_PREFIX = "<dsh-injection ";

/** 注入标记的终点字面量。 */
export const INJECTION_CLOSE = "</dsh-injection>";

/**
 * 取文本开头一个完整注入标记的 `kind` 属性。
 *
 * 这是给合成消息判定用的结构性读取，不用于可见性判定。只解析起点行内的 `kind="…"`，
 * 起点行必须以 `>` 收尾且存在换行；属性缺失、空值或形态不完整时返回 null。
 * 不解析、不反转义正文，也不把正文里的同形文字当作标记。
 *
 * @param text 消息首个文本块的原始文本。
 * @returns 注入类别；不是完整注入起点时返回 null。
 */
export function leadingInjectionKind(text: string): string | null {
  if (!text.startsWith(INJECTION_OPEN_PREFIX)) return null;
  const openEnd = text.indexOf("\n");
  if (openEnd < 0 || text[openEnd - 1] !== ">") return null;
  const line = text.slice(0, openEnd);
  const marker = 'kind="';
  const start = line.indexOf(marker);
  if (start < 0) return null;
  const valueStart = start + marker.length;
  const valueEnd = line.indexOf('"', valueStart);
  if (valueEnd <= valueStart) return null;
  return line.slice(valueStart, valueEnd);
}

/** 消息标记的起点前缀（含一个空格，避免匹配到 `<dsh-message-extra` 之类同前缀文本）。 */
export const MESSAGE_OPEN_PREFIX = "<dsh-message ";

/** 消息标记的终点字面量。 */
export const MESSAGE_CLOSE = "</dsh-message>";

/** 工具结果标记的起点前缀。 */
export const RESULT_OPEN_PREFIX = "<dsh-result ";

/** 工具结果标记的终点字面量。 */
export const RESULT_CLOSE = "</dsh-result>";

/** 交接摘要信封的起点（单独成行）。 */
const SUMMARY_OPEN = "<compacted-summary>";

/** 交接摘要信封的终点（单独成行）。 */
const SUMMARY_CLOSE = "</compacted-summary>";

/** 一个从文本起点开始的完整信封在文本中的位置。 */
interface EnvelopeSpan {
  /** 内层正文的起始下标（起点行之后）。 */
  readonly innerStart: number;
  /** 内层正文的结束下标（终点前那个换行处）。 */
  readonly innerEnd: number;
  /** 信封结束后的下标（终点字面量之后）。 */
  readonly end: number;
}

/**
 * 解析从 `text` 起点开始的一个完整信封。
 *
 * @param text 待解析文本。
 * @param openPrefix 起点前缀（含其后的空格）。
 * @param close 终点字面量。
 * @returns 完整信封的位置；不是完整信封时返回 null。
 */
function leadingEnvelope(text: string, openPrefix: string, close: string): EnvelopeSpan | null {
  if (!text.startsWith(openPrefix)) return null;
  // 起点行必须在首个换行处结束，且该行必须以 `>` 收尾：标记形态是“属性 + >”，起点行内不应有正文。
  // 少了这条检查时，`<dsh-injection …>正文\n</dsh-injection>` 会被当成空正文信封，正文被静默丢弃。
  const openEnd = text.indexOf("\n");
  if (openEnd < 0 || text[openEnd - 1] !== ">") return null;
  // 终点前必须有一个换行，避免把正文里恰好出现的终点字面量当成终点。
  const closeAt = text.indexOf(`\n${close}`, openEnd);
  if (closeAt < 0) return null;
  const end = closeAt + 1 + close.length;
  // 终点之后只能是文本结尾或换行（后者用于两个信封顺序排列）；其它形态不猜。
  if (end !== text.length && text[end] !== "\n") return null;
  return { innerStart: openEnd + 1, innerEnd: closeAt, end };
}

/**
 * 剥离文本起点处一个或多个完整注入信封。
 *
 * 子代理初始任务消息由两个顺序排列的信封组成（任务块与回报指引块），本函数按顺序全部剥离，
 * 内层正文之间以一个换行连接。任何一个信封不完整，或剥离后仍有非空残余，都原样返回整个输入。
 *
 * @param text 已拼接的完整消息正文。
 * @returns 剥离后的正文；没有可剥离的完整信封时返回原文。
 */
export function stripInjectionEnvelopes(text: string): string {
  const parts: string[] = [];
  let rest = text;
  let stripped = false;
  for (;;) {
    const span = leadingEnvelope(rest, INJECTION_OPEN_PREFIX, INJECTION_CLOSE);
    if (span === null) break;
    stripped = true;
    parts.push(rest.slice(span.innerStart, span.innerEnd));
    rest = rest.slice(span.end);
    // `leadingEnvelope` 已保证终点之后只可能是文本结尾或一个换行（第三条判据），因此这里只需处理
    // 换行：它属于两个信封之间的分隔形态，不进入正文。终点后紧跟其它内容的形态已在判据处被拒。
    if (rest.startsWith("\n")) rest = rest.slice(1);
  }
  if (!stripped) return text;
  // 所有信封剥离后仍有残余内容：不能确定残余是否属于正文，原样返回。
  if (rest.length > 0) return text;
  return parts.join("\n");
}

/**
 * 严格剥离工具结果外层的边界信封。
 *
 * 保留问答载荷解析的历史语义：不以起点前缀开头时原样返回（旧日志与未启用该插件的部署是裸正文）；
 * 以起点开头但起点行缺失、或终点不在末尾时返回 null，由调用方判为载荷异常。
 *
 * @param text 工具结果全部文本块拼接后的正文。
 * @returns 剥离后的正文；不是信封时为原正文；信封不完整时为 null。
 */
export function stripResultEnvelope(text: string): string | null {
  if (!text.startsWith(RESULT_OPEN_PREFIX)) return text;
  const span = leadingEnvelope(text, RESULT_OPEN_PREFIX, RESULT_CLOSE);
  if (span === null) return null;
  if (span.end !== text.length) return null;
  return text.slice(span.innerStart, span.innerEnd);
}

/**
 * 宽松剥离工具结果外层的边界信封，供展示面使用。
 *
 * 完整信封被剥离；不是信封或信封不完整时原样返回，展示面不依赖信封结构，原样显示比丢弃或
 * 猜测更诚实。原始正文始终可由 `show --format jsonl` 取回。
 *
 * @param text 工具结果全部文本块拼接后的正文。
 * @returns 剥离后的正文或原文。
 */
export function stripResultEnvelopeLenient(text: string): string {
  if (!text.startsWith(RESULT_OPEN_PREFIX)) return text;
  const span = leadingEnvelope(text, RESULT_OPEN_PREFIX, RESULT_CLOSE);
  if (span === null || span.end !== text.length) return text;
  return text.slice(span.innerStart, span.innerEnd);
}

/**
 * 宽松剥离对话消息外层的消息信封。
 *
 * 部署侧在会话 `append` 包装层给真实用户消息与带文本块的 assistant 消息各加一对 `<dsh-message>`，
 * 起点行承载 `role`/`id`/`ts` 三个属性，终点行单独成形（纯工具调用的 assistant 消息不包裹）。
 * 它是传输层标记而不是消息内容；md、json 与检索面统一用本函数取正文，`--format jsonl` 仍保留原始事件。
 *
 * 与工具结果的宽松版同形：完整即剥离，否则原样返回。消息信封没有严格版，它不承载需要解析的
 * 结构化载荷，展示与检索不依赖信封结构，原样显示比丢弃或猜测更诚实。消息信封最多一个且位于
 * 最外层，因此不做顺序排列的循环；终点之后还有内容时不是完整信封，原样返回。
 *
 * @param text 已拼接的完整消息正文。
 * @returns 剥离后的正文；不是信封或信封不完整时为原文。
 */
export function stripMessageEnvelope(text: string): string {
  if (!text.startsWith(MESSAGE_OPEN_PREFIX)) return text;
  const span = leadingEnvelope(text, MESSAGE_OPEN_PREFIX, MESSAGE_CLOSE);
  if (span === null || span.end !== text.length) return text;
  return text.slice(span.innerStart, span.innerEnd);
}

/**
 * 取 `<compacted-summary>` 信封的内层正文。
 *
 * 只认“整段恰好是一个完整信封”：起点在开头且单独成行、终点在末尾且单独成行。官方压缩检查点的
 * 正文前面还有一段英文检查点前言，因此不满足本判据；本函数只用于识别普通消息交接投递的那条
 * 用户消息（其正文由交接插件写成严格的 `<compacted-summary>\n…\n</compacted-summary>`）。
 *
 * @param text 已拼接的完整消息正文。
 * @returns 内层正文；不是完整信封时返回 null。
 */
export function compactedSummaryBody(text: string): string | null {
  if (!text.startsWith(`${SUMMARY_OPEN}\n`)) return null;
  if (!text.endsWith(`\n${SUMMARY_CLOSE}`)) return null;
  return text.slice(SUMMARY_OPEN.length + 1, text.length - SUMMARY_CLOSE.length - 1);
}

/**
 * 消息终点的转义形态。
 *
 * 外层包裹对内层终点统一转义（`preset-lib/injection-boundary.mjs` 的 `wrapSegments`），转义后的
 * 字面量是“反斜杠 + 斜杠 + 标签名”。本常量只用于识别嵌套残形的终点，不做任何反转义，反转义会
 * 改坏正文本身含反斜杠的正规载荷。
 */
const ESCAPED_MESSAGE_CLOSE = "<\\/dsh-message>";

/**
 * 剥掉交接摘要内层的消息信封残形。
 *
 * 投递消息的内层是助手消息落账后的文本，因此带着一对 `<dsh-message>`；外层
 * `<dsh-message role="user">` 又把它的终点转义为 `<\/dsh-message>`，使它不构成完整信封。
 * 本函数只处理这一种确定形态，判据三条缺一不可：以消息起点前缀开头、起点行在首个换行处结束
 * 且该行以 `>` 收尾、末尾是换行加转义终点。任一不满足即原样返回，不猜、不截取。
 *
 * 剥离只去掉起点行与转义终点行，不反转义，也不改动内层正文的任何字符。
 *
 * @param text 已取出的 `<compacted-summary>` 内层文本。
 * @returns 剥掉残形后的正文；不是该形态时原样返回。
 */
export function stripNestedMessageEnvelope(text: string): string {
  if (!text.startsWith(MESSAGE_OPEN_PREFIX)) return text;
  const openEnd = text.indexOf("\n");
  if (openEnd < 0 || text[openEnd - 1] !== ">") return text;
  const suffix = `\n${ESCAPED_MESSAGE_CLOSE}`;
  if (!text.endsWith(suffix)) return text;
  return text.slice(openEnd + 1, text.length - suffix.length);
}

/**
 * 清理交接摘要条目正文里内层的嵌套残形。
 *
 * 只对“整段恰好是一个 `<compacted-summary>` 信封”生效，判据与 `compactedSummaryBody` 相同；
 * 官方压缩检查点的正文前面还有检查点前言，因此原样返回，不会被二次切分。清理后保留标签本身，
 * 使调用方仍能从正文读出这是摘要而不是用户输入。
 *
 * @param text 已剥离外层消息信封的 `user/message` 正文。
 * @returns 清理内层残形后的完整摘要文本；不是整段信封时原样返回。
 */
export function cleanCompactedSummary(text: string): string {
  const inner = compactedSummaryBody(text);
  if (inner === null) return text;
  return `${SUMMARY_OPEN}\n${stripNestedMessageEnvelope(inner)}\n${SUMMARY_CLOSE}`;
}

/**
 * 清理正文里内层引用的消息标记行对。
 *
 * `subagent-settled` 一类注入消息会把子代理的收尾发言整段引用进来，于是正文中间出现一对消息标记：
 * 起点行是 `<dsh-message role="assistant" id="…" ts="…">`，终点行被外层包裹转义成 `<\/dsh-message>`
 * （写入侧对所有终点统一转义，见 `preset-lib/injection-boundary.mjs`）。它们不是内容，却被原样带进
 * 可读正文，因此在剥完外层信封之后按“起点行 + 其后第一个转义终点行”成对删除。
 *
 * 判据只有两条且都得独占一行：起点行去掉首尾空白后以 `<dsh-message ` 开头并以 `>` 结尾；终点行去掉
 * 首尾空白后恰好是 `<\/dsh-message>`。找不到成对形态时整段原样返回，不做截取：只有起点、只有终点、
 * 终点未转义、标记混在行内的形态都不是该结构，猜错会破坏正文本身。
 *
 * 只删除这两行，两行之间的正文与其余所有字符逐字不变；多个成对按出现顺序逐个处理；对结果再次调用
 * 不再有可删除的成对，因此本函数幂等。
 *
 * @param text 已剥离外层信封的消息正文。
 * @returns 删掉标记行对后的正文；没有成对形态时原样返回。
 */
export function stripNestedMessageMarkers(text: string): string {
  const lines = text.split("\n");
  const removed = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    const head = lines[index].trim();
    if (!head.startsWith(MESSAGE_OPEN_PREFIX) || !head.endsWith(">")) continue;
    let closeIndex = index + 1;
    while (closeIndex < lines.length && lines[closeIndex].trim() !== ESCAPED_MESSAGE_CLOSE) {
      closeIndex += 1;
    }
    if (closeIndex >= lines.length) continue;
    removed.add(index);
    removed.add(closeIndex);
    // 从终点之后继续扫描：同一个起点不可能再与后面的终点配成第二对。
    index = closeIndex;
  }
  if (removed.size === 0) return text;
  return lines.filter((_line, index) => !removed.has(index)).join("\n");
}

/**
 * 标题里出现即视为"没有标题"的部署标记起点字面量。
 *
 * 上游偶尔把部署标记本身截断成标题（形如 `<dsh-injection kind="subagent-task" src=`），这些值不是
 * 会话标题，而是落账形态被截断后的残片。字面量必须与写入侧一致，因此直接复用本模块的四个起点常量。
 */
export const DEPLOYMENT_MARKER_TITLE_PREFIXES = [
  INJECTION_OPEN_PREFIX,
  MESSAGE_OPEN_PREFIX,
  RESULT_OPEN_PREFIX,
  SUMMARY_OPEN,
] as const;

/**
 * 标题归一化：把部署标记残片与空标题都收敛为 `null`（"没有标题"）。
 *
 * 两个标题来源（projcache 的 `title` 字段与日志里最后一个 `session/title` 事件）都必须经过它，
 * 否则同一会话会在 `list` 与 `show` 里给出两种答案。不可用不等于"元数据不完整"：标记残片是取值本身
 * 不可用，不是缺字段，因此调用方不得把它记为元数据缺失，渲染层的空值分支（md 显示 `-`、json 为 null）
 * 直接复用即可。
 *
 * @param raw 原始标题文本。
 * @returns 去掉首尾空白后的标题；标记残片、空串与缺失均返回 null。
 */
export function normalizeSessionTitle(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  for (const prefix of DEPLOYMENT_MARKER_TITLE_PREFIXES) {
    if (trimmed.startsWith(prefix)) return null;
  }
  return trimmed;
}
