"""Invocation-local CI command owner; no global process killing."""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import subprocess
import sys

if len(sys.argv) < 3:
    raise RuntimeError("Expected exact Linux subreaper path and child argv")
subreaper, command = sys.argv[1], sys.argv[2:]
if sys.platform == "linux":
    os.execv(sys.executable, [sys.executable, "-B", subreaper, *command])
if sys.platform != "win32":
    raise RuntimeError("Unsupported CI command ownership platform")

# Join a fresh unnamed job BEFORE spawning. Child processes inherit membership;
# the non-inheritable sole job handle closes even on TerminateProcess(owner).
# This job does not permit breakaway; failure to establish it launches no child.
kernel = ctypes.WinDLL("kernel32", use_last_error=True)
class BasicLimits(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong), ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t), ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD), ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]
class IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in
                ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                 "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]
class ExtendedLimits(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", BasicLimits), ("IoInfo", IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]
kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
kernel.CreateJobObjectW.restype = wintypes.HANDLE
kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
kernel.SetInformationJobObject.restype = wintypes.BOOL
kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
kernel.AssignProcessToJobObject.restype = wintypes.BOOL
kernel.GetCurrentProcess.argtypes = []
kernel.GetCurrentProcess.restype = wintypes.HANDLE
job = kernel.CreateJobObjectW(None, None)
if not job:
    raise ctypes.WinError(ctypes.get_last_error())
limits = ExtendedLimits()
limits.BasicLimitInformation.LimitFlags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
    raise ctypes.WinError(ctypes.get_last_error())
if not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
    raise ctypes.WinError(ctypes.get_last_error())
print(json.dumps({"harness": "windows-job-owner", "ownerPid": os.getpid(),
                  "jobEstablishedBeforeSpawn": True, "breakawayAllowed": False}), file=sys.stderr, flush=True)
code = subprocess.call(command, shell=False)
# Let process exit close the last job handle. Closing it explicitly here would
# terminate this owner before its real child exit code could be returned.
sys.exit(code)
