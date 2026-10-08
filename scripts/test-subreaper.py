"""Linux-only, invocation-local owner of the test runner's orphan descendants."""
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def descendants(pid):
    """Walk only this owner's child links, never a global process scan."""
    try:
        children = {int(value) for task in Path(f"/proc/{pid}/task").iterdir()
                    for value in (task / "children").read_text().split()}
    except FileNotFoundError:
        return []
    result = []
    for child in children:
        result.extend(descendants(child))
        result.append(child)
    return result


def signal_owned(signum):
    for pid in descendants(os.getpid()):
        # A pidfd cannot target a recycled PID. Recheck that the opened process
        # is still our descendant before sending any termination signal.
        try:
            descriptor = os.pidfd_open(pid)
        except ProcessLookupError:
            continue
        try:
            if pid in descendants(os.getpid()):
                signal.pidfd_send_signal(descriptor, signum)
        except ProcessLookupError:
            pass
        finally:
            os.close(descriptor)


def main():
    if sys.platform != "linux" or len(sys.argv) < 2:
        raise RuntimeError("test-subreaper requires Linux and an explicit child command")
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER failed")
    # Require safe cleanup support before launching any test process.
    descriptor = os.pidfd_open(os.getpid())
    os.close(descriptor)
    if not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("pidfd_send_signal is required")
    cancellation = []
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda number, _frame: cancellation.append(number))
    child = subprocess.Popen(sys.argv[1:])
    reaped = []
    main_code = None
    cleanup_started = None
    term_sent = False
    remaining = False
    while True:
        # Reap throughout test execution: tests still use their original kill(0)
        # criterion, which must see the orphan PID actually disappear.
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                remaining = False
                break
            remaining = True
            if pid == 0:
                break
            reaped.append(pid)
            if pid == child.pid:
                main_code = os.waitstatus_to_exitcode(status)
                child.returncode = main_code
        if cancellation and cleanup_started is None:
            cleanup_started = time.monotonic()
        if main_code is not None and cleanup_started is None:
            cleanup_started = time.monotonic()
        if not remaining and main_code is not None:
            break
        if cleanup_started is not None:
            elapsed = time.monotonic() - cleanup_started
            if not term_sent and (cancellation or elapsed >= 1):
                signal_owned(signal.SIGTERM)
                term_sent = True
            if elapsed >= 3:
                signal_owned(signal.SIGKILL)
            if elapsed >= 5:
                break
        time.sleep(0.02)
    print(json.dumps({"harness": "test-subreaper", "ownerPid": os.getpid(),
                      "runnerPid": child.pid, "reapedPids": reaped,
                      "remainingChildren": remaining, "runnerExitCode": main_code,
                      "cancelled": bool(cancellation)}), file=sys.stderr)
    if remaining or main_code is None:
        return 70  # No success claim if owned descendants failed to drain.
    if cancellation:
        return 128 + cancellation[0]
    return main_code if main_code >= 0 else 128 - main_code


if __name__ == "__main__":
    sys.exit(main())
