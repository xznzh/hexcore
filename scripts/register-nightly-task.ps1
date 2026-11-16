<#
.SYNOPSIS
    把 nightly-eval.ps1 注册成 Windows 计划任务（每天固定时间跑一次评测）。

.DESCRIPTION
    为什么单独写这个脚本，而不是在文档里贴几行命令：

    1. **注册必须管理员权限**。直接 New-ScheduledTaskAction 在非管理员 PowerShell 里
       报的是「拒绝访问」，看不出是权限问题还是语法问题；这里先探测再给明确提示。
    2. **要能后悔**。注册完想撤掉时，没人记得当初的 TaskName；这里固定用同一个名字，
       并提供 -Unregister 一条命令还原。
    3. **错过要补跑**。笔记本合盖、机器关机都会让 2:00 那次不执行；默认开启
       StartWhenAvailable，开机后补跑一次（而不是悄无声息少一个数据点）。
    4. **路径要绝对**。计划任务的工作目录不是项目目录，`npm run eval` 会找不到
       package.json；这里显式把 -WorkingDirectory 指到仓库根。

.PARAMETER At
    每日触发时间，默认 02:00。

.PARAMETER TaskName
    任务名，默认 'hexcore 夜间评测'。

.PARAMETER Unregister
    删除已注册的任务，不新建。

.EXAMPLE
    # 右键「以管理员身份运行 PowerShell」，然后：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-nightly-task.ps1

.EXAMPLE
    # 改成每天 03:30
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-nightly-task.ps1 -At 03:30

.EXAMPLE
    # 撤掉
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-nightly-task.ps1 -Unregister

.NOTES
    前提：评测要连数据库和模型接口，任务运行时机器不能睡眠、网络要通。
    想让它唤醒睡眠中的机器，需要硬件支持，这里不擅自开启。
#>
[CmdletBinding()]
param(
    [string]$At = '02:00',
    [string]$TaskName = 'hexcore 夜间评测',
    [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'scripts\nightly-eval.ps1'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# 只有注册/删除才需要管理员；先判权限，别等 cmdlet 抛「拒绝访问」再猜
if (-not (Test-Admin)) {
    Write-Host '[失败] 需要管理员权限。' -ForegroundColor Red
    Write-Host '       请以「管理员身份运行 PowerShell」，再执行同一条命令。' -ForegroundColor Yellow
    exit 1
}

# ---------- 卸载 ----------
if ($Unregister) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Host "[跳过] 没有名为「$TaskName」的任务。" -ForegroundColor Yellow
        exit 0
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "[完成] 已删除任务「$TaskName」。" -ForegroundColor Green
    exit 0
}

# ---------- 注册前体检 ----------
if (-not (Test-Path $target)) {
    Write-Host "[失败] 找不到 $target" -ForegroundColor Red
    exit 1
}

# 时间格式校验：New-ScheduledTaskTrigger -At 对非法值报错信息很难懂，提前拦一道
$parsed = [DateTime]::MinValue
if (-not [DateTime]::TryParseExact($At, 'HH:mm', $null, [System.Globalization.DateTimeStyles]::None, [ref]$parsed)) {
    Write-Host "[失败] -At 需要 HH:mm 格式（例如 02:00 或 03:30），收到：$At" -ForegroundColor Red
    exit 1
}

# npm 能否找到：任务里靠 PATH，本机是 pnpm/npm 混用，先确认一次
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host '[警告] 当前会话 PATH 里没有 npm，任务运行时可能失败。' -ForegroundColor Yellow
    Write-Host '       建议在任务动作里改成绝对路径（见脚本末尾注释）。' -ForegroundColor Yellow
}

# ---------- 注册 ----------
$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $target) `
    -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -Daily -At $At

# StartWhenAvailable：错过触发（睡眠/关机）后开机补跑，避免趋势图缺一个点
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -MultipleInstances IgnoreNew

# 用当前用户身份运行（交互式），这样能读到用户级的环境变量与 .env
$principal = New-ScheduledTaskPrincipal `
    -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[信息] 同名任务已存在，将覆盖动作与触发器。" -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description '每晚跑 golden set 评测、更新趋势图、判定疑似回归' | Out-Null

Write-Host ''
Write-Host "[完成] 已注册计划任务「$TaskName」" -ForegroundColor Green
Write-Host "       触发：每天 $At"
Write-Host "       动作：powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$target`""
Write-Host "       目录：$root"
Write-Host ''
Write-Host '接下来：' -ForegroundColor Cyan
Write-Host '  1. 立刻试跑一次（不必等到明天）：'
Write-Host "     Start-ScheduledTask -TaskName '$TaskName'"
Write-Host '  2. 看日志：evals\reports\nightly-*.log'
Write-Host '  3. 看趋势：evals\reports\trend.html'
Write-Host '  4. 有疑似回归会生成 evals\reports\ALERT.md（恢复后自动删除）'
Write-Host ''
Write-Host '注意：机器睡眠/关机时不会跑（已开补跑，开机后会补一次）；数据库需在线。' -ForegroundColor DarkGray
Write-Host '若任务报「找不到 npm」，把 -Execute 改成 npm.cmd 的绝对路径（where.exe npm 可查）。' -ForegroundColor DarkGray
