param([string]$OutputRoot = (Join-Path $env:RUNNER_TEMP 'ac7-guard-r09-results'))
[Console]::OutputEncoding=$OutputEncoding=[Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$taskUtf8 = [Text.UTF8Encoding]::new($false)
$taskExit = 2
$taskCases = @()
$taskStarted = [DateTime]::UtcNow.ToString('o')
$taskRoot = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $taskRoot) { throw '기존 시험 근거를 보존합니다. 새 출력 경로를 사용하세요.' }
[IO.Directory]::CreateDirectory($taskRoot) | Out-Null
try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw '실제 Windows에서만 실행합니다.' }
  $taskFsutil = Get-Command fsutil.exe -CommandType Application -ErrorAction Stop
  $taskGuardPath = Join-Path $PSScriptRoot 'r09-guard-functions.ps1'
  if ((Get-FileHash -LiteralPath $taskGuardPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne '5aefe0fdfd2276fbbf4777f4a75513430d1b70ed0c5b08afc9a216c4bc3baf00') { throw '승인용 가드 추출 파일의 해시가 다릅니다.' }
  $taskTokens = $null; $taskErrors = $null
  $taskAst = [Management.Automation.Language.Parser]::ParseFile($taskGuardPath, [ref]$taskTokens, [ref]$taskErrors)
  if ($taskErrors.Count -ne 0) { throw '가드 함수 구문 오류입니다.' }
  $taskExpected = [ordered]@{
    'Assert-TaskBytes'='7ab1655d8b7874353e85742e6cd32c10a6e749af13c77b74856174752889fa3e'
    'Assert-TaskIndependentFile'='8c474a1e631e5174145be9b407dcfcdeb821aefdd8a04a229478fa47ddd31ddd'
    'Assert-TaskReadOnlyConsumption'='f3c15d93f9700377c77521854e098dd12af40dae090c68b907c1556cbe30264e'
  }
  $taskDefinitions = @($taskAst.FindAll({param($taskNode) $taskNode -is [Management.Automation.Language.FunctionDefinitionAst]}, $true))
  if ($taskDefinitions.Count -ne 3 -or $taskAst.EndBlock.Statements.Count -ne 3) { throw '정확한 가드 함수 세 개만 허용합니다.' }
  $taskFunctionPins = @()
  foreach ($taskName in $taskExpected.Keys) {
    $taskDefinition = @($taskDefinitions | Where-Object Name -CEQ $taskName)
    if ($taskDefinition.Count -ne 1) { throw '승인용 가드 함수가 누락되거나 중복됐습니다.' }
    $taskRaw = $taskUtf8.GetBytes($taskDefinition[0].Extent.Text)
    $taskHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($taskRaw)).ToLowerInvariant()
    if ($taskHash -cne $taskExpected[$taskName]) { throw ('승인용 함수 본문이 다릅니다: ' + $taskName) }
    $taskFunctionPins += [pscustomobject]@{name=$taskName; bytes=$taskRaw.Length; sha256=$taskHash}
    . ([ScriptBlock]::Create($taskDefinition[0].Extent.Text))
  }
  foreach ($taskCase in @('normal','declaration-drift','retained-runtime-drift','hook-wrapper-drift','hardlink-drift')) {
    $taskDir = Join-Path $taskRoot $taskCase
    [IO.Directory]::CreateDirectory($taskDir) | Out-Null
    $taskPins = @()
    for ($taskIndex = 0; $taskIndex -lt 23; $taskIndex++) {
      $taskKind = if ($taskIndex -lt 8) {'declaration'} elseif ($taskIndex -lt 17) {'retained-runtime'} else {'hook-wrapper'}
      $taskFile = Join-Path $taskDir ('{0:D2}-{1}.txt' -f $taskIndex,$taskKind)
      [IO.File]::WriteAllText($taskFile, ('소유 시험 파일 {0}' -f $taskIndex) + [char]10, $taskUtf8)
      $taskPins += [pscustomobject]@{kind=$taskKind;path=$taskFile;bytes=(Get-Item -LiteralPath $taskFile).Length;sha256=(Get-FileHash -LiteralPath $taskFile -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
    $taskSentinel = Join-Path $taskDir 'first-replacement-target.txt'
    $taskCandidate = Join-Path $taskDir 'first-replacement-source.txt'
    [IO.File]::WriteAllText($taskSentinel, '보존할 원본' + [char]10, $taskUtf8)
    [IO.File]::WriteAllText($taskCandidate, '소유 후보' + [char]10, $taskUtf8)
    $taskOriginal = [IO.File]::ReadAllBytes($taskSentinel)
    $taskOriginalHash = (Get-FileHash -LiteralPath $taskSentinel -Algorithm SHA256).Hash.ToLowerInvariant()
    $taskInjected = $null
    switch ($taskCase) {
      'declaration-drift' { $taskInjected=$taskPins[1].path }
      'retained-runtime-drift' { $taskInjected=$taskPins[8].path }
      'hook-wrapper-drift' { $taskInjected=$taskPins[17].path }
    }
    if ($taskInjected) { [IO.File]::AppendAllText($taskInjected, '준비 후 사용자 변경' + [char]10, $taskUtf8) }
    $taskLinkExit = $null
    if ($taskCase -eq 'hardlink-drift') {
      $taskLinkOutput = @(& $taskFsutil.Source hardlink create (Join-Path $taskDir 'owned-hardlink-alias.txt') $taskPins[22].path 2>&1)
      $taskLinkExit = $LASTEXITCODE
      [IO.File]::WriteAllText((Join-Path $taskDir 'hardlink-create.raw.txt'), ($taskLinkOutput -join [char]10) + [char]10, $taskUtf8)
    }
    $taskBefore = @($taskPins | ForEach-Object {[pscustomobject]@{path=$_.path;sha256=(Get-FileHash -LiteralPath $_.path -Algorithm SHA256).Hash.ToLowerInvariant()}})
    $taskGuardError = $null; $taskCopyAttempted = $false
    if ($taskCase -ne 'hardlink-drift' -or $taskLinkExit -eq 0) {
      try {
        Assert-TaskReadOnlyConsumption $taskPins
        $taskCopyAttempted = $true
        Copy-Item -LiteralPath $taskCandidate -Destination $taskSentinel -Force
      } catch { $taskGuardError = $_.Exception.Message }
    }
    $taskSentinelAfter = (Get-FileHash -LiteralPath $taskSentinel -Algorithm SHA256).Hash.ToLowerInvariant()
    $taskAfter = @($taskBefore | ForEach-Object {[pscustomobject]@{path=$_.path;sha256=(Get-FileHash -LiteralPath $_.path -Algorithm SHA256).Hash.ToLowerInvariant()}})
    $taskInputsPreserved = $true
    for ($taskIndex=0; $taskIndex -lt $taskBefore.Count; $taskIndex++) {if ($taskBefore[$taskIndex].sha256 -cne $taskAfter[$taskIndex].sha256) {$taskInputsPreserved=$false}}
    $taskExpectedError = if ($taskCase -eq 'hardlink-drift') {'대상 파일이 독립적인 단일 링크인지 확인하지 못했습니다.'} elseif ($taskInjected) {'파일 바이트가 일치하지 않습니다: ' + $taskInjected} else {$null}
    $taskPassed = if ($taskCase -eq 'normal') {
      $null -eq $taskGuardError -and $taskCopyAttempted -and $taskSentinelAfter -ceq (Get-FileHash -LiteralPath $taskCandidate -Algorithm SHA256).Hash.ToLowerInvariant() -and $taskInputsPreserved
    } else {
      $taskGuardError -ceq $taskExpectedError -and -not $taskCopyAttempted -and $taskSentinelAfter -ceq $taskOriginalHash -and $taskInputsPreserved
    }
    $taskStatus = if ($taskCase -eq 'hardlink-drift' -and $taskLinkExit -ne 0) {'NOT_RUN'} elseif ($taskPassed) {'PASS'} else {'FAIL'}
    $taskNormalRestored = $null
    if ($taskCase -eq 'normal') {
      [IO.File]::WriteAllBytes($taskSentinel, $taskOriginal)
      $taskNormalRestored = (Get-FileHash -LiteralPath $taskSentinel -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $taskOriginalHash
      if (-not $taskNormalRestored) {$taskStatus='FAIL'}
    }
    $taskRow = [ordered]@{id=$taskCase;status=$taskStatus;preparedPins=$taskPins;beforeGuard=$taskBefore;afterGuard=$taskAfter;actualGuardError=$taskGuardError;expectedGuardError=$taskExpectedError;firstReplacementAttempted=$taskCopyAttempted;originalSentinelSHA256=$taskOriginalHash;afterGuardSentinelSHA256=$taskSentinelAfter;allInjectedInputBytesPreserved=$taskInputsPreserved;normalHarnessRestore=$taskNormalRestored;hardlinkCreateExit=$taskLinkExit}
    [IO.File]::WriteAllText((Join-Path $taskDir 'RESULT.safe.json'), (ConvertTo-Json -InputObject $taskRow -Depth 12) + [char]10, $taskUtf8)
    $taskCases += $taskRow
    Write-Output ('{0}: {1}' -f $taskCase,$taskStatus)
  }
  $taskExit = if (@($taskCases | Where-Object status -NE 'PASS').Count -eq 0) {0} else {1}
} catch {
  $taskFatal = $_.Exception.Message
  Write-Error -Message $taskFatal -ErrorAction Continue
} finally {
  $taskResult = [ordered]@{schema='AC7-r09-격리파일가드시험.v1';candidateCommit='15c8f9139167a27f5046421a2f56b5c952eb725f';sourceCommandSHA256='ca1ff8c5b3c4ac11c9ffc2dcf6de85181dad09a5e6d754fa6bf2e38ef8fcd1e3';sourceManifestSHA256='7d048205ee2078dcc42467958e8f7aa9e64f25dab68569ff3606593da001a535';functionPins=$taskFunctionPins;startedUTC=$taskStarted;finishedUTC=[DateTime]::UtcNow.ToString('o');powershellVersion=$PSVersionTable.PSVersion.ToString();platform=[Environment]::OSVersion.Platform.ToString();fsutilPath=$taskFsutil.Source;cases=$taskCases;exit=$taskExit;fatalError=$taskFatal;scope='승인용 원함수의 파일가드 경계만 시험. 실제 설치·전역 설정·운영 DB·기존 프로세스 종료 없음.';limits=@('실제 APPLY 전체와 47개 교체·복구 절차는 실행하지 않음','가드 세 호출 위치의 정적 확인과 각 위치의 동적 개입은 구분함','정상 사례의 원본 복원은 소유 sentinel 정리이며 제품 Restore-TaskChanged 검증이 아님','하드링크 생성 불가 시 NOT_RUN이며 전체 종료 1로 미충족 보존')}
  [IO.File]::WriteAllText((Join-Path $taskRoot 'RESULT.safe.json'), (ConvertTo-Json -InputObject $taskResult -Depth 16) + [char]10, $taskUtf8)
}
exit $taskExit
