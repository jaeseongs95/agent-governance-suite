param([Parameter(Mandatory=$true)][string]$FixtureDirectory)
$ErrorActionPreference = 'Stop'
# Publish the PID atomically so a reader never sees an empty or partial marker.
$marker = Join-Path $FixtureDirectory 'native-query-pid'
[System.IO.File]::WriteAllText("$marker.tmp", [string]$PID, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::Move("$marker.tmp", $marker)
# An orphan guard only, longer than the test's own hang guard. Its expiry is recorded, so a guard exit can never
# pass for the broker's cancellation.
$queryGuard = [System.Diagnostics.Stopwatch]::StartNew()
while (-not [System.IO.File]::Exists((Join-Path $FixtureDirectory 'release-query'))) {
    if ($queryGuard.ElapsedMilliseconds -ge 60000) {
        [System.IO.File]::WriteAllText((Join-Path $FixtureDirectory 'native-guard-expired'), '1')
        throw 'Owned fixture release guard expired.'
    }
    Start-Sleep -Milliseconds 10
}
[Console]::WriteLine('fixture-parent-birth')
