using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using Ags.Issuer.Windows.Core;
using Microsoft.Win32.SafeHandles;

namespace Ags.Issuer.Windows.Host
{
    // B14-q-a3-3b-2: the issuer server (SAME_USER_SMOKE). Usage: <pipeName> <receiverSid> <callerSid>.
    // The pipe follows the 3a policy (IssuerPipe); only the recorded receiver and caller get read/write. One server lifetime
    // shares one core and one start epoch (16 random bytes, never printed). Each connection handles one request under one
    // fixed deadline from accept (reading, writing and waiting for the client to close; pieces never extend it): the frame
    // is read up to the LF within FrameAdapter.MaxFrameBytes, the peer SID comes from this connection's token
    // (RunAsClient), FrameAdapter answers, and the server then waits for the client to close before disconnecting.
    // Overlapped I/O on one thread; a cancelled I/O is reused only after its completion is seen within CancelGraceMs.
    // If that is not seen, or impersonation cannot be reverted, the process ends at once without touching the buffers.
    // stderr carries one "outcome <kind> end <reason> core-calls <n> late-bytes <n>" line per connection.
    public static class IssuerServer
    {
        const int DeadlineMs = 2000;
        const int CancelGraceMs = 1000;
        const int ReadSize = FrameAdapter.MaxFrameBytes + 1;
        const int ErrorIoPending = 997, ErrorPipeConnected = 535, ErrorBrokenPipe = 109, ErrorNoData = 232, ErrorPipeNotConnected = 233;
        const uint TokenQuery = 0x0008;
        const int TokenUserClass = 1;

        static SafeFileHandle pipe;
        static ManualResetEvent ev;
        static IntPtr overlapped, readBuffer, writeBuffer;
        static FrameAdapter adapter;
        static string kind;
        static int callsBefore, late;

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool ConnectNamedPipe(SafeFileHandle pipe, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool DisconnectNamedPipe(SafeFileHandle pipe);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool ReadFile(SafeFileHandle file, IntPtr buffer, uint size, IntPtr read, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool WriteFile(SafeFileHandle file, IntPtr buffer, uint size, IntPtr written, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetOverlappedResult(SafeFileHandle file, IntPtr overlapped, out uint transferred, bool wait);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CancelIoEx(SafeFileHandle file, IntPtr overlapped);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool ImpersonateNamedPipeClient(SafeFileHandle pipe);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool RevertToSelf();
        [DllImport("kernel32.dll")]
        static extern IntPtr GetCurrentThread();
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool OpenThreadToken(IntPtr thread, uint access, bool openAsSelf, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returned);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr text);
        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")]
        static extern IntPtr LocalFree(IntPtr memory);
        [DllImport("kernel32.dll")]
        static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")]
        static extern bool TerminateProcess(IntPtr process, uint code);

        public static int Main(string[] args)
        {
            if (args.Length != 3 || !IssuerPipe.IsValidName(args[0]) || !IssuerPipe.IsAllowedSid(args[1]) || !IssuerPipe.IsAllowedSid(args[2]) || args[1] == args[2])
            {
                Console.Error.WriteLine("usage: <pipeName> <receiverSid> <callerSid>");
                return 2;
            }
            var random = new byte[16];
            using (var rng = new RNGCryptoServiceProvider()) rng.GetBytes(random);
            string epoch = BitConverter.ToString(random).Replace("-", "").ToLowerInvariant();
            adapter = new FrameAdapter(new IssuerCore(epoch, args[1], args[2]));
            string failure;
            pipe = IssuerPipe.Create(args[0], new[] { args[1], args[2] }, true, out failure);
            if (pipe == null)
            {
                Console.Error.WriteLine(failure);
                return 3;
            }
            ev = new ManualResetEvent(false);
            overlapped = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(NativeOverlapped)));
            readBuffer = Marshal.AllocHGlobal(ReadSize);
            writeBuffer = Marshal.AllocHGlobal(ReadSize);
            Console.Out.WriteLine("listening " + args[0]);
            Console.Out.Flush();
            var stop = new Thread(() => { Console.In.ReadToEnd(); Environment.Exit(0); });
            stop.IsBackground = true;
            stop.Start();
            while (true) Serve();
        }

        static void Serve()
        {
            Accept();
            var clock = Stopwatch.StartNew();
            kind = "close";
            late = 0;
            callsBefore = adapter.CoreCalls;
            string end = "server-closed";
            var frame = new byte[ReadSize];
            int length = 0, got = 0;
            while (length <= FrameAdapter.MaxFrameBytes && Array.IndexOf(frame, (byte)'\n', 0, length) < 0)
            {
                got = Io(true, IntPtr.Add(readBuffer, length), ReadSize - length, clock);
                if (got <= 0) break;
                Marshal.Copy(IntPtr.Add(readBuffer, length), frame, length, got);
                length += got;
            }
            int lf = Array.IndexOf(frame, (byte)'\n', 0, length);
            if (got == -1)
            {
                kind = "timeout";
                end = "deadline";
            }
            // Only one whole frame is answered: no LF, bytes after the LF or more than the limit close with no core call.
            else if (lf >= 0 && lf + 1 == length && length <= FrameAdapter.MaxFrameBytes)
            {
                string peer = ClientSid();
                if (peer == null || !IssuerPipe.IsAllowedSid(peer)) kind = "fail-closed";
                else
                {
                    FrameOutcome outcome = adapter.Handle(peer, frame, length);
                    kind = outcome.Kind;
                    if (outcome.Response != null)
                    {
                        Marshal.Copy(outcome.Response, 0, writeBuffer, outcome.Response.Length);
                        end = Io(false, writeBuffer, outcome.Response.Length, clock) == -1 ? "deadline" : WaitForClose(clock);
                    }
                }
            }
            DisconnectNamedPipe(pipe);
            Console.Error.WriteLine("outcome " + kind + " end " + end + " core-calls " + (adapter.CoreCalls - callsBefore) + " late-bytes " + late);
        }

        // After the response, wait within the same deadline for the client to close. What it still sends is counted only.
        static string WaitForClose(Stopwatch clock)
        {
            while (true)
            {
                int got = Io(true, readBuffer, ReadSize, clock);
                if (got == -1) return "deadline";
                if (got <= 0) return "client-closed";
                late += got;
            }
        }

        // Waits for a client with no deadline; the deadline starts once one is connected. A client that came and went before
        // the accept finished is dropped and the next one is awaited; any other accept failure stops the server.
        static void Accept()
        {
            while (true)
            {
                Prepare();
                if (ConnectNamedPipe(pipe, overlapped)) return;
                int error = Marshal.GetLastWin32Error();
                if (error == ErrorPipeConnected) return;
                if (error == ErrorIoPending)
                {
                    uint ignored;
                    ev.WaitOne();
                    if (GetOverlappedResult(pipe, overlapped, out ignored, false)) return;
                    error = Marshal.GetLastWin32Error();
                }
                if (!Closed(error)) Stop("accept-failed", 4);
                DisconnectNamedPipe(pipe);
            }
        }

        // One overlapped read or write bounded by the connection deadline. Returns the bytes moved, 0 when the client has
        // closed, -1 at the deadline (the I/O is cancelled and its completion seen) and -2 on any other failure.
        static int Io(bool read, IntPtr buffer, int size, Stopwatch clock)
        {
            Prepare();
            bool done = read ? ReadFile(pipe, buffer, (uint)size, IntPtr.Zero, overlapped) : WriteFile(pipe, buffer, (uint)size, IntPtr.Zero, overlapped);
            if (!done)
            {
                int error = Marshal.GetLastWin32Error();
                if (error != ErrorIoPending) return Closed(error) ? 0 : -2;
                long remaining = DeadlineMs - clock.ElapsedMilliseconds;
                if (!ev.WaitOne((int)Math.Max(0, remaining)))
                {
                    CancelIoEx(pipe, overlapped);
                    bool cancelled = ev.WaitOne(CancelGraceMs);
                    if (!cancelled) Stop("cancel-stuck", 5);
                    uint ignored;
                    GetOverlappedResult(pipe, overlapped, out ignored, false);
                    return -1;
                }
            }
            uint moved;
            if (GetOverlappedResult(pipe, overlapped, out moved, false)) return (int)moved;
            return Closed(Marshal.GetLastWin32Error()) ? 0 : -2;
        }

        static bool Closed(int error) { return error == ErrorBrokenPipe || error == ErrorNoData || error == ErrorPipeNotConnected; }

        static void Prepare()
        {
            ev.Reset();
            Marshal.StructureToPtr(new NativeOverlapped { EventHandle = ev.SafeWaitHandle.DangerousGetHandle() }, overlapped, false);
        }

        // RunAsClient: the SID of the token this connection's client presented, read on the pipe the frame came from.
        static string ClientSid()
        {
            IntPtr token = IntPtr.Zero;
            try
            {
                if (!ImpersonateNamedPipeClient(pipe)) return null;
                if (!OpenThreadToken(GetCurrentThread(), TokenQuery, true, out token)) return null;
                int needed;
                GetTokenInformation(token, TokenUserClass, IntPtr.Zero, 0, out needed);
                if (needed <= 0) return null;
                IntPtr info = Marshal.AllocHGlobal(needed);
                try
                {
                    IntPtr text;
                    if (!GetTokenInformation(token, TokenUserClass, info, needed, out needed) || !ConvertSidToStringSidW(Marshal.ReadIntPtr(info), out text)) return null;
                    try { return Marshal.PtrToStringUni(text); }
                    finally { LocalFree(text); }
                }
                finally { Marshal.FreeHGlobal(info); }
            }
            finally
            {
                if (token != IntPtr.Zero) CloseHandle(token);
                if (!RevertToSelf()) Stop("revert-failed", 6);
            }
        }

        // Ends the process at once: nothing is freed or reused, and stderr gets only the enum line.
        static void Stop(string end, uint code)
        {
            Console.Error.WriteLine("outcome fail-closed end " + end + " core-calls " + (adapter.CoreCalls - callsBefore) + " late-bytes " + late);
            Console.Error.Flush();
            TerminateProcess(GetCurrentProcess(), code);
        }
    }
}
