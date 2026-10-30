param()
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=$OutputEncoding=[Text.UTF8Encoding]::new($false)
$root='D:/codex/개발자/work/d0352-isolated-install-r01/executor-r01'
if(-not [string]::Equals([IO.Path]::GetFullPath($PSScriptRoot),[IO.Path]::GetFullPath($root),[StringComparison]::OrdinalIgnoreCase)){throw 'HEADLESS_COPIED_ROOT_REJECTED'}
$fixedNode='C:/Program Files/nodejs/node.exe'
$fixedPowerShell='C:/Users/Lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe'
$preparePath=Join-Path $root 'Prepare-R04Current-r02.mjs'
$helperPath=Join-Path $root 'Invoke-R11Once.ps1'
$guardPath=Join-Path $root 'Headless-Guard.ps1'
$launcherPath=Join-Path $root 'Launch-Headless.vbs'
$inputPath=Join-Path $root 'HEADLESS-INPUT.safe.json'
$prepareSha256='3fbf21cd88377e65d251bbe75877f7e02ea4d361914a417365a6161d21263723'
$helperSha256='1d4b0acc6153e165f72a67275ca00873adc873c4911c6bb593d3b902b4e18f2c'
$guardSha256='c7dd13e400024e0cd641c8c83be07183ea4849945bbff50d2fe921379f2f07b0'
$launcherSha256='99f3476f318b947900a86ff4da1a9402e2d0cbcb12de03cbf91641e4fb176222'
function Save-R07StartRecord([string]$Path,$Value) {
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 70).Replace([string][char]13,'')+[char]10)
 $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
 [ordered]@{path=$Path;bytes=$bytes.Length;sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()}
}
function Assert-R07StartPin([string]$Path,[string]$Hash) {
 if($Hash -cnotmatch '^[a-f0-9]{64}$' -or -not (Test-Path -LiteralPath $Path -PathType Leaf) -or (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hash){throw 'HEADLESS_FIXED_INPUT_PIN_MISMATCH'}
}
function Invoke-R07HiddenChild([string]$Executable,[string[]]$Arguments,[string]$Name) {
 $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$Executable
 $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
 $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
 $info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false);$info.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
 foreach($argument in $Arguments){$info.ArgumentList.Add($argument)}
 $process=[Diagnostics.Process]::new();$process.StartInfo=$info
 $started=$false;$outTask=$null;$errTask=$null;$stdout='';$stderr='';$exitCode=$null;$childIdentity=$null;$identityError=$null;$errors=[Collections.Generic.List[object]]::new()
 $startedUtc=[DateTime]::UtcNow.ToString('o');$childPid=$null
 try{
  if(-not $process.Start()){throw 'HEADLESS_CHILD_START_RETURNED_FALSE'}
  $started=$true;$childPid=$process.Id
  $outTask=$process.StandardOutput.ReadToEndAsync();$errTask=$process.StandardError.ReadToEndAsync()
  try{$childIdentity=[R07HeadlessNative]::Identity([uint32]$childPid)}catch{$identityError=$_.Exception.GetType().FullName}
  $process.WaitForExit();$exitCode=$process.ExitCode
 }catch{$errors.Add(@{phase='start-or-wait';type=$_.Exception.GetType().FullName;message=$_.Exception.Message})}
 finally{
  try{if($outTask){$stdout=$outTask.GetAwaiter().GetResult()}}catch{$errors.Add(@{phase='stdout-drain';type=$_.Exception.GetType().FullName;message=$_.Exception.Message})}
  try{if($errTask){$stderr=$errTask.GetAwaiter().GetResult()}}catch{$errors.Add(@{phase='stderr-drain';type=$_.Exception.GetType().FullName;message=$_.Exception.Message})}
  $process.Dispose()
 }
 $stdoutPin=Write-R07NewBytes (Join-Path $root ($Name+'.stdout.bin')) ([Text.UTF8Encoding]::new($false).GetBytes($stdout))
 $stderrPin=Write-R07NewBytes (Join-Path $root ($Name+'.stderr.bin')) ([Text.UTF8Encoding]::new($false).GetBytes($stderr))
 $record=[ordered]@{schemaVersion='R07HiddenChildResult.v1';name=$Name;executable=$Executable;startedUtc=$startedUtc;finishedUtc=[DateTime]::UtcNow.ToString('o');started=$started;pid=$childPid;identity=$childIdentity;identityObservationError=$identityError;creationApi='System.Diagnostics.Process.Start';useShellExecute=$info.UseShellExecute;createNoWindow=$info.CreateNoWindow;windowStyle=$info.WindowStyle.ToString();argumentTransport='ArgumentList';rawArgumentsStored=$false;stdout=$stdoutPin;stderr=$stderrPin;exitCode=$exitCode;errors=@($errors.ToArray());waitPolicy='WaitForExit 후 양 스트림 비동기 읽기 완료. 부모 대기에는 별도 시간상한 없음. helper 600초 검증의 대체 아님.';allDescendantWindowsVerified=$false}
 $null=Save-R07StartRecord (Join-Path $root ($Name+'.result.safe.json')) $record
 if($errors.Count){throw 'HEADLESS_CHILD_START_WAIT_OR_DRAIN_FAILED'}
 return $record
}
$lock=$null;$ownsStart=$false;$startExitCode=1;$phase='START_GUARD';$errorRecord=$null
$observationPin=$null;$inputPin=$null;$selfPin=$null;$prepareResult=$null;$helperResult=$null;$helperStartAttempts=0;$executionPin=$null
$startedUtc=[DateTime]::UtcNow.ToString('o')
try{
 $lock=[IO.File]::Open((Join-Path $root 'start-headless.once.lock'),[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$ownsStart=$true
 if($PSVersionTable.PSVersion.Major -lt 7 -or -not [string]::Equals([IO.Path]::GetFullPath([Environment]::ProcessPath),[IO.Path]::GetFullPath($fixedPowerShell),[StringComparison]::OrdinalIgnoreCase)){throw 'HEADLESS_FIXED_POWERSHELL7_REQUIRED'}
 foreach($pin in @(
  @{path=$fixedNode;sha256='3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237'},
  @{path=$fixedPowerShell;sha256='362a356ce7f0940ec74f73a8fc2c990a2cc24a38a11c90bbd8eca947110ad139'},
  @{path=$preparePath;sha256=$prepareSha256},@{path=$helperPath;sha256=$helperSha256},
  @{path=$guardPath;sha256=$guardSha256},@{path=$launcherPath;sha256=$launcherSha256}
 )){Assert-R07StartPin $pin.path $pin.sha256}
 . $guardPath
 $observation=Get-R07HeadlessObservation 'Start' $fixedPowerShell $launcherPath $launcherSha256 $PSCommandPath
 $observationPin=Save-R07StartRecord (Join-Path $root 'start-headless.observation.safe.json') $observation
 $final=Get-Content -LiteralPath (Join-Path $root 'FINAL-BINDING.safe.json') -Raw -Encoding UTF8 | ConvertFrom-Json -DateKind String
 Assert-R07SamePath $final.wrapper.path $PSCommandPath;Assert-R07StartPin $PSCommandPath $final.wrapper.sha256
 $selfPin=@{path=$PSCommandPath;sha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()}
 foreach($name in @('execution.safe.json','execution.once.lock','external-console-start.safe.json','external-console-result.safe.json','PREFLIGHT-INTENT.safe.json','PREFLIGHT-REPORT.safe.json','PREPARATION-STATUS.safe.json','LAUNCH.safe.json','CURRENT-STATE.safe.json','CURRENT-OBSERVATION.safe.json','PREPARATION-BINDING.safe.json','SOURCE-ARCHIVE-CHECK.safe.json','helper-headless.observation.safe.json')){
  if(Test-Path -LiteralPath (Join-Path $root $name)){throw ('HEADLESS_SINGLE_EXECUTION_PATH_COLLISION: '+$name)}
 }
 if(-not (Test-Path -LiteralPath (Join-Path $root 'launch-headless.once.json') -PathType Leaf)){throw 'HEADLESS_USER_LAUNCH_MARKER_MISSING'}
 $inputBytes=[IO.File]::ReadAllBytes($inputPath)
 $freshInput=([Text.UTF8Encoding]::new($false,$true).GetString($inputBytes)) | ConvertFrom-Json -DateKind String
 $keys=@($freshInput.PSObject.Properties.Name | Sort-Object)
 if(($keys -join '|') -cne 'IntentPath|IntentSha256|ReportPath|ReportSha256'){throw 'HEADLESS_EXACT_FOUR_FRESH_INPUT_FIELDS_REQUIRED'}
 $inputPin=@{path=$inputPath;bytes=$inputBytes.Length;sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($inputBytes)).ToLowerInvariant()}
 foreach($entry in @(@{path=$freshInput.IntentPath;sha256=$freshInput.IntentSha256},@{path=$freshInput.ReportPath;sha256=$freshInput.ReportSha256})){
  if(-not [IO.Path]::IsPathFullyQualified($entry.path)){throw 'FRESH_16_PREFLIGHT_ABSOLUTE_PATH_REQUIRED'}
  Assert-R07StartPin $entry.path $entry.sha256
 }
 $null=Save-R07StartRecord (Join-Path $root 'start-headless.safe.json') ([ordered]@{schemaVersion='R07UserHeadlessStart.v1';startedUtc=$startedUtc;mode='USER_EXPLORER_WSCRIPT_HEADLESS';self=$selfPin;observation=$observationPin;launcherPath=$launcherPath;actualLauncherSha256=$observation.actualLauncherSha256;input=$inputPin;prepareSha256=$prepareSha256;helperSha256=$helperSha256;requestedWScriptWindowStyle=0;startupUseShowWindow=$observation.startupUseShowWindow;startupShowWindow=$observation.startupShowWindow;automaticRetry=$false;parentAppExitSurvival='NOT_OBSERVED'})
 $phase='PREPARATION'
 $prepareResult=Invoke-R07HiddenChild $fixedNode @($preparePath,'--intent-file',[string]$freshInput.IntentPath,'--intent-sha256',[string]$freshInput.IntentSha256,'--report-file',[string]$freshInput.ReportPath,'--report-sha256',[string]$freshInput.ReportSha256) 'headless-prepare'
 if($prepareResult.exitCode -ne 0){throw 'HEADLESS_PREPARATION_FAILED'}
 $prepared=Get-Content -LiteralPath (Join-Path $root 'PREPARATION-STATUS.safe.json') -Raw -Encoding UTF8 | ConvertFrom-Json -DateKind String
 if($prepared.status -cne 'READY' -or $prepared.valid -ne $true -or $prepared.originalVerifierExitCode -ne 0 -or $prepared.helperSha256 -cne $helperSha256){throw 'HEADLESS_PREPARATION_NOT_READY'}
 $reportObject=Get-Content -LiteralPath (Join-Path $root 'PREFLIGHT-REPORT.safe.json') -Raw -Encoding UTF8 | ConvertFrom-Json -DateKind String
 if($reportObject.verdict -cne 'READY' -or [DateTimeOffset]::Parse($reportObject.validUntil) -le [DateTimeOffset]::UtcNow){throw 'HEADLESS_PREFLIGHT_NOT_CURRENT_READY'}
 Assert-R07StartPin $inputPath $inputPin.sha256
 Assert-R07StartPin (Join-Path $root 'PREFLIGHT-INTENT.safe.json') ([string]$freshInput.IntentSha256)
 Assert-R07StartPin (Join-Path $root 'PREFLIGHT-REPORT.safe.json') ([string]$freshInput.ReportSha256)
 Assert-R07StartPin $helperPath $helperSha256
 $phase='HELPER';$helperStartAttempts=1
 $helperResult=Invoke-R07HiddenChild $fixedPowerShell @('-NoLogo','-NoProfile','-NonInteractive','-File',$helperPath,'-IntentPath',(Join-Path $root 'PREFLIGHT-INTENT.safe.json'),'-ReportPath',(Join-Path $root 'PREFLIGHT-REPORT.safe.json'),'-IntentSha256',[string]$freshInput.IntentSha256,'-ReportSha256',[string]$freshInput.ReportSha256) 'headless-helper'
 $statePath=Join-Path $root 'execution.safe.json'
 if(Test-Path -LiteralPath $statePath -PathType Leaf){$executionPin=@{path=$statePath;bytes=(Get-Item -LiteralPath $statePath).Length;sha256=(Get-FileHash -LiteralPath $statePath -Algorithm SHA256).Hash.ToLowerInvariant()}}
 $startExitCode=[int]$helperResult.exitCode
}catch{
 $errorRecord=@{phase=$phase;type=$_.Exception.GetType().FullName;message=$_.Exception.Message};$startExitCode=1
}finally{
 try{
  if($ownsStart){
   $null=Save-R07StartRecord (Join-Path $root 'headless-result.safe.json') ([ordered]@{schemaVersion='R07UserHeadlessResult.v1';startedUtc=$startedUtc;finishedUtc=[DateTime]::UtcNow.ToString('o');phase=$phase;self=$selfPin;nativeObservation=$observationPin;lastNativeObservation=$script:R07LastNativeObservation;freshInput=$inputPin;prepare=$prepareResult;helper=$helperResult;helperStartAttempts=$helperStartAttempts;executionState=$executionPin;error=$errorRecord;exitCode=$startExitCode;automaticRetry=$false;jobBreakawayRequested=$false;parentAppExitSurvival='NOT_OBSERVED';nativeLoad='NOT_RUN';allDescendantWindowsVerified=$false;helperReturnedIsInstallationCompletion=$false})
  }
 }catch{$startExitCode=1;[Console]::Error.WriteLine('HEADLESS_RESULT_RECORD_FAILED')}
 finally{if($lock){$lock.Dispose()}}
}
exit $startExitCode
