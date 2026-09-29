# CASE=e9fix-f1-verify — reconcile F1 수정 후보 ab8e745 Linux 검증

- 대상: `ab8e7456c66364fe99ca344855defe8513fc1bd4` (codex/wake-history-reconcile), tree `a0176ddab500613da4c0b38bb2591459246aa41d` 확인. 부모 사슬 ab8e745 → b3c9a95 → e9b4c73 → 53eff30 확인(01-fetch, 90-final-status).
- 비교 기준(수정 전): `e9b4c73b2ff4294c68c6490411fbc6118c69c8c8`, tree `4316195bbb2cdade6efa1a62150e33358ef60a7c`. 2.7.1 상태 생성: `d5c5932cd5a0d87630f6ed94f8e3721181ab9864`.
- 환경: Linux cloud 컨테이너 1대(root), Node v24.21.0(SHASUMS256 검증 tarball), pnpm 11.19.0(corepack).
- **Linux cloud 한 환경에서 일회용 상태로 한 실험이다. 사용자 PC의 운영 상태나 live 증거가 아니다.** 모든 broker와 CLI는 가짜 HOME(/tmp 아래)으로 실행했다.
- 소스·테스트·설정은 바꾸지 않았다. 반증 단계에서 /tmp/e9에 테스트 patch를 잠시 얹었다가 되돌렸다(26-changed-tests.log 마지막 줄 0). 종료 시 fix/e9/v271 worktree와 원 checkout은 모두 clean이다(90-final-status.log). 90의 `processes left: 1`은 pgrep이 자기 자신을 센 것이다. 이후 `pgrep -af`로 확인했을 때 broker 프로세스는 없었다.
- 네트워크·서비스 실패(429/5xx)는 0건이다.

## 1. 명령별 exit (/tmp/fix, AGENTS.md 순서)

| # | 명령 | EXIT | 판정 | 비고 |
|---|---|---|---|---|
| 02 | `pnpm install --frozen-lockfile` | 0 | PASS | |
| 10 | `pnpm bundle:check` (빌드 전) | 0 | PASS | |
| 11 | `pnpm claude:drift` | 0 | PASS | `claude-plugin: fresh` |
| 12 | `pnpm claude:check` | 0 | PASS | |
| 13 | `pnpm lint` | 0 | PASS | |
| 14 | `pnpm build` | 0 | PASS | 빌드 뒤 `git status --porcelain` 0줄(15) |
| 16 | `pnpm test` 1회차 | 0 | PASS | 59 files passed, 1 skipped / 770 tests passed, 1 skipped |
| 17 | `pnpm test` 2회차 | 0 | PASS | 결과 동일. 테스트 뒤 dirty 0줄(18) |
| 23 | `pnpm test --reporter=json` 3회차(JSON 저장) | 0 | PASS | 771 tests: passed 770, failed 0, skipped 1 |
| 24 | `pnpm test --reporter=json` 4회차(JSON 저장) | 0 | PASS | 결과 동일 |
| 19 | `pnpm runtime:check` | 0 | PASS | `runtime: ready (29 skill CLIs, Node.js 24.21.0)` |
| 20 | `pnpm validate:all` | 0 | PASS | |
| 21 | `pnpm validate:official` | **1** | NOT_RUN(validator 부재) | `Error: ENOENT: no such file or directory, access '/root/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py'`. validator가 컨테이너에 없어 실행되지 않았다. 환경 실패로 분류한다 |
| 22 | `git diff --check` | 0 | PASS | |

- 16·17 회차에는 `pnpm test -- --reporter=json …`를 썼다. `--`가 vitest에 그대로 넘어가 JSON reporter가 무시됐다(16-test1.log 첫 줄 참조). 그래서 JSON 저장용으로 23·24를 추가로 실행했다. 전체 test는 모두 4회 실행했고 4회 모두 결과가 같다.
- 건너뛴 테스트(4회 모두 같음): `tests/session-messaging/previous-broker.test.ts` :: `preserves queued messages when new hooks meet the previous released broker`. `it.skipIf(!process.env.AGS_PREVIOUS_BROKER_PATH)` 조건 때문이며, 이전 릴리스 broker 경로를 주지 않았다. 판정: NOT_RUN.
- 실패한 테스트: 없음.

## 2. 반증 (변경 테스트만 수정 전 e9에 적용)

`git diff e9b4c73 ab8e745 -- tests`로 바뀐 파일은 `tests/session-messaging/historical-wake.test.mjs` 하나다(26-tests.patch). e9 worktree에 patch를 적용하고 그 파일만 실행했다(e9의 커밋된 dist 사용).

| 테스트 전체 이름 | e9b4c73 + 새 테스트 | ab8e745 |
|---|---|---|
| `packaged CLI binds history to explicit broker state directory: prestarted` | **failed** (`unrelatedProof` 기대 `{reconciled:false, evidence:null}`, 실제로는 evidence가 있는 reconciled 결과) | passed |
| `packaged CLI binds history to explicit broker state directory: client-ensure` | **failed** (같은 assertion) | passed |
| 같은 파일의 나머지 45개(목록은 29-counter-table.log) | passed 45 | passed 45 |
| 합계 | 47개 중 45 passed / 2 failed, EXIT=1 (27) | 47 passed, EXIT=0 (28) |

판정: PASS. 새 테스트는 수정 전 코드에서 실패하고 수정 후 코드에서 통과한다.

## 3. F1 실제 프로세스 재현 (e9 vs fix, 설치 트리 codex 루트·claude-plugin)

- 설치 트리는 `git archive <sha>`(codex)와 `git archive <sha>:claude-plugin`(claude)로 만든 `/tmp/inst/{e9,fix}/{codex,claude}`이며 node_modules는 0개다(30). fix broker 번들 sha 앞 16자리는 `5fafd04e8b8860b9`로 codex와 claude가 같다. e9는 `80c00e7b96dd3e4e`다.
- broker 실행: `env -i PATH HOME node <INST>/mcp-server/dist/session-message-broker.mjs --state-directory R`. `/proc/<pid>/environ`에서 `AGENT_GOVERNANCE_*` 키 0개를 확인했다. c2는 CLI가 자동 기동한 경우로, 상속된 STATE_DIR 1개만 있다.
- CLI 실행: `env -i PATH HOME AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR=R node <INST>/mcp-server/dist/session-message-cli.mjs`. `AGENT_GOVERNANCE_TRUST_DB_PATH`는 broker와 CLI 어디에도 지정하지 않았다. 내부 테스트 전용 ENV도 쓰지 않았다. 이 변수는 fixture 작성기 `seed.mjs` 프로세스 안에서 receipt를 쓸 위치를 정하는 데만 썼다(J2와 같은 방식).
- 기본 경로는 `D=$HOME/.agent-governance-suite/session-messaging`이다. "D 미접촉"은 broker 기동 전과 broker 종료 후의 D 파일 목록, 크기, sha256, inode, mtime·ctime(ns)이 같다는 뜻이다. 관측 과정은 DB를 제자리에서 열지 않고 scratch 복사본만 dump한다.
- 1차 시도(`attempt1-f1-harness-dump-touched-default/`)는 폐기했다. harness의 read-only dump가 D DB를 직접 열어 -shm/-wal을 만들고 mtime을 바꿨다. 그래서 fix에서도 "D 변경"이 거짓으로 나왔다. 수정한 harness의 최종 결과는 50–77 로그다. reconcile 결과(true/false) 자체는 두 시도에서 같다.

| 조건 | 설명 | 기대(지시) | e9 codex / claude | fix codex / claude | fix의 D | 판정(fix) |
|---|---|---|---|---|---|---|
| a1 | 유효 증거는 R/trust에, D에는 무관한 trust DB | true | false / false, **D에 -shm·-wal 생성** | **true → 재실행 false** / 같음 | 불변(sidecar 0) | PASS (e9 FAIL 재현) |
| a2 | 증거는 D에만, R에는 trust DB 없음 | false | **true** / **true**, D에 sidecar 생성 | false, false / 같음; R/trust도 생성 안 됨 | 불변 | PASS (e9 FAIL 재현) |
| a3 | R/trust는 있으나 원 receipt 없음(다른 key), 유효 원본은 D에만 | false | **true** / **true**, D에 sidecar 생성 | false, false / 같음 | 불변 | PASS (e9 FAIL 재현) |
| b | D 디렉터리 없음, 유효 증거는 R/trust에(J2 b 구성) | false, 생성 0 | false / false, D 생성 안 됨 | **true → 재실행 false** / 같음, D 생성 안 됨 | 없음 유지 | 생성 0: PASS. reconcile 결과: **기대(false)와 다름 → UNKNOWN**. 증거가 broker 결속 경로 R에 있으므로 true는 a1과 같은 정상 동작으로 보인다. J2는 e9의 b=false를 "가용성 FAIL"로 적었다. 지시의 기대값이 어떤 구성을 전제로 했는지 확인이 필요하다 |
| b0(추가) | trust DB가 어디에도 없음(R·D 모두) | false, 생성 0 | false / false | false, false / 같음; R/trust·D 모두 생성 안 됨 | 없음 유지 | PASS |
| c | R = D (기본 state) | true | true / true | true → 재실행 false / 같음 | (R=D라 broker가 씀, 비교 대상 아님) | PASS |
| c2 | CLI가 broker 자동 기동 | true | true / true | true → 재실행 false / 같음 | D 생성 안 됨 | PASS |

- 모든 사례에서 메시지 claim 0건, `input_observations` 0건이다. true인 사례에서 옛 wake 행은 `observed`, consumed가 설정되고, false인 사례에서는 `unknown`, consumed null이다(49-f1-table.md).
- 재실행: fix의 모든 true 사례는 2회차에 false다. PASS.
- 결론: F1(a1 false negative, a2·a3 false positive, 결속되지 않은 기본 경로 trust에 sidecar 생성)은 e9에서 두 설치 트리 모두 재현됐고, fix에서는 두 설치 트리 모두 재현되지 않았다.

## 4. E2 복구 재실행 (2.7.1 상태 → fix 공개 CLI)

- E 스크립트 `build-271-state.mjs`(E와 E2 사본이 같은 파일)로 /tmp/v271(d5c5932)에서 2.7.1 상태를 새로 만들었다(41). T1–T6 새 wake는 모두 false, T4 늦은 outcome 수락, T0 dispatch true로 E·E2와 같다. live snapshot을 3개로 복사했고 hash가 모두 같다(42).
- driver `run-fix.mjs`는 E2 `run-e9.mjs`를 바꾼 것이다. broker와 CLI는 설치 트리 `/tmp/inst/fix/*/mcp-server/dist`에서, client와 hook 합성 helper는 /tmp/fix src에서 가져온다.
- **dry-run·읽기 전용 reconcile은 코드에 없다.** CLI `OPERATIONS`는 prepare, send, claim, acknowledge, status, pending, wait, reconcile-wake-observation이고 broker case에도 해당 옵션이 없다. 그래서 dry-run은 NOT_RUN이다.

| 실행 | broker 형태 | T3 1차 | T3 2차 | 새 세대 뒤 T6 | T6 재적용 | T0/T1/T2/T4/T5 행(00→07 전체 열) | 잘못된 receipt(T1←T3 receipt) | T3 옛 attempt 늦은 outcome | 새 wake(T3·T6) | 판정 |
|---|---|---|---|---|---|---|---|---|---|---|
| 43 main (codex) | CLI 형태(env STATE_DIR=R) | true | false | true | false | 모두 UNCHANGED | false | `recorded:false` | 각각 reserve true 1회, 활성 중 2차 reserve false, claim 1건, replay 0건, claim 뒤 reserve false | PASS |
| 44 main-direct (codex) | **직접 기동, env에 STATE_DIR 없음(F1 형태)** | true | false | true | false | 모두 UNCHANGED | false | `recorded:false` | 같음 | PASS (e9에서는 이 형태에서 T3가 false였음, E2 f1a·f1b) |
| 45 main-direct (claude) | 같음 | true | false | true | false | 모두 UNCHANGED | false | `recorded:false` | 같음 | PASS |

- 2차 적용 no-op: 메시지 DB 논리 digest와 WAL sha가 03과 04에서 같다. 새 세대 2차도 05와 06에서 같다. PASS.
- T1, T2, T4, T5의 새 wake reserve는 false로 계속 막혀 있다. 도착 증거가 없으므로 설계상 유지되는 것이며 E2와 같다.
- trust 권위 데이터(key digest, schema)는 모든 snap에서 불변이다. receipt 수는 07에서 2개에서 4개로 늘었는데, driver가 새 wake hook 도착을 합성했기 때문이다(E2와 같음). 가짜 HOME의 기본 경로 D는 세 실행 모두 끝까지 생성되지 않았다(`defaultTrustDir: null`).

## 5. 경합 fuzz (seed 50 × 프로세스 4, fix codex 설치 트리)

- 방법: `fuzz.mjs`, `fuzz-seed.mjs`, `fuzz-child.mjs`. seed s = 0..49, 자식 PRNG seed = s*16+p (p = 0..3, mulberry32). seed마다 새 R과 가짜 HOME을 만들고 fixture를 둔다.
  - A: R/trust에 유효 receipt가 있는 late-unknown
  - B: receipt가 없는 late-unknown
  - C: receipt가 D에만 있는 late-unknown
  - T: 종료 행(submitted)
  - U: definite-failure 뒤 retry 대기 행
  - broker는 `env -i PATH HOME … --state-directory R`로 기동한다. 네 자식이 같은 시각에 시작해 무작위 순서로 연산 2–5개를 수행한다. 연산은 공개 CLI reconcile(A 정상, B·T·U에 A receipt, C는 D receipt), 세대 교체(presence-start와 acquire-relay), reserve-wake다.
  - 끝난 뒤 A–U 전체를 다시 reconcile(2차)하고 불변식을 검사한다.
- 결과(80, 81): **50/50 PASS**. 자식 오류 0, seed 오류 0.

| 불변식 | 통과 seed |
|---|---|
| 대상별 활성 행(reserved/started) ≤ 1 | 50/50 |
| 종료 행(T)과 U 행 전체 열 불변 | 50/50 |
| 근거 없는 unknown(B, C) 미해제 | 50/50 |
| B·C·T·U reconcile 전부 false | 50/50 |
| A reconcile true ≤ 1 (실측: 50 seed 모두 정확히 1) | 50/50 |
| A 행 상태와 true 횟수 일치 | 50/50 |
| 2차 실행 전부 false이며 DB 행 무변화 | 50/50 |
| 메시지 claim·delivery 0 | 50/50 |
| 기본 경로 D(C의 receipt DB) 파일 불변 | 50/50 |
| reserve-wake dispatch true ≤ 1 (0회 18 seed, 1회 32 seed) | 50/50 |

연산 분포: reconcile-A true 50 / false 142, B 74, C 59, T 53, U 36 (모두 false). gen-change 127, reserve true 32 / false 103.

## 6. 범위 밖 항목 관측

- **F2 (trust user_version 미검사): 관측됨, 미수정.** fix 설치 트리(codex, claude)에서 R/trust의 `PRAGMA user_version=99` DB로 reconcile을 실행하면 1차 `reconciled:true`, 2차 false가 나온다(82, `f2-observe.sh`). 수정 후보 범위 밖이므로 PASS로 적지 않는다. 판정: FAIL(관측, 범위 밖).
- **O1 (옛 세대의 늦은 definite-failure가 wake를 영구 차단): 직접 재현은 NOT_RUN.** 관련 상태는 관측했다. fuzz fixture U에서 definite-failure를 기록하면 행이 `reserved`(retry_count=1, instance-1)가 되고, 새 세대(instance-2) presence 뒤에도 그대로 활성으로 남는다(50 seed 모두 `activeCounts.fz-U=1`). 그 행이 U의 새 wake를 막는지는 시험하지 않았다. 판정: UNKNOWN.

## 7. NOT_RUN과 한계

- `pnpm validate:official`: validator 파일이 없어(ENOENT) 실행되지 않음.
- `previous-broker.test.ts`의 1건: `AGS_PREVIOUS_BROKER_PATH`가 없어 skip.
- dry-run reconcile: 진입점이 코드에 없음.
- O1 직접 재현, 실제 Codex·Claude host wake, 설치 캐시와 MCP(`tools/list`에는 reconcile 도구가 없다, J2), Windows: 이번 범위에서 실행하지 않음.
- hook 도착은 `adaptHostInput`와 `recordWakeHookObservation`으로 합성했다.
- 키 비공개: trust.sqlite3(-wal/-shm), HMAC key, broker-key.pem, broker.token은 evidence에 넣지 않았다. DB 바이너리도 넣지 않았다. 로그에는 sha 앞 16자리, id, 시각, key 이름과 길이만 있다.

## 재현
```
. /tmp/env.sh  # Node 24.21.0
/tmp/ev/scripts/run-validation.sh                                 # 1단계 (+ JSON: pnpm test --reporter=json --outputFile=…)
git -C /tmp/e9 apply 26-tests.patch; (cd /tmp/e9 && pnpm exec vitest run tests/session-messaging/historical-wake.test.mjs)
scripts/f1.sh <e9|fix> <codex|claude> <a1|a2|a3|b|b0|c-same|c2> <log>; node scripts/f1-table.mjs
cd /tmp/v271 && HOME=<fake> AGENT_GOVERNANCE_TRUST_DB_PATH=/tmp/state-271/trust.sqlite3 node --import tsx scripts/build-271-state.mjs /tmp/v271 /tmp/state-271
cd /tmp/fix && node --import tsx scripts/run-fix.mjs /tmp/fix /tmp/inst/fix/codex /tmp/state-fix-direct main-direct <fakeHome> /tmp/state-lookup/trust.sqlite3
cd /tmp/fix && node scripts/fuzz.mjs 0 50 /tmp/inst/fix/codex
```

## 부록: 로그 가공
- 43–45 로그에서 driver가 새로 만든 wake nonce 원문(`"nonce":"e9-…"`) 14건씩을 `"nonce":"<앞 6자>…[REDACTED]"`로 바꿨다. 행 dump는 원래 앞 10자와 길이만 남긴다. 스크립트에 있는 고정 fixture nonce 문자열(`history-nonce-…`, `unrelated-nonce-…`, `fuzz-nonce-…`)은 재현용 상수로 남겼다.
- 로그에 나오는 `trust-signing-key`는 key 이름과 길이만이며 값은 없다.
