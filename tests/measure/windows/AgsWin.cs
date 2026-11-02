// M2 and M3 Windows helper. Loaded by PowerShell 5.1 Add-Type (C# 5 syntax only).
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;

public static class AgsWin {
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a; public long b; public uint LimitFlags; public UIntPtr c; public UIntPtr d; public uint e; public UIntPtr f; public uint g; public uint h; }
  [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IOC Io; public UIntPtr a; public UIntPtr b; public UIntPtr c; public UIntPtr d; }

  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint acc, bool inh, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr sa, string n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int cls, ref EXT i, int len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr j, int cls, out EXT i, int len, IntPtr rl);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFile(string n, uint acc, uint share, IntPtr sa, uint disp, uint fl, IntPtr t);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateNamedPipe(string n, uint om, uint pm, uint mi, uint ob, uint ib, uint to, IntPtr sa);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr h, byte[] b, int n, out int w, IntPtr ov);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(IntPtr h, byte[] b, int n, out int r, IntPtr ov);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ConnectNamedPipe(IntPtr h, IntPtr ov);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeClientProcessId(IntPtr h, out uint pid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern uint GetSecurityInfo(IntPtr h, int t, uint si, IntPtr o, IntPtr g, IntPtr d, IntPtr s, out IntPtr sd);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr sd, uint rev, uint si, out IntPtr str, out uint len);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LogonUser(string u, string d, string p, int type, int prov, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool ImpersonateLoggedOnUser(IntPtr tok);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool RevertToSelf();

  static readonly IntPtr INVALID = new IntPtr(-1);
  const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000, FILE_WRITE_DATA = 0x2, READ_CONTROL = 0x20000;
  const uint PIPE_ACCESS_DUPLEX = 3, FIRST_INSTANCE = 0x00080000, KILL_ON_JOB_CLOSE = 0x2000;

  static string P(string name) { return @"\\.\pipe\" + name; }
  static string J(string s) {
    if (s == null) return "null";
    var b = new StringBuilder("\"");
    foreach (char c in s) { if (c == '"' || c == '\\') b.Append('\\').Append(c); else if (c < 0x20) b.AppendFormat("\\u{0:x4}", (int)c); else b.Append(c); }
    return b.Append('"').ToString();
  }

  /// IsProcessInJob for pid; for the current process also the immediate job's limit flags.
  public static string JobStatus(int pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return "open-failed:" + Marshal.GetLastWin32Error();
    bool r; bool ok = IsProcessInJob(h, IntPtr.Zero, out r); CloseHandle(h);
    string s = ok ? ("inJob=" + r) : ("err=" + Marshal.GetLastWin32Error());
    if (ok && r && pid == Process.GetCurrentProcess().Id) {
      EXT e; if (QueryInformationJobObject(IntPtr.Zero, 9, out e, Marshal.SizeOf(typeof(EXT)), IntPtr.Zero)) s += " flags=0x" + e.Basic.LimitFlags.ToString("x");
      else s += " queryErr=" + Marshal.GetLastWin32Error();
    }
    return s;
  }

  /// Security descriptor of a listening pipe as SDDL (opens one client instance with READ_CONTROL only).
  public static string PipeSddl(string name) {
    IntPtr h = CreateFile(P(name), READ_CONTROL, 0, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == INVALID) return "open-err=" + Marshal.GetLastWin32Error();
    IntPtr sd; uint rc = GetSecurityInfo(h, 6, 1 | 2 | 4, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out sd);
    CloseHandle(h);
    if (rc != 0) return "gsi-err=" + rc;
    IntPtr str; uint len; string res = "convert-err";
    if (ConvertSecurityDescriptorToStringSecurityDescriptor(sd, 1, 1 | 2 | 4, out str, out len)) { res = Marshal.PtrToStringUni(str); LocalFree(str); }
    LocalFree(sd); return res;
  }

  public static IntPtr Logon(string user, string pw, out string how) {
    IntPtr t;
    if (LogonUser(user, ".", pw, 2, 0, out t)) { how = "interactive"; return t; }
    int e2 = Marshal.GetLastWin32Error();
    if (LogonUser(user, ".", pw, 3, 0, out t)) { how = "network(interactive-err=" + e2 + ")"; return t; }
    how = "failed interactive=" + e2 + " network=" + Marshal.GetLastWin32Error(); return IntPtr.Zero;
  }

  static string Open(string name, uint acc, bool tryWrite) {
    IntPtr h = CreateFile(P(name), acc, 0, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == INVALID) return "err=" + Marshal.GetLastWin32Error();
    string s = "ok";
    if (tryWrite) { byte[] b = Encoding.UTF8.GetBytes("{\"ags\":\"hello\"}\n"); int w; s += WriteFile(h, b, b.Length, out w, IntPtr.Zero) ? " write=ok(" + w + ")" : " write-err=" + Marshal.GetLastWin32Error(); }
    CloseHandle(h); return s;
  }

  /// As the logged-on user: connect read-only, read+write, write-only, and create an extra instance of an existing pipe.
  public static string ProbeAs(IntPtr tok, string name) {
    if (!ImpersonateLoggedOnUser(tok)) return "impersonate-err=" + Marshal.GetLastWin32Error();
    try {
      string who = System.Security.Principal.WindowsIdentity.GetCurrent().Name;
      string r = Open(name, GENERIC_READ, true);
      string rw = Open(name, GENERIC_READ | GENERIC_WRITE, true);
      string w = Open(name, FILE_WRITE_DATA, true);
      IntPtr h = CreateNamedPipe(P(name), PIPE_ACCESS_DUPLEX, 0, 255, 65536, 65536, 0, IntPtr.Zero);
      string inst = h == INVALID ? "err=" + Marshal.GetLastWin32Error() : "ok";
      if (h != INVALID) CloseHandle(h);
      return "{\"as\":" + J(who) + ",\"read\":" + J(r) + ",\"readWrite\":" + J(rw) + ",\"writeOnly\":" + J(w) + ",\"newInstance\":" + J(inst) + "}";
    } finally { RevertToSelf(); }
  }

  /// As the logged-on user: create the first instance (FILE_FLAG_FIRST_PIPE_INSTANCE) plus a second one.
  public static IntPtr[] SquatAs(IntPtr tok, string name, out string info) {
    IntPtr[] hs = new IntPtr[2];
    if (!ImpersonateLoggedOnUser(tok)) { info = "impersonate-err=" + Marshal.GetLastWin32Error(); return hs; }
    try {
      hs[0] = CreateNamedPipe(P(name), PIPE_ACCESS_DUPLEX | FIRST_INSTANCE, 0, 255, 65536, 65536, 0, IntPtr.Zero);
      int e0 = Marshal.GetLastWin32Error();
      hs[1] = CreateNamedPipe(P(name), PIPE_ACCESS_DUPLEX, 0, 255, 65536, 65536, 0, IntPtr.Zero);
      int e1 = Marshal.GetLastWin32Error();
      info = "first=" + (hs[0] == INVALID ? "err=" + e0 : "ok") + " second=" + (hs[1] == INVALID ? "err=" + e1 : "ok");
      return hs;
    } finally { RevertToSelf(); }
  }

  /// Server side of a squatted instance: client pid and the bytes a client sent. Never blocks (peek first).
  public static string SquatAccept(IntPtr h) {
    uint avail;
    if (!PeekNamedPipe(h, IntPtr.Zero, 0, IntPtr.Zero, out avail, IntPtr.Zero)) return "{\"peekErr\":" + Marshal.GetLastWin32Error() + "}";
    uint pid; string p = GetNamedPipeClientProcessId(h, out pid) ? pid.ToString() : "err=" + Marshal.GetLastWin32Error();
    string data = "";
    if (avail > 0) { byte[] b = new byte[avail]; int n; data = ReadFile(h, b, b.Length, out n, IntPtr.Zero) ? Encoding.UTF8.GetString(b, 0, n) : "read-err=" + Marshal.GetLastWin32Error(); }
    return "{\"clientPid\":" + J(p) + ",\"received\":" + J(data) + "}";
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool PeekNamedPipe(IntPtr h, IntPtr buf, uint size, IntPtr read, out uint avail, IntPtr left);

  /// Ordinary client (current token): connect read+write and send a hello line. Returns the open handle in h.
  public static string ClientSend(string name, out IntPtr h) {
    h = CreateFile(P(name), GENERIC_READ | GENERIC_WRITE, 0, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == INVALID) return "err=" + Marshal.GetLastWin32Error();
    byte[] b = Encoding.UTF8.GetBytes("{\"ags\":\"hello\",\"profile\":\"secret-path\"}\n"); int w;
    return WriteFile(h, b, b.Length, out w, IntPtr.Zero) ? "sent=" + w : "write-err=" + Marshal.GetLastWin32Error();
  }

  public static void Close(IntPtr h) { if (h != IntPtr.Zero && h != INVALID) CloseHandle(h); }

  /// hello round trip against the measurement service.
  public static string PipeHello(string name, int timeoutMs) {
    try {
      using (var c = new NamedPipeClientStream(".", name, PipeDirection.InOut)) {
        c.Connect(timeoutMs);
        byte[] b = Encoding.UTF8.GetBytes("{\"ags\":\"hello\",\"protocol\":1}\n"); c.Write(b, 0, b.Length); c.Flush();
        var rd = new StreamReader(c, Encoding.UTF8); var t = rd.ReadLineAsync();
        return t.Wait(timeoutMs) ? "ok " + t.Result : "read-timeout";
      }
    } catch (Exception e) { return "err " + e.GetType().Name + ": " + e.Message; }
  }

  /// Codex-like host: runs exe in a new job with KILL_ON_JOB_CLOSE (no breakaway), waits for stdout EOF, closes the job.
  public static string RunInJob(string exe, string args, int timeoutMs) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    EXT e = new EXT(); e.Basic.LimitFlags = KILL_ON_JOB_CLOSE;
    bool set = SetInformationJobObject(job, 9, ref e, Marshal.SizeOf(typeof(EXT)));
    var psi = new ProcessStartInfo(exe, args); psi.UseShellExecute = false; psi.RedirectStandardOutput = true; psi.RedirectStandardError = true; psi.RedirectStandardInput = true; psi.CreateNoWindow = true;
    var sw = Stopwatch.StartNew();
    var p = Process.Start(psi);
    bool assigned = AssignProcessToJobObject(job, p.Handle);
    int assignErr = assigned ? 0 : Marshal.GetLastWin32Error();
    p.StandardInput.Close();
    var outT = p.StandardOutput.ReadToEndAsync(); var errT = p.StandardError.ReadToEndAsync();
    bool eof = outT.Wait(timeoutMs);
    long eofMs = sw.ElapsedMilliseconds;
    bool exited = p.WaitForExit(1000);
    CloseHandle(job); // last handle: KILL_ON_JOB_CLOSE terminates every process still in the job
    long closeMs = sw.ElapsedMilliseconds;
    string so = eof ? outT.Result : "";
    string se = errT.Wait(500) ? errT.Result : "";
    if (se.Length > 1500) se = se.Substring(0, 1500);
    return "{\"host\":\"job\",\"setInfo\":" + (set ? "true" : "false") + ",\"assigned\":" + (assigned ? "true" : "false") + ",\"assignErr\":" + assignErr
      + ",\"hookShellPid\":" + p.Id + ",\"eof\":" + (eof ? "true" : "false") + ",\"eofMs\":" + eofMs + ",\"shellExited\":" + (exited ? "true" : "false")
      + ",\"jobClosedMs\":" + closeMs + ",\"stdout\":" + J(so) + ",\"stderr\":" + J(se) + "}";
  }
}
