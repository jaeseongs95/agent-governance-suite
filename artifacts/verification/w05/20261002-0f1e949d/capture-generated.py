import hashlib,io,json,os,pathlib,subprocess,tarfile,tempfile,datetime
root=pathlib.Path('<candidate>')
out=pathlib.Path(__file__).parent
def git(*args,env=None):
    return subprocess.check_output(['git',*args],cwd=root,env=env)
def sha(data): return hashlib.sha256(data).hexdigest()
baseline=json.loads((out/'untouched-candidate-files.json').read_text())
before={f['path']:f for f in baseline['files']}
tracked=git('diff','--name-only','HEAD','-z').decode().split('\0')[:-1]
new=git('ls-files','--others','--exclude-standard','-z').decode().split('\0')[:-1]
paths=sorted(tracked+new)
assert len(paths)==22,paths
assert all(p=='host-integration.json' or p.startswith('mcp-server/dist/') or p.startswith('claude-plugin/mcp-server/dist/') or p in ['claude-plugin/contracts/types.ts','claude-plugin/contracts/session-auto-wake-outlook.v1.schema.json'] for p in paths)
source=json.loads((out/'source25-comparison.json').read_text())
guard=[]
for f in source['files']:
    data=(root/f['path']).read_bytes()
    mode=git('ls-tree','HEAD','--',f['path']).decode().split()[0]
    assert len(data)==f['expectedBytes'] and sha(data)==f['expectedSha256']
    assert mode==f['observedMode']
    guard.append({'path':f['path'],'bytes':len(data),'sha256':sha(data),'gitMode':mode,'unchanged':True})
fd,index=tempfile.mkstemp(prefix='ags-w05-shipment-index-',dir='/tmp');os.close(fd);os.unlink(index)
env=os.environ.copy();env['GIT_INDEX_FILE']=index
try:
    git('read-tree','HEAD',env=env)
    git('add','--',*paths,env=env)
    tree=git('write-tree',env=env).decode().strip()
    patch=git('diff','--cached','--binary','HEAD',env=env)
    (out/'generated-actual22.patch').write_bytes(patch)
    entries=[]
    with tarfile.open(out/'generated-actual22.tar','w',format=tarfile.PAX_FORMAT) as tar:
        for p in paths:
            data=(root/p).read_bytes()
            mode,kind,blob,_=git('ls-tree',tree,'--',p).decode().split(maxsplit=3)
            assert git('cat-file','blob',blob)==data
            entries.append({'path':p,'gitMode':mode,'blob':blob,'before':before.get(p),'after':{'bytes':len(data),'sha256':sha(data)}})
            info=tarfile.TarInfo(p);info.size=len(data);info.mode=int(mode[-3:],8);info.mtime=0;info.uid=0;info.gid=0;info.uname='';info.gname=''
            tar.addfile(info,io.BytesIO(data))
    complete=[]
    for line in git('ls-tree','-r','-z',tree).decode().split('\0')[:-1]:
        header,p=line.split('\t',1);mode,kind,blob=header.split()
        data=git('cat-file','blob',blob)
        assert (root/p).read_bytes()==data,p
        complete.append({'path':p,'gitMode':mode,'blob':blob,'bytes':len(data),'sha256':sha(data)})
    (out/'shipment-tree-files.json').write_text(json.dumps({'tree':tree,'files':complete},indent=2)+'\n')
    report={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'candidateCommit':git('rev-parse','HEAD').decode().strip(),'candidateTree':baseline['candidateTree'],'shipmentTree':tree,'expectedGeneratedCountReported':15,'actualGeneratedChangedCount':len(entries),'discrepancy':'22 observed; expected exact15 path/byte/hash manifest unavailable','source25Unchanged':guard,'generatedFiles':entries,'patch':{'path':'generated-actual22.patch','bytes':len(patch),'sha256':sha(patch)},'archive':{'path':'generated-actual22.tar','bytes':(out/'generated-actual22.tar').stat().st_size,'sha256':sha((out/'generated-actual22.tar').read_bytes())},'commitCreated':False,'refsChanged':False}
    (out/'generated-closure.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k not in ['generatedFiles','source25Unchanged']}))
finally:
    pathlib.Path(index).unlink(missing_ok=True)
