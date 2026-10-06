"""Correct only generated public prose; retain failed scan and source captures."""
import collections, datetime, hashlib, importlib.util, json, pathlib, re, zipfile
from runner import ROOT, run
sha=lambda b:hashlib.sha256(b).hexdigest()
encode=lambda v:(json.dumps(v,ensure_ascii=False,indent=2)+'\n').encode()
audit=ROOT/'audit';public=ROOT/'public/cs280-release-prep/codex-final-2'
assert json.loads((public/'RESIDUAL-SCAN.json').read_text())['state']=='FAIL'
assert not (public/'MANIFEST.json').exists()
failed=ROOT/'failed-preparation-control';failed.mkdir()
for name in ('README.ko.md','RESIDUAL-SCAN.json'):
    (failed/name).write_bytes((public/name).read_bytes());(failed/name).chmod(0o400)
_,out,_=run('20-finalizer-tools-pin',['git','rev-parse','HEAD','HEAD^{tree}'],ROOT/'tools');pins=out.read_text().splitlines()
_,out,_=run('21-finalizer-tools-clean',['git','status','--porcelain'],ROOT/'tools');assert not out.read_bytes()
cutoff=datetime.datetime.now(datetime.timezone.utc).isoformat()
prior=ROOT.parent/'publication-20261006T040502Z'
spec=importlib.util.spec_from_file_location('redactor',prior/'redact.py');redactor=importlib.util.module_from_spec(spec);spec.loader.exec_module(redactor)
redactor.ids=set(json.loads((audit/'known-private-resource-ids.json').read_text()))
old=json.loads((public/'REDACTION.json').read_text());ledger=old['files']
original_inventory=(audit/'RAW-INVENTORY.json').read_bytes();original_inv=json.loads(original_inventory)
extra=ROOT/'frozen-correction';extra.mkdir()
sources=[(failed/name,'postprocessing-correction/generated-before/'+name) for name in ('README.ko.md','RESIDUAL-SCAN.json')]
for label in ('10-public-preparation-driver','13-public-residual-scan','16-finalizer-syntax','20-finalizer-tools-pin','21-finalizer-tools-clean'):
    for suffix in ('.stdout.log','.stderr.log','.command.json'):
        p=ROOT/'raw/logs'/(label+suffix);sources.append((p,'postprocessing-correction/logs/'+p.name))
sources += [(ROOT/'raw/logs/commands.jsonl','postprocessing-correction/logs/commands-through-cutoff.jsonl'),
            (ROOT/'tools/finalize_public.py','postprocessing-correction/tools/finalize_public.py')]
for source,name in sources:
    data=source.read_bytes();p=extra/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data);p.chmod(0o400)
    output,counts=redactor.redacted_bytes(data,source.suffix)
    text,n=re.subn(r'\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b','[REDACTED:EMAIL_STYLE_VALUE]',output.decode());output=text.encode()
    if n:counts['EMAIL_STYLE_VALUE']=n
    p=public/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(output)
    ledger.append(dict(path=name,sourcePath=str(source),originalBytes=len(data),originalSha256=sha(data),publicBytes=len(output),publicSha256=sha(output),
        removalsByKind=counts,removalCount=sum(counts.values()),nulDelimitersEscaped=0,transformation=None))
(public/'README.ko.md').write_text(
    '공식 metadata 검사는 PASS다. 최종 source b7341d3/tree5648f765에서 child pnpm_config_store_dir와 config get/store path를 대조한 뒤 pnpm run validate:official 1회 exit0, plugin과22 skill 모두 PASS. dependency gate override 및 unknown-option 강제, 사용자 홈·전역 설정 repair0. source1344/lock/workspace-module state/supplier5 bytes 전후 동일하다.\n\n'
    'stdout의 Already up to date/Done 문구는 보존한다. 내부 세부 경로는 process trace로 확정하지 않았고 원 heuristic false는 내부 호출0의 근거가 아니다. 전체 node_modules payload는 사전 hash하지 않았다. 새 명시적 install 명령0이며 공식 metadata PASS는 full regression/runtime/품질/독립감사/호스트 설치/출시 승인과 구분한다.\n\n'
    '과거 official1/final1의 실제 pnpm 실패·NOT_RUN과 준비 실패/보정을 유지한다. final1 게시 후처리/scope/preflight/push 실제 캡처와 raw/public SHA를 별도 prior-final1 subtree에 보존하고 기존 final1은 변경하지 않았다. private Drive 첫 ZIP 이송과 Library provider 서비스값은 별도 비공개 receipt이며 이 패킷에는 raw ZIP/key/DB/store payload/internal reasoning/다른 세션 원문을 넣지 않았다.\n\n'
    '첫 공개 스캔은 생성 README의 일반 HOME 표기를 private-home 패턴으로 인식해 exit1이었다. 당시 README와 실제 실패 로그를 동결 보존하고 공개 표현만 바꿨다. 검사 기준 완화·제품 재검사0. 초기수집과 이번보정 cutoff, raw/public hash 대응 및 문서전후 차이를 기록한다. 이후 자기 배달·게시로그는 범위 밖이며 무한 재게시하지 않는다.\n')
counts=collections.Counter()
for row in ledger:counts.update(row['removalsByKind'])
inventory=dict(original_inv,sourceCount=len(ledger),files=ledger,correctionCutoffUtc=cutoff,
    originalInventorySha256=sha(original_inventory),correction='Generated prose only. Actual failed13/10 streams and before-control bytes preserved. Current17 active driver/later18/19/Library/publication delivery excluded.')
(audit/'CORRECTED-RAW-INVENTORY.json').write_bytes(encode(inventory));(audit/'CORRECTED-RAW-INVENTORY.json').chmod(0o400)
(public/'INVENTORY.json').write_bytes(encode(inventory))
(public/'REDACTION.json').write_bytes(encode(dict(files=ledger,sourceCount=len(ledger),publicCopies=len(ledger),removalCount=sum(counts.values()),removalsByKind=dict(counts),nulDelimitersEscaped=sum(row['nulDelimitersEscaped'] for row in ledger))))
(public/'TOOLS-PIN.json').write_bytes(encode(dict(commit=pins[0],tree=pins[1],clean=True,checkedIn=True,originalCollectorToolsCommit=json.loads((public/'TOOLS-PIN.json').read_text())['commit'])))
collection=json.loads((public/'COLLECTION.json').read_text());collection.update(correctionCutoffUtc=cutoff,
    failedScan='13 exit1 on generated generic HOME wording; before prose/FAIL/command kept. Expression corrected, scanner checks unchanged.',
    afterCorrectionCutoff='18,19,current17 completion and scope/preflight/push/Library delivery are outside this packet. Actual captures retained separately.')
(public/'COLLECTION.json').write_bytes(encode(collection))
run('18-corrected-public-scan',['python',str(prior/'scan-public.py'),str(ROOT),str(public)],ROOT)
assert json.loads((public/'RESIDUAL-SCAN.json').read_text())['state']=='PASS'
for row in ledger:
    snap=(ROOT/'frozen-raw'/row['path']) if (ROOT/'frozen-raw'/row['path']).is_file() else extra/row['path']
    assert sha(snap.read_bytes())==row['originalSha256']
    assert sha((public/row['path']).read_bytes())==row['publicSha256']
files=[dict(path=p.relative_to(public).as_posix(),bytes=p.stat().st_size,sha256=sha(p.read_bytes())) for p in sorted(public.rglob('*')) if p.is_file()]
(public/'MANIFEST.json').write_bytes(encode(dict(prefix='cs280-release-prep/codex-final-2',cutoffUtc=original_inv['cutoffUtc'],correctionCutoffUtc=cutoff,files=files,
    hashCycleRule='MANIFEST excludes itself and SUMS. SUMS includes MANIFEST and excludes itself. External ZIP binds final bytes. Future append folders are separate collections at their own commit pins.')))
mh=sha((public/'MANIFEST.json').read_bytes());(public/'SHA256SUMS').write_text('\n'.join(row['sha256']+'  '+row['path'] for row in files)+'\n'+mh+'  MANIFEST.json\n')
run('19-corrected-public-sums',['sha256sum','--check','--quiet','SHA256SUMS'],public)
packet=ROOT/'AGS-CS280-Codex-final-2-review.zip';assert not packet.exists()
with zipfile.ZipFile(packet,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    for p in sorted(public.rglob('*')):
        if p.is_file():z.write(p,'cs280-release-prep/codex-final-2/'+p.relative_to(public).as_posix())
with zipfile.ZipFile(packet) as z:
    assert len(z.namelist())==len(files)+2
    for name in z.namelist():assert z.read(name)==(ROOT/'public'/name).read_bytes()
private=ROOT/'private-original-evidence.zip';assert not private.exists()
with zipfile.ZipFile(private,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    for folder in ('frozen-raw','frozen-correction','failed-preparation-control'):
        for p in sorted((ROOT/folder).rglob('*')):
            if p.is_file():z.write(p,p.relative_to(ROOT).as_posix())
private.chmod(0o400)
result=dict(status='PREPARED_OFFICIAL_METADATA_PASS',cutoffUtc=original_inv['cutoffUtc'],correctionCutoffUtc=cutoff,publicPath=str(public),publicFiles=len(files)+2,
    rawSourceFiles=len(ledger),rawInventorySha256=sha((audit/'CORRECTED-RAW-INVENTORY.json').read_bytes()),manifestSha256=mh,sumsSha256=sha((public/'SHA256SUMS').read_bytes()),
    redactionMatches=sum(counts.values()),nulDelimitersEscaped=sum(row['nulDelimitersEscaped'] for row in ledger),residualFindings=0,toolsCommit=pins[0],
    reviewZip=dict(path=str(packet),bytes=packet.stat().st_size,sha256=sha(packet.read_bytes())),
    privateOriginalZip=dict(path=str(private),bytes=private.stat().st_size,sha256=sha(private.read_bytes()),uploaded=False),
    afterCutoff='18,19,17 completion and scope/preflight/push/Library delivery excluded; source/runtime test repetition0')
(audit/'DELIVERY.json').write_bytes(encode(result));print(json.dumps(result,ensure_ascii=False,indent=2))
