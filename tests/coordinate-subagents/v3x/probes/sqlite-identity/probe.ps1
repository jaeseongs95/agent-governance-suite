param(
  [Parameter(Mandatory = $true)][string]$DatabasePath,
  [string]$ExpectedIdentity = '',
  [switch]$WriteSchema
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class SqliteIdentityProbe {
  [StructLayout(LayoutKind.Sequential)]
  private struct FileIdInfo {
    public ulong VolumeSerialNumber;
    public ulong FileIdLow;
    public ulong FileIdHigh;
  }

  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  private static extern int sqlite3_open_v2(byte[] path, out IntPtr db, int flags, IntPtr vfs);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  private static extern int sqlite3_file_control(IntPtr db, string name, int op, out IntPtr handle);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  private static extern int sqlite3_exec(IntPtr db, string sql, IntPtr callback, IntPtr arg, out IntPtr error);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  private static extern void sqlite3_free(IntPtr pointer);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  private static extern int sqlite3_close_v2(IntPtr db);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  private static extern IntPtr sqlite3_libversion();
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(IntPtr handle, int infoClass, out FileIdInfo info, uint size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  private static extern IntPtr GetModuleHandle(string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  private static extern uint GetModuleFileName(IntPtr module, StringBuilder path, int size);

  public static string Version { get { return Marshal.PtrToStringAnsi(sqlite3_libversion()); } }

  public static string[] Run(string path, string expected, bool writeSchema) {
    string full = Path.GetFullPath(path);
    string temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
    if (!full.StartsWith(temp, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
      throw new InvalidOperationException("Probe accepts only an existing file below the OS temp directory.");
    if (writeSchema && expected.Length == 0)
      throw new InvalidOperationException("Expected identity is required before schema write.");

    sqlite3_libversion(); // Force load before opening the database.
    var modulePath = new StringBuilder(32768);
    if (GetModuleFileName(GetModuleHandle("winsqlite3.dll"), modulePath, modulePath.Capacity) == 0 ||
        !String.Equals(modulePath.ToString(), Path.Combine(Environment.SystemDirectory, "winsqlite3.dll"), StringComparison.OrdinalIgnoreCase))
      throw new InvalidOperationException("SQLite was not loaded from the Windows system directory.");

    IntPtr db = IntPtr.Zero;
    byte[] utf8 = Encoding.UTF8.GetBytes(full + "\0");
    int rc = sqlite3_open_v2(utf8, out db, 2, IntPtr.Zero); // READWRITE, never CREATE
    try {
      if (rc != 0) throw new InvalidOperationException("sqlite3_open_v2 failed: " + rc);
      IntPtr handle;
      rc = sqlite3_file_control(db, "main", 29, out handle); // WIN32_GET_HANDLE
      if (rc != 0 || handle == IntPtr.Zero) throw new InvalidOperationException("main xFileControl failed: " + rc);
      FileIdInfo info;
      if (!GetFileInformationByHandleEx(handle, 18, out info, (uint)Marshal.SizeOf(typeof(FileIdInfo))))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      string identity = info.VolumeSerialNumber.ToString("x16") + ":" + info.FileIdLow.ToString("x16") + info.FileIdHigh.ToString("x16");
      if (expected.Length != 0 && !String.Equals(identity, expected, StringComparison.Ordinal))
        return new [] { "mismatch", identity, "false" };
      if (writeSchema) {
        IntPtr error;
        rc = sqlite3_exec(db, "CREATE TABLE probe_marker (id INTEGER PRIMARY KEY)", IntPtr.Zero, IntPtr.Zero, out error);
        if (rc != 0) {
          string message = error == IntPtr.Zero ? "" : Marshal.PtrToStringAnsi(error);
          if (error != IntPtr.Zero) sqlite3_free(error);
          throw new InvalidOperationException("schema write failed: " + rc + " " + message);
        }
      }
      return new [] { expected.Length == 0 ? "observed" : "matched", identity, writeSchema ? "true" : "false" };
    } finally {
      if (db != IntPtr.Zero) sqlite3_close_v2(db);
    }
  }
}
'@

try {
  $result = [SqliteIdentityProbe]::Run($DatabasePath, $ExpectedIdentity, [bool]$WriteSchema)
  [pscustomobject]@{ status = $result[0]; identity = $result[1]; wroteSchema = ($result[2] -eq 'true'); sqliteVersion = [SqliteIdentityProbe]::Version } | ConvertTo-Json -Compress
  if ($result[0] -eq 'mismatch') { exit 2 }
} catch {
  [pscustomobject]@{ status = 'error'; message = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
