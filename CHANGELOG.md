# Changelog

本文件记录本技能值得关注的对外变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。

## [Unreleased]

### Added

- 默认导出的时间线新增 `**交接**` 条目：上下文交接的结构事实，来自 `developer/message` 且其 `data.message.source.kind` 为 `handoff` 的事件。条目恒为三行——`轮次 <turn>／步 <step>`、`历史替换 seq <start>-<end>（<n> 条事件）`、`投递 <target>；正文 seq <seq>（<字符数> 字符）`；字段缺失按空值契约显示 `-`。该条目默认可见、没有关闭开关，不受 `--thinking`/`--tools`/`--events` 控制（`--events` 打开时同一事件不再以 `**事件**` 形态重复出现），不受 `--role` 影响，仍受 `--turn`/`--seq` 与 `--head`/`--tail` 影响，且不计入任何隐藏计数；`--summary` 不输出该条目，`--format json` 不新增条目类型。
- 交接条目**只给结构事实、不复制正文**：实测每次交接都是「`assistant/message`（交接正文）→ `developer/message`（`handoff`，空正文，承载 `surfaceOp: replace` 与 `sourceEventSeqs`）→ `agent/inbox/spliced`（同一正文加 `<compacted-summary>` 包裹后投递）」三段式，拼接载荷正文剥去包裹后与助手正文逐字相同；正文因此仍由既有的 `**助手**` 条目承载，避免同一段内容在产物中出现两次。

### Changed

- 标签词表由 12 个取值扩为 13 个（新增 `**交接**`）；结构门禁白名单、`SKILL.md`、`README.md` 与开发规范同步。
- 登记校正：`compact-checkpoint` 标注为**历史取值**（本机全量日志不出现该来源种类，交接改由 `developer/message` 的 `handoff` 型与 `agent/inbox/spliced` 承载），保留在默认保留名单内不改变任何可见性。
- 登记校正：`historicalChildCatalogSource` 更正为由 `@deepseek-ai/dsh-session-format-v3-to-v4` 导出（不在 `@deepseek-ai/dsh-session-format-catalog` 内），实现一直按两个包分别解析。
- 登记新增已知边界：投影缓存的版本校验是严格等值（必须恰为当前版本），官方写入端接受若干兼容旧版本；升版后列表与统计的元数据会整体退化为「不可用」，届时须按当期版本更新常量，不得放宽为区间匹配。
- 检索边界登记：`text` 与 `tools` 档不为 `**交接**` 条目另建检索单元（它只含结构元数据，正文已由 `assistant/message` 在 `text` 档可检索）；`all` 档仍含 `developer/message` 与 `agent/inbox/spliced` 的完整载荷。
- 修复：部署侧的边界插件会给工具结果加一层 `<dsh-result …>` 信封，`ask_user_question` 的回答正文因此可能不是裸 JSON，此前会让这类会话的 `show` 以退出码 3 报 `数据不可读`。现在解析回答载荷前先剥离一个完整信封；不以起点开头的正文（旧日志与未启用该插件的部署）仍按裸 JSON 解析，信封不完整或剥离后为空仍判为载荷异常并整体失败，不做尽力截取。
- 官方格式库的默认解析锚点改为**桌面版安装内的 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules`**：不再探测 npm 缓存的 npx 安装树与 `<dsh-home>\profiles\node_modules`，也不设任何回退；理由是桌面安装归档是库的唯一权威位置，另两处只取决于某次安装或运行的历史痕迹（`_npx` 安装树可能仍然存在），存在性与版本都随本机状态漂移。锚点必须同时含 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-session-format-catalog`，缺少 `%LOCALAPPDATA%`、非 Windows 或锚点不成立即退出 3 并说明。`--lib-root` 仍是显式覆盖入口，语义与取值约束不变。
- 运行载体说明同步为**桌面版 Electron-as-Node**：官方格式库位于 Electron 归档 `app.asar` 的虚拟路径内，只有桌面运行时能解析（PATH 中的系统 Node 解析不了该路径——其 `existsSync` 对归档内路径恒为 false——直接运行会以退出 3 失败）；因此所有命令示例改用桌面版执行载体占位符，`--lib-root` 的默认说明与错误文案同步指向新锚点。
- 开发与维护文档的校验链改用桌面版运行时执行，并把测试入口写成 `"tests/**/*.test.ts"` glob（目录形式 `--test tests` 在桌面版运行时的 Node 线上不可用）。
- 测试以子进程驱动 CLI 与门禁时统一传递 `ELECTRON_RUN_AS_NODE=1`：`process.execPath` 在桌面版宿主下是 Electron 可执行文件，缺少该变量会让子进程被当作桌面应用启动。
- 总帮助与各子命令帮助的用法行改用 `<desktop_node>` 占位符，并说明它指桌面版 Electron-as-Node 执行载体（原写法 `node session-reader.ts` 会被读成用 PATH 中的系统 Node 运行）；载体说明补上 shim 的 `DSH_DESKTOP_NODE_EXECUTABLE` 前提与它转发的 `--expose-internals`，使只读帮助的调用方不必另查文档即可凑齐调用参数。
- 文档一致性修正：`SKILL.md` 命令块补回 `list` 的完整用法行，运行前提登记 PowerShell 直接调用桌面版可执行文件不等待、取不到退出码的边界；开发与验证基线更新为本机桌面版安装实物 `0.2.1-rc.2`。

### Fixed

- 修复桌面版安装形态下默认组合无法加载官方格式库的问题（原探测路径只在 npm 缓存安装树下成立）。
- 现行文档与注释的事实性修正：删除"npm 缓存 npx 安装树已不存在"这一失真的理由（该树可能因某次 `npx dsh` 仍留在本机），改为按"桌面安装归档是库的唯一权威位置"说明唯一锚点；`profiles` 一项按当前布局改写为 `<dsh-home>\profiles\node_modules` 已不在、实际是每个 profile 各自的 `node_modules`。
- 现行文档与注释的口径修正：系统 Node 的限制改为"解析不了 `app.asar` 虚拟路径"（其 `existsSync` 对归档内路径恒为 false），直接调用桌面版可执行文件的说明按 shim 的做法补上 `--expose-internals` 并保留其非硬性前提的实测结论；删除"物理行数与逻辑事件数一致性校验"这一与实现不符的旧判据，改为按真实失败形态（结构违规、整份日志解码失败）描述；登记 `--dsh-home` 只选数据根、不改变库的来源与版本；`tests/paths.test.ts` 的用例名按其实际覆盖范围改写。

## [0.3.0] - 2026-10-02

### Added

- 默认导出的时间线新增 `**子代理任务**（<description>）` 与 `**发往子代理**（<子代理 id>）` 两类条目：主代理发给子代理的任务正文（`subagent` 的 `arguments.prompt`）与后续消息正文（`send_message` 的 `arguments.message`），默认可见且不受 `--tools` 控制，并取代对应调用的原始工具条目。
- 产物摘要行新增排除声明：`show` 给出 `已排除 N 条框架注入（--events 显示）` 与 `已排除 M 条子代理调度回执（--tools 显示）`；`search` 在 `text`/`tools` 档给出 `已排除 N 条框架注入与 M 条子代理调度回执（--scope all 可检索）`。

### Changed

- 默认参数下不再保留框架与插件自动注入的消息：`runtime-context`（运行时上下文快照）、`skill-catalog`（技能目录）、`tool-jobs`（后台任务完成通知）、`model-selection`（模型切换通知）等一律排除；保留名单为 `user`、`compact-checkpoint`、`subagent-settled`、`agent-message`、`user-question-reply` 五种来源，来源缺失或为空的 `user/message` 同样排除。判定按日志字段（`data.source.kind`、事件类型、工具 `name`/`callId`），与正文文案无关。其中 `user-question-reply` 是用户对提问的延迟回答，保留它是因为提问被中止、取消或超时时没有配对的工具结果，该消息是答案的唯一记录。
- 轮次大纲（`show --summary` 与 `show --format json` 的 `turns`）改为与默认时间线同一可见性：注入消息不再被当成用户提问（实测某会话首轮 prompt 曾落到 `user-approval` 的审批策略通知上）。
- 子代理调度回执（`started subagent <id>`）默认不呈现，`--tools` 打开时作为工具结果出现；`subagent/catalog` 登记事件保持默认隐藏。
- 默认检索范围 `--scope text` 与 `show` 默认参数改为同一可见性：注入消息与调度回执在 `text` 档不可命中，`tools` 档不含调度回执；`--scope all` 仍是取回被排除内容的入口。
- `show --format json` 的 `messages` 与默认视图同口径；`--format jsonl` 保持逐事件穷尽，不做可见性过滤。
- 时间线标签词表由 10 个取值扩展为 12 个；结构门禁白名单、`SKILL.md` 与测试断言同步。

## [0.2.0] - 2026-10-02

### Added

- 默认导出的时间线新增 `**提问**` 与 `**回答**` 两类条目：`ask_user_question` 工具向用户提出的问题与用户的回答，默认可见且没有关闭开关，不受 `--tools` 控制。
- `--probe` 新增 `- 问答数：<P> 提问 / <Q> 回答` 一行，计数为事件数口径。

### Changed

- 默认检索范围 `--scope text` 纳入问答条目的可读文本，命中行标签为 `提问` 与 `回答`；`text` 档的命中总数与命中分布因此变大。
- 问答载荷结构与预期不符时不再降级：单目标 `show` 以退出码 3 报 `数据不可读` 且不产出文件，`search` 把该会话逐条列入覆盖声明的排除项。提问被中止或取消（结果为工具错误态）不属于载荷结构不符：提问照常呈现，且不产出回答条目。
- 适配 dsh `0.2.0-rc.2` 的历史 catalog，按直属子会话事实为每个历史父会话建立独立恢复器。
- 区分物理 JSON 行与迁移后的逻辑事件，不再以两者数量相等拒绝合法历史迁移。
- 默认格式库定位继续使用 dsh 安装锚点，并在帮助文本中同步当前定位语义。
- 投影缓存行增加 `ver`、`seq` 与 `val` 的结构校验。

### Fixed

- 修复历史日志因缺少 child-bound catalog 而无法读取的问题。

## [0.1.0] - 2026-09-29

首次公开发布。

### Added

- 五个命令：`list`（列出会话）、`show`（读取一次会话）、`search`（全库检索内容）、`stats`（用量统计）、`check`（日志完整性校验）。全部只读、离线、不产生模型调用。
- 三种输出格式：面向阅读的 `md`（满足可被 lint 校验的结构纪律）、面向程序处理的 `json`，以及 `show` 专用的 `jsonl`（逐事件穷尽枚举）。
- 目标支持三种写法：完整会话 id、唯一前缀（不区分大小写，最少 8 字符）、`last`（最近活动的主会话）。
- 覆盖声明：每份产物写明扫描、纳入、排除的会话数，并逐条列出被排除的会话与原因；结论强度因此可自证，`--scope all` 检索的 0 命中可作为不存在的证据。
- 检索污染可剔除：产物给出逐会话命中分布（含 0 命中的会话），并提供 `--exclude-session` 排除某个会话及其子代理子树。
- 规模探测 `--probe`：只给会话头、预计正文字节数与消息条数，用于在读取之前判断开销。
- 来源标注：`user/message` 事件的来源不是用户本人时，标签行与检索命中行给出来源种类（子代理中继、子代理结算、插件注入等），使非用户输入的消息不再与用户消息混同。
- 产物命名可控：`--name` 指定产物名时原子替换；不指定时用带时间戳与随机后缀的唯一名，且同名拒绝覆盖。
- 错误可定位：退出码与固定的错误分类分流，组合冲突分支额外给出可执行的合法替代写法。
- 子代理会话支持：`show --subagents` 按父子层级渲染子代理块，路径编号表达嵌套关系。
- 范围选择：`--turn`/`--seq` 按事件序列筛选，`--head`/`--tail` 按条目截取，`--truncate` 按码点截断。

### Changed

- 产物命名由固定前缀改为「命令 + UTC 时间戳 + 随机后缀」，并把产物名纳入 `--name` 控制。
- 命令级摘要统一由单一模块产出，同一调用的摘要不因 `--format` 变化。
- `--name` 的可用字符放宽为 ASCII 字母、数字、`_`、`-` 加全部汉字，含扩展平面。
- 官方格式库的定位改为按 dsh 自身的安装锚点探测（在 npm 缓存的 npx 目录下找同时含 `@deepseek-ai/dsh` 与该库的 `node_modules`），不再固定指向 `<dsh-home>/profiles/node_modules`。该目录自 dsh `0.1.7-rc.2` 起不再由 dsh 创建。

### Fixed

- 参数错误附带可定位的说明（选项名、子命令位 token 或合法格式），不再只有一句分类。
- 补齐覆盖声明与截断口径，并拆分超过长度上限的源文件。
- 修正条目截取与元数据文案。
- 修正来源标注契约与注释中的不一致。
- 适配会话日志格式 v4：夹具与断言按新格式的消息结构、消息 id、时间戳类型与来源种类取值同步。
- 修掉工具结果抽取失效：只识别某一种历史内容形态的实现，对当前格式的日志会静默抽不到任何工具结果文本，表现为 `show --tools` 不显示工具输出、`search --scope tools` 检索不到工具结果；现在两种形态都取。

### Security

- 运行时不读取任何凭据文件，不联网，不调用模型。
- 文件操作限定在只读会话与投影缓存、只写 `--output-dir` 指定目录的范围。
- 不修改 dsh 数据，不建立任何形式的缓存。

[Unreleased]: https://github.com/YOUKNOWWHOOO/dsh-session-reader/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/YOUKNOWWHOOO/dsh-session-reader/releases/tag/v0.3.0
[0.2.0]: https://github.com/YOUKNOWWHOOO/dsh-session-reader/releases/tag/v0.2.0
[0.1.0]: https://github.com/YOUKNOWWHOOO/dsh-session-reader/releases/tag/v0.1.0
