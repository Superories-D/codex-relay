param([Parameter(Mandatory=$true)][string]$RequestPath,[ValidateSet('inspect','stop','status')][string]$Action='inspect')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$request=Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $request.file -PathType Leaf)) { throw 'Source session file does not exist' }
$currentSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RelayFileOwners {
 [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public uint pid; public System.Runtime.InteropServices.ComTypes.FILETIME start; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct ProcessInfo {
  public UniqueProcess process;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)] public string appName;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=64)] public string serviceName;
  public int appType; public uint status; public uint sessionId;
  [MarshalAs(UnmanagedType.Bool)] public bool restartable;
 }
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint handle,int flags,System.Text.StringBuilder key);
 [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint handle,uint files,string[] names,uint apps,IntPtr processes,uint services,string[] serviceNames);
 [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle,out uint needed,ref uint count,[In,Out] ProcessInfo[] entries,ref uint reasons);
 public sealed class Owner { public uint pid; public long startedAt; }
 public static Owner[] Get(string file) {
  uint handle; int result=RmStartSession(out handle,0,new System.Text.StringBuilder(33));
  if(result!=0) throw new Exception("Restart Manager start failed: "+result);
  try {
   result=RmRegisterResources(handle,1,new[]{file},0,IntPtr.Zero,0,null);
   if(result!=0) throw new Exception("File owner registration failed: "+result);
   uint needed=0,count=0,reasons=0;
   result=RmGetList(handle,out needed,ref count,null,ref reasons);
   for(int attempt=0;attempt<3;attempt++) {
    if(result==0 && needed==0) return new Owner[0];
    if(result!=234) throw new Exception("File owner lookup failed: "+result);
    if(needed>128) throw new Exception("Too many file owners");
    count=needed; var items=new ProcessInfo[count];
    result=RmGetList(handle,out needed,ref count,items,ref reasons);
    if(result==0) {
     var owners=new Owner[count];
     for(int i=0;i<count;i++) {
      var process=items[i].process;
      long fileTime=((long)(uint)process.start.dwHighDateTime<<32) | (uint)process.start.dwLowDateTime;
      owners[i]=new Owner { pid=process.pid, startedAt=DateTime.FromFileTimeUtc(fileTime).Ticks };
     }
     return owners;
    }
   }
   throw new Exception("File owners changed repeatedly");
  } finally { RmEndSession(handle); }
 }
}
'@
function Get-Identity([int]$processId) {
 $cim=Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
 if (-not $cim) { return $null }
 $owner=Invoke-CimMethod -InputObject $cim -MethodName GetOwnerSid
 if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $currentSid) { throw 'Process belongs to another user or cannot be verified' }
 $proc=Get-Process -Id $processId -ErrorAction Stop
 try {
  $unused=$proc.Handle
  if ([Math]::Abs($proc.StartTime.ToUniversalTime().Ticks - $cim.CreationDate.ToUniversalTime().Ticks) -ge 10) { throw 'Process changed while checking ownership' }
  return [pscustomobject]@{pid=$processId;startedAt=$proc.StartTime.ToUniversalTime().Ticks.ToString();executable=$proc.MainModule.FileName;title=$proc.MainWindowTitle}
 } finally { $proc.Dispose() }
}
function Is-Codex([string]$name) { return $name -match '^(Codex|codex-cli|codex-x86_64-pc-windows-msvc|codex-aarch64-pc-windows-msvc|ChatGPT)\.exe$' }
function Get-Root([int]$processId,[long]$expectedStart) {
 $entry=Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
 if (-not $entry -or -not (Is-Codex $entry.Name)) { throw 'Session file is held by an unrecognized process' }
 $identity=Get-Identity $processId
 if (-not $identity -or [long]$identity.startedAt -ne $expectedStart -or -not (Is-Codex ([IO.Path]::GetFileName($identity.executable)))) { throw 'File owner changed during inspection' }
 if ([Math]::Abs([long]$identity.startedAt - $entry.CreationDate.ToUniversalTime().Ticks) -ge 10) { throw 'File owner changed during inspection' }
 for($i=0;$i -lt 12;$i++) {
  $parent=Get-CimInstance Win32_Process -Filter "ProcessId=$($entry.ParentProcessId)"
  if (-not $parent -or -not (Is-Codex $parent.Name)) { break }
  $parentIdentity=Get-Identity ([int]$parent.ProcessId)
  if (-not $parentIdentity -or [long]$parentIdentity.startedAt -gt [long]$identity.startedAt) { break }
  if ([Math]::Abs([long]$parentIdentity.startedAt - $parent.CreationDate.ToUniversalTime().Ticks) -ge 10 -or -not (Is-Codex ([IO.Path]::GetFileName($parentIdentity.executable)))) { throw 'Parent process changed during inspection' }
  $entry=$parent; $identity=$parentIdentity
 }
 return $identity
}
function Inspect-Owners {
 $roots=@{}
 foreach($owner in [RelayFileOwners]::Get($request.file)) {
  $root=Get-Root ([int]$owner.pid) ([long]$owner.startedAt)
  $roots[$root.pid]=$root
 }
 return @($roots.Values)
}
function Write-Receipt($identities) {
 $temp=$request.receipt+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
 @{processes=@($identities)} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temp -Encoding UTF8
 Move-Item -LiteralPath $temp -Destination $request.receipt -Force
}
function Stop-Identity($expected,[bool]$graceful) {
 $proc=Get-Process -Id ([int]$expected.pid) -ErrorAction SilentlyContinue
 if (-not $proc) { return }
 try {
  $unused=$proc.Handle # Pin the process object before validating, so PID reuse cannot redirect Kill().
  if ($proc.StartTime.ToUniversalTime().Ticks.ToString() -ne $expected.startedAt -or $proc.MainModule.FileName -ine $expected.executable) {
   throw 'PID identity changed; refusing to stop a replacement process'
  }
  if ($graceful -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
   $null=$proc.CloseMainWindow()
   if ($proc.WaitForExit(2000)) { return }
  }
  $proc.Kill()
  if (-not $proc.WaitForExit(5000)) { throw 'Process did not confirm exit' }
 } finally { $proc.Dispose() }
}
if ($Action -eq 'status') {
 $alive=@($request.processes).Count -gt 0
 foreach($expected in @($request.processes)) {
  $current=Get-Identity ([int]$expected.pid)
  if (-not $current) { $alive=$false; continue }
  if ($current.startedAt -ne $expected.startedAt -or $current.executable -ine $expected.executable) { throw 'Original process identity changed' }
 }
 @{alive=$alive} | ConvertTo-Json -Compress
 exit 0
}
$owners=@(Inspect-Owners)
if ($Action -eq 'inspect') {
 $other=@()
 if ($owners.Count -eq 0) {
  foreach($entry in Get-CimInstance Win32_Process) {
   if (Is-Codex $entry.Name) {
    try { $identity=Get-Identity ([int]$entry.ProcessId); if($identity){$other+=$identity} } catch { throw 'A Codex process could not be verified' }
   }
  }
 }
 @{processes=@($owners);canHandoff=($owners.Count -gt 0 -or $other.Count -eq 0);issue=$(if($other.Count -gt 0){'No session file owner was found, but Codex processes are still running. Close the original Codex instance and retry.'}else{$null})} | ConvertTo-Json -Depth 6 -Compress
 exit 0
}
$expectedRoots=@($request.processes)
foreach($owner in $owners) {
 if (-not ($expectedRoots | Where-Object { $_.pid -eq $owner.pid -and $_.startedAt -eq $owner.startedAt -and $_.executable -ieq $owner.executable })) {
  throw 'A different process now owns this session; rescan before takeover'
 }
}
if ($expectedRoots.Count -eq 0 -and $owners.Count -gt 0) { throw 'No authorized process identity' }
$identities=@{}
if (Test-Path -LiteralPath $request.receipt) {
 $prior=Get-Content -LiteralPath $request.receipt -Raw -Encoding UTF8 | ConvertFrom-Json
 foreach($identity in @($prior.processes)) { $identities["$($identity.pid):$($identity.startedAt)"]=$identity }
}
foreach($identity in $expectedRoots) { $identities["$($identity.pid):$($identity.startedAt)"]=$identity }
$all=@(Get-CimInstance Win32_Process)
$parents=@()
foreach($expected in $expectedRoots) {
 $current=Get-Identity ([int]$expected.pid)
 if ($current) {
  if ($current.startedAt -ne $expected.startedAt -or $current.executable -ine $expected.executable) { throw 'Root PID was reused; no processes were stopped' }
  $parents+=[int]$expected.pid
 }
}
for($depth=0;$depth -lt 16 -and $parents.Count -gt 0;$depth++) {
 $next=@()
 foreach($entry in $all) {
  if ($parents -contains [int]$entry.ParentProcessId) {
   $identity=Get-Identity ([int]$entry.ProcessId)
   if ($identity) {
    if ([Math]::Abs([long]$identity.startedAt - $entry.CreationDate.ToUniversalTime().Ticks) -ge 10) { throw 'Child process changed during inspection' }
    $identities["$($identity.pid):$($identity.startedAt)"]=$identity; $next+=[int]$identity.pid
   }
  }
 }
 $parents=$next
}
if ($parents.Count -gt 0) { throw 'Process tree is too deep to verify' }
Write-Receipt -identities @($identities.Values)
# Only this explicitly selected Codex tree is stopped. Never signal a console or use /IM.
foreach($identity in $expectedRoots) { Stop-Identity $identity $true }
foreach($identity in @($identities.Values)) { Stop-Identity $identity $false }
$knownParents=@($identities.Values | ForEach-Object {[int]$_.pid})
foreach($entry in Get-CimInstance Win32_Process) {
 if ($knownParents -contains [int]$entry.ParentProcessId) {
  throw 'A child process appeared during shutdown; takeover is blocked until it exits'
 }
}
if (@([RelayFileOwners]::Get($request.file)).Count -gt 0) { throw 'Source session remains open after stop' }
@{stopped=$true} | ConvertTo-Json -Compress
