import datetime, json, pathlib, sys
from environment import CANDIDATE, ROOT, child_environment, processes, sha, snapshot, verify_supplier
from runner import run, write
installation = json.loads((ROOT / 'raw/INSTALL-RESULT.json').read_text())
assert installation['status'] == 'LOCKED_DEPS_READY' and installation['exitCode'] == 0 and installation['installAttempts'] == 1
assert installation['sourcePrePostExact'] and installation['lockedDependenciesReady']
compatibility = json.loads((ROOT / 'raw/COMPATIBILITY.json').read_text())
assert compatibility['state'] == 'STATIC_KEY_COMPATIBLE' and compatibility['skillCount'] == 22
verify_supplier()
pre = snapshot('28-before-official')
assert pre == json.loads((ROOT / 'raw/23-after-install.json').read_text()) and not pre['dirty']
observation = processes()
assert not observation['activeTestBuildInstallProcesses']
store = ROOT / 'pnpm-store-private'
env = child_environment()
_, out, _ = run('29-effective-store-official', ['pnpm', '--store-dir', str(store), 'store', 'path'], CANDIDATE, env)
assert str(pathlib.Path(out.read_text().strip()).resolve()) == installation['effectiveStore']
state_paths = [CANDIDATE / 'node_modules/.pnpm-workspace-state-v1.json', CANDIDATE / 'node_modules/.modules.yaml']
state_before = {str(p.relative_to(CANDIDATE)): sha(p.read_bytes()) for p in state_paths}
command = ['pnpm', '--store-dir', str(store), 'validate:official']
write('OFFICIAL-ENV-BINDING.json', dict(cwd=str(CANDIDATE), command=command,
    childOnlyEnvironment={k: env[k] for k in ('CODEX_HOME', 'PYTHON', 'PYTHONUTF8', 'PYTHONDONTWRITEBYTECODE', 'PYTHONNOUSERSITE', 'TMPDIR')},
    effectiveStore=installation['effectiveStore'], dependencyGate='Unchanged; no verify-deps-before-run override',
    lockedDepsBefore=state_before, concurrentBefore=observation, globalUserConfigurationModified=False))
with (ROOT / 'raw/FINAL-OFFICIAL-ONCE.json').open('x') as out:
    json.dump(dict(attempt=1, sourceHead=pre['head'], supplierCommit='10382da79a2a2d6e8ae221fa63077215389c1ad2',
                   startedUtc=datetime.datetime.now(datetime.timezone.utc).isoformat()), out)
code, stdout, stderr = run('30-final-validate-official', command, CANDIDATE, env, check=False)
post = snapshot('31-after-official')
supplier = verify_supplier()
state_after = {str(p.relative_to(CANDIDATE)): sha(p.read_bytes()) for p in state_paths}
text = stdout.read_text()
plugin_pass = 'Plugin validation passed:' in text
skill_passes = text.count('Skill is valid!')
result = dict(schema='AGSFinalOfficialValidation.v1', status='PASS' if code == 0 and plugin_pass and skill_passes == 22 and pre == post else 'FAIL',
    officialAttempts=1, command=command, cwd=str(CANDIDATE), exitCode=code, pluginPassed=plugin_pass, skillsPassed=skill_passes, skillsExpected=22,
    sourceHead=pre['head'], sourceTree=pre['tree'], trackedFiles=1344, sourcePrePostByteExact=pre==post, sourceCleanPrePost=not pre['dirty'] and not post['dirty'],
    supplierCommit=supplier['sourceCommit'], suppliedFilesByteExactAfter=True, effectiveStore=installation['effectiveStore'],
    lockSha256=installation['lockSha256After'], dependencyStateBefore=state_before, dependencyStateAfter=state_after, dependencyStateByteExact=state_before==state_after,
    installAttempts=1, lockedInstallExitCode=installation['exitCode'], implicitInstallObserved=('Packages:' in text or 'Lockfile is up to date' in text or 'Progress: resolved' in text),
    observationLimit='No full process/syscall trace collected; stdout and unchanged workspace/module state recorded. No dependency gate override applied.',
    stdoutPath=str(stdout), stdoutBytes=stdout.stat().st_size, stdoutSha256=sha(stdout.read_bytes()),
    stderrPath=str(stderr), stderrBytes=stderr.stat().st_size, stderrSha256=sha(stderr.read_bytes()),
    sourceWrites=0, fullTestsBuildRuntimeExecuted=0, fixtureR1R2Integrated=False, mainTagReleaseHostInstallPush=0,
    firstOfficial1='Frozen4ba pnpm exit1 / official Python NOT_RUN preserved; final changed-input PASS does not relabel it',
    signedWholeLifecycleGlobalAcceptance='NOT_IMPLEMENTED unchanged', independentAudit='Not performed by implementer',
    scope='Official plugin/22 skill metadata validators at exact final pin only; not full regression, actual host install, quality A/B/C, release or SOURCE approval',
    completedAtUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(), concurrentAfter=processes())
write('OFFICIAL-RESULT.json', result)
print(json.dumps(result, ensure_ascii=False, indent=2))
sys.exit(0 if result['status']=='PASS' else (code or 1))
