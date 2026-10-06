import hashlib, io, json, pathlib, re, subprocess, tarfile, zipfile

root=pathlib.Path('/workspace/ags-cs-2x/linux-lifecycle-r1');repo=root.parent/'repo';out=root/'output'
base='4ba47558020bd5e501fa9718f09d562dcf573713';head='3b9c34b0dc0ca65d74db1631cc5fdd4898b7f2d7'
original=root.parent/'output/AGS-2.8.0-CS-RC-review.zip'
def git(*args):return subprocess.check_output(['git',*args],cwd=repo)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def encoded(value):return (json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode()
assert git('rev-parse','HEAD').decode().strip()==head and not git('status','--porcelain')
assert sha(original.read_bytes())=='2f4067919ec83cccef39650cdac61d4dca61d47e9c8ccdf4558fe0f011f06fc4'
assert '914 passed | 5 skipped (919)' in (root/'evidence/07-full-process-only.log').read_text()
payload={};modes={};source_manifest=[]
with tarfile.open(fileobj=io.BytesIO(git('archive','--format=tar',head))) as tar:
 for member in tar:
  if member.isdir():continue
  assert member.isfile() and not member.name.startswith('/') and '..' not in pathlib.PurePosixPath(member.name).parts
  raw=tar.extractfile(member).read();name='source/'+member.name;payload[name]=raw;modes[name]=member.mode
  source_manifest.append({'path':member.name,'bytes':len(raw),'sha256':sha(raw),'mode':oct(member.mode)})
with zipfile.ZipFile(original) as old:
 old_manifest=json.loads(old.read('source-manifest.json'))
 original_differences=[f['path'] for f in old_manifest['files'] if sha(payload['source/'+f['path']])!=f['sha256']]
 assert len(old_manifest['files'])==1344 and not original_differences
 for name in ['verification-report.ko.md','verification-status.json','source-pin.json','source-manifest.json','evidence/13d-full-tests.log','evidence/19-baseline-fixtures.log','evidence/15-official.log']:
  payload['original-r0/'+name]=old.read(name)
payload['original-r0/delivery-receipt.json']=(root.parent/'output/delivery-receipt.json').read_bytes()
for p in sorted((root/'evidence').glob('*')):
 if p.is_file():payload['evidence/'+p.name]=p.read_bytes()
payload['evidence/observer-final.py']=(root/'observe.py').read_bytes()
payload['AGS-2.8.0-CS-Linux-lifecycle-r1.patch']=git('format-patch','--stdout','--binary',base+'..'+head)
payload['AGS-2.8.0-CS-Linux-lifecycle-r1.bundle']=(out/'AGS-2.8.0-CS-Linux-lifecycle-r1.bundle').read_bytes()
changes=[{'status':s,'path':p} for s,p in (line.split('\t') for line in git('diff','--name-status',base,head).decode().splitlines())]
assert [f['path'] for f in changes]==['tests/helpers/linux-child-reaper.md','tests/helpers/linux-child-reaper.py']
pin={'requestId':'c1a7252a-c8ed-4fd4-8d49-c744043e91d3','messageId':'d68a83e4-f4df-4ad9-951d-42b60684b27c','leadThread':'01a1023f-b277-7ef1-bb48-4b90770caf13',
 'baseCommit':base,'sourceCommit':head,'sourceTree':git('rev-parse',head+'^{tree}').decode().strip(),'branch':'codex/cs-engineering-2x','worktree':str(repo),
 'candidateVersion':'2.8.0','revision':'Linux-lifecycle-r1','changedFiles':changes,'sourceFiles':len(source_manifest),
 'originalSourceFilesCompared':1344,'originalSourceByteDifferences':original_differences,'originalZipBytes':original.stat().st_size,
 'originalZipSha256':sha(original.read_bytes()),'originalZipUnmodified':True,'productionChanges':False,'assertionsTimeoutsSkipsChanged':False,
 'worktreeClean':True,'remoteWrites':False,'testsExecutedBeforeCommit':'Recorded working-file-pins.json matches committed harness bytes; all 1344 original source files are byte-identical.'}
status={'state':'QUALIFIED_LINUX_REGRESSION_PASS','environment':{'node':'24.19.0','pnpm':'11.19.0','python':'3.12.14','platform':'Linux','pid1':'tail'},
 'supervisedFull':{'passed':914,'failed':0,'skipped':5,'total':919,'exitCode':0,'adoptedChildrenReaped':51,'childExitCodesAllZero':True,'log':'evidence/07-full-process-only.log'},
 'supervisedAffectedFiles':{'passed':136,'failed':0,'skipped':0,'exitCode':0,'adoptedChildrenReaped':7,'log':'evidence/04-harness-fixtures.log'},
 'unchangedUnsupervisedDiagnostic':{'passed':1,'failed':3,'notSelected':132,'exitCode':1,'log':'evidence/01-unreaped.log'},
 'supervisorDiagnostic':{'passed':4,'failed':0,'notSelected':132,'exitCode':0,'log':'evidence/02-reaped.log'},
 'failureExitPreserved':{'expected':7,'observed':7,'log':'evidence/05-exit-propagation.log'},
 'otherPass':['source:check','lint','bundle:check','claude:check','git diff --check','git bundle verify'],
 'rawCorrectionLogs':['03-harness-fixtures.log: absent optional proc children file; corrected supervisor', '06-full-node24.log: diagnostic SQLite read collided with migration DDL; removed DB reader in final whole suite'],
 'unsupervisedContainerStatus':'Original three failures remain when this non-reaping PID1 environment has no supervisor; not relabeled PASS.',
 'productionLifecycleFixClaimed':False,'windows':'Separate lead verifier; no result claimed here','officialValidator':'Original missing-script BLOCKED persists; not changed in this follow-up',
 'independentSourceAudit':'NOT_RUN','remainingNotImplemented':['signed1.1 all-lifecycle CS binding','global acceptance/applicability gate'],'releasePublished':False}
report=f'''# AGS CS 2.8.0 — Linux lifecycle revision r1

한국시간 2026-10-06. 기계 로그의 시각은 UTC ISO다. 회신 대상은 AGS 리드 `01a1023f-b277-7ef1-bb48-4b90770caf13`, requestId `c1a7252a-c8ed-4fd4-8d49-c744043e91d3`, 같은 발급 messageId `d68a83e4-f4df-4ad9-951d-42b60684b27c`다. 동일 업무는 이 Linux owner 한 명이 이어서 수행했다. 별도 개발자나 새 구현을 배정하지 않았다.

결과는 **Linux 테스트 환경 보정 아래 회귀 통과**다. 원본 일반 실행의 3 FAIL을 삭제하거나 PASS로 바꾸지 않는다. 일반 명령을 비회수 PID 1 아래서 그대로 실행하면 그 환경 실패는 남는다. 이번 revision은 테스트를 정상적으로 감독하는 선택적 harness를 제공한다.

## 소스와 변경

- 기존 worktree `{repo}`, 브랜치 `codex/cs-engineering-2x`를 유지했다. 착수 시 HEAD는 `{base}`, clean이었고 실행 중인 이전 검증 작업은 없었다. 남은 zombie 메타데이터를 확인했다.
- 최종 로컬 commit `{head}`; source tree `{pin['sourceTree']}`; 작업 트리 clean.
- 변경은 `tests/helpers/linux-child-reaper.py`와 설명 `tests/helpers/linux-child-reaper.md` 두 파일, 102 insertions뿐이다. 원 테스트 두 파일, broker/relay/identity/runtime, CS gate, 계약/registry/keys/version metadata를 수정하지 않았다. 원 `4ba` ZIP의 source 1,344개 파일 bytes가 모두 같다. 새 source snapshot은 1,346개다.
- 원 ZIP 3,956,830 bytes와 SHA256 `2f4067919ec83cccef39650cdac61d4dca61d47e9c8ccdf4558fe0f011f06fc4`, 원 보고/실패/delivery를 보존했다. 원 ZIP 자체를 덮어쓰지 않았다.

## 세 실패를 가른 관측

| 대상 | 새 관측과 실제 lifecycle | 판단 |
| --- | --- | --- |
| historical-wake.test.mjs:421 client-ensure | 짧은 CLI가 detached broker를 시작하고 종료한다. PID 28272는 endpoint를 정리한 뒤 `state=Z`, `PPID=1`로 남았다. prestarted direct-child control은 통과한다. reaper 조건의 broker는 exit0으로 waitpid 회수되고 기존 PID 소멸 assertion이 통과한다. | broker 작업 실패가 아니라 fixture orphan 회수 누락 |
| session-message.test.ts:897 profile relay 종료 | 같은 존재 generation에서 codex-queue가 유지된다. 설정 false 후 새 SessionStart는 새 codex-deferred generation을 만든다. 이전 queue generation은 ended_at이 기록되고 relay PID 29257이 종료하지만, 첫 불완전 harness 아래서 zombie가 남는다. 수정 harness는 relay를 회수하고 기존 새 presence online assertion도 통과한다. | queue profile/전환이 정상이고 종료된 relay의 회수가 문제 |
| session-message.test.ts:87/107 packaged hook teardown | hook CLI가 자동 시작한 broker PID 28144는 종료 시 endpoint가 제거됐고 `state=Z`, `PPID=1`로 남는다. 올바른 supervisor 아래에서는 endpoint 정리 후 실제 PID가 소멸하고 teardown이 통과한다. | 운영 broker 종료 로직 수정 근거 없음; fixture supervisor 필요 |

`evidence/01-unreaped.observations.json`의 endpoint 삭제/PID state 전이와 `03/04-harness-fixtures.observations.json`의 synthetic SQL presence/relay 메타데이터가 근거다. `evidence/lifecycle-discriminants.json`에는 해당 profile 전이와 relay zombie를 추렸다. 종료된 zombie도 `kill(pid,0)`에 남는 기존 assertion을 바꾸지 않고, OS waitpid로 실제 회수했다. queue body/nonce/인증 secret은 관측하지 않았다.

01 실행은 선택된 4개 diagnostic case에서 기존3 FAIL/1 PASS, 02의 supervisor 조건은 같은4 PASS였다. `-t`로 선택하지 않은132개는 이 진단의 전체 PASS 근거가 아니다. 후속04에서 두 파일136개를 모두 실행했고, 최종07에서 전체919개를 실행했다.

## 최소 보정

`source/tests/helpers/linux-child-reaper.py:16`의 PR_SET_CHILD_SUBREAPER는 그 테스트 supervisor에만 적용한다. 받은 argv를 shell 없이 동일 cwd/env로 실행한다. `:38`에서 PPID가 자신의 PID인 자식만 고르고 `:41`의 waitpid(WNOHANG)로 회수한다. command의 PID는 Popen.wait가 담당하므로 빼며, 사용자/운영 프로세스에 signal을 보내거나 PID1을 수정하지 않는다. 통과를 발급하는 schema/계약, timeout, skip, 기대값 완화가 없다. 명령이 exit7이면 harness도 exit7이다.

이 optional Linux harness에는 Python 표준 라이브러리가 필요하다. 제품 CLI의 의존성이나 배포/runtime 요구는 늘리지 않았다. 제대로 감독되는 host나 Windows는 이 harness를 쓰지 않는다. 이 보정이 다른 Linux 커널/namespace 조합이나 실제 사용자 설치 호스트에서 검증됐다는 주장도 없다.

## 실제 명령·환경·결과

모든 cwd는 `{repo}`. Node24.19.0 / pnpm11.19.0 / Python3.12.14 / Linux. 최종 TMPDIR은 `/dev/shm/ags-cs-lifecycle-r1/07-full-process-only`, shared-state/XDG는 `/workspace/ags-cs-2x/linux-lifecycle-r1/tool-state/`로 격리했다. pnpm store는 기존 작업의 `/workspace/ags-cs-2x/tool-state/pnpm-store`. 개발용 임시 경로만 filesystem grant를 사용했고 운영 registry/DB/키/계정/네트워크 설정을 변경하지 않았다.

```text
python tests/helpers/linux-child-reaper.py pnpm exec vitest run tests/session-messaging/historical-wake.test.mjs tests/session-messaging/session-message.test.ts --maxWorkers=2
=> exit0, 136 PASS, 0 FAIL, 0 SKIP; adopted children 7, all exit0

python tests/helpers/linux-child-reaper.py pnpm test --maxWorkers=2
=> exit0, 914 PASS, 0 FAIL, 5 inherited SKIP (919), 67 passed files / 1 inherited skipped file
=> adopted children 51, all exit0, harnessErrors []

python tests/helpers/linux-child-reaper.py node -e 'process.exit(7)'
=> exit7 preserved
```

source:check, lint, bundle:check, claude:check, git diff --check, git bundle verify는 exit0이다. 최종 test가 기존 build 스크립트를 실행했고 그 결과의 모든 원 source bytes 및 배포 bundle은 4ba와 같다. 현재 명령/환경/시각/exit와 실행 전 확인한 파일 pin은 evidence/commands.jsonl, 각 log의 첫 JSON, working-file-pins.json, source-pin.json을 따른다.

원시 log/observations의 `subreaper` 필드는 외부 관측기 자체의 옵션이다. 04/07은 외부 관측기 false이고 실제 실행 명령 안의 linux-child-reaper.py가 PR_SET_CHILD_SUBREAPER를 적용한다. 따라서 실제 supervisor 동작은 command argv, harness 소스와 test-fixture-reaper 결과의 회수 개수/exit로 대조한다.

실패·보정 로그는 숨기지 않았다. 03의 최초 harness는 이 환경에 없는 `/proc/.../children` 파일 때문에 회수하지 못했다. PPID 필드 방식으로 보정했다. 첫01/02에서는 초기 SQLite observer의 context-close 오류 때문에 SQL 전이 자료가 생성되지 않아 PID/endpoint 자료만 사용한다. SQL 전이는 고친03/04 자료가 근거다. 06의 전체 실행은913 PASS/1 FAIL/5 SKIP였고, 그 하나는 v272 migration fixture 초기 ALTER TABLE의 `database is locked`다. 진단 observer가 전체 fixture DB를 읽던 실행이었다. final07에서는 DB 읽기 observer를 제거하고 제품/테스트 bytes를 그대로 둔 채 전체914 PASS를 얻었다. 이 observer 충돌 보정은 외부 진단 스크립트에만 있으며 wake-liveness 제품/테스트를 수정하지 않았다.

## 범위와 남은 경계

원격 push/merge/tag/release, 사용자 설치·cache·운영 상태, 실제 사용자 세션 발신, 계정 인증/폴러/R5.x/3.x 변경은 없다. 기존 테스트 TLS/STDIO/메시징은 합성 loopback fixture다. 임시 random32bytes HMAC 및 P-256 broker key/token은 fixture temp/DB에만 생성한다. 값은 로그/ZIP에 없다. ZIP은 tracked 소스, 선택된 로그/manifest/observer 스크립트만 포함하고 tool-state/temp/node_modules/.git/개인 credential/mutable DB는 제외한다. 기존 tracked glossary DB는 정적 제품 데이터로만 포함한다.

Windows verifier와 호환성 RO 작업은 리드가 별도로 관리하며 여기서 결과를 대신 판정하지 않는다. 공식 validator의 원 missing-script BLOCKED와 독립 SOURCE 감사 NOT_RUN도 해소했다고 주장하지 않는다. signed1.1 전 생명주기 CS binding과 전역 acceptance/applicability gate는 원 `source/docs/cs-engineering.md:23` 이후의 미구현 경계를 그대로 유지한다. 이번 작업에서 제품 broker/공통 계약 수정이 필요하다는 근거는 얻지 못했으므로 쓰지 않았다.

이 새 revision의 검토·인수 판단은 리드에게 있다. patch와 bundle은 정확한 `{base}`를 기준으로 한다. source-pin/change-list/source-manifest/MANIFEST가 바이트와 commit을 고정한다. 원 r0 보고/실패는 original-r0 아래에 있다. 실제 새 Library ID·Drive ID·업로드 재다운로드 hash는 ZIP 생성 후 delivery-receipt.json과 최종 회신에 기록한다. 원 r0 파일이나 sharing permission을 바꾸지 않는다.
'''
payload['verification-report.ko.md']=report.encode()
payload['source-pin.json']=encoded(pin);payload['verification-status.json']=encoded(status)
payload['change-list.json']=encoded(changes);payload['source-manifest.json']=encoded({'sourceCommit':head,'files':source_manifest})
payload['evidence-manifest.json']=encoded({'sourceCommit':head,'files':[{'path':n,'bytes':len(b),'sha256':sha(b)} for n,b in sorted(payload.items()) if n.startswith('evidence/')]})
for name,raw in payload.items():
 for pattern in [rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',rb'gh[pousr]_[A-Za-z0-9]{20,}',rb'sk-[A-Za-z0-9]{20,}',rb'Bearer [A-Za-z0-9_-]{32,}']:
  assert not re.search(pattern,raw),'Secret pattern in '+name
manifest={'sourceCommit':head,'scope':'All entries except MANIFEST itself; ZIP digest is external.','files':[{'path':n,'bytes':len(b),'sha256':sha(b)} for n,b in sorted(payload.items())]}
payload['MANIFEST.json']=encoded(manifest)
zip_path=out/'AGS-2.8.0-CS-Linux-lifecycle-r1-review.zip'
with zipfile.ZipFile(zip_path,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for name,raw in sorted(payload.items()):
  info=zipfile.ZipInfo(name,(2026,10,6,3,14,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=((0o100000|modes.get(name,0o644))<<16)
  z.writestr(info,raw,compresslevel=9)
with zipfile.ZipFile(zip_path) as z:
 assert z.testzip() is None and set(z.namelist())==set(payload)
 for f in manifest['files']:
  raw=z.read(f['path']);assert len(raw)==f['bytes'] and sha(raw)==f['sha256']
result={'path':str(zip_path),'bytes':zip_path.stat().st_size,'sha256':sha(zip_path.read_bytes()),'entries':len(payload),'sourceCommit':head,'sourceFiles':len(source_manifest),'changedFiles':len(changes),'original1344SourceByteDifferences':[],'manifestVerified':True,'modePreserved':True}
(out/'zip-verification.json').write_bytes(encoded(result))
for name in ['verification-report.ko.md','source-pin.json','verification-status.json','AGS-2.8.0-CS-Linux-lifecycle-r1.patch']:(out/name).write_bytes(payload[name])
print(json.dumps(result))
