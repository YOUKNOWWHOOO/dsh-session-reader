# 本技能的唯一调用方入口：定位桌面版安装，以 Electron-as-Node 方式启动 session-reader.ts，
# 并把调用方的全部参数原样转发、把子进程退出码原样回传。
#
# 职责：只做"载具定位 + 参数转发 + 退出码透传"。所有会话读取逻辑都在同目录的
#   session-reader.ts 内，本脚本不做任何解析、校验或输出改写。
# 关键依赖：同目录的 desktop-runtime.ps1（点源取得 Get-DesktopRuntime 与 Invoke-DesktopNode）。
# 设计约束：
#   * 本脚本不声明 param 块。自动变量 `$args` 保留全部 token 的字面形态，`--output-dir`、`--help`、
#     `--`、`- item` 因此不会被 PowerShell 的参数绑定改写；一旦声明 param，CLI 的选项表就与
#     PowerShell 的绑定规则形成两套真值源。
#   * 不改变当前工作目录、不注入 DSH_DESKTOP_NODE_EXECUTABLE、不注入 --lib-root、不回退到系统 Node。
#     相对路径参数必须相对调用方的当前目录解析，改变工作目录会让产物落到非预期位置。
#   * 内部错误只输出一行 stderr。CLI 的 stderr 契约是"错误: <分类>"单行，因此这里不能用
#     Write-Error（它会输出多行格式并带上调用栈信息）。
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

. (Join-Path -Path $PSScriptRoot -ChildPath 'desktop-runtime.ps1')

try {
    $runtime = Get-DesktopRuntime
    $cliPath = Join-Path -Path $PSScriptRoot -ChildPath 'session-reader.ts'
    $exitCode = Invoke-DesktopNode -ExecutablePath $runtime.ExecutablePath -Arguments (@($cliPath) + $args)
    exit $exitCode
}
catch {
    $message = $_.Exception.Message
    if ([string]::IsNullOrEmpty($message)) {
        $message = '执行入口内部错误'
    }
    [Console]::Error.Write("错误: 内部错误（$message）`n")
    [Console]::Error.Flush()
    exit 3
}
