import datetime, hashlib, io, json, pathlib, re, subprocess, tarfile, zipfile

root = pathlib.Path('/workspace/ags-cs-2x')
repo = root / 'repo'
out = root / 'output'
out.mkdir(exist_ok=True)
base = 'f39501efe5dfe51d83af9afddf39dec7b7e26b01'
def git(*args):
    return subprocess.check_output(['git', *args], cwd=repo)
def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()
def sha(raw):
    return hashlib.sha256(raw).hexdigest()
head = git('rev-parse', 'HEAD').decode().strip()
assert head == '4ba47558020bd5e501fa9718f09d562dcf573713'
assert git('status', '--porcelain') == b''
files = {}
archive = git('archive', '--format=tar', head)
source_manifest = []
with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
    for member in tar:
        if member.isdir():
            continue
        assert member.isfile() and not member.name.startswith('/') and '..' not in pathlib.PurePosixPath(member.name).parts
        raw = tar.extractfile(member).read()
        files['source/' + member.name] = raw
        source_manifest.append({'path': member.name, 'bytes': len(raw), 'sha256': sha(raw), 'mode': oct(member.mode)})
for directory, prefix in [(root/'input','frozen-input'), (root/'evidence','evidence')]:
    for p in sorted(directory.rglob('*')):
        if p.is_file():
            files[prefix + '/' + str(p.relative_to(directory))] = p.read_bytes()
for name in ['run-check.py', 'run-baseline.py']:
    files['evidence/' + name] = (root/name).read_bytes()
files['AGS-2.8.0-CS-RC.patch'] = git('format-patch', '--stdout', '--binary', base+'..'+head)
files['AGS-2.8.0-CS-RC.bundle'] = (root/'AGS-2.8.0-CS-RC.bundle').read_bytes()
files['change-stat.txt'] = git('diff', '--stat', base, head)
changes=[]
for line in git('diff','--name-status',base,head).decode().splitlines():
    status, path=line.split('\t',1)
    changes.append({'status':status,'path':path,'generated':path.startswith('claude-plugin/') or path.startswith('mcp-server/dist/')})
pin={'baseCommit':base,'sourceCommit':head,'sourceTree':git('rev-parse',head+'^{tree}').decode().strip(),
     'branch':'codex/cs-engineering-2x','worktree':str(repo),'upstream':'https://github.com/jaeseongs95/agent-governance-suite.git',
     'observedMain':base,'publicVersion':'2.7.7','publicTagObject':'c329674678c098007104a5170bbef75c82686c69',
     'publicTagCommit':'ba85fdcf245b9910674d88fffdd125f6f0454027','candidateVersion':'2.8.0','skillVersion':'0.2.0',
     'knowledgePackVersion':'0.1.0','inputManifestSha256':'6348400d65f62759f12e3bfc58fbcdf40c63292ba6e1977d59b8c26f8a514475',
     'inputManifestBytes':18543,'inputFileCount':101,'inputExactSetVerified':True,'worktreeClean':True,
     'sourceFileCount':len(source_manifest),'changedFileCount':len(changes),'remoteMutations':False,
     'testsBeforeCommit':'Final source bytes tested before local commit; source-lock, Claude and bundle checks repeated after commit.'}
verification={'status':'REVIEW_CANDIDATE_WITH_BLOCKERS','releaseReady':False,
    'environment':{'node':'24.19.0','pnpm':'11.19.0','python':'3.12.14','sqlite':'3.53.1','pythonJsonschema':'4.26.0','os':'Linux'},
    'fullVitest':{'passed':911,'failed':3,'skipped':5,'total':919,'log':'evidence/13d-full-tests.log'},
    'baselineFailedFixtureReproduction':{'passed':133,'failed':3,'total':136,'commit':base,'log':'evidence/19-baseline-fixtures.log'},
    'csVitest':{'passed':16,'failed':0,'note':'15 integration cases and one wrapper for the selected Node regression subset','log':'evidence/07h-cs-deployment.log'},
    'frozenInputNode24':{'passed':151,'failed':0,'log':'evidence/14-input-node24.log'},
    'sqliteReference':{'passed':9,'failed':0,'log':'evidence/09-sqlite-reference.log'},
    'schemaCrossCheck':{'schemas':7,'cases':44,'agreements':44,'nodeSchemaEngine':'ags-ajv2020','log':'evidence/29-schema.log'},
    'pipelinePass':['locked install with isolated store','source:check','lint','build','runtime:check (30 CLI entrypoints)',
                    'validate:all','skills:context-check','release:check','bundle:check','claude:build (463 files)','claude:check','git diff --check','git bundle verify'],
    'officialValidator':{'status':'BLOCKED','reason':'ENOENT [REDACTED:PRIVATE_HOME]/skills/.system/plugin-creator/scripts/validate_plugin.py','log':'evidence/15-official.log'},
    'notRun':['user-host installation/automatic invocation','Windows + Node24','A/B/C model quality and cost evaluation','independent SOURCE audit'],
    'notImplemented':['signed plan/lease/start/resume full CS binding','conditional ponytail required input and semantic receipt','all-path CS applicability/acceptance gate','automatic CS binding-to-epoch recontract'],
    'frozenInputEvidence':'Historical Node22/Python3.13/SQLite3.46 evidence under frozen-input is not current candidate PASS.'}
files['source-pin.json']=encoded(pin)
files['change-list.json']=encoded(changes)
files['source-manifest.json']=encoded({'sourceCommit':head,'files':source_manifest})
files['verification-status.json']=encoded(verification)
files['release-notes-2.8.0-rc.ko.md']=(repo/'docs/release-notes-2.8.0-rc.ko.md').read_bytes()
report=f'''# AGS 2.8.0 CS 통합 후보 검토 보고서

현재 상태는 **구현 후보 / 공개 릴리스 보류**다. 최종 소스는 `{head}`이고 로컬 브랜치 `codex/cs-engineering-2x`, worktree `{repo}`에 보존했다. 이 ZIP은 완전한 소스 snapshot, 적용 patch, 기준 commit을 전제로 한 Git bundle, 변경 목록, 명령·원시 로그·해시 manifest를 제공한다. 부모가 지정한 AGS 리드와 구현자에게서 분리된 SOURCE 검토자가 인수할 수 있다. 인수 확인이나 독립 감사 완료를 주장하지 않는다.

## 기준·입력·동결

- 기준 main/HEAD: `{base}` / AGS 2.7.7. 확인한 공개 v2.7.7 tag object는 c329674678c098007104a5170bbef75c82686c69, peeled commit은 ba85fdcf245b9910674d88fffdd125f6f0454027이다. 확인 시점은 2026-10-06 UTC이며 원격 쓰기는 없다.
- Drive CS 폴더 `1hQrWjRxCBrACWXWfEt2bWts9BDonRrwH`, 패키지 폴더 `[REDACTED:PRIVATE_RESOURCE]`를 공식 도구로 재귀 조회했다. 패키지 22개 폴더는 각각 100개 page 한도 미만이며 실제 101개 파일 = MANIFEST의 99개 + MANIFEST.json + SHA256SUMS다. 누락·추가·hash 오류 0이다. `evidence/drive-inventory.json`에 각 folder/file의 ID·경로·개수·한도를 보존했다.
- MANIFEST ID `[REDACTED:PRIVATE_RESOURCE]`, 18543 bytes, SHA256 `6348400d65f62759f12e3bfc58fbcdf40c63292ba6e1977d59b8c26f8a514475`를 처음과 마지막에 확인했다. `frozen-input/`은 원본 bytes다.
- 지정 root README ID `[REDACTED:PRIVATE_RESOURCE]`와 상위 검증 보고서 ID `1Yw_D8yXSYBlYnPw5lR8wNXo7p7h9MRNF`도 읽고 보존했다. 추가 입력 SHA는 `evidence/input-final-verification.json`에 있다.
- AGENTS.md, task-contract/orchestrator/ponytail/change-scope-guardian 지침과 원 설계·implementation-status를 읽었다. installer와 관련 스크립트의 쓰기 효과를 읽은 뒤 깨끗한 새 worktree에만 check/apply했다. 최초 installer 변경은 63개이며 receipt 경로는 `evidence/install-apply.json`에 있다. 입력·원격 PEER/R5.1 미커밋 후보는 섞지 않았다.

## 실제 통합

새 전문 기능이므로 **2.8.0 minor 후보**를 제안한다. cs-engineering 배포 0.2.0과 동결 지식팩 0.1.0을 구분한다. 기본5분야20규칙과 명시적으로 도입하는 draft5분야20규칙을 유지하며 draft를 validated로 승격하지 않았다. 원리·불변조건·실패 유형·판단 질문과 필요한 분야만 로딩하는 구조를 보존했다.

1. implicit invocation metadata, registry bootstrap25/workflow67, query CLI, bilingual README, internal source-lock, Claude 생성물을 연결했다. bootstrap derivation은 workflow capability가 아니므로 계약 전 실행하고 review capability만 task에 넣도록 설명·회귀로 확인했다.
2. handoff CLI가 구현 전 동결 task/binding/request/constraints/policy와 실물 출처·의무 ID를 대조한다. orchestrator→task-contract→구현자→검토→acceptance의 실제 참고 경로를 문서화했다. 인계 데이터를 읽었다는 의미적 수신 증명은 별도다.
3. 기존 StageResult/ProviderResult artifacts를 활용하는 닫힌 CsStageBundle.v1을 추가했다. 선택된 CS review에서 고정 manifest/raw hash, 기존 signed taskDigest, report와 provider output 전체, candidate·동결 조건·환경·원시 source/evidence digest를 실제 패키지 CLI로 검사한다. 기록 뒤 finalize와 SQLite 재시작에서도 pin을 재검사한다.
4. FAIL/BLOCKED는 non-passing이며 observe/NOT_RUN을 PASS로 승격하지 않는다. 새로운 TaskEnvelope 임의 필드, plan wrapper migration, DB migration, 승인 권한, 감사 책임 완화가 없다. receipt 정책과 execution assurance는 기존 검사를 유지한다.
5. MCP runtime smoke에 CS CLI를 추가했다. 생성기에서 원 설계의 dual-host 참고 문서만 기존 dual-host 예외 목록에 넣고 원본을 수정하지 않았다. Claude 파일은 `pnpm claude:build`로만 생성했다.

호환성 기준은 이 정확한 2.7.7 commit, Node>=24, pnpm11.19.0, Registry2.0/SourceLock3.0/TaskEnvelope1.0이다. 다른 2.x commit에 무검토 자동 적용하는 patch는 아니다. 후보 metadata는 2.8.0이지만 README의 공개 설치 참조는 실제 v2.7.7을 유지한다. 원격 push/merge/tag/release나 사용자 plugin cache 변경은 없다.

## 검증 결과

| 실행 | 실제 결과 | 로그 |
| --- | --- | --- |
| AGS 전체 Node24 Vitest | 919개: 911 PASS / 3 FAIL / 5 SKIP | evidence/13d-full-tests.log |
| 신규 CS 통합·배포 | 16 PASS: 15개 통합 사례 + Node subset harness | evidence/07h-cs-deployment.log |
| 동결 입력 전체 Node24 회귀 | 151 PASS | evidence/14-input-node24.log |
| SQLite 실제 독립 프로세스 참조 | 9 PASS, Python3.12.14 / SQLite3.53.1 | evidence/09-sqlite-reference.log |
| 스키마 교차 검사 | 7 schemas / 44 agreement, native ags-ajv2020 + Python jsonschema4.26.0 | evidence/29-schema.log |
| source-lock/lint/build/runtime/validate:all/context/release | PASS; runtime 30개 CLI | evidence/20-runtime.log, 21–30 로그 |
| commit 후 source-lock/Claude/bundle | PASS; Claude 463 files fresh | evidence/31–33 로그 |
| 공식 plugin validator | BLOCKED: 환경 내 필수 Python script ENOENT | evidence/15-official.log |
| 실호스트/Windows/품질 평가/독립 SOURCE 감사 | NOT_RUN | verification-status.json |

전체 회귀를 PASS로 주장하지 않는다. 3 FAIL은 `historical-wake.test.mjs:421`의 broker 종료 PID 검사, `session-message.test.ts:897`의 상태 대기와 `:87/:107`의 broker 종료 대기다. 깨끗한 기준 `{base}`의 별도 detached worktree에서 같은 2개 파일을 다시 실행해 133 PASS / 같은 3 FAIL을 확인했다(`evidence/19-baseline-fixtures.log`). 기존 fixture 문제의 근본 원인은 이 작업에서 해결했다고 주장하지 않으며 리드 검토가 필요하다.

원시 실패와 보정도 보존한다. 최초 pnpm store/자동 sync 환경 오류는 isolated XDG/store+CI로 보정했다. TypeScript와 ESLint 오류를 수정했고 합성 MCP observation ID fixture를 기존 최소 길이에 맞췄다. 기존 보안 검사를 낮추지 않았다. `/workspace/.git`, `/tmp/.git`의 환경상 synthetic read-only 항목 때문에 non-Git 작업공간 테스트 7개가 실패했으며 `/dev/shm/ags-cs-2x-tests`를 추가 filesystem grant로 격리해 7개 모두 통과했다. Claude의 신규 파일 누락은 Git intent registration 후 기존 생성기로 보정했다. STDIO profile fixture가 HOME 기본 trust DB에 접근하지 않도록 해당 fixture의 shared-state 경로를 명시했다. 13/13b/13c 로그를 삭제하거나 최종 PASS로 덮어쓰지 않았다.

입력의 기존 Node22.16/Python3.13.5/SQLite3.46.1 결과는 현재 후보 검증으로 재사용하지 않았다. 입력 sample review/evidence JSON의 PASS는 예제이며 제품 회귀 PASS도 아니다. JSON 구조·결속의 검사와 실행 내용의 진실성·학술 포괄성·모델 품질·독립 감사는 구분한다.

## 남는 기능과 리드의 선택

| 경계 | 현재 상태와 파일·행 |
| --- | --- |
| plan1.1, signed plan/expected plan/lease/start/resume binding | NOT_IMPLEMENTED — source/docs/cs-engineering.md:23; source/skills/cs-engineering/references/ags-2x-integration.md:55 |
| 전 작업 CS 적용성, ponytail 조건부 입력, 의미적 수신 | NOT_IMPLEMENTED — source/docs/cs-engineering.md:24; source/skills/cs-engineering/references/ags-2x-integration.md:57 |
| acceptance 의무 집합 강제, CS 후보 변경의 재계약·epoch 자동 연결 | NOT_IMPLEMENTED — source/docs/cs-engineering.md:25; 원 입력 frozen-input/package/docs/implementation-status.ko.md:29 |
| 정책 권한, 테스트 진실성, reviewer 독립성 | validator 보장 밖 — source/docs/cs-engineering.md:26; source/skills/cs-engineering/references/ags-2x-integration.md:48 |
| 실호스트 자동 선택·Windows·품질·독립 SOURCE | NOT_RUN — source/docs/cs-engineering.md:27 |

구현 지점은 source/mcp-server/src/cs-engineering-validator.ts:8, source/mcp-server/src/workflow-service.ts:695 및 :761, source/skills/cs-engineering/scripts/ags-adapter.mjs:35다. CS binding은 기록된 stage artifact에서 처음 pin된다. 이것을 전체 생명주기의 우회 불가 acceptance gate라고 설명하지 않는다. 사용자에게 별도로 등록된 전체 '스킬 선택 실패 원인 분석'을 완료했다는 주장도 없다. 재현 가능한 discovery·capability planning·실제 synthetic MCP stage·음성 wire 검사 범위만 만들었다.

리드는 (A) 현재 제한적 2.8.0 후보를 독립 SOURCE 검토하고 남은 회귀/공식 validator blocker를 해결하거나, (B) 별도 승인된 opt-in1.1 계약 및 전 생명주기 binding 작업을 설계할 수 있다. 전 작업 강제 적용과 운영 권한 확대는 별도 결정이며 이 후보에 자동으로 3.0 전체 설계를 넣지 않았다.

## 테스트 격리·비밀·배포

- 테스트는 이 작업의 임시 파일·SQLite DB·합성 task/actor/observation fixture에 한정했다. 실제 MCP tool 이름을 사용한 InMemoryTransport 시험은 실제 사용자 세션이나 호스트 연결이 아니다. update store의 nextCheckAt을 합성 미래값으로 고정해 신규 CS 시험의 외부 update fetch를 막았다.
- 기존 TLS/STDIO/메시징 서버 검사는 localhost/[REDACTED:IP_ADDRESS] fixture 서버다. 사용자 PC의 MCP/호스트를 초기화·조회하지 않았고 운영 registry/실물 계정 인증·네트워크 설정·사용자 세션 발신은 없다.
- 새 서명 fixture는 `createPlanSigningKey()`의 임시 random32bytes HMAC 키다(source/mcp-server/src/workflow-store.ts:262). 메모리 store와 임시 `ags-cs-stage-*/fixture.sqlite3`에만 사용하며 운영 등록 키를 읽지 않는다. 기존 TLS fixture는 P-256 self-signed `session-messaging-*/broker-key.pem`과 임시 random32bytes token을 사용한다. 초기 tmp는 `/workspace/ags-cs-2x/tmp`, 다음 `/tmp/ags-cs-2x-tests`, 최종 `/dev/shm/ags-cs-2x-tests`다. tool-state는 `/workspace/ags-cs-2x/tool-state`로 분리했다.
- ZIP에는 mutable temp DB, tool-state, 운영 자격증명, PEM private key, token 값, node_modules, .git admin을 넣지 않는다. 기존 tracked glossary DB는 정적 제품 데이터이므로 소스 snapshot에 포함했다. 비밀 패턴과 ZIP 파일 집합을 검사했다. 원시 로그에도 비밀값을 출력하지 않는다.
- Library에 동일 ZIP을 저장한다. Drive에는 입력을 수정하지 않고 CS 폴더 아래 새 결과 폴더에 올리며 owner-only/private 상태를 확인하고 raw 재다운로드 SHA256을 로컬 ZIP과 대조한다. 실제 Library ID·Drive file ID·ZIP hash·업로드 검증은 ZIP 생성 이후의 `delivery-receipt.json` 및 최종 인계 응답이 정본이다. 공유 권한 변경은 없다.

## 검토 방법

먼저 source-pin.json, verification-status.json, change-list.json, 원 설계와 범위 문서를 읽는다. 전체 파일 manifest는 source-manifest.json 및 MANIFEST.json에 있다. patch는 정확한 기준의 새 격리 worktree에 `git am AGS-2.8.0-CS-RC.patch`로 검토할 수 있으며, Git bundle은 기준 history를 가진 checkout에서 별도 로컬 branch로 fetch해 원 commit pin을 보존할 수 있다. 원격 배포 작업을 자동 실행하는 installer는 이 후보 ZIP의 적용 절차로 사용하지 않는다. frozen-input의 installer는 원 입력 증거다.

evidence/commands.jsonl에는 실제 argv/cwd/시각/exitCode/log 이름을 남겼다. evidence/run-check.py가 격리 환경을 보여준다. 부모와 리드의 공개 릴리스 검토·확인 및 독립 SOURCE 검토 전에는 main/태그/Release/사용자 설치본에 적용하지 않는다.
'''
files['verification-report.ko.md']=report.encode()
files['evidence-manifest.json']=encoded({'sourceCommit':head,'files':[{'path':k,'bytes':len(v),'sha256':sha(v)} for k,v in sorted(files.items()) if k.startswith('evidence/')]})
secret_patterns=[rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',rb'gh[pousr]_[A-Za-z0-9]{20,}',rb'sk-[A-Za-z0-9]{20,}',rb'Bearer [A-Za-z0-9_-]{32,}']
# Test source may contain a literal pattern definition; real raw PEM/token values are prohibited.
for name,raw in files.items():
    if name.startswith(('evidence/','frozen-input/')) or name.endswith('.patch'):
        for pattern in secret_patterns:
            assert not re.search(pattern,raw), 'Secret pattern in ' + name
manifest={'schemaVersion':'1.0.0','sourceCommit':head,'scope':'Every ZIP entry except this manifest itself. Archive digest is external in delivery receipt.',
          'files':[{'path':k,'bytes':len(v),'sha256':sha(v)} for k,v in sorted(files.items())]}
files['MANIFEST.json']=encoded(manifest)
zip_path=out/'AGS-2.8.0-CS-RC-review.zip'
with zipfile.ZipFile(zip_path,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    for name,raw in sorted(files.items()):
        info=zipfile.ZipInfo(name,(2026,10,6,2,17,44));info.compress_type=zipfile.ZIP_DEFLATED
        info.external_attr=(0o100644<<16);z.writestr(info,raw,compresslevel=9)
with zipfile.ZipFile(zip_path) as z:
    assert z.testzip() is None and set(z.namelist()) == set(files)
    for entry in manifest['files']:
        raw=z.read(entry['path']);assert len(raw)==entry['bytes'] and sha(raw)==entry['sha256']
result={'path':str(zip_path),'bytes':zip_path.stat().st_size,'sha256':sha(zip_path.read_bytes()),'entries':len(files),
        'sourceCommit':head,'sourceFiles':len(source_manifest),'changedFiles':len(changes),'manifestVerified':True}
(out/'zip-verification.json').write_bytes(encoded(result))
(out/'verification-report.ko.md').write_bytes(files['verification-report.ko.md'])
print(json.dumps(result))
