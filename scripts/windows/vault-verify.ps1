param([string]$ExpectedManifestSha256 = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try { [AppContext]::SetSwitch('Switch.System.IO.UseLegacyPathHandling', $false); [AppContext]::SetSwitch('Switch.System.IO.BlockLongPaths', $false) } catch {}
function Hash-File([string]$File) {
  $stream=[IO.File]::Open($File,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  $hash=[Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
  finally { $hash.Dispose(); $stream.Dispose() }
}
function Bundle-File([string]$Root,[string]$Relative) {
  if (!$Relative -or $Relative -match '^[\\/]|[\x00-\x1f:]') { throw 'Invalid artifact path' }
  $current=$Root
  foreach($part in ($Relative -split '[\\/]')) {
    if (!$part -or $part -eq '.' -or $part -eq '..') { throw 'Invalid artifact path' }
    $current=[IO.Path]::Combine($current,$part)
    if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are not artifact files' }
  }
  $full=[IO.Path]::GetFullPath($current)
  if (!$full.StartsWith($Root.TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or
      (([IO.File]::GetAttributes($full) -band [IO.FileAttributes]::Directory) -ne 0)) { throw 'Artifact leaves the bundle' }
  return $full
}
try {
  $root=[IO.Path]::GetFullPath($PSScriptRoot)
  if ($root -ne [IO.Path]::GetPathRoot($root)) { $root=$root.TrimEnd([IO.Path]::DirectorySeparatorChar) }
  $manifestPath=Bundle-File $root 'manifest.json'
  $digest=Hash-File $manifestPath
  if ($ExpectedManifestSha256 -and ($ExpectedManifestSha256 -notmatch '^[a-fA-F0-9]{64}$' -or $digest -ne $ExpectedManifestSha256.ToLowerInvariant())) { throw 'Manifest fingerprint mismatch' }
  $manifest=[IO.File]::ReadAllText($manifestPath,[Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1 -or @($manifest.artifacts).Count -lt 1) { throw 'Unsupported or empty manifest' }
  $seen=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $failed=New-Object 'Collections.Generic.List[string]'
  [long]$total=0
  foreach($artifact in $manifest.artifacts) {
    try {
      if (!$seen.Add([string]$artifact.path) -or [string]$artifact.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid artifact fingerprint' }
      $file=Bundle-File $root ([string]$artifact.path)
      $info=New-Object IO.FileInfo($file)
      if ($info.Length -ne [long]$artifact.bytes -or (Hash-File $file) -ne $artifact.sha256) { throw 'Artifact fingerprint mismatch' }
      $total += $info.Length
    } catch { $failed.Add([string]$artifact.path) }
  }
  $passed=$failed.Count -eq 0 -and $total -eq [long]$manifest.totalBytes
  [ordered]@{passed=$passed; manifestSha256=$digest; comparedTrustedManifest=[bool]$ExpectedManifestSha256; files=@($manifest.artifacts).Count; bytes=$total; failed=@($failed.ToArray())} | ConvertTo-Json -Depth 5
  if (!$passed) { exit 2 }
} catch {
  [ordered]@{passed=$false;error='Bundle verification failed';detail=$_.Exception.Message} | ConvertTo-Json -Depth 3
  exit 2
}
