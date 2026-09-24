using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// Loaded from measured bytes by resource-storage-windows.ps1; no runtime compiler.
public static class ResourceStorageWindows
{
    [StructLayout(LayoutKind.Sequential)]
    private struct FileIdInfo
    {
        public ulong VolumeSerialNumber;
        public ulong FileIdLow;
        public ulong FileIdHigh;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileAttributeTagInfo
    {
        public uint FileAttributes;
        public uint ReparseTag;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public FileTime CreationTime;
        public FileTime LastAccessTime;
        public FileTime LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass,
        out FileIdInfo info, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass,
        out FileAttributeTagInfo info, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle,
        out ByHandleFileInformation info);

    private static string Unknown(string code, int win32)
    {
        return "{\"status\":\"UNKNOWN\",\"qualification\":\"FIXTURE_ONLY\",\"code\":\"" +
            code + "\",\"win32\":" + win32 + "}";
    }

    public static string Probe(string path)
    {
        if (String.IsNullOrWhiteSpace(path)) return Unknown("INVALID_PATH", 0);
        try
        {
            string full = Path.GetFullPath(path);
            var parents = new List<string>();
            for (DirectoryInfo parent = Directory.GetParent(full); parent != null; parent = parent.Parent)
                parents.Add(parent.FullName);
            parents.Reverse();
            var held = new List<SafeFileHandle>();
            try
            {
                // Deny delete sharing while checking every ancestor, including junctions.
                foreach (string parent in parents)
                {
                    SafeFileHandle directory = CreateFileW(parent, 0x80, 0x3, IntPtr.Zero, 3,
                        0x00200000 | 0x02000000, IntPtr.Zero);
                    if (directory.IsInvalid)
                    {
                        int error = Marshal.GetLastWin32Error();
                        directory.Dispose();
                        return Unknown("PARENT_OPEN_FAILED", error);
                    }
                    held.Add(directory);
                    FileAttributeTagInfo parentTag;
                    if (!GetFileInformationByHandleEx(directory, 9, out parentTag,
                        (uint)Marshal.SizeOf(typeof(FileAttributeTagInfo))))
                        return Unknown("PARENT_ATTRIBUTES_FAILED", Marshal.GetLastWin32Error());
                    if ((parentTag.FileAttributes & 0x400) != 0)
                        return "{\"status\":\"BLOCKED_REPARSE\",\"qualification\":\"FIXTURE_ONLY\",\"reparse\":true}";
                    if ((parentTag.FileAttributes & 0x10) == 0)
                        return Unknown("PARENT_NOT_DIRECTORY", 0);
                }

                // OPEN_REPARSE_POINT keeps a final symlink handle on the link itself.
                using (SafeFileHandle handle = CreateFileW(full, 0x80, 0x3, IntPtr.Zero, 3,
                    0x00200000 | 0x02000000, IntPtr.Zero))
                {
                    if (handle.IsInvalid) return Unknown("OPEN_FAILED", Marshal.GetLastWin32Error());
                FileIdInfo fileId;
                if (!GetFileInformationByHandleEx(handle, 18, out fileId,
                    (uint)Marshal.SizeOf(typeof(FileIdInfo))))
                    return Unknown("FILE_ID_FAILED", Marshal.GetLastWin32Error());
                FileAttributeTagInfo tag;
                if (!GetFileInformationByHandleEx(handle, 9, out tag,
                    (uint)Marshal.SizeOf(typeof(FileAttributeTagInfo))))
                    return Unknown("ATTRIBUTES_FAILED", Marshal.GetLastWin32Error());
                ByHandleFileInformation links;
                if (!GetFileInformationByHandle(handle, out links))
                    return Unknown("LINK_COUNT_FAILED", Marshal.GetLastWin32Error());
                string identity = fileId.VolumeSerialNumber.ToString("x16") + ":" +
                    fileId.FileIdLow.ToString("x16") + fileId.FileIdHigh.ToString("x16");
                bool reparse = (tag.FileAttributes & 0x400) != 0;
                string status = reparse ? "BLOCKED_REPARSE" :
                    (tag.FileAttributes & 0x10) != 0 ? "BLOCKED_TYPE" :
                    links.NumberOfLinks != 1 ? "BLOCKED_ALIAS" : "OBSERVED";
                return "{\"status\":\"" + status + "\",\"qualification\":\"FIXTURE_ONLY\",\"identity\":\"" +
                    identity + "\",\"linkCount\":" + links.NumberOfLinks +
                    ",\"reparse\":" + (reparse ? "true" : "false") + "}";
                }
            }
            finally
            {
                foreach (SafeFileHandle directory in held) directory.Dispose();
            }
        }
        catch (Exception)
        {
            return Unknown("PROBE_FAILED", 0);
        }
    }
}
