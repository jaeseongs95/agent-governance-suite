# M3: default DACL of a Node net.Server named pipe and what another local (non-admin) user can do.
# Creates a temporary local user and deletes it (and any profile) in finally.
param([string]$Root = 'C:\ags-measure-dbms')
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition (Get-Content "$Root\AgsWin.cs" -Raw)
$work = "$Root\work"; New-Item -ItemType Directory -Force $work | Out-Null
$res = "$Root\results\m3.jsonl"
function W($o) { $j = $o | ConvertTo-Json -Compress -Depth 6; $j | Add-Content -Encoding utf8 $res; $j }
$node = (Get-Command node.exe).Source
function StartSvc($name) {
  Start-Process -FilePath $node -ArgumentList "$Root\service.mjs --name $name --lock $work\$name.lock --log $work\$name.log --life 45000" -WindowStyle Hidden -PassThru
}
$user = 'agsm3probe'
$pw = 'Ag9!' + [guid]::NewGuid().ToString('N').Substring(0, 16) + 'z#'
# net user /add prompts (Y/N) for passwords longer than 14 characters and blocks a non-interactive run; use the cmdlets.
$created = $null
try { New-LocalUser -Name $user -Password (ConvertTo-SecureString $pw -AsPlainText -Force) -Description "AGS M3 temporary probe" -ErrorAction Stop | Out-Null; Add-LocalGroupMember -Group Users -Member $user -ErrorAction Stop; $created = "ok" } catch { $created = "err: $_" }
try {
  $sid = (New-Object System.Security.Principal.NTAccount($user)).Translate([System.Security.Principal.SecurityIdentifier]).Value
  $groups = (Get-LocalGroup | Where-Object { (Get-LocalGroupMember -Group $_.Name -ErrorAction SilentlyContinue | Where-Object { $_.SID.Value -eq $sid }) } | ForEach-Object Name) -join ','
  $how = ''; $tok = [AgsWin]::Logon($user, $pw, [ref]$how)

  # 1. Pipe created by the service (Administrator) with Node's default listen(): SDDL + other-user access.
  $svcName = "ags-m3-svc-$PID"
  $p = StartSvc $svcName
  $hello = 'none'; for ($i = 0; $i -lt 50 -and $hello -notlike 'ok*'; $i++) { Start-Sleep -Milliseconds 100; $hello = [AgsWin]::PipeHello($svcName, 500) }
  $sddl = [AgsWin]::PipeSddl($svcName)
  $probe = if ($tok -ne [IntPtr]::Zero) { [AgsWin]::ProbeAs($tok, $svcName) | ConvertFrom-Json } else { $null }
  $after = [AgsWin]::PipeHello($svcName, 1000)
  W @{ ev = 'm3-default'; user = $user; created = $created; sid = $sid; groups = $groups; logon = $how; adminHelloBefore = $hello; sddl = $sddl; otherUser = $probe; adminHelloAfter = $after }
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue

  # 2. Squat: the other user creates the name first, then the service starts, then an ordinary client connects.
  if ($tok -ne [IntPtr]::Zero) {
    $sq = "ags-m3-squat-$PID"
    $info = ''; $hs = [AgsWin]::SquatAs($tok, $sq, [ref]$info)
    $p2 = StartSvc $sq
    Start-Sleep -Milliseconds 2500
    $svcAlive = [bool](Get-Process -Id $p2.Id -ErrorAction SilentlyContinue)
    $h = [IntPtr]::Zero; $send = [AgsWin]::ClientSend($sq, [ref]$h)
    Start-Sleep -Milliseconds 200
    $saw = @([AgsWin]::SquatAccept($hs[0]) | ConvertFrom-Json; [AgsWin]::SquatAccept($hs[1]) | ConvertFrom-Json)
    [AgsWin]::Close($h)
    $sqSddl = [AgsWin]::PipeSddl($sq)
    W @{ ev = 'm3-squat'; squatterCreate = $info; serviceAliveAfter2500ms = $svcAlive; serviceLog = @(Get-Content "$work\$sq.log" -ErrorAction SilentlyContinue); clientPid = $PID; clientSend = $send; squatterInstances = $saw; squatPipeSddl = $sqSddl }
    [AgsWin]::Close($hs[0]); [AgsWin]::Close($hs[1])
    Stop-Process -Id $p2.Id -Force -ErrorAction SilentlyContinue
    [AgsWin]::Close($tok)
  }
} finally {
  Remove-LocalUser -Name $user -ErrorAction SilentlyContinue
  $prof = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }
  if ($prof) { $prof | Remove-CimInstance }
  W @{ ev = 'm3-cleanup'; userDeleted = -not [bool](Get-LocalUser -Name $user -ErrorAction SilentlyContinue); profileFound = [bool]$prof; profileDirExists = (Test-Path "C:\Users\$user") }
}
