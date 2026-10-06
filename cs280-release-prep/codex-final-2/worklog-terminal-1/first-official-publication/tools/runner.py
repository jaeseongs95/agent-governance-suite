import datetime, json, pathlib, subprocess, sys
ROOT = pathlib.Path(__file__).resolve().parents[1]
LOGS = ROOT / 'raw/logs'
LOGS.mkdir(parents=True, exist_ok=True)
def run(label, command, cwd, env=None, check=True):
    if pathlib.Path(command[0]).name in ('python','python3','node'):
        assert not any(a in ('-c','-e','--eval') for a in command[1:]), 'Inline process code prohibited'
    paths = [LOGS / (label+suffix) for suffix in ('.stdout.log','.stderr.log','.command.json')]
    assert not any(p.exists() for p in paths), 'Never overwrite previous evidence'
    record = dict(label=label, command=list(map(str,command)), cwd=str(cwd), startedUtc=datetime.datetime.now(datetime.timezone.utc).isoformat())
    with paths[0].open('wb') as out, paths[1].open('wb') as err:
        result = subprocess.run(list(map(str,command)), cwd=cwd, env=env, stdout=out, stderr=err)
    record.update(exitCode=result.returncode, finishedUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(), stdout=paths[0].name, stderr=paths[1].name)
    paths[2].write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n')
    with (LOGS/'commands.jsonl').open('a') as out: out.write(json.dumps(record,ensure_ascii=False)+'\n')
    print(json.dumps(record),flush=True)
    if check and result.returncode: raise RuntimeError(f'{label} exit {result.returncode}; actual stdout/stderr preserved')
    return result.returncode, paths[0], paths[1]
def write(name, value):
    (ROOT/'raw'/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
if __name__=='__main__':
    label,cwd,*command=sys.argv[1:]
    code,_,_=run(label,command,cwd,check=False)
    sys.exit(code)
