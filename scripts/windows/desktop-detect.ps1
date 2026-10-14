$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$found = @()
foreach ($p in @(Get-AppxPackage | Where-Object { $_.Name -match '^OpenAI\.(Codex|ChatGPT)$' } | Sort-Object @{Expression={if($_.Name -match 'Codex'){0}else{1}}}, @{Expression='Version';Descending=$true})) {
  foreach ($a in (Get-AppxPackageManifest -Package $p).Package.Applications.Application) {
    $exe = Join-Path $p.InstallLocation $a.Executable
    if ([IO.Path]::GetFileName($exe) -match '^(Codex|ChatGPT)\.exe$' -and (Test-Path -LiteralPath $exe -PathType Leaf)) {
      $found += @{ executable=$exe; name=$p.Name; version=[string]$p.Version; source='Microsoft Store' }
    }
  }
}
foreach ($base in @((Join-Path $env:LOCALAPPDATA 'Programs'), $env:ProgramFiles)) {
  foreach ($name in @('Codex','ChatGPT')) {
    $exe = Join-Path (Join-Path $base $name) ($name + '.exe')
    if (Test-Path -LiteralPath $exe -PathType Leaf) {
      $found += @{ executable=$exe; name=$name; version=(Get-Item -LiteralPath $exe).VersionInfo.FileVersion; source='Local' }
    }
  }
}
@{ candidates=@($found | Sort-Object -Property executable -Unique) } | ConvertTo-Json -Depth 5 -Compress
