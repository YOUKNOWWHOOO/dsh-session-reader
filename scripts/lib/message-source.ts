// 用途：`user/message` 事件的"来源归属"，md 标注文字与 json 归属对象的唯一真值源。
// 主要入口：attributeSource（原始 source 值 → 归属对象）、describeSource（归属对象 → md 标注片段）。
// 关键依赖：render-core.ts 的 inlineValue（行内载体）。
// 设计约束：
// 1. 判据与词表只此一处：md 渲染（render-show-md.ts、render-md.ts）与 json 渲染（render-json.ts）一律调用本模块，
//    禁止任何渲染器自行判别来源。理由：同一条消息在时间线、检索命中行与 json 中必须给出同一答案。
// 2. `kind` 由官方 MessageSourceMap 定义，且该联合是"合并可扩展"的（该声明在桌面安装里以
//    `dsh-llm\lib\typert.host.js` 的 `declaration` 字符串承载，见下方 KNOWN_KINDS 的注释：
//    桌面安装**不发运任何 `.d.ts`**）。因此未知 kind 必须原样呈现，禁止丢弃，
//    也禁止归入最接近的已知类别，那会把"未知"伪装成"已知"。
// 3. 骨架里只有固定词"来源"与词表内的 kind 裸写；词表外的 kind 与一切取自日志的取值（plugin 名、
//    会话 id 等）一律经行内载体承载（inlineValue）。原因：日志的字段值可能含反引号或换行，
//    裸写会把标签行拆成两行并让裸文本进入骨架（违反 md 输出契约 R2 载体隔离），也会被
//    tests\matrix-assert.ts 的"数据标记必须处于代码载体"断言拦下。产品里其它会话 id（`- ID：`、
//    `- 父会话：`、列表行、命中行）本来就经载体承载，这里的处理与之同惯例。
// 4. 不在此处登记数据统计：`user/message` 的 `source` 可能缺失、可能不是对象，`kind` 也可能为空串、
//    词表内的取值或词表外的取值（来源种类由官方包与部署插件共同扩展）。三种情况都有确定处理，
//    缺失记 null、空串按"无该字段"处理、词表外取值入行内载体原样呈现，因此不需要、也不允许用
//    一份"真实数据里出现过哪些取值"的清单来代替判据。
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
 * 词表的来源分三层。前两层取自本机安装的官方包（下列文件为实测位置；不写行号，行号会随官方包升级漂移），第三层由本文部署侧的插件写入。
 *
 * 其一，`MessageSourceMap` 本身。**桌面安装不发运 `.d.ts`**：`app.asar` 内的
 * `@deepseek-ai` 作用域没有这类文件，类型文本以各包 `lib\typert.host.js` 里的
 * `declaration` 字符串承载。因此本词表的类型依据只能取该字段，不能引用任何 `.d.ts`
 * 路径。`dsh-llm\lib\typert.host.js` 的 `MessageSourceMap` 声明按顺序包含下列键：
 * `user`、`model`、`tool`、`system-prompt`、`model-selection`、`tool-registry`、
 * `action-cards`、`runtime-context`、`user-rpc`、`working-directory`、`user-approval`、
 * `agent-message`、`subagent-settled`、`skill-invocation`、`ptc-mode`、
 * `compact-checkpoint`、`cordis-host-runner`、`user-question-reply`、`team-message`、
 * `goal`、`plan-mode`、`schedule`、`session-reference`、`webhook`。同一份声明在多个
 * 官方包里逐字重复，各份的键名与顺序完全一致，说明它是随构建摊平的同一份聚合声明，
 * 不是各包分别增补。本技能只把其中一部分列为裸写取值，其余键仍走载体分支。
 *
 * 其二，**不在**上述声明里、但属官方承认合法取值的：`plugin`（历史取值，只出现在迁移适配器
 * 与持久化 worker 的取值白名单里）、`skill-catalog`（`dsh-tool-skill` 等包使用）、
 * `agent-instructions`（`dsh-agent-instructions` 使用）、`coordinator`、`subagent-report`
 * （只在迁移适配器与持久化 worker 的白名单里，见 `dsh-session-format-v0-to-v1`、
 * `dsh-session-format-v2-to-v3`、`dsh-session-format-v3-to-v4`、`dsh-session-persistence-jsonl`）。
 * 其中 `plugin` 曾被本注释并列为「声明里的基础成员」，那是失实表述：它不在声明里。
 *
 * 其三，**本文部署侧**声明的取值：`global-spec`、`injection-boundary`。这两个不是官方取值，
 * 由自定义预设的插件写入，`KNOWN_KINDS` 收录它们只为让标注裸写而非入载体。
 *
 * 该词表**不是**对官方词表的完整声明，联合是合并可扩展的，任何未列入的取值都会走载体分支
 * 原样呈现，这正是设计意图。
 */
const KNOWN_KINDS: readonly string[] = [
  // 官方 `MessageSourceMap` 声明里的取值（本技能只裸写其中一部分，完整键名见上方注释）。
  "user",
  "model",
  "tool",
  "agent-message",
  "subagent-settled",
  "skill-invocation",
  "team-message",
  "goal",
  "webhook",
  "session-reference",
  "compact-checkpoint",
  "working-directory",
  // 不在官方 `MessageSourceMap` 声明里、但由官方包实际写入或由迁移适配器与持久化 worker
  // 的白名单承认的取值。`plugin` 是历史取值（声明里没有它），`skill-catalog` 与
  // `agent-instructions` 由对应插件写入，`coordinator` 与 `subagent-report` 只出现在白名单里。
  "plugin",
  "skill-catalog",
  "agent-instructions",
  "coordinator",
  "subagent-report",
  // 本文部署侧新增的来源种类：全局规范消息、注入边界消息（runtime-context / user-question-reply
  // 两侧的独立边界消息）。它们是部署侧插件声明的取值，裸写可读性高于行内载体。
  "global-spec",
  "injection-boundary",
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
