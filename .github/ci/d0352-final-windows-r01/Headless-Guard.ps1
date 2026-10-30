# r07 정본: 실제 실행 시에만 표준 Windows 관측을 수행한다.
$ErrorActionPreference='Stop'
$script:R07LastNativeObservation=$null
if (-not ('R07HeadlessNative' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public sealed class R07ProcessIdentity {
 public uint pid, parentPid; public string path, creationUtc; public long creationFileTime;
}
public sealed class R07SelfObservation {
 public R07ProcessIdentity self; public bool jobQuerySucceeded, inJob, consoleHandlePresent, consoleVisible;
 public int visibleTopWindowCount; public bool startupUseShowWindow; public ushort startupShowWindow; public uint startupInfoSize;
}
public static class R07HeadlessNative {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
 struct ProcessEntry { public uint dwSize,cntUsage,th32ProcessID; public UIntPtr th32DefaultHeapID; public uint th32ModuleID,cntThreads,th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string szExeFile; }
 [StructLayout(LayoutKind.Sequential)]
 struct FileTime { public uint low,high; public long Value { get { return ((long)high<<32)|low; } } }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
 struct StartupInfo { public uint cb; public IntPtr reserved,desktop,title; public uint x,y,xSize,ySize,xCount,yCount,fill,dwFlags; public ushort showWindow,cbReserved2; public IntPtr reserved2,stdInput,stdOutput,stdError; }
 delegate bool EnumWindowCallback(IntPtr window,IntPtr parameter);
 [DllImport("kernel32.dll",SetLastError=true)] static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32FirstW(SafeFileHandle snapshot,ref ProcessEntry entry);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32NextW(SafeFileHandle snapshot,ref ProcessEntry entry);
 [DllImport("kernel32.dll",SetLastError=true)] static extern SafeFileHandle OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageNameW(SafeFileHandle process,uint flags,StringBuilder path,ref uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(SafeFileHandle process,out FileTime creation,out FileTime exit,out FileTime kernel,out FileTime user);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
 [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern void GetStartupInfoW(out StartupInfo info);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll",SetLastError=true)] static extern bool EnumWindows(EnumWindowCallback callback,IntPtr parameter);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
 [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command,out int count);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
 static Exception Error(string api) { return new Win32Exception(Marshal.GetLastWin32Error(),api); }
 public static R07ProcessIdentity Identity(uint pid) {
  uint parent=0; bool found=false;
  using(var snapshot=CreateToolhelp32Snapshot(2,0)) {
   if(snapshot.IsInvalid) throw Error("CreateToolhelp32Snapshot");
   var entry=new ProcessEntry();entry.dwSize=(uint)Marshal.SizeOf(typeof(ProcessEntry));
   if(!Process32FirstW(snapshot,ref entry)) throw Error("Process32FirstW");
   do { if(entry.th32ProcessID==pid) {parent=entry.th32ParentProcessID;found=true;break;} } while(Process32NextW(snapshot,ref entry));
   if(!found) {int error=Marshal.GetLastWin32Error();if(error!=18)throw new Win32Exception(error,"Process32NextW");throw new InvalidOperationException("PROCESS_IDENTITY_UNAVAILABLE");}
  }
  using(var handle=OpenProcess(0x1000,false,pid)) {
   if(handle.IsInvalid)throw Error("OpenProcess");
   var path=new StringBuilder(32768);uint size=32768;
   if(!QueryFullProcessImageNameW(handle,0,path,ref size))throw Error("QueryFullProcessImageNameW");
   FileTime created,exited,kernel,user;
   if(!GetProcessTimes(handle,out created,out exited,out kernel,out user))throw Error("GetProcessTimes");
   if(exited.Value!=0)throw new InvalidOperationException("PROCESS_ALREADY_EXITED");
   return new R07ProcessIdentity {pid=pid,parentPid=parent,path=path.ToString(),creationFileTime=created.Value,creationUtc=DateTime.FromFileTimeUtc(created.Value).ToString("o")};
  }
 }
 public static R07SelfObservation Observe(uint pid) {
  bool inJob;if(!IsProcessInJob(GetCurrentProcess(),IntPtr.Zero,out inJob))throw Error("IsProcessInJob");
  IntPtr console=GetConsoleWindow();int visible=0;
  EnumWindowCallback callback=(window,parameter)=>{uint owner;GetWindowThreadProcessId(window,out owner);if(owner==pid&&IsWindowVisible(window))visible++;return true;};
  if(!EnumWindows(callback,IntPtr.Zero))throw Error("EnumWindows");
  GC.KeepAlive(callback);
  StartupInfo startup;GetStartupInfoW(out startup);
  if(startup.cb!=(uint)Marshal.SizeOf(typeof(StartupInfo)))throw new InvalidOperationException("STARTUP_INFO_UNKNOWN");
  return new R07SelfObservation { self=Identity(pid),jobQuerySucceeded=true,inJob=inJob,consoleHandlePresent=console!=IntPtr.Zero,consoleVisible=console!=IntPtr.Zero&&IsWindowVisible(console),visibleTopWindowCount=visible,startupUseShowWindow=(startup.dwFlags&1)!=0,startupShowWindow=startup.showWindow,startupInfoSize=startup.cb };
 }
 public static string[] Arguments(string command) {
  int count;IntPtr memory=CommandLineToArgvW(command,out count);if(memory==IntPtr.Zero)throw Error("CommandLineToArgvW");
  try {var result=new string[count];for(int i=0;i<count;i++)result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory,i*IntPtr.Size));return result;} finally {LocalFree(memory);}
 }
}
'@
}
function Assert-R07SamePath([string]$Actual,[string]$Expected) {
 if(-not [string]::Equals([IO.Path]::GetFullPath($Actual),[IO.Path]::GetFullPath($Expected),[StringComparison]::OrdinalIgnoreCase)){throw 'HEADLESS_PROCESS_PATH_MISMATCH'}
}
function Assert-R07ParentOrder($Child,$Parent) {
 if($Child.parentPid -ne $Parent.pid -or $Parent.creationFileTime -gt $Child.creationFileTime){throw 'HEADLESS_PARENT_PID_REUSED_OR_UNKNOWN'}
}
function Get-R07ProcessScript($Identity,[string]$Kind) {
 $rows=@(Get-CimInstance Win32_Process -Filter ('ProcessId='+$Identity.pid) -OperationTimeoutSec 5 -ErrorAction Stop)
 if($rows.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$rows[0].CommandLine)){throw 'HEADLESS_ARGUMENT_IDENTITY_UNAVAILABLE'}
 $arguments=[R07HeadlessNative]::Arguments([string]$rows[0].CommandLine)
 if($arguments.Count -lt 2){throw 'HEADLESS_SCRIPT_ARGUMENT_MISSING'}
 Assert-R07SamePath $arguments[0] $Identity.path
 if($Kind -eq 'wscript'){
  $scripts=@($arguments | Select-Object -Skip 1 | Where-Object {-not $_.StartsWith('//',[StringComparison]::Ordinal)})
  if($scripts.Count -ne 1){throw 'HEADLESS_LAUNCHER_ARGUMENT_AMBIGUOUS'}
  return [IO.Path]::GetFullPath($scripts[0])
 }
 $indices=@(for($index=1;$index -lt $arguments.Count;$index++){if($arguments[$index] -ieq '-File'){$index}})
 if($indices.Count -ne 1 -or $indices[0]+1 -ge $arguments.Count){throw 'HEADLESS_PARENT_SCRIPT_ARGUMENT_AMBIGUOUS'}
 return [IO.Path]::GetFullPath($arguments[$indices[0]+1])
}
function Get-R07HeadlessObservation([ValidateSet('Start','Helper')][string]$Role,[string]$PowerShellPath,[string]$LauncherPath,[string]$LauncherSha256,[string]$StartPath) {
 $native=[R07HeadlessNative]::Observe([uint32]$PID)
 $script:R07LastNativeObservation=$native
 if($native.inJob){throw 'HEADLESS_PROCESS_IN_JOB_REJECTED'}
 if($native.consoleVisible -or $native.visibleTopWindowCount -ne 0){throw 'HEADLESS_VISIBLE_WINDOW_REJECTED'}
 if($Role -eq 'Start' -and (-not $native.startupUseShowWindow -or $native.startupShowWindow -ne 0)){throw 'HEADLESS_STARTUP_HIDE_OPTION_UNCONFIRMED'}
 if($Role -eq 'Helper' -and $native.consoleHandlePresent){throw 'HEADLESS_HELPER_CONSOLE_PRESENT'}
 Assert-R07SamePath $native.self.path $PowerShellPath
 $lineage=[Collections.Generic.List[object]]::new();$lineage.Add($native.self)
 $parent=[R07HeadlessNative]::Identity($native.self.parentPid);Assert-R07ParentOrder $native.self $parent
 if($Role -eq 'Helper'){
  Assert-R07SamePath $parent.path $PowerShellPath
  Assert-R07SamePath (Get-R07ProcessScript $parent 'pwsh') $StartPath
  $lineage.Add($parent)
  $wscript=[R07HeadlessNative]::Identity($parent.parentPid);Assert-R07ParentOrder $parent $wscript
 }else{$wscript=$parent}
 $windows=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
 Assert-R07SamePath $wscript.path (Join-Path $windows 'System32/wscript.exe')
 $actualLauncher=Get-R07ProcessScript $wscript 'wscript';Assert-R07SamePath $actualLauncher $LauncherPath
 $actualLauncherHash=(Get-FileHash -LiteralPath $actualLauncher -Algorithm SHA256).Hash.ToLowerInvariant()
 if($actualLauncherHash -cne $LauncherSha256){throw 'HEADLESS_ACTUAL_LAUNCHER_PIN_MISMATCH'}
 $lineage.Add($wscript)
 $explorer=[R07HeadlessNative]::Identity($wscript.parentPid);Assert-R07ParentOrder $wscript $explorer
 Assert-R07SamePath $explorer.path (Join-Path $windows 'explorer.exe');$lineage.Add($explorer)
 foreach($identity in $lineage){
  $again=[R07HeadlessNative]::Identity($identity.pid)
  if($again.creationFileTime -ne $identity.creationFileTime -or $again.parentPid -ne $identity.parentPid){throw 'HEADLESS_IDENTITY_CHANGED_DURING_OBSERVATION'}
  Assert-R07SamePath $again.path $identity.path
 }
 [ordered]@{schemaVersion='R07NativeHeadlessObservation.v1';observedUtc=[DateTime]::UtcNow.ToString('o');role=$Role;self=$native.self;lineage=@($lineage.ToArray());jobQuerySucceeded=$native.jobQuerySucceeded;inJob=$native.inJob;consoleHandlePresent=$native.consoleHandlePresent;consoleVisible=$native.consoleVisible;visibleTopWindowCount=$native.visibleTopWindowCount;startupUseShowWindow=$native.startupUseShowWindow;startupShowWindow=$native.startupShowWindow;startupInfoSize=$native.startupInfoSize;actualLauncherPath=$actualLauncher;actualLauncherSha256=$actualLauncherHash;rawCommandLineStored=$false;pseudoconsolePresentationVerified=$false;parentAppExitSurvival='NOT_OBSERVED';allDescendantWindowsVerified=$false}
}
function Write-R07NewBytes([string]$Path,[byte[]]$Bytes) {
 $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$stream.Write($Bytes);$stream.Flush($true)}finally{$stream.Dispose()}
 [ordered]@{path=$Path;bytes=$Bytes.Length;sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()}
}
function Write-R07NewJson([string]$Path,$Record) {
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Record | ConvertTo-Json -Depth 60).Replace([string][char]13,'')+[char]10)
 Write-R07NewBytes $Path $bytes
}
