import collections,datetime,hashlib,importlib.util,json,pathlib,shutil,zipfile
from runner import ROOT,run
raw=ROOT/'raw';sha=lambda b:hashlib.sha256(b).hexdigest();encode=lambda v:(json.dumps(v,ensure_ascii=False,indent=2)+'\n').encode();prior=pathlib.Path('/workspace/ags-cs-2x/publication-20261006T040502Z')
_,p,_=run('25-tools-pin',['git','rev-parse','HEAD','HEAD^{tree}'],ROOT/'tools');pins=p.read_text().splitlines();_,p,_=run('26-tools-clean',['git','status','--porcelain'],ROOT/'tools');assert not p.read_bytes()
(raw/'TOOLS-PIN.json').write_bytes(encode(dict(commit=pins[0],tree=pins[1],branch='codex/cs280-official-validator-evidence',checkedInDedicatedScripts=True,inlineProcessCodeUsed=False,dirty='',productSourceChanged=False)))
cutoff=datetime.datetime.now(datetime.timezone.utc).isoformat();frozen=ROOT/'frozen-raw';frozen.mkdir();public=ROOT/'public/cs280-release-prep/codex-official-1';public.mkdir(parents=True);audit=ROOT/'audit';audit.mkdir()
spec=importlib.util.spec_from_file_location('redactor',prior/'redact.py');redactor=importlib.util.module_from_spec(spec);spec.loader.exec_module(redactor);known=json.loads((prior/'audit/known-private-resource-ids.json').read_text());redactor.ids=set(known);(audit/'known-private-resource-ids.json').write_bytes(encode(known))
inventory=[];ledger=[]
sources=[(p,'raw/'+p.relative_to(raw).as_posix()) for p in sorted(raw.rglob('*')) if p.is_file()]
supplied=json.loads((raw/'SUPPLIED.json').read_text())
sources += [(ROOT/'codex-home-disposable'/r['temporaryPath'],'supplied-official/'+r['temporaryPath']) for r in supplied['files']]
sources += [(p,'checked-in-tools/'+p.name) for p in sorted((ROOT/'tools').glob('*.py'))]+[(ROOT/'tools/.gitignore','checked-in-tools/.gitignore')]
for p,name in sources:
 b=p.read_bytes();snap=frozen/name;snap.parent.mkdir(parents=True,exist_ok=True);snap.write_bytes(b);snap.chmod(0o400);inventory.append(dict(sourcePath=str(p.relative_to(ROOT)),path=name,originalBytes=len(b),originalSha256=sha(b)))
 if name.startswith('supplied-official/'):
  # Public upstream validator/licence files remain byte exact, not redacted substitutes.
  out=b;counts={}
 else:out,counts=redactor.redacted_bytes(b,p.suffix)
 dest=public/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(out);ledger.append(dict(path=name,originalBytes=len(b),originalSha256=sha(b),publicBytes=len(out),publicSha256=sha(out),removalsByKind=counts,removalCount=sum(counts.values())))
inv=dict(schema='AGSOfficialPrepInventory.v1',cutoffUtc=cutoff,sourceCount=len(inventory),files=inventory,scope='This current-CS official preparation only; raw private snapshots are immutable. No DB/key/full native transcript/Git bundle/private ZIP payload included.')
(audit/'RAW-INVENTORY.json').write_bytes(encode(inv));(audit/'RAW-INVENTORY.json').chmod(0o400);digest=sha((audit/'RAW-INVENTORY.json').read_bytes());(audit/'FROZEN-INVENTORY-SHA.json').write_bytes(encode(dict(sha256=digest)))
counts=collections.Counter()
for r in ledger:counts.update(r['removalsByKind'])
(public/'INVENTORY.json').write_bytes(encode(dict(**inv,frozenPrivateInventorySha256=digest)))
(public/'REDACTION.json').write_bytes(encode(dict(files=ledger,rawFiles=len(ledger),publicCopies=len(ledger),removalsByKind=dict(counts),removalCount=sum(counts.values()),note='Supplied official files are public source bytes and remain exact. Other actual captures carry raw/public hash mapping. Normalization can change bytes without removal matches.')))
annotated=json.loads((raw/'ANNOTATED-RESULT.json').read_text());(public/'STATUS.json').write_bytes(encode(annotated))
(public/'COLLECTION.json').write_bytes(encode(dict(cutoffUtc=cutoff,originalSupplierPin='10382da79a2a2d6e8ae221fa63077215389c1ad2',candidate='4ba47558020bd5e501fa9718f09d562dcf573713',candidateTree='5fcc66de8aa37e6a347511c2def0eae54a0ed1e5',officialCommandAttempts=1,officialPluginAndSkills='NOT_RUN: pnpm pre-script dependency install failed',postprocessingAfterCutoff='Kept separately in this task raw/logs; not claimed inside frozen packet. Delivery/ZIP/Library metadata is outside itself.',nativePrelude='Full native transcript and initial read-only tool/outer acquire-supply wrapper stdout exports NOT_VERIFIABLE; actual nested supplier command captures, HTTP bytes/pins, official command and later wrappers are retained. No reconstructed internal reasoning.',environment='Current namespace identities recorded. Workspace/runtimes reused; container lifecycle and external jobs UNKNOWN. No remote-environment inference.',publication='PREPARED ONLY under cs280-release-prep/codex-official-1; remote push/main/tag/release/host install not performed. Unexpected dependency install attempt retained.',sourceCompatibility='Only supported-key precheck passed; official full metadata validation NOT_RUN.',sourceControls='1,344 candidate files exact pre/post; r1/r2 fixture changes not integrated. Existing evidence not rewritten.')))
(public/'README.ko.md').write_text('공식 validator 공급은 검증 완료, 공식 검사는 BLOCKED다. OpenAI codex rust-v0.158.0-alpha.2 / commit10382da를 원격 Git·raw HTTPS로 대조했고 세 Python 파일과 LICENSE·NOTICE를 임시 CODEX_HOME에 그대로 제공했다. 정상 후보4ba/tree5fcc에서 pnpm validate:official을 딱 한 번 실행했으나 pnpm 기본 verify-deps-before-run=install이 dependency install을 시도해 기본 사용자 store 초기화 ENOENT로 exit1을 반환했다. plugin validator와 22개 skill validator는 NOT_RUN이다. FAIL·예상 밖 install 시도·stdout/stderr·명령/exit를 보존했고 같은 입력 재실행0이다. 공식 Python 파일 대체·수정·검사 완화는 없다. 1,344개 소스 파일 및 tree, clean 상태는 전후 불변이다. 전체 test/build/runtime, r1/r2 통합, main/tag/release/host 설치/push는 하지 않았다. 증거는 신규 지정 폴더의 로컬 게시 준비본이며, 리드의 후속 검토 전 원격 게시하지 않는다. global store 생성 성공은 관측되지 않았고 user config/운영 DB/key/profile은 조회·수리하지 않았다.\n')
run('27-public-residual-scan',['python',str(prior/'scan-public.py'),str(ROOT),str(public)],ROOT)
assert json.loads((public/'RESIDUAL-SCAN.json').read_text())['state']=='PASS'
files=[dict(path=p.relative_to(public).as_posix(),bytes=p.stat().st_size,sha256=sha(p.read_bytes())) for p in sorted(public.rglob('*')) if p.is_file()]
(public/'MANIFEST.json').write_bytes(encode(dict(schema='AGSOfficialPrepPublicManifest.v1',prefix='cs280-release-prep/codex-official-1',cutoffUtc=cutoff,files=files,scope='Exact prepared payload except its own MANIFEST.json and SHA256SUMS. SUMS includes MANIFEST but excludes itself; external ZIP receipt hashes both.')))
mh=sha((public/'MANIFEST.json').read_bytes());(public/'SHA256SUMS').write_text('\n'.join(r['sha256']+'  '+r['path'] for r in files)+'\n'+mh+'  MANIFEST.json\n')
run('28-payload-sums',['sha256sum','--check','--quiet','SHA256SUMS'],public)
packet=ROOT/'AGS-CS280-Codex-official-1-review.zip'
with zipfile.ZipFile(packet,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for p in sorted(public.rglob('*')):
  if p.is_file():z.write(p,'cs280-release-prep/codex-official-1/'+p.relative_to(public).as_posix())
with zipfile.ZipFile(packet) as z:
 assert len(z.namelist())==len(files)+2
 for n in z.namelist():assert z.read(n)==(ROOT/'public'/n).read_bytes()
private_zip=ROOT/'private-original-evidence.zip'
with zipfile.ZipFile(private_zip,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for p in sorted(frozen.rglob('*')):
  if p.is_file():z.write(p,p.relative_to(frozen).as_posix())
private_zip.chmod(0o400)
result=dict(status='PREPARED_BLOCKED_NO_PUSH',publicPath=str(public),publicFiles=len(files)+2,rawSourceFiles=len(inventory),cutoffUtc=cutoff,rawInventorySha256=digest,manifestSha256=mh,sha256SumsSha256=sha((public/'SHA256SUMS').read_bytes()),reviewZip=dict(path=str(packet),bytes=packet.stat().st_size,sha256=sha(packet.read_bytes())),privateOriginalZip=dict(path=str(private_zip),bytes=private_zip.stat().st_size,sha256=sha(private_zip.read_bytes()),uploaded=False),redactionMatches=sum(counts.values()),residualFindings=0,supplierPin='10382da79a2a2d6e8ae221fa63077215389c1ad2',candidatePin='4ba47558020bd5e501fa9718f09d562dcf573713',toolsCommit=pins[0],postCutoffLogRange='27-public-residual-scan onward; outside sealed payload')
(audit/'DELIVERY.json').write_bytes(encode(result));print(json.dumps(result,ensure_ascii=False,indent=2))
