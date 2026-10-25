// Hold conventional Git metadata/ref locks with delete-on-close handles. Windows
// removes them even when the owning Job Object is forcibly terminated.
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

[DataContract] sealed class LeaseDirectory { [DataMember] public string path,dev,ino; }
[DataContract] sealed class LeaseRepository { [DataMember] public string gitDir,commonDir,index,branch; }
[DataContract] sealed class LeaseRequest {
  [DataMember] public int version;
  [DataMember] public string id,owner,home;
  [DataMember] public LeaseRepository[] repositories;
  [DataMember] public LeaseDirectory[] directories;
}
[DataContract] sealed class LeaseOwner { [DataMember] public int version; [DataMember] public string id,owner; }
[DataContract] sealed class LeaseProof { [DataMember] public string file,dev,ino,sha256; [DataMember] public long bytes; }
[DataContract] sealed class LeaseReady { [DataMember] public int version=1; [DataMember] public string id,requestSha256,phase; [DataMember] public LeaseProof[] locks; }
static class RelayRepositoryLeaseHost {
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {public uint Attributes;public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string path,uint access,uint sharing,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file,out FileInfo info);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle file,StringBuilder name,uint length,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectoryW(string file,IntPtr security);
  static string Full(string value){var path=Path.GetFullPath(value);return path.Length>Path.GetPathRoot(path).Length?path.TrimEnd('\\'):path;}
  static string Native(string value){value=Full(value);return value.StartsWith("\\\\")?"\\\\?\\UNC\\"+value.Substring(2):"\\\\?\\"+value;}
  static bool Same(string a,string b){return String.Equals(Full(a),Full(b),StringComparison.OrdinalIgnoreCase);}
  static bool Within(string parent,string file){return Full(file).StartsWith(Full(parent).TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase);}
  static void Uuid(string value){Guid id;if(!Guid.TryParseExact(value,"D",out id))throw new Exception("Invalid repository lease identity");}
  static FileInfo Info(SafeFileHandle file){FileInfo info;if(!GetFileInformationByHandle(file,out info))throw new Win32Exception();return info;}
  static string Inode(FileInfo info){return (((ulong)info.IndexHigh<<32)|info.IndexLow).ToString(System.Globalization.CultureInfo.InvariantCulture);}
  static string Final(SafeFileHandle file){var value=new StringBuilder(32768);var count=GetFinalPathNameByHandleW(file,value,(uint)value.Capacity,0);if(count==0||count>=value.Capacity)throw new Win32Exception();var path=value.ToString();return path.StartsWith("\\\\?\\UNC\\")?"\\\\"+path.Substring(8):path.StartsWith("\\\\?\\")?path.Substring(4):path;}
  static string Hash(byte[] bytes){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
  static T Read<T>(string path){using(var handle=CreateFileW(Native(path),0x80000000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero)){
    if(handle.IsInvalid)throw new Win32Exception();var info=Info(handle);if((info.Attributes&0x410)!=0||!Same(Final(handle),path))throw new Exception("Repository lease control file changed");using(var stream=new FileStream(handle,FileAccess.Read))return (T)new DataContractJsonSerializer(typeof(T)).ReadObject(stream);
  }}
  static SafeFileHandle Directory(string path){var handle=CreateFileW(Native(path),0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);if(handle.IsInvalid){handle.Dispose();throw new Win32Exception();}try{var info=Info(handle);if((info.Attributes&0x410)!=0x10||!Same(Final(handle),path))throw new Exception("Repository lease directory changed");return handle;}catch{handle.Dispose();throw;}}
  static string Ref(string name){if(String.IsNullOrEmpty(name))return null;if(!name.StartsWith("refs/")||name.Any(c=>c<33||c=='\\'||c==':'||c=='"')||name.Split('/').Any(part=>String.IsNullOrEmpty(part)||part=="."||part==".."||part.EndsWith(".")||part.EndsWith(" ")||System.Text.RegularExpressions.Regex.IsMatch(part,@"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)",System.Text.RegularExpressions.RegexOptions.IgnoreCase)))throw new Exception("Invalid reviewed Git ref name");return name.Replace('/',Path.DirectorySeparatorChar);}
  static void Output(LeaseReady result){var serializer=new DataContractJsonSerializer(typeof(LeaseReady));using(var buffer=new MemoryStream()){serializer.WriteObject(buffer,result);Console.Out.WriteLine(Encoding.UTF8.GetString(buffer.ToArray()));Console.Out.Flush();}}
  static int Run(string requestFile,string expectedSha){
    byte[] bytes;using(var handle=CreateFileW(Native(requestFile),0x80000000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero)){
      if(handle.IsInvalid)throw new Win32Exception();if((Info(handle).Attributes&0x410)!=0||!Same(Final(handle),requestFile))throw new Exception("Repository lease request path changed");using(var input=new FileStream(handle,FileAccess.Read))using(var buffer=new MemoryStream()){input.CopyTo(buffer);bytes=buffer.ToArray();}
    }
    if(Hash(bytes)!=expectedSha)throw new Exception("Repository lease request fingerprint changed");LeaseRequest request;using(var input=new MemoryStream(bytes))request=(LeaseRequest)new DataContractJsonSerializer(typeof(LeaseRequest)).ReadObject(input);Uuid(request.id);Uuid(request.owner);
    if(request.version!=1||!Within(request.home,requestFile)||request.repositories==null||request.repositories.Length==0)throw new Exception("Invalid repository lease scope");
    var expected=new Dictionary<string,LeaseDirectory>(StringComparer.OrdinalIgnoreCase);foreach(var value in request.directories??new LeaseDirectory[0]){if(expected.ContainsKey(Full(value.path)))throw new Exception("Duplicate repository lease parent");expected.Add(Full(value.path),value);}
    var held=new Dictionary<string,SafeFileHandle>(StringComparer.OrdinalIgnoreCase);var streams=new List<FileStream>();
    try{
      foreach(var value in expected.Values.OrderBy(value=>value.path.Length)){var parent=Path.GetDirectoryName(Full(value.path));if(parent!=null&&!expected.ContainsKey(Full(parent)))throw new Exception("Repository lease ancestor lacks a guard");var handle=Directory(value.path);held.Add(Full(value.path),handle);var info=Info(handle);if(info.Volume.ToString()!=value.dev||Inode(info)!=value.ino)throw new Exception("Repository lease ancestor identity changed");}
      if(!held.ContainsKey(Full(request.home))||!held.ContainsKey(Full(Path.GetDirectoryName(requestFile))))throw new Exception("Unprotected repository lease request");var owner=Read<LeaseOwner>(Path.Combine(request.home,".relay-repository-lease.json"));if(owner.version!=1||owner.id!=request.id||owner.owner!=request.owner)throw new Exception("Repository lease home ownership changed");
      var locks=new SortedSet<string>(StringComparer.OrdinalIgnoreCase);foreach(var repository in request.repositories){
        if(!held.ContainsKey(Full(repository.gitDir))||!held.ContainsKey(Full(repository.commonDir))||!Same(repository.index,Path.Combine(repository.gitDir,"index")))throw new Exception("Invalid reviewed Git metadata layout");
        locks.Add(Full(repository.index+".lock"));locks.Add(Path.Combine(Full(repository.commonDir),"config.lock"));locks.Add(Path.Combine(Full(repository.gitDir),"config.worktree.lock"));locks.Add(Path.Combine(Full(repository.commonDir),"packed-refs.lock"));locks.Add(Path.Combine(Full(repository.commonDir),"shallow.lock"));locks.Add(Path.Combine(Full(repository.gitDir),"HEAD.lock"));
        var branch=Ref(repository.branch);if(branch!=null){var file=Path.Combine(Full(repository.commonDir),branch+".lock");if(!Within(repository.commonDir,file))throw new Exception("Repository lease ref escaped its scope");var parts=branch.Split(Path.DirectorySeparatorChar);var folder=Full(repository.commonDir);foreach(var part in parts.Take(parts.Length-1)){folder=Path.Combine(folder,part);if(!held.ContainsKey(folder)){if(!CreateDirectoryW(Native(folder),IntPtr.Zero)&&Marshal.GetLastWin32Error()!=183)throw new Win32Exception();held.Add(folder,Directory(folder));}}locks.Add(file);}
      }
      var claim=Encoding.UTF8.GetBytes("Codex Relay repository lease "+request.id+" "+expectedSha+"\n");var proofs=new List<LeaseProof>();
      foreach(var file in locks){if(!held.ContainsKey(Full(Path.GetDirectoryName(file))))throw new Exception("Repository lock parent is not held");var handle=CreateFileW(Native(file),0xC0010000,1,IntPtr.Zero,1,0x84200000,IntPtr.Zero);if(handle.IsInvalid){handle.Dispose();throw new Win32Exception();}var stream=new FileStream(handle,FileAccess.ReadWrite,65536,false);streams.Add(stream);var info=Info(handle);if((info.Attributes&0x410)!=0||!Same(Final(handle),file))throw new Exception("Repository lock was redirected");stream.Write(claim,0,claim.Length);stream.Flush(true);proofs.Add(new LeaseProof{file=file,dev=info.Volume.ToString(),ino=Inode(info),bytes=claim.Length,sha256=Hash(claim)});}
      Output(new LeaseReady{id=request.id,requestSha256=expectedSha,phase="held",locks=proofs.ToArray()});var release=Console.In.ReadLine();if(release!=null&&release!="release "+request.id)throw new Exception("Invalid repository lease release");
    }finally{foreach(var stream in streams.AsEnumerable().Reverse())stream.Dispose();foreach(var handle in held.Values.Reverse())handle.Dispose();}
    Output(new LeaseReady{id=request.id,requestSha256=expectedSha,phase="released",locks=new LeaseProof[0]});return 0;
  }
  static int Main(string[] args){AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling",false);AppContext.SetSwitch("Switch.System.IO.BlockLongPaths",false);Console.OutputEncoding=new UTF8Encoding(false);try{if(args.Length!=2)throw new Exception("Expected guarded repository lease request and fingerprint");return Run(Full(args[0]),args[1]);}catch(Exception error){Console.Error.WriteLine("Repository lease failed: "+error);return 92;}}
}
