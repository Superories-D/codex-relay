param([Parameter(Mandatory=$true)][string]$RequestPath, [ValidateSet('verify','stop','show')][string]$Action='verify')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$r = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$r.pid)
if (-not $p -and $Action -eq 'show') { throw '受管客户端已经退出' }
if (-not $p) { @{ running=$false } | ConvertTo-Json -Compress; exit 0 }
# PID alone is not ownership: verify executable AND this job's unique profile.
if ($p.ExecutablePath -ine $r.executable -or -not $p.CommandLine.Contains('--user-data-dir=' + $r.userData)) { throw '进程身份与受管实例不一致；拒绝操作' }
if ($r.createdAt -and ([Diagnostics.Process]::GetProcessById([int]$r.pid).StartTime.ToUniversalTime().ToString('o') -ne $r.createdAt)) { throw '进程创建时间变化；拒绝操作复用的 PID' }
if ($Action -eq 'show') {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class RelayWindow { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); }'
  $handle = [Diagnostics.Process]::GetProcessById([int]$r.pid).MainWindowHandle
  if ($handle -eq [IntPtr]::Zero) { throw '客户端窗口尚未就绪，请稍后重试' }
  [RelayWindow]::ShowWindowAsync($handle, 9) | Out-Null
  [RelayWindow]::SetForegroundWindow($handle) | Out-Null
}
if ($Action -eq 'stop') {
  & "$env:SystemRoot\System32\taskkill.exe" /PID ([string]$r.pid) /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '无法停止受管客户端进程树' }
  $remaining = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$r.pid)
  if ($remaining) { throw '客户端仍未退出' }
}
@{ running=($Action -ne 'stop'); verified=$true } | ConvertTo-Json -Compress
