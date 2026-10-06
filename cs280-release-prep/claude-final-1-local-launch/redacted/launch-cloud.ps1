$ErrorActionPreference = 'Continue'
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $base 'launch.log'
"start $((Get-Date).ToUniversalTime().ToString('o'))" | Out-File -FilePath $log -Encoding utf8
# Child of a Claude session: drop inherited Claude Code session variables for this process only.
Get-ChildItem Env: | Where-Object { $_.Name -eq 'CLAUDECODE' -or $_.Name -like 'CLAUDE_CODE_*' } | ForEach-Object {
  "unset $($_.Name)" | Out-File -FilePath $log -Append -Encoding utf8
  Remove-Item -Path ("Env:" + $_.Name)
}
$env:CCR_FORCE_BUNDLE = '1'
Set-Location (Join-Path $base 'repo')
"cwd $((Get-Location).Path) head $(git rev-parse HEAD) tree $(git rev-parse 'HEAD^{tree}') dirty $((git status --porcelain --untracked-files=all | Measure-Object).Count)" | Out-File -FilePath $log -Append -Encoding utf8
$prompt = Get-Content -Raw -Encoding UTF8 (Join-Path $base 'cloud-prompt-final.md')
$arg = $prompt.Replace('"', '\"')
Start-Transcript -Path (Join-Path $base 'launch-transcript.log') -Force | Out-Null
& claude.exe --cloud $arg
$code = $LASTEXITCODE
Stop-Transcript | Out-Null
$LASTEXITCODE = $code
"exit $LASTEXITCODE end $((Get-Date).ToUniversalTime().ToString('o'))" | Out-File -FilePath $log -Append -Encoding utf8
