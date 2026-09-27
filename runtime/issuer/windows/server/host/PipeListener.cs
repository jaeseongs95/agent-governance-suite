using System;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Ags.Issuer.Windows.Host
{
    // B14-q-a3-3a: temporary named-pipe listener (SAME_USER_SMOKE). Usage: <pipeName> <allowedSid>...
    // The pipe policy (single instance, remote refusal, protected DACL without Everyone or Anonymous) lives in IssuerPipe.
    // A connection is only drained until the client closes (request handling is IssuerServer). Closing stdin ends it.
    public static class PipeListener
    {
        const int ErrorPipeConnected = 535;

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool ConnectNamedPipe(SafeFileHandle pipe, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool DisconnectNamedPipe(SafeFileHandle pipe);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool ReadFile(SafeFileHandle file, byte[] buffer, uint size, out uint read, IntPtr overlapped);

        public static int Main(string[] args)
        {
            if (args.Length < 2 || !IssuerPipe.IsValidName(args[0])) return Usage();
            var allowed = new string[args.Length - 1];
            for (int i = 1; i < args.Length; i++)
            {
                if (!IssuerPipe.IsAllowedSid(args[i])) return Usage();
                allowed[i - 1] = args[i];
            }
            string failure;
            SafeFileHandle pipe = IssuerPipe.Create(args[0], allowed, false, out failure);
            if (pipe == null)
            {
                Console.Error.WriteLine(failure);
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
