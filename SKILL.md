---
name: session-reader
description: 当需要查看、列出、检索、查看概况或校验本机 dsh（DeepSeek Harness）会话历史（含子代理会话），而 dsh 自身不提供会话读取命令时加载。
---

# session-reader 技能

## 用途与数据边界

读取、列出、检索、查看概况和校验本机 DeepSeek Harness（dsh）会话，包括子代理会话。需要 Windows、pwsh 7 或更高版本，以及已安装的桌面版 dsh。技能只读、离线，不启动 dsh、不调用模型、不读取凭据，只向指定的输出目录写文件。

支持当前官方 `standard`、`cordis`（创造模式）、`ptc` 和本机 `dsh-custom-ptc` 预设的当前格式日志；旧日志不迁移。非文本内容只在原始事件中保留图片块和引用，不读取附件、不执行 OCR、不展示图片本体。不读取远端会话，也不提供实时事件流。

## 开始使用

入口 `scripts/session-reader.ps1` 自动定位桌面安装，调用方无需设置环境变量。下面的 `<skill_dir>` 是技能目录的绝对路径，`<project_tmp>` 是项目临时目录。先定位会话，再查看导出规模和正文：

```powershell
& "<skill_dir>\scripts\session-reader.ps1" list --output-dir "<project_tmp>"
& "<skill_dir>\scripts\session-reader.ps1" show last --output-dir "<project_tmp>" --probe
& "<skill_dir>\scripts\session-reader.ps1" show last --output-dir "<project_tmp>"
```

可在 PowerShell 终端、脚本或当前可用的 PowerShell 执行工具中调用入口。用户未指定选项时使用默认值，脚本路径和路径参数须按 PowerShell 规则引用。

通过 JavaScript 或 TypeScript 构造命令文本时，用 `String.raw` 模板字面量保留反斜杠；其它语言按自身字符串规则保留命令原文。

例如，在 `run_code` 中通过 `tools.pwsh` 调用：

```typescript
const result = await tools.pwsh({
  description: "读取指定会话的默认历史",
  command: String.raw`& '<skill_dir>\scripts\session-reader.ps1' show <session_id> --output-dir '<project_tmp>'`,
});
console.log(JSON.stringify(result));
```

执行前将占位符替换为实际值，`<session_id>` 为要读取的会话标识。

## 命令与选项

调用形式为 `& "<skill_dir>\scripts\session-reader.ps1" <命令> [位置参数] --output-dir "<目录>" [选项]`。

| 命令 | 用途与位置参数 | 格式 | 范围与子代理 |
| --- | --- | --- | --- |
| `list` | 列出会话；无位置参数 | md、json | 支持会话过滤 |
| `show` | 阅读会话；必需目标 | md、json、jsonl | 可筛选事件并导出子代理 |
| `search` | 检索内容；必需关键词 | md、json | 支持会话过滤和子树选择 |
| `stats` | 查看会话概况；目标可省略 | md、json | 全局概况支持会话过滤 |
| `check` | 校验完整性；目标可省略，省略时校验全库 | md、json | 按目标或全库校验 |

目标可用完整 id、不区分大小写的唯一前缀或区分大小写的 `last`。前缀至少 8 个字符，可省略 `session-`；`last` 指最近活动的主会话。id 前缀不表示会话类型。子树沿记录中的父会话关系读取，普通分叉不一定属于子代理树。

### 通用选项

- `--output-dir <目录>` 必填，输出文件的保存目录。
- `--name <名称>` 指定输出文件名；命名与覆盖规则见下文。
- `--format <md|json|jsonl>` 默认 `md`；仅 `show` 支持 `jsonl`。
- `--dsh-home <路径>` 指定会话数据目录，默认使用 `DSH_HOME`，未设置时使用 `~/.dsh`。
- `--lib-root <目录>` 是高级覆盖选项，指定包含完整官方依赖的 `node_modules` 目录。
- `-h`、`--help` 显示帮助，无需输出目录。

### 会话过滤与检索选项

- `--workspace <路径|标题>` 用于 `list`、`search` 和全局 `stats`；路径归一化后全等或工作区标题全等，无匹配退出 1。
- `--since <时间>`、`--until <时间>` 用于同一组命令，按会话最近活动时间过滤整会话，缺失时使用创建时间；不筛选事件时间。接受毫秒数或严格 ISO 时间，无时区后缀按 UTC；两端包含，不校验先后。
- `--origin <all|main|subagent>` 用于同一组命令，默认 `all`。
- `--title <关键词>` 仅用于 `list`，按标题子串匹配且不区分大小写；标题不可用时不匹配，零匹配正常返回。
- `--include-blank` 仅用于 `list`，显示默认隐藏的空会话；`search` 与 `stats` 始终包含空会话。
- `--limit N` 用于 `list` 和 `search`，默认 100，0 表示不限；不改变命中总数与覆盖声明。
- `--sort <time|created|title|size>` 仅用于 `list`，默认 `time`；标题升序，其余降序，并列按会话 id 排序。其它取值报参数无效。
- `--full` 仅用于 `list`，以逐会话块代替精简表格。
- `--scope <text|tools|all>` 仅用于 `search`，默认 `text`，范围见下表。
- `--case-sensitive` 仅用于 `search`，使检索区分大小写；默认不区分。
- `--context N` 仅用于 `search`，默认在命中两侧各取 60 个码点；被裁剪的一侧显示省略号。
- `--session <目标>`、`--exclude-session <目标>` 仅用于 `search`，分别选择和排除目标及其子代理子树；同时使用时取交集。

### 阅读选项

以下选项用于 `show`。

- `--role <user|assistant>` 只过滤对话消息，工具与事件不受影响。
- `--thinking` 显示推理；`--tools` 显示工具调用、结果和子代理调度回执；`--events` 显示生命周期事件、系统消息及默认排除的注入消息。这些内容默认隐藏。
- `--subagents` 连带导出子代理会话。
- `--headers` 显示事件序号和本地时间；PTC 条目还显示调用和父调用标识。
- `--truncate N` 按码点截断正文并加省略号，默认 0 表示不截断；头部和交接坐标不受影响。
- `--turn <A-B|A>`、`--seq <A-B|A>` 按包含端点的区间筛选每个会话块，最小值分别为 1 和 0；同用取交集，子代理按自己的事件流计。
- `--head N`、`--tail N` 分别取根会话时间线的前 N 条或后 N 条，0 表示不限。
- `--summary` 输出每轮内容大纲，代替时间线；大纲不含来源标注及问答条目。`--role`、`--thinking`、`--tools`、`--events`、`--headers` 同用时无效果；与 `--probe` 同用时按探测处理。
- `--probe` 只输出头部与按同组选项完整导出的预计 UTF-8 字节数，不输出正文。

### 组合限制

`--role`、`--thinking`、`--tools`、`--events`、`--headers`、`--truncate`、`--turn`、`--seq`、`--head`、`--tail` 和 `--probe` 仅适用于 md。jsonl 不可与 `--summary` 或 `--subagents` 同用。

`--head` 与 `--tail` 互斥；`--summary` 与 `--turn`、`--seq`、`--head`、`--tail` 互斥；`--probe` 与 `--subagents` 互斥。指定 `stats` 目标时不可使用会话过滤选项。`list --full --format json` 被接受，但 `--full` 不改变 JSON 输出。

选项不可重复，开关不接受值；支持 `--opt=value`，位置参数不终止选项解析。`--` 后的内容均为位置参数，必需选项须写在其前；帮助选项出现在 `--` 前时直接显示帮助。

## 阅读与检索

默认时间线显示用户和助手正文、提问与回答、子代理任务和发往子代理的消息，以及上下文摘要、交接指令、交接通知和交接坐标。提问被取消或中止时没有回答条目。自定义 PTC 停用了提问工具；已有问答记录仍可读取。直接工具与 PTC 子调用采用相同的展示和检索语义，`mcp_call`、`creation_call` 的子结果可用 `--tools` 查看。

交接通知只给交接文件路径与读取要求；技能不读取外部交接文件。用户角色不一定代表人类输入，应查看来源标注或 JSON 的 `source`。子代理块以路径编号表示层级，例如 `1.2` 是第一个子代理的第二个子代理。

| 检索范围 | 内容 |
| --- | --- |
| `text` | 默认交流正文，以及上述问答、子代理和上下文条目的可读文本 |
| `tools` | 包含 `text`，并增加工具参数与结果，包括问答原始载荷 |
| `all` | 包含上述内容及完整事件载荷，包括默认隐藏的记录 |

`text` 与 `tools` 排除框架注入和子代理创建回执；`all` 可检索这些记录。

`all` 按 JSON 记录形态检索，字符可能被转义；零命中不能单独证明原文不存在。先检查覆盖声明中的排除项和每会话命中分布，再考虑排除当前会话及其子树。命中总数按检索单元计，不等于文本出现次数。

可读输出会规范化换行、制表符及行内空白，因此并非逐字原文；需要逐事件核对原文时使用 JSONL。工具是否存在以 `hasToolCalls` 表示；不输出活动次数或令牌统计，读取规模、检索覆盖和完整性诊断仍有数量。

## 输出文件及机器输出

相对输出目录按调用时的工作目录解析，不存在时创建。成功时终端输出两行，分别给出保存路径，以及摘要和文件行数；正文只写入文件。文件为 UTF-8 无 BOM、LF，可能包含会话明文和本地路径，应按临时敏感产物管理。

指定 `--name` 时，同名文件会被替换；名称只能含 ASCII 字母、数字、下划线、连字符和汉字，按 UTF-16 单元计长度为 1–64，不得包含点、路径分隔符、空白、控制字符或 Windows 保留设备名。未指定时使用带 UTC 时间戳和随机后缀的文件名，同名时拒绝覆盖。

| 命令 | JSON 顶层与重点 |
| --- | --- |
| `list` | `sessions`、`coverage` |
| `show` | `session`、`meta`、`turns`、`messages`、`subagents`、`coverage`；`meta.hasToolCalls` 表示是否包含工具调用 |
| `search` | `matches`、`total`、`truncated`、`scope`、`totalIsExact`、`excludedInjections`、`coverage`、`scan`、`distribution` |
| `stats` | `kind`、会话概况、`coverage`、`scan`；以 `hasToolCalls` 表示工具是否存在 |
| `check` | `sessions`、`anomalyCount`、`coverage` |

`coverage` 显示扫描、纳入和逐项排除的会话，应查看排除原因而不只看数量；`scan` 显示实际解码与读取的范围及失败信息。`show` 子树中归属未知的会话单列，`--probe` 不提供 `coverage`。

`show` 的 `messages` 保留真实事件 `type`。PTC 调用和结果分别使用 `tool/ptc-dispatch-start`、`tool/ptc-dispatch`，包含 `callId`、`rootCallId`、`parentCallId`、`name`、`arguments`；结果另含 `isError` 和 `text`，参数为规范 JSON 文本。`turns` 与助手消息的 `toolCalls` 是内容数组；`--summary` 时 `messages` 为空数组。

JSONL 首行为会话头，其后逐行保存原始事件，不包含子代理子树。Markdown 空值显示 `-`，JSON 空值为 `null`；Markdown 时间使用本地时区，JSON 时间为毫秒数。

## 错误与限制

| 退出码 | 含义与处理 |
| --- | --- |
| 0 | 成功，包括空结果和零命中 |
| 1 | 目标不存在、前缀有歧义或工作区无匹配；检查目标和路径 |
| 2 | 参数无效；检查必填项、取值和组合限制 |
| 3 | 数据、格式库或文件操作错误；按错误提示检查数据、安装和输出目录 |

聚合命令会列出不可读会话并继续；单目标不可读时退出 3。`check` 发现异常时先写产物并输出路径，再退出 3。问答载荷不符会使需要呈现问答的 Markdown 导出失败，检索则列出被排除的会话。

标题或元数据可能不可用；实际预设以 `show` 的会话头为准。尾部不完整帧及其后续内容会被丢弃并在产物中标注；坏行和异常也会标注。

## 开发入口

开发、测试与维护要求见 [开发规范](doc/开发规范.md)；项目介绍见 [README](README.md)，变更记录见 [CHANGELOG](CHANGELOG.md)。
