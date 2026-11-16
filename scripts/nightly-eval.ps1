<#
.SYNOPSIS
    夜间自动评测：跑 golden set → 更新趋势图 → 判定是否疑似回归 → 清理过期报告。

.DESCRIPTION
    设计要点（三条，都是踩过或差点踩的）：

    1. **vitest 的退出码不代表质量**。eval.test.ts 只是 console.log 结果、不 assert，
       所以「52 条里挂了 3 条」也是 exit 0。不能靠退出码判断好坏，必须读报告 JSON 比。
    2. **比较对象要选对**。和「绝对分数」比会天天误报（模型有 ±1~2 条抖动）；
       这里和「上一次同配置」比，且要掉 2 条以上才算疑似回归。
    3. **清理只碰自己产的文件**。白名单正则限定「评测报告 / 夜间日志」，
       trend.html 与任何非上述命名的文件一律不动。

.PARAMETER KeepDays
    报告与日志保留天数，默认 14。

.PARAMETER SkipEval
    跳过评测，只重画趋势并做清理判定（调样式 / 补历史时用）。

.PARAMETER WhatIfClean
    演练模式：只列出将被清理的文件，不删除。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\nightly-eval.ps1

.EXAMPLE
    # 注册为每天凌晨 2:00 的计划任务（需要管理员 PowerShell；机器须不休眠、数据库在跑）
    $a = New-ScheduledTaskAction -Execute 'powershell.exe' `
         -Argument '-NoProfile -ExecutionPolicy Bypass -File "D:\Python WorkSpace\ai-agent-platform\scripts\nightly-eval.ps1"'
    $t = New-ScheduledTaskTrigger -Daily -At 2:00am
    Register-ScheduledTask -TaskName 'ai-agent-platform 夜间评测' -Action $a -Trigger $t -Description '每晚跑 golden set 并更新趋势'

.NOTES
    退出码：0 正常 / 2 疑似回归 / 3 配置缺失 / 4 评测进程异常 / 5 趋势脚本异常。
#>
[CmdletBinding()]
param(
    [int]$KeepDays = 14,
    [switch]$SkipEval,
    [switch]$WhatIfClean
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$reports = Join-Path $root 'evals\reports'
if (-not (Test-Path $reports)) { New-Item -ItemType Directory -Path $reports -Force | Out-Null }

$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$log = Join-Path $reports "nightly-$stamp.log"

function Write-Log {
    param([string]$Message)
    # 外部命令的输出常带 \r（node 在 Windows 上的换行、进度条残留），
    # 不清掉会写进日志，也让控制台出现杂字符
    $clean = ($Message -replace "`r", '').TrimEnd()
    $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $clean
    Write-Host $line
    Add-Content -Path $log -Value $line -Encoding UTF8
}

<#
    跑一条外部命令并把输出逐行进日志。
    不用 `Tee-Object -FilePath` 的原因：它默认按 UTF-16 写文件，和上面 Add-Content 的 UTF-8
    混写同一个日志，读出来是乱码；而且它把非字符串对象原样丢进管道，会出现莫名的杂字符。
#>
function Invoke-Logged {
    param([scriptblock]$Command)
    # 外部命令往 stderr 写东西是常态（npm 的告警、vite 的版本提示）。
    # 在脚本顶部的 Stop 模式下，`2>&1` 会把它们变成 ErrorRecord 直接当终止错误抛出：
    # 实测一次就是「评测其实跑完了、报告也写出来了，日志却断在 vitest 启动那一行」。
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Command 2>&1 | ForEach-Object { Write-Log ([string]$_) }
    }
    finally {
        $ErrorActionPreference = $prev
    }
}

Write-Log "夜间评测开始 · 目录 $root"

if (-not (Test-Path (Join-Path $root '.env.local')) -and -not (Test-Path (Join-Path $root '.env'))) {
    Write-Log '找不到 .env.local / .env，配置缺失，直接退出（不算评测失败）'
    exit 3
}

# ── 1. 跑评测 ───────────────────────────────────────────────────────────
$evalCode = 0
if ($SkipEval) {
    Write-Log '已指定 -SkipEval，跳过评测，仅更新趋势'
} else {
    Write-Log '开始跑 golden set（约 5 分钟）'
    Invoke-Logged { & npm.cmd run eval }
    $evalCode = $LASTEXITCODE
    Write-Log "评测进程退出码 $evalCode"
}

# ── 2. 更新趋势 + 回归判定 ──────────────────────────────────────────────
$trendCode = 0
$trendHtml = Join-Path $reports 'trend.html'
Invoke-Logged { & node 'evals/trend.mjs' '--check' '--html' $trendHtml }
$trendCode = $LASTEXITCODE
Write-Log "趋势脚本退出码 $trendCode（2 = 疑似回归）"

# ── 3. 清理过期报告（白名单，绝不碰 trend.html 与仓库内其他文件）────────
$cut = (Get-Date).AddDays(-$KeepDays)
$pattern = '^\d{4}-\d\d-\d\dT[\d-]+(-no-gate)?\.(json|md)$|^nightly-\d{8}-\d{4}\.log$'
$expired = @(Get-ChildItem -Path $reports -File -ErrorAction SilentlyContinue | Where-Object {
        $_.LastWriteTime -lt $cut -and $_.Name -match $pattern
    })

if ($expired.Count -eq 0) {
    Write-Log "无需清理（保留 $KeepDays 天）"
}
elseif ($WhatIfClean) {
    Write-Log "演练模式：以下 $($expired.Count) 个文件已超过 $KeepDays 天，未删除"
    foreach ($f in $expired) { Write-Log "  - $($f.Name)" }
}
else {
    foreach ($f in $expired) { Remove-Item -LiteralPath $f.FullName -Force -Confirm:$false }
    Write-Log "已清理 $($expired.Count) 个超过 $KeepDays 天的报告/日志"
}

# ── 4. 结论 ─────────────────────────────────────────────────────────────
if ($evalCode -ne 0) {
    Write-Log '评测进程异常退出，看上面的输出（常见原因：数据库没起 / 模型额度用尽）'
    exit 4
}
if ($trendCode -eq 2) {
    Write-Log '疑似回归：通过数较上次同配置下降 2 条以上，或平均命中片数明显上升。跑 npm run eval:diff 看逐条变化'
    exit 2
}
if ($trendCode -ne 0) {
    Write-Log "趋势脚本异常（$trendCode）"
    exit 5
}

Write-Log "完成，无显著变化。趋势图：$reports\trend.html"
exit 0
