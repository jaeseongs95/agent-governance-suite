"""Freeze one bounded publication tail before its own delivery starts."""
import collections, datetime, hashlib, importlib.util, json, pathlib, re, shutil, zipfile
from runner import ROOT, run
sha=lambda b:hashlib.sha256(b).hexdigest()
enc=lambda v:(json.dumps(v,ensure_ascii=False,indent=2)+'\n').encode()
f2=ROOT.parent/'official-final2-d0ce2935'
first=ROOT.parent/'official1-publication-8c6eacff'
old=ROOT.parent/'official-validator-26c6c9d9'
assert json.loads((f2/'audit/PUSH-RECEIPT.json').read_text())['verifiedRemoteBlobCount']==238
assert json.loads((first/'audit/PUSH-RECEIPT.json').read_text())['verifiedRemoteBlobCount']==253
_,pin,_=run('T01-tools-pin',['git','rev-parse','HEAD','HEAD^{tree}'],ROOT/'tools')
_,clean,_=run('T02-tools-clean',['git','status','--porcelain'],ROOT/'tools')
assert not clean.read_bytes()
cutoff=datetime.datetime.now(datetime.timezone.utc).isoformat()
public=ROOT/'public/cs280-release-prep/codex-final-2/worklog-terminal-1'
frozen=ROOT/'frozen-raw'
assert not public.exists() and not frozen.exists()
public.mkdir(parents=True);frozen.mkdir()
audit=ROOT/'audit'
prior=ROOT.parent/'publication-20261006T040502Z'
spec=importlib.util.spec_from_file_location('redactor',prior/'redact.py')
redactor=importlib.util.module_from_spec(spec);spec.loader.exec_module(redactor)
known=(f2/'audit/known-private-resource-ids.json').read_bytes()
(audit/'known-private-resource-ids.json').write_bytes(known)
redactor.ids=set(json.loads(known))
sources=[]
def add(source,target):
    assert source.is_file()
    sources.append((source,target))
def completed_after(base,bound,name):
    count=0
    for meta in sorted((base/'raw/logs').glob('*.command.json')):
        row=json.loads(meta.read_text())
        if row['finishedUtc']<=bound:continue
        for suffix in ('.command.json','.stdout.log','.stderr.log'):
            add(meta.with_name(row['label']+suffix),name+'/logs/'+row['label']+suffix)
        count+=1
    add(base/'raw/logs/commands.jsonl',name+'/logs/commands-through-cutoff.jsonl')
    return count
counts={}
counts['final2']=completed_after(f2,json.loads((f2/'audit/DELIVERY.json').read_text())['correctionCutoffUtc'],'final2-publication')
counts['firstPublication']=completed_after(first,'','first-official-publication')
counts['firstOriginalTail']=completed_after(old,'2026-10-06T05:35:59.215793+00:00','first-official-original-tail')
for base,name in ((f2,'final2-publication'),(first,'first-official-publication')):
    for p in sorted((base/'audit').glob('*.json')):
        if p.name in ('known-private-resource-ids.json','RAW-INVENTORY.json','CORRECTED-RAW-INVENTORY.json') or p.name.endswith('.private.json'):continue
        add(p,name+'/audit/'+p.name)
    for p in sorted((base/'tools').glob('*.py')):add(p,name+'/tools/'+p.name)
add(old/'audit/NATIVE-FINAL-RECEIPT.json','first-official-original-tail/NATIVE-FINAL-RECEIPT.json')
for label in ('T00-syntax','T01-tools-pin','T02-tools-clean'):
    for suffix in ('.command.json','.stdout.log','.stderr.log'):
        add(ROOT/'raw/logs'/(label+suffix),'collection-control/logs/'+label+suffix)
for p in sorted((ROOT/'tools').glob('*.py')):add(p,'collection-control/tools/'+p.name)
assert len({target for _,target in sources})==len(sources)
ledger=[]
for source,target in sources:
    raw=source.read_bytes()
    dest=frozen/target;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(raw);dest.chmod(0o400)
    output,removals=redactor.redacted_bytes(raw,source.suffix)
    nul=output.count(b'\0')
    if nul:output=output.replace(b'\0',b'\\0')
    text,n=re.subn(r'\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b','[REDACTED:EMAIL_STYLE_VALUE]',output.decode())
    if n:removals['EMAIL_STYLE_VALUE']=n
    output=text.encode()
    dest=public/target;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(output)
    ledger.append(dict(path=target,sourcePath=str(source),originalBytes=len(raw),originalSha256=sha(raw),publicBytes=len(output),publicSha256=sha(output),
        removalsByKind=removals,removalCount=sum(removals.values()),nulDelimitersEscaped=nul,transformation='NUL_DELIMITER_ESCAPED' if nul else None))
totals=collections.Counter()
for row in ledger:totals.update(row['removalsByKind'])
inventory=dict(cutoffUtc=cutoff,sourceFiles=len(ledger),publicCopies=len(ledger),completedCommandsBySource=counts,files=ledger)
(audit/'RAW-INVENTORY.json').write_bytes(enc(inventory));(audit/'RAW-INVENTORY.json').chmod(0o400)
(public/'INVENTORY.json').write_bytes(enc(inventory))
(public/'REDACTION.json').write_bytes(enc(dict(files=ledger,sourceCount=len(ledger),publicCopies=len(ledger),removalCount=sum(totals.values()),removalsByKind=dict(totals),nulDelimitersEscaped=sum(r['nulDelimitersEscaped'] for r in ledger))))
(public/'COLLECTION.json').write_bytes(enc(dict(cutoffUtc=cutoff,
    scope='Existing completed final2 post-core-cutoff and approved first official1 publication command/stdout/stderr/audit/tool captures; original official1 post-terminal-cutoff tail. This collector and later delivery/push are outside cutoff.',
    counts=counts,sourceFiles=len(ledger),coreFinal2Commit=json.loads((f2/'audit/PUSH-RECEIPT.json').read_text())['commit'],
    firstOfficialCommit=json.loads((first/'audit/PUSH-RECEIPT.json').read_text())['commit'],
    excludes=['Private ZIP/DB/WAL/key/trustfile/store payload','Drive/Library raw service values and signed URLs','Internal reasoning/full native transcript','Other session transcripts'],
    claim='Captured raw files only; not all native tool outputs. No product validator/test/runtime rerun. Prior failures and NOT_RUN retained.')))
(public/'NOT-VERIFIABLE.json').write_bytes(enc(dict(
    nativeCompleteTranscript='NOT_VERIFIABLE: no supported complete native transcript/tool-event export provided.',
    uncapturedToolOutputs='NOT_VERIFIABLE: direct shell file-read/file-write and local tools-Git init/add/commit outputs not persisted as raw files. No reconstruction claimed. Standard runner captures listed in inventory are actual files.',
    first29EmptyAtInitialCutoff='NOT_VERIFIABLE: original empty-at-cutoff bytes not supplied; preserve later partial/complete captures separately.',
    original33Overwrite='NOT_VERIFIABLE: older publication same-label stdout overwrite limit unchanged.',
    privateOriginalDelivery='Not supplied as public bytes; private immutable originals remain local. Public source digests are not proof of independently delivered all private bytes.',
    laterDelivery='T03 collector completion/T04 scan/T05 sums and later tail scope/preflight/commit/push/Library actions fall after cutoff. Bounded native receipt only; no infinite republication.')))
(public/'TOOLS-PIN.json').write_bytes(enc(dict(commit=pin.read_text().splitlines()[0],tree=pin.read_text().splitlines()[1],clean=True,checkedInBeforeRun=True)))
(public/'README.ko.md').write_text(
    '두 게시의 실제 command/cwd/exit/stdout/stderr와 scope·preflight·receipt·commit·remote hash를 동결한 bounded tail이다. final2 core 및 first official1의 기존250파일은 수정하지 않았다. raw/public 파일별 SHA, 제거 종류/횟수와 inventory를 기록한다.\n\n'
    '공식 metadata만 final2 plugin·22 skill PASS이다. 원 official1/final1 pnpm wrapper 두실패·NOT_RUN은 유지하고 full Cloud tests/build/runtime/품질/독립감사/전체 signed1.1 acceptance는 이 작업에서 검증·구현하지 않았다. 첫 패킷 formatting-only/실패 집계/초기empty 한계는 승인된 first intake 문서에 따로 기록했다.\n\n'
    '이 cutoff 뒤 자기 게시·Library 배달은 native receipt로 구분하며 이 문서의 원본문서범위에 포함했다고 주장하지 않는다. 실제 파일 캡처가 없는 native 전체는 NOT_VERIFIABLE이다. 비공개 원본·ZIP/DB/key payload는 공개하지 않는다.\n')
run('T04-public-residual-scan',['python',str(prior/'scan-public.py'),str(ROOT),str(public)],ROOT)
assert json.loads((public/'RESIDUAL-SCAN.json').read_text())['state']=='PASS'
for row in ledger:
    assert sha((frozen/row['path']).read_bytes())==row['originalSha256']
    assert sha((public/row['path']).read_bytes())==row['publicSha256']
files=[dict(path=p.relative_to(public).as_posix(),bytes=p.stat().st_size,sha256=sha(p.read_bytes())) for p in sorted(public.rglob('*')) if p.is_file()]
(public/'MANIFEST.json').write_bytes(enc(dict(prefix='cs280-release-prep/codex-final-2/worklog-terminal-1',cutoffUtc=cutoff,files=files,
    hashCycleRule='MANIFEST excludes itself and SUMS. SUMS includes MANIFEST and excludes itself. This separate child collection does not change parent core controls. External ZIP binds final bytes.')))
mh=sha((public/'MANIFEST.json').read_bytes())
(public/'SHA256SUMS').write_text('\n'.join(r['sha256']+'  '+r['path'] for r in files)+'\n'+mh+'  MANIFEST.json\n')
run('T05-public-sums',['sha256sum','--check','--quiet','SHA256SUMS'],public)
result=dict(status='BOUNDED_TAIL_PREPARED',publicPath=str(public),publicFiles=len(files)+2,rawSourceFiles=len(ledger),cutoffUtc=cutoff,
    manifestSha256=mh,sumsSha256=sha((public/'SHA256SUMS').read_bytes()),redactionMatches=sum(totals.values()),
    nulDelimitersEscaped=sum(r['nulDelimitersEscaped'] for r in ledger),residualFindings=0,toolsCommit=pin.read_text().splitlines()[0],
    afterCutoff='Current collector completion, T04/T05, scope/preflight/push and Library/self-delivery outside cutoff; actual raw logs local and lightweight native receipt.')
(audit/'DELIVERY.json').write_bytes(enc(result))
print(json.dumps(result,ensure_ascii=False,indent=2))
