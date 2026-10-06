import ast,datetime,hashlib,importlib.metadata,json,pathlib,re,shutil,urllib.request
from runner import ROOT,run
raw=ROOT/'raw';discovery=json.loads((raw/'SUPPLIER-DISCOVERY.json').read_text());commit=discovery['commit'];gitdir=ROOT/'upstream.git';sha=lambda b:hashlib.sha256(b).hexdigest()
_,p,_=run('08-tag-remote-confirm',['git','ls-remote','https://github.com/openai/codex.git','refs/tags/'+discovery['tag'],'refs/tags/'+discovery['tag']+'^{}'],ROOT)
assert p.read_text().splitlines()==[discovery['annotatedTag']+'\trefs/tags/'+discovery['tag'],commit+'\trefs/tags/'+discovery['tag']+'^{}']
notice='NOTICE';_,p,_=run('09-notice-blob',['git','--git-dir',str(gitdir),'rev-parse',commit+':'+notice],ROOT);blob=p.read_text().strip();_,p,_=run('10-notice-content',['git','--git-dir',str(gitdir),'cat-file','blob',blob],ROOT);b=p.read_bytes();assert hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()==blob
(ROOT/'official-source'/notice).write_bytes(b);discovery['files'].append(dict(path=notice,gitBlob=blob,bytes=len(b),rawSha256=sha(b),crlfCount=b.count(b'\r\n')))
required=[discovery['pluginValidator'],discovery['identifierDependency'],discovery['quickValidator'],'LICENSE','NOTICE'];rows=[]
for i,path in enumerate(required):
 expected=next(r for r in discovery['files'] if r['path']==path);url='https://raw.githubusercontent.com/openai/codex/'+commit+'/'+path
 request=urllib.request.Request(url,headers={'Accept-Encoding':'identity','User-Agent':'AGS-CS-official-validator-pin-check'})
 with urllib.request.urlopen(request,timeout=30) as response:body=response.read();status=response.status
 p=raw/'http'/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(body);assert status==200 and sha(body)==expected['rawSha256'] and body==(ROOT/'official-source'/path).read_bytes();assert hashlib.sha1(b'blob '+str(len(body)).encode()+b'\0'+body).hexdigest()==expected['gitBlob']
 rows.append(dict(**expected,url=url,httpStatus=status,httpRawSha256=sha(body),httpGitBlobExact=True))
 pins=dict(origin=discovery['origin'],tag=discovery['tag'],annotatedTag=discovery['annotatedTag'],commit=commit,sourceLicense='Apache-2.0',files=rows,windowsCrLfShaProvided='1e6cb914505b458856c2cfab7d18a224731c743ef47e0c9d78afe64f35b67f7c',windowsBytesVerification='NOT_RUN: Windows raw bytes were not supplied here; the provided CRLF digest is not claimed as remote LF SHA')
 (raw/'SUPPLIER-PIN.json').write_text(json.dumps(pins,ensure_ascii=False,indent=2)+'\n')
assert 'Apache License' in (ROOT/'official-source/LICENSE').read_text()
candidate=ROOT/'candidate';run('11-candidate-clone',['git','clone','--no-checkout','--no-hardlinks','/workspace/ags-cs-2x/repo',str(candidate)],ROOT);run('12-candidate-lf',['git','config','core.autocrlf','false'],candidate);run('13-candidate-checkout',['git','checkout','--detach','4ba47558020bd5e501fa9718f09d562dcf573713'],candidate)
_,p,_=run('14-candidate-pin',['git','rev-parse','HEAD','HEAD^{tree}'],candidate);assert p.read_text().splitlines()==['4ba47558020bd5e501fa9718f09d562dcf573713','5fcc66de8aa37e6a347511c2def0eae54a0ed1e5']
_,p,_=run('15-candidate-clean',['git','status','--porcelain'],candidate);assert not p.read_bytes()
import yaml
modules={}
for path in required[:3]:
 tree=ast.parse((ROOT/'official-source'/path).read_text());imports=sorted({n.module for n in ast.walk(tree) if isinstance(n,ast.ImportFrom)}|{a.name for n in ast.walk(tree) if isinstance(n,ast.Import) for a in n.names});modules[path]=imports
assert modules[discovery['quickValidator']]==['pathlib','re','sys','yaml']
manifest=json.loads((candidate/'.codex-plugin/plugin.json').read_text());plugin_ast=ast.parse((ROOT/'official-source'/discovery['pluginValidator']).read_text());fn=next(n for n in plugin_ast.body if isinstance(n,ast.FunctionDef) and n.name=='validate_manifest_shape');allowed=next(ast.literal_eval(n.value) for n in fn.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='allowed_keys' for t in n.targets));conflicts=[]
for k in set(manifest)-allowed:conflicts.append(dict(path='.codex-plugin/plugin.json',field=k,reason='Unsupported top-level field in pinned validator'))
interface_allowed={'displayName','shortDescription','longDescription','developerName','category','capabilities','websiteURL','privacyPolicyURL','termsOfServiceURL','brandColor','composerIcon','logo','logoDark','screenshots','defaultPrompt','default_prompt'}
for k in set(manifest.get('interface',{}))-interface_allowed:conflicts.append(dict(path='.codex-plugin/plugin.json',field='interface.'+k,reason='Unsupported pinned interface field'))
quick_ast=ast.parse((ROOT/'official-source'/discovery['quickValidator']).read_text());quick_allowed=next(ast.literal_eval(n.value) for n in ast.walk(quick_ast) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='allowed_properties' for t in n.targets));skill_rows=[]
for d in sorted((candidate/'skills').iterdir()):
 if not d.is_dir():continue
 p=d/'SKILL.md';text=p.read_text();m=re.match(r'^---\n(.*?)\n---',text,re.S);assert m is not None,p;front=yaml.safe_load(m.group(1));keys=set(front)
 for k in keys-quick_allowed:conflicts.append(dict(path=str(p.relative_to(candidate)),field=k,reason='Unsupported pinned quick-validator frontmatter field'))
 agent=d/'agents/openai.yaml'
 if agent.is_file():
  value=yaml.safe_load(agent.read_text())
  for k in set(value)-{'interface','policy','dependencies'}:conflicts.append(dict(path=str(agent.relative_to(candidate)),field=k,reason='Unsupported pinned agent field'))
  for k in set(value.get('interface',{}))-{'display_name','short_description','icon_small','icon_large','brand_color','default_prompt'}:conflicts.append(dict(path=str(agent.relative_to(candidate)),field='interface.'+k,reason='Unsupported pinned agent interface field'))
 skill_rows.append(dict(name=d.name,frontmatterKeys=sorted(keys)))
compat=dict(state='STATIC_KEY_COMPATIBLE' if not conflicts else 'CONTRADICTION_STOP',scope='Source-derived supported manifest/frontmatter/agent key sets only; not an official validation result',conflicts=conflicts,pluginVersion=manifest['version'],skillCount=len(skill_rows),skills=skill_rows,dependencies=modules,pythonYaml=dict(version=yaml.__version__,distributionVersion=importlib.metadata.version('PyYAML'),modulePath=yaml.__file__))
(raw/'COMPATIBILITY.json').write_text(json.dumps(compat,ensure_ascii=False,indent=2)+'\n');assert not conflicts,'Manifest contract contradiction; official execution withheld'
home=ROOT/'codex-home-disposable';assert not home.exists();home.mkdir();mapping={discovery['pluginValidator']:'skills/.system/plugin-creator/scripts/validate_plugin.py',discovery['identifierDependency']:'skills/.system/plugin-creator/scripts/identifier_validation.py',discovery['quickValidator']:'skills/.system/skill-creator/scripts/quick_validate.py','LICENSE':'.supplier/LICENSE','NOTICE':'.supplier/NOTICE'}
supplied=[]
for path,dest in mapping.items():
 b=(ROOT/'official-source'/path).read_bytes();p=home/dest;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b);assert sha(p.read_bytes())==next(r['rawSha256'] for r in rows if r['path']==path);supplied.append(dict(sourcePath=path,temporaryPath=dest,bytes=len(b),sha256=sha(b)))
(raw/'SUPPLIED.json').write_text(json.dumps(dict(codeHome=str(home),createdNew=True,defaultCodeHomeTouched=False,files=supplied,officialExecutionCount=0,registryKeysProfilesInstalled=False),ensure_ascii=False,indent=2)+'\n');print(json.dumps(dict(supplierPin=commit,staticCompatibility=compat['state'],skillCount=len(skill_rows),providedFiles=len(supplied),officialExecutionCount=0)))
