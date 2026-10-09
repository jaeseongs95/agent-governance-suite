"""Linux-only, invocation-local owner of the test runner's orphan descendants."""
import ctypes
from contextlib import closing
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


class CleanupLimit(Exception):
    """Return control to the reap/cancellation loop after bounded cleanup work."""


class ProcUnavailable(Exception):
    """Missing child links are unobserved ownership, not an empty tree."""


class CleanupBudget:
    def __init__(self, deadline):
        self.deadline = deadline
        self.remaining = 256

    def check(self):
        if self.remaining <= 0 or time.monotonic() >= self.deadline:
            raise CleanupLimit()
        self.remaining -= 1


def descendants(pid, budget):
    """Walk only this owner's child links, never a global process scan."""
    pending = [pid]
    seen = {pid}
    while pending:
        budget.check()
        parent = pending.pop()
        try:
            with os.scandir(f"/proc/{parent}/task") as tasks:
                while True:
                    budget.check()
                    try:
                        task = next(tasks)
                    except StopIteration:
                        break
                    budget.check()
                    with (Path(task.path) / "children").open() as stream:
                        tail = ""
                        while True:
                            budget.check()
                            chunk = stream.read(4096)
                            values = (tail + chunk).split()
                            tail = values.pop() if chunk and not chunk[-1].isspace() else ""
                            for value in values:
                                budget.check()
                                child = int(value)
                                if child not in seen:
                                    seen.add(child)
                                    pending.append(child)
                                    yield child
                            if not chunk:
                                break
        except FileNotFoundError as cause:
            raise ProcUnavailable() from cause


def parent_pid(pid, budget):
    """Extract only PID/PPid metadata; never inspect cmdline or environment."""
    try:
        budget.check()
        with Path(f"/proc/{pid}/status").open() as stream:
            fields = {}
            for _ in range(16):
                budget.check()
                line = stream.readline(256)
                if not line:
                    break
                key, separator, value = line.partition(":")
                if separator and key in ("Pid", "PPid"):
                    fields[key] = int(value.strip())
                if len(fields) == 2:
                    return fields["PPid"] if fields["Pid"] == pid else None
    except (OSError, ValueError):
        pass
    return None


def current_owner(pid, budget):
    owner = os.getpid()
    seen = set()
    while pid not in (0, 1, owner) and pid not in seen:
        budget.check()
        seen.add(pid)
        pid = parent_pid(pid, budget)
        if pid is None:
            return None
    return pid == owner


class ProcScan:
    """Invocation-owned lazy cursor; partial batches never restart a prefix."""
    def __init__(self, known=()):
        self.known = known
        self.iterator = None
        self.pending = None
        self.unknown = False
        self.enabled = False

    def close(self):
        if self.iterator is not None:
            self.iterator.close()
            self.iterator = None
        self.pending = None

    def signal_pid(self, pid, signum, budget):
        if pid == os.getpid():
            return
        observed = current_owner(pid, budget)
        if observed is not True:
            self.unknown |= observed is None
            return
        budget.check()
        try:
            descriptor = os.pidfd_open(pid)
        except ProcessLookupError:
            return
        try:
            observed = current_owner(pid, budget)
            self.unknown |= observed is None
            if observed is True and pid != os.getpid():
                budget.check()
                signal.pidfd_send_signal(descriptor, signum)
        except ProcessLookupError:
            pass
        finally:
            os.close(descriptor)

    def signal(self, signum, budget):
        if self.iterator is None:
            self.unknown = False
        # The directly spawned runner cannot wait behind an unrelated prefix.
        for pid in self.known:
            self.signal_pid(pid, signum, budget)
        if self.iterator is None:
            budget.check()
            self.iterator = os.scandir("/proc")
        while True:
            budget.check()
            if self.pending is None:
                try:
                    entry = next(self.iterator)
                except StopIteration:
                    self.close()
                    return not self.unknown
                if not entry.name.isdecimal():
                    continue
                self.pending = int(entry.name)
            budget.check()
            self.signal_pid(self.pending, signum, budget)
            self.pending = None


def signal_owned(signum, deadline, proc_scan=None):
    budget = CleanupBudget(deadline)
    temporary = proc_scan is None
    if temporary:
        proc_scan = ProcScan()
    try:
        if proc_scan.enabled:
            return proc_scan.signal(signum, budget)
        with closing(descendants(os.getpid(), budget)) as owned:
            for pid in owned:
                # A pidfd cannot target a recycled PID. Recheck that the opened process
                # is still our descendant before sending any termination signal.
                budget.check()
                try:
                    descriptor = os.pidfd_open(pid)
                except ProcessLookupError:
                    continue
                try:
                    with closing(descendants(os.getpid(), budget)) as current:
                        if pid in current:
                            budget.check()
                            signal.pidfd_send_signal(descriptor, signum)
                except ProcessLookupError:
                    pass
                finally:
                    os.close(descriptor)
    except ProcUnavailable:
        proc_scan.enabled = True
        try:
            return proc_scan.signal(signum, budget)
        except CleanupLimit:
            return False
        except OSError:
            proc_scan.close()
            return False
    except CleanupLimit:
        return False
    except OSError:
        proc_scan.close()
        return False
    finally:
        if temporary:
            proc_scan.close()
    return True


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
    proc_scan = ProcScan((child.pid,))
    try:
        while True:
            # Reap throughout test execution: tests still use their original kill(0)
            # criterion, which must see the orphan PID actually disappear.
            for _ in range(32):
                if cleanup_started is None and (cancellation or main_code is not None):
                    cleanup_started = time.monotonic()
                if cleanup_started is not None and time.monotonic() >= cleanup_started + 5:
                    remaining = True  # No absence observation at the deadline.
                    break
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
                    term_sent = signal_owned(signal.SIGTERM, cleanup_started + 5, proc_scan)
                if elapsed >= 3:
                    signal_owned(signal.SIGKILL, cleanup_started + 5, proc_scan)
                if time.monotonic() >= cleanup_started + 5:
                    break
            time.sleep(0.02)
    finally:
        proc_scan.close()
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
