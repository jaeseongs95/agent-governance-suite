param([Parameter(Mandatory = $true)][string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'resource-storage-windows.cs'
$output = Join-Path $OutputDirectory 'resource-storage-windows.dll'
$windows = [IO.Directory]::GetParent([Environment]::SystemDirectory).FullName
$compiler = Join-Path $windows 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not [IO.File]::Exists($compiler) -or -not [IO.Directory]::Exists($OutputDirectory)) {
  throw 'BUILD_ENVIRONMENT_UNAVAILABLE'
}
& $compiler /nologo /target:library /optimize+ "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw 'BUILD_FAILED' }
function Get-Hash([string]$path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($path))).Replace('-', '') }
  finally { $sha.Dispose() }
}
function Get-NormalizedHash([string]$path) {
  $bytes = [IO.File]::ReadAllBytes($path)
  $pe = [BitConverter]::ToInt32($bytes, 0x3c)
  if ($pe -lt 0 -or $pe + 12 -ge $bytes.Length -or
      [Text.Encoding]::ASCII.GetString($bytes, $pe, 4) -ne "PE`0`0") {
    throw 'INVALID_PE'
  }
  $mvid = [Reflection.Assembly]::Load($bytes).ManifestModule.ModuleVersionId.ToByteArray()
  $matches = @()
  for ($i = 0; $i -le $bytes.Length - $mvid.Length; $i++) {
    if ($bytes[$i] -ne $mvid[0]) { continue }
    $same = $true
    for ($j = 1; $j -lt $mvid.Length; $j++) {
      if ($bytes[$i + $j] -ne $mvid[$j]) { $same = $false; break }
    }
    if ($same) { $matches += $i }
  }
  if ($matches.Count -ne 1) { throw 'MVID_NOT_UNIQUE' }
  [Array]::Clear($bytes, $pe + 8, 4) # PE TimeDateStamp
  [Array]::Clear($bytes, $matches[0], $mvid.Length)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '') }
  finally { $sha.Dispose() }
}
$committedArtifact = Join-Path $PSScriptRoot 'resource-storage-windows.dll'
@{
  sourceSha256 = Get-Hash $source
  artifactSha256 = Get-Hash $output
  normalizedArtifactSha256 = Get-NormalizedHash $output
  normalizedCommittedSha256 = Get-NormalizedHash $committedArtifact
} | ConvertTo-Json -Compress
