using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using Ags.Issuer.Windows.Core;
using Microsoft.Win32.SafeHandles;

namespace Ags.Issuer.Windows.Host
{
    // The B14-q-a3-3a pipe policy, shared by PipeListener and IssuerServer (B14-q-a3-3b-2). One instance only
    // (FILE_FLAG_FIRST_PIPE_INSTANCE: a name another process already holds is refused), remote clients rejected
    // (PIPE_REJECT_REMOTE_CLIENTS, plus a network deny ACE), and an explicit protected DACL: SYSTEM and this process's user
    // get full control, each allowed SID read/write; Everyone and Anonymous are never allowed.
    public static class IssuerPipe
    {
        const uint PipeAccessDuplex = 0x3;
        const uint FirstPipeInstance = 0x00080000;
        const uint FileFlagOverlapped = 0x40000000;
        const uint RejectRemoteClients = 0x8u;
        const string DenyNetwork = "(D;;GA;;;NU)";
        static readonly Regex Name = new Regex(@"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\z", RegexOptions.CultureInvariant);
        // Canonical but never allowed: the DACL must not name Everyone or Anonymous, whatever the caller passes.
        static readonly string[] ForbiddenSids = { "S-1-1-0", "S-1-5-7" };

        [StructLayout(LayoutKind.Sequential)]
        struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBuffer, uint inBuffer, uint timeout, ref SecurityAttributes security);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, IntPtr size);
        [DllImport("kernel32.dll")]
        static extern IntPtr LocalFree(IntPtr memory);

        public static bool IsValidName(string name) { return name != null && Name.IsMatch(name); }

        public static bool IsAllowedSid(string sid) { return IssuerCore.IsCanonicalSid(sid) && Array.IndexOf(ForbiddenSids, sid) < 0; }

        // Returns the pipe, or null with "dacl-failed <err>" / "create-failed <err>" in failure. overlapped only selects the
        // I/O mode; the security policy is the same either way.
        public static SafeFileHandle Create(string name, string[] allowedSids, bool overlapped, out string failure)
        {
            var dacl = new StringBuilder("D:P" + DenyNetwork + "(A;;GA;;;SY)(A;;GA;;;" + WindowsIdentity.GetCurrent().User.Value + ")");
            foreach (string sid in allowedSids) dacl.Append("(A;;GRGW;;;").Append(sid).Append(')');
            IntPtr descriptor;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(dacl.ToString(), 1, out descriptor, IntPtr.Zero))
            {
                failure = "dacl-failed " + Marshal.GetLastWin32Error();
                return null;
            }
            var security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = descriptor };
            SafeFileHandle pipe = CreateNamedPipeW(@"\\.\pipe\" + name, PipeAccessDuplex | FirstPipeInstance | (overlapped ? FileFlagOverlapped : 0),
                RejectRemoteClients, 1, 4096, 4096, 0, ref security);
            int error = Marshal.GetLastWin32Error();
            LocalFree(descriptor);
            if (pipe.IsInvalid)
            {
                failure = "create-failed " + error;
                return null;
            }
            failure = null;
            return pipe;
        }
    }
}
