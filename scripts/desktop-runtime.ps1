# 桌面版执行载具的定位与启动：本技能所有 CLI 调用的唯一运行时来源。
#
# 用途：由 skills/session-reader/scripts/session-reader.ps1 点源使用，向它提供两件事
#   1) Get-DesktopRuntime：按结构唯一定位桌面版安装，给出安装根、桌面版可执行文件与 shim 路径；
#   2) Invoke-DesktopNode：以 Electron-as-Node 形态启动桌面版可执行文件，逐字转发参数并回传退出码。
# 入口函数：Get-DesktopRuntime、Invoke-DesktopNode。本文件被点源，因此不得有顶层执行块。
# 关键依赖：Windows 的 %LOCALAPPDATA%\Programs 安装布局，以及桌面版安装自带的
#   resources\runtime\bin\node.cmd（用它的存在性作为"这是桌面版安装"的结构判据）。
# 设计约束：
#   * 定位只按结构，不拼产品目录名。写死名称会把任何名称形态差异直接变成定位失败，而该失败形态
#     与真实缺装无法区分；候选数不是恰好一个时抛错，不猜、不回退到其它目录。
#   * 必须用 [System.Diagnostics.ProcessStartInfo] 直接启动桌面版可执行文件，禁止经过 node.cmd。
#     node.cmd 用 `%*` 转发参数，而 `%*` 会被 cmd.exe 二次解析：含 `&` 的参数在那里被拆成两条命令，
#     参数不再逐字到达 Node。这是实测结论，不是预防性设计。
#   * 桌面版可执行文件是 GUI 子系统程序，裸 `&` 调用不会等待；必须用 ProcessStartInfo 加
#     WaitForExit() 才能取得退出码。
#   * 不使用 $global:、不写 Write-Host、不使用别名。

# 桌面版安装目录相对自身根的两级判据与执行载体名。
$script:PROGRAMS_DIRECTORY_NAME = 'Programs'
$script:NODE_CMD_RELATIVE_PATH = 'resources\runtime\bin\node.cmd'
# Electron-as-Node 形态下转发给 Node 的开关，与 shim 转发的一致；本技能据此加载官方格式库。
$script:EXPOSE_INTERNALS_ARGUMENT = '--expose-internals'

function Get-DesktopRuntime {
    <#
    .SYNOPSIS
    按结构唯一定位桌面版安装，返回安装根、桌面版可执行文件与 shim 路径。

    .DESCRIPTION
    候选是 `%LOCALAPPDATA%\Programs` 的直接子目录中带 `resources\runtime\bin\node.cmd` 的那一个。
    候选数不是恰好一个时抛错：多于一个时无法判断哪一棵与当前运行的桌面版同版，猜一棵等于加载到
    版本不确定的库；零个说明本机没有可用的桌面版安装。两种情况都由调用方按同一分类报错，因此
    这里直接抛出，不做任何回退。

    .PARAMETER LocalAppData
    本地应用数据根，默认取 `$env:LOCALAPPDATA`。

    .OUTPUTS
    System.Management.Automation.PSCustomObject，含 InstallRoot、ExecutablePath、NodeCmdPath。

    .EXAMPLE
    $runtime = Get-DesktopRuntime
    $runtime.ExecutablePath
    #>
    [CmdletBinding()]
    param(
        [string]$LocalAppData = $env:LOCALAPPDATA
    )

    if ([string]::IsNullOrEmpty($LocalAppData)) {
        throw '未能在 %LOCALAPPDATA%\Programs 下唯一定位桌面版安装，命中 0 个候选'
    }
    $programsRoot = Join-Path -Path $LocalAppData -ChildPath $script:PROGRAMS_DIRECTORY_NAME
    # 只认目录：Programs 若是同名文件，其下不会有安装目录，按"命中 0 个候选"处理。
    if (-not (Test-Path -LiteralPath $programsRoot -PathType Container)) {
        throw '未能在 %LOCALAPPDATA%\Programs 下唯一定位桌面版安装，命中 0 个候选'
    }

    try {
        $installRoots = @(
            Get-ChildItem -LiteralPath $programsRoot -Directory -ErrorAction Stop |
                Where-Object {
                    $nodeCmdPath = Join-Path -Path $_.FullName -ChildPath $script:NODE_CMD_RELATIVE_PATH
                    [System.IO.File]::Exists($nodeCmdPath)
                }
        )
    }
    catch {
        # 目录访问失败时不得把底层异常文本（可能含绝对路径）透给调用方；按"命中 0 个候选"处理，
        # 与目录不存在同一分类，由调用方统一报错。
        throw '未能在 %LOCALAPPDATA%\Programs 下唯一定位桌面版安装，命中 0 个候选'
    }
    if ($installRoots.Count -ne 1) {
        throw "未能在 %LOCALAPPDATA%\Programs 下唯一定位桌面版安装，命中 $($installRoots.Count) 个候选"
    }

    $installRoot = $installRoots[0].FullName
    # 可执行文件名与安装目录同名，因此从目录名派生；本机实测该关系成立，拼写直接取自目录名而不是
    # 硬编码产品名。关系不成立时下面的存在性检查会显式失败。
    $executableName = (Split-Path -Path $installRoot -Leaf) + '.exe'
    $executablePath = Join-Path -Path $installRoot -ChildPath $executableName
    if (-not [System.IO.File]::Exists($executablePath)) {
        throw '桌面版安装目录根部缺少与目录同名的可执行文件'
    }

    $nodeCmdPath = Join-Path -Path $installRoot -ChildPath $script:NODE_CMD_RELATIVE_PATH
    return [PSCustomObject]@{
        InstallRoot    = $installRoot
        ExecutablePath = $executablePath
        NodeCmdPath    = $nodeCmdPath
    }
}

function Invoke-DesktopNode {
    <#
    .SYNOPSIS
    以 Electron-as-Node 形态启动桌面版可执行文件，逐字转发参数并回传退出码。

    .DESCRIPTION
    子进程的输出被重定向后原样转发到本进程的 stdout/stderr，因此调用方的管道契约与直接运行 Node
    完全一致。参数经 ArgumentList 逐个加入，不拼接命令行，`&`、`%`、空串、换行、制表符、`--`
    与 `- item` 都逐字到达子进程。

    .PARAMETER ExecutablePath
    桌面版可执行文件绝对路径（由 Get-DesktopRuntime 给出）。

    .PARAMETER Arguments
    转发给 Node 的参数列表，第一项是本脚本路径，其后是 CLI 参数。

    .OUTPUTS
    System.Int32，子进程退出码。

    .EXAMPLE
    $exitCode = Invoke-DesktopNode -ExecutablePath $runtime.ExecutablePath -Arguments @($cliPath, '--help')
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ExecutablePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $ExecutablePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    # 编码必须显式指定为 UTF-8 无 BOM：CLI 的产物与 stderr 都是 UTF-8，依赖系统默认代码页会把中文
    # 文本解码成乱码，而乱码只在用户读出内容时才被发现。
    $startInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $startInfo.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
    $startInfo.Environment['ELECTRON_RUN_AS_NODE'] = '1'
    $null = $startInfo.ArgumentList.Add($script:EXPOSE_INTERNALS_ARGUMENT)
    foreach ($argument in $Arguments) {
        $null = $startInfo.ArgumentList.Add($argument)
    }

    $process = $null
    try {
        try {
            $process = [System.Diagnostics.Process]::Start($startInfo)
        }
        catch {
            # 错误文本不带绝对路径：stderr 的契约不含用户名与安装布局，只留 Win32 错误号定位系统原因。
            $startException = $_.Exception
            if ($startException -is [System.ComponentModel.Win32Exception]) {
                $nativeError = $startException.NativeErrorCode
            }
            else {
                $nativeError = $startException.HResult
            }
            throw "启动桌面版执行载体失败，Win32 错误 $nativeError"
        }

        # 先发起异步读取再等待退出：同步读一个管道的同时等待另一个管道写满会互相阻塞，子进程输出量
        # 超过管道缓冲区时整次调用死锁。
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()

        $stdoutText = $stdoutTask.GetAwaiter().GetResult()
        if ($stdoutText.Length -gt 0) {
            [Console]::Out.Write($stdoutText)
            [Console]::Out.Flush()
        }
        $stderrText = $stderrTask.GetAwaiter().GetResult()
        if ($stderrText.Length -gt 0) {
            [Console]::Error.Write($stderrText)
            [Console]::Error.Flush()
        }

        return $process.ExitCode
    }
    finally {
        # 异常路径下子进程可能仍在运行：先杀掉整棵进程树并等待它真正退出，再释放句柄，
        # 否则本进程退出后残留的 Node 子进程会继续写文件。
        if ($null -ne $process) {
            if (-not $process.HasExited) {
                $process.Kill($true)
                $process.WaitForExit()
            }
            $process.Dispose()
        }
    }
}
