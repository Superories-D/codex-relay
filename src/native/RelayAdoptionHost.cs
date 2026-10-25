// Windows regular-file adoption primitive. Every move uses the locked file handle,
// never a second pathname lookup; replacement destinations are always exclusive.
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
using System.Security.AccessControl;
using Microsoft.Win32.SafeHandles;

[DataContract] sealed class AdoptionFileProof {
  [DataMember] public string dev,ino,sha256;
  [DataMember] public long bytes;
}
[DataContract] sealed class AdoptionMetadata {
  [DataMember] public uint attributes,links;
  [DataMember] public string security,securitySha256,created,modified;
  [DataMember] public string[] streams;
}
[DataContract] sealed class AdoptionDirectoryProof {
  [DataMember] public string path,dev,ino;
}
[DataContract] sealed class AdoptionMetadataSource {
  [DataMember] public string path;
  [DataMember] public AdoptionFileProof proof;
  [DataMember] public AdoptionMetadata metadata;
}
[DataContract] sealed class AdoptionOwner {
  [DataMember] public int version;
  [DataMember] public string id,owner,root;
}
[DataContract] sealed class AdoptionRequest {
  [DataMember] public int version;
  [DataMember] public string id,transactionId,owner,home,root,path,action,stage;
  [DataMember] public AdoptionFileProof before,after;
  [DataMember] public AdoptionMetadata beforeMetadata,afterMetadata;
  [DataMember] public AdoptionMetadataSource metadataSource;
  [DataMember] public bool restoreMetadata;
  [DataMember] public AdoptionDirectoryProof[] directories;
}
[DataContract] sealed class AdoptionReceipt {
  [DataMember] public int version=1;
  [DataMember] public string id,transactionId,requestSha256,phase;
  [DataMember] public AdoptionFileProof before,after;
}
[DataContract] sealed class AdoptionInspection {
  [DataMember] public int version=1;
  [DataMember] public string id,transactionId;
  [DataMember] public bool prepared,applied;
  [DataMember] public AdoptionFileProof target,stage,backup,beforeCopy;
  [DataMember] public AdoptionMetadata targetMetadata,stageMetadata,backupMetadata;
}
static class RelayAdoptionHost {
  const uint Read=0x80000000,Delete=0x10000,ReadAttributes=0x80,ShareRead=1,ShareWrite=2,OpenExisting=3,BackupSemantics=0x02000000,OpenReparse=0x00200000;
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
    public uint Attributes;public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write;
    public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string name,uint access,uint sharing,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out FileInfo info);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,StringBuilder name,uint length,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle,int kind,IntPtr info,uint length);
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct StreamInfo {public long Size;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=296)]public string Name;}
  [StructLayout(LayoutKind.Sequential)] struct BasicInfo {public long Creation,Access,Write,Change;public uint Attributes;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr FindFirstStreamW(string file,int level,out StreamInfo info,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool FindNextStreamW(IntPtr search,out StreamInfo info);
  [DllImport("kernel32.dll")] static extern bool FindClose(IntPtr search);
  [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle handle,int kind,uint flags,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll",SetLastError=true)] static extern uint SetSecurityInfo(SafeFileHandle handle,int kind,uint flags,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorControl(IntPtr descriptor,out ushort control,out uint revision);
  [DllImport("advapi32.dll")] static extern bool EqualSid(IntPtr left,IntPtr right);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  static string Full(string path){var value=Path.GetFullPath(path);return value.Length>Path.GetPathRoot(value).Length?value.TrimEnd('\\'):value;}
  static string Native(string path){path=Full(path);return path.StartsWith("\\\\")?"\\\\?\\UNC\\"+path.Substring(2):"\\\\?\\"+path;}
  static bool Same(string left,string right){return String.Equals(Full(left),Full(right),StringComparison.OrdinalIgnoreCase);}
  static bool Within(string root,string file){return Full(file).StartsWith(Full(root).TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase);}
  static void Uuid(string value){Guid parsed;if(!Guid.TryParseExact(value,"D",out parsed))throw new Exception("Invalid adoption identity");}
  static string Relative(string value){
    if(String.IsNullOrEmpty(value)||value.Contains('\\')||value.StartsWith("/")||value.Any(c=>c<32||c==':'))throw new Exception("Invalid adoption relative path");
    foreach(var part in value.Split('/'))if(String.IsNullOrEmpty(part)||part=="."||part==".."||part.Equals(".git",StringComparison.OrdinalIgnoreCase)||part.EndsWith(".")||part.EndsWith(" ")||System.Text.RegularExpressions.Regex.IsMatch(part,@"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)",System.Text.RegularExpressions.RegexOptions.IgnoreCase))throw new Exception("Invalid adoption path component");return value;
  }
  static FileInfo Info(SafeFileHandle handle){FileInfo info;if(!GetFileInformationByHandle(handle,out info))throw new Win32Exception();return info;}
  static string Inode(FileInfo info){return (((ulong)info.IndexHigh<<32)|info.IndexLow).ToString(System.Globalization.CultureInfo.InvariantCulture);}
  static string Final(SafeFileHandle handle){var buffer=new StringBuilder(32768);var length=GetFinalPathNameByHandleW(handle,buffer,(uint)buffer.Capacity,0);if(length==0||length>=buffer.Capacity)throw new Win32Exception();var result=buffer.ToString();if(result.StartsWith("\\\\?\\UNC\\"))return "\\\\"+result.Substring(8);return result.StartsWith("\\\\?\\")?result.Substring(4):result;}
  static SafeFileHandle Open(string file,bool directory,bool mutable,bool metadataWrite=false){
    var handle=CreateFileW(Native(file),directory?ReadAttributes:Read|(mutable?Delete:0)|(metadataWrite?0x40100U:0),directory?ShareRead|ShareWrite:ShareRead,IntPtr.Zero,OpenExisting,OpenReparse|(directory?BackupSemantics:0),IntPtr.Zero);
    if(handle.IsInvalid){handle.Dispose();throw new Win32Exception();}try{var info=Info(handle);if((info.Attributes&0x400)!=0||((info.Attributes&0x10)!=0)!=directory||!Same(Final(handle),file))throw new Exception("Adoption path identity or reparse state changed");return handle;}catch{handle.Dispose();throw;}
  }
  static string Hash(byte[] bytes){using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
  static T Deserialize<T>(byte[] bytes){using(var input=new MemoryStream(bytes))return (T)new DataContractJsonSerializer(typeof(T)).ReadObject(input);}
  static byte[] ReadBytes(string file){using(var handle=Open(file,false,false))using(var stream=new FileStream(handle,FileAccess.Read))using(var output=new MemoryStream()){stream.CopyTo(output);return output.ToArray();}}
  static void Save(string file,object value){using(var stream=new FileStream(Native(file),FileMode.CreateNew,FileAccess.Write,FileShare.Read,65536,FileOptions.WriteThrough)){new DataContractJsonSerializer(value.GetType()).WriteObject(stream,value);stream.Flush(true);}}
  static AdoptionFileProof Proof(SafeFileHandle handle){
    var before=Info(handle);using(var borrowed=new SafeFileHandle(handle.DangerousGetHandle(),false))using(var stream=new FileStream(borrowed,FileAccess.Read,262144,false))using(var hash=SHA256.Create()){
      stream.Position=0;var digest=BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant();var after=Info(handle);
      if(before.IndexHigh!=after.IndexHigh||before.IndexLow!=after.IndexLow||before.Volume!=after.Volume||before.SizeHigh!=after.SizeHigh||before.SizeLow!=after.SizeLow||before.Write.dwHighDateTime!=after.Write.dwHighDateTime||before.Write.dwLowDateTime!=after.Write.dwLowDateTime)throw new Exception("Adoption file changed while being read");
      return new AdoptionFileProof{dev=after.Volume.ToString(System.Globalization.CultureInfo.InvariantCulture),ino=Inode(after),bytes=((long)after.SizeHigh<<32)|after.SizeLow,sha256=digest};
    }
  }
  static void Match(AdoptionFileProof actual,AdoptionFileProof expected){if(expected==null||actual.bytes!=expected.bytes||actual.sha256!=expected.sha256||actual.dev!=expected.dev||actual.ino!=expected.ino)throw new Exception("Adoption file no longer matches the reviewed identity and complete bytes");}
  static void Copy(SafeFileHandle handle,string destination){using(var borrowed=new SafeFileHandle(handle.DangerousGetHandle(),false))using(var input=new FileStream(borrowed,FileAccess.Read,262144,false))using(var output=new FileStream(Native(destination),FileMode.CreateNew,FileAccess.Write,FileShare.Read,262144,FileOptions.WriteThrough)){input.Position=0;input.CopyTo(output);output.Flush(true);}}
  static long Time(System.Runtime.InteropServices.ComTypes.FILETIME value){return ((long)(uint)value.dwHighDateTime<<32)|(uint)value.dwLowDateTime;}
  static AdoptionMetadata Metadata(SafeFileHandle handle){
    IntPtr owner,group,dacl,sacl,descriptor;var code=GetSecurityInfo(handle,1,7,out owner,out group,out dacl,out sacl,out descriptor);if(code!=0)throw new Win32Exception((int)code);
    byte[] security;try{security=new byte[GetSecurityDescriptorLength(descriptor)];Marshal.Copy(descriptor,security,0,security.Length);}finally{LocalFree(descriptor);}
    var info=Info(handle);var streams=new List<string>();StreamInfo stream;var search=FindFirstStreamW(Native(Final(handle)),0,out stream,0);if(search==new IntPtr(-1)){var error=Marshal.GetLastWin32Error();if(error!=38&&error!=87)throw new Win32Exception(error);}else try{do{streams.Add(stream.Name);}while(FindNextStreamW(search,out stream));var error=Marshal.GetLastWin32Error();if(error!=38)throw new Win32Exception(error);}finally{FindClose(search);}
    return new AdoptionMetadata{attributes=info.Attributes,links=info.Links,security=Convert.ToBase64String(security),securitySha256=Hash(security),created=Time(info.Creation).ToString(),modified=Time(info.Write).ToString(),streams=streams.ToArray()};
  }
  static void OrdinaryMetadata(AdoptionMetadata metadata){
    if(metadata.links!=1||metadata.streams.Any(name=>name!="::$DATA")||(metadata.attributes&~0x21A7U)!=0)throw new Exception("Adoption requires an explicit plan for hardlinks, alternate streams or special storage attributes");
  }
  static void MatchMetadata(AdoptionMetadata actual,AdoptionMetadata expected){if(expected==null||actual.attributes!=expected.attributes||actual.links!=expected.links||actual.created!=expected.created||actual.modified!=expected.modified||actual.securitySha256!=expected.securitySha256||!actual.streams.SequenceEqual(expected.streams))throw new Exception("Adoption metadata no longer matches the reviewed permissions, attributes or streams");}
  static void Security(SafeFileHandle original,SafeFileHandle replacement,bool temporaryProtection){
    IntPtr owner,group,dacl,sacl,descriptor;var code=GetSecurityInfo(original,1,7,out owner,out group,out dacl,out sacl,out descriptor);if(code!=0)throw new Win32Exception((int)code);try{
      IntPtr targetOwner,targetGroup,targetDacl,targetSacl,targetDescriptor;code=GetSecurityInfo(replacement,1,7,out targetOwner,out targetGroup,out targetDacl,out targetSacl,out targetDescriptor);if(code!=0)throw new Win32Exception((int)code);try{if(!EqualSid(owner,targetOwner)||!EqualSid(group,targetGroup))throw new Exception("Adoption requires an explicit ownership transfer plan");}finally{LocalFree(targetDescriptor);}
      ushort control;uint revision;if(!GetSecurityDescriptorControl(descriptor,out control,out revision))throw new Win32Exception();var flags=4U|(temporaryProtection||(control&0x1000)!=0?0x80000000U:0x20000000U);code=SetSecurityInfo(replacement,1,flags,IntPtr.Zero,IntPtr.Zero,dacl,IntPtr.Zero);if(code!=0)throw new Win32Exception((int)code);
    }finally{LocalFree(descriptor);}
  }
  static void Attributes(SafeFileHandle original,SafeFileHandle replacement,bool restoreModified){
    var source=Info(original);var value=new BasicInfo{Creation=Time(source.Creation),Access=0,Write=restoreModified?Time(source.Write):0,Change=0,Attributes=source.Attributes};var size=Marshal.SizeOf(typeof(BasicInfo));var memory=Marshal.AllocHGlobal(size);try{Marshal.StructureToPtr(value,memory,false);if(!SetFileInformationByHandle(replacement,0,memory,(uint)size))throw new Win32Exception();}finally{Marshal.FreeHGlobal(memory);}
  }
  static void Move(SafeFileHandle handle,string destination){
    // FILE_RENAME_INFO: BOOLEAN at0, pointer at8, DWORD at16, UTF16 name at20.
    var name=Encoding.Unicode.GetBytes(Native(destination));var memory=Marshal.AllocHGlobal(22+name.Length);try{for(int index=0;index<22+name.Length;index++)Marshal.WriteByte(memory,index,0);Marshal.WriteIntPtr(memory,8,IntPtr.Zero);Marshal.WriteInt32(memory,16,name.Length);Marshal.Copy(name,0,IntPtr.Add(memory,20),name.Length);if(!SetFileInformationByHandle(handle,3,memory,(uint)(22+name.Length)))throw new Win32Exception();var actual=Final(handle);if(!Same(actual,destination))throw new Exception("Adoption move did not retain its owned destination");}finally{Marshal.FreeHGlobal(memory);}
  }
  static AdoptionFileProof OptionalProof(string file){try{using(var handle=Open(file,false,false))return Proof(handle);}catch(Win32Exception error){if(error.NativeErrorCode==2||error.NativeErrorCode==3)return null;throw;}}
  static AdoptionMetadata OptionalMetadata(string file){try{using(var handle=Open(file,false,false))return Metadata(handle);}catch(Win32Exception error){if(error.NativeErrorCode==2||error.NativeErrorCode==3)return null;throw;}}
  static bool ReceiptExists(string file,AdoptionRequest request,string requestSha,string phase){
    try{var receipt=Deserialize<AdoptionReceipt>(ReadBytes(file));if(receipt.version!=1||receipt.id!=request.id||receipt.transactionId!=request.transactionId||receipt.requestSha256!=requestSha||receipt.phase!=phase)throw new Exception("Adoption receipt does not match its bound request");return true;}
    catch(Win32Exception error){if(error.NativeErrorCode==2||error.NativeErrorCode==3)return false;throw;}
  }
  static void RequireParents(string file,Dictionary<string,AdoptionDirectoryProof> expected){for(var parent=Path.GetDirectoryName(Full(file));!String.IsNullOrEmpty(parent);parent=Path.GetDirectoryName(parent))if(!expected.ContainsKey(Full(parent)))throw new Exception("Adoption ancestor lacks an identity guard");}
  static int Run(string command,string requestFile,string expectedSha){
    var requestBytes=ReadBytes(requestFile);if(Hash(requestBytes)!=expectedSha)throw new Exception("Adoption request fingerprint changed");var request=Deserialize<AdoptionRequest>(requestBytes);Uuid(request.id);Uuid(request.transactionId);Uuid(request.owner);
    if(request.version!=1||!new[]{"create","replace","delete"}.Contains(request.action)||!Within(request.home,requestFile)||Same(request.root,request.home)||Within(request.root,request.home)||!Same(Path.GetPathRoot(request.root),Path.GetPathRoot(request.home)))throw new Exception("Invalid adoption transaction scope");
    string target=Path.Combine(Full(request.root),Relative(request.path).Replace('/',Path.DirectorySeparatorChar)),stage=request.stage==null?null:Path.Combine(Full(request.home),Relative(request.stage).Replace('/',Path.DirectorySeparatorChar)),backup=Path.Combine(Full(request.home),"actual",request.id),beforeCopy=Path.Combine(Full(request.home),"before",request.id),prepared=Path.Combine(Full(request.home),"receipts",request.id+".prepared.json"),applied=Path.Combine(Full(request.home),"receipts",request.id+".applied.json");
    if(!Within(request.root,target)||request.action=="create"&&request.before!=null||request.action!="create"&&request.before==null||request.action=="delete"&&(stage!=null||request.after!=null)||request.action!="delete"&&(stage==null||request.after==null))throw new Exception("Invalid adoption file transition");
    string metadataFile=null;if(request.restoreMetadata&&request.metadataSource==null)throw new Exception("Restored adoption metadata requires its independent original");if(request.metadataSource!=null){if(request.action=="delete"||!System.Text.RegularExpressions.Regex.IsMatch(request.metadataSource.path??"",@"^actual/[a-fA-F0-9-]{36}$"))throw new Exception("Invalid retained adoption metadata source");Uuid(request.metadataSource.path.Substring(7));metadataFile=Path.Combine(Full(request.home),request.metadataSource.path.Replace('/',Path.DirectorySeparatorChar));}
    var directories=new Dictionary<string,AdoptionDirectoryProof>(StringComparer.OrdinalIgnoreCase);foreach(var directory in request.directories??new AdoptionDirectoryProof[0]){var name=Full(directory.path);if(directories.ContainsKey(name))throw new Exception("Duplicate adoption directory guard");directories.Add(name,directory);}foreach(var file in new[]{target,backup,beforeCopy,prepared,applied,requestFile,Path.Combine(request.home,".relay-adoption.json")}.Concat(stage==null?new string[0]:new[]{stage}).Concat(metadataFile==null?new string[0]:new[]{metadataFile}))RequireParents(file,directories);
    var held=new List<SafeFileHandle>();try{
      foreach(var directory in directories.OrderBy(pair=>pair.Key.Length)){var handle=Open(directory.Key,true,false);held.Add(handle);var info=Info(handle);if(info.Volume.ToString(System.Globalization.CultureInfo.InvariantCulture)!=directory.Value.dev||Inode(info)!=directory.Value.ino)throw new Exception("Adoption ancestor identity changed");}
      var owner=Deserialize<AdoptionOwner>(ReadBytes(Path.Combine(request.home,".relay-adoption.json")));if(owner.version!=1||owner.id!=request.transactionId||owner.owner!=request.owner||!Same(owner.root,request.root))throw new Exception("Adoption home ownership changed");
      if(command=="inspect"){var view=new AdoptionInspection{id=request.id,transactionId=request.transactionId,target=OptionalProof(target),stage=stage==null?null:OptionalProof(stage),backup=OptionalProof(backup),beforeCopy=OptionalProof(beforeCopy),targetMetadata=OptionalMetadata(target),stageMetadata=stage==null?null:OptionalMetadata(stage),backupMetadata=OptionalMetadata(backup),prepared=ReceiptExists(prepared,request,expectedSha,"prepared"),applied=ReceiptExists(applied,request,expectedSha,"applied")};using(var output=Console.OpenStandardOutput())new DataContractJsonSerializer(typeof(AdoptionInspection)).WriteObject(output,view);return 0;}
      if(command!="apply")throw new Exception("Unknown adoption operation");if(File.Exists(Native(prepared))||File.Exists(Native(applied))||File.Exists(Native(backup))||File.Exists(Native(beforeCopy)))throw new Exception("Adoption transition already started; inspect its durable state");
      SafeFileHandle original=null,replacement=null,metadataSource=null;try{
        if(request.before!=null){original=Open(target,false,true);Match(Proof(original),request.before);var metadata=Metadata(original);MatchMetadata(metadata,request.beforeMetadata);OrdinaryMetadata(metadata);Copy(original,beforeCopy);using(var proof=Open(beforeCopy,false,false)){var copied=Proof(proof);if(copied.sha256!=request.before.sha256||copied.bytes!=request.before.bytes)throw new Exception("Independent adoption backup failed complete verification");}}
        else if(OptionalProof(target)!=null)throw new Exception("Adoption destination already exists");
        if(metadataFile!=null){metadataSource=Open(metadataFile,false,false);Match(Proof(metadataSource),request.metadataSource.proof);MatchMetadata(Metadata(metadataSource),request.metadataSource.metadata);OrdinaryMetadata(request.metadataSource.metadata);}
        var metadataOriginal=metadataSource??original;
        if(stage!=null){replacement=Open(stage,false,true,true);Match(Proof(replacement),request.after);var metadata=Metadata(replacement);MatchMetadata(metadata,request.afterMetadata);OrdinaryMetadata(metadata);if(metadataOriginal!=null){Security(metadataOriginal,replacement,true);Attributes(metadataOriginal,replacement,request.restoreMetadata);}}
        Save(prepared,new AdoptionReceipt{id=request.id,transactionId=request.transactionId,requestSha256=expectedSha,phase="prepared",before=request.before,after=request.after});
        if(original!=null)Move(original,backup);if(replacement!=null){Move(replacement,target);if(metadataOriginal!=null)Security(metadataOriginal,replacement,false);}
        var before=original==null?null:Proof(original);var after=replacement==null?null:Proof(replacement);
        // A pre-existing writable mapping can bypass normal write-handle sharing.
        // Never seal success from the initial hash alone; partial state stays inspectable.
        if(before!=null){Match(before,request.before);MatchMetadata(Metadata(original),request.beforeMetadata);}if(after!=null){Match(after,request.after);var expected=request.metadataSource!=null?request.metadataSource.metadata:request.beforeMetadata;var actual=Metadata(replacement);if(expected!=null&&(actual.securitySha256!=expected.securitySha256||actual.attributes!=expected.attributes||actual.created!=expected.created||request.restoreMetadata&&actual.modified!=expected.modified))throw new Exception("Adopted permissions or attributes did not match the reviewed original");}
        var receipt=new AdoptionReceipt{id=request.id,transactionId=request.transactionId,requestSha256=expectedSha,phase="applied",before=before,after=after};Save(applied,receipt);using(var output=Console.OpenStandardOutput())new DataContractJsonSerializer(typeof(AdoptionReceipt)).WriteObject(output,receipt);return 0;
      }finally{if(replacement!=null)replacement.Dispose();if(original!=null)original.Dispose();if(metadataSource!=null)metadataSource.Dispose();}
    }finally{foreach(var handle in held)handle.Dispose();}
  }
  static int Main(string[] args){AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling",false);AppContext.SetSwitch("Switch.System.IO.BlockLongPaths",false);Console.OutputEncoding=new UTF8Encoding(false);try{if(args.Length!=3)throw new Exception("Expected operation, owned request and fingerprint");return Run(args[0],Full(args[1]),args[2]);}catch(Exception error){Console.Error.WriteLine("Windows file adoption failed: "+error);return 91;}}
}
