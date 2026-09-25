"""B14-p-l: identify the fd that SQLite's own unix VFS xOpen opened for the main DB.

The probe loads the system libsqlite3 through ctypes and, before sqlite3_open_v2,
replaces the unix VFS "open"/"close" system calls with documented
xSetSystemCall overrides. The override forwards to the original call and records
the fd returned for the main database path, so the identity comes from the
connection's own descriptor (fstat st_dev:st_ino), never from a separate guard FD.
"""
import ctypes
import json
import os
import sys
import tempfile

SQLITE_OPEN_READWRITE = 0x00000002


class Vfs(ctypes.Structure):
    _fields_ = [
        ('iVersion', ctypes.c_int), ('szOsFile', ctypes.c_int), ('mxPathname', ctypes.c_int),
        ('pNext', ctypes.c_void_p), ('zName', ctypes.c_char_p), ('pAppData', ctypes.c_void_p),
    ] + [(name, ctypes.c_void_p) for name in (
        'xOpen', 'xDelete', 'xAccess', 'xFullPathname', 'xDlOpen', 'xDlError', 'xDlSym', 'xDlClose',
        'xRandomness', 'xSleep', 'xCurrentTime', 'xGetLastError', 'xCurrentTimeInt64',
        'xSetSystemCall', 'xGetSystemCall', 'xNextSystemCall')]


OpenCall = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_int)
CloseCall = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int)
SetSystemCall = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(Vfs), ctypes.c_char_p, ctypes.c_void_p)
GetSystemCall = ctypes.CFUNCTYPE(ctypes.c_void_p, ctypes.POINTER(Vfs), ctypes.c_char_p)


def loaded_library():
    with open('/proc/self/maps', encoding='utf8') as maps:
        for line in maps:
            if 'libsqlite3.so' in line:
                return os.path.realpath(line.split(None, 5)[5].strip())
    raise RuntimeError('libsqlite3 is not mapped')


def run(path, expected, write_schema):
    full = os.path.realpath(path)
    temp = os.path.realpath(tempfile.gettempdir()) + os.sep
    if not full.startswith(temp) or not os.path.isfile(full):
        raise RuntimeError('Probe accepts only an existing file below the OS temp directory.')
    if write_schema and not expected:
        raise RuntimeError('Expected identity is required before schema write.')

    lib = ctypes.CDLL('libsqlite3.so.0')
    lib.sqlite3_libversion.restype = ctypes.c_char_p
    lib.sqlite3_vfs_find.restype = ctypes.POINTER(Vfs)
    lib.sqlite3_vfs_find.argtypes = [ctypes.c_char_p]
    lib.sqlite3_open_v2.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p), ctypes.c_int, ctypes.c_char_p]
    lib.sqlite3_exec.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_void_p,
                                 ctypes.POINTER(ctypes.c_char_p)]
    lib.sqlite3_close_v2.argtypes = [ctypes.c_void_p]
    lib.sqlite3_errmsg.restype = ctypes.c_char_p
    lib.sqlite3_errmsg.argtypes = [ctypes.c_void_p]

    vfs = lib.sqlite3_vfs_find(None)
    if not vfs or vfs.contents.zName != b'unix' or vfs.contents.iVersion < 3:
        raise RuntimeError('Default SQLite VFS is not the unix VFS with system-call overrides.')
    set_call = SetSystemCall(vfs.contents.xSetSystemCall)
    get_call = GetSystemCall(vfs.contents.xGetSystemCall)
    real_open = OpenCall(get_call(vfs, b'open'))
    real_close = CloseCall(get_call(vfs, b'close'))
    target = full.encode()
    state = {'fd': None, 'opens': 0}

    def traced_open(name, flags, mode):
        fd = real_open(name, flags, mode)
        if name == target and fd >= 3:
            state['fd'] = fd
            state['opens'] += 1
        return fd

    def traced_close(fd):
        if fd == state['fd']:
            state['fd'] = None
        return real_close(fd)

    hooks = (OpenCall(traced_open), CloseCall(traced_close))
    if set_call(vfs, b'open', ctypes.cast(hooks[0], ctypes.c_void_p)) != 0 or \
       set_call(vfs, b'close', ctypes.cast(hooks[1], ctypes.c_void_p)) != 0:
        raise RuntimeError('unix VFS xSetSystemCall failed')

    db = ctypes.c_void_p()
    rc = lib.sqlite3_open_v2(target, ctypes.byref(db), SQLITE_OPEN_READWRITE, b'unix')  # never CREATE
    try:
        if rc != 0:
            raise RuntimeError('sqlite3_open_v2 failed: %d' % rc)
        fd = state['fd']
        if fd is None or state['opens'] != 1:
            raise RuntimeError('main xOpen fd was not observed exactly once')
        swap = os.environ.get('B14PL_SWAP_AFTER_OPEN')
        if swap:  # fixture-only race: move the path to another inode after SQLite opened it
            parked, replacement = json.loads(swap)
            for other in (parked, replacement):
                if not os.path.realpath(other).startswith(temp):
                    raise RuntimeError('Swap paths must stay below the OS temp directory.')
            os.rename(full, parked)
            os.rename(replacement, full)
        info = os.fstat(fd)
        identity = '%016x:%016x' % (info.st_dev, info.st_ino)
        result = {'identity': identity, 'fd': fd, 'fdPath': os.readlink('/proc/self/fd/%d' % fd),
                  'vfs': 'unix', 'library': loaded_library(),
                  'sqliteVersion': lib.sqlite3_libversion().decode()}
        if expected and identity != expected:
            return dict(result, status='mismatch', wroteSchema=False)
        if write_schema:
            error = ctypes.c_char_p()
            rc = lib.sqlite3_exec(db, b'CREATE TABLE probe_marker (id INTEGER PRIMARY KEY)', None, None,
                                  ctypes.byref(error))
            if rc != 0:
                raise RuntimeError('schema write failed: %d %s' % (rc, (error.value or b'').decode()))
        return dict(result, status='matched' if expected else 'observed', wroteSchema=write_schema)
    finally:
        if db:
            lib.sqlite3_close_v2(db)


def main(argv):
    if not argv or len(argv) > 3 or (len(argv) == 3 and argv[2] != '--write-schema'):
        sys.stderr.write('usage: probe.py <temp-db> [expected-id] [--write-schema]\n')
        return 64
    try:
        result = run(argv[0], argv[1] if len(argv) > 1 else '', len(argv) == 3)
    except Exception as error:  # report every failure as JSON for the Node runner
        print(json.dumps({'status': 'error', 'message': str(error)}, separators=(',', ':')))
        return 1
    print(json.dumps(result, separators=(',', ':')))
    return 2 if result['status'] == 'mismatch' else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
