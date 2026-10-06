import datetime, json, os, pathlib, platform, sys
import yaml
from environment import CANDIDATE, ROOT, child_environment, processes, sha, snapshot, verify_supplier
from runner import run, write
pre = snapshot('18-before-install')
assert pre['dirty'] == '' and pre['trackedFiles'] == 1344
verify_supplier()
assert not (CANDIDATE / 'node_modules').exists(), 'New dependency tree required'
store = ROOT / 'pnpm-store-private'
tmp = ROOT / 'tmp-private'
state = ROOT / 'state-private'
for p in (store, tmp, state):
    assert not p.exists()
    p.mkdir(mode=0o700)
env = child_environment()
observation = processes()
assert not observation['activeTestBuildInstallProcesses'], 'Concurrent product job observed; withhold install'
_, out, _ = run('19-node-version', ['node', '--version'], CANDIDATE)
node = out.read_text().strip()
_, out, _ = run('20-pnpm-version', ['pnpm', '--version'], CANDIDATE)
pnpm = out.read_text().strip()
assert node.startswith('v24.') and pnpm == '11.19.0'
_, out, _ = run('21-effective-store-before', ['pnpm', '--store-dir', str(store), 'store', 'path'], CANDIDATE, env)
effective_store = pathlib.Path(out.read_text().strip()).resolve()
effective_store.relative_to(store.resolve())
prior = json.loads((ROOT.parent / 'official-validator-26c6c9d9/raw/ENVIRONMENT.json').read_text())
identity = dict(hostname=platform.node(), kernel=platform.release(), architecture=platform.machine(),
                pidNamespace=os.readlink('/proc/self/ns/pid'), containerCgroupSha256=sha(pathlib.Path('/proc/self/cgroup').read_bytes()))
local_matches = all(identity[k] == prior[k] for k in ('hostname', 'pidNamespace', 'containerCgroupSha256')) and observation['pid1'] == prior['concurrentJobs']['pid1']
write('ENVIRONMENT.json', dict(environment='Actual Codex Cloud Linux', observedAtUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(), **identity,
    node=node, pnpm=pnpm, python=platform.python_version(), pythonExecutable=sys.executable, yamlVersion=yaml.__version__, yamlModule=yaml.__file__,
    workspace='REUSED; this candidate checkout is NEW', runtime='REUSED preinstalled Node/pnpm/Python/PyYAML',
    container='Current local namespace identity and PID1 match prior official1' if local_matches else 'UNKNOWN continuity; actual identities recorded',
    remoteEnvironmentReuse='Not inferred', deps=dict(state='NEW, no node_modules before install, no sharing of prior node_modules',
       storeArgument=str(store), effectiveStore=str(effective_store), storeNewEmptyAtCreation=True, userGlobalConfiguration='Not queried/repaired/modified by task'),
    tmp=dict(path=str(tmp), createdNew=True), state=dict(path=str(state), createdNew=True, database='NONE used/opened'),
    otherDatabases='UNKNOWN/not queried', codeHome=dict(path=env['CODEX_HOME'], createdNew=True, supplierBytesReverified=True, noProfilesRegistryKeys=True),
    priorJobs='Prior CS/official1 artifacts retained; prior results not reused as this outcome', concurrent=observation,
    firstOfficial1='exit1 before Python validators, implicit install/user-store ENOENT retained',
    changedInput='New final source b734; explicitly authorized frozen install with private --store-dir; no dependency gate relaxation'))
write('INSTALL-ENV-BINDING.json', dict(cwd=str(CANDIDATE), command=['pnpm', '--store-dir', str(store), 'install', '--frozen-lockfile'],
    childOnlyEnvironment={k: env[k] for k in ('CODEX_HOME', 'PYTHON', 'PYTHONUTF8', 'PYTHONDONTWRITEBYTECODE', 'PYTHONNOUSERSITE', 'TMPDIR')},
    defaultHomeChanged=False, userConfigChanged=False, verifyDepsBeforeRun='Unchanged; no bypass flag/env'))
with (ROOT / 'raw/LOCKED-INSTALL-ONCE.json').open('x') as out:
    json.dump(dict(attempt=1, startedUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(), sourceHead=pre['head']), out)
code, stdout, stderr = run('22-locked-install', ['pnpm', '--store-dir', str(store), 'install', '--frozen-lockfile'], CANDIDATE, env, check=False)
post = snapshot('23-after-install')
unchanged = pre == post
verify_supplier()
workspace_path = CANDIDATE / 'node_modules/.pnpm-workspace-state-v1.json'
modules_path = CANDIDATE / 'node_modules/.modules.yaml'
workspace = json.loads(workspace_path.read_text()) if workspace_path.is_file() else None
modules = yaml.safe_load(modules_path.read_text()) if modules_path.is_file() else None
ready = False
if code == 0 and unchanged and workspace and modules:
    (ROOT / 'raw/PNPM-WORKSPACE-STATE.json').write_bytes(workspace_path.read_bytes())
    (ROOT / 'raw/PNPM-MODULES.yaml').write_bytes(modules_path.read_bytes())
    projects = workspace.get('projects', {})
    ready = str(CANDIDATE) in projects and projects[str(CANDIDATE)].get('name') == 'agent-governance-suite' and projects[str(CANDIDATE)].get('version') == '2.8.0'
    ready = ready and pathlib.Path(modules['storeDir']).resolve() == effective_store and modules['packageManager'] == 'pnpm@11.19.0'
    ready = ready and workspace.get('settings', {}).get('allowBuilds') == {'esbuild': True}
    for name in ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'):
        assert (CANDIDATE / name).stat().st_mtime * 1000 <= workspace['lastValidatedTimestamp']
_, out, _ = run('24-effective-store-after', ['pnpm', '--store-dir', str(store), 'store', 'path'], CANDIDATE, env)
assert pathlib.Path(out.read_text().strip()).resolve() == effective_store
result = dict(status='LOCKED_DEPS_READY' if code == 0 and ready else 'BLOCKED_INSTALL_OR_STATE', installAttempts=1, exitCode=code,
    frozenLockfile=True, sourceHead=pre['head'], sourceTree=pre['tree'], trackedFiles=1344, sourcePrePostExact=unchanged,
    lockSha256Before=next(r['sha256'] for r in pre['files'] if r['path']=='pnpm-lock.yaml'),
    lockSha256After=next(r['sha256'] for r in post['files'] if r['path']=='pnpm-lock.yaml'),
    dirtyPre=pre['dirty'], dirtyPost=post['dirty'], nodeModulesCreated=(CANDIDATE / 'node_modules').exists(),
    storeArgument=str(store), effectiveStore=str(effective_store), workspaceStatePresent=workspace is not None, modulesStatePresent=modules is not None,
    lockedDependenciesReady=bool(ready), officialValidatorAttempts=0, stdoutPath=str(stdout), stdoutSha256=sha(stdout.read_bytes()),
    stderrPath=str(stderr), stderrSha256=sha(stderr.read_bytes()), noGlobalRepair=True, supplierBytesExactAfter=True,
    completedAtUtc=datetime.datetime.now(datetime.timezone.utc).isoformat())
write('INSTALL-RESULT.json', result)
print(json.dumps(result, ensure_ascii=False, indent=2))
sys.exit(0 if result['status']=='LOCKED_DEPS_READY' else (code or 1))
