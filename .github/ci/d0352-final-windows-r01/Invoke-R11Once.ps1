param([string]$IntentPath,[string]$ReportPath,[string]$IntentSha256,[string]$ReportSha256)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=$OutputEncoding=[Text.UTF8Encoding]::new($false)
$script:ExecutorRoot=$PSScriptRoot
$script:ExecutorPlanPath='D:/codex/개발자/work/d0352-isolated-install-r01/executor-r01/PREPARATION.safe.json'
$script:ExecutorCommandPath='D:/codex/개발자/work/d0352-isolated-install-r01/executor-r01/AFTER-AUTHORIZATION-COMMANDS.txt'
$script:ExecutorPlanHash='ad365aa0321c5c4cf1033223dd4bfb9a770c6db288c7d59ec9057cfd7feb17e6'
$script:ExecutorCommandHash='fe2dce182edb2ddb4be0b40d78c7c4a7d39f39f256384b9ab00e6c280aaf56d4'
$script:ExecutorApplyHash='56c1169901d22a80bebb8503a3b7a14d445f59ff6f5d69429e827c455efd348f'
$script:ExecutorBaselineHash='11b5c5479df0d544432c49fa452b61b8053f72eaed8246a107d034e7ae5a0801'
$script:ExecutorVerifier='D:/codex/개발자/work/d0352-isolated-install-r01/executor-r01/preflight-source/skills/mutation-risk-preflight/scripts/verify-preflight-receipt.mjs'
$script:ExecutorVerifierHash='0cb206aff307cc5f704067db5aee4a03acec7e239072418cc09694aa59746bae'
$script:ExecutorPowerShell='C:/Users/Lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe'
$script:ExecutorNode='C:/Program Files/nodejs/node.exe'
$script:R07GuardPath=Join-Path $PSScriptRoot 'Headless-Guard.ps1'
if((Get-FileHash -LiteralPath $script:R07GuardPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'c7dd13e400024e0cd641c8c83be07183ea4849945bbff50d2fe921379f2f07b0'){throw 'HEADLESS_GUARD_PIN_MISMATCH'}
. $script:R07GuardPath
function Get-ExecutorHash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Get-ExecutorTextHash([string]$Text) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant() }
function Assert-ExecutorPin([string]$Path,[string]$Hash) {
  if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Hash -cnotmatch '^[a-f0-9]{64}$' -or -not (Test-Path -LiteralPath $Path -PathType Leaf) -or (Get-ExecutorHash $Path) -cne $Hash) { throw 'FIXED_INPUT_MISMATCH' }
}
function Get-ExecutorApply([string]$CommandPath=$script:ExecutorCommandPath,[string]$CommandHash=$script:ExecutorCommandHash,[string]$PlanPath=$script:ExecutorPlanPath,[string]$PlanHash=$script:ExecutorPlanHash) {
  Assert-ExecutorPin $CommandPath $CommandHash; Assert-ExecutorPin $PlanPath $PlanHash
  $matches=[regex]::Matches([IO.File]::ReadAllText($CommandPath,[Text.UTF8Encoding]::new($false,$true)),'(?s)# BEGIN APPLY POWERSHELL\r?\n(.*?)# END APPLY POWERSHELL')
  if($matches.Count -ne 1){throw 'APPLY_BLOCK_COUNT'}; $body=$matches[0].Groups[1].Value
  if((Get-ExecutorTextHash $body) -cne $script:ExecutorApplyHash){throw 'APPLY_BLOCK_MISMATCH'}
  $tokens=$null;$errors=$null;$null=[Management.Automation.Language.Parser]::ParseInput($body,[ref]$tokens,[ref]$errors)
  if($errors.Count){throw 'APPLY_PARSE_FAILED'}; return $body
}
function Get-ExecutorAction {
  $self=Join-Path $script:ExecutorRoot 'Invoke-R11Once.ps1'
  [ordered]@{tool='PowerShell';action=('executor='+$self+';executorSha256='+(Get-ExecutorHash $self)+';applySha256='+$script:ExecutorApplyHash+';manifestSha256='+$script:ExecutorPlanHash)}
}
function Assert-ExecutorIntent($Intent,$Plan,$Action) {
  if($Intent.actionClass -cne 'deploy' -or $Intent.plannedCommandOrTool.tool -cne $Action.tool -or $Intent.plannedCommandOrTool.action -cne $Action.action){throw 'PREFLIGHT_ACTION_MISMATCH'}
  $expected=[Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($file in $Plan.hosts.files){$expected.Add([IO.Path]::GetFullPath($file.target),'sha256:'+$file.oldSha256)}
  if(@($Intent.targets).Count -ne $expected.Count){throw 'PREFLIGHT_TARGET_COUNT'}
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($target in $Intent.targets){
    if(-not [IO.Path]::IsPathFullyQualified([string]$target.locator)){throw 'PREFLIGHT_TARGET_PATH'}; $resolved=[IO.Path]::GetFullPath($target.locator)
    if(-not $seen.Add($resolved) -or -not $expected.ContainsKey($resolved) -or $target.expectedFingerprint -cne $expected[$resolved]){throw 'PREFLIGHT_TARGET_MISMATCH'}
  }
}
function Write-ExecutorState($Context,[string]$State,$Details) {
  $record=[ordered]@{schemaVersion='R11OneShotExecution.v1';state=$State;startedUtc=$Context.startedUtc;updatedUtc=[DateTime]::UtcNow.ToString('o');elapsedMs=[long]$Context.clock.ElapsedMilliseconds;applyInvocations=$Context.applyInvocations;headlessIdentity=$Context['headlessIdentity'];headlessGuardObservation=$script:R07LastNativeObservation;details=$Details;lastUnknown=$Context['lastUnknown']}
  $pending=$Context.statePath+'.pending'; $bytes=[Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $record -Depth 20).Replace([string][char]13,'')+[char]10)
  $stream=[IO.File]::Open($pending,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}; [IO.File]::Move($pending,$Context.statePath,$true)
}
function Convert-ExecutorArguments([string]$Line) {
  if(-not ('R11WindowsArguments' -as [type])){
    Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class R11WindowsArguments {
 [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string line,out int count);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
 public static string[] Parse(string line){int count;var ptr=CommandLineToArgvW(line,out count);if(ptr==IntPtr.Zero)throw new InvalidOperationException("ARGUMENT_PARSE_FAILED");try{var result=new string[count];for(int i=0;i<count;i++)result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(ptr,i*IntPtr.Size));return result;}finally{LocalFree(ptr);}}
}
'@
  }; return [R11WindowsArguments]::Parse($Line)
}
function Get-ExecutorSafeProcess($Process,[string]$Kind,[string]$HostName) {
  if(-not $Process.ExecutablePath -or -not $Process.CreationDate){throw 'PROCESS_IDENTITY_UNAVAILABLE'}
  [pscustomobject]@{pid=[int]$Process.ProcessId;parentPid=[int]$Process.ParentProcessId;name=[string]$Process.Name;executablePath=[string]$Process.ExecutablePath;createdUtc=$Process.CreationDate.ToUniversalTime().ToString('o');kind=$Kind;host=$HostName}
}
function Read-ExecutorObservation($Plan,$KnownHosts=@(),$Rows=$null) {
  if($null -eq $Rows){$Rows=@(Get-CimInstance Win32_Process -OperationTimeoutSec 5 -ErrorAction Stop)}
  $by=@{};foreach($row in $Rows){$by[[int]$row.ProcessId]=$row}
  $selected=[Collections.Generic.List[object]]::new();$hosts=[Collections.Generic.List[object]]::new();$unknown=[Collections.Generic.List[object]]::new();$tokens=@{}
  foreach($row in $Rows){
    if($row.Name -notmatch '^(node|node_repl|codex|claude|ChatGPT|Claudes|Antigravity|language_server.*)\.exe$'){continue}
    if(-not $row.CommandLine){
      if($row.Name -match '^(node|node_repl|codex|claude|ChatGPT|Claudes|Antigravity|language_server.*)\.exe$'){
        $identity=$row | Select-Object Name,ExecutablePath,CreationDate,ParentProcessId
        $unavailable=@()
        foreach($field in @('Name','ExecutablePath','CreationDate','ParentProcessId')){
          $property=$row.PSObject.Properties[$field]
          if($null -eq $property){$unavailable+=@{field=$field;reason='PROPERTY_NOT_RETURNED'}}
          elseif($null -eq $identity.$field -or ($identity.$field -is [string] -and $identity.$field.Length -eq 0)){$unavailable+=@{field=$field;reason='NULL_OR_EMPTY'}}
        }
        $unknown.Add(@{pid=[int]$row.ProcessId;reason='PROCESS_ARGUMENTS_UNAVAILABLE';name=$identity.Name;executablePath=$identity.ExecutablePath;createdUtc=if($identity.CreationDate){$identity.CreationDate.ToUniversalTime().ToString('o')}else{$null};parentPid=if($null -ne $identity.ParentProcessId -and -not ($identity.ParentProcessId -is [string] -and $identity.ParentProcessId.Length -eq 0)){[int]$identity.ParentProcessId}else{$null};metadataUnavailable=$unavailable})
      };continue
    }
    $args=@(Convert-ExecutorArguments ([string]$row.CommandLine));$tokens[[int]$row.ProcessId]=$args
    foreach($hostPlan in $Plan.hosts){
      $root=$hostPlan.installRoot.Replace('\','/').TrimEnd('/')+'/'
      $entry=@($args | Where-Object {$arg=$_.Replace('\','/');$arg.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -and $arg.EndsWith('.mjs',[StringComparison]::OrdinalIgnoreCase)})
      if(-not $entry.Count){continue}
      $kind=if($entry[0] -match 'session-message-relay\.mjs$'){'relay'}elseif($entry[0] -match 'session-message-broker\.mjs$'){'broker'}elseif($entry[0] -match '[/\\]server\.mjs$'){'mcp'}else{'ags-runtime'}
      $safe=Get-ExecutorSafeProcess $row $kind $hostPlan.host;$selected.Add($safe)
      $parent=[int]$row.ParentProcessId;$hintIndex=[Array]::IndexOf($args,'--parent-pid')
      if($hintIndex -ge 0){if($hintIndex+1 -ge $args.Count -or $args[$hintIndex+1] -cnotmatch '^[1-9][0-9]*$'){throw 'PARENT_HINT_INVALID'};$parent=[int]$args[$hintIndex+1]}
      $seen=[Collections.Generic.HashSet[int]]::new()
      for($depth=0;$parent -gt 0 -and $depth -lt 32;$depth++){
        if(-not $seen.Add($parent)){throw 'PARENT_CHAIN_CYCLE'}; $ancestor=$by[$parent];if(-not $ancestor){break}
        if($ancestor.CreationDate -gt $row.CreationDate){$unknown.Add(@{pid=$safe.pid;reason='PARENT_PID_REUSED'});break}
        if($ancestor.Name -match '^(explorer|services|wininit|svchost|System)\.exe$'){break}
        $isHost=switch($hostPlan.host){'codex'{$ancestor.Name -match '^(codex|ChatGPT)\.exe$'} 'claude-code'{$ancestor.Name -match '^(claude|Claudes)\.exe$'} 'antigravity'{$ancestor.Name -match '^(Antigravity|language_server.*)\.exe$'} default{$false}}
        if($isHost){$hosts.Add((Get-ExecutorSafeProcess $ancestor 'host' $hostPlan.host))}; $parent=[int]$ancestor.ParentProcessId
      }; break
    }
  }
  $bindings=@($KnownHosts)+@($hosts.ToArray())
  foreach($row in $Rows){
    $binding=@($bindings | Where-Object {[string]::Equals($_.executablePath,[string]$row.ExecutablePath,[StringComparison]::OrdinalIgnoreCase)})
    if($binding.Count){$hosts.Add((Get-ExecutorSafeProcess $row 'host' $binding[0].host))}
    elseif(@($bindings | Where-Object {$_.name -ieq $row.Name}).Count){$unknown.Add(@{pid=[int]$row.ProcessId;reason='HOST_EXECUTABLE_CHANGED'})}
  }
  $hostIds=@{};foreach($hostRow in $hosts){$hostIds[$hostRow.pid]=$hostRow}
  foreach($row in $Rows){
    if(@($selected | Where-Object pid -eq $row.ProcessId).Count -or -not $tokens.ContainsKey([int]$row.ProcessId)){continue}
    $relative=@($tokens[[int]$row.ProcessId] | Where-Object {$_.Replace('\','/') -ceq 'mcp-server/dist/server.mjs'}); if(-not $relative.Count){continue}
    $parent=[int]$row.ParentProcessId;$seen=[Collections.Generic.HashSet[int]]::new();$owner=$null
    for($depth=0;$parent -gt 0 -and $depth -lt 32;$depth++){
      if(-not $seen.Add($parent)){throw 'PARENT_CHAIN_CYCLE'}; $ancestor=$by[$parent]
      if(-not $ancestor -or $ancestor.Name -match '^explorer\.exe$'){break};if($ancestor.CreationDate -gt $row.CreationDate){$unknown.Add(@{pid=[int]$row.ProcessId;reason='PARENT_PID_REUSED'});break}
      if($hostIds.ContainsKey($parent)){$owner=$hostIds[$parent];break};$parent=[int]$ancestor.ParentProcessId
    }; if($owner){$selected.Add((Get-ExecutorSafeProcess $row 'mcp-relative-owned' $owner.host))}else{$unknown.Add(@{pid=[int]$row.ProcessId;reason='RELATIVE_MCP_HOST_UNRESOLVED'})}
  }
  [pscustomobject]@{observedUtc=[DateTime]::UtcNow.ToString('o');selected=@($selected.ToArray() | Sort-Object pid -Unique);hosts=@($hosts.ToArray() | Sort-Object pid -Unique);unknown=@($unknown.ToArray());query='Win32_Process 단일 현재 목록';rawCommandLineStored=$false}
}
function Get-ExecutorWaitDecision($Observation,[long]$ElapsedMs,[int]$ClearCount) {
  if($ElapsedMs -ge 600000){return 'TIMED_OUT'}; if(@($Observation.unknown).Count){return 'BLOCKED_UNKNOWN_OWNERSHIP'}
  if(@($Observation.selected).Count -or @($Observation.hosts).Count){return 'WAITING_SAFE_SHUTDOWN'}
  if($ClearCount -lt 1){return 'WAITING_SECOND_ABSENCE'}; return 'READY'
}
function Assert-ExecutorVerifierInputs {
  Assert-ExecutorPin (Join-Path $script:ExecutorRoot 'preflight-source/skills/mutation-risk-preflight/scripts/verify-preflight-receipt.mjs') '0cb206aff307cc5f704067db5aee4a03acec7e239072418cc09694aa59746bae'
  Assert-ExecutorPin (Join-Path $script:ExecutorRoot 'preflight-source/skills/mutation-risk-preflight/scripts/evaluate-preflight.mjs') '9ff002852bc34338ed94fdf0e9c5060cdb92f602961d2a959237d365ffeae40c'
  Assert-ExecutorPin (Join-Path $script:ExecutorRoot 'preflight-source/skills/mutation-risk-preflight/scripts/schema-validation.mjs') '4cce85dc38941f216349a8ac89fa230f2d40ea55d05ccb17b3d030bdd7a141d2'
  Assert-ExecutorPin (Join-Path $script:ExecutorRoot 'preflight-source/skills/mutation-risk-preflight/contracts/mutation-intent.v1.schema.json') 'eaf3bc82d4d18372544e54f39cfe0d6214ade77e983589de62789828207b8dc6'
  Assert-ExecutorPin (Join-Path $script:ExecutorRoot 'preflight-source/skills/mutation-risk-preflight/contracts/mutation-preflight-report.v1.schema.json') '4e6f86d0baf672ef0bd83a4a9c592bd8ec5dcab1f342071372908f52e5217fde'
  Assert-ExecutorPin (Join-Path $script:ExecutorRoot 'preflight-source/runtime/schema-validation.mjs') '04ff3beef504afe8afd2e90213098e72cea7943af0e1a2438f6a896e1c525d75'
}
function Assert-ExecutorScope($Plan) {
  if($Plan.candidateCommit -cne '94f4bb42353bde3be9a653e80070c5421c6c801f' -or $Plan.candidateTree -cne '73fe2528c9c967bf3d7b495f8ef6bd5b2f687265'){throw 'FIXED_CANDIDATE_MISMATCH'}
  $counts=@{'codex'=5;'claude-code'=6;'antigravity'=5};$seenHosts=@{}
  $targets=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $backups=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);$artifacts=@{}
  foreach($artifact in $Plan.artifacts){if($artifacts.ContainsKey($artifact.sourceArtifact)){throw 'DUPLICATE_ARTIFACT'};$artifacts[$artifact.sourceArtifact]=$artifact}
  foreach($hostPlan in $Plan.hosts){
    if(-not $counts.ContainsKey($hostPlan.host) -or $seenHosts.ContainsKey($hostPlan.host) -or @($hostPlan.files).Count -ne $counts[$hostPlan.host]){throw 'HOST_SCOPE_MISMATCH'};$seenHosts[$hostPlan.host]=$true
    $prefix=[IO.Path]::GetFullPath($hostPlan.installRoot).TrimEnd('\')+'\'
    foreach($file in $hostPlan.files){
      $target=[IO.Path]::GetFullPath($file.target)
      if(-not $target.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or -not $targets.Add($target) -or -not $backups.Add($file.backupRelativePath)){throw 'TARGET_SCOPE_OR_DUPLICATE_MISMATCH'}
      $artifact=$artifacts[$file.sourceArtifact]
      if(-not $artifact -or $artifact.sha256 -cne $file.newSha256 -or $artifact.bytes -ne $file.newBytes){throw 'ARTIFACT_TARGET_PIN_MISMATCH'}
    }
  }
  if($seenHosts.Count -ne 3 -or $targets.Count -ne 16 -or $artifacts.Count -ne 11 -or @($Plan.readOnlyConsumptionPins).Count -ne 23 -or @($Plan.configurationPins).Count -ne 7){throw 'FIXED_PLAN_SCOPE_MISMATCH'}
}
function Invoke-ExecutorReceiptCheck($Intent,$Report,[string]$Verifier=$script:ExecutorVerifier) {
  Assert-ExecutorVerifierInputs
  Assert-ExecutorPin $Verifier $script:ExecutorVerifierHash
  $payload=ConvertTo-Json -InputObject @{intent=$Intent;report=$Report} -Depth 80 -Compress -EscapeHandling EscapeNonAscii
  $output=$payload | & $script:ExecutorNode $Verifier; $exitCode=$LASTEXITCODE; $result=$output | ConvertFrom-Json
  if($exitCode -ne 0 -or $result.valid -ne $true){throw 'PREFLIGHT_NOT_VALID'}
  [ordered]@{exitCode=$exitCode;valid=$true;actionDigest=$result.actionDigest;targetDigest=$result.targetDigest}
}
function Get-ExecutorPostHashes($Plan) {
  $rows=@()
  foreach($group in @(@{kind='configuration';items=@($Plan.configurationPins)},@{kind='readonly';items=@($Plan.readOnlyConsumptionPins)},@{kind='target';items=@($Plan.hosts.files)})){
    foreach($item in $group.items){
      $path=if($group.kind -eq 'target'){$item.target}else{$item.path};$expectedBytes=if($group.kind -eq 'target'){$item.newBytes}else{$item.bytes};$expectedHash=if($group.kind -eq 'target'){$item.newSha256}else{$item.sha256}
      try{$bytes=(Get-Item -LiteralPath $path).Length;$hash=Get-ExecutorHash $path;$rows += [ordered]@{path=$path;bytes=$bytes;sha256=$hash;matches=($bytes -eq $expectedBytes -and $hash -ceq $expectedHash);kind=$group.kind}}
      catch{$rows += [ordered]@{path=$path;bytes=$null;sha256=$null;matches=$false;kind=$group.kind;error=$_.Exception.Message}}
    }
  };return $rows
}
function Invoke-R11Executor {
  if($PSVersionTable.PSVersion.Major -lt 7 -or [Environment]::Version.Major -lt 7 -or -not [string]::Equals([IO.Path]::GetFullPath([Environment]::ProcessPath),[IO.Path]::GetFullPath($script:ExecutorPowerShell),[StringComparison]::OrdinalIgnoreCase)){throw 'FIXED_POWERSHELL7_REQUIRED'}
  $context=@{startedUtc=[DateTime]::UtcNow.ToString('o');clock=[Diagnostics.Stopwatch]::StartNew();statePath=(Join-Path $script:ExecutorRoot 'execution.safe.json');applyInvocations=0}
  $lockPath=Join-Path $script:ExecutorRoot 'execution.once.lock';$lock=$null;$post=$null;$remainingObservation=$null
  if((Test-Path -LiteralPath $context.statePath) -or (Test-Path -LiteralPath $lockPath)){throw 'SINGLE_EXECUTION_PATH_COLLISION'}
  try{
    $lock=[IO.File]::Open($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $headless=Get-R07HeadlessObservation 'Helper' $script:ExecutorPowerShell (Join-Path $script:ExecutorRoot 'Launch-Headless.vbs') '99f3476f318b947900a86ff4da1a9402e2d0cbcb12de03cbf91641e4fb176222' (Join-Path $script:ExecutorRoot 'Start-Headless.ps1')
    $headlessPin=Write-R07NewJson (Join-Path $script:ExecutorRoot 'helper-headless.observation.safe.json') $headless
    $context['headlessIdentity']=@{pid=$headless.self.pid;creationUtc=$headless.self.creationUtc;parentPid=$headless.self.parentPid;observedUtc=$headless.observedUtc;observationPath=$headlessPin.path;observationSha256=$headlessPin.sha256}
    Write-ExecutorState $context 'STARTING' @{installationStarted=$false}
    Assert-ExecutorPin $IntentPath $IntentSha256;Assert-ExecutorPin $ReportPath $ReportSha256
    $body=Get-ExecutorApply;$plan=Get-Content -LiteralPath $script:ExecutorPlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-ExecutorScope $plan
    $intent=Get-Content -LiteralPath $IntentPath -Raw -Encoding UTF8 | ConvertFrom-Json -DateKind String;$report=Get-Content -LiteralPath $ReportPath -Raw -Encoding UTF8 | ConvertFrom-Json -DateKind String
    Assert-ExecutorIntent $intent $plan (Get-ExecutorAction)
    $baselinePath=Join-Path $script:ExecutorRoot 'consumer-baseline.safe.json';Assert-ExecutorPin $baselinePath $script:ExecutorBaselineHash
    $baseline=Get-Content -LiteralPath $baselinePath -Raw -Encoding UTF8 | ConvertFrom-Json;$known=@($baseline.hosts);$clearCount=0;$shutdownNoticeShown=$false
    while($true){
      if($context.clock.ElapsedMilliseconds -ge 600000){Write-ExecutorState $context 'TIMED_OUT' @{applyExitCode=$null};return 3}
      $observation=Read-ExecutorObservation $plan $known;$known=@(@($known)+@($observation.hosts) | Sort-Object executablePath -Unique)
      $decision=Get-ExecutorWaitDecision $observation $context.clock.ElapsedMilliseconds $clearCount
      if($decision -eq 'TIMED_OUT'){Write-ExecutorState $context 'TIMED_OUT' @{observation=$observation;applyExitCode=$null};return 3}
      if($decision -eq 'BLOCKED_UNKNOWN_OWNERSHIP'){$context['lastUnknown']=@{observedUtc=$observation.observedUtc;unknown=$observation.unknown;clearCountResetTo=0}}
      if($decision -eq 'READY'){break};$clearCount=if(@($observation.unknown).Count -eq 0 -and @($observation.selected).Count -eq 0 -and @($observation.hosts).Count -eq 0){$clearCount+1}else{0}
      Write-ExecutorState $context 'WAITING_SAFE_SHUTDOWN' @{observation=$observation;clearCount=$clearCount;intervalMs=2000;deadlineMs=600000}
      if($decision -eq 'WAITING_SAFE_SHUTDOWN' -and -not $shutdownNoticeShown){[Console]::WriteLine('안전 종료 대기를 확인했습니다. 선택된 앱을 정상 종료하세요. 숨김 도우미의 동일 프로세스 번호와 생성 시각 및 후속 상태를 별도 확인해야 합니다. 대기 제한은 설치기 시작부터 10분입니다.');$shutdownNoticeShown=$true}
      $remaining=600000-$context.clock.ElapsedMilliseconds;if($remaining -gt 0){Start-Sleep -Milliseconds ([int][Math]::Min(2000,$remaining))}
    }
    Assert-ExecutorPin $IntentPath $IntentSha256;Assert-ExecutorPin $ReportPath $ReportSha256;$body=Get-ExecutorApply
    $receipt=Invoke-ExecutorReceiptCheck $intent $report;$last=Read-ExecutorObservation $plan $known
    if((Get-ExecutorWaitDecision $last $context.clock.ElapsedMilliseconds 1) -ne 'READY'){throw 'SHUTDOWN_OR_DEADLINE_CHANGED_AFTER_PREFLIGHT'}
    Write-ExecutorState $context 'APPLYING' @{preflight=$receipt;intentSha256=$IntentSha256;reportSha256=$ReportSha256;applySha256=$script:ExecutorApplyHash;observation=$last}
    if($context.clock.ElapsedMilliseconds -ge 600000){Write-ExecutorState $context 'TIMED_OUT' @{applyExitCode=$null};return 3}
    $context.applyInvocations=1; & ([scriptblock]::Create($body)) | Out-Null
    $post=Get-ExecutorPostHashes $plan;$remainingObservation=Read-ExecutorObservation $plan $known
    if(@($post | Where-Object {-not $_.matches}).Count -or @($remainingObservation.selected).Count -or @($remainingObservation.hosts).Count -or @($remainingObservation.unknown).Count){throw 'POST_APPLY_HASH_OR_PROCESS_MISMATCH'}
    Write-ExecutorState $context 'DISK_APPLIED_RESTART_REQUIRED' @{applyExitCode=0;hashResults=$post;configurationCount=7;readOnlyCount=23;targetCount=16;remaining=$remainingObservation;nativeLoad='NOT_RUN';elapsedOverTenMinutes=($context.clock.ElapsedMilliseconds -ge 600000)};return 0
  }catch{
    $causes=@([ordered]@{type=$_.Exception.GetType().FullName;message=$_.Exception.Message})
    if($_.Exception -is [AggregateException]){$causes=@($_.Exception.InnerExceptions | ForEach-Object {[ordered]@{type=$_.GetType().FullName;message=$_.Message}})}
    if($context.applyInvocations){if($null -eq $post){try{$post=Get-ExecutorPostHashes $plan}catch{$causes+=@{type=$_.Exception.GetType().FullName;message=$_.Exception.Message;phase='실패 후 해시 조회'}}};if($null -eq $remainingObservation){try{$remainingObservation=Read-ExecutorObservation $plan $known}catch{$causes+=@{type=$_.Exception.GetType().FullName;message=$_.Exception.Message;phase='실패 후 잔존 조회'}}}}
    $failureState=if($context.applyInvocations){'FAILED'}else{'BLOCKED'}
    Write-ExecutorState $context $failureState @{causes=$causes;applyExitCode=if($context.applyInvocations){1}else{$null};hashResults=$post;remaining=$remainingObservation;automaticRetry=$false;additionalRestore=$false};return 1
  }finally{if($lock){$lock.Dispose()};$context.clock.Stop()}
}
if($MyInvocation.InvocationName -ne '.') { exit (Invoke-R11Executor) }

