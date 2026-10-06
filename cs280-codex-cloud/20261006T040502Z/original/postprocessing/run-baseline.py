import datetime,json,os,pathlib,subprocess,sys
root=pathlib.Path('/workspace/ags-cs-2x')
label=sys.argv[1];command=sys.argv[2:]
env=dict(os.environ,XDG_DATA_HOME=str(root/'tool-state/data'),XDG_CACHE_HOME=str(root/'tool-state/cache'),TMPDIR='/dev/shm/ags-cs-2x-tests',npm_config_store_dir=str(root/'tool-state/pnpm-store'),CI='true')
for name in list(env):
 if name.startswith('AGENT_GOVERNANCE_'):env.pop(name)
env.update(XDG_STATE_HOME=str(root/'tool-state/state'),AGENT_GOVERNANCE_SHARED_STATE_DIR=str(root/'tool-state/state'),PYTHONDONTWRITEBYTECODE='1')
pathlib.Path(env['TMPDIR']).mkdir(mode=0o700,exist_ok=True)
log=root/'evidence'/f'{label}.log'
start=datetime.datetime.now(datetime.timezone.utc).isoformat()
with log.open('w') as out:
 out.write(json.dumps({'command':command,'cwd':str(root/'baseline'),'started':start,'isolation':{'TMPDIR':env['TMPDIR'],'XDG_DATA_HOME':env['XDG_DATA_HOME'],'XDG_CACHE_HOME':env['XDG_CACHE_HOME']}},ensure_ascii=False)+'\n');out.flush()
 result=subprocess.run(command,cwd=root/'baseline',env=env,stdout=out,stderr=subprocess.STDOUT)
record={'label':label,'command':command,'cwd':str(root/'baseline'),'started':start,'finished':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':result.returncode,'log':log.name}
with (root/'evidence/commands.jsonl').open('a') as out:out.write(json.dumps(record,ensure_ascii=False)+'\n')
print(json.dumps(record,ensure_ascii=False));sys.exit(result.returncode)
