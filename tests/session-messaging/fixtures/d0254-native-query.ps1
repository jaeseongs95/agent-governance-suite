param([Parameter(Mandatory=$true)][string]$FixtureDirectory)
$ErrorActionPreference = 'Stop'
[System.IO.File]::WriteAllText((Join-Path $FixtureDirectory 'native-query-pid'), [string]$PID, [System.Text.UTF8Encoding]::new($false))
$queryGuard = [System.Diagnostics.Stopwatch]::StartNew()
while (-not [System.IO.File]::Exists((Join-Path $FixtureDirectory 'release-query'))) {
    if ($queryGuard.ElapsedMilliseconds -ge 8000) { throw 'Owned fixture release guard expired.' }
    Start-Sleep -Milliseconds 10
}
[Console]::WriteLine('fixture-parent-birth')
