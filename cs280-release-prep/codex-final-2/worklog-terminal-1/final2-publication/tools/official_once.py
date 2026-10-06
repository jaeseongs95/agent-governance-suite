import datetime, hashlib, json, os, pathlib, platform, sys
import yaml
from runner import ROOT, run, write
PRIOR=ROOT.parent/'official-final-3ff79982'
CANDIDATE=PRIOR/'candidate'
STORE=PRIOR/'pnpm-store-private'
HOME_SUPPLIER=PRIOR/'codex-home-disposable'
HEAD='b7341d3e6636b79217b1f3d37d7a5014fcbf47be'
TREE='5648f76558e923244cedf78a8263892d00df8299'
sha=lambda b:hashlib.sha256(b).hexdigest()
def snapshot(label):
    _,out,_=run(label+'-pin',['git','rev-parse','HEAD','HEAD^{tree}'],CANDIDATE)
    assert out.read_text().splitlines()==[HEAD,TREE]
    _,out,_=run(label+'-clean',['git','status','--porcelain'],CANDIDATE)
    assert not out.read_bytes()
    _,out,_=run(label+'-paths',['git','ls-files','-z'],CANDIDATE)
    rows=[]
    for name in out.read_bytes().split(b'\0'):
        if not name:continue
        name=os.fsdecode(name);p=CANDIDATE/name;data=os.fsencode(os.readlink(p)) if p.is_symlink() else p.read_bytes()
        rows.append(dict(path=name,bytes=len(data),sha256=sha(data),symlink=p.is_symlink()))
    result=dict(head=HEAD,tree=TREE,dirty='',trackedFiles=len(rows),files=rows)
    write(label+'.json',result)
    return result
def processes():
    active=[];pid1=None;zombies=0
    for p in pathlib.Path('/proc').iterdir():
        if not p.name.isdigit():continue
        try:
            data=(p/'stat').read_text();fields=data[data.rfind(')')+2:].split();argv=(p/'cmdline').read_bytes().split(b'\0')
            row=dict(pid=int(p.name),state=fields[0],ppid=int(fields[1]),starttime=fields[19],comm=(p/'comm').read_text().strip())
            if p.name=='1':pid1=row
            if row['state']=='Z':zombies+=1
            test=any(b'vitest' in a or a.endswith(b'/scripts/build.mjs') for a in argv) or any(a==b'pnpm' for a in argv) and any(a in (b'test',b'build',b'install',b'runtime:check') for a in argv)
            if test and row['state']!='Z':active.append(row)
        except (FileNotFoundError,ProcessLookupError,PermissionError):continue
    return dict(pid1=pid1,activeTestBuildInstallProcesses=active,zombiesObserved=zombies,observedAtUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                scope='Current /proc namespace only, no argv contents/signals/sockets/reaping; external jobs UNKNOWN')
installation=json.loads((PRIOR/'raw/INSTALL-RESULT.json').read_text())
prior_result=json.loads((PRIOR/'raw/OFFICIAL-RESULT.json').read_text())
assert installation['status']=='LOCKED_DEPS_READY' and installation['exitCode']==0
assert prior_result['exitCode']==1 and prior_result['skillsPassed']==0 and prior_result['dependencyStateByteExact']
assert json.loads((PRIOR/'raw/ANNOTATED-RESULT.json').read_text())['officialPythonValidatorExecutions']==0
pre=snapshot('01-before-final2')
assert pre==json.loads((PRIOR/'raw/31-after-official.json').read_text()) and pre['trackedFiles']==1344
supplied=json.loads((PRIOR/'raw/SUPPLIED.json').read_text())
def check_supplier():
    for row in supplied['verifiedFiles']:assert sha((HOME_SUPPLIER/row['temporaryPath']).read_bytes())==row['sha256']
check_supplier()
state_paths=[CANDIDATE/'node_modules/.pnpm-workspace-state-v1.json',CANDIDATE/'node_modules/.modules.yaml']
state_before={str(p.relative_to(CANDIDATE)):sha(p.read_bytes()) for p in state_paths}
assert state_before==prior_result['dependencyStateAfter']
bundle=pathlib.Path('/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/dist/pnpm.mjs')
code=bundle.read_text();lines=code.splitlines()
assert sha(bundle.read_bytes())==json.loads((PRIOR/'raw/PNPM-RUN-OPTION-SOURCE.json').read_text())['sha256']
assert 'function* parseEnvVars(getSchema, env4)' in code and 'PREFIX = "pnpm_config_"' in code and '"store-dir": String' in code
assert 'for (const { key, value } of parseEnvVars((key2) => envPnpmTypes[key2], env4))' in code
ranges=[(148057,148078),(148172,148198),(149733,149742),(150325,150348),(150079,150085)]
write('PNPM-ENV-PARSER-PIN.json',dict(path=str(bundle),sha256=sha(bundle.read_bytes()),version='11.19.0',
    mapping='pnpm_config_store_dir -> lower-snake suffix store_dir -> kebab schema store-dir String -> camel storeDir -> pnpmConfig assignment',
    excerpts=[dict(start=a,end=b,lines=[dict(number=i,text=lines[i-1]) for i in range(a,b+1)]) for a,b in ranges]))
tmp=ROOT/'tmp-private';tmp.mkdir(mode=0o700)
state=ROOT/'state-private';state.mkdir(mode=0o700)
env=os.environ.copy()
assert env.get('AGENT_GOVERNANCE_ROOT') in (None,'',str(CANDIDATE))
assert env.get('PNPM_CONFIG_STORE_DIR') in (None,'',str(STORE)), 'Conflicting inherited uppercase store binding'
env.update(CODEX_HOME=str(HOME_SUPPLIER),PYTHON=sys.executable,PYTHONUTF8='1',PYTHONDONTWRITEBYTECODE='1',PYTHONNOUSERSITE='1',TMPDIR=str(tmp),pnpm_config_store_dir=str(STORE))
for key in ('pnpm_config_verify_deps_before_run','PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN'):
    assert env.get(key) in (None,''), 'Inherited dependency gate override; withhold run'
observation=processes();assert not observation['activeTestBuildInstallProcesses']
_,out,_=run('02-node-version',['node','--version'],CANDIDATE);node=out.read_text().strip();assert node.startswith('v24.')
_,out,_=run('03-pnpm-version',['pnpm','--version'],CANDIDATE);pnpm=out.read_text().strip();assert pnpm=='11.19.0'
_,out,_=run('04-child-config-store-dir',['pnpm','config','get','store-dir'],CANDIDATE,env)
assert pathlib.Path(out.read_text().strip()).resolve()==STORE.resolve(), 'Child store config mismatch; no validator run'
_,out,_=run('05-child-effective-store',['pnpm','store','path'],CANDIDATE,env)
effective=pathlib.Path(out.read_text().strip()).resolve()
assert str(effective)==installation['effectiveStore'] and effective==STORE.resolve()/'v11'
assert state_before=={str(p.relative_to(CANDIDATE)):sha(p.read_bytes()) for p in state_paths}
check_supplier()
identity=dict(hostname=platform.node(),kernel=platform.release(),architecture=platform.machine(),pidNamespace=os.readlink('/proc/self/ns/pid'),containerCgroupSha256=sha(pathlib.Path('/proc/self/cgroup').read_bytes()))
write('ENVIRONMENT.json',dict(environment='Actual Codex Cloud Linux',**identity,node=node,pnpm=pnpm,python=platform.python_version(),pythonExecutable=sys.executable,yamlVersion=yaml.__version__,
    workspace='REUSED; same clean disposable final1 checkout',runtime='REUSED preinstalled runtime',deps='REUSED exact locked final1 node_modules and workspace/module state; no new install',
    storeArgument=str(STORE),effectiveStore=str(effective),store='REUSED task-owned private store from verified frozen install',
    codeHome='REUSED final1 private CODEX_HOME, exact5 supplier files verified',tmp=dict(path=str(tmp),createdNew=True),state=dict(path=str(state),createdNew=True,database='NONE'),
    otherDatabases='UNKNOWN/not queried',container='Current local identities recorded; remote reuse not inferred',priorJobs='Final1 and official1 failures preserved',concurrent=observation,
    changedInput='Only child pnpm_config_store_dir added; unsupported run CLI store-dir removed. No model/effort/gate[REDACTED:PRIVATE_HOME] config field changed.'))
write('EXECUTION-ENV-BINDING.json',dict(command=['pnpm','run','validate:official'],cwd=str(CANDIDATE),
    childOnlyEnvironment={k:env[k] for k in ('CODEX_HOME','PYTHON','PYTHONUTF8','PYTHONDONTWRITEBYTECODE','PYTHONNOUSERSITE','TMPDIR','pnpm_config_store_dir')},
    configStoreDirMatches=True,storePathMatches=True,dependencyStateBefore=state_before,noGateOverride=True,globalUserConfigurationWrites=0,priorPnPMWrapperFailures=2))
with (ROOT/'raw/FINAL2-OFFICIAL-ACTUAL-ONCE.json').open('x') as out:
    json.dump(dict(attempt=1,sourceHead=HEAD,sourceTree=TREE,startedUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(),authorization='d0ce2935-ef6b-45b5-b3d0-68b4fc2a1c75'),out)
exit_code,stdout,stderr=run('06-final2-validate-official',['pnpm','run','validate:official'],CANDIDATE,env,check=False)
post=snapshot('07-after-final2');check_supplier()
state_after={str(p.relative_to(CANDIDATE)):sha(p.read_bytes()) for p in state_paths}
text=stdout.read_text();plugin='Plugin validation passed:' in text;skills=text.count('Skill is valid!')
result=dict(schema='AGSFinal2OfficialValidation.v1',status='PASS' if exit_code==0 and plugin and skills==22 and pre==post else 'FAIL',
    command=['pnpm','run','validate:official'],cwd=str(CANDIDATE),exitCode=exit_code,changedInputCommandAttempts=1,priorWrapperFailuresPreserved=2,
    pluginPassed=plugin,skillsPassed=skills,skillsExpected=22,officialMetadataScopeOnly=True,
    sourceHead=HEAD,sourceTree=TREE,trackedFiles=1344,sourcePrePostExact=pre==post,sourceClean=True,
    supplierCommit=supplied['sourceCommit'],supplierFiveFilesByteExact=True,dependencyStateBefore=state_before,dependencyStateAfter=state_after,dependencyStateByteExact=state_before==state_after,
    lockSha256=installation['lockSha256After'],storeConfig=str(STORE),effectiveStore=str(effective),noGateOverride=True,newInstallAttempts=0,
    implicitInstallObserved=('Packages:' in text or 'Progress: resolved' in text or 'Lockfile is up to date' in text),
    observationLimit='Actual pnpm outputs and unchanged source/dependency/supplier bytes; no full per-child syscall trace',
    stdoutPath=str(stdout),stdoutBytes=stdout.stat().st_size,stdoutSha256=sha(stdout.read_bytes()),stderrPath=str(stderr),stderrBytes=stderr.stat().st_size,stderrSha256=sha(stderr.read_bytes()),
    fullTestsBuildRuntimeRun=0,productWrites=0,mainTagReleaseHostInstall=0,firstOfficial1AndFinal1Unchanged=True,
    signedWholeLifecycleGlobalAcceptance='NOT_IMPLEMENTED unchanged',qualityABC='NOT_RUN',independentSourceAudit='Separate parent responsibility',
    completedAtUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(),concurrentAfter=processes())
write('OFFICIAL-RESULT.json',result);print(json.dumps(result,ensure_ascii=False,indent=2))
sys.exit(0 if result['status']=='PASS' else (exit_code or 1))
