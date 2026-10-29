param([Parameter(Mandatory)][string]$OutputRoot)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=$OutputEncoding=[Text.UTF8Encoding]::new($false)
if(-not $IsWindows -or -not (Get-Command fsutil -CommandType Application -ErrorAction SilentlyContinue)){throw 'Windows fsutil 필요'}
if(Test-Path -LiteralPath $OutputRoot){throw '새 출력루트 필요'}
$pin=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'PROVENANCE.json') -Raw -Encoding UTF8|ConvertFrom-Json
function Hash([string]$Path){(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
$test=Join-Path $PSScriptRoot 'Test-R11Executor-F1F2.ps1'
if((Hash $test) -cne $pin.test.publicSha256){throw '시험 해시 불일치'}
foreach($source in $pin.sources){if((Hash (Join-Path $PSScriptRoot ($source.variant+'/AFTER-AUTHORIZATION-COMMANDS.txt'))) -cne $source.extractedSha256){throw '추출 원문 해시 불일치'}}
[IO.Directory]::CreateDirectory($OutputRoot)|Out-Null
$receipts=@()
foreach($variant in @('red','green')){
  $source=Join-Path $PSScriptRoot $variant;$output=Join-Path $OutputRoot $variant
  $stdout=Join-Path $OutputRoot ($variant+'.stdout.txt');$stderr=Join-Path $OutputRoot ($variant+'.stderr.txt')
  $argv=@('-NoLogo','-NoProfile','-NonInteractive','-File',$test,'-SourceRoot',$source,'-OutputRoot',$output)
  $PSNativeCommandUseErrorActionPreference=$false
  & ([Environment]::ProcessPath) @argv 1> $stdout 2> $stderr
  $code=$LASTEXITCODE
  $resultPath=Join-Path $output 'f2-result.safe.json'
  if(-not(Test-Path -LiteralPath $resultPath)){throw ('시험결과 부재: '+$variant+' exit='+$code)}
  $result=Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8|ConvertFrom-Json
  $cases=@($result.cases);$failed=@($cases|Where-Object status -ne 'PASS');$new=@($cases|Where-Object caseId -ceq 'F2_잠금전_동일후보경쟁쓰기_소유오인복구금지')
  if($cases.Count -ne 9 -or $new.Count -ne 1 -or @($result.capabilityCases).Count -ne 0){throw '9사례 또는 실제 환경 전제 불충족'}
  if($variant -ceq 'red'){
    if($code -ne 1 -or $result.status -cne 'FAIL' -or $failed.Count -ne 1 -or $new[0].status -cne 'FAIL' -or $new[0].error -notlike '*본인 쓰기 전 경쟁자가 쓴 동일 후보 바이트를 소유로 오인해 복구함*' -or -not $new[0].state.preLockInjected -or -not $new[0].state.entry.Restored -or $new[0].state.targetHash -cne $new[0].state.entry.OldHash){throw '신규 단언의 결함 재현 실패: 환경 오류는 인정하지 않음'}
  }elseif($code -ne 0 -or $result.status -cne 'PASS' -or $failed.Count -ne 0){throw '수리판 9사례 통과 실패'}
  $receipts+=@{variant=$variant;executable=[Environment]::ProcessPath;argv=$argv;exitCode=$code;resultSha256=(Hash $resultPath);stdoutSha256=(Hash $stdout);stderrSha256=(Hash $stderr);caseCount=$cases.Count}
}
$receipt=[ordered]@{status='PASS';scope='Windows 실제 독립파일가드와 원9사례의 결함판/수리판 비교';testSha256=(Hash $test);runs=$receipts;actualInstallation='NOT_RUN';actual104Restore='NOT_RUN';actualMidCopyDiskFailure='NOT_RUN'}
[IO.File]::WriteAllText((Join-Path $OutputRoot 'comparison.json'),($receipt|ConvertTo-Json -Depth 10).Replace([string][char]13,'')+[char]10,[Text.UTF8Encoding]::new($false))
$receipt|ConvertTo-Json -Depth 10
