# M2 (D7): does a service started from a hook survive the host's job / process tree? Plus cold start samples.
# Meant to run outside the SSH session (started through Win32_Process.Create) and write JSON lines to results.
param([string]$Root = 'C:\ags-measure-dbms', [string]$Tag = 'run1', [int]$ColdN = 10)
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition (Get-Content "$Root\AgsWin.cs" -Raw)
$res = "$Root\results\d7-$Tag.jsonl"; $work = "$Root\work"; New-Item -ItemType Directory -Force $work | Out-Null
function W($o) { ($o | ConvertTo-Json -Compress -Depth 6) | Add-Content -Encoding utf8 $res }
$node = (Get-Command node.exe).Source
$me = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
W @{ ev = 'env'; pid = $PID; ppid = $me.ParentProcessId; parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$($me.ParentProcessId)").Name; job = [AgsWin]::JobStatus($PID); user = (whoami); session = (Get-Process -Id $PID).SessionId; node = (& $node -v) }
$env:AGS_NODE = $node; $env:AGS_HOOK = "$Root\hook.mjs"; $env:AGS_PROBE = 'from-hook-env'
$psExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$jobArgs = '-NoLogo -NoProfile -NonInteractive -Command "$a = ConvertFrom-Json $env:AGS_HOOK_ARGS; & $env:AGS_NODE $env:AGS_HOOK $a"'

function HookArgs($mode, $name, $life) {
  ConvertTo-Json -Compress @('--mode', $mode, '--name', $name, '--service', "$Root\service.mjs", '--lock', "$work\$name.lock", '--log', "$work\$name.log", '--hb', "$work\$name.hb", '--life', "$life")
}
function Check($name, $svcPid) {
  $alive = [bool](Get-Process -Id $svcPid -ErrorAction SilentlyContinue)
  $hbAge = $null; if (Test-Path "$work\$name.hb") { $hbAge = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long](Get-Content "$work\$name.hb") }
  @{ alive = $alive; hbAgeMs = $hbAge; pipeHello = [AgsWin]::PipeHello($name, 1000); svcJob = $(if ($alive) { [AgsWin]::JobStatus($svcPid) } else { $null }) }
}
function RunHost($hostKind, $mode, $name, $life) {
  $env:AGS_HOOK_ARGS = HookArgs $mode $name $life
  $sw = [Diagnostics.Stopwatch]::StartNew()
  if ($hostKind -eq 'node') { $hostOut = "$work\$name.host.json"; & $node "$Root\host-node.mjs" $hostOut 20000 | Out-Null; $h = Get-Content $hostOut -Raw | ConvertFrom-Json }
  else { $h = [AgsWin]::RunInJob($psExe, $jobArgs, 20000) | ConvertFrom-Json }
  $hostMs = $sw.ElapsedMilliseconds
  $hook = $null; try { $hook = (($h.stdout -split "`n") | Where-Object { $_ -match '^\{' } | Select-Object -Last 1) | ConvertFrom-Json } catch {}
  $svcPid = if ($hook.servicePid) { $hook.servicePid } else { $hook.launchedPid }
  @{ hostMs = $hostMs; host = $h; hook = $hook; svcPid = $svcPid }
}

# 1. Job/process-tree survival matrix.
foreach ($hostKind in 'node', 'job') {
  foreach ($mode in 'shellexecute', 'cim', 'detached') {
    $name = "ags-m2-$Tag-$hostKind-$mode"
    $r = RunHost $hostKind $mode $name 90000
    Start-Sleep -Seconds 3
    $c = Check $name $r.svcPid
    W @{ ev = 'd7'; hostKind = $hostKind; mode = $mode; hostMs = $r.hostMs; hostResult = $r.host; hook = $r.hook; svcPid = $r.svcPid; after3s = $c; svcLog = @(Get-Content "$work\$name.log" -ErrorAction SilentlyContinue) }
    if ($c.alive) { Stop-Process -Id $r.svcPid -Force -ErrorAction SilentlyContinue }
  }
}

# 2. Cold start samples (hook run directly, service killed after each sample).
foreach ($mode in 'shellexecute', 'cim', 'detached') {
  for ($i = 1; $i -le $ColdN; $i++) {
    $name = "ags-m2-$Tag-cold-$mode-$i"
    $out = & $node "$Root\hook.mjs" --mode $mode --name $name --service "$Root\service.mjs" --lock "$work\$name.lock" --log "$work\$name.log" --hb "$work\$name.hb" --life 30000
    $hook = $out | Where-Object { $_ -match '^\{' } | Select-Object -Last 1 | ConvertFrom-Json
    W @{ ev = 'cold'; mode = $mode; i = $i; hook = $hook }
    $p = if ($hook.servicePid) { $hook.servicePid } else { $hook.launchedPid }
    if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
  }
}

# 3. Services left running; checked again after this script (the whole tree) has exited.
foreach ($k in @(@('node', 'shellexecute'), @('job', 'cim'))) {
  $name = "ags-m2-$Tag-keep-$($k[0])-$($k[1])"
  $r = RunHost $k[0] $k[1] $name 900000
  Start-Sleep -Seconds 2
  W @{ ev = 'keep'; hostKind = $k[0]; mode = $k[1]; name = $name; svcPid = $r.svcPid; after2s = (Check $name $r.svcPid) }
}
W @{ ev = 'done' }
