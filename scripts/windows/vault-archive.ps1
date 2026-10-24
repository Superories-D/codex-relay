param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
try {
  [AppContext]::SetSwitch('Switch.System.IO.UseLegacyPathHandling',$false)
  [AppContext]::SetSwitch('Switch.System.IO.BlockLongPaths',$false)
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -ReferencedAssemblies System.IO.Compression -TypeDefinition @'
using System;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Collections.Generic;
using System.Diagnostics;
public static class RelayVaultArchive {
  static readonly byte[] Empty = new byte[0];
  static string Hex(byte[] value) { return BitConverter.ToString(value).Replace("-", "").ToLowerInvariant(); }
  static string Source(string root, string relative) {
    if (String.IsNullOrEmpty(relative) || relative.IndexOf(':') >= 0 || relative[0]=='/' || relative[0]=='\\') throw new IOException("Invalid bundle path");
    var current=root;
    foreach(var part in relative.Split('/', '\\')) {
      if(String.IsNullOrEmpty(part) || part=="." || part=="..") throw new IOException("Invalid bundle path");
      foreach(char c in part) if(c<32) throw new IOException("Invalid bundle path");
      current=Path.Combine(current,part);
      if((File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0) throw new IOException("Reparse point in bundle");
    }
    var full=Path.GetFullPath(current);
    if(!full.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase) || (File.GetAttributes(full)&FileAttributes.Directory)!=0) throw new IOException("Artifact outside bundle");
    return full;
  }
  static void Progress(string phase,long bytes,long total,int files,int count) {
    Console.WriteLine("{\"phase\":\""+phase+"\",\"bytes\":"+bytes+",\"totalBytes\":"+total+",\"files\":"+files+",\"totalFiles\":"+count+"}");
  }
  static long CopyHash(Stream source,Stream output,byte[] buffer,long expected,string digest,Action<long> progress) {
    long count=0;var clock=Stopwatch.StartNew();
    using(var hash=SHA256.Create()) {
      int read;
      while((read=source.Read(buffer,0,buffer.Length))>0) {
        count+=read;if(count>expected) throw new IOException("File exceeds accepted length");
        hash.TransformBlock(buffer,0,read,buffer,0);if(output!=null) output.Write(buffer,0,read);
        if(clock.ElapsedMilliseconds>=250){progress(count);clock.Restart();}
      }
      hash.TransformFinalBlock(Empty,0,0);
      if(count!=expected || Hex(hash.Hash)!=digest) throw new IOException("File fingerprint mismatch");
    }
    progress(count);return count;
  }
  public static void Run(string directory,string output,string[] names,long[] sizes,string[] digests) {
    if(names.Length==0 || names.Length!=sizes.Length || names.Length!=digests.Length) throw new IOException("Invalid file list");
    var root=Path.GetFullPath(directory);var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);long total=0;
    for(int i=0;i<names.Length;i++) {
      if(!seen.Add(names[i]) || names[i].IndexOf('\\')>=0 || sizes[i]<0 || digests[i].Length!=64) throw new IOException("Invalid file list");
      Source(root,names[i]);total=checked(total+sizes[i]);
    }
    var buffer=new byte[1024*1024];
    using(var file=new FileStream(output,FileMode.Open,FileAccess.ReadWrite,FileShare.Read,1024*1024,FileOptions.SequentialScan)) {
      if(file.Length!=0) throw new IOException("Output is not empty");
      using(var zip=new ZipArchive(file,ZipArchiveMode.Create,true,System.Text.Encoding.UTF8)) {
        long done=0;
        for(int i=0;i<names.Length;i++) {
          Progress("packing",done,total,i,names.Length);
          string source=Source(root,names[i]);var modified=File.GetLastWriteTimeUtc(source);
          using(var input=new FileStream(source,FileMode.Open,FileAccess.Read,FileShare.Read,buffer.Length,FileOptions.SequentialScan)) {
            if(input.Length!=sizes[i]) throw new IOException("File length changed");
            var entry=zip.CreateEntry(names[i],CompressionLevel.Fastest);
            // Stable, valid DOS timestamp; provenance times remain in manifest.json.
            entry.LastWriteTime=new DateTimeOffset(2000,1,1,0,0,0,TimeSpan.Zero);
            using(var stream=entry.Open()) CopyHash(input,stream,buffer,sizes[i],digests[i],n=>Progress("packing",done+n,total,i,names.Length));
            if(input.Length!=sizes[i] || File.GetLastWriteTimeUtc(source)!=modified) throw new IOException("File changed during export");
          }
          done+=sizes[i];
        }
      }
      file.Flush(true);file.Position=0;
      using(var zip=new ZipArchive(file,ZipArchiveMode.Read,true,System.Text.Encoding.UTF8)) {
        if(zip.Entries.Count!=names.Length) throw new IOException("Archive entry count mismatch");
        var expected=new Dictionary<string,int>(StringComparer.Ordinal);for(int i=0;i<names.Length;i++) expected.Add(names[i],i);
        seen.Clear();long done=0;int index=0;
        foreach(var entry in zip.Entries) {
          int i;if(!seen.Add(entry.FullName) || !expected.TryGetValue(entry.FullName,out i) || entry.Length!=sizes[i]) throw new IOException("Archive entry mismatch");
          Progress("checkingArchive",done,total,index,names.Length);
          using(var stream=entry.Open()) CopyHash(stream,null,buffer,sizes[i],digests[i],n=>Progress("checkingArchive",done+n,total,index,names.Length));
          done+=sizes[i];index++;
        }
      }
      file.Position=0;long length=file.Length;string fingerprint;
      using(var hash=SHA256.Create()) fingerprint=Hex(hash.ComputeHash(file));
      Console.WriteLine("{\"result\":true,\"bytes\":"+length+",\"sha256\":\""+fingerprint+"\",\"files\":"+names.Length+"}");
    }
  }
}
'@
  $requestData=[IO.File]::ReadAllText($Request,[Text.Encoding]::UTF8) | ConvertFrom-Json
  $names=[string[]]@($requestData.files | ForEach-Object { $_.path })
  $sizes=[long[]]@($requestData.files | ForEach-Object { $_.bytes })
  $digests=[string[]]@($requestData.files | ForEach-Object { $_.sha256 })
  [RelayVaultArchive]::Run([string]$requestData.directory,[string]$requestData.output,$names,$sizes,$digests)
} catch {
  [Console]::Error.WriteLine('Complete archive creation or readback failed: '+$_.Exception.Message)
  exit 2
}
