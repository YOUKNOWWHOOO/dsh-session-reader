// 用途：`user/message` 事件的"来源归属"——md 标注文字与 json 归属对象的唯一真值源。
// 主要入口：attributeSource（原始 source 值 → 归属对象）、describeSource（归属对象 → md 标注片段）。
// 关键依赖：render-core.ts 的 inlineValue（行内载体）。
// 设计约束：
// 1. 判据与词表只此一处：md 渲染（render-show-md.ts、render-md.ts）与 json 渲染（render-json.ts）一律调用本模块，
//    禁止任何渲染器自行判别来源。理由：同一条消息在时间线、检索命中行与 json 中必须给出同一答案。
// 2. `kind` 由官方 MessageSourceMap 定义，且该联合是"合并可扩展"的（`@deepseek-ai/dsh-llm` 的 message.d.ts：
//    "Merge-extensible sum type — plugins add their own kinds"）。因此未知 kind 必须原样呈现，禁止丢弃，
//    也禁止归入最接近的已知类别——那会把"未知"伪装成"已知"。
// 3. 骨架里只有固定词"来源"与词表内的 kind 裸写；词表外的 kind 与一切取自日志的取值（plugin 名、
//    会话 id 等）一律经行内载体承载（inlineValue）。原因：日志的字段值可能含反引号或换行，
//    裸写会把标签行拆成两行并让裸文本进入骨架（违反 md 输出契约 R2 载体隔离），也会被
//    tests\matrix-assert.ts 的"数据标记必须处于代码载体"断言拦下。产品里其它会话 id（`- ID：`、
//    `- 父会话：`、列表行、命中行）本来就经载体承载，这里的处理与之同惯例。
// 4. 本机真实数据的实测性质（不写具体计数：该计数随会话增长而变化，写死必然过时）：`user/message`
//    事件的 `source` 恒存在、`kind` 恒为非空字符串，出现的取值集中在 user/plugin/agent-message/
//    subagent-settled/skill-catalog/agent-instructions/goal。空串与缺失一律按"无该字段"处理——空串
//    没有任何信息量，若当成取值渲染会产出空载体（`来源 ``` ），既有损可读性也失去标注意义。
//    `来源 未标注` 分支是为违反 schema 的日志保留的显式标注，不是为不可能发生的场景加兜底逻辑。

import { asRecord, readString } from "./decode.ts";
import { inlineValue } from "./render-core.ts";

/** 来源归属：json 面的固定形态；无值的字段为 null（与"空值在 json 中为 null"同一口径）。 */
export interface SourceAttribution {
  readonly kind: string | null;
  readonly form: string | null;
  readonly senderSessionId: string | null;
  readonly plugin: string | null;
}

/**
 * 本技能识别的 kind：词表内的值在 md 中裸写，词表外的值入行内载体。
 *
 * 词表的来源分三层，均取自本机安装的官方包（以下文件与行号为实测位置）：基础成员 4 个由
 * `@deepseek-ai/dsh-llm\lib\types\message.d.ts` 的 `MessageSourceMap` 声明（`user`、`plugin`、
 * `model`、`tool`）；`agent-message`、`subagent-settled`、`skill-invocation`、`goal`、
 * `session-reference` 由 `dsh-subagent`、`dsh-skill`、`dsh-goal`、`dsh-session-reference` 各自
 * `declare module` 增补；`team-message` 在本机 `@deepseek-ai` 的 `.d.ts` 中没有声明，只出现在
 * `dsh-llm\lib\typert.host.js` 的聚合声明与官方适配器白名单里（同名类型 `TeamMessageSource` 亦然）。
 * `skill-catalog`、`agent-instructions`、`webhook` 由对应插件包增补。`coordinator`、`subagent-report`
 * 不出现在任何合并声明中，只出现在官方迁移适配器与持久化 worker 的取值白名单里
 * （`dsh-session-format-v0-to-v1`、`dsh-session-format-v2-to-v3`、`dsh-session-persistence-jsonl`），
 * 但它们是官方承认的合法取值，故一并视为已知。该词表**不是**对官方词表的完整声明——联合是合并
 * 可扩展的，任何未列入的取值都会走载体分支原样呈现，这正是设计意图。
 */
const KNOWN_KINDS: readonly string[] = [
  "user",
  "plugin",
  "model",
  "tool",
  "agent-message",
  "subagent-settled",
  "skill-catalog",
  "skill-invocation",
  "agent-instructions",
  "team-message",
  "coordinator",
  "subagent-report",
  "goal",
  "webhook",
  "session-reference",
];

/** 取非空字符串字段：缺失、非字符串与空串一律视为"无该字段"。 */
function readNonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = readString(record, key);
  return value === undefined || value === "" ? null : value;
}

/** 携带定位取值的 kind → 该取值在归属对象中的字段名。 */
const DETAIL_FIELD: Readonly<Record<string, keyof SourceAttribution>> = {
  "agent-message": "senderSessionId",
  "subagent-settled": "senderSessionId",
  plugin: "plugin",
};

/**
 * 把日志中的 `data.source` 归一为归属对象。
 *
 * @param source 事件载荷里的 `source` 原始值（类型未知，可能是对象、缺失或非对象）。
 * @returns 固定形态的归属对象；无法取出的字段为 null，绝不猜测。
 */
export function attributeSource(source: unknown): SourceAttribution {
  const record = asRecord(source) ?? {};
  return {
    kind: readNonEmptyString(record, "kind"),
    form: readNonEmptyString(record, "form"),
    senderSessionId: readNonEmptyString(record, "senderSessionId"),
    plugin: readNonEmptyString(record, "plugin"),
  };
}

/**
 * 生成 md 标注片段：`来源 <kind>[ <取值>]`。
 *
 * 取值（`senderSessionId`、`plugin`）与词表外的 kind 一律经行内载体承载（见文件头第 3 条）。
 *
 * @param attribution 归属对象（`attributeSource` 的产物）。
 * @returns 标注片段；`kind` 为 `user`（用户本人的消息）时返回 null，表示不标注；
 *          `kind` 缺失、非字符串或空串时返回 `来源 未标注`，使违反 schema 的日志同样可辨。
 */
export function describeSource(attribution: SourceAttribution): string | null {
  const kind = attribution.kind;
  if (kind === null) return "来源 未标注";
  // 用户本人的消息不加标注：标签 `**用户**` 本身就是准确描述，加标注只会制造噪声。
  if (kind === "user") return null;
  const head = KNOWN_KINDS.includes(kind) ? kind : inlineValue(kind);
  const field = DETAIL_FIELD[kind];
  const detail = field === undefined ? null : attribution[field];
  if (detail === null) return `来源 ${head}`;
  return `来源 ${head} ${inlineValue(detail)}`;
}
