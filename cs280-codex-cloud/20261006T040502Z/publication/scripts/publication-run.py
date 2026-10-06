import datetime, json, pathlib, subprocess, sys
root = pathlib.Path(sys.argv[1]); label=sys.argv[2]; cwd=pathlib.Path(sys.argv[3]); command=sys.argv[4:]
record=dict(label=label,command=command,cwd=str(cwd),started=datetime.datetime.now(datetime.timezone.utc).isoformat(),kind='publication-only; no product test')
log=root/'audit'/f'{label}.log'
with log.open('w') as out:
    out.write(json.dumps(record)+'\n');out.flush()
    result=subprocess.run(command,cwd=cwd,stdout=out,stderr=subprocess.STDOUT)
record.update(exitCode=result.returncode,finished=datetime.datetime.now(datetime.timezone.utc).isoformat(),log=log.name)
with (root/'audit/publication-commands.jsonl').open('a') as out:out.write(json.dumps(record)+'\n')
print(json.dumps(record));sys.exit(result.returncode)
