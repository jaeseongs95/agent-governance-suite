param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
$sourceHash = 'BA5D8CB582DE5A6982CF36F2AC72359448A7924A5638EDE511D0EB0B27E623D4'
$artifactHash = 'FD320D1C3930821670400600E0047006A7C6D1FDF9A8C213DC26B56FCC0F1F5D'

function Get-Sha256([byte[]]$bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '') }
  finally { $sha.Dispose() }
}

try {
  $systemShell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
  $runningShell = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  if ($PSVersionTable.PSVersion.Major -ne 5 -or
      -not [string]::Equals($runningShell, $systemShell, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'UNSUPPORTED_SHELL'
  }

  $source = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'resource-storage-windows.cs'))
  $artifact = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'resource-storage-windows.dll'))
  if ((Get-Sha256 $source) -ne $sourceHash -or (Get-Sha256 $artifact) -ne $artifactHash) {
    throw 'ARTIFACT_MISMATCH'
  }

  # Load the exact bytes measured above. PowerShell 5.1 Add-Type is never invoked.
  $assembly = [Reflection.Assembly]::Load($artifact)
  $method = $assembly.GetType('ResourceStorageWindows', $true).GetMethod('Probe')
  if ($null -eq $method -or -not $method.IsStatic) { throw 'ARTIFACT_INVALID' }
  $json = [string]$method.Invoke($null, @($Path))
  $result = $json | ConvertFrom-Json
  if ($result.qualification -ne 'FIXTURE_ONLY' -or
      $result.status -notin @('OBSERVED', 'BLOCKED_ALIAS', 'BLOCKED_REPARSE', 'BLOCKED_TYPE', 'UNKNOWN')) {
    throw 'ARTIFACT_INVALID'
  }
  $json
  if ($result.status -eq 'OBSERVED') { exit 0 }
  if ($result.status -eq 'UNKNOWN') { exit 1 }
  exit 2
} catch {
  @{ status = 'UNKNOWN'; qualification = 'FIXTURE_ONLY'; code = 'LOADER_FAILED' } |
    ConvertTo-Json -Compress
  exit 1
}
