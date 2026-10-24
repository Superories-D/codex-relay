// Windows 10+: private process job, assigned atomically at process creation.
// stdout belongs exclusively to the CLI protocol in run mode.
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Diagnostics;
using System.Threading;
using System.ComponentModel;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

[DataContract] sealed class Launch {
  [DataMember] public int version;
  [DataMember] public string nonce, home, executable;
  [DataMember] public string[] args;
}
[DataContract] sealed class Owner {
  [DataMember] public int version, pid, launcherPid;
  [DataMember] public string kind, nonce, home, launcherCreated;
}
[DataContract] sealed class Identity {
  [DataMember] public int pid;
  [DataMember] public string created;
}
[DataContract] sealed class Receipt {
  [DataMember] public int version=1, hostPid, rootPid;
  [DataMember] public string nonce, home, job, phase, hostCreated, rootCreated;
}
[DataContract] sealed class DomainView {
  [DataMember] public int active;
  [DataMember] public bool attested=true;
  [DataMember] public string nonce, phase;
}
static class RelayJobHost {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorking, MaxWorking; public uint ProcessLimit;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long User,Kernel,PeriodUser,PeriodKernel;
    public uint Faults,Total,Active,Terminated;
  }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
    public uint Size; public string Reserved,Desktop,Title;
    public uint X,Y,Width,Height,CharsX,CharsY,Fill,Flags;
    public ushort Show,ReservedBytes; public IntPtr ReservedData,Input,Output,Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Basic; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint ProcessId,ThreadId; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,IntPtr data,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting data,uint size,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr key,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr ps,IntPtr ts,bool inherit,uint flags,IntPtr env,string cwd,ref StartupEx startup,out ProcessInfo process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr from,IntPtr value,IntPtr to,out IntPtr result,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool MoveFileEx(string from,string to,uint flags);

  static T Read<T>(string file) { using(var stream=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))return (T)new DataContractJsonSerializer(typeof(T)).ReadObject(stream); }
  static void Write<T>(string file,T value) {
    string temp=file+"."+Guid.NewGuid().ToString("N")+".tmp";
    try {
      using(var stream=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None)){new DataContractJsonSerializer(typeof(T)).WriteObject(stream,value);stream.Flush(true);}
      for(int i=0;;i++){if(MoveFileEx(temp,file,9))break;if(i>=4)throw new Win32Exception();Thread.Sleep(50*(1<<i));}
    } finally {if(File.Exists(temp))File.Delete(temp);}
  }
  static string Full(string path) {return Path.GetFullPath(path).TrimEnd('\\','/');}
  static bool Same(string a,string b) {return String.Equals(Full(a),Full(b),StringComparison.OrdinalIgnoreCase);}
  static string Name(string nonce) {Guid id;if(!Guid.TryParseExact(nonce,"D",out id))throw new Exception("Invalid domain nonce");return "Local\\CodexRelay-"+nonce;}
  static string ReceiptFile(string home,string nonce){Name(nonce);return Path.Combine(home,"relay-domain-"+nonce+".json");}
  static Mutex HomeMutex(string home){using(var sha=SHA256.Create()){var digest=sha.ComputeHash(Encoding.UTF8.GetBytes(Full(home).ToUpperInvariant()));return new Mutex(false,"Local\\CodexRelayHome-"+BitConverter.ToString(digest).Replace("-",""));}}
  static bool Acquire(Mutex mutex,int timeout){try{return mutex.WaitOne(timeout);}catch(AbandonedMutexException){return true;}}
  static string Created(IntPtr process) {long a,b,c,d;if(!GetProcessTimes(process,out a,out b,out c,out d))throw new Win32Exception();return a.ToString(System.Globalization.CultureInfo.InvariantCulture);}
  static bool Live(int pid,string created) {
    if(pid==0)return false;
    IntPtr handle=OpenProcess(0x100000|0x1000,false,pid);
    if(handle==IntPtr.Zero){if(Marshal.GetLastWin32Error()==87)return false;throw new Win32Exception();}
    try{return Created(handle)==created&&WaitForSingleObject(handle,0)==258;}finally{CloseHandle(handle);}
  }
  static uint Active(IntPtr job) {Accounting data;if(!QueryInformationJobObject(job,1,out data,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero))throw new Win32Exception();return data.Active;}
  static void Empty(IntPtr job) {var end=DateTime.UtcNow.AddSeconds(10);while(Active(job)!=0){if(DateTime.UtcNow>end)throw new Exception("Owned job has not stopped");Thread.Sleep(25);}}
  static string Quote(string text) {
    var result=new StringBuilder("\"");int slashes=0;
    foreach(char c in text){if(c=='\\'){slashes++;continue;}if(c=='\"'){result.Append('\\',slashes*2+1).Append(c);slashes=0;continue;}result.Append('\\',slashes).Append(c);slashes=0;}
    return result.Append('\\',slashes*2).Append('"').ToString();
  }
  static Owner ValidOwner(string file) {
    var owner=Read<Owner>(file);
    if(owner.version!=2||owner.kind!="windows-job"||!Same(Path.GetDirectoryName(file),owner.home))throw new Exception("Unrecognized domain owner");Name(owner.nonce);return owner;
  }
  static Receipt ValidReceipt(Owner owner) {
    var receipt=Read<Receipt>(ReceiptFile(owner.home,owner.nonce));
    if(receipt.version!=1||receipt.nonce!=owner.nonce||receipt.job!=Name(owner.nonce)||receipt.hostPid!=owner.pid||!Same(receipt.home,owner.home)||String.IsNullOrEmpty(receipt.hostCreated))throw new Exception("Domain receipt does not match owner");return receipt;
  }
  static DomainView Inspect(string file,bool stop) {
    return InspectOwner(ValidOwner(file),stop);
  }
  static DomainView InspectOwner(Owner owner,bool stop) {
    var receipt=ValidReceipt(owner);
    IntPtr job=OpenJobObject(stop?0xCu:4u,false,receipt.job);
    if(job==IntPtr.Zero){
      if(Marshal.GetLastWin32Error()!=2)throw new Win32Exception();
      if(Live(receipt.hostPid,receipt.hostCreated)||Live(receipt.rootPid,receipt.rootCreated))throw new Exception("Live process contradicts missing job");
      return new DomainView{nonce=owner.nonce,phase="closed",active=0};
    }
    try {
      if(receipt.rootPid!=0&&Live(receipt.rootPid,receipt.rootCreated)){
        IntPtr root=OpenProcess(0x1000,false,receipt.rootPid);if(root==IntPtr.Zero)throw new Win32Exception();
        try{bool inside;if(!IsProcessInJob(root,job,out inside)||!inside)throw new Exception("Root does not belong to the recorded job");}finally{CloseHandle(root);}
      }
      if(stop){
        // Stop the exact recorded host first; it must not create/resume a root
        // after an empty-job check. Retain this job handle until all members stop.
        IntPtr host=OpenProcess(0x101001,false,receipt.hostPid);
        if(host!=IntPtr.Zero){try{if(Created(host)==receipt.hostCreated&&WaitForSingleObject(host,0)==258){if(!TerminateProcess(host,1)||WaitForSingleObject(host,5000)!=0)throw new Win32Exception();}}finally{CloseHandle(host);}}
        else if(Marshal.GetLastWin32Error()!=87)throw new Win32Exception();
        if(!TerminateJobObject(job,1))throw new Win32Exception();Empty(job);
      }
      int active=(int)Active(job);
      // A host between prepared receipt and CreateProcess still owns admission.
      if(Live(receipt.hostPid,receipt.hostCreated))active++;
      return new DomainView{nonce=owner.nonce,phase=stop?"stopping":receipt.phase,active=active};
    }finally{CloseHandle(job);}
  }
  static DomainView Release(string file,string nonce){
    string home=Full(Path.GetDirectoryName(file));var receipt=Read<Receipt>(ReceiptFile(home,nonce));
    var owner=new Owner{version=2,kind="windows-job",home=home,nonce=nonce,pid=receipt.hostPid};
    var view=InspectOwner(owner,false);if(view.active!=0)throw new Exception("Owned domain is still running");
    // Per-run receipts never overwrite a newer run's evidence.
    receipt.phase="stopped";Write(ReceiptFile(home,nonce),receipt);
    using(var mutex=HomeMutex(home)){
      if(!Acquire(mutex,0)){
        // Another run can already own the same home after a previous release.
        // This receipt proves only the old run closed; never touch the new one.
        if(!File.Exists(file)||ValidOwner(file).nonce!=nonce)return view;
        if(!Acquire(mutex,5000))throw new Exception("Runtime home ownership is changing");
      }
      try{if(File.Exists(file)){var current=ValidOwner(file);if(current.nonce==nonce)File.Delete(file);}}
      finally{mutex.ReleaseMutex();}
    }
    return view;
  }
  static int Run(string file) {
    var request=Read<Launch>(file);if(request.version!=1||!Path.IsPathRooted(request.executable)||!Same(Path.GetDirectoryName(file),request.home)||request.args==null)throw new Exception("Invalid domain launch request");
    string ownerFile=Path.Combine(request.home,"relay-owner.json");
    int hostPid=Process.GetCurrentProcess().Id;Owner owner=null;var deadline=DateTime.UtcNow.AddSeconds(10);
    do {try{owner=ValidOwner(ownerFile);}catch(IOException){}if(owner!=null&&owner.nonce==request.nonce&&owner.pid==hostPid)break;if(DateTime.UtcNow>deadline)throw new Exception("Launch ownership was not acknowledged");Thread.Sleep(20);}while(true);
    using(var mutex=HomeMutex(request.home)){
      if(!Acquire(mutex,0))throw new Exception("Runtime home already has a managed host");
      try{return RunOwned(request,owner,hostPid);}finally{mutex.ReleaseMutex();}
    }
  }
  static int RunOwned(Launch request,Owner owner,int hostPid){
    string jobName=Name(request.nonce),receiptFile=ReceiptFile(request.home,request.nonce);
    IntPtr job=CreateJobObject(IntPtr.Zero,jobName);int jobError=Marshal.GetLastWin32Error();
    if(job==IntPtr.Zero)throw new Win32Exception();if(jobError==183){CloseHandle(job);throw new Exception("Domain name already exists");}
    var receipt=new Receipt{nonce=request.nonce,home=Full(request.home),job=jobName,phase="prepared",hostPid=hostPid,hostCreated=Created(GetCurrentProcess())};
    IntPtr limits=IntPtr.Zero,attributes=IntPtr.Zero,jobList=IntPtr.Zero,handleList=IntPtr.Zero,parent=IntPtr.Zero;var handles=new IntPtr[3];ProcessInfo child=new ProcessInfo();bool initialized=false;
    try {
      parent=OpenProcess(0x101000,false,owner.launcherPid);if(parent==IntPtr.Zero||WaitForSingleObject(parent,0)!=258||Created(parent)!=owner.launcherCreated)throw new Exception("Launcher identity is no longer valid");
      var data=new ExtendedLimits();data.Basic.Flags=0x2000;int size=Marshal.SizeOf(typeof(ExtendedLimits));limits=Marshal.AllocHGlobal(size);Marshal.StructureToPtr(data,limits,false);
      if(!SetInformationJobObject(job,9,limits,(uint)size))throw new Win32Exception();
      Write(receiptFile,receipt); // Durable job identity BEFORE any root can exist.
      IntPtr bytes=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref bytes);attributes=Marshal.AllocHGlobal(bytes);
      if(!InitializeProcThreadAttributeList(attributes,2,0,ref bytes))throw new Win32Exception();initialized=true;
      jobList=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobList,job);
      if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000d),jobList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero))throw new Win32Exception();
      for(int i=0;i<3;i++)if(!DuplicateHandle(GetCurrentProcess(),GetStdHandle(-10-i),GetCurrentProcess(),out handles[i],0,true,2))throw new Win32Exception();
      handleList=Marshal.AllocHGlobal(IntPtr.Size*3);for(int i=0;i<3;i++)Marshal.WriteIntPtr(handleList,i*IntPtr.Size,handles[i]);
      if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handleList,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero))throw new Win32Exception();
      var startup=new StartupEx();startup.Basic.Size=(uint)Marshal.SizeOf(typeof(StartupEx));startup.Basic.Flags=0x100;startup.Basic.Input=handles[0];startup.Basic.Output=handles[1];startup.Basic.Error=handles[2];startup.Attributes=attributes;
      string command=Quote(request.executable)+" "+String.Join(" ",request.args.Select(Quote).ToArray());
      if(!CreateProcess(request.executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08080004,IntPtr.Zero,request.home,ref startup,out child))throw new Win32Exception();
      receipt.rootPid=(int)child.ProcessId;receipt.rootCreated=Created(child.Process);receipt.phase="running";Write(receiptFile,receipt);
      if(ResumeThread(child.Thread)==0xffffffff)throw new Win32Exception();
      while(WaitForSingleObject(child.Process,100)==258)if(WaitForSingleObject(parent,0)!=258)break;
      uint code;if(!GetExitCodeProcess(child.Process,out code))throw new Win32Exception();
      if(!TerminateJobObject(job,1))throw new Win32Exception();Empty(job);
      receipt.phase="stopped";Write(receiptFile,receipt);return (int)code;
    } finally {
      CloseHandle(job); // Also kills contained descendants on every failure path.
      if(child.Thread!=IntPtr.Zero)CloseHandle(child.Thread);if(child.Process!=IntPtr.Zero)CloseHandle(child.Process);
      if(parent!=IntPtr.Zero)CloseHandle(parent);
      foreach(var handle in handles)if(handle!=IntPtr.Zero)CloseHandle(handle);
      if(initialized)DeleteProcThreadAttributeList(attributes);
      foreach(var memory in new[]{limits,attributes,jobList,handleList})if(memory!=IntPtr.Zero)Marshal.FreeHGlobal(memory);
    }
  }
  static int Main(string[] args) {
    try {
      if(args.Length==2&&args[0]=="identity"){
        int pid=Int32.Parse(args[1]);IntPtr process=OpenProcess(0x101000,false,pid);if(process==IntPtr.Zero)throw new Win32Exception();
        try{if(WaitForSingleObject(process,0)!=258)throw new Exception("Requested process exited");using(var stream=Console.OpenStandardOutput())new DataContractJsonSerializer(typeof(Identity)).WriteObject(stream,new Identity{pid=pid,created=Created(process)});return 0;}finally{CloseHandle(process);}
      }
      if(args.Length==3&&args[0]=="stop-run"){
        string home=Full(Path.GetDirectoryName(Path.GetFullPath(args[1]))),nonce=args[2];var receipt=Read<Receipt>(ReceiptFile(home,nonce));
        using(var stream=Console.OpenStandardOutput())new DataContractJsonSerializer(typeof(DomainView)).WriteObject(stream,InspectOwner(new Owner{version=2,kind="windows-job",home=home,nonce=nonce,pid=receipt.hostPid},true));return 0;
      }
      if(args.Length==3&&args[0]=="release"){using(var stream=Console.OpenStandardOutput())new DataContractJsonSerializer(typeof(DomainView)).WriteObject(stream,Release(Path.GetFullPath(args[1]),args[2]));return 0;}
      if(args.Length!=2)throw new Exception("Expected run, inspect or stop with an owned request path");
      if(args[0]=="run")return Run(Path.GetFullPath(args[1]));
      if(args[0]!="inspect"&&args[0]!="stop")throw new Exception("Unknown domain operation");
      using(var stream=Console.OpenStandardOutput())new DataContractJsonSerializer(typeof(DomainView)).WriteObject(stream,Inspect(Path.GetFullPath(args[1]),args[0]=="stop"));return 0;
    }catch(Exception error){Console.Error.WriteLine("Windows process domain failed: "+error.Message);return 90;}
  }
}
