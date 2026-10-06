import hashlib,json,pathlib
from runner import ROOT,run
COMMIT='10382da79a2a2d6e8ae221fa63077215389c1ad2';TAG='rust-v0.158.0-alpha.2';TAG_OBJECT='3ccf947fb92b3bc936aada20f9b92ed5ebbba22d';gitdir=ROOT/'upstream.git';raw=ROOT/'raw';raw.mkdir(exist_ok=True)
run('01-upstream-init',['git','init','--bare','--quiet',str(gitdir)],ROOT)
run('02-upstream-origin',['git','--git-dir',str(gitdir),'remote','add','origin','https://github.com/openai/codex.git'],ROOT)
run('03-upstream-fetch',['git','--git-dir',str(gitdir),'fetch','--depth=1','--filter=blob:none','--no-tags','origin','refs/tags/'+TAG],ROOT)
_,p,_=run('04-upstream-tag',['git','--git-dir',str(gitdir),'rev-parse','FETCH_HEAD','FETCH_HEAD^{}'],ROOT);assert p.read_text().splitlines()==[TAG_OBJECT,COMMIT]
_,p,_=run('05-upstream-paths',['git','--git-dir',str(gitdir),'ls-tree','-r','--name-only',COMMIT],ROOT);paths=p.read_text().splitlines()
plugin='codex-rs/skills/src/assets/samples/plugin-creator/scripts/validate_plugin.py';identifier=str(pathlib.PurePosixPath(plugin).parent/'identifier_validation.py');assert plugin in paths and identifier in paths
quick=[s for s in paths if s.endswith('/skill-creator/scripts/quick_validate.py') and s.startswith('codex-rs/skills/src/assets/')];assert len(quick)==1,quick
selected=sorted({s for s in paths if any(s.startswith(str(pathlib.PurePosixPath(v).parent)+'/') and s.endswith('.py') for v in [plugin,quick[0]])}|{s for s in paths if s=='LICENSE' or s.endswith('/LICENSE') and 'codex-rs/skills/src/assets' in s})
source=ROOT/'official-source';source.mkdir();rows=[]
for i,path in enumerate(selected):
 _,p,_=run(f'06-blob-{i:02}', ['git','--git-dir',str(gitdir),'rev-parse',COMMIT+':'+path],ROOT);blob=p.read_text().strip()
 if path==plugin:assert blob=='b5be462c3b4fe3ea6083cca948ccf52e05301546'
 if path==identifier:assert blob=='41a1a2f1b503c165f5d4b93f7f0e99eb0b3add6e'
 _,p,_=run(f'07-content-{i:02}',['git','--git-dir',str(gitdir),'cat-file','blob',blob],ROOT);content=p.read_bytes();assert hashlib.sha1(b'blob '+str(len(content)).encode()+b'\0'+content).hexdigest()==blob
 out=source/path;out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(content);rows.append(dict(path=path,gitBlob=blob,bytes=len(content),rawSha256=hashlib.sha256(content).hexdigest(),crlfCount=content.count(b'\r\n')))
report=dict(origin='https://github.com/openai/codex',tag=TAG,annotatedTag=TAG_OBJECT,commit=COMMIT,pluginValidator=plugin,identifierDependency=identifier,quickValidator=quick[0],files=rows,officialExecutionCount=0)
(raw/'SUPPLIER-DISCOVERY.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False,indent=2))
