param([Parameter(Mandatory=$true)][string]$RequestPath, [ValidateSet('verify','stop')][string]$Action='verify')
$ErrorActionPreference = 'Stop'
$r = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$r.pid)
if (-not $p) { @{ running=$false } | ConvertTo-Json -Compress; exit 0 }
# PID alone is not ownership: verify executable AND this job's unique profile.
if ($p.ExecutablePath -ine $r.executable -or -not $p.CommandLine.Contains('--user-data-dir=' + $r.userData)) { throw '进程身份与受管实例不一致；拒绝操作' }
if ($Action -eq 'stop') {
  & "$env:SystemRoot\System32\taskkill.exe" /PID ([string]$r.pid) /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '无法停止受管客户端进程树' }
  $remaining = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$r.pid)
  if ($remaining) { throw '客户端仍未退出' }
}
@{ running=($Action -eq 'verify'); verified=$true } | ConvertTo-Json -Compress
