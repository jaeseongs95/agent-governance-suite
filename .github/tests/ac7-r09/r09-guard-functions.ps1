function Assert-TaskBytes($taskPath, $taskBytes, $taskHash) {
  if ((Get-Item -LiteralPath $taskPath).Length -ne [long]$taskBytes -or (Get-FileHash -Algorithm SHA256 -LiteralPath $taskPath).Hash.ToLowerInvariant() -ne $taskHash) { throw ('파일 바이트가 일치하지 않습니다: ' + $taskPath) }
}

function Assert-TaskIndependentFile($taskPath) {
  $taskItem = Get-Item -LiteralPath $taskPath
  while ($null -ne $taskItem) {
    if (($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '대상 또는 상위 경로에 재분석 지점이 있습니다. 보존한 뒤 확인하세요.' }
    $taskItem = if ($taskItem -is [IO.FileInfo]) { $taskItem.Directory } else { $taskItem.Parent }
  }
  $taskLinks = @(& fsutil hardlink list $taskPath)
  if ($LASTEXITCODE -ne 0 -or @($taskLinks | Where-Object { $_.Trim() }).Count -ne 1) { throw '대상 파일이 독립적인 단일 링크인지 확인하지 못했습니다.' }
}

function Assert-TaskReadOnlyConsumption($taskPins) {
  if (@($taskPins).Count -ne 23) { throw '읽기 전용 소비 파일 23개의 명시적 고정 목록이 필요합니다.' }
  foreach ($taskPin in @($taskPins)) {
    if ([string]::IsNullOrWhiteSpace([string]$taskPin.path) -or $null -eq $taskPin.bytes -or [long]$taskPin.bytes -lt 0 -or [string]$taskPin.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw '읽기 전용 소비 파일의 경로·크기·해시를 확인하지 못했습니다.' }
    Assert-TaskIndependentFile $taskPin.path
    Assert-TaskBytes $taskPin.path $taskPin.bytes $taskPin.sha256
  }
}
