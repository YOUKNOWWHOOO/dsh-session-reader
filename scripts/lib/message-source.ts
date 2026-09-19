// 用途：`user/message` 事件的"来源归属"——md 标注文字与 json 归属对象的唯一真值源。
// 主要入口：attributeSource（原始 source 值 → 归属对象）、describeSource（归属对象 → md 标注片段）。
// 关键依赖：render-core.ts 的 inlineValue（行内载体）。
// 设计约束：
// 1. 判据与词表只此一处：md 渲染（render-show-md.ts、render-md.ts）与 json 渲染（render-json.ts）一律调用本模块，
//    禁止任何渲染器自行判别来源。理由：同一条消息在时间线、检索命中行与 json 中必须给出同一答案。
// 2. `kind` 由官方 MessageSourceMap 定义，且该联合是"合并可扩展"的（`@deepseek-ai/dsh-llm` 的 message.d.ts：
//    "Merge-extensible sum type — plugins add their own kinds"）。因此未知 kind 必须原样呈现，禁止丢弃，
//    也禁止归入最接近的已知类别——那会把"未知"伪装成"已知"。
// 3. 骨架里只有固定词"来源"与词表内的 kind 裸写；词表外的 kind 与一切取自日志的取值（plugin 名）经
//    行内载体承载（inlineValue）。原因：日志内容可能含反引号或换行，裸写会破坏骨架，并被
//    tests\matrix-assert.ts 的"数据标记必须处于代码载体"断言拦下。会话 id 是唯一例外，原样输出，
//    与 `- ID：`、`- 父会话：`、列表与命中行的完整 id 同一惯例。
// 4. 真实数据实测（307 个会话、2319 条 user/message 事件）：`source` 零缺失、`kind` 零非字符串，
//    取值只有 user(502)/plugin(562)/agent-message(396)/subagent-settled(287)/skill-catalog(312)/
//    agent-instructions(259)/goal(1) 七种，其中 agent-message 与 subagent-settled 恒带 senderSessionId。
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
 * 已知 kind：词表内的值在 md 中裸写，词表外的值入行内载体。
 * 前六项来自官方基础类型（`@deepseek-ai/dsh-llm`）、后六项来自本机安装的各插件扩展。
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
  "goal",
  "webhook",
  "session-reference",
];

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
    kind: readString(record, "kind") ?? null,
    form: readString(record, "form") ?? null,
    senderSessionId: readString(record, "senderSessionId") ?? null,
    plugin: readString(record, "plugin") ?? null,
  };
}

/**
 * 生成 md 标注片段：`来源 <kind>[ <取值>]`。
 *
 * @param attribution 归属对象（`attributeSource` 的产物）。
 * @returns 标注片段；`kind` 为 `user`（用户本人的消息）时返回 null，表示不标注；
 *          `kind` 缺失时返回 `来源 未标注`，使违反 schema 的日志同样可辨。
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
  // 取值一律入载体，唯一例外是会话 id（见文件头第 3 条）。
  const detailText = field === "senderSessionId" ? detail : inlineValue(detail);
  return `来源 ${head} ${detailText}`;
}
