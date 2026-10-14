using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

public static class HomeAIIsolatedNode {
  [StructLayout(LayoutKind.Sequential)] struct CAPS { public IntPtr Sid,Capabilities; public uint Count,Reserved; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct START {
    public uint cb;public IntPtr reserved,desktop,title;public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
    public ushort show,reservedSize;public IntPtr reserved2,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTEX {public START Info;public IntPtr Attributes;}
  [StructLayout(LayoutKind.Sequential)] struct PROCESS {public IntPtr Process,Thread;public uint ProcessId,ThreadId;}
  [StructLayout(LayoutKind.Sequential)] struct BASICLIMIT {
    public long ProcessTime,JobTime;public uint Flags;public UIntPtr MinWorking,MaxWorking;public uint ActiveProcessLimit;
    public UIntPtr Affinity;public uint Priority,Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IOC {public ulong a,b,c,d,e,f;}
  [StructLayout(LayoutKind.Sequential)] struct LIMIT {public BASICLIMIT Basic;public IOC Io;public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;}
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,uint count,out IntPtr sid);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int GetAppContainerFolderPath(string sid,out IntPtr folder);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr value,uint length,out uint returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTEX startup,out PROCESS process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr security,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref LIMIT limits,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static IntPtr packageSid=IntPtr.Zero;static string profile;
  public static string CreateProfile(string name){
    if(packageSid!=IntPtr.Zero)throw new InvalidOperationException("A profile is already active.");
    int hr=CreateAppContainerProfile(name,name,"HomeAI isolated offline Node test",IntPtr.Zero,0,out packageSid);
    if(hr!=0){packageSid=IntPtr.Zero;Marshal.ThrowExceptionForHR(hr);}
    profile=name;return new SecurityIdentifier(packageSid).Value;
  }
  public static void Cleanup(){
    if(packageSid!=IntPtr.Zero){FreeSid(packageSid);packageSid=IntPtr.Zero;}
    if(profile!=null){int hr=DeleteAppContainerProfile(profile);profile=null;if(hr!=0)Marshal.ThrowExceptionForHR(hr);}
  }
  static void Check(bool ok){if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error());}
  static string Quote(string value){
    if(value.IndexOf('\0')>=0)throw new ArgumentException("NUL argument.");
    var b=new StringBuilder("\"");int slashes=0;
    foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='\"'){b.Append('\\',slashes*2+1);b.Append(c);}else{b.Append('\\',slashes);b.Append(c);}slashes=0;}
    b.Append('\\',slashes*2);return b.Append('"').ToString();
  }
  public static int Run(string exe,string[] args,string cwd,string temp,string stdout,string stderr,int seconds){
    if(packageSid==IntPtr.Zero)throw new InvalidOperationException("No AppContainer profile.");
    IntPtr list=IntPtr.Zero,cap=IntPtr.Zero,handles=IntPtr.Zero,environment=IntPtr.Zero,job=IntPtr.Zero,input=IntPtr.Zero;
    PROCESS process=new PROCESS();bool initialized=false;
    using(var output=new FileStream(stdout,FileMode.CreateNew,FileAccess.Write,FileShare.Read))
    using(var error=new FileStream(stderr,FileMode.CreateNew,FileAccess.Write,FileShare.Read)){
      try{
        input=CreateFile("NUL",0x80000000,3,IntPtr.Zero,3,0,IntPtr.Zero);if(input==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr outHandle=output.SafeFileHandle.DangerousGetHandle(),errHandle=error.SafeFileHandle.DangerousGetHandle();
        foreach(IntPtr h in new[]{input,outHandle,errHandle})Check(SetHandleInformation(h,1,1));
        IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
        list=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(list,2,0,ref size));initialized=true;
        var capabilities=new CAPS{Sid=packageSid};cap=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(CAPS)));Marshal.StructureToPtr(capabilities,cap,false);
        Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20009),cap,new IntPtr(Marshal.SizeOf(typeof(CAPS))),IntPtr.Zero,IntPtr.Zero));
        handles=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.WriteIntPtr(handles,0,input);Marshal.WriteIntPtr(handles,IntPtr.Size,outHandle);Marshal.WriteIntPtr(handles,IntPtr.Size*2,errHandle);
        Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
        job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
        var limits=new LIMIT();limits.Basic.Flags=0x2000|0x100|0x8;limits.Basic.ActiveProcessLimit=1;limits.ProcessMemory=new UIntPtr(1024u*1024u*1024u);
        Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(LIMIT))));
        string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        // A fresh environment never inherits subscription tokens, keys or user PATH.
        IntPtr folder;int folderResult=GetAppContainerFolderPath(new SecurityIdentifier(packageSid).Value,out folder);if(folderResult!=0)Marshal.ThrowExceptionForHR(folderResult);
        string privateProfile;try{privateProfile=Marshal.PtrToStringUni(folder);}finally{Marshal.FreeCoTaskMem(folder);}
        string env="APPDATA="+privateProfile+"\0HOMEAI_SANDBOX=1\0LOCALAPPDATA="+privateProfile+"\0SystemDrive="+Path.GetPathRoot(windows).TrimEnd('\\')+"\0SystemRoot="+windows+"\0TEMP="+temp+"\0TMP="+temp+"\0USERPROFILE="+privateProfile+"\0windir="+windows+"\0\0";
        environment=Marshal.StringToHGlobalUni(env);
        var startup=new STARTEX();startup.Info.cb=(uint)Marshal.SizeOf(typeof(STARTEX));startup.Info.flags=0x100;startup.Info.input=input;startup.Info.output=outHandle;startup.Info.error=errHandle;startup.Attributes=list;
        var command=new StringBuilder(Quote(exe));foreach(string arg in args)command.Append(' ').Append(Quote(arg));
        Check(CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,true,0x08000000|0x00080000|0x400|4,environment,cwd,ref startup,out process));
        IntPtr token;Check(OpenProcessToken(process.Process,8,out token));IntPtr isContainer=Marshal.AllocHGlobal(4);
        try{uint returned;Check(GetTokenInformation(token,29,isContainer,4,out returned));if(Marshal.ReadInt32(isContainer)!=1)throw new InvalidOperationException("Child is not an AppContainer; execution refused.");}
        finally{Marshal.FreeHGlobal(isContainer);CloseHandle(token);}
        Check(AssignProcessToJobObject(job,process.Process));if(ResumeThread(process.Thread)==0xffffffff)throw new Win32Exception(Marshal.GetLastWin32Error());
        var clock=Stopwatch.StartNew();bool terminated=false;
        while(WaitForSingleObject(process.Process,20)==258){
          if(clock.Elapsed.TotalSeconds>seconds||new FileInfo(stdout).Length+new FileInfo(stderr).Length>1024*1024){TerminateProcess(process.Process,124);terminated=true;break;}
        }
        WaitForSingleObject(process.Process,5000);uint code;Check(GetExitCodeProcess(process.Process,out code));
        if(new FileInfo(stdout).Length+new FileInfo(stderr).Length>1024*1024)terminated=true;
        return terminated?124:unchecked((int)code);
      }finally{
        if(process.Process!=IntPtr.Zero){TerminateProcess(process.Process,125);CloseHandle(process.Process);}if(process.Thread!=IntPtr.Zero)CloseHandle(process.Thread);
        if(job!=IntPtr.Zero)CloseHandle(job);if(input!=IntPtr.Zero&&input!=new IntPtr(-1))CloseHandle(input);
        if(initialized)DeleteProcThreadAttributeList(list);
        foreach(IntPtr p in new[]{list,cap,handles,environment})if(p!=IntPtr.Zero)Marshal.FreeHGlobal(p);
      }
    }
  }
}
