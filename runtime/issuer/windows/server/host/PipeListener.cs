using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Ags.Issuer.Windows.Core;
using Microsoft.Win32.SafeHandles;

namespace Ags.Issuer.Windows.Host
{
    // B14-q-a3-3a: temporary named-pipe listener (SAME_USER_SMOKE). Usage: <pipeName> <allowedSid>...
    // One instance only (FILE_FLAG_FIRST_PIPE_INSTANCE: a name another process already holds is refused), remote clients
    // rejected (PIPE_REJECT_REMOTE_CLIENTS, plus a network deny ACE), and an explicit protected DACL: SYSTEM and this
    // process's user get full control, each allowed SID read/write; there is no Everyone or Anonymous entry.
    // A connection is only drained until the client closes (request handling is B14-q-a3-3b). Closing stdin ends it.
    public static class PipeListener
    {
        const uint PipeAccessDuplex = 0x3;
        const uint FirstPipeInstance = 0x00080000;
        const uint RejectRemoteClients = 0x8u;
        const string DenyNetwork = "(D;;GA;;;NU)";
        const int ErrorPipeConnected = 535;
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
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool ConnectNamedPipe(SafeFileHandle pipe, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool DisconnectNamedPipe(SafeFileHandle pipe);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool ReadFile(SafeFileHandle file, byte[] buffer, uint size, out uint read, IntPtr overlapped);

        public static int Main(string[] args)
        {
            if (args.Length < 2 || !Name.IsMatch(args[0])) return Usage();
            var dacl = new StringBuilder("D:P" + DenyNetwork + "(A;;GA;;;SY)(A;;GA;;;" + WindowsIdentity.GetCurrent().User.Value + ")");
            for (int i = 1; i < args.Length; i++)
            {
                if (!IssuerCore.IsCanonicalSid(args[i]) || Array.IndexOf(ForbiddenSids, args[i]) >= 0) return Usage();
                dacl.Append("(A;;GRGW;;;").Append(args[i]).Append(')');
            }
            IntPtr descriptor;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(dacl.ToString(), 1, out descriptor, IntPtr.Zero))
            {
                Console.Error.WriteLine("dacl-failed " + Marshal.GetLastWin32Error());
                return 3;
            }
            var security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = descriptor };
            SafeFileHandle pipe = CreateNamedPipeW(@"\\.\pipe\" + args[0], PipeAccessDuplex | FirstPipeInstance, RejectRemoteClients, 1, 4096, 4096, 0, ref security);
            int error = Marshal.GetLastWin32Error();
            LocalFree(descriptor);
            if (pipe.IsInvalid)
            {
                Console.Error.WriteLine("create-failed " + error);
                return 3;
            }
            Console.Out.WriteLine("listening " + args[0]);
            Console.Out.Flush();
            var stop = new Thread(() => { Console.In.ReadToEnd(); Environment.Exit(0); });
            stop.IsBackground = true;
            stop.Start();
            var buffer = new byte[4096];
            while (true)
            {
                if (!ConnectNamedPipe(pipe, IntPtr.Zero) && Marshal.GetLastWin32Error() != ErrorPipeConnected)
                {
                    Console.Error.WriteLine("connect-failed " + Marshal.GetLastWin32Error());
                    return 4;
                }
                Console.Out.WriteLine("connected");
                Console.Out.Flush();
                uint read;
                while (ReadFile(pipe, buffer, (uint)buffer.Length, out read, IntPtr.Zero) && read > 0) { }
                DisconnectNamedPipe(pipe);
            }
        }

        static int Usage()
        {
            Console.Error.WriteLine("usage: <pipeName> <canonicalAllowedSid>...");
            return 2;
        }
    }
}
