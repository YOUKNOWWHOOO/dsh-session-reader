---
name: session-reader
description: 当需要查看、列出、检索、统计或校验本机 dsh（DeepSeek Harness）会话历史（含子代理会话），而 dsh 自身不提供会话读取命令时加载。
---

# session-reader 技能

读取、列出、检索、统计与校验 dsh 会话历史。离线、只读：不运行 dsh、不联网、不产生模型调用、不读取凭据。

## 运行前提

- 平台：Windows；PATH 中需有 Node（v26 线，原生执行 TypeScript，无需构建）。
- 本机需有 dsh 安装（提供官方格式库与会话数据；默认位置 `~\.dsh`，可用 `--dsh-home` 覆盖）。
- 全部命令必须显式指定 `--output-dir`；工具不对输出位置做任何假定或校验。

## 输出使用规定

- `--output-dir` 必须由调用方显式指定（无默认值，缺省退出 2）；惯例指向当前项目的临时目录（`<项目>/tmp/` 或 `<项目>/.tmp/`）。工具对目录位置零假定、不校验，不限制其是否位于 dsh 主目录内。
- 终端只输出两行：输出文件绝对路径与摘要；会话正文只写入输出文件（UTF-8 无 BOM、LF、末尾恰一个换行）。
- 未指定 `--name` 时产物名由工具生成（`session-reader-<命令>-<UTC 时间戳>-<随机 6 位>.<扩展名>`），此时绝不覆盖已存在的文件（命中即退出 2）。
- 指定 `--name <basename>` 时产物恒为 `<output-dir>/<basename>.<扩展名>`，扩展名由 `--format` 决定；同名产物被**原子替换**（连续两次调用写同一路径，内容为后一次结果）。覆盖即丢失上一次内容，仅在自己需要稳定引用路径时使用。
- `--name` 取值：字母、数字、`_`、`-`、中文，长度 1-64；不得包含 `.`、路径分隔符、空白与控制字符；不得为 Windows 保留设备名（`CON`、`NUL`、`COM1`…）。违者退出 2。
- 输出文件可能含会话明文，按临时产物管理，不提交、不长期保留。
- 默认格式 `md` 的输出真实通过 dsh 全局 markdownlint 基线（无文件内豁免、无配置放宽）：调用方无需将输出目录排除在 Markdown 静态检查之外；`json`/`jsonl` 为机器可读格式，不参与 lint。

## 覆盖范围与统计口径

每个命令的产物都自带覆盖声明与统计口径，调用方可据此判断结论强度，不需要读源码：

- `扫描会话 N 个；纳入 M 个；排除 K 个`：N 是枚举到的会话数，M 是实际进入本次结论的会话数，K 是被排除的会话数；`N = M + K` 恒成立。M 与 `--limit` 无关（`--limit` 只决定产物列出多少条，由摘要行的 `匹配 N 个，显示 M 个` 表达）。
- `排除会话：<完整 id>（<原因>）`：每个被排除的会话独占一行，原因是可诊断的具体文本（如 `帧魔数无效（偏移 0）`、`解码失败`）。**排除是显式的**——header 不可读的会话不会让整条命令失败，也不会静默消失。
- `扫描明细：解码日志 X 份；读到事件 Y 个；解码失败 Z 份；帧解压失败 W 帧` 与 `事件时间范围：<下界> ~ <上界>`：`search` 与 `stats` 输出，给出"0 命中"的分母——扫了哪些日志、读到多少事件、有没有读失败、覆盖到什么时间。时间范围来自**事件自带的 `time` 字段**（不是会话的最近活动时间）；无事件时显示 `-`。
- `检索范围：<scope>（<覆盖面描述>）；命中总数 X 为精确值`：仅 `search` 输出。`--limit` 只限制产物中列出的命中条数，**不截断命中总数**；`--scope all` 时命中总数为精确值，此时"0 命中"可作为"不存在"的证据。
- `## 每会话命中分布`（仅 `search`）：逐会话给出命中数（含 0 命中的纳入会话），按命中数降序。用于把**调用方自己的语料**从结论里剔除——检索在全库上做，发起检索的会话与它派出的子代理会话也在库里，调查笔记、复述过的错误串、贴过的代码片段都会被命中；只给一个总数会把这种污染藏起来。自动化剔除用 `--exclude-session <标识>`。
- `筛选：…；显示 X 条时间线条目（区间内事件 Y 个，共 Z 个事件）`：仅 `show` 在范围选择生效时输出，同时给出最终显示条目数、区间内事件数与整会话事件数。

## 输出格式（md）

- 骨架只用固定词表（与内容隔离）：文档标题 `# 会话列表` / `# 会话列表（完整）` / `# 会话记录` / `# 检索结果` / `# 统计` / `# 完整性校验`；区块标题 `## 时间线`、`## 轮次大纲`、`## 子代理 <路径编号>`；标签行恒以 `：` 收尾（`**用户**：`、`**助手**：`、`**工具调用**（read）：` 等）；短横线列表与 GFM 表格只承载固定字段。
- 任意会话文本只经两种载体承载：多行文本 → 动态长度反引号围栏（语言标注 `text`，反引号长度 = 内容最长连续反引号串 + 1，且不小于 3）；单行文本 → 动态反引号行内代码跨度（表格单元格内 `|` 先转义）。
- 内容只做三条极小归一化：制表符 → 4 空格；行内值首尾空白去除（全空白值保留原样）；围栏载荷的所有非空行都以 `$`+空白开头时，末尾追加一行单个空格（原文各行逐字不变）。CR/CRLF 折叠为 LF（输出契约要求 LF-only）。
- 列表与命中行输出的会话标识是**完整 id**，可直接作为 `show`/`stats`/`check`/`search --session` 的目标参数。
- 子代理块层级：所有子代理块固定为 H2（`## 子代理 <路径编号>`）、子内容固定为 H3；嵌套父子关系只由路径编号（如 `1` 与 `1.1`）表达，标题层级本身不随深度递进。
- 读取建议：按 `#`/`##` 词表定位区块，用围栏/行内代码边界识别原始文本与字段值。

## 命令

脚本路径相对本技能目录；示例中的 `<project_tmp>` 为项目临时目录占位符。

```text
node scripts/session-reader.ts list   --output-dir <project_tmp> [--name <basename>] [--workspace <路径|标题>]
                                      [--since <时间>] [--until <时间>] [--title <关键词>]
                                      [--origin all|main|subagent] [--include-blank] [--limit N]
                                      [--sort time|created|title|size|turns] [--full] [--format md|json]
node scripts/session-reader.ts show   <id|唯一前缀|last> --output-dir <project_tmp> [--name <basename>] [--summary]
                                      [--role user|assistant] [--thinking] [--tools] [--events] [--subagents]
                                      [--headers] [--truncate N] [--turn <A-B|A>] [--seq <A-B|A>]
                                      [--head N] [--tail N] [--probe] [--format md|json|jsonl]
node scripts/session-reader.ts search <关键词> --output-dir <project_tmp> [--name <basename>] [--scope text|tools|all]
                                      [--case-sensitive] [--context N] [--limit N] [--session <会话标识>]
                                      [--exclude-session <会话标识>] [--workspace <路径|标题>]
                                      [--since <时间>] [--until <时间>] [--origin all|main|subagent] [--format md|json]
node scripts/session-reader.ts stats  [<id|唯一前缀|last>] --output-dir <project_tmp> [--name <basename>]
                                      [--workspace/--since/--until/--origin；仅全局聚合（缺省目标）可用] [--format md|json]
node scripts/session-reader.ts check  [<id|唯一前缀|last>] --output-dir <project_tmp> [--name <basename>] [--format md|json]
```

全局选项：`--dsh-home <路径>`（默认 `$DSH_HOME`，否则 `~\.dsh`）、`--lib-root <目录>`（官方格式库解析锚点，默认 `<dsh-home>\profiles\node_modules`）、`--output-dir`、`--name`、`--format`、`-h/--help`。

`--scope` 的覆盖范围（三档单调包含，`all` 为穷尽档）：

- `text`：用户消息与助手消息正文（默认，也是唯一命中集最小的档）。
- `tools`：`text` 全部 ＋ 工具调用参数 ＋ 工具结果正文。
- `all`：`tools` 全部 ＋ 推理、系统消息、压缩摘要、命令、标题请求、web 检索请求、交付物、待办、代理信箱注入内容 ＋ **每个事件的完整 JSON 载荷**（命中行的标签即事件类型，如 `assistant/attempt`、`llm/retry`）。因此 `all` 覆盖日志中出现的任意字符串。

选项互斥（违者退出 2）：

- `--format json|jsonl` 下禁止一切**呈现类开关**（`--role`、`--thinking`、`--tools`、`--events`、`--headers`、`--truncate`、`--turn`、`--seq`、`--head`、`--tail`、`--probe`）——这十一个开关仅 `md` 可用。
- `--format jsonl` 下另禁止**内容范围开关** `--summary` 与 `--subagents`；`--format json` 允许这两个开关。
- `--head` 与 `--tail` 互斥。
- `--summary` 与 `--turn`/`--seq`/`--head`/`--tail` 互斥（`--summary` 呈现整会话轮次大纲，范围选择对其无意义）。
- `--probe` 与 `--subagents` 互斥（探测的意义是"读之前先问规模"，而 `--subagents` 会把产物扩展到整棵子代理树）。`--probe` **可以**与其它呈现类开关同用：它会按同一组开关渲染一份副本并据实报告字节数，因此 `--probe --events --truncate 500` 正是量出"带这些选项的完整导出有多大"的用法。
- `stats` 指定目标（单会话）时禁止范围过滤选项 `--workspace`/`--since`/`--until`/`--origin`（不做静默忽略）。
- 所有互斥与取值错误都会在 stderr 括号说明中给出**合法替代写法**（形如 `去掉 --events，或把 --format 改为 md`）。

选项终止符：`--` 之后的所有 token 一律作为位置参数（用于以 `-` 开头的关键词，如 `search -- "- item"`）。

示例（PowerShell）：

```text
node scripts/session-reader.ts list --output-dir <project_tmp> --workspace user_projects --limit 20 --name 会话清单
node scripts/session-reader.ts show 39b27999 --output-dir <project_tmp> --thinking --tools
node scripts/session-reader.ts show last --output-dir <project_tmp> --subagents --format json
node scripts/session-reader.ts show last --output-dir <project_tmp> --turn 3-5
node scripts/session-reader.ts show last --output-dir <project_tmp> --head 20 --events
node scripts/session-reader.ts show last --output-dir <project_tmp> --probe
node scripts/session-reader.ts search compact --output-dir <project_tmp> --scope all
node scripts/session-reader.ts search data_inspection_failed --output-dir <project_tmp> --scope all --session 77707026
node scripts/session-reader.ts search write-failed --output-dir <project_tmp> --scope all --exclude-session last
```

## 默认参数组合（默认调用）

默认组合 = 仅写「命令 + 目标（如需要） + `--output-dir`」，其余选项全部取默认值（含 `--dsh-home`、`--lib-root`、`--format`、`--name` 等）。`--output-dir` 是默认组合中唯一必须显式提供的位置类参数，且必须遵守上文「输出使用规定」（由调用方显式指定，惯例指向项目临时目录）。

```text
node scripts/session-reader.ts list                      --output-dir <project_tmp>
node scripts/session-reader.ts show   <id|唯一前缀|last> --output-dir <project_tmp>
node scripts/session-reader.ts search <关键词>            --output-dir <project_tmp>
node scripts/session-reader.ts stats                     --output-dir <project_tmp>
node scripts/session-reader.ts check                     --output-dir <project_tmp>
```

默认行为（对外契约）：

- 输出格式为 md（lint-safe Markdown，载体与归一化见「输出格式（md）」；输出文件扩展名 `.md`）；文本不截断（`--truncate 0`，对所有文本载体一致，含 `--events` 的事件载荷）。
- `show`：推理、工具调用/结果与生命周期事件隐藏，正文尾部摘要行提示对应开关；用户/助手消息正文完整；不施加任何范围选择，`--subagents` 关闭。
- `search`：`--scope text`、不限定会话、`--limit 100`（命中总数始终为全量）。
- `list`：`--limit 100`、`--sort time`、隐藏空会话。
- 结果只写入输出文件（UTF-8 无 BOM、LF、末尾恰一个换行），终端仅两行 stdout（输出文件路径与摘要）。

## 退出码与错误

- `0` 成功（含 0 命中等空结果）；`1` 目标不存在（含前缀歧义）；`2` 参数错误；`3` 数据/IO 错误。
- stderr 只输出单行 `错误: <分类>`，分类后可附一段括号说明：歧义目标为 `（候选 N 个）`；参数错误为冲突或缺失的选项名、合法替代写法，或调用方自身在子命令位或选项位给出的 token（如 `错误: 参数无效（呈现类开关 --events 仅 md 可用；去掉 --events，或把 --format 改为 md）`）。说明中不含会话内容、会话 ID、用户名与 dsh 数据路径。
- 调用方只应依赖分类（退出码与 `错误: <分类>` 文本）做分流；括号说明可能扩展，不要做全等匹配。
- 目标解析三态可区分：唯一匹配且可读 → 正常执行；多个匹配 → `目标不存在（候选 N 个）`、退出 1；**目标存在于磁盘但 header 不可读** → `数据不可读`、退出 3（与"确实不存在"的退出码不同）；其余无匹配 → `目标不存在`、退出 1。

## 使用要点

- `show` 的目标可写完整 id、唯一前缀（大小写不敏感，最短 8 字符，可省略 `session-`）或 `last`；歧义时按候选数改用更长前缀。`list`/`search` 产物中给出的完整 id 必然可直接使用。
- 范围选择：`--turn A-B`（turn 区间，含端点）、`--seq A-B`（seq 区间）、`--head N`（首个 N 条时间线条目）、`--tail N`（末 N 条）。`--turn` 与 `--seq` 可同时使用（交集）；`--head`/`--tail` 作用于筛选后的条目序列且只作用于主会话块（子代理块始终完整导出）。范围选择只改变呈现，不改变覆盖声明与统计。
- 先探测规模再决定是否读取：`show <目标> --probe` 只落一份规模摘要（头部 KV ＋ `- 预计字节数：N` ＋ `- 消息数：X 用户 / Y 助手`），不含任何会话正文。预计字节数等于"以同一组选项做完整导出"的字节数，因此 `--probe --events --truncate 500` 可以先量出带这些选项的导出有多大，再决定要不要真的导出。
- 检索时剔除调用方自己的语料：先看产物中的 `## 每会话命中分布` 定位哪些命中来自自己的会话与子代理，再用 `--exclude-session <标识>` 把它们整棵子树排除；`--session` 与其互为反向。
- `search --session <标识>` 只检索该会话及其子代理子树（按 `parentSession` 递归），`search --exclude-session <标识>` 排除同一棵树；两者都与 `--workspace`/`--since`/`--until`/`--origin` 以交集生效，目标不存在时退出 1（不静默忽略）。
- 推理、工具调用/结果与生命周期事件默认隐藏，分别用 `--thinking`、`--tools`、`--events` 显示；正文尾部摘要行会提示实际隐藏原因。
- 尾部截断、坏行等异常会在输出中显式标注；解码失败以退出码 3 报错。`check` 用不读 header 的枚举路径，因此结构损坏的会话本身也在其诊断范围内。
- `list`/`stats` 的元数据来自官方投影缓存；不可用时相关列显式标注"元数据不可用"并给出原因。
