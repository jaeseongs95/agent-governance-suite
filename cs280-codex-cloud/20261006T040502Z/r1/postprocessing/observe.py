import contextlib, ctypes, datetime, json, os, pathlib, sqlite3, subprocess, sys, threading, time

root=pathlib.Path('/workspace/ags-cs-2x/linux-lifecycle-r1')
repo=pathlib.Path('/workspace/ags-cs-2x/repo')
label=sys.argv[1];reap=sys.argv[2]=='reap';database_reads=sys.argv[3]!='--process-only';command=sys.argv[3:] if database_reads else sys.argv[4:]
evidence=root/'evidence';evidence.mkdir(parents=True,exist_ok=True)
tmp=pathlib.Path('/dev/shm/ags-cs-lifecycle-r1')/label;tmp.mkdir(parents=True,mode=0o700,exist_ok=True)
env=dict(os.environ,TMPDIR=str(tmp),XDG_DATA_HOME=str(root/'tool-state/data'),XDG_CACHE_HOME=str(root/'tool-state/cache'),XDG_STATE_HOME=str(root/'tool-state/state'),npm_config_store_dir='/workspace/ags-cs-2x/tool-state/pnpm-store',CI='true',PYTHONDONTWRITEBYTECODE='1')
for name in list(env):
 if name.startswith('AGENT_GOVERNANCE_'):env.pop(name)
env['AGENT_GOVERNANCE_SHARED_STATE_DIR']=str(root/'tool-state/state')
if reap:
 libc=ctypes.CDLL(None,use_errno=True)
 if libc.prctl(36,1,0,0,0)!=0:raise OSError(ctypes.get_errno(),'PR_SET_CHILD_SUBREAPER')
known={};roles={};events=[];states={};seen_dirs=set();observed_files={}
def emit(kind,**data):events.append({'t':round(time.monotonic()-start_clock,4),'kind':kind,**data})
def proc(pid):
 try:
  raw=pathlib.Path(f'/proc/{pid}/stat').read_text();fields=raw[raw.rindex(')')+2:].split()
  return {'pid':pid,'state':fields[0],'ppid':int(fields[1]),'start':fields[19]}
 except (OSError,ValueError,IndexError):return None
def observe():
 while not stop.is_set():
  current={}
  for path in pathlib.Path('/proc').iterdir():
   if path.name.isdecimal():
    row=proc(int(path.name))
    if row:current[row['pid']]=row
  members={process.pid}|{pid for pid,row in known.items() if current.get(pid,{}).get('start')==row['start']}
  while True:
   extra={pid for pid,row in current.items() if row['ppid'] in members}-members
   if not extra:break
   members.update(extra)
  for pid in members:
   if pid not in current:continue
   row=current[pid]
   if known.get(pid)!=row:
    emit('process-state',**row);known[pid]=row
  for directory in tmp.iterdir():
   if not directory.is_dir():continue
   if directory not in seen_dirs:seen_dirs.add(directory);emit('fixture-directory',path=directory.name)
   endpoint=directory/'endpoint.json'
   try:
    value=json.loads(endpoint.read_text());pid=value['pid'];roles[pid]='broker'
    if observed_files.get(str(endpoint))!=pid:emit('broker-endpoint',path=directory.name,pid=pid);observed_files[str(endpoint)]=pid
   except (OSError,ValueError,KeyError):
    if str(endpoint) in observed_files:emit('broker-endpoint-removed',path=directory.name,pid=observed_files.pop(str(endpoint)))
   db=directory/'session-messages.sqlite3'
   if not database_reads or not directory.name.startswith(('session-messaging-','ags-wake-history-')) or not db.is_file():continue
   try:
    with contextlib.closing(sqlite3.connect(db.as_uri()+'?mode=ro',uri=True,timeout=0.01)) as conn:
     presence=conn.execute('SELECT session_id, transport, instance_id, ended_at FROM session_presence').fetchall()
     relays=conn.execute('SELECT pid,parent_pid,transport FROM relay_leases').fetchall()
    for pid,parent,transport in relays:
     if pid!=parent:roles[pid]='relay'
    state={'presence':presence,'relays':relays}
    if states.get(str(directory))!=state:
     emit('fixture-state',path=directory.name,**state);states[str(directory)]=state
   except sqlite3.Error:pass
  if reap:
   for pid,row in current.items():
    if pid!=process.pid and row['ppid']==os.getpid():
     try:
      found,status=os.waitpid(pid,os.WNOHANG)
      if found:emit('reaped',pid=pid,exit=os.waitstatus_to_exitcode(status))
     except ChildProcessError:pass
  stop.wait(0.01)
start_clock=time.monotonic();started=datetime.datetime.now(datetime.timezone.utc).isoformat();stop=threading.Event()
log=evidence/(label+'.log')
with log.open('w') as output:
 output.write(json.dumps({'command':command,'cwd':str(repo),'started':started,'subreaper':reap,'databaseReads':database_reads,'pid1':pathlib.Path('/proc/1/comm').read_text().strip(),'isolation':{'TMPDIR':str(tmp),'sharedState':env['AGENT_GOVERNANCE_SHARED_STATE_DIR']}})+'\n');output.flush()
 process=subprocess.Popen(command,cwd=repo,env=env,stdout=output,stderr=subprocess.STDOUT)
 thread=threading.Thread(target=observe);thread.start()
 result=process.wait();stop.set();thread.join()
for event in events:
 if event.get('pid') in roles:event['role']=roles[event['pid']]
record={'label':label,'command':command,'cwd':str(repo),'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),'started':started,'finished':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':result,'subreaper':reap,'log':log.name,'events':events,'knownFixtureRoles':roles,'scope':'Only this invocation descendants and synthetic fixture directories; no credentials/body/nonce values logged.'}
(evidence/(label+'.observations.json')).write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n')
with (evidence/'commands.jsonl').open('a') as out:out.write(json.dumps({k:v for k,v in record.items() if k not in ('events','knownFixtureRoles')})+'\n')
print(json.dumps({'label':label,'exitCode':result,'subreaper':reap,'observations':len(events),'fixtureRoles':roles}))
sys.exit(result)
