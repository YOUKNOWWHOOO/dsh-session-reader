---
name: session-reader
description: 当需要查看、列出、检索、统计或校验本机 dsh（DeepSeek Harness）会话历史（含子代理会话），而 dsh 自身不提供会话读取命令时加载。
---

# session-reader 技能

读取、列出、检索、统计与校验本机 dsh（DeepSeek Harness）会话历史，包括子代理会话。全程只读、离线：不运行 dsh，不联网，不产生模型调用，不读取凭据，不修改会话数据。

## 适用范围

- 排查问题、复盘模型行为、审计工具调用与检索历史记录。
- 只处理本机 dsh 主目录内的会话日志与投影缓存，不解析远端会话，不提供实时事件流。
- 唯一写入位置是 `--output-dir` 指定的目录。

## 运行前提

- 平台：Windows。
- 执行载体：在运行本技能的 PowerShell 里先执行下列两条，后续示例中的 `& $desktopNode` 即用它运行。

  ```powershell
  $env:DSH_DESKTOP_NODE_EXECUTABLE = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/DeepSeek Harness.exe'
  $desktopNode = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/bin/node.cmd'
  ```

  shim 直接引用该环境变量，缺它时以 `'""' is not recognized`、退出码 1 失败。本文件的命令示例写 `& $desktopNode`，`--help` 输出的用法行写同义的 `<desktop_node>` 占位符。
- 官方格式库默认取桌面版安装内的 `node_modules`，该目录必须同时含 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-session-format-catalog`。锚点不成立或库加载失败时退出 3，错误行只给可执行的下一步（不包含任何安装路径）。可用 `--lib-root <目录>` 覆盖，取值必须是含 `@deepseek-ai` 的 `node_modules`。
- 全部命令必须显式指定 `--output-dir`，缺省退出 2。

## 支持的会话来源

本技能支持 dsh 随附 `standard` 预设与自定义 `dsh-custom` 预设（显示名“自定义模式”）产生的会话。只支持当前会话日志格式，旧版本日志不做迁移，按不可读处理：单目标命令以 `数据不可读`、退出 3 失败，聚合命令把它列入覆盖声明的排除项，`check` 记为异常并以 3 结束。

可读正文统一剥离部署包装，包括注入消息的 `<dsh-injection …>…</dsh-injection>`、用户消息与助手消息的 `<dsh-message …>…</dsh-message>`、普通工具结果的 `<dsh-result …>…</dsh-result>`，以及正文中被引用的子代理发言的 `<dsh-message …>` 起点行与其 `<\/dsh-message>` 终点行。最后一类只在起点行与终点行各自独占一行且成对出现时删除这两行，两行之间的正文逐字保留；找不到成对时整段原样保留。其余不完整或形态异常的包装原样显示，不做截取。需要逐字原文时用 `show --format jsonl`，它保留全部原始事件。

上下文替换与其它合成消息不会显示成 `**用户**`：

- 标准模式的压缩检查点，以及旧格式自定义交接投递的摘要消息，渲染为 `**上下文摘要**`，正文只出现一次。
- 新格式自定义交接不投递摘要：交接正文保留在 `**助手**` 条目，历史替换后投递的压缩通知渲染为 `**交接通知**`，正文只含投影层路径与读取要求。
- 自定义模式交接的生成提示词渲染为 `**交接指令**`。
- 子代理会话自身的首条任务消息渲染为 `**子代理任务**`。

## 命令

脚本路径相对于本技能目录。`<project_tmp>` 是项目临时目录占位符，`& $desktopNode` 是“运行前提”一节设置的执行载体。

```text
& $desktopNode scripts/session-reader.ts list   --output-dir <project_tmp> [--name <basename>] [--workspace <路径|标题>]
                                      [--since <时间>] [--until <时间>] [--title <关键词>]
                                      [--origin all|main|subagent] [--include-blank] [--limit N]
                                      [--sort time|created|title|size|turns] [--full] [--format md|json]
& $desktopNode scripts/session-reader.ts show   <id|唯一前缀|last> --output-dir <project_tmp> [--name <basename>] [--summary]
                                      [--role user|assistant] [--thinking] [--tools] [--events] [--subagents]
                                      [--headers] [--truncate N] [--turn <A-B|A>] [--seq <A-B|A>]
                                      [--head N] [--tail N] [--probe] [--format md|json|jsonl]
& $desktopNode scripts/session-reader.ts search <关键词> --output-dir <project_tmp> [--name <basename>] [--scope text|tools|all]
                                      [--case-sensitive] [--context N] [--limit N] [--session <会话标识>]
                                      [--exclude-session <会话标识>] [--workspace <路径|标题>]
                                      [--since <时间>] [--until <时间>] [--origin all|main|subagent] [--format md|json]
& $desktopNode scripts/session-reader.ts stats  [<id|唯一前缀|last>] --output-dir <project_tmp> [--name <basename>]
                                      [--workspace/--since/--until/--origin；仅全局聚合可用] [--format md|json]
& $desktopNode scripts/session-reader.ts check  [<id|唯一前缀|last>] --output-dir <project_tmp> [--name <basename>] [--format md|json]
```

全局选项为 `--dsh-home <路径>`、`--lib-root <目录>`、`--output-dir`、`--name`、`--format` 与 `-h/--help`。选项不可重复，否则退出 2；开关不接受值；支持 `--opt=value`；位置参数不终止选项解析。

## 选项语义

- `--format <md|json|jsonl>`：默认 `md`；`jsonl` 仅 `show` 支持，是逐事件穷尽与逐字核对的入口。
- `--context N`：命中处两侧各取 N 个码点，默认 60；被裁剪的一侧加 `…`。
- `--limit N`：限制产物列出的条数，默认 100，`0` 为不限；不改变命中总数与覆盖声明。
- `--case-sensitive`：检索区分大小写，默认不区分。
- `--head N`、`--tail N`：只对根块的时间线条目取首条数或末条数，`0` 为不限。
- `--truncate N`：按码点截断所有正文载体，`0` 为不截断；轮次大纲同此口径。头部字段块不受该选项影响。
- `--turn A-B`、`--seq A-B`：区间含端点，`--turn` 最小 1，`--seq` 最小 0。作用于每个块，子代理块按自身事件流计；两者同用时取交集。
- `--since`、`--until`：接受毫秒数或严格 ISO 时间。纯数字按毫秒解释，无时区后缀按 UTC。与会话的最近活动时间比较，缺失该时间时用创建时间；双端含端点，不校验先后。
- `--title <关键词>`（`list` 专有）：对标题做子串匹配，不区分大小写；标题不可用时该会话落选（判据见“会话标题”一节）。无匹配时正常返回空结果，退出 0。
- `--workspace <路径|标题>`：路径归一化后全等匹配，或工作区标题全等匹配，均不是子串；无匹配时退出 1。
- `--origin <all|main|subagent>`：按会话日志头的 `origin` 判定，缺失或其它值算主会话。
- `--role <user|assistant>`：只过滤对话消息，工具与事件不受影响；给出该选项后摘要行会说明角色过滤。
- `--thinking`、`--tools`、`--events`：分别显示推理、工具调用与结果、生命周期事件与系统消息。默认全部隐藏。
- `--subagents`：`show` 连带导出子代理会话。子代理块固定 H2，用路径编号表达父子关系。与 `--probe` 互斥。
- `--headers`：在标签行括号内追加 `seq N` 与本地时间，位置在来源标注之前。
- `--full`：`list` 改用逐会话块，标题改为 `# 会话列表（完整）`。与 `--format json` 同用时被接受但无效果。
- `--include-blank`：`list` 专有，用于显示空会话。`search` 与 `stats` 恒包含空会话，没有该选项。
- `--sort <time|created|title|size|turns>`：默认 `time`；`title` 升序，其余降序；并列按会话 id 排序。
- `--summary`：`show` 用轮次大纲替代时间线，`--role`、`--thinking`、`--tools`、`--events`、`--headers` 被接受但无效果；与 `--probe` 同用时按 `--probe` 处理。轮次大纲与 json 的 `turns` 不含来源标注，也不含 `**提问**` 与 `**回答**`。
- `--probe`：只输出头部、预计字节数、消息数与问答数，不含会话正文。问答数分别给出提问事件数与产出回答的结果数；提问被中止或取消时回答数会小于提问数。可与其它呈现类开关同用，按同一组开关渲染副本后据实计量。
- `--session`、`--exclude-session`：目标语法与 `show` 相同，作用为该会话及其子代理子树的正选与反选；两者可同时给出并取交集。
- `--scope text|tools|all`：默认 `text`，三档单调包含。
  - `text` 含用户与助手正文，以及 `**提问**`、`**回答**`、`**上下文摘要**`、`**交接通知**`、`**交接指令**`、`**子代理任务**` 六类条目的可读文本，与 `show` 默认参数同一可见性。
  - `tools` 另含工具调用参数与工具结果正文，包括问答的原始载荷。
  - `all` 另含推理、系统消息、压缩摘要、命令、标题请求、web 检索请求、交付物、待办、代理信箱，以及每个事件的完整 JSON 载荷。它是取回被默认排除内容的入口。
  - 被抑制的助手副本与 `**交接**` 的结构信息在 `text` 与 `tools` 档不产生检索单元，其正文已由 `**上下文摘要**` 或 `**助手**` 承载；`all` 档仍保留整条事件载荷。
  - `text` 与 `tools` 档在确有排除项时声明排除了多少条框架注入与子代理调度回执。
  - `all` 档的载荷是事件的 JSON 序列化，字段值里的引号、反斜杠与制表符是转义形态。需要逐字核对原文时用 `show --format jsonl`。

选项互斥，违者退出 2：

- `--role`、`--thinking`、`--tools`、`--events`、`--headers`、`--truncate`、`--turn`、`--seq`、`--head`、`--tail`、`--probe` 只对 md 有效。
- `--format jsonl` 另禁止 `--summary` 与 `--subagents`。
- `--head` 与 `--tail` 互斥。
- `--summary` 与 `--turn`、`--seq`、`--head`、`--tail` 互斥。
- `--probe` 与 `--subagents` 互斥。
- `stats` 指定目标时禁止 `--workspace`、`--since`、`--until`、`--origin`。

组合冲突时 stderr 会给出可执行的替代写法，例如 `去掉 --events，或把 --format 改为 md`。解析错误只回显选项名与合法格式，不含会话内容。

`--` 之后的所有 token 一律作为位置参数，用于以 `-` 开头的关键词。必需选项必须写在 `--` 之前，例如 `search --output-dir <目录> -- "- item"`。`-h` 与 `--help` 出现在 `--` 之前即短路为帮助。

示例：

```text
& $desktopNode scripts/session-reader.ts list --output-dir <project_tmp> --workspace <工作区路径> --limit 20 --name 会话清单
& $desktopNode scripts/session-reader.ts show 39b27999 --output-dir <project_tmp> --thinking --tools
& $desktopNode scripts/session-reader.ts show last --output-dir <project_tmp> --subagents --format json
& $desktopNode scripts/session-reader.ts show last --output-dir <project_tmp> --turn 3-5
& $desktopNode scripts/session-reader.ts show last --output-dir <project_tmp> --probe
& $desktopNode scripts/session-reader.ts search compact --output-dir <project_tmp> --scope all
```

## 默认调用

默认调用只写命令、目标与 `--output-dir`，其余选项全部取默认值：

```text
& $desktopNode scripts/session-reader.ts list                      --output-dir <project_tmp>
& $desktopNode scripts/session-reader.ts show   <id|唯一前缀|last> --output-dir <project_tmp>
& $desktopNode scripts/session-reader.ts search <关键词>            --output-dir <project_tmp>
& $desktopNode scripts/session-reader.ts stats                     --output-dir <project_tmp>
& $desktopNode scripts/session-reader.ts check                     --output-dir <project_tmp>
```

默认行为：

- 输出 md，扩展名 `.md`，文本不截断；唯一的固定上限是命中分布表标题按码点截断 40。
- `show` 显示用户与助手正文、`**提问**`、`**回答**`、`**子代理任务**`、`**发往子代理**`、`**上下文摘要**`、`**交接通知**`、`**交接指令**` 与 `**交接**`；推理、其余工具调用与结果、生命周期事件默认隐藏。框架与插件注入的消息默认排除。
- `search` 使用 `--scope text`，不限定会话，`--limit 100`，`--context 60`，不区分大小写。
- `list` 使用 `--limit 100`、`--sort time`、`--origin all`，隐藏空会话。
- `check` 不给目标时校验全部会话。
- 结果只写入输出文件，终端只回两行。

## 输出文件与终端回显

- `--output-dir` 无默认值，惯例指向项目临时目录。目录不存在时创建；创建、写入或移动失败退出 3。
- 成功时 stdout 恰两行，第一行为 `完整输出已保存到: <绝对路径>`，第二行为 `<摘要>；输出文件共 N 行`。`N` 等于产物实际行数，摘要不因 `--format` 改变。会话正文只写入输出文件。
- 摘要内容：`list` 为匹配数与显示数；`search` 为命中数与显示数；`show` 为 `会话 <id>；事件 N 个`，`--summary` 为 `会话 <id>（摘要）；轮次 N 个`，`--probe` 为 `会话 <id>（规模探测）；事件 N 个；预计正文 M 字节`，`--subagents` 追加 `；子代理 N 个`；`stats` 为会话数与总轮次、工具调用；`check` 为会话数与异常项数。
- 失败时 stdout 为空，只有 stderr 一行。
- 产物为 UTF-8 无 BOM、LF、末尾恰一个换行。
- 未指定 `--name` 时，产物名为 `session-reader-<命令>-<UTC 时间戳>-<随机 6 位>.<扩展名>`；同名文件已存在则退出 2。
- 指定 `--name <basename>` 时，产物为 `<output-dir>/<basename>.<扩展名>`，同名文件被原子替换，会覆盖上一次内容。
- `--name` 只接受单一路径段：ASCII 字母、数字、`_`、`-`，以及全部汉字；长度按 UTF-16 单元计，1 到 64；不得含 `.`、路径分隔符、空白、控制字符或 Windows 保留设备名。违者退出 2。
- md 产物可直接通过 markdownlint，调用方无需把输出目录排除在静态检查之外；json 与 jsonl 不参与 lint。
- 产物可能含会话明文，按临时产物管理。
- `-h/--help` 写 stdout、退出 0、不需要 `--output-dir`。

## Markdown 输出

骨架只用固定词表，会话内容一律放在围栏或行内代码中。

- 文档标题：`# 会话列表`、`# 会话列表（完整）`、`# 会话记录`、`# 检索结果`、`# 统计`、`# 完整性校验`。
- 区块标题：`## 时间线`、`### 时间线`（子代理块）、`## 轮次大纲`、`### 轮次大纲`、`## 子代理 <路径编号>`、`## 每会话命中分布`。子代理块固定 H2，标题层级不随深度递进，父子关系只看路径编号，如 `1.2` 是第 1 个子代理的第 2 个子代理。
- 标签行恒以 `：` 收尾，共 16 个：`**用户**`、`**助手**`、`**推理**`、`**工具调用**（<name>）`、`**工具结果**`、`**工具结果**（错误）`、`**系统消息**`、`**事件**`、`**提问**`、`**回答**`、`**子代理任务**（<description>）`、`**发往子代理**（<子代理 id>）`、`**交接**`、`**上下文摘要**`、`**交接通知**`、`**交接指令**`。`**事件**` 不是围栏，同一行为 `` **事件**：`<类型>` `<载荷 JSON>` ``。
- 标签行括号内的顺序固定为 `seq N`、本地时间、来源标注。前两项只在 `--headers` 时出现；来源项只在事件是 `user/message` 且来源不是用户本人时出现。
- `**工具结果**（错误）` 与 `--format json` 的 `isError` 是同一个判据：结果被标记为错误，或其载荷带错误对象，任一成立即为错误结果。判定不看正文文案，正文以 `Error` 开头的普通结果不因此被标成错误。
- 来源标注为 `来源 <kind>`。`agent-message` 与 `subagent-settled` 追加发送方会话 id，`plugin` 追加插件名，其它 kind 不加取值；kind 缺失或为空时显示 `来源 未标注`。常见 kind 裸写，未列出的取值放在行内代码中原样显示。
- `**提问**` 与 `**回答**` 来自 `ask_user_question` 的调用与配对结果，默认可见，不受 `--tools` 与 `--role` 控制。提问逐题显示序号、标题、问题正文与选项；回答逐条显示问题标识、所选选项或自定义回答。提问被中止或取消时不显示回答条目，提问照常呈现。载荷结构不符时，会渲染时间线副本的 md 形态（默认时间线、`--subagents`、`--tools`、`--probe`）退出 3 且不产出文件；`--summary` 不呈现问答条目，照常成功；`search` 把该会话列入排除项；json 与 jsonl 不做问答抽取，不受影响。
- `**子代理任务**` 与 `**发往子代理**` 来自 `subagent` 与 `send_message` 的调用实参，默认可见，并取代对应的原始工具条目。前者显示任务正文与括号内的 description，后者显示消息正文与括号内的子代理 id。调度参数不进默认产物，需要逐字核对时用 `--format jsonl`。子代理会话自身的首条任务消息也标为 `**子代理任务**`，括号内没有 description。
- `**交接**` 来自 `developer/message` 的 `handoff` 事件，只给结构事实，不复制正文。旧格式交接成功时正文由随后的 `**上下文摘要**` 承载；新格式不投递摘要，正文由紧邻其前的 `**助手**` 承载；没有投递消息时同样由紧邻其前的 `**助手**` 承载。条目恒为三行：`轮次 <turn>／步 <step>`、`历史替换 seq <start>-<end>（<n> 条事件）`、`投递 <target>；正文 seq <seq>（<字符数> 字符）`；缺失字段显示 `-`。该条目不受 `--thinking`、`--tools`、`--events`、`--role` 控制，`--events` 打开时不会重复显示为 `**事件**`，也不计入隐藏计数；`--summary` 不输出。
- `**上下文摘要**` 承载上下文替换的摘要正文，来源有两处：标准模式的压缩检查点保留检查点前言与 `<compacted-summary>` 标签；旧格式自定义交接投递的消息保留信封标签。不受上述四个开关控制，不计入隐藏计数；`--summary` 与 json 的 `turns` 不把它当成用户提问。新格式交接没有这一条目。
- `**交接通知**` 承载新格式自定义交接在历史替换后投递的压缩通知，正文只含压缩告知、投影层路径与读取要求，不含交接正文。它不是用户输入，不受上述四个开关与 `--role` 控制，不计入隐藏计数；`--summary` 不输出，`--summary` 与 json 的 `turns` 也不把它当成用户提问。检索单元名为 `交接通知`。
- `**交接指令**` 承载自定义模式交接的生成提示词。旧格式按结构位置识别，新格式按注入标记识别（生成阶段可能跨多个步骤并调用工具，指令与最终回复不相邻）；两种情况下都不会标成 `**用户**`，可见性与 `**交接**` 相同。
- `show` 头部字段：`- ID：`、`- 标题：`、`- 工作区：`、`- 创建：`、`- 类型：`、`- 父会话：`、`- 深度：`、`- 预设：`、`- 日志：`、`- 规模：`、`- 轮次：`、`- 令牌：`、`- 异常：`。`--probe` 追加 `- 预计字节数：`、`- 消息数：`、`- 问答数：`。
- `list --full` 每个会话一块，给出工作区、最近活动、轮次、大小、创建时间、cwd、预设、模型、令牌与元数据状态。
- `stats` 单会话给出会话标识、标题、空会话、轮次、步数、工具调用、令牌、创建与最近活动、预设、模型、日志与大小；全局给出会话数、空会话数、总轮次、总步数、工具调用总数、各类令牌合计、时间跨度与日志总大小。
- `check` 每个会话一行，给出格式版本、结构状态、帧数、行数、seq 是否连续、坏行数与异常数，末尾给出结论行。结构状态可能是 `完整`、`结构损坏` 或 `tornStart@<偏移>`。
- `search` 命中行为 `` - `<完整 id>`（seq <N>）`<标签>`：`<片段>` ``。事件是 `user/message` 且来源不是用户本人时，括号内追加来源。标签可能是事件类型，也可能是检索单元名，如 `user`、`assistant`、`assistant/reasoning`、`tool/call`、`tool/result`、`system`、`agent/inbox`、`title-request`、`command/run`、`command/done`、`todo`、`deliverables`、`web-search-request`、`compaction/summary`、`提问`、`回答`、`上下文摘要`、`交接通知`、`交接指令`、`子代理任务`。事件类型缺失时标签为 `(未知类型)`。
- `show --summary` 的条目为 `- T<turn>（seq <seq>）：<prompt> → <response>`；会话没有轮次事件时整段为 `无`。
- `list` 默认是一张表格，每行列出一个会话的 id、标题、工作区、最近活动、轮次、类型与大小。
- 载体：多行文本用动态长度的 `text` 围栏，反引号数量保证不被内容打断；单行文本用行内代码，表格单元格内的 `|` 会转义。
- 归一化：CR 与 CRLF 折叠为 LF，制表符换成 4 个空格，行内值去掉首尾空白，行内值与轮次大纲把换行换成空格。其余字符原样保留，超长单行不截断。
- 截断：`--truncate N` 按码点截断所有正文载体并追加 `…`，`0` 为不截断。`**交接**` 的结构事实行不截断，命中分布表标题固定截断 40。
- 空值显示 `-`，元数据不可用显示 `元数据不可用`。列表与命中行给出完整会话 id，可直接作为目标参数。

## JSON 与 JSONL

- `list --format json`：`{ sessions, coverage }`。会话字段为 `id`、`type`、`title`、`cwd`、`workspaceTitle`、`createdAt`、`lastActivityAt`、`lastPromptAt`、`turns`、`steps`、`blank`、`agentPreset`、`model`、`tokens`、`sizeBytes`、`metadata`；`metadata` 为 `{ available, reasons }`。元数据不可用时，由元数据派生的字段为 `null`，`createdAt`、`lastActivityAt`、`sizeBytes` 不受影响。
- `show --format json`：`{ session, meta, turns, messages, subagents, coverage }`。`messages` 只含五类事件，推理与工具调用内嵌其中，生命周期事件只计入 `meta`。
  - `user/message` 字段为 `seq`、`time`、`type`、`role`、`text`、`source`。
  - `assistant/message` 另含 `reasoning` 与 `toolCalls`。
  - `tool/call` 字段为 `seq`、`time`、`type`、`role`、`callId`、`name`、`arguments`。
  - `tool/result` 字段为 `seq`、`time`、`type`、`role`、`callId`、`isError`、`text`；`isError` 在 `message.isError` 为真或 `data.error` 存在时为 `true`。
  - `system/message` 字段为 `seq`、`time`、`type`、`role`、`text`。
  - `source` 为 `{ kind, form, senderSessionId, plugin }`，无值者为 `null`，是判断是否用户本人的判据。
  - `--summary` 时 `messages` 为空数组，`turns` 保留；`subagents` 只在 `--subagents` 时非空。
- `show --format jsonl`：首行是会话头，包含会话标识与格式版本；其后每行一个已解码事件，行数为事件数加一。不含子代理，不做可见性过滤，是逐事件穷尽与逐字核对的入口。
- `search --format json`：`{ matches, total, truncated, scope, totalIsExact, excludedInjections, coverage, scan, distribution }`。`matches[]` 字段为 `sessionId`、`seq`、`time`、`label`、`excerpt`、`source`；`distribution[]` 为 `{ sessionId, type, title, hits }`；`scan` 为 `{ logsDecoded, eventsRead, decodeFailures, frameFailures, observedFrom, observedTo }`。`excludedInjections` 为 `{ userMessages, subagentReceipts }`，使调用方判断 `text` 档 0 命中是否由默认排除造成。
- `stats --format json`：`kind` 为 `single` 或 `global`，各含 `coverage`、`scan` 与 `excludedMetricSessions`。`excludedMetricSessions` 是未计入轮次与步数的会话数，与 md 摘要行的 `（N 个会话未计入，原因见输出文件）` 同源，`single` 恒为 0。`single` 的 `session` 字段为 `id`、`title`、`blank`、`turns`、`steps`、`toolCalls`、`tokens`、`agentPreset`、`model`、`createdAt`、`lastActivityAt`、`logPath`、`logVersion`、`logCompressed`、`sizeBytes`、`metadata`。`global` 字段为 `sessionCount`、`blankCount`、`turns`、`steps`、`toolCalls`、`tokens`、`earliestCreatedAt`、`latestActivityAt`、`totalSizeBytes`、`unavailable`。
- `check --format json`：`{ sessions, anomalyCount, coverage }`。会话字段为 `id`、`logPath`、`formatVersion`、`classification`、`structure`、`structureDetail`、`frames`、`lines`、`seqContiguous`、`badLines`、`anomalies`。
- 时间：md 为本地时区含数值偏移的秒级 ISO 8601，如 `2026-09-18T22:39:06+08:00`；json 为原始毫秒数。
- 空值：md 为 `-`，json 为 `null`；元数据不可用时 json 另给 `metadata.reasons`。
- md 的 `**提问**`、`**回答**`、`**子代理任务**`、`**发往子代理**`、`**交接**`、`**上下文摘要**`、`**交接通知**`、`**交接指令**` 在 json 中不产生新的条目类型。问答与合成消息仍按 `user/message`、`tool/call`、`tool/result` 出现；交接事件仍是 `developer/message`，不进入 `messages`。新格式交接的通知与维护指令都出现在 `messages` 里，类型为 `user/message`，正文已剥离注入标记。

## 会话标题

会话标题有两个来源：`list`、`stats` 与 `search` 命中分布的标题取 dsh 投影缓存，`show` 取会话日志的 `session/title` 事件。两个来源都经过同一套归一化，取值与呈现规则一致。

- 归一化去掉首尾空白；空标题与以部署标记起点开头的标题一律视为不可用。标记判据是起点标签后紧跟一个空格：`<dsh-injection`、`<dsh-message`、`<dsh-result`；第四类是不带空格的起点 `<compacted-summary>`。这类取值是注入正文或落账标记的残片，不是标题。
- 按本判据不可用时 md 显示 `-`，json 为 `null`。
- 标题不可用不属于元数据不完整：不产生 `元数据不完整` 声明，也不影响其它元数据字段的可用性。
- `--title` 使用归一化后的同一取值，标题不可用的会话一律落选。

## 覆盖范围

每份产物都声明扫描、纳入与排除的会话数，让调用方判断结论强度。

- md 为 `扫描会话 N 个；纳入 M 个；排除 K 个`，随后逐条列出 `排除会话：<完整 id>（<原因>）`。json 为 `coverage: { scannedCount, includedCount, excluded }`，`show` 另有 `unattributable`。
- `N = M + K` 恒成立。核对覆盖范围要看逐条排除项，这个等式本身不携带额外信息。
- `list` 的 `M`、`K` 描述发现阶段的全库覆盖：`M` 是日志头可读的会话数，`K` 是不可读者。它与范围过滤、空会话隐藏、`--limit` 无关。
- `search` 与 `stats` 的 `M` 是本次作用域内实际进入检索或统计的会话数；`K` 是发现阶段不可读的全库会话，加上作用域内解码失败或问答载荷结构不符者。同一会话不会同时计入 `M` 与 `K`。
- `show` 的 `N`、`M` 是本目标及其子树的可读节点数，`K` 恒为 0。`show --subagents` 另对无法判断归属的会话输出 `归属未知：<id>（<原因>）`，不计入 `N`、`M`、`K`。
- `stats <目标>` 恒为 `扫描会话 1 个；纳入 1 个；排除 0 个`。`check` 的 `K` 恒为 0。
- 聚合命令跳过不可读会话并声明，退出 0；单目标命令遇到同类情况退出 3。`--limit` 不影响 `N`、`M`、`K`。
- `list` 另输出合计、隐藏的空会话数，以及每个元数据不完整条目的原因。
- `search` 与 `stats` 另输出扫描明细与事件时间范围。事件时间取自事件自带的时间，与会话最近活动时间不是同一口径。
- `stats` 在存在指标不可用的会话时，摘要行追加 `（N 个会话未计入，原因见输出文件）`，并在产物中逐条说明。`stats` 的 `会话数` 是作用域内的会话总数，可能大于覆盖声明的纳入数，因为后者只数实际进入统计的会话。
- `search` 另输出命中总数、检索范围与每会话命中分布。命中分布含 0 命中的纳入会话，按命中数降序、同数按会话 id 升序，表给出会话、类型、标题与命中数。命中总数是检索单元内的匹配次数，不是文本出现次数。产物中的 `命中总数 X 为精确值` 表示该数未被 `--limit` 截断。
- `show` 在范围选择生效时输出 `筛选：…`，在存在隐藏项、角色过滤或截断时输出 `摘要：…`。两者都是条件输出。
- `--probe` 产物不含覆盖声明。

## 默认参数下的注入过滤

默认只保留会话双方的真实交流。框架与插件为运行而注入的状态提示、调度通知与调度回执默认不保留。判定只看消息在日志里的来源字段，与正文文案无关。

默认保留的来源种类：

| 来源种类 | 内容 |
| --- | --- |
| `user` | 用户本人的输入 |
| `compact-checkpoint` | 标准模式的压缩检查点，渲染为 `**上下文摘要**` |
| `handoff` | 自定义模式交接的协议消息：维护指令渲染为 `**交接指令**`，历史替换后的压缩通知渲染为 `**交接通知**` |
| `subagent-settled` | 子代理结算回传 |
| `agent-message` | 子代理或其它代理的中途发言 |
| `user-question-reply` | 用户对提问的延迟回答。提问被中止或取消时它是唯一的答案记录；配对结果同时存在时同一答案会出现两次 |

其余来源一律默认排除，包括运行时上下文、技能目录、后台任务通知、模型切换通知、工作区指令、审批通知、插件注入、系统提示、时间上下文、计划模式等，以及来源缺失或为空的消息。保留名单是白名单，未列出的新来源默认不显示。

另外两类默认排除：`subagent` 调用产生的调度回执，以及 `subagent/catalog` 登记事件。

排除数量会在摘要行逐项声明。取回方式：`--events` 恢复注入消息，`--tools` 恢复调度回执与其它工具，`search --scope all` 恢复被排除内容的检索，`show --format jsonl` 逐事件穷尽导出。

`--thinking`、`--tools`、`--events` 控制的是框架事件与工具细节的默认隐藏，与注入过滤是两套机制。`--role` 只过滤对话消息。范围选择与过滤叠加。覆盖声明不受影响，因为排除的是消息而不是会话。

## 退出码与错误

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功，含 0 命中、空结果、`--help`、`check` 未发现异常 |
| `1` | 目标不存在，含前缀歧义、`--workspace` 无匹配、`--dsh-home` 不存在、`sessions` 缺失 |
| `2` | 参数错误，含 `--name` 非法、选项组合违规、缺 `--output-dir`、关键词为空、前缀短于 8 字符、未给 `--name` 时输出文件已存在 |
| `3` | 数据或 IO 错误，含 `check` 发现异常、输出目录或文件操作失败、官方格式库加载失败、问答载荷结构不符 |

- stderr 恒为一行 `错误: <分类>`，分类只有 8 个：`参数无效`、`目标不存在`、`数据不可读`、`内部错误`、`输出目录创建失败`、`输出文件已存在`、`输出写入失败`、`输出移动失败`。错误行不含会话内容、会话标识、用户名与任何绝对路径（dsh 数据路径与安装路径都算），锚点位置只以 `%LOCALAPPDATA%` 占位形态出现，因此可以原样转贴。
- 分类后可能附括号说明。调用方应只依赖退出码与分类分流，不要对括号内容做全等匹配。
- 临时文件清理失败并入当次失败分类：写入阶段的临时文件未能清理时报 `输出写入失败（临时文件未清理）`，移动阶段未能清理时报 `输出移动失败（临时文件未清理）`；说明不含任何路径。
- `check` 发现异常时先写出产物并打印两行 stdout，再以 3 结束，stderr 为空。退出码 3 不代表没有产物。
- 目标解析有三种结果：唯一匹配且可读时执行；多个匹配时报 `目标不存在（候选 N 个）` 并退出 1；目标存在但日志头不可读时报 `数据不可读` 并退出 3。

## 使用要点

- 目标可写完整 id、唯一前缀或 `last`。前缀不区分大小写，按原 token 计最短 8 字符，可省略 `session-`。`last` 区分大小写，表示最近活动的主会话；没有主会话时退出 1。
- 先用 `list` 定位会话，再用 `show` 读取、`search` 核对内容。
- 范围选择只改变呈现，不改变覆盖声明与统计。
- 读大会话前先用 `show <目标> --probe` 判断规模。预计字节数是按同一组选项完整导出时的 UTF-8 字节数。
- `show` 头部与 `--probe` 产物都含会话日志的绝对路径，可能带用户名，按敏感信息处理。
- 检索时先看每会话命中分布，再用 `--exclude-session <标识>` 排除自己这次会话及其子代理子树，避免把复述过的内容算进结论。
- `--since`、`--until` 按会话最近活动时间过滤整会话，不筛选事件时间。产物中的事件时间范围才是事件时间口径。
- `list` 默认隐藏空会话，`search` 与 `stats` 恒包含空会话，三者的集合可能不同。
- 推理、工具调用与结果、生命周期事件默认隐藏，分别用 `--thinking`、`--tools`、`--events` 显示。`--events` 同时显示系统消息。`**提问**`、`**回答**`、`**子代理任务**`、`**发往子代理**`、`**上下文摘要**`、`**交接通知**`、`**交接指令**` 与 `**交接**` 不受这些开关控制。
- `**用户**` 只表示事件的模型可见角色。判断是否用户本人要看同行括号内的来源标注，用户本人的消息没有来源项。需要按来源筛选时用 json 的 `source`。
- 会话的预设名在 `list` 与 `show` 中可能不同，前者取自投影缓存，后者取自会话日志头。判断以 `show` 的 `- 预设：` 为准。
- `list` 与 `stats` 的元数据来自 dsh 投影缓存。缓存不可用或版本不符时，相关字段显示 `元数据不可用`，json 为 `null` 并给出原因。投影缓存升级后，这些字段会整体不可用，直到技能更新。
- `check` 不带目标时校验全库，包括日志头不可读的会话；带目标时按目标解析三态处理。要诊断损坏会话本身，去掉目标查全库。
- 尾部截断与坏行会在产物中标注。尾部不完整帧及其后续内容整体丢弃，标注 `尾部未完整帧已丢弃`。
- 需要逐事件穷尽或逐字原文时用 `show --format jsonl`。`--format json` 只含五类消息事件。
