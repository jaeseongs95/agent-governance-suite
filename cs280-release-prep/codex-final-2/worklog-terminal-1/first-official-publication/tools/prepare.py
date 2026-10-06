"""Publish byte-identical approved sanitized ZIP with new root coverage controls only."""
import datetime, hashlib, json, pathlib, shutil, zipfile
from runner import ROOT, run
sha=lambda b:hashlib.sha256(b).hexdigest()
enc=lambda v:(json.dumps(v,ensure_ascii=False,indent=2)+'\n').encode()
audit=ROOT/'audit'
source=ROOT.parent/'official-validator-26c6c9d9/AGS-CS280-Codex-official-1-delivery.zip'
expected='1110e6b0bea193247b66ec17e3f312f84ac6187e38b4bf57bb74c5fea690210d'
assert source.stat().st_size==451171 and sha(source.read_bytes())==expected
public=ROOT/'public/cs280-release-prep/codex-official-1'
assert not public.exists()
public.mkdir(parents=True)
original=[]
with zipfile.ZipFile(source) as z:
    assert len(z.namelist())==250
    for info in z.infolist():
        name=info.filename
        assert not info.is_dir() and not name.startswith('/') and '..' not in pathlib.PurePosixPath(name).parts
        if name.startswith('collection/cs280-release-prep/codex-official-1/'):
            target='collection/'+name.removeprefix('collection/cs280-release-prep/codex-official-1/')
        else:
            assert name.startswith('delivery-terminal/')
            target=name
        p=public/target
        assert not p.exists()
        p.parent.mkdir(parents=True,exist_ok=True)
        data=z.read(info)
        p.write_bytes(data)
        original.append(dict(zipPath=name,path=target,bytes=len(data),sha256=sha(data)))
assert sum(r['path'].startswith('collection/') for r in original)==209
assert sum(r['path'].startswith('delivery-terminal/') for r in original)==41
for folder in ('collection','delivery-terminal'):
    run('I01-'+folder+'-original-sums',['sha256sum','--check','--quiet','SHA256SUMS'],public/folder)
collection=json.loads((public/'collection/raw/logs/commands.jsonl').read_text().splitlines()[0])
def count(name):
    rows=[json.loads(line) for line in (public/name).read_text().splitlines() if line.strip()]
    return dict(records=len(rows),nonzero=sum(r['exitCode']!=0 for r in rows),
                nonzeroCommands=[dict(label=r['label'],command=r['command'],exitCode=r['exitCode']) for r in rows if r['exitCode']!=0])
candidates=list((public/'delivery-terminal').rglob('*commands*.jsonl'))
assert len(candidates)==1, [p.as_posix() for p in candidates]
counts=dict(collection=count('collection/raw/logs/commands.jsonl'),terminal=count(candidates[0].relative_to(public).as_posix()))
assert counts['collection']['records']==54 and counts['collection']['nonzero']==6
assert counts['terminal']['records']==64 and counts['terminal']['nonzero']==7
cutoff=datetime.datetime.now(datetime.timezone.utc).isoformat()
(public/'INTAKE-LIMITS.ko.md').write_text(
    '원 sanitized ZIP 451171 bytes, SHA256 '+expected+'의 250파일을 원바이트 그대로 공개한다. collection 209, delivery-terminal 41이며 기존 SUMS·MANIFEST·노트는 바꾸지 않았다. 새 root controls만 전체 경로와 해시를 연결한다.\n\n'
    '기준은 original4ba47558020bd5e501fa9718f09d562dcf573713/tree5fcc66de8aa37e6a347511c2def0eae54a0ed1e5이다. pnpm19 wrapper exit1, implicit global-store mkdir ENOENT 전에 공식 Python plugin·22 skill은 NOT_RUN이다. 이후 final2의 별도 PASS로 이 실패를 바꾸지 않는다.\n\n'
    'OFFICIAL-EXECUTION-ONCE.json은 원184 bytes에서 public195 bytes로 compact JSON을 pretty JSON으로 재직렬화한 formatting-only 변환이다. 기존 removal0/NUL0/transformation:null의 설명 누락은 원파일을 고치지 않고 여기서 밝힌다. parent의 로컬 재직렬화 결과가 원SHA와 일치했다는 인수 관측이며 전체 private 원본 전달 증거는 아니다.\n\n'
    'COLLECTION-VERIFICATION preservedFailedCommands=5는 집계 정의가 제공되지 않았다. 실제 collection cumulative54행의 nonzero는6, terminal cumulative64행의 nonzero는7이다. 이는 직접실패와 외부 wrapper 실패를 별도 record로 세는 집계이고 실패 원인 개수로 합산하지 않는다. ROOT-MANIFEST에 실제 label·command·exit 목록을 기록한다.\n\n'
    '최초 cutoff의29 stdout은 empty 원bytes가 제공되지 않았다. 이후 partial883 bytes의25·26 records와 완결raw가 별도로 존재한다. 초기 empty 원본을 직접 검증했다고 표현하지 않는다. private 원본 전체 bytes·내부 reasoning·native 전체 transcript는 미제공/NOT_VERIFIABLE이며 원문 추정 복원하지 않는다. 기존 raw/public SHA ledger의 한계도 유지한다.\n\n'
    '새 게시 준비 cutoff는 '+cutoff+'이다. 이 원250파일의 기존 두 cutoff를 소급 확대하지 않는다. 이후 scope/preflight/commit/push 명령의 실제 캡처는 별도 bounded tail에 포함하고 자기 배달 이후는 native receipt로 구분한다. 운영 DB/key/trustfile·private ZIP/Gitbundle payload·다른 세션 transcript·서비스 비밀은 공개 제외한다. 공개는 제품 검증 PASS나 출시·설치 승인이 아니다.\n')
scanner=ROOT.parent/'publication-20261006T040502Z/scan-public.py'
shutil.copyfile(ROOT.parent/'official-final2-d0ce2935/audit/known-private-resource-ids.json',audit/'known-private-resource-ids.json')
scan_copy=ROOT/'disposable-scan-copy'
shutil.copytree(public,scan_copy)
run('I02-unchanged-copy-residual-scan',['python',str(scanner),str(ROOT),str(scan_copy)],ROOT)
result=json.loads((scan_copy/'RESIDUAL-SCAN.json').read_text())
assert result['state']=='PASS'
(audit/'RESIDUAL-SCAN.json').write_bytes(enc(result))
files=[dict(path=p.relative_to(public).as_posix(),bytes=p.stat().st_size,sha256=sha(p.read_bytes())) for p in sorted(public.rglob('*')) if p.is_file()]
assert len(files)==251
manifest=dict(prefix='cs280-release-prep/codex-official-1',cutoffUtc=cutoff,files=files,originalFiles=original,originalZipBytes=451171,originalZipSha256=expected,
    originalPacketFiles=250,collectionFiles=209,terminalFiles=41,allOriginalBytesExact=True,commandCounts=counts,
    hashCycleRule='ROOT-MANIFEST excludes itself and ROOT-SHA256SUMS. ROOT-SHA256SUMS includes ROOT-MANIFEST and excludes itself. Original nested MANIFEST/SUMS preserved unchanged.')
(public/'ROOT-MANIFEST.json').write_bytes(enc(manifest))
mh=sha((public/'ROOT-MANIFEST.json').read_bytes())
(public/'ROOT-SHA256SUMS').write_text('\n'.join(r['sha256']+'  '+r['path'] for r in files)+'\n'+mh+'  ROOT-MANIFEST.json\n')
run('I03-root-sums',['sha256sum','--check','--quiet','ROOT-SHA256SUMS'],public)
delivery=dict(status='APPROVED_UNCHANGED_OFFICIAL1_PACKET_PREPARED',publicPath=str(public),publicFiles=253,originalFiles=250,cutoffUtc=cutoff,
    manifestSha256=mh,sumsSha256=sha((public/'ROOT-SHA256SUMS').read_bytes()),originalZipBytes=451171,originalZipSha256=expected,
    originalPluginStatus='NOT_RUN',originalSkillsStatus='NOT_RUN',residualFindings=0,commandCounts=counts)
(audit/'DELIVERY.json').write_bytes(enc(delivery))
print(json.dumps(delivery,ensure_ascii=False,indent=2))
