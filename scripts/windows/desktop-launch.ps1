param([Parameter(Mandatory=$true)][string]$RequestPath, [switch]$InPackage)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$r = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
function Quote-Arg([string]$s) {
  if ($s -notmatch '[\s"]' -and $s.Length -gt 0) { return $s }
  return '"' + [regex]::Replace([regex]::Replace($s, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
try {
  $exe = [string]$r.executable
  $package = $null; $application = $null
  if (-not $InPackage) {
    $candidates = @(Get-AppxPackage | Where-Object { $_.Name -match '^OpenAI\.(Codex|ChatGPT)$' } | Sort-Object @{Expression={if($_.Name -match 'Codex'){0}else{1}}}, @{Expression='Version';Descending=$true})
    foreach ($p in $candidates) {
      foreach ($a in (Get-AppxPackageManifest -Package $p).Package.Applications.Application) {
        $full = Join-Path $p.InstallLocation $a.Executable
        if (([IO.Path]::GetFileName($full) -match '^(Codex|ChatGPT)\.exe$') -and ((-not $exe) -or $full -ieq $exe)) { $package=$p; $application=$a; $exe=$full; break }
      }
      if ($package) { break }
    }
    if ($package) {
      $r.executable = $exe
      $r | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $RequestPath -Encoding UTF8
      $argsText = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-Arg $PSCommandPath) + ' -RequestPath ' + (Quote-Arg $RequestPath) + ' -InPackage'
      Invoke-CommandInDesktopPackage -PackageFamilyName $package.PackageFamilyName -AppId $application.Id -PreventBreakaway -Command "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Args $argsText
      exit 0
    }
  }
  if (-not $exe -or -not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw '未找到客户端，请在设置中选择 Codex.exe 或 ChatGPT.exe' }
  if (([IO.Path]::GetFileName($exe)) -notmatch '^(Codex|ChatGPT)\.exe$') { throw '选定文件不是 Codex / ChatGPT 客户端' }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe; $psi.UseShellExecute = $false
  $psi.Arguments = (@('--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',('--user-data-dir=' + $r.userData)) | ForEach-Object { Quote-Arg $_ }) -join ' '
  $psi.EnvironmentVariables['CODEX_HOME'] = $r.codexHome
  $psi.EnvironmentVariables['CODEX_ELECTRON_USER_DATA_PATH'] = $r.userData
  $psi.EnvironmentVariables.Remove('OPENAI_API_KEY')
  $child = [Diagnostics.Process]::Start($psi)
  @{ pid=$child.Id; createdAt=$child.StartTime.ToUniversalTime().ToString('o'); executable=$exe; nonce=$r.nonce; userData=$r.userData; started=$true } | ConvertTo-Json -Compress | Set-Content -LiteralPath $r.receipt -Encoding UTF8
} catch {
  @{ error=$_.Exception.Message; nonce=$r.nonce; started=($null -ne $child); pid=$child.Id; executable=$exe; userData=$r.userData } | ConvertTo-Json -Compress | Set-Content -LiteralPath $r.receipt -Encoding UTF8
  exit 1
}
