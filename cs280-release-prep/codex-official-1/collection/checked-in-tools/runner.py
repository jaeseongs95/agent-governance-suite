import datetime,json,pathlib,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[1]
LOGS=ROOT/'raw/logs'
LOGS.mkdir(parents=True,exist_ok=True)
def run(label,command,cwd,env=None,check=True):
 for executable in ('python','python3','node'):
  if pathlib.Path(command[0]).name==executable:
   assert not any(x in ('-c','-e','--eval') for x in command[1:]),'Inline execution prohibited'
 record=dict(label=label,command=list(map(str,command)),cwd=str(cwd),startedUtc=datetime.datetime.now(datetime.timezone.utc).isoformat())
 stdout=LOGS/(label+'.stdout.log');stderr=LOGS/(label+'.stderr.log');meta=LOGS/(label+'.command.json')
 assert not any(p.exists() for p in (stdout,stderr,meta)),'Existing evidence must not be overwritten'
 with stdout.open('wb') as out,stderr.open('wb') as err:
  result=subprocess.run(list(map(str,command)),cwd=cwd,env=env,stdout=out,stderr=err)
 record.update(exitCode=result.returncode,finishedUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(),stdout=stdout.name,stderr=stderr.name)
 meta.write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n')
 with (LOGS/'commands.jsonl').open('a') as out:out.write(json.dumps(record,ensure_ascii=False)+'\n')
 print(json.dumps(record),flush=True)
 if check and result.returncode:raise RuntimeError(f'{label} failed with exit {result.returncode}; original stdout/stderr retained')
 return result.returncode,stdout,stderr

if __name__=='__main__':
 import sys
 label,cwd,*command=sys.argv[1:]
 code,_,_=run(label,command,cwd,check=False)
 sys.exit(code)
