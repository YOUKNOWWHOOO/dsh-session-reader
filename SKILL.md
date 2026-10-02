---
name: session-reader
description: 当需要查看、列出、检索、统计或校验本机 dsh（DeepSeek Harness）会话历史（含子代理会话），而 dsh 自身不提供会话读取命令时加载。
---

# session-reader 技能

读取、列出、检索、统计与校验 dsh 会话历史。离线、只读：不运行 dsh、不联网、不产生模型调用、不读取凭据。

## 运行前提

- 平台：Windows；PATH 中需有 Node（v26 线，原生执行 TypeScript，无需构建）。
- 本机需有 dsh 安装（提供官方格式库与会话数据）。主目录默认 `$DSH_HOME`，否则 `~\.dsh`，可用 `--dsh-home` 覆盖；该路径不存在、或其下缺 `sessions\` 时退出 1。
- 官方格式库的默认解析锚点按 dsh 自身的安装锚点探测：在 npm 缓存的 npx 目录下找同时含 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-session-format-catalog` 的 `node_modules`，命中数必须恰好 1；`<dsh-home>\profiles\node_modules` 只在它同时含这两个包时才参与。当前 DSH `0.2.0-rc.2` 的历史读取还要求 `historicalSessionFormatCatalog`、`createSessionFormatCatalogWithChildren` 与 `historicalChildCatalogSource`，缺少任一能力即退出 3，禁止降级为静态 catalog。可用 `--lib-root <目录>` 覆盖（取值必须是含 `@deepseek-ai` 的 `node_modules`）；无法唯一定位或库加载失败时退出 3。
- 全部命令必须显式指定 `--output-dir`，缺省退出 2。

## 输出使用规定

- `--output-dir` 无默认值，惯例指向项目临时目录（`<项目>/tmp/` 或 `<项目>/.tmp/`）。目录不存在时创建；创建、写入或移动失败退出 3。工具不校验路径合法性，也不限制其是否位于 dsh 主目录内。
- 成功时 stdout 恰两行：`完整输出已保存到: <绝对路径>` 与 `<摘要>；输出文件共 N 行`，`N` 等于产物实际行数。摘要给出该命令的关键计数，且同一调用不因 `--format` 改变：`list` 为匹配条数与显示条数、`search` 为命中处数与显示处数、`show` 为 `会话 <id>；事件 N 个`（`--summary` 为 `会话 <id>（摘要）；轮次 N 个`、`--probe` 为 `会话 <id>（规模探测）；事件 N 个；预计正文 M 字节`、`--subagents` 追加 `；子代理 N 个`）、`stats` 为会话数与总轮次/工具调用、`check` 为会话数与异常项数。会话正文只写入输出文件。失败时 stdout 为空，只有 stderr 一行。`--help` 例外：写 stdout、退出 0、不需要 `--output-dir`。
- 产物编码 UTF-8 无 BOM、LF、末尾恰一个换行。
- 未指定 `--name` 时产物名为 `session-reader-<命令>-<UTC 时间戳>-<随机 6 位>[a-z0-9].<扩展名>`；目标已存在即拒绝、退出 2（分类 `输出文件已存在`）。
- 指定 `--name <basename>` 时产物恒为 `<output-dir>/<basename>.<扩展名>`，扩展名由 `--format` 决定，同名产物被原子替换（覆盖即丢失上一次内容）。
- `--name` 取值：ASCII 字母、数字、`_`、`-`，加全部汉字（Unicode `Script=Han`，含扩展 B 及以后）；长度 1-64（按 UTF-16 单元）；禁 `.`、路径分隔符、空白、控制字符；禁 22 个 Windows 保留设备名 `CON`、`PRN`、`AUX`、`NUL`、`COM1`-`COM9`、`LPT1`-`LPT9`。违者退出 2，错误文案指出原因。
- 默认格式 `md` 的产物真实通过全局 markdownlint 基线（技能根 `.markdownlint.jsonc` 与全局基线逐条一致，无文件内豁免、无配置放宽）：调用方无需将输出目录排除在静态检查之外；`json`/`jsonl` 不参与 lint。
- 产物可能含会话明文，按临时产物管理。

## 覆盖范围与统计口径

覆盖声明让调用方无需读源码即可判断结论强度。md 形态为 `扫描会话 N 个；纳入 M 个；排除 K 个` 加逐条 `排除会话：<完整 id>（<原因>）`；json 形态为 `coverage: { scannedCount, includedCount, excluded: [{ id, reason }] }`，只有 `show` 的 coverage 另有 `unattributable: [{ id, reason }]`（恒存在，未开启 `--subagents` 时为空数组）；聚合命令（`list`/`search`/`stats`/`check`）的 coverage 没有该键。

- `N = M + K` 恒成立，且实现就是按 `N = M + K` 构造这三个数——它不是独立的核对手段；核对覆盖范围要看逐条列出的排除项。
- `list` 的 `M`/`K` 描述发现阶段的全库覆盖：`M` 是 header 可读的会话数，`K` 是 header 不可读的会话数。它与范围过滤、空会话隐藏、`--limit` 都无关；过滤结果由 `合计：匹配 A 个会话，显示 B 个（共扫描 C 个）` 表达（`C` 即 `N`）。
- `search` 与 `stats` 的 `M` 是本次作用域内实际进入检索/统计的会话数（范围过滤后的会话数减去其中解码失败者）；`K` 由两部分构成：发现阶段 header 不可读的全库会话（无从判定其是否符合过滤条件）与作用域内解码失败者。解码失败的会话只计入 `K`，不同时计入 `M`。
- `stats <目标>` 的覆盖声明恒为 `扫描会话 1 个；纳入 1 个；排除 0 个`；`show` 的 `N = M =` 本目标及其子树的可读节点数（`--subagents` 关闭时为 1）、`K` 恒为 0（可归属的排除项不存在，无法归属者走 `unattributable`）；`check` 的 `K` 恒为 0（其枚举本就不读 header）。`--limit` 不影响 `N`/`M`/`K`。
- `排除会话：<id>（<原因>）` 逐条列出 `K` 中每个会话；header 不可读时 `id` 为会话目录名。聚合命令（`list`/`search`/`stats`）跳过这类会话并声明、退出 0；单目标命令（`show`、`stats <目标>`）遇同类情况退出 3。
- 仅 `show --subagents` 追加 `归属未知：<id>（<原因>）` 行：header 不可读的会话无从取得 id 与父子关系，无法判定是否属于目标子树，故不计入 `N`/`M`/`K`，只声明读取缺口。
- `list` 另输出 `合计：匹配 A 个会话，显示 B 个（共扫描 C 个）`、`已隐藏空会话 D 个（--include-blank 显示）`（`D > 0` 时），以及对每个存在不可用字段的条目的 `元数据不完整：<完整 id>（<原因>）`。
- `search` 与 `stats` 另输出 `扫描明细：解码日志 X 份；读到事件 Y 个；解码失败 Z 份；帧解压失败 W 帧` 与 `事件时间范围：<下界> ~ <上界>`。时间取自**事件自带的 `time` 字段**，与会话最近活动时间不是同一口径；无事件时显示 `-`。`stats` 全局在存在轮次/步数不可用的会话时，摘要行追加 `（N 个会话未计入，原因见输出文件）`（该数字是"至少有一项指标不可用"的会话数；总轮次与总步数按项累加，因此某个只缺 `steps` 的会话仍会把它的轮次计入 `总轮次`），并在产物中逐条输出 `元数据不完整：<完整 id>（<原因>）`；`stats` 单会话输出 `元数据不完整：<原因>`（不带 id）。`元数据不完整` 的判据是该会话存在不可用字段（含「可读但缺字段」的情形），与 `list --full`/`stats` 头部 `**元数据**` 字段的 `部分缺失`、`不可用` 是同一状态的不同粒度。
- `search` 另输出 `命中总数：X`（被 `--limit` 截断时追加 `；已截断显示 N 条（--limit 0 显示全部）`）与 `检索范围：<scope>（<覆盖面描述>）；命中总数 X 为精确值`（先 `命中总数` 行、后 `检索范围` 行），以及 `## 每会话命中分布` 表格与其后的固定提示行 `用 --exclude-session <标识> 排除调用方自己的会话及其子代理子树。`（分布为空时整段不输出）。
- 命中总数是**检索单元内的匹配次数**，不是文本出现次数：同一段文本可能按正文、按字段、按事件载荷被各计一次，因此 `text` ≤ `tools` ≤ `all`（三档单调不减；没有工具事件时 `text` 与 `tools` 相等，除问答外没有其它工具事件时 `tools` 仅多计问答的原始载荷）。`为精确值` 表示该数未被 `--limit` 截断，因此 `--scope all` 下「0 命中」可作为「不存在」的证据——但仅限原文形态的关键词：`all` 档的载荷单元是事件的 JSON 序列化，其中的 `"`、制表符等会以转义形态出现，只存在于非文本字段里的、含这类字符的关键词可能命不中（按字段枚举的单元是原文，不受此限）。
- 命中分布逐会话给出命中数（含 0 命中的纳入会话），按命中数降序、同数按会话 id 升序，标题列按码点截断 40。用途是把**调用方自己的语料**从结论里剔除：检索在全库上做，发起检索的会话及其子代理会话也在库里，笔记与复述过的错误串都会被命中。
- `show` 另输出 `筛选：…；显示 X 条时间线条目（区间内事件 Y 个，共 Z 个事件）`（`…` 为 `turn A-B`、`seq A-B`、`首 N 条`、`末 N 条` 中以 `；` 连接者；**只有实际对该块生效的条件才出现**——`--head`/`--tail` 只作用于根块，因此子代理块不含 `首 N 条`/`末 N 条`；每个受影响的块各一条，`Z` 为该块自身的事件数）与 `摘要：…`（五段固定顺序：推理、工具、生命周期事件的隐藏数，角色过滤说明，截断说明）。这两行都是**条件输出**：没有任何范围筛选时不输出 `筛选：`，没有隐藏项/角色过滤/截断时不输出 `摘要：`。
- `show --probe` 只产出头部 KV 与 `- 预计字节数：`、`- 消息数：`、`- 问答数：`，不含覆盖声明。

## 输出格式（md）

骨架只用固定词表，会话来源文本一律经载体承载（来源标注里的插件名与会话 id 同样入载体，见标签行一条）：

- 文档标题：`# 会话列表`（`list`）、`# 会话列表（完整）`（`list --full`）、`# 会话记录`（`show`）、`# 检索结果`（`search`）、`# 统计`（`stats`）、`# 完整性校验`（`check`）。
- 区块标题：`## 时间线`（根块）、`### 时间线`（子代理块）、`## 轮次大纲`（`--summary`）、`### 轮次大纲`（子代理块）、`## 子代理 <路径编号>`（恒 H2，编号如 `1`、`1.1`）、`## 每会话命中分布`（`search`）。路径编号是各层内子节点的 1 起序号、以 `.` 连接，因此 `1.2` 表示根的第 1 个子代理的第 2 个子代理。
- 标签行恒以 `：` 收尾，穷尽 12 个：`**用户**`、`**助手**`、`**推理**`、`**工具调用**（<name>）`、`**工具结果**`、`**工具结果**（错误）`、`**系统消息**`、`**事件**`、`**提问**`、`**回答**`、`**子代理任务**（<description>）`、`**发往子代理**（<子代理 id>）`。`**事件**` 不是围栏，同一行为 `` **事件**：`<类型>` `<载荷 JSON>` ``。标签行括号内的标注项顺序固定为 `seq N` → `<本地时间>` → `来源 …`：前两项仅 `--headers` 出现，来源项恒出现且仅当该事件是 `user/message`、且来源不是用户本人（`**助手**`、`**推理**`、`**工具调用**`、`**工具结果**`、`**系统消息**`、`**事件**`、`**提问**`、`**回答**`、`**子代理任务**`、`**发往子代理**` 不加标注，用户本人的消息也不加）。`**工具调用**（<name>）` 的选项名括号在加粗之内，`--headers` 的括号紧随其后，因此该行带两个括号，形如 `` ``**工具调用**（`read`）（seq 15；<本地时间>）：`` ``。
- 来源标注的形态为 `来源 <kind>`：`agent-message` 与 `subagent-settled` 追加 `<senderSessionId>`（入行内载体，取值可直接作为 `show` 的前缀目标），`plugin` 追加插件名（入行内载体），其余 kind 不加取值，`kind` 缺失、非字符串或空串时为 `来源 未标注`（空串没有信息量，按缺失处理）。kind 在本技能识别的词表（`user`、`plugin`、`model`、`tool`、`agent-message`、`subagent-settled`、`skill-catalog`、`skill-invocation`、`agent-instructions`、`team-message`、`coordinator`、`subagent-report`、`goal`、`webhook`、`session-reference`）内时裸写，词表外的值入行内载体原样呈现（来源种类是官方与插件共同扩展的合并联合，该词表不是完整声明，未知取值不得丢弃或改写）。`**用户**` 标签不能单独作为"这条消息是用户写的"的证据，来源标注才是判据。
- `**提问**` 与 `**回答**` 是默认可见的成对条目，来自 `ask_user_question` 工具的调用与配对结果（`tool/call` 与同一 callId 的 `tool/result`），载体内容是可读文本：提问逐题给出序号与标题、问题正文，以及每个选项的名称与说明；回答逐条给出对应问题标识，以及所选选项或用户自定义回答。两者恒出现且没有关闭开关，不受 `--tools` 与 `--role` 控制（`--tools` 打开时同一事件会同时以原始工具条目与问答条目出现），仍受 `--turn`/`--seq` 与 `--head`/`--tail` 影响，且不计入 `已隐藏 N 条工具调用/结果`。配对结果为错误态（`message.isError` 为 `true` 或 `data.error` 存在）时不产出 `**回答**` 条目、提问照常呈现：提问被中止或取消是正常产品形态，不是载荷异常；需要核对某个提问为何没有回答时用 `--tools` 查看该提问的结果条目。载荷结构与预期不符时不输出任何降级内容：`show` 以退出码 3 报 `数据不可读` 且不产出文件，`search` 把该会话逐条列入覆盖声明的排除项（原因 `问答载荷结构不符合预期`）；`--format json` 与 `jsonl` 不受影响。
- `**子代理任务**` 与 `**发往子代理**` 是默认可见的成对能力，来自 `subagent` 与 `send_message` 两个工具的调用实参：前者呈现 `arguments.prompt`（任务正文），括号内是 `arguments.description`；后者呈现 `arguments.message`（后续消息正文），括号内是 `arguments.agent_id`。两者取代对应调用的原始工具条目（同一调用只呈现一次），因此不受 `--tools` 控制；`provider`、`model`、`reasoning_effort`、`run_in_background` 等调度参数不进默认产物，需要逐字核对完整实参时用 `--format jsonl`。调度回执（`started subagent <id>`）默认不呈现，`--tools` 打开时作为工具结果出现。
- `show` 头部字段：`- ID：`、`- 标题：`、`- 工作区：`、`- 创建：`、`- 类型：主会话|子代理`、`- 父会话：`（子代理）、`- 深度：`（子代理）、`- 预设：`、`- 日志：`（会话日志绝对路径）、`- 规模：<大小>；v<N>；<帧> 帧；<行> 行；<事件> 事件`、`- 轮次：<轮次>；步数：<步数>；工具调用：<数>`、`- 令牌：输入 A；输出 B；缓存读 C；推理 D`、`- 异常：…`（有异常时）。`--probe` 追加 `- 预计字节数：N（完整导出正文大小，按 UTF-8 计）`、`- 消息数：X 用户 / Y 助手` 与 `- 问答数：<P> 提问 / <Q> 回答`（事件数口径：`P` 为提问事件数，`Q` 为产出回答条目的结果数；未配对的提问以及被中止或取消的提问都不产出回答条目，因此这些情况下回答数小于提问数）。
- 表格只有两处：`list` 精简列的 `| ID | 标题 | 工作区 | 最近活动 | 轮次 | 类型 | 大小 |`，与命中分布的 `| 会话 | 类型 | 标题 | 命中 |`。
- `list --full` 每个会话一个块：`- <完整 id>：<标题>（主|子）`，续行两空格缩进 `**工作区**`、`**最近活动**`、`**轮次**`、`**大小**`、`**创建**`、`**cwd**`、`**预设**`、`**模型**`（`provider/model`）、`**令牌**`（`未缓存输入/输出/缓存读/缓存写`，斜杠分隔）、`**元数据**`（`projcache`、`部分缺失`、`不可用`）。
- `stats` 头部字段：单会话为 `会话`、`空会话`、`轮次`、`步数`、`工具调用`、`令牌：未缓存输入…`、`创建`、`最近活动`、`标题`、`预设`、`模型`、`日志`、`大小`；全局为 `会话数`、`空会话数`、`总轮次`、`总步数`、`工具调用总数`、`令牌-未缓存输入/输出/缓存读/缓存写`、`时间跨度`、`日志总大小`。`会话数` 是本次作用域内的会话总数（含随后因解码失败被排除者），因此它与同产物覆盖声明的 `纳入 M 个` 可以不同：`M` 只数实际进入统计的会话。
- `check` 每个会话一行：`- <id>：v=<N>；结构=<完整|结构损坏|tornStart@<偏移>>；帧=<N>；行=<N>；seq=<连续|不连续|->；坏行=<N>；异常=<N>`，有异常时追加 `；异常详情：…`；末尾为 `结论：无异常` 或 `结论：发现 N 项异常`。
- `show --summary` 的条目为 `- T<turn>（seq <seq>）：<prompt> → <response>`；会话无轮次事件时整段为 `无`。
- `search` 命中行为 `` - `<完整 id>`（seq <N>）`<标签>`：`<片段>` ``。命中所在事件为 `user/message` 且来源不是用户本人时，`（seq <N>）` 内追加 `；来源 …`，形态与标签行的来源标注完全同源。标签在事件载荷命中上是事件类型（如 `assistant/attempt`、`llm/retry`），在按字段枚举的命中上是工具自造的单元名（`user`、`assistant`、`assistant/reasoning`、`tool/call`、`tool/result`、`system`、`agent/inbox`、`title-request`、`command/run`、`command/done`、`todo`、`deliverables`、`web-search-request`、`compaction/summary`、`提问`、`回答`；事件类型为空时写作 `(未知类型)`）。
- 载体：多行文本用动态长度反引号围栏（语言标注 `text`，反引号长度 = 内容最长连续反引号串 + 1 且不小于 3）；单行文本用动态反引号行内代码跨度（内容以反引号开头或结尾时，在跨度内两端各补一个空格作内边距；表格单元格内 `|` 先转义）。
- 归一化共四条，前两条作用于全部载体、后两条只作用于行内载体与轮次大纲：CR/CRLF 折叠为 LF；制表符 → 4 空格；行内载体首尾空白去除（全空白值保留原样）；行内载体与轮次大纲把内嵌换行替换为空格。围栏载荷保留原始换行（不做第四条折叠），仅当所有非空行都以 `$`+空白开头时在载荷末尾追加一行单个空格。控制字符、RTL/组合字符、零宽字符与 NUL 在载体内原样保留，超长单行不截断。
- 截断：`--truncate N` 按 Unicode 码点截断并追加 `…`（长度可达 N+1），`0` 即不截断，作用于用户/助手正文、推理、工具参数、工具结果、系统消息、`--events` 载荷、轮次大纲与问答可读文本；标签、ID、表格与列表列不受影响。命中分布表标题固定按码点截断 40，不随 `--truncate` 变化。
- 空值显示裸 `-`，元数据不可用显示 `元数据不可用`。列表与命中行输出**完整 id**，可直接作为 `show`/`stats`/`check`/`search --session` 的目标参数。
- 读取建议：按标题词表定位区块，用围栏/行内代码边界识别原始文本与字段值；子代理块只由路径编号表达父子关系，标题层级不随深度递进。

## JSON 与 JSONL 结构

- `list --format json`：`{ sessions: [...], coverage }`。条目字段为 `id`、`type`（`main`/`subagent`）、`title`、`cwd`、`workspaceTitle`、`createdAt`、`lastActivityAt`、`lastPromptAt`、`turns`、`steps`、`blank`、`agentPreset`、`model`、`tokens`、`sizeBytes`、`metadata`（`metadata` 为 `{ available, reasons }`；不可用时**由元数据派生的字段**为 `null`，即 `title`、`lastPromptAt`、`turns`、`steps`、`blank`、`agentPreset`、`model`、`tokens`；`createdAt`、`lastActivityAt`、`sizeBytes` 来自 header 与日志文件本身，不受元数据可用性影响）。
- `show --format json`：`{ session, meta, turns, messages, subagents, coverage }`。`messages` 只含五类事件（`user/message`、`assistant/message`、`tool/call`、`tool/result`、`system/message`），推理与工具调用内嵌在条目中，生命周期事件不出现而只计入 `meta` 的计数。条目字段按类型给出：`user/message` 为 `seq`、`time`、`type`、`role`、`text`、`source`；`assistant/message` 为 `seq`、`time`、`type`、`role`、`text`、`reasoning`、`toolCalls`；`tool/call` 为 `seq`、`time`、`type`、`role`、`callId`、`name`、`arguments`；`tool/result` 为 `seq`、`time`、`type`、`role`、`callId`、`isError`、`text`；`system/message` 为 `seq`、`time`、`type`、`role`、`text`。`source` 是归属对象 `{ kind, form, senderSessionId, plugin }`（无值者为 `null`），是区分"用户本人"与"子代理中继、结算通知、插件注入"的唯一判据。`--summary` 时 `messages` 为 `[]` 而 `turns` 保留；`subagents` 仅在 `--subagents` 时非空。md 的 `**提问**` 与 `**回答**` 在这里不产生新的条目类型：问答仍以 `tool/call` 与 `tool/result` 出现在 `messages` 中，需要 md 的可读形态时用默认格式，需要逐字原文时用 `jsonl`。
- `show --format jsonl`：首行为**逻辑 header**（官方库归一化后的产物，不是磁盘首行原文），其后每行一个已解码逻辑事件，行数 = 逻辑事件数 + 1；磁盘物理 JSON 行数可能因 compact run、历史迁移插入或追加事件而不同。不含 `meta`/`turns`/`messages`/`subagents`/`coverage`，不含子代理。这是逐事件穷尽枚举的唯一入口。
- `search --format json`：`{ matches, total, truncated, scope, totalIsExact, coverage, scan, distribution }`；`matches[]` 为 `{ sessionId, seq, time, label, excerpt, source }`，其中 `source` 是该命中所属事件的归属对象（形态与 `show` 的 `messages[].source` 同源；非 `user/message` 事件为 `null`），`distribution[]` 为 `{ sessionId, type, title, hits }`，`scan` 为 `{ logsDecoded, eventsRead, decodeFailures, frameFailures, observedFrom, observedTo }`。
- `stats --format json`：`kind` 为 `single` 或 `global`，两种形态各含 `coverage` 与 `scan`。`single` 另有 `session`：`id`、`title`、`blank`、`turns`、`steps`、`toolCalls`、`tokens`、`agentPreset`、`model`、`createdAt`、`lastActivityAt`、`logPath`、`logVersion`、`logCompressed`、`sizeBytes`、`metadata`。`global` 另有 `sessionCount`、`blankCount`、`turns`、`steps`、`toolCalls`、`tokens`、`earliestCreatedAt`、`latestActivityAt`、`totalSizeBytes`、`unavailable`（`[{ id, reasons }]`）；「N 个会话未计入」只出现在摘要行与 md，json 无该字段。
- `check --format json`：`{ sessions, anomalyCount, coverage }`；会话字段为 `id`、`logPath`、`formatVersion`、`classification`、`structure`、`structureDetail`、`frames`、`lines`、`seqContiguous`、`badLines`、`anomalies`（`lines` 与 `badLines` 是渲染层键名）。
- 时间：md 一律本地时区含数值偏移的秒级 ISO 8601（如 `2026-09-18T22:39:06+08:00`）；json 中 `createdAt`、`lastActivityAt`、事件 `time` 等为原始毫秒数。
- 空值：文本为 `-`，json 为 `null`；元数据不可用时 json 另给 `metadata.reasons`。

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

全局选项：`--dsh-home <路径>`（默认 `$DSH_HOME`，否则 `~\.dsh`）、`--lib-root <目录>`（默认按 dsh 自身的安装锚点探测，见「运行前提」；取值必须是含 `@deepseek-ai` 的 `node_modules`）、`--output-dir`、`--name`、`--format`、`-h/--help`。选项不可重复（重复即退出 2），开关不接受值，支持 `--opt=value`，位置参数不终止选项解析，`-h` 出现在 `--` 之前即短路为帮助。

## 选项语义

- `--context N`：命中处两侧各取 N 个码点的窗口（含命中本身），被裁剪侧加 `…`；默认 60。
- `--limit N`：`0` 表示不限，默认 100；只限制产物列出的条数，不改变命中总数与覆盖声明。
- `--head N` / `--tail N`：`0` 表示不限；只作用于根块的时间线条目。
- `--truncate N`：按码点截断，`0` 表示不截断；轮次大纲同此口径，无固定上限。
- `--turn A-B` / `--seq A-B`：含端点，`--turn` 最小 1、`--seq` 最小 0，`B` 不小于 `A`；作用于每个块（子代理的 turn 与 seq 按自身事件流计），两者同用时取交集。
- `--since` / `--until`：接受毫秒数或严格 ISO 时间（纯数字按毫秒解释，无时区后缀按 UTC，如 `2026-09-15` 或 `2026-09-15T21:30:00Z`）；与「有效最近活动时间」比较（投影缓存的最近活动时间，缺失时回落会话创建时间），双端含端点；不校验两者先后。
- `--title <关键词>`：对投影缓存标题做子串匹配、不区分大小写；标题为 null 或元数据不可用时该会话落选。
- `--workspace <路径|标题>`：路径归一化后全等匹配（`\` 转 `/`、去尾部 `/`、转小写）或工作区标题全等匹配，均非子串；无任何匹配时退出 1（分类 `目标不存在`），与 `--title` 无匹配时退出 0 不同。
- `--origin <all|main|subagent>`：判据是会话 header 的 `origin` 为 `subagent`，缺失或其它值一律算主会话。
- `--role <user|assistant>`：只过滤对话消息，工具与事件不受影响；只要给出该选项，摘要行就追加角色过滤说明。
- `--headers`：给时间线标签追加 `（seq N；<本地时间>）`，位置在来源标注之前。
- `--full`：`list` 用逐会话块替代表格并改用 `# 会话列表（完整）`；与 `--format json` 同用时被接受但无效果。
- `--include-blank`：`list` 专有。默认隐藏 `blank` 为真者；`blank` 为 null（元数据不可用）不隐藏。`search` 与 `stats` 没有该选项，恒包含空会话。
- `--sort <time|created|title|size|turns>`：默认 `time`；`title` 升序、其余降序；并列按会话 id 排序，方向与主序一致（降序键的并列按 id 降序，`title` 的并列按 id 升序）。
- `--summary`：`show` 用轮次大纲替代时间线；其下 `--role`/`--thinking`/`--tools`/`--events`/`--headers` 被接受但无效果；与 `--probe` 同用时规模探测优先。轮次大纲的 prompt 与 json 的 `turns` 都不含来源标注（该视图没有标签行），需要按来源判别消息时用时间线（md）或 `messages[].source`（json）。时间线里的 `**提问**` 与 `**回答**` 也不出现在该视图。
- `--probe`：只落头部 KV、`- 预计字节数：`、`- 消息数：`、`- 问答数：`（`P` 为提问事件数，`Q` 为产出回答条目的结果数）；与其它呈现类开关可同用，按同一组开关渲染副本据实测字节。头部 KV 含 `- 日志：`（会话日志绝对路径，自带用户名与 dsh 数据布局），`--probe` 不改变这一点。
- `--session` / `--exclude-session`：与 `show` 目标同语法（含 `last`），作用为该会话及其子代理子树的正选与反选；两者可同时给出并取交集；目标不存在时退出 1。
- `--scope text|tools|all`：三档单调包含，`all` 为穷尽档，默认值为 `text`。`text` 含用户与助手正文，以及 `**提问**` 与 `**回答**` 两类条目的可读文本，与 `show` 默认参数**同一可见性**（框架与插件注入的消息、子代理调度回执都不进本档）；`tools` 另含工具调用参数与工具结果正文（含问答的原始载荷，同样排除框架注入与调度回执）；`all` 另含推理、系统消息、压缩摘要、命令、标题请求、web 检索请求、交付物、待办、代理信箱注入内容，以及**每个事件的完整 JSON 载荷**，因此日志中出现的任意事件记录都被纳入检索——它同时是取回被默认排除内容的入口。产物在 `text` 与 `tools` 档下追加 `已排除 N 条框架注入与 M 条子代理调度回执（--scope all 可检索）`，使调用方不会把"被默认排除"读成"不存在"。注意载荷单元是 `JSON.stringify` 的结果：字段值里的 `"`、反斜杠、制表符会变成转义序列，只有该字段原文形态的关键词才必然命中（逐字段枚举的单元取原文，因此文本字段不受此限）；需要逐字核对原文时用 `show --format jsonl` 导出原始事件行。

选项互斥（违者退出 2）：

- `--format json|jsonl` 下禁止一切**呈现类开关**（`--role`、`--thinking`、`--tools`、`--events`、`--headers`、`--truncate`、`--turn`、`--seq`、`--head`、`--tail`、`--probe`）——这十一个开关仅 `md` 可用。
- `--format jsonl` 下另禁止**内容范围开关** `--summary` 与 `--subagents`；`--format json` 允许这两个开关。
- `--head` 与 `--tail` 互斥。
- `--summary` 与 `--turn`/`--seq`/`--head`/`--tail` 互斥（`--summary` 呈现整会话轮次大纲，范围选择对其无意义）。
- `--probe` 与 `--subagents` 互斥（探测的意义是"读之前先问规模"，而 `--subagents` 会把产物扩展到整棵子代理树）。`--probe` **可以**与其它呈现类开关同用：它会按同一组开关渲染一份副本并据实报告字节数，因此 `--probe --events --truncate 500` 正是量出"带这些选项的完整导出有多大"的用法。
- `stats` 指定目标（单会话）时禁止范围过滤选项 `--workspace`/`--since`/`--until`/`--origin`（不做静默忽略）。
- stderr 括号说明有三个来源：组合冲突给出**合法替代写法**（形如 `去掉 --events，或把 --format 改为 md`）；解析层错误只回显选项名、子命令位 token 或位置参数占位名（`未知选项: --x`、`未知子命令: x`、`重复选项: --x`、`开关选项不接受值: --x`、`选项缺少值: --x`、`选项值为空: --x`、`选项值无效: --x`、`选项值必须是整数: --x`、`选项值超出范围: --x`、`缺少子命令`、`缺少位置参数: <位置参数名>`、`位置参数过多`、`该命令不接受位置参数`）；取值诊断给出选项名与合法格式（目标前缀过短时给出的是不含选项名的规则文本 `会话前缀至少 8 个字符`），其中 `--name` 的保留设备名分支会回显命中的保留设备名（大写形式，判定不区分大小写：传入 `con` 时回显 `CON`，便于调用方定位）。**只有组合冲突分支提供替代写法。**

选项终止符：`--` 之后的所有 token 一律作为位置参数（用于以 `-` 开头的关键词）。必需选项必须写在 `--` 之前，正确形态为 `search --output-dir <目录> -- "- item"`；把 `--output-dir` 写在 `--` 之后会被当作位置参数而报 `位置参数过多`。

示例（PowerShell）：

```text
node scripts/session-reader.ts list --output-dir <project_tmp> --workspace <工作区路径> --limit 20 --name 会话清单
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

- 输出格式为 md（lint-safe Markdown，载体与归一化见「输出格式（md）」；扩展名 `.md`）。
- 文本不截断（`--truncate 0`）；唯一的固定上限是命中分布表标题按码点截断 40。
- `show`：推理、工具调用/结果与生命周期事件隐藏，摘要行提示对应开关；用户与助手消息正文完整；`**提问**` 与 `**回答**` 两类问答条目默认可见，不受 `--tools` 控制；`**子代理任务**`（主代理发给子代理的任务正文）与 `**发往子代理**`（主代理发给已存在子代理的消息正文）同样默认可见、不受 `--tools` 控制；框架与插件自动注入的消息默认被排除（见「默认参数下的注入过滤」）；不施加范围选择，`--subagents` 关闭；产物含覆盖声明。
- `search`：`--scope text`（含用户与助手正文与问答可读文本，与 `show` 默认参数同口径，见「选项语义」）、不限定会话、`--limit 100`、`--context 60`、`--case-sensitive` 关闭；命中总数为全量。
- `list`：`--limit 100`、`--sort time`、`--origin all`、隐藏空会话。
- `check`：不给目标即校验全部会话，走不读 header 的枚举。
- 结果只写入输出文件；成功时 stdout 两行。

## 退出码与错误

- `0` 成功（含 0 命中、空结果、`--help`、`check` 无异常）；`1` 目标不存在（含前缀歧义、`--workspace` 无匹配、`--dsh-home` 不存在、`sessions` 缺失）；`2` 参数错误（含 `--name` 非法、选项组合违规、缺 `--output-dir`、`search` 关键词为空、前缀短于 8 字符、未给 `--name` 时目标已存在）；`3` 数据/IO 错误（含 `check` 发现异常、输出目录创建失败、输出写入失败、输出移动失败、官方格式库加载失败、问答载荷结构不符合预期）。
- stderr 唯一格式为 `错误: <分类>`，后可附 `（候选 N 个）` 或 `（<说明>）`。分类全集 8 个：`参数无效`、`目标不存在`、`数据不可读`、`内部错误`、`输出目录创建失败`、`输出文件已存在`、`输出写入失败`、`输出移动失败`。
- `check` 发现异常时先落盘并打印两行 stdout，再以 3 结束，stderr 为空；退出码 3 因此不代表没有产物。
- 失败路径 stdout 为空，只有 stderr 一行。说明的来源与边界见「选项互斥」，其中不含会话内容、会话 ID、用户名与 dsh 数据路径。
- 调用方只应依赖分类（退出码与 `错误: <分类>` 文本）做分流；括号说明可能扩展，不要做全等匹配。
- 目标解析三态可区分：唯一匹配且可读 → 正常执行；多个匹配 → `目标不存在（候选 N 个）`、退出 1；**目标存在于磁盘但 header 不可读** → `数据不可读`、退出 3；其余无匹配 → `目标不存在`、退出 1。`目标不存在` 同时覆盖工作区无匹配与 dsh 主目录不存在，无法从分类区分。

## 使用要点

- 目标可写完整 id、唯一前缀（大小写不敏感，按原 token 计最短 8 字符，可省略 `session-`）或 `last`。`last` 区分大小写（`LAST` 会被当作前缀而报前缀过短、退出 2）。`last` 指**最近活动的主会话**：在所有可读会话中排除子代理，按有效最近活动时间取最大，并列取 id 较小者；没有主会话时退出 1。歧义时按候选数改用更长前缀。`list`/`search` 产物中的完整 id 必然可直接使用。
- 范围选择只改变呈现，不改变覆盖声明与统计。`--head`/`--tail` 只作用于根块，`--turn`/`--seq` 作用于每个块，因此后者会裁剪子代理块，且各块的 turn 与 seq 编号互不相干。
- 先探测规模再决定是否读取：`show <目标> --probe` 只落头部 KV、`- 预计字节数：N`、`- 消息数：X 用户 / Y 助手`、`- 问答数：<P> 提问 / <Q> 回答`（`Q` 为产出回答条目的结果数），不含会话正文；`N` 等于以同一组选项做完整导出的 UTF-8 字节数。
- 检索时剔除调用方自己的语料：先看 `## 每会话命中分布` 定位来自自己会话与子代理的命中，再用 `--exclude-session <标识>` 整棵子树排除。
- `--since`/`--until` 按会话的最近活动时间过滤整会话，不筛选事件时间；产物中的 `事件时间范围` 才是事件时间口径，两者可能不一致。
- `search` 与 `stats` 恒包含空会话，`list` 默认隐藏，做「list 定位会话、search 核对内容」时注意两者集合不同。
- 推理、工具调用/结果与生命周期事件默认隐藏，分别用 `--thinking`、`--tools`、`--events` 显示；摘要行给出各类隐藏条数。`**系统消息**` 与生命周期事件同受 `--events` 控制，并合并计入「已隐藏 N 条生命周期事件（--events 显示）」，因此不给出 `--events` 时系统消息也整条不可见。`**提问**`、`**回答**`、`**子代理任务**` 与 `**发往子代理**` 不受这三个开关控制：它们默认就在时间线里，`--tools` 只控制其余工具调用与结果。
- `**用户**` 只表示该事件的模型可见角色，不代表"由人类用户写下"：真正的判据是同一行括号内的来源标注（形如 `来源 agent-message` 后接该子代理的会话 id，或 `来源 plugin` 后接插件名，取值均在行内载体里）。用户本人的消息没有来源项，因此"有来源项 ⇒ 不是用户写的"是可依赖的读法；需要按来源逐条筛选时用 json 的 `source` 归属对象。
- `check` 不带目标时走不读 header 的枚举，结构损坏与 header 不可读的会话也在诊断范围内；带目标时按目标解析三态处理——目标不存在、或前缀歧义时退出 1，目标存在但 header 不可读时退出 3 且无产物，只有可读目标才产出校验结果。要诊断损坏会话本身，去掉目标查全库。
- 尾部截断、坏行等异常在产物中显式标注（`show` 的 `- 异常：` 与 `check` 的异常详情）；尾部的不完整帧及其后续内容整体丢弃，标注 `尾部未完整帧已丢弃（v1 不做前缀抢救）`。聚合命令遇解码失败逐条排除而不中断，单目标命令则以退出 3 报错。
- `list`/`stats` 的元数据来自官方投影缓存（版本须为 7、身份四项全等、每行必须含合法非负整数 `ver` 与 `seq` 以及 `val`）；不可用时相关列标注 `元数据不可用` 并给出原因，json 中为 `null` 加 `metadata.reasons`。离线技能只能校验行结构，不能取得运行时投影注册表的精确 `stateVersion`，因此不把 `ver` 解释为已完成实时版本匹配。
- 需要逐事件穷尽枚举时用 `show --format jsonl`；`--format json` 只含五类消息事件，不含生命周期事件。

## 默认参数下的注入过滤

默认参数的提取目标是会话双方的真实交流。框架与插件为了运行而向模型注入的状态提示、调度通知与调度回执不是交流内容，默认不保留；只有携带真实内容的消息才保留。判据一律取自日志字段（`user/message` 的 `data.source.kind`、事件类型、`tool/call` 的 `name` 与 `callId`），与正文文案无关——同一注入换个文案、或把注入标记写进用户本人输入，都不会影响判定。

默认保留的来源种类（`data.source.kind`）：

| 来源种类 | 内容 |
| --- | --- |
| `user` | 用户本人的输入 |
| `compact-checkpoint` | 压缩产生的交接指令 |
| `subagent-settled` | 子代理结算回传 |
| `agent-message` | 子代理或其它代理的中途发言 |

其余来源一律默认排除，包括 `runtime-context`（运行时上下文快照）、`skill-catalog`（技能目录）、`tool-jobs`（后台任务完成通知）、`model-selection`（模型切换通知）、`plugin`、`model`、`tool`、`system-prompt`、`user-approval`、`ptc-mode`、`tool-registry`、`cordis-host-runner`、`team-message`、`coordinator`、`subagent-report`、`user-question-reply`、`goal`、`schedule`、`webhook`、`session-reference`、`skill-invocation`、`agent-instructions`，以及**来源缺失或为空**的消息（无法证明来源，默认不显示）。保留名单是白名单：来源种类是官方与插件共同扩展的合并联合，名单外的新种类默认不显示，不会误当作用户消息呈现。

另外两类默认排除：`subagent` 调用的 `tool/result`（正文形如 `started subagent <id>` 的调度回执，按 `toolCallId` 与调用配对识别）、`subagent/catalog` 登记事件（只含子代理身份与模式）。

被排除的条数在产物摘要行逐项声明（`已排除 N 条框架注入（--events 显示）`、`已排除 M 条子代理调度回执（--tools 显示）`），调用方据此判断产物是否经过过滤、以及该用哪个开关取回。取回方式：`--events` 恢复注入消息，`--tools` 恢复调度回执与其它工具调用结果，`search --scope all` 恢复全部被排除内容的检索，`show --format jsonl` 逐事件穷尽导出（它不做任何可见性过滤，是唯一不受过滤影响的形态）。

过滤与既有开关的关系：`--thinking`、`--tools`、`--events` 控制的是"框架事件与工具细节的默认隐藏"，与本次的注入排除是两套机制。`--role` 只过滤对话消息，不影响注入判定。`--turn`/`--seq`/`--head`/`--tail` 与过滤叠加。覆盖声明不受影响——排除的是消息而不是会话。
