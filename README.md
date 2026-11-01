# dsh-session-reader

> 读取、列出、检索、统计与校验本机 DeepSeek Harness（下称 dsh）的会话历史，包括子代理会话；全程只读、离线、不产生模型调用。

## 项目状态

| 字段 | 当前值 |
| --- | --- |
| 当前阶段 | Active Development |
| 已发布版本 | 0.3.0 |
| 当前主线 | 0.4.0-dev（未发布，变更见 `CHANGELOG.md` 的 `Unreleased` 段） |
| 对外稳定性 | CLI 与输出契约仍可能调整 |

`package.json` 的 `version` 记录已发布版本 0.3.0。当前主线尚未发布，因此该字段不随 `Unreleased` 的累积内容改动。

## 项目定位与范围

dsh 把每一次会话记录成一组日志文件，位置在 dsh 主目录的 `sessions/` 下。一个会话占一个目录，日志是 zstd 压缩的 JSONL，每行一个事件：用户消息、助手消息、推理、工具调用与结果、系统提示词，以及轮次、模型请求、上下文压缩、审批与运行时注入等生命周期事件。子代理会话单独存放，通过父会话标识与主会话关联。

dsh 自身不提供读取这些日志的命令，要查看一次会话只能手工定位目录、解压 zstd 帧、再逐行解析 JSON。本技能把这段过程收敛成五个命令（`list`、`show`、`search`、`stats`、`check`），把会话历史导出为 Markdown、JSON 与 JSONL 三种文件，供人阅读，也供程序或 agent 继续处理。

当前范围：

- 只处理本机 dsh 主目录内的会话日志与投影缓存，不解析远端会话，不提供实时事件流。
- 只读、离线的完整边界与唯一写入位置见 `SKILL.md` 的“适用范围”。

不覆盖的用法与数据边界见 `SKILL.md` 的“支持的会话来源”与“使用要点”两节。

## 适用环境

- **平台**：Windows。技能的路径处理、产物文件名校验与文件移动语义都按 Windows 实现。
- **执行载体**：桌面版 DeepSeek Harness 的 Electron-as-Node。脚本是 TypeScript（ESM），由该运行时原生类型剥离直接执行，没有构建步骤，`tsconfig.json` 只服务开发期类型检查。
- **dsh 安装**：本机需有一份可用的 dsh 安装，它提供两样东西，即会话数据本身，以及随桌面版发运的官方会话格式库。
- **会话日志格式**：只支持当前格式。旧版本日志按不可读处理，具体行为见 `SKILL.md` 的“支持的会话来源”。
- **主目录**：默认取环境变量 `DSH_HOME`，未设置时取 `~/.dsh`，可用 `--dsh-home` 覆盖。该选项只决定数据来源，不改变官方格式库的位置与版本。

### 官方格式库的位置

官方格式库随桌面版 dsh 一同安装，位于安装归档内的虚拟路径：

```text
%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules
```

该路径只有桌面版 Electron-as-Node 能读取。系统 Node 的 `existsSync` 对 `app.asar` 内路径恒为 false，因此用系统 Node 直接运行默认组合必然在加载格式库这一步失败；这种用法只适用于用 `--lib-root` 指向真实目录的开发场景。

技能默认以该锚点为唯一来源，不探测 npm 缓存、npx 安装树或 profile 依赖；定位失败时直接报错，不猜测也不回落。`--lib-root` 是唯一显式覆盖入口。锚点的判定要求见 `SKILL.md` 的“运行前提”。

## 安装与运行前提

1. 本机已安装桌面版 DeepSeek Harness 并至少使用过一次，`~/.dsh/sessions/` 下有会话日志。
1. 技能目录放在 `<dsh-home>/skills/session-reader/`，会话创建时它会被技能目录收录，模型可按名称加载。
1. 在运行命令的 PowerShell 里先设置执行载体，后续用 `& $desktopNode` 调用：

   ```powershell
   $env:DSH_DESKTOP_NODE_EXECUTABLE = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/DeepSeek Harness.exe'
   $desktopNode = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/bin/node.cmd'
   ```

   shim 设置 `ELECTRON_RUN_AS_NODE=1` 并转发 `--expose-internals`，其第三行直接引用 `DSH_DESKTOP_NODE_EXECUTABLE`。它是 `.cmd`，PowerShell 会等待并回传退出码。缺少该变量时的失败形态见 `SKILL.md` 的“运行前提”。
1. 全部命令必须显式指定 `--output-dir`，它没有默认值。惯例是指向项目临时目录。

## 最小可运行示例

```powershell
& $desktopNode scripts/session-reader.ts list --output-dir .\tmp
```

命令把会话清单写入 `.\tmp`。命令、选项与输出契约的完整说明见 `SKILL.md`。

## 模块结构

```text
SKILL.md                    技能说明，也是面向调用方的唯一契约正文
README.md                   本文件：项目定位、环境、安装运行与开发入口
CHANGELOG.md                对外变更记录
scripts/
  session-reader.ts         CLI 入口：解析、校验、分发、写出产物
  lib/
    decode.ts               官方格式库加载、事件解码与正文抽取出口
    frames.ts               物理层 zstd 帧扫描与逐帧解压
    paths.ts                官方格式库默认锚点、保留设备名与路径工具
    deployment-text.ts      部署包装的解析与剥离
    context-checkpoint.ts   合成上下文消息的判定与正文抽取
    ask-user.ts             问答的可读文本抽取
    handoff.ts              交接的结构事实与投递判定
    visibility.ts           默认参数下的可见性白名单
    message-source.ts       来源归属与来源标注
    store-*.ts              会话发现、投影缓存元数据、列表、检索、统计、校验
    render-*.ts             md、json、jsonl 渲染与命令级摘要
tests/                      单元测试、CLI 集成测试与全组合 lint 门禁
doc/开发规范.md              开发、测试与维护的要求与验收标准
```

## 开发与校验链

在技能目录下依次执行。前两步依赖 `npm ci` 安装的开发依赖，测试与门禁需要真实官方格式库与真实会话。

```powershell
$env:DSH_DESKTOP_NODE_EXECUTABLE = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/DeepSeek Harness.exe'
$desktopNode = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/bin/node.cmd'
npm ci
npx --no-install biome ci .
npx --no-install tsc --noEmit
& $desktopNode --test "tests/**/*.test.ts"
& $desktopNode scripts/session-reader.ts --help
foreach ($command in 'list', 'show', 'search', 'stats', 'check') { & $desktopNode scripts/session-reader.ts $command --help }
& $desktopNode tests/lint-matrix.ts --workdir tests/.tmp/matrix --real-home $env:USERPROFILE\.dsh
npx --no-install markdownlint-cli --config .markdownlint.jsonc .
```

覆盖率门禁按 `doc/开发规范.md` 的“测试要求”执行，它与上面最后一条命令共用 `tests/**/*.test.ts` 入口。

门禁的 `--workdir` 必须指向临时位置，否则逐组合结果与合成夹具会写进技能目录。测试或门禁取不到官方格式库、真实会话时直接失败，不跳过。

## 文档入口

- [`SKILL.md`](SKILL.md)：用途、运行前提、命令与选项语义、输出契约、退出码与错误、使用要点的唯一正文；模型加载技能时读到的也是它。
- [`CHANGELOG.md`](CHANGELOG.md)：对外变更记录与版本段。
- [`doc/开发规范.md`](doc/开发规范.md)：开发、测试、维护、发布的要求与验收标准。

## 许可证

[MIT](LICENSE)。
