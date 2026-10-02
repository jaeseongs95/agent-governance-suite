import datetime,hashlib,json,os,pathlib,subprocess,tempfile,tarfile
out=pathlib.Path(__file__).parent;root=pathlib.Path('<candidate>')
r=json.loads((out/'generated-closure.json').read_text())
def git(*a,env):return subprocess.check_output(['git',*a],cwd=root,env=env)
fd,index=tempfile.mkstemp(prefix='ags-w05-recovery-index-',dir='/tmp');os.close(fd);os.unlink(index)
env=os.environ.copy();env['GIT_INDEX_FILE']=index
try:
    git('read-tree',r['candidateCommit'],env=env)
    git('apply','--cached','--binary',str(out/r['patch']['path']),env=env)
    tree=git('write-tree',env=env).decode().strip();assert tree==r['shipmentTree']
finally:pathlib.Path(index).unlink(missing_ok=True)
with tarfile.open(out/r['archive']['path']) as tar:
    files=tar.getmembers();assert [f.name for f in files]==[f['path'] for f in r['generatedFiles']]
    for f,e in zip(files,r['generatedFiles']):
        data=tar.extractfile(f).read();assert len(data)==e['after']['bytes'];assert hashlib.sha256(data).hexdigest()==e['after']['sha256'];assert f.mode==int(e['gitMode'][-3:],8)
for f in json.loads((out/'shipment-tree-files.json').read_text())['files']:
    data=(root/f['path']).read_bytes();assert len(data)==f['bytes'] and hashlib.sha256(data).hexdigest()==f['sha256'],f['path']
print(json.dumps({'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'patchAppliesToExactCandidate':True,'patchReconstructedTree':tree,'archiveFilesBytesHashesModesMatch':True,'actualGeneratedCount':len(r['generatedFiles']),'source25Unchanged':True,'entireShipmentWorkingBytesUnchanged':True,'refsChanged':False}))
