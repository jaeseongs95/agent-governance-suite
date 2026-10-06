import datetime,hashlib,json,os,pathlib,platform,shutil,sys
from runner import ROOT,run
raw=ROOT/'raw';candidate=ROOT/'candidate';home=ROOT/'codex-home-disposable';sha=lambda b:hashlib.sha256(b).hexdigest()
def write(n,v):(raw/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def snapshot(label):
 _,pin,_=run(label+'-pin',['git','rev-parse','HEAD','HEAD^{tree}'],candidate);values=pin.read_text().splitlines();assert values==['4ba47558020bd5e501fa9718f09d562dcf573713','5fcc66de8aa37e6a347511c2def0eae54a0ed1e5']
 _,dirty,_=run(label+'-status',['git','status','--porcelain'],candidate)
 _,paths,_=run(label+'-paths',['git','ls-files','-z'],candidate);rows=[]
 for name in paths.read_bytes().split(b'\0'):
  if not name:continue
  name=os.fsdecode(name);p=candidate/name;b=os.readlink(p).encode() if p.is_symlink() else p.read_bytes();rows.append(dict(path=name,bytes=len(b),sha256=sha(b),symlink=p.is_symlink()))
 report=dict(head=values[0],tree=values[1],dirty=dirty.read_text(),trackedFiles=len(rows),files=rows);write(label+'.json',report);return report
def proc_observation():
 rows=[];active=[];zombies=0
 for p in sorted(pathlib.Path('/proc').iterdir()):
  if not p.name.isdigit():continue
  try:
   stat=(p/'stat').read_text();rest=stat[stat.rfind(')')+2:].split();comm=(p/'comm').read_text().strip();argv=(p/'cmdline').read_bytes().split(b'\0');test=any(b'vitest' in a or a.endswith(b'/scripts/build.mjs') for a in argv) or any(a==b'pnpm' for a in argv) and any(a in (b'test',b'build',b'runtime:check') for a in argv)
   row=dict(pid=int(p.name),state=rest[0],ppid=int(rest[1]),starttime=rest[19],comm=comm)
   if row['state']=='Z':zombies+=1
   if test and row['state']!='Z':active.append(row)
   if p.name=='1' or test:rows.append(row)
  except (FileNotFoundError,ProcessLookupError,PermissionError):continue
 return dict(observedAtUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(),pid1=next((r for r in rows if r['pid']==1),None),activeTestBuildProcesses=active,zombieProcessesObserved=zombies,heuristic='Read /proc metadata and classify arguments; no signals, sockets or process teardown. Outside namespace jobs UNKNOWN; argument contents not recorded.')
pre=snapshot('16-source-pre');assert not pre['dirty'];assert pre['trackedFiles']==1344
compat=json.loads((raw/'COMPATIBILITY.json').read_text());assert compat['state']=='STATIC_KEY_COMPATIBLE' and not compat['conflicts'];supplied=json.loads((raw/'SUPPLIED.json').read_text());assert supplied['createdNew'] and supplied['officialExecutionCount']==0
for row in supplied['files']:assert sha((home/row['temporaryPath']).read_bytes())==row['sha256']
assert os.environ.get('AGENT_GOVERNANCE_ROOT') in (None,'',str(candidate)),'Unexpected inherited AGS root; withhold official check'
tmp=ROOT/'tmp-official';tmp.mkdir();state=ROOT/'state-official';state.mkdir();observation=proc_observation();assert not observation['activeTestBuildProcesses'],'Concurrent test/build observed; do not execute'
_,p,_=run('17-node-version',['node','--version'],candidate);node=p.read_text().strip();_,p,_=run('18-pnpm-version',['pnpm','--version'],candidate);pnpm=p.read_text().strip();assert node.startswith('v24.') and pnpm=='11.19.0'
import yaml
environment=dict(environment='Actual Codex Cloud Linux',observedAtUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(),hostname=platform.node(),kernel=platform.release(),architecture=platform.machine(),pidNamespace=os.readlink('/proc/self/ns/pid'),containerCgroupSha256=sha(pathlib.Path('/proc/self/cgroup').read_bytes()),node=node,pnpm=pnpm,python=platform.python_version(),pythonExecutable=sys.executable,yamlVersion=yaml.__version__,yamlModule=yaml.__file__,hostContainerReuse='UNKNOWN: no persisted prior container identity comparison; current identity recorded without remote-host inference',workspaceReuse=dict(state='REUSED',knownPriorPaths=['/workspace/ags-cs-2x/repo','/workspace/ags-cs-2x/linux-lifecycle-r1','/workspace/ags-cs-2x/linux-lifecycle-r2','/workspace/ags-cs-2x/publication-20261006T040502Z'],newCandidateCheckout=True),depsStore=dict(runtime='REUSED preinstalled Node/pnpm/Python/PyYAML',candidateNodeModulesPresent=(candidate/'node_modules').exists(),pnpmStore='UNKNOWN: effective user configuration/store was not queried; no dependency install'),tmpStateDb=dict(tmp=str(tmp),tmpNewEmpty=True,state=str(state),stateNewEmpty=True,taskDatabase='NONE used or opened',otherDatabases='UNKNOWN/not queried'),codexHome=dict(path=str(home),createdNew=True,defaultHome='Not read or modified',profilesKeysRegistryInstalled=False),priorJobs='Prior CS artifacts exist; previous results are not reused as this check result',concurrentJobs=observation,otherSessions='UNKNOWN outside available /proc namespace; no other session transcript collected')
write('ENVIRONMENT.json',environment)
env=os.environ.copy();env.update(CODEX_HOME=str(home),PYTHON=sys.executable,PYTHONUTF8='1',PYTHONDONTWRITEBYTECODE='1',PYTHONNOUSERSITE='1',TMPDIR=str(tmp));write('EXECUTION-ENV-BINDING.json',dict(cwd=str(candidate),command=['pnpm','validate:official'],temporaryEnvironment={k:env[k] for k in ['CODEX_HOME','PYTHON','PYTHONUTF8','PYTHONDONTWRITEBYTECODE','PYTHONNOUSERSITE','TMPDIR']},scope='Child process only; no global environment/user configuration modified'))
marker=raw/'OFFICIAL-EXECUTION-ONCE.json'
with marker.open('x') as out:json.dump(dict(attempt=1,sourceHead=pre['head'],supplierCommit='10382da79a2a2d6e8ae221fa63077215389c1ad2',startedUtc=datetime.datetime.now(datetime.timezone.utc).isoformat()),out)
exit_code,out,err=run('19-validate-official',['pnpm','validate:official'],candidate,env=env,check=False)
post=snapshot('20-source-post');unchanged=pre==post;assert unchanged and not post['dirty']
for row in supplied['files']:assert sha((home/row['temporaryPath']).read_bytes())==row['sha256']
_,p,_=run('21-original-worktree-pin',['git','rev-parse','HEAD'],pathlib.Path('/workspace/ags-cs-2x/repo'));assert p.read_text().strip()=='f7912c452483ddc67ba874a185c08fa0038a38e7';_,p,_=run('22-original-worktree-clean',['git','status','--porcelain'],pathlib.Path('/workspace/ags-cs-2x/repo'));assert not p.read_bytes()
stdout=out.read_text();stderr=err.read_text();passed=stdout.count('Skill is valid!');plugin_passed='Plugin validation passed:' in stdout
result=dict(schema='AGSOfficialValidatorRun.v1',status='PASS' if exit_code==0 else 'FAIL',command=['pnpm','validate:official'],cwd=str(candidate),exitCode=exit_code,officialExecutionAttempts=1,supplierCommit='10382da79a2a2d6e8ae221fa63077215389c1ad2',candidateHead=pre['head'],candidateTree=pre['tree'],trackedFiles=1344,sourcePrePostByteExact=unchanged,sourceDirtyPre=pre['dirty'],sourceDirtyPost=post['dirty'],pluginPassed=plugin_passed,skillsPassed=passed,skillsExpected=compat['skillCount'],stdoutPath=str(out),stdoutBytes=out.stat().st_size,stdoutSha256=sha(out.read_bytes()),stderrPath=str(err),stderrBytes=err.stat().st_size,stderrSha256=sha(err.read_bytes()),suppliedFilesByteExactAfter=True,fullTestsBuildRuntimeReexecuted=False,fixtureR1R2Integrated=False,mainTagReleaseInstallPushPerformed=False,claimScope='Official plugin/skill metadata validation only; not a full regression, runtime, release approval or independent audit',finishedUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(),concurrentAfter=proc_observation())
if exit_code==0:assert passed==compat['skillCount'] and plugin_passed
write('OFFICIAL-RESULT.json',result);print(json.dumps(result,ensure_ascii=False,indent=2));sys.exit(0 if exit_code==0 else exit_code)
