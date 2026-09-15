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
- 输出文件绝不覆盖已存在的文件。
- 输出文件可能含会话明文，按临时产物管理，不提交、不长期保留。
- 默认格式 `md` 的输出真实通过 dsh 全局 markdownlint 基线（无文件内豁免、无配置放宽）：调用方无需将输出目录排除在 Markdown 静态检查之外；`json`/`jsonl` 为机器可读格式，不参与 lint。

## 输出格式（md）

- 骨架只用固定词表（与内容隔离）：文档标题 `# 会话列表` / `# 会话列表（完整）` / `# 会话记录` / `# 检索结果` / `# 统计` / `# 完整性校验`；区块标题 `## 时间线`、`## 轮次大纲`、`## 子代理 <路径编号>`；标签行恒以 `：` 收尾（`**用户**：`、`**助手**：`、`**工具调用**（read）：` 等）；短横线列表与 GFM 表格只承载固定字段。
- 任意会话文本只经两种载体承载：多行文本 → 动态长度反引号围栏（语言标注 `text`，反引号长度 = 内容最长连续反引号串 + 1，且不小于 3）；单行文本 → 动态反引号行内代码跨度（表格单元格内 `|` 先转义）。
- 内容只做三条极小归一化：制表符 → 4 空格；行内值首尾空白去除（全空白值保留原样）；围栏载荷的所有非空行都以 `$`+空白开头时，末尾追加一行单个空格（原文各行逐字不变）。
- 子代理块层级：所有子代理块固定为 H2（`## 子代理 <路径编号>`）、子内容固定为 H3；嵌套父子关系只由路径编号（如 `1` 与 `1.1`）表达，标题层级本身不随深度递进。
- 读取建议：按 `#`/`##` 词表定位区块，用围栏/行内代码边界识别原始文本与字段值。

## 命令

脚本路径相对本技能目录；示例中的 `<project_tmp>` 为项目临时目录占位符。

```text
node scripts/session-reader.ts list   --output-dir <project_tmp> [--workspace <路径|标题>] [--since <时间>] [--until <时间>]
                                      [--title <关键词>] [--origin all|main|subagent] [--include-blank]
                                      [--limit N] [--sort time|created|title|size|turns] [--full]
node scripts/session-reader.ts show   <id|唯一前缀|last> --output-dir <project_tmp> [--summary] [--role user|assistant]
                                      [--thinking] [--tools] [--events] [--subagents] [--headers] [--truncate N]
                                      [--format md|json|jsonl]
node scripts/session-reader.ts search <关键词> --output-dir <project_tmp> [--scope text|tools|all] [--case-sensitive]
                                      [--context N] [--limit N] [--workspace <路径|标题>] [--since <时间>] [--until <时间>]
                                      [--origin all|main|subagent]
node scripts/session-reader.ts stats  [<id|唯一前缀|last>] --output-dir <project_tmp> [--workspace/--since/--until/--origin；仅全局聚合（缺省目标）可用]
node scripts/session-reader.ts check  [<id|唯一前缀|last>] --output-dir <project_tmp>
```

全局选项：`--dsh-home <路径>`（默认 `$DSH_HOME`，否则 `~\.dsh`）、`--lib-root <目录>`（官方格式库解析锚点，默认 `<dsh-home>\profiles\node_modules`）、`--format`、`-h/--help`。

选项互斥（违者退出 2）：

- `--format json|jsonl` 下禁止一切**呈现类开关**（`--role`、`--thinking`、`--tools`、`--events`、`--headers`、`--truncate`）——这六个开关仅 `md` 可用。
- `--format jsonl` 下另禁止**内容范围开关** `--summary` 与 `--subagents`；`--format json` 允许这两个开关。
- `stats` 指定目标（单会话）时禁止范围过滤选项 `--workspace`/`--since`/`--until`/`--origin`（不做静默忽略）。

选项终止符：`--` 之后的所有 token 一律作为位置参数（用于以 `-` 开头的关键词，如 `search -- "- item"`）。

示例（PowerShell）：

```text
node scripts/session-reader.ts list --output-dir <project_tmp> --workspace user_projects --limit 20
node scripts/session-reader.ts show 39b27999 --output-dir <project_tmp> --thinking --tools
node scripts/session-reader.ts show last --output-dir <project_tmp> --subagents --format json
node scripts/session-reader.ts search compact --output-dir <project_tmp> --scope all
```

## 默认参数组合（默认调用）

默认组合 = 仅写「命令 + 目标（如需要） + `--output-dir`」，其余选项全部取默认值（含 `--dsh-home`、`--lib-root`、`--format` 等）。`--output-dir` 是默认组合中唯一必须显式提供的位置类参数，且必须遵守上文「输出使用规定」（由调用方显式指定，惯例指向项目临时目录）。

```text
node scripts/session-reader.ts list                      --output-dir <project_tmp>
node scripts/session-reader.ts show   <id|唯一前缀|last> --output-dir <project_tmp>
node scripts/session-reader.ts search <关键词>            --output-dir <project_tmp>
node scripts/session-reader.ts stats                     --output-dir <project_tmp>
node scripts/session-reader.ts check                     --output-dir <project_tmp>
```

默认行为（对外契约）：

- 输出格式为 md（lint-safe Markdown，载体与归一化见「输出格式（md）」；输出文件扩展名 `.md`）；文本不截断（`--truncate 0`）。
- `show`：推理、工具调用/结果与生命周期事件隐藏，正文尾部摘要行提示对应开关；用户/助手消息正文完整。
- 结果只写入输出文件（UTF-8 无 BOM、LF、末尾恰一个换行），终端仅两行 stdout（输出文件路径与摘要）。

## 退出码与错误

- `0` 成功（含 0 命中等空结果）；`1` 目标不存在（含前缀歧义）；`2` 参数错误；`3` 数据/IO 错误。
- stderr 只输出单行 `错误: <分类>`，分类后可附一段括号说明：歧义目标为 `（候选 N 个）`；参数错误为冲突或缺失的选项名、调用方自身在子命令位或选项位给出的 token（如 `错误: 参数无效（--format jsonl 与 --thinking 不能同时使用）`）。说明中不含会话内容、会话 ID、用户名与 dsh 数据路径。

## 使用要点

- `show` 的目标可写完整 id、唯一前缀（大小写不敏感，最短 8 字符，可省略 `session-`）或 `last`；歧义时按候选数改用更长前缀。
- 推理、工具调用/结果与生命周期事件默认隐藏，分别用 `--thinking`、`--tools`、`--events` 显示；正文尾部摘要行会提示实际隐藏原因。
- 尾部截断、坏行等异常会在输出中显式标注；解码失败以退出码 3 报错。
- `list`/`stats` 的元数据来自官方投影缓存；不可用时相关列显式标注"元数据不可用"并给出原因。
