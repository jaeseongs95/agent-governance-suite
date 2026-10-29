param([Parameter(Mandatory)][string]$SourceRoot,[Parameter(Mandatory)][string]$OutputRoot)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=$OutputEncoding=[Text.UTF8Encoding]::new($false)
$runtime=[ordered]@{version=$PSVersionTable.PSVersion.ToString();path=[Environment]::ProcessPath;sha256=(Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath ([Environment]::ProcessPath) -Algorithm SHA256).Hash.ToLowerInvariant();os=[Environment]::OSVersion.ToString();framework=[Runtime.InteropServices.RuntimeInformation]::FrameworkDescription}
$missingApi=@()
if(-not @([Security.Cryptography.SHA256].GetMethods() | Where-Object {$_.Name -eq 'HashData' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType -eq [IO.Stream]}).Count){$missingApi+='SHA256.HashData(Stream)'}
if(-not @([Convert].GetMethods() | Where-Object Name -eq 'ToHexString').Count){$missingApi+='Convert.ToHexString'}
if($missingApi.Count){
  $unsupported=[ordered]@{status='UNSUPPORTED';runtime=$runtime;missingApi=$missingApi;actualPrepare=0;productApply=0;reason='제품 함수가 실제 사용하는 .NET API 부재. F1은 별도로 계속 실행한다.'}
  $unsupported|ConvertTo-Json -Depth 10 -Compress
  exit 2
}
$document=Get-Content -LiteralPath (Join-Path $SourceRoot 'AFTER-AUTHORIZATION-COMMANDS.txt') -Raw -Encoding UTF8
$apply=[regex]::Match($document,'(?s)# BEGIN APPLY POWERSHELL\r?\n(.*?)# END APPLY POWERSHELL').Groups[1].Value
$restore=[regex]::Match($document,'(?s)# BEGIN RESTORE POWERSHELL\r?\n(.*?)# END RESTORE POWERSHELL').Groups[1].Value
$tokens=$null;$errors=$null
$applyAst=[Management.Automation.Language.Parser]::ParseInput($apply,[ref]$tokens,[ref]$errors)
if($errors.Count){throw '실제 APPLY 구문 오류'}
$restoreAst=[Management.Automation.Language.Parser]::ParseInput($restore,[ref]$tokens,[ref]$errors)
if($errors.Count){throw '실제 RESTORE 구문 오류'}
$definitions=@();$functionPins=@()
foreach($name in @('Assert-TaskBytes','Assert-TaskIndependentFile','Write-TaskLedger','Get-TaskStreamHash','Restore-TaskChanged','Update-TaskWriteObservation','Write-TaskCandidate')){
  $found=@($applyAst.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
  if($found.Count -eq 0 -and $name -in @('Get-TaskStreamHash','Update-TaskWriteObservation','Write-TaskCandidate')){continue}
  if($found.Count -ne 1){throw ('실제 함수 경계 불일치: '+$name)}
  $definitions+=$found[0].Extent.Text
  $functionPins+=@{name=$name;sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($found[0].Extent.Text))).ToLowerInvariant()}
  if($name -notin @('Update-TaskWriteObservation','Write-TaskCandidate')){
    $other=@($restoreAst.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
    if($other.Count -ne 1 -or $other[0].Extent.Text -cne $found[0].Extent.Text){throw ('APPLY/RESTORE 함수 차이: '+$name)}
  }
}
. ([scriptblock]::Create($definitions -join [char]10))
$capabilityCases=@()
if(-not $IsWindows -or -not (Get-Command fsutil -CommandType Application -ErrorAction SilentlyContinue)){throw 'Windows fsutil 실제 독립파일검사가 필요합니다'}
if(Test-Path -LiteralPath $OutputRoot){throw '새 출력루트가 필요합니다'}
# 원 적용 루프의 복사→직후 관측→후속 검증 구간을 그대로 사용한다.
$copyStart=$apply.IndexOf('    $taskRow.Attempted = $true')
$originalCheck=$apply.LastIndexOf('    Assert-TaskBytes $taskRow.Target $taskRow.OldBytes $taskRow.OldHash',$copyStart)
if($originalCheck -ge 0){$copyStart=$originalCheck}
$copyEndText='    Assert-TaskBytes $taskRow.Target $taskRow.NewBytes $taskRow.NewHash'
$copyEnd=$apply.IndexOf($copyEndText,$copyStart)+$copyEndText.Length
if($copyStart -lt 0 -or $copyEnd -le $copyStart){throw '실제 복사 구간 경계 불일치'}
$copyBlock=[scriptblock]::Create($apply.Substring($copyStart,$copyEnd-$copyStart))
$script:cases=[Collections.Generic.List[object]]::new()
$script:copyInjection=$false;$script:partialCopyFailure=$false;$script:raceEnabled=$false;$script:raceTriggered=$false;$script:raceBlocked=$false;$script:preLockInjection=$false;$script:preLockInjected=$false;$script:preLockCandidate=$false;$script:applyRaceEnabled=$false;$script:applyRaceTriggered=$false;$script:applyRaceBlocked=$false
function Hash-File([string]$Path){(Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Write-Fixture([string]$Path,[string]$Text){[IO.File]::WriteAllText($Path,$Text,[Text.UTF8Encoding]::new($false))}
function Assert-Test($Value,[string]$Message){if(-not $Value){throw $Message}}
function New-CaseFiles([string]$Name){
  $directory=Join-Path $OutputRoot $Name;[IO.Directory]::CreateDirectory($directory)|Out-Null
  $target=Join-Path $directory 'target.txt';$backup=Join-Path $directory 'original.backup';$source=Join-Path $directory 'candidate.txt'
  Write-Fixture $target '원본';Write-Fixture $backup '원본';Write-Fixture $source '알려진 후보'
  $script:taskRow=[pscustomobject]@{Target=$target;Backup=$backup;Source=$source;OldBytes=(Get-Item -LiteralPath $backup).Length;OldHash=(Hash-File $backup);NewBytes=(Get-Item -LiteralPath $source).Length;NewHash=(Hash-File $source);Attempted=$false;Changed=$false;LastWrittenHash=$null;Restored=$false}
  $script:taskLedger=@($script:taskRow);$script:taskLedgerPath=Join-Path $directory 'ledger.safe.json'
  $script:copyInjection=$false;$script:partialCopyFailure=$false;$script:raceEnabled=$false;$script:raceTriggered=$false;$script:raceBlocked=$false;$script:preLockInjection=$false;$script:preLockInjected=$false;$script:preLockCandidate=$false;$script:applyRaceEnabled=$false;$script:applyRaceTriggered=$false;$script:applyRaceBlocked=$false
}
function Copy-Item {
  param([string]$LiteralPath,[string]$Destination,[switch]$Force)
  Microsoft.PowerShell.Management\Copy-Item @PSBoundParameters
  if($LiteralPath -ceq $script:taskRow.Source){
    if($script:copyInjection){Write-Fixture $Destination '복사 직후 사용자 저장'}
    if($script:partialCopyFailure){Write-Fixture $Destination '부분 쓰기';throw '주입한 복사 실패'}
  }
}
function Get-FileHash {
  param([string]$LiteralPath,[string]$Algorithm)
  $result=Microsoft.PowerShell.Utility\Get-FileHash @PSBoundParameters
  if($LiteralPath -ceq $script:taskRow.Target -and $script:preLockInjection -and -not $script:preLockInjected){$script:preLockInjected=$true;Write-Fixture $LiteralPath '잠금 전 사용자 저장'}
  if($LiteralPath -ceq $script:taskRow.Target -and $script:applyRaceEnabled -and -not $script:applyRaceTriggered){
    $script:applyRaceTriggered=$true
    try{Write-Fixture $LiteralPath '원본 검증 직후 사용자 저장'}catch{if($_.Exception.GetBaseException() -is [IO.IOException]){$script:applyRaceBlocked=$true}else{throw}}
  }
  if($script:raceEnabled -and -not $script:raceTriggered -and $LiteralPath -ceq $script:taskRow.Target){
    $script:raceTriggered=$true;Write-Fixture $LiteralPath '복구 검사 직후 사용자 저장'
  }
  $result
}
$streamDefinition=Get-Command Get-TaskStreamHash -ErrorAction SilentlyContinue
if($streamDefinition){
  $script:realStreamHash=$streamDefinition.ScriptBlock
  function Get-TaskStreamHash($taskStream){
    $hash=& $script:realStreamHash $taskStream
    if($script:applyRaceEnabled -and -not $script:applyRaceTriggered -and $taskStream.Name -ceq $script:taskRow.Target){
      $script:applyRaceTriggered=$true
      try{Write-Fixture $taskStream.Name '원본 검증 직후 사용자 저장'}catch{if($_.Exception.GetBaseException() -is [IO.IOException]){$script:applyRaceBlocked=$true}else{throw}}
    }
    if($script:raceEnabled -and -not $script:raceTriggered -and $taskStream.Name -ceq $script:taskRow.Target){
      $script:raceTriggered=$true
      try{Write-Fixture $taskStream.Name '복구 검사 직후 사용자 저장'}catch{if($_.Exception.GetBaseException() -is [IO.IOException]){$script:raceBlocked=$true}else{throw}}
    }
    $hash
  }
}
# 실제 파일 검증·교체 함수는 추출한 원문을 호출한다. 주입은 잠금 전·해제 후 경계에만 둔다.
$script:realIndependentGuard=(Get-Command Assert-TaskIndependentFile).ScriptBlock
function Assert-TaskIndependentFile($taskPath){
  & $script:realIndependentGuard $taskPath
  if($script:preLockInjection -and -not $script:preLockInjected -and $taskPath -ceq $script:taskRow.Target){$script:preLockInjected=$true;if($script:preLockCandidate){[IO.File]::WriteAllBytes($taskPath,[IO.File]::ReadAllBytes($script:taskRow.Source))}else{Write-Fixture $taskPath '잠금 전 사용자 저장'}}
}
$candidateDefinition=Get-Command Write-TaskCandidate -ErrorAction SilentlyContinue
if($candidateDefinition){
  $script:realCandidateWrite=$candidateDefinition.ScriptBlock
  function Write-TaskCandidate($taskEntry){
    & $script:realCandidateWrite $taskEntry
    if($script:copyInjection){Write-Fixture $taskEntry.Target '복사 직후 사용자 저장'}
    if($script:partialCopyFailure){Write-Fixture $taskEntry.Target '부분 쓰기';throw '주입한 복사 실패'}
  }
}
function Test-Case([string]$Name,[scriptblock]$Body){
  $errorText=$null;$state=$null
  try{New-CaseFiles $Name;& $Body;$status='PASS'}catch{$status='FAIL';$errorText=$_.Exception.ToString()}
  if($script:taskRow){$state=@{entry=$script:taskRow;targetHash=(Hash-File $script:taskRow.Target);backupHash=(Hash-File $script:taskRow.Backup);raceTriggered=$script:raceTriggered;raceWriteBlocked=$script:raceBlocked;preLockInjected=$script:preLockInjected;applyRaceTriggered=$script:applyRaceTriggered;applyRaceBlocked=$script:applyRaceBlocked}}
  $script:cases.Add([ordered]@{caseId=$Name;status=$status;error=$errorText;state=$state;productApply=0})
}
Test-Case 'F2_복사성공_관측전_사용자쓰기보존' {
  $script:copyInjection=$true;$copyError=$null;$restoreError=$null
  try{& $copyBlock}catch{$copyError=$_.Exception.Message}
  $userHash=Hash-File $taskRow.Target
  try{Restore-TaskChanged @($taskRow)}catch{$restoreError=$_.Exception.Message}
  Assert-Test ($copyError -and $restoreError -and -not $taskRow.Restored -and (Hash-File $taskRow.Target) -ceq $userHash -and (Hash-File $taskRow.Backup) -ceq $taskRow.OldHash) '복사 직후 사용자 바이트가 복구로 덮였거나 명시 중단이 없음'
}
Test-Case 'F2_이번후보쓰기_정상자기복구' {
  & $copyBlock
  Assert-Test ($taskRow.LastWrittenHash -ceq $taskRow.NewHash) '알려진 후보 소유 해시 아님'
  Restore-TaskChanged @($taskRow)
  Assert-Test ($taskRow.Restored -and (Hash-File $taskRow.Target) -ceq $taskRow.OldHash -and (Hash-File $taskRow.Backup) -ceq $taskRow.OldHash) '이번 후보 쓰기 복구 실패'
}
Test-Case 'F2_관측후_사용자변경보존' {
  & $copyBlock;Write-Fixture $taskRow.Target '관측 이후 사용자 저장';$userHash=Hash-File $taskRow.Target;$caught=$false
  try{Restore-TaskChanged @($taskRow)}catch{$caught=$true}
  Assert-Test ($caught -and -not $taskRow.Restored -and (Hash-File $taskRow.Target) -ceq $userHash) '관측 후 사용자 바이트가 덮임'
}
Test-Case 'F2_복구검사쓰기_같은배타핸들' {
  & $copyBlock;$script:raceEnabled=$true
  Restore-TaskChanged @($taskRow)
  Assert-Test ($script:raceTriggered -and $script:raceBlocked -and $taskRow.Restored -and (Hash-File $taskRow.Target) -ceq $taskRow.OldHash) '복구 검사와 쓰기 사이 별도 쓰기가 차단되지 않음'
}
Test-Case 'F2_불명부분쓰기_보존과두오류' {
  $script:partialCopyFailure=$true;$copyException=$null;$restoreError=$null
  try{& $copyBlock}catch{$copyException=$_.Exception}
  $partialHash=Hash-File $taskRow.Target
  try{Restore-TaskChanged @($taskRow)}catch{$restoreError=$_.Exception.Message}
  Assert-Test ($copyException -is [AggregateException] -and $copyException.InnerExceptions.Count -eq 2 -and $restoreError -and (Hash-File $taskRow.Target) -ceq $partialHash -and (Hash-File $taskRow.Backup) -ceq $taskRow.OldHash) '불명 부분쓰기 또는 두 원오류를 보존하지 않음'
}
Test-Case 'F2_Changed아닌파일_복구제외' {
  Write-Fixture $taskRow.Target '이번 쓰기 아닌 사용자 파일';$userHash=Hash-File $taskRow.Target
  Restore-TaskChanged @($taskRow)
  Assert-Test (-not $taskRow.Restored -and (Hash-File $taskRow.Target) -ceq $userHash) 'Changed 아닌 파일을 복구함'
}
Test-Case 'F2_잠금전_원본변경거부와보존' {
  $script:preLockInjection=$true;$copyError=$null;$restoreError=$null
  try{& $copyBlock}catch{$copyError=$_.Exception.Message}
  $userHash=Hash-File $taskRow.Target
  try{Restore-TaskChanged @($taskRow)}catch{$restoreError=$_.Exception.Message}
  Assert-Test ($script:preLockInjected -and $copyError -and $restoreError -and -not $taskRow.Restored -and (Hash-File $taskRow.Target) -ceq $userHash -and (Hash-File $taskRow.Backup) -ceq $taskRow.OldHash) '잠금 전에 바뀐 원본을 덮었거나 사용자 변경을 복구로 덮음'
}
Test-Case 'F2_원본검증과교체_같은배타핸들' {
  $script:applyRaceEnabled=$true
  & $copyBlock
  Assert-Test ($script:applyRaceTriggered -and $script:applyRaceBlocked -and (Hash-File $taskRow.Target) -ceq $taskRow.NewHash -and $taskRow.LastWrittenHash -ceq $taskRow.NewHash) '원본 검증 뒤 교체 전에 별도 쓰기가 차단되지 않음'
}
Test-Case 'F2_잠금전_동일후보경쟁쓰기_소유오인복구금지' {
  $script:preLockInjection=$true;$script:preLockCandidate=$true;$copyError=$null;$restoreError=$null
  try{& $copyBlock}catch{$copyError=$_.Exception.Message}
  $competitorHash=Hash-File $taskRow.Target
  try{Restore-TaskChanged @($taskLedger | Where-Object Changed)}catch{$restoreError=$_.Exception.Message}
  Assert-Test ($script:preLockInjected -and $copyError -and $competitorHash -ceq $taskRow.NewHash -and -not $taskRow.LastWrittenHash -and -not $taskRow.Restored -and (Hash-File $taskRow.Target) -ceq $competitorHash -and (Hash-File $taskRow.Backup) -ceq $taskRow.OldHash) '본인 쓰기 전 경쟁자가 쓴 동일 후보 바이트를 소유로 오인해 복구함'
}
$result=[ordered]@{schemaVersion='Fixed856OwnedWriteTests.v1';status=if(@($cases | Where-Object status -eq 'FAIL').Count){'FAIL'}else{'PASS'};runtime=$runtime;capabilityCases=$capabilityCases;windowsProductionValidation='NOT_RUN';sourceRoot=$SourceRoot;commandSha256=(Hash-File (Join-Path $SourceRoot 'AFTER-AUTHORIZATION-COMMANDS.txt'));functions=$functionPins;cases=@($cases.ToArray());actualPrepare=0;actualReceiptIssues=0;helperMain=0;productApply=0;actual104Restore='NOT_RUN';fixtureScope=$OutputRoot}
$text=($result|ConvertTo-Json -Depth 30).Replace([string][char]13,'')+[char]10
$stream=[IO.File]::Open((Join-Path $OutputRoot 'f2-result.safe.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes($text);$stream.Write($bytes)}finally{$stream.Dispose()}
$result|ConvertTo-Json -Depth 30 -Compress
if($result.status -ne 'PASS'){exit 1}
