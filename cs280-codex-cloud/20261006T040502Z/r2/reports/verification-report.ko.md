# AGS CS 2.8.0 Linux lifecycle r2 — fixture 판별 관측

한국시간 2026-10-06. 리드 `01a1023f-b277-7ef1-bb48-4b90770caf13`의 messageId `22dbddf1-56a8-4711-8356-3870c12de69e`를 기존 d68a83e4/768c2b75 업무에 통합했다. 새 중복 owner/agent를 만들지 않았다. 원 RO DiagnosisReport.v1의 `NEXT_TEST / confirmedCause=null`과 digest 검증은 전달된 metadata다. 이 Cloud에서는 D: 경로의 원 report/spec 전체를 읽거나 canonical validation을 실행하지 않았다. 아래는 새 실제 관측이며 그 원 보고서를 덮어쓰지 않는다.

결과: **이번 Codex Cloud 실행의 기존 세 실패는 종료된 fixture 자식의 회수 누락으로 판별된다.** candidate와 exact baseline의 각 대상 PID에서 starttime이 동일하고, 원 kill-zero가 성공한 마지막 검사에서 state Z / PPID 1이었다. 실제 종료 미완료와 PID 재사용은 이번 관측에서는 배제된다. 일반 실행의 실패를 PASS로 바꾸거나 제품 수정을 발급하는 결과는 아니다.

## 실제 역할·환경·소스

- Linux 수정/관측 owner 한 명. 실제 선택된 Codex Cloud, hostname `d19a608d7837`, Linux 6.18.44 x86_64, Node24.19.0, pnpm11.19.0, Python3.12.14, PID1=`tail`.
- candidate cwd `/workspace/ags-cs-2x/repo`, branch `codex/cs-engineering-2x`. 착수 HEAD `3b9c34b0dc0ca65d74db1631cc5fdd4898b7f2d7`, clean. 새 local commit **`f7912c452483ddc67ba874a185c08fa0038a38e7`**.
- source reference는 원 `4ba47558020bd5e501fa9718f09d562dcf573713` + r1 supervisor + r2 fixture telemetry다. `4ba` 원 소스 1,344개 중 실제 바뀐 기존 파일은 테스트 두 파일뿐이다. 제품·계약·bundle·registry·version의 bytes는 그대로다.
- 새 baseline diagnostic worktree `/workspace/ags-cs-2x/linux-lifecycle-r2/base-repo`, HEAD `f39501efe5dfe51d83af9afddf39dec7b7e26b01`. 이 worktree에만 candidate와 동일한 fixture 네 파일 overlay를 적용했다. **계측 overlay를 포함한 실행이며 original exact clean f395 자체 실행이라고 주장하지 않는다.** 원 tracked1,213개 중 두 fixture 외 bytes 차이는 0이다. 전체 overlay 파일과 비교 manifest가 고정돼 있다.
- 원 `/workspace/agent-governance-suite`와 이전 baseline `/workspace/ags-cs-2x/baseline`은 변경하지 않았다. r0/r1 ZIP·log·delivery도 보존했다. test source를 조작해 기대값을 낮추거나 운영 broker를 고치지 않았다.

## 원 관측과 추가한 계측

기존 r1의 `01-unreaped` 외부 관측은 broker PID28144 start438548, PID28272 start439637에서 같은 starttime의 R/S→Z/PPID1 전이를 기록했다. relay PID28108도 start437011의 Z/PPID1 전이를 보였으며, 별도 `03-harness-fixtures`는 SQL fixture의 relay PID29257 start458020을 확인했다. 이는 새 RO 문서가 분석한 r0 13d/19 log보다 뒤에 생성된 자료다. baseline fixture 내부 kill/stat 대응 관측은 없어 이번 r2에서 채웠다.

`tests/helpers/fixture-process-observer.ts:19`는 `AGS_TEST_PROCESS_OBSERVATIONS`가 지정된 Linux fixture에서만 동작한다. 원 process.kill callback의 앞뒤에 `/proc/<pid>/stat`의 state, ppid, starttime을 읽어 JSONL로 기록한다. callback return/error를 그대로 전달한다. 출력 실패는 stderr에 표시하며 관측 증거를 무효로 본다. 이번 기록 오류는 0이다. observer 자체에 kill, signal, waitpid, subreaper, DB query는 없다.

`session-message.test.ts`의 broker terminate와 profile relay 검사, `historical-wake.test.mjs`의 client-ensure broker 검사에만 연결했다. profile은 기존 next SessionStart 앞뒤와 기존 kill-zero loop를 함께 관측한다. 원 deadline 5초/10초/15초, delay20/50ms, assertion, catch 의미, 보안 검증, 제품 lifecycle은 유지했다. env 미지정 또는 Linux 외 환경에서는 원 operation만 호출한다. 새 helper와 설명을 더한 **r2 delta는 네 파일**이다. r1 supervisor 두 파일은 변경하지 않았다.

## 관측 결과

| 원 실패 대상 | candidate PID / starttime | baseline PID / starttime | 마지막 원 kill-zero |
| --- | --- | --- | --- |
| historical-wake client-ensure, 원421 / 계측422 | 43850 / 615224 | 44465 / 630962 | 모두 return, 같은 starttime, before/after Z, PPID1 |
| session-message profile relay, 원897 / 계측898 | 43686 / 612614 | 44048 / 617488 | 모두 return, 같은 starttime, before/after Z, PPID1 |
| packaged hook broker teardown, 원87/107 / 계측88/108 | 43722 / 614140 | 44084 / 619015 | 모두 return, 같은 starttime, before/after Z, PPID1 |

6개 대상 모두 distinct starttime은 하나다. 살아 있는 non-Z가 deadline 끝에 남은 경우나 starttime 변경은 관측되지 않았다. profile fixture의 prestarted direct-child broker는 candidate43653, baseline44015에서 ESRCH/ENOENT로 정상 회수됐다. 이 control의 ESRCH 자체를 원 실패의 원인이라고 해석하지 않는다. `evidence/fixture-lifecycle-classification.json`에 원 JSONL 파일명·행·최초 stat·최종 kill-zero와 각 분류가 있다. standalone analyze.py가 새 자료로 이 판정을 재생성한다. 이 결과는 독립 SOURCE 감사 또는 signed DiagnosisReport.v1 인증 결과가 아니다.

## 실제 실행·실패 보존

candidate에서 03은 다음 명령을 한 번 실행했다. exit1, 선택4개 중 **1 PASS / 3 FAIL**, 132개는 선택되지 않았다. source pin은 f791이다.

```text
pnpm exec vitest run tests/session-messaging/historical-wake.test.mjs tests/session-messaging/session-message.test.ts -t 'packaged CLI binds history|uses one plugin queue profile|keeps packaged hook and relay entrypoints' --maxWorkers=1
```

baseline의 04는 같은 명령을 시도했고 session-message의 두 선택 case를 한 번씩 실행했다. 두 원 FAIL과 대응 zombie를 기록했다. historical-wake worker는 test 시작 전에 MODULE_NOT_FOUND로 중단됐다. 제가 별도 pnpm source/bundle 검사를 병행하면서, 공유 node_modules를 pnpm이 재생성해 worker preload 파일을 없앤 실행 관리 오류다. 원 04 log에는 2 FAIL/69 not-selected와 worker error1이 남아 있으며 완전한 비교 run으로 재명명하지 않았다.

의존성은 그때부터 baseline 전용 local copy로 분리했다. candidate/base pnpm-lock SHA256은 같고 dependency-isolation-correction.json에 copy 방법과 preload pin을 기록했다. pnpm을 추가 실행하지 않고 아직 시작되지 않은 history 두 case만 07에서 실행했다. exit1, **1 PASS / 1 FAIL / 63 not-selected**다.

```text
node node_modules/vitest/vitest.mjs run tests/session-messaging/historical-wake.test.mjs -t 'packaged CLI binds history' --maxWorkers=1
```

baseline의 실제 실행된 선택4개를 합하면 1 PASS/3 FAIL이다. 이미 실행한 case의 동일 입력 재실행은 0이다. worker 시작 실패를 세 lifecycle FAIL에 합치지 않았다. 최초 분류 스크립트의 partial-run AssertionError와 manifest 작성 시 Git Unicode quoting 오류도 construction-corrections.json에 보존했다. 그 보정은 외부 증거 구성 스크립트에만 있다.

TMPDIR은 각 실행의 `/dev/shm/ags-cs-lifecycle-r2/<label>`, XDG/shared-state는 이 revision의 tool-state/<label>이다. 모든 command/cwd/시각/exit/fixture hash/environment는 evidence/commands.jsonl과 log 첫 JSON에 있다. subreaper와 DB observer는 껐다. fixture에서만 loopback broker와 임시 HMAC/P-256 key/token을 사용한다. 키값/본문/nonce는 관측하지 않았다. 임시 DB·키·node_modules·mutable tool-state는 ZIP에 넣지 않는다.

tsc --noEmit, lint, source:check, bundle:check, git diff --check, Git bundle verify는 PASS다. typecheck/lint는 commit 직전 현재 파일 hash로 실행했고 f791에 동일 bytes가 커밋됐다. 원 product bundle을 빌드로 덮지 않았다.

## 인수 경계

새 f791 전체 회귀는 **NOT_RUN**이다. r1의 supervisor 아래 136 PASS 및 914 PASS/0 FAIL/5 inherited SKIP는 **3b9c source pin의 별도 기록**이며 f791 PASS로 재사용하지 않는다. r2는 요청된 lifecycle 판별 관측이다. r1 supervisor가 zombie를 실제 waitpid로 회수해 기존 assertion을 통과시킨 결과와 함께 리드가 검토할 수 있다. 제품 broker/공통 계약 수정의 근거는 얻지 못했으므로 수정하지 않았다.

Windows의 다른 failure cluster를 합치거나 해결했다고 주장하지 않는다. Claude Cloud의 실제 runtime 실행도 없다. R042는 원4ba 선택 csstage의 전달된 정적 판정이며 r1/r2에 재사용하지 않는다. 새 SOURCE 감사는 NOT_RUN, official validator는 원 스크립트 부재 BLOCKED다. `docs/cs-engineering.md:23` 이후 signed1.1 전체 lifecycle CS binding·global acceptance/applicability NOT_IMPLEMENTED 경계는 유지한다.

원격 push/merge/tag/release, 사용자 설치·plugin cache·운영 DB/registry/키/계정/폴러/네트워크 설정 변경, 실사용자 세션 발신은 없다. 공개/설치/출시 권한도 없다. 실제 PEER relay 도구가 노출되지 않아 native callback으로 리드에게 회신한다. 새 Library/Drive delivery와 재다운로드 hash는 ZIP 생성 후 별도 receipt에 기록한다.
