# dsh-session-reader

> 读取、列出、检索、统计与校验本机 DeepSeek Harness（下称 dsh）的会话历史，包括子代理会话；全程只读、离线、不产生模型调用。

## 项目状态

| 字段 | 当前值 |
| --- | --- |
| 当前阶段 | Active Development |
| 当前版本 | 0.3.0 |
| 适用平台 | Windows |
| 运行依赖 | Node.js v26 线、本机 dsh 安装 |
| 开发与验证基线 | dsh `0.2.0-rc.2`，会话日志格式 v4 |

## 背景与目的

dsh 把每一次会话记录成一组日志文件，位置在 dsh 主目录的 `sessions/` 下。一个会话占一个目录，日志文件名形如 `session.v4.jsonl.zstd`，内容是 zstd 压缩的 JSONL，每一行是一个事件：用户消息、助手消息、模型的推理过程、工具调用及其参数、工具返回的结果、系统提示词，以及轮次开始与结束、模型请求与响应、上下文压缩、审批与运行时注入等生命周期事件。子代理会话单独存放，通过父会话标识与主会话关联。

这些日志是排查问题的第一手材料，也是复盘模型行为的唯一依据。但 dsh 自身不提供读取它们的命令：要查看一次会话，只能手工定位会话目录、解压 zstd 帧、再逐行解析 JSON 事件。

这个技能把这段过程收敛成五个命令，将会话消息历史提取为 Markdown、JSON 与 JSONL 三种格式的文件，供人阅读，也供程序或 agent 继续处理。

## 适用环境

- **平台**：Windows。技能的路径处理、输出文件名校验与文件移动语义都按 Windows 实现（例如拒绝 `CON`、`PRN`、`NUL`、`COM1`-`COM9`、`LPT1`-`LPT9` 这 22 个保留设备名）。
- **Node.js**：v26 线。脚本是 TypeScript（ESM），由 Node 的原生类型剥离直接执行，没有构建步骤，也不需要 `tsconfig.json` 参与运行。
- **dsh**：本机需有一份可用的 dsh 安装。本技能以 dsh `0.2.0-rc.2` 为开发与验证基线，需要它提供两样东西，即会话数据本身，以及随发行版提供的官方会话格式库 `@deepseek-ai/dsh-session-format-catalog`。
- **会话日志格式**：当前为 v4。技能通过官方格式库解码日志，不自行解析格式细节。
- **主目录**：默认取环境变量 `DSH_HOME`，未设置时取 `~/.dsh`；可用 `--dsh-home` 覆盖。该目录不存在、或其下缺 `sessions/` 时，命令以退出码 1 结束。

## 能做什么

### 选取哪些内容

技能用参数组合控制提取范围。同一个命令换一组参数，既可以只查看某一个会话的一小段，也可以扫描全库：

| 要控制的事情 | 用哪些参数 |
| --- | --- |
| 选哪些会话 | `--workspace`（工作区路径或标题精确匹配）、`--since`/`--until`（最近活动时间区间）、`--title`（标题子串，仅 `list`）、`--origin`（主会话／子代理／全部） |
| 指定某一个会话 | 目标写法：完整会话 id、唯一前缀（最少 8 个字符）、`last`（最近活动的主会话）；`show`、`stats`、`check` 与 `search --session`/`--exclude-session` 都接受 |
| 选哪些事件 | `show` 的 `--turn A-B`/`--seq A-B`（事件序列区间，含端点）；`search` 的 `--scope text\|tools\|all`（按内容类型分三档） |
| 选哪些类型的消息 | `show` 的 `--role user\|assistant`（只看某一方的消息）、`--thinking`（模型推理）、`--tools`（工具调用与结果）、`--events`（生命周期事件与系统消息） |
| 选多少 | `--limit N`（列出条数上限）、`--head N`/`--tail N`（首尾条目）、`--truncate N`（每条正文的截断长度）、`--context N`（检索命中两侧的窗口） |
| 是否连带子代理会话 | `show --subagents`（按父子层级一并导出）、`--origin subagent`（只看子代理） |
| 从检索中剔除或只保留一棵子树 | `search --session`、`search --exclude-session`，都按该会话及其子代理子树生效 |

### 导出为哪些格式

| 格式 | 支持的命令 | 形态与用途 |
| --- | --- | --- |
| `md`（默认） | 全部五个命令 | Markdown，面向人阅读；结构固定，标题、列表、表格与代码围栏齐备，可继续交给 Markdown 工具处理 |
| `json` | 全部五个命令 | JSON，面向程序处理；含覆盖声明与逐条结构化数据，其中检索与统计另含扫描明细 |
| `jsonl` | 仅 `show` | 每行一个 JSON；首行是会话头，其后每行一个已解码事件，行数等于事件数加一，是逐事件穷尽枚举的唯一入口 |

三种格式都写入 `--output-dir` 指定的目录，终端只回两行摘要。

## 功能

五个命令的共同点是：只读，结果写入文件，成功时终端只回两行。

### `list`：列出会话

会话清单，默认是一张表格，每行一个会话。

- 每行给出：会话 id、标题、工作区、最近活动时间、轮次、类型（主会话或子代理）、日志大小。
- 过滤：`--workspace`、`--since`/`--until`、`--title`、`--origin`。
- 排序：`--sort time|created|title|size|turns`，默认 `time`；`title` 升序，其余降序。
- 条数：`--limit N`，默认 100，`0` 为不限。
- `--full`：换成逐会话的完整块，额外给出 cwd、预设、模型、令牌用量（未缓存输入／输出／缓存读／缓存写）与元数据可用性。
- 默认隐藏空会话，用 `--include-blank` 显示。
- 结果末尾给出合计（匹配数、显示数、扫描数）与逐条元数据说明，并带覆盖声明。

### `show`：读取一次会话

一次会话的完整时间线，按事件顺序展开。

- 呈现内容：用户与助手的正文、模型的推理过程、工具调用及其参数、工具返回的结果、系统消息、生命周期事件，工具向用户提问的问答条目（`**提问**` 与 `**回答**`），以及主代理发给子代理的任务与后续消息（`**子代理任务**` 与 `**发往子代理**`）。
- 默认可见性：显示用户与助手消息、问答条目（`**提问**` 与 `**回答**`，来自 `ask_user_question` 工具）、子代理任务与发往子代理的正文（来自 `subagent` 与 `send_message` 工具），这几类都没有关闭开关，也不受 `--tools` 控制；推理、其余工具调用与结果、生命周期事件默认隐藏，分别用 `--thinking`、`--tools`、`--events` 显示。
- 默认排除框架与插件自动注入的消息：运行时上下文快照、技能目录、后台任务完成通知、模型切换通知等状态提示，以及子代理调度回执（`started subagent …`）。判定按日志里的来源字段，与正文文案无关。结果末尾的摘要行写明隐藏与排除了多少条；被排除的内容可用 `--events`（注入消息）、`--tools`（调度回执与工具结果）或 `search --scope all` 取回。
- `--role user|assistant`：只看某一方的消息，工具与事件不受影响。
- `--summary`：不展开时间线，只给轮次大纲（不含提问与回答条目），每轮一问一答各截取一段，适合先看整体再决定读哪一段。
- 范围选择：`--turn A-B`/`--seq A-B` 按事件序列筛选（作用于每个块），`--head N`/`--tail N` 按条目截取（只作用于主会话块）。
- `--headers`：给每一行标注事件序号与本地时间。
- `--truncate N`：按码点截断正文，`0` 为不截断（默认）。
- `--subagents`：连带把子代理会话按父子层级一并导出，标题里的路径编号（如 `1.2`）表达嵌套关系。
- `--probe`：只给会话头、预计正文字节数、消息条数与问答数，不含任何会话正文，用于先判断完整读取的开销。
- 范围筛选生效时，结果里有一行筛选说明，列出该块真正生效的条件、条目数与事件数；没有任何筛选时不输出该行。
- 格式：`md`、`json`、`jsonl`。

### `search`：检索内容

在全库会话里检索关键词，返回命中总数、逐条命中与每会话命中分布。

- `--scope` 三档：`text`（用户与助手正文，以及问答条目的可读文本，默认；与 `show` 默认参数同一可见性，不含框架注入与调度回执）、`tools`（另含工具调用参数与工具结果，含问答的原始载荷；同样排除框架注入与调度回执）、`all`（另含推理、系统消息、压缩摘要、命令、标题请求、web 检索请求、交付物、待办、代理信箱与每个事件的完整 JSON 载荷；它同时是取回被默认排除内容的入口）。默认两档会在结果里写明排除了多少条注入与调度回执。
- 每条命中给出所属会话 id、事件序号、标签与命中处两侧的上下文片段。
- `--context N`：命中处两侧各取 N 个码点，默认 60。
- `--limit N`：限制列出的命中条数，默认 100，`0` 为不限，不改变命中总数。
- `--case-sensitive`：区分大小写，默认不区分。
- `--session`：只检索该会话及其子代理子树；`--exclude-session`：排除该子树。
- 范围过滤：`--workspace`、`--since`/`--until`、`--origin`。
- 结果另给检索范围说明（当前档位覆盖哪些内容）、扫描明细（解码日志份数、读到的事件总数、解码失败份数、帧解压失败帧数）、事件时间范围与每会话命中分布（含 0 命中的会话）。
- 格式：`md`、`json`。

### `stats`：统计用量

- 给目标时统计单个会话：会话标识、标题、是否空会话、轮次、步数、工具调用数、令牌用量、创建时间、最近活动时间、预设、模型、日志路径与大小。
- 不给目标时做全局聚合：会话数、空会话数、总轮次、总步数、工具调用总数、四类令牌合计、时间跨度、日志总大小。
- 范围过滤 `--workspace`、`--since`/`--until`、`--origin` 只在全局聚合时可用；与单会话目标同用会被拒绝，不做静默忽略。
- 部分字段来自 dsh 的投影缓存，不可用时逐条说明原因，并且不计入相关合计。
- 格式：`md`、`json`。

### `check`：校验日志完整性

逐会话核查日志的物理结构与事件序列。

- 核查项：日志格式版本、结构完整性（完整／结构损坏／尾部撕裂及其偏移）、zstd 帧数、行数、事件序号是否连续、坏行数、异常项与详情。
- 不给目标时校验全库，且这种扫描不读会话头，因此连会话头都读不出来的目录也在诊断范围内。
- 结论行给出"无异常"或异常项数。
- 发现异常时，先把结果写入文件并打印两行 stdout，再以退出码 3 结束，stderr 为空。因此退出码 3 不代表没有输出文件。
- 格式：`md`、`json`。

## 使用方法

### 前置条件

1. 本机已安装 dsh 并至少使用过一次，`~/.dsh/sessions/` 下有会话日志。
1. `node --version` 返回 v26 线。
1. 把本仓库放在 dsh 的技能目录下，或在任意位置直接调用脚本（脚本按自身位置解析所需资源，不依赖当前工作目录）。

若作为 dsh 技能使用，目录应放在 `<dsh-home>/skills/session-reader/`，这样会话创建时它会被技能目录收录，模型可以按名称加载它。

### 基本调用

所有命令都必须显式给出 `--output-dir`，它没有默认值，缺省即退出码 2。惯例是指向项目临时目录。

```powershell
# 列出最近活动的 20 个会话
node scripts/session-reader.ts list --output-dir .\tmp --limit 20

# 只看某个工作区的会话，按大小排序
node scripts/session-reader.ts list --output-dir .\tmp --workspace "C:\Users\me\project" --sort size

# 只看子代理会话
node scripts/session-reader.ts list --output-dir .\tmp --origin subagent

# 读取最近活动的主会话（默认只显示用户与助手消息）
node scripts/session-reader.ts show last --output-dir .\tmp

# 先量规模，再决定是否完整读取
node scripts/session-reader.ts show last --output-dir .\tmp --probe

# 完整读取，含推理、工具调用与参数、工具结果，并标注事件序号与时间
node scripts/session-reader.ts show last --output-dir .\tmp --thinking --tools --headers

# 只看第 3 到第 5 轮里用户发出的消息
node scripts/session-reader.ts show last --output-dir .\tmp --turn 3-5 --role user

# 先看轮次大纲
node scripts/session-reader.ts show last --output-dir .\tmp --summary

# 连带子代理会话一起导出，并用 JSON 交给程序处理
node scripts/session-reader.ts show last --output-dir .\tmp --subagents --format json

# 逐事件穷尽枚举，每行一个事件
node scripts/session-reader.ts show last --output-dir .\tmp --format jsonl

# 全库检索某个错误串，范围含所有事件载荷
node scripts/session-reader.ts search "ECONNRESET" --output-dir .\tmp --scope all

# 检索时排除自己这次会话及其子代理
node scripts/session-reader.ts search "timeout" --output-dir .\tmp --scope all --exclude-session last

# 全局用量统计
node scripts/session-reader.ts stats --output-dir .\tmp

# 校验全库日志完整性
node scripts/session-reader.ts check --output-dir .\tmp
```

### 指定输出文件名

不给 `--name` 时，文件名是 `session-reader-<命令>-<UTC 时间戳>-<随机 6 位>.<扩展名>`，且同名文件已存在就拒绝执行（退出码 2），因此不会覆盖既有文件。给 `--name` 时文件名固定为 `<output-dir>/<name>.<扩展名>`，同名文件被原子替换，会覆盖上一次的内容。

`--name` 只接受单一路径段：ASCII 字母、数字、`_`、`-`，以及全部汉字（含扩展 B 及以后）。长度 1-64。

### 目标写法

`show`、`stats`、`check` 以及 `search --session`/`--exclude-session` 都接受三种目标写法：

- 完整会话 id，如 `session-3f2a1c4e-...`；
- 唯一前缀（不区分大小写，最少 8 个字符，可省略 `session-`），如 `3f2a1c4e`；
- `last`，表示最近活动的主会话（区分大小写）。

前缀有歧义时以退出码 1 报错并给出候选数，改用更长前缀即可。

### 使用要点

- 时间参数：`--since` 与 `--until` 接受毫秒数或严格 ISO 时间（纯数字按毫秒解释，无时区后缀按 UTC，如 `2026-09-15` 或 `2026-09-15T21:30:00Z`）。过滤基准是会话的有效最近活动时间，双端含端点，不校验两者先后。
- 过滤的失败语义不同：`--workspace` 是路径归一化全等匹配或工作区标题全等匹配，没有任何匹配时以退出码 1 报错；`--title` 是标题子串匹配且不区分大小写，没有匹配时正常返回空结果并以 0 结束。
- 空会话的默认处理不同：`list` 默认隐藏空会话，用 `--include-blank` 显示；`search` 与 `stats` 恒包含空会话。因此用 `list` 定位会话、再用 `search` 核对内容时，两者的会话集合不完全相同。
- `--limit`、`--head`、`--tail` 的 `0` 表示不限；`--truncate` 的 `0` 表示不截断；`--turn` 与 `--seq` 的区间含端点，其中 `--turn` 最小 1、`--seq` 最小 0。
- 选项不可重复（重复即退出 2），开关不接受值（`--full=1` 退出 2），值选项支持 `--name <值>` 与 `--name=<值>` 两种写法。
- 关键词以 `-` 开头时用 `--` 终止选项解析；必需选项要写在 `--` 之前：

  ```powershell
  node scripts/session-reader.ts search --output-dir .\tmp -- "- item"
  ```

- 目标的解析有三种结果：唯一匹配且可读时正常执行；匹配到多个会话时以退出码 1 报错并给出候选数；目标存在于磁盘但会话头不可读时以退出码 3 报 `数据不可读`，与"不存在"可以区分。其余无匹配以退出码 1 报 `目标不存在`。
- `-h` 与 `--help` 写 stdout、以 0 结束，且不需要 `--output-dir`。

## 输出格式

### 终端只回两行

```text
完整输出已保存到: <输出文件的绝对路径>
<规模摘要>；输出文件共 N 行
```

摘要给出该命令的关键计数（会话数、命中数、事件数等），且同一调用不因 `--format` 而改变。失败时终端不输出任何内容，只在 stderr 打一行 `错误: <分类>`。

### 选项组合限制

以下组合会被拒绝，以退出码 2 结束：

- `--thinking`、`--tools`、`--events`、`--role`、`--truncate`、`--turn`、`--seq`、`--head`、`--tail` 与 `--probe` 只对 Markdown 有效，与 `--format json` 或 `--format jsonl` 同用即被拒绝。
- `--format jsonl` 另外还禁止 `--summary` 与 `--subagents`。
- `--head` 与 `--tail` 互斥。
- `--summary` 与 `--turn`、`--seq`、`--head`、`--tail` 互斥。
- `--probe` 与 `--subagents` 互斥。
- `stats` 给了目标（单会话统计）时，`--workspace`、`--since`、`--until`、`--origin` 不可用。

组合冲突的错误说明会给出可执行的替代写法，例如 `去掉 --events，或把 --format 改为 md`。

### 文件编码

UTF-8 无 BOM、LF 换行、末尾恰一个换行。Markdown 输出满足一套可被 lint 校验的结构纪律（标题词表固定、多行文本只用围栏承载、单行文本只用行内代码承载、围栏长度按内容动态计算），因此调用方不需要把输出目录排除在 Markdown 静态检查之外。

### 覆盖声明

每份输出都写明"扫了什么、纳入了什么、排除了什么"（`--probe` 的规模探测输出除外）：

```text
扫描会话 12 个；纳入 11 个；排除 1 个
排除会话：session-9f1c...（会话头不可读）
```

三个数字满足 `扫描 = 纳入 + 排除`，且实现就按这个等式构造。它不是独立的核对手段，要判断覆盖范围是否完整，看的是逐条列出的排除项与原因。单个会话损坏不会让整份统计失败：聚合命令跳过它并声明，只有以它为目标的单目标命令才会明确报错。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功，含 0 命中、空结果、`--help`、`check` 未发现异常 |
| 1 | 目标不存在，含前缀歧义、`--workspace` 无匹配、`--dsh-home` 不存在、`sessions/` 缺失 |
| 2 | 参数错误，含 `--name` 非法、选项组合违规、缺 `--output-dir`、前缀短于 8 字符、未给 `--name` 时输出文件已存在 |
| 3 | 数据或 IO 错误，含 `check` 发现异常、输出目录创建失败、输出写入失败、文件移动失败、官方格式库加载失败、问答载荷结构不符合预期 |

stderr 的格式固定为一行 `错误: <分类>`，分类是固定的 8 个取值（`参数无效`、`目标不存在`、`数据不可读`、`内部错误`、`输出目录创建失败`、`输出文件已存在`、`输出写入失败`、`输出移动失败`）。分类后可能附一段括号说明；调用方应只依赖分类与退出码分流，括号说明的内容可能扩展。

一个例外需要知道：`check` 发现异常时先把结果写入文件并打印两行 stdout，再以 3 结束，stderr 为空。因此退出码 3 不代表没有输出文件。

## 已知边界与限制

这些是实际存在的限制，使用前应当知道：

- **与 dsh 的格式版本绑定**。会话日志的格式由 dsh 决定，技能通过官方格式库解码，格式版本以官方库的 `currentVersion` 为准（当前为 v4）。dsh `0.2.0-rc.2` 的历史正文读取必须绑定直属子会话事实，技能会按物理 generation 使用历史 catalog 或当前 catalog，并为每个历史父会话建立独立 child-bound catalog。
- **依赖官方格式库的位置**。库随 dsh 一起安装。技能默认按 dsh 自身的安装锚点探测它（在 npm 缓存的 npx 目录下找同时含 `@deepseek-ai/dsh` 与该库的 `node_modules`，命中数必须恰好一个），也可以用 `--lib-root` 显式指定含 `@deepseek-ai` 的 `node_modules` 目录。探测不到时不会猜测，而是直接以退出码 3 报错并说明该指定什么。
- **平台限定 Windows**。在其它平台上，输出文件名的保留设备名校验、路径处理与原子替换语义都未经验证。
- **检索的穷尽性有一处细节**。`--scope all` 档的"事件载荷"单元是事件的 JSON 序列化结果，其中的双引号、反斜杠与制表符会以转义形态出现。因此只存在于非文本字段里、且含这些字符的关键词可能命不中；需要逐字核对原文时用 `show --format jsonl` 导出原始事件行。另外命中总数是检索单元内的匹配次数，不是文本出现次数，同一段文本可能被计多次。
- **元数据可能不可用**。列表与统计的部分字段来自 dsh 的投影缓存。缓存缺失、版本不符或与会话身份不一致时，相关字段标注为"元数据不可用"并在 json 中给出原因，不会静默填 0。
- **问答载荷的结构绑定**。`ask_user_question` 的提问参数与回答结果由工具实现决定；结构与技能登记的形态不符时不做任何降级：单目标 `show` 以退出码 3 报 `数据不可读` 且不产出文件，`search` 把该会话逐条列入覆盖声明的排除项。提问被中止或取消（结果为工具错误态）不属于结构不符：提问照常呈现，且不产出回答条目。`--format json` 与 `jsonl` 不做这类抽取，仍可读取原始载荷。
- **输出文件含会话明文**。输出是会话内容的导出，应按临时文件管理，不要提交到公开仓库。

## 开发

### 目录结构

```text
SKILL.md          技能说明：触发条件、命令契约、输出格式、退出码（写给加载它的模型看）
README.md         本文件：面向使用者的总览
scripts/          实现
  session-reader.ts   CLI 入口：解析、校验、分发、写入输出文件
  lib/decode.ts       官方格式库加载、事件解码、各类文本抽取
  lib/ask-user.ts     问答（ask_user_question）的可读文本抽取，md 渲染与检索共用
  lib/frames.ts       物理层：结构性 zstd 帧扫描与逐帧解压
  lib/store-*.ts      会话发现、投影缓存元数据、列表、检索、统计、校验
  lib/render-*.ts     md/json/jsonl 渲染与命令级摘要
tests/            单元测试、CLI 集成测试、md 渲染单元测试、全组合 lint 门禁
doc/开发规范.md    开发与维护要求（契约、边界、测试与校验链）
```

### 校验链

修改代码后依次运行（在技能目录下）：

```powershell
npm ci
npx --no-install biome ci .                    # 格式化与 lint
npx --no-install tsc --noEmit                  # 类型检查
node --test tests                              # 测试
node tests/lint-matrix.ts --workdir tests/.tmp/matrix --real-home $env:USERPROFILE\.dsh   # 全组合 lint 门禁
npx --no-install markdownlint-cli --config .markdownlint.jsonc .
node --test --experimental-test-coverage --test-coverage-lines=80 --test-coverage-branches=85 tests
```

门禁的输出路径由 `--workdir` 决定，必须指向临时位置，否则会把逐组合结果与合成夹具写进技能目录。

### 测试无法脱离 dsh 数据

`tests/` 里的 CLI 集成测试与全组合门禁需要**真实的官方格式库**（以及门禁的真实会话抽查）。库定位不到时这些测试不会静默跳过，而是直接失败并说明原因，因为跳过会让"没有通过"伪装成"通过"。

## 文档入口

- [`CHANGELOG.md`](CHANGELOG.md)：版本变更记录
- [`SKILL.md`](SKILL.md)：触发条件、命令与输出契约的完整说明，也是模型加载技能时读到的正文
- [`doc/开发规范.md`](doc/开发规范.md)：开发、测试与维护的强制要求，其中标题为"兼容性要求"的一节规定与 dsh 版本演进相关的约束

## 许可证

[MIT](LICENSE)。
