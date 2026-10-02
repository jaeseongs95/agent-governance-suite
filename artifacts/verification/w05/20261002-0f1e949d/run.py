import subprocess,sys,time,json,datetime,pathlib
root=pathlib.Path(__file__).parent
label=sys.argv[1];cmd=sys.argv[2:];started=datetime.datetime.now(datetime.timezone.utc).isoformat();t=time.monotonic()
r=subprocess.run(cmd,cwd='<candidate>',capture_output=True,text=True)
(root/(label+'.stdout')).write_text(r.stdout);(root/(label+'.stderr')).write_text(r.stderr)
receipt={'command':cmd,'cwd':'<candidate>','startedAt':started,'durationSeconds':round(time.monotonic()-t,3),'exitCode':r.returncode}
(root/(label+'.json')).write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt));print(r.stdout[-12000:]);print(r.stderr[-6000:]);sys.exit(r.returncode)
