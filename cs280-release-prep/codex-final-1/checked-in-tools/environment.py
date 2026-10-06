import datetime, hashlib, json, os, pathlib, platform, sys
from runner import ROOT, run, write
HEAD = 'b7341d3e6636b79217b1f3d37d7a5014fcbf47be'
TREE = '5648f76558e923244cedf78a8263892d00df8299'
CANDIDATE = ROOT / 'candidate'
sha = lambda b: hashlib.sha256(b).hexdigest()
def snapshot(label):
    _, out, _ = run(label + '-pin', ['git', 'rev-parse', 'HEAD', 'HEAD^{tree}'], CANDIDATE)
    assert out.read_text().splitlines() == [HEAD, TREE]
    _, out, _ = run(label + '-status', ['git', 'status', '--porcelain'], CANDIDATE)
    dirty = out.read_text()
    _, out, _ = run(label + '-paths', ['git', 'ls-files', '-z'], CANDIDATE)
    rows = []
    for value in out.read_bytes().split(b'\0'):
        if not value: continue
        name = os.fsdecode(value)
        p = CANDIDATE / name
        data = os.fsencode(os.readlink(p)) if p.is_symlink() else p.read_bytes()
        rows.append(dict(path=name, bytes=len(data), sha256=sha(data), symlink=p.is_symlink()))
    report = dict(head=HEAD, tree=TREE, dirty=dirty, trackedFiles=len(rows), files=rows)
    write(label + '.json', report)
    return report
def processes():
    active, zombies, pid1 = [], 0, None
    for p in sorted(pathlib.Path('/proc').iterdir()):
        if not p.name.isdigit(): continue
        try:
            data = (p / 'stat').read_text()
            fields = data[data.rfind(')') + 2:].split()
            argv = (p / 'cmdline').read_bytes().split(b'\0')
            row = dict(pid=int(p.name), state=fields[0], ppid=int(fields[1]), starttime=fields[19], comm=(p / 'comm').read_text().strip())
            if row['state'] == 'Z': zombies += 1
            if p.name == '1': pid1 = row
            test = any(b'vitest' in a or a.endswith(b'/scripts/build.mjs') for a in argv) or any(a == b'pnpm' for a in argv) and any(a in (b'test', b'build', b'install', b'runtime:check') for a in argv)
            if test and row['state'] != 'Z': active.append(row)
        except (FileNotFoundError, ProcessLookupError, PermissionError): continue
    return dict(observedAtUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(), pid1=pid1, activeTestBuildInstallProcesses=active,
                zombiesObserved=zombies, scope='Current namespace /proc metadata only, no argv contents, signals/sockets/reaping. Outside namespace jobs UNKNOWN.')
def verify_supplier():
    supplied = json.loads((ROOT / 'raw/SUPPLIED.json').read_text())
    for row in supplied['verifiedFiles']:
        assert sha((ROOT / 'codex-home-disposable' / row['temporaryPath']).read_bytes()) == row['sha256']
    return supplied
def child_environment():
    env = os.environ.copy()
    assert env.get('AGENT_GOVERNANCE_ROOT') in (None, '', str(CANDIDATE)), 'Unexpected inherited AGS root'
    env.update(CODEX_HOME=str(ROOT / 'codex-home-disposable'), PYTHON=sys.executable, PYTHONUTF8='1',
               PYTHONDONTWRITEBYTECODE='1', PYTHONNOUSERSITE='1', TMPDIR=str(ROOT / 'tmp-private'))
    return env
