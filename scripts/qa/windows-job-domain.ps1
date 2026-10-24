# Owned, account-free Windows process fixture. No installed-app processes.
$ErrorActionPreference = 'Stop'
$fixtureParent = 'D:\cooperate\codex-relay-qa'
$fixture = Join-Path $fixtureParent ('job-domain-' + [guid]::NewGuid().ToString('N'))
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$reportPath = Join-Path $repo 'qa-output\windows-job-domain-report.json'
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;
public sealed class OwnedJobDomainProbe : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorking, MaxWorking; public uint ProcessLimit;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long User, Kernel, PeriodUser, PeriodKernel;
    public uint Faults, Total, Active, Terminated;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint Size; public string Reserved, Desktop, Title;
    public uint X,Y,Width,Height,CharsX,CharsY,Fill,Flags;
    public ushort Show, ReservedBytes; public IntPtr ReservedData,Input,Output,Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process,Thread; public uint ProcessId,ThreadId;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,IntPtr data,uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting data,uint size,IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  IntPtr job,root;
  public OwnedJobDomainProbe() {
    job=CreateJobObject(IntPtr.Zero,null);
    if(job==IntPtr.Zero)throw new Win32Exception();
    var limits=new ExtendedLimits();limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE
    int size=Marshal.SizeOf(typeof(ExtendedLimits));IntPtr data=Marshal.AllocHGlobal(size);
    try {Marshal.StructureToPtr(limits,data,false);if(!SetInformationJobObject(job,9,data,(uint)size))throw new Win32Exception();}
    catch {Dispose();throw;} finally {Marshal.FreeHGlobal(data);}
  }
  public int LaunchSuspendedThenAssign(string app,string command,string cwd) {
    if(root!=IntPtr.Zero)throw new InvalidOperationException("Fixture root already created");
    var startup=new Startup();startup.Size=(uint)Marshal.SizeOf(typeof(Startup));ProcessInfo info;
    if(!CreateProcess(app,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,cwd,ref startup,out info))throw new Win32Exception();
    root=info.Process;
    try {
      if(!AssignProcessToJobObject(job,root))throw new Win32Exception();
      if(ResumeThread(info.Thread)==0xffffffff)throw new Win32Exception();
      return (int)info.ProcessId;
    } catch {TerminateProcess(root,91);throw;} finally {CloseHandle(info.Thread);}
  }
  public void AwaitRootExit() {if(WaitForSingleObject(root,15000)!=0)throw new Exception("Owned fixture root did not exit");}
  public uint ActiveProcesses() {Accounting data;if(!QueryInformationJobObject(job,1,out data,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero))throw new Win32Exception();return data.Active;}
  public void Dispose() {if(job!=IntPtr.Zero){CloseHandle(job);job=IntPtr.Zero;}if(root!=IntPtr.Zero){CloseHandle(root);root=IntPtr.Zero;}}
}
'@
$fixtureCode = @'
const fs=require('node:fs'),cp=require('node:child_process');
const [mode,marker]=process.argv.slice(2);
if(mode==='child'){fs.writeFileSync(marker,JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);}
else {const child=cp.spawn(process.execPath,[__filename,'child',marker],{windowsHide:true,detached:true,stdio:'ignore'});child.unref();const timer=setInterval(()=>{if(fs.existsSync(marker)){clearInterval(timer);process.exit(0);}},25);setTimeout(()=>process.exit(92),10000).unref();}
'@
$script = Join-Path $fixture 'fixture.cjs'
[IO.File]::WriteAllText($script,$fixtureCode,[Text.UTF8Encoding]::new($false))
$node = (Get-Command node.exe).Source
$marker = Join-Path $fixture 'owned.json'
$controlMarker = Join-Path $fixture 'control.json'
$domain = $null
$outside = $null
$descendant = $null
$report = [ordered]@{ status='running'; modelRequests=0; externalMessages=0; checks=@() }
try {
  # The known outside control proves closing this job does not kill unrelated work.
  $outside = Start-Process -FilePath $node -ArgumentList @('"'+$script+'"','child','"'+$controlMarker+'"') -WindowStyle Hidden -PassThru
  $controlDeadline = [DateTime]::UtcNow.AddSeconds(10)
  while (!(Test-Path -LiteralPath $controlMarker)) {
    $outside.Refresh()
    if ($outside.HasExited -or [DateTime]::UtcNow -gt $controlDeadline) { throw 'Outside control did not become ready' }
    Start-Sleep -Milliseconds 25
  }
  $domain = [OwnedJobDomainProbe]::new()
  $command = '"'+$node+'" "'+$script+'" parent "'+$marker+'"'
  $rootPid = $domain.LaunchSuspendedThenAssign($node,$command,$fixture)
  $domain.AwaitRootExit()
  if (!(Test-Path -LiteralPath $marker)) { throw 'Descendant did not announce readiness' }
  $childPid = (Get-Content -Raw -LiteralPath $marker | ConvertFrom-Json).pid
  $descendant = [Diagnostics.Process]::GetProcessById($childPid)
  if ($descendant.HasExited) { throw 'Descendant exited before containment check' }
  $active = $domain.ActiveProcesses()
  if ($active -lt 1) { throw 'Job lost descendant after root exit' }
  $report.checks += 'Root exits while a live descendant remains in the owned job'
  $report.rootPid = $rootPid; $report.descendantPid = $childPid; $report.activeAfterRootExit = $active
  $domain.Dispose(); $domain = $null
  if (!$descendant.WaitForExit(5000)) { throw 'Closing the owned job did not stop its descendant' }
  $report.checks += 'Closing the last job handle terminates the retained descendant'
  $outside.Refresh()
  if ($outside.HasExited -or !(Test-Path -LiteralPath $controlMarker)) { throw 'Outside control did not survive the owned job close' }
  $report.checks += 'An independently launched control process stays alive'
  $report.status = 'passed'
} catch { $report.status='failed'; $report.error=$_.Exception.ToString(); throw }
finally {
  if ($domain) { $domain.Dispose() }
  if ($outside) { $outside.Refresh(); if (!$outside.HasExited) { $outside.Kill(); $outside.WaitForExit(5000) | Out-Null }; $outside.Dispose() }
  if ($descendant) { $descendant.Dispose() }
  $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  $actual = (Resolve-Path -LiteralPath $fixture).Path
  $parent = (Resolve-Path -LiteralPath $fixtureParent).Path
  if ([IO.Path]::GetDirectoryName($actual) -ne $parent -or ![IO.Path]::GetFileName($actual).StartsWith('job-domain-')) { throw 'Unsafe native fixture cleanup' }
  Remove-Item -LiteralPath $actual -Recurse -Force
}
$report | ConvertTo-Json -Depth 6
