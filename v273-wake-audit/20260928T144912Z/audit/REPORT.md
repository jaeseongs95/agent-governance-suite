# AGS 2.7.3 wake-liveness 독립 감사 보고서

- 감사 대상(후보): `claude/v273-wake-liveness` = `e739090952710d418a67dae71d76b1f2ef169441` (tree `f3bfdf1be77a6e857c595dacb9231402f86974a9`)
- 기준: `8763cef2b11f2635d6c9af7861b5bffd496e2a30` (main, tag `v2.7.2`, tree `eed08f96…`)
- 감사자: 후보를 만든 세션과 분리된 독립 감사 세션. 제품 소스는 고치지 않았다. 아래 감사용 테스트·하네스는 이 evidence 브랜치에만 있다.
- 환경: Linux cloud 컨테이너 1대, Node v24.21.0, pnpm 11.19.0 (`meta.json` 참고)
- 구현 세션 evidence `claude/evidence-v273-wake-liveness-20260928T141526Z`(534f52b)의 REPORT.md는 대조용으로만 읽었다. 판정은 이 감사에서 직접 재현한 결과만 근거로 한다.

## 최종 판정: **ACCEPT_WITH_FINDINGS**

blocker와 major는 없다. minor 6건(F1~F6)은 모두 재현 근거가 있다. 요구 A~G의 핵심 불변조건은 모두 직접 시험으로 확인했다. 퇴역 조건 두 가지가 함께 있어야 한다는 점, 한 번만 새 attempt를 예약한다는 점, observed로 바뀌지 않는다는 점, 이관과 하향 호환이 여기에 들어간다.

## 항목별 결과

| # | 항목 | 결과 | 핵심 근거 |
|---|---|---|---|
| 1 | 퇴역 조건의 정확성 | PASS | `mcp-server/src/session-message-store.ts:314-324`, 감사 테스트 1a~1i (`logs/audit-retire.log`) |
| 2 | 멱등성과 중복 wake | PASS (F1 minor) | `session-message-store.ts:1015-1035`, 감사 테스트 2a~2d, 다중 프로세스 R1~R3 10회·40회 (`logs/audit-race*.log`) |
| 3 | 기존 테스트 변경의 정당성 | PASS | 아래 표. 검증을 약하게 만든 변경 없음 |
| 4 | 이관과 하향 호환 | PASS | 실제 v2.7.2 코드로 만든 DB 이관, v2.7.2/v2.7.1/v2.2.6 태그 dist broker, SIGKILL 30회 (`logs/upgrade-*.json`, `logs/previous-broker-*.log`, `logs/crash-migration.log`) |
| 5 | advisory 신호(B·C) | PASS (F3 minor) | `contracts/session-auto-wake-outlook.v1.schema.json`, `mcp-server/src/server.ts:538,550`, 감사 테스트 5a·5b |
| 6 | K와 C2 재현 | PASS | 기준 코드에 후보 테스트 적용: C2와 K 모두 기준에서 동작 실패, 후보에서 통과 (`logs/base-with-candidate-wake-liveness-test*.log`) |
| 7 | 벤더 비종속 | PASS (F4 minor) | store·broker·service·contract의 추가 줄에 벤더 이름 0건. 새 `host === "codex"` 분기 1건은 hook에 있음(`session-message-hook.ts:211`) |
| 8 | 전체 검증 재실행 | PASS, validate:official만 FAIL_UNRELATED(환경) | `logs/full-summary.tsv`, `logs/full-*.log` |
| 8b | korean-prose-cycle-receipt flaky 판정 | 재현 안 됨(단독 20/20, 전체 병렬 6/6 통과). 변경과 무관, 원인 UNKNOWN | `logs/flaky-korean-receipt.log`, `logs/full-suite-repeat.log` |
| 9 | 생성물 일치 | PASS | build·claude:build 후 `git status --porcelain` 빈 출력 (`logs/full-post-status.txt`), bundle:check·claude:check `fresh` |
| 10 | 문서 | PASS (F2·F3·F5 minor) | `docs/session-message-lifecycle.md` 대조 |

## 1. 퇴역 조건의 정확성 — PASS

구현: `retireUnobservedWakes`(`session-message-store.ts:314-324`)는 UPDATE 한 문장이다. 대상은 `state IN (reserved, started, submitted, unknown)`이고 `expires_at <= now - 10분`인 행이다. 여기에 (a) 같은 host·session의 `session_activity.active_at > expires_at`이 있거나, (b) 최신 presence가 끝나지 않았고 lease가 유효하며 `started_at > birth_generation`일 때만 퇴역시킨다. `prune()`(`:292-307`)에서 호출된다. `reserveManagedWake`에서는 `BEGIN IMMEDIATE` 안에서 prune과 새 예약이 한 transaction으로 일어난다(`:841-893`).

직접 시험(`tests/audit/audit-retire.test.mjs`, 후보에서 18/18 통과):

| 시험 | 조건 | 결과 |
|---|---|---|
| 1a | 만료만(같은 세대, relay live, 활동 없음). 만료+유예, +1ms, +1일, +7일 | 새 wake 없음, `submitted` 유지, outlook `latched` |
| 1b | 세대 교체만(만료 전). 만료-1ms, 만료, 만료+1ms, 만료+유예-1ms | 새 wake 없음. 정확히 만료+유예에서 처음 퇴역하고 예약 1건 |
| 1c | ACK만(만료 전 ACK). +유예, +1일 | 새 wake 없음 |
| 1c2 | 만료 뒤 ACK, 유예 전 조회 | 없음. 유예가 지나면 1건 |
| 1d | relay 재시작만(새 relayId, 이전 lease 만료, 같은 presence birth), 만료 전·후·+1일 | 새 wake 없음. `session_activity` 0행(relay tick은 활동이 아님) |
| 1e | 다른 세션, 또는 같은 sessionId의 다른 host가 활동 | 근거로 쓰이지 않음 |
| 1f | 더 새 세대이지만 lease가 끊김(unreachable) | 근거로 쓰이지 않음 |
| 1g | 두 조건 모두. 두 연결에서 reserve 20회 | attemptId 1개, 활성 행 1개, 퇴역 행 1개 |
| 1h | W1을 퇴역시킨 활동이 다음 W2에 이월되는가 | 이월되지 않음(W2는 자기 만료 뒤 활동이 필요) |
| 1i | 퇴역 행을 observed로 바꾸는 공개 경로 | 없음. outcome 3종·start·검증된 늦은 도착·reconcile이 모두 거절하고 행은 `expired-unobserved`, `observed_at`·`consumed_at`은 null |

코드 확인: state를 `observed`로 쓰는 UPDATE는 세 곳이다(`:985`, `:1028`, `:1042`). `:985`는 `state='unknown'`, `:1028`은 `state IN ('started','submitted','unknown')`만 대상으로 한다. `:1042`는 `valid` 경로에서만 실행되고 `valid = !retired && …`이다(`:1021`). 퇴역 행에서 나가는 전이는 없다. `recordManagedWakeOutcome`는 `state IN ('started','unknown')`(`:927`), `startManagedWake`는 `state='reserved'`(`:901`)만 받는다. status의 `deliveryState`는 퇴역 행에서 `unknown`을 유지한다(`:951`).

## 2. 멱등성과 중복 wake — PASS (F1)

- 2a: 퇴역 nonce가 3번 늦게 도착해도 `{recognized:false, messages:[], binding:null, retired:true}`이고 messages 표는 바뀌지 않았다. `late_observed_at`은 첫 도착 시각으로 한 번만 기록된다.
- 2c: 같은 prune과 같은 활동을 10번 되풀이해도 `retired_at`은 처음 값을 유지하고, 새 attempt는 1개다.
- 2d: 늦은 도착이 prune보다 먼저 commit되는 순서에서는 행이 `observed`가 된다(실제 도착 증거, 2.7.2 규칙). 본문은 claim하지 않고, 이어서 새 wake 1건이 예약된다.
- 다중 프로세스(`tests/audit/audit-race.test.mjs`, 독립 child-process 하네스 `tests/audit/fixtures/audit-race-worker.mjs`):
  - R1: relay 프로세스 6개가 퇴역 조건이 갖춰진 DB에서 동시에 reserve→start→effect를 한다. 10회와 40회 반복 모두 effect 파일에 1줄, 활성 행 1개, 퇴역 행 1개였다.
  - R2: 늦은 도착 프로세스와 relay 프로세스가 경합한다. 10회와 40회 모두 옛 nonce가 본문을 claim하지 않았고, effect는 1개 이하였다. 관측된 순서는 "퇴역이 먼저"뿐이었다. 반대 순서는 2d에서 결정적으로 시험했다.
  - R3: 별도 프로세스가 활동을 commit한 뒤 relay 4개가 경합한다. 10회와 40회 모두 effect 1개였다.
- 후보 자체 테스트 `two independent relay processes racing retirement…`는 dispatch만 보고 effect 수는 보지 않는다. 감사 R1이 effect 수까지 확인해 이 빈자리를 채웠다.

## 3. 기존 테스트 기대값 변경 — PASS

`git diff 8763cef..e739090 -- tests/`에서 기존 기대값이 바뀐 곳은 아래 4곳뿐이다. 삭제된 테스트나 assertion은 없다.

| 위치 | 변경 | 판정 |
|---|---|---|
| `tests/session-board/session-board.test.ts:365` | 미등록 세션 presence `toEqual`에 `autoWake` 필드 추가 | 정당. 새 필드를 정확한 값으로 요구하므로 오히려 강화 |
| `tests/session-messaging/message-lifecycle.test.ts:101` | duplicate receipt `toEqual`에 `autoWake: {...first.autoWake, checkedAt: 3000}` 추가 | 정당. receipt 필드는 그대로 엄격히 비교한다. `autoWake`는 호출마다 새로 만드는 advisory라 `checkedAt`만 정확한 새 시각으로 바꿨다 |
| 같은 파일 `:110` | prune 뒤 duplicate에 같은 방식 적용 | 정당(위와 같음) |
| 같은 파일 `:210`, `:253` | 실제 broker·CLI 재전송 비교에서 `autoWake.checkedAt`만 `expect.any(String)` | 정당. 별도 프로세스의 현재 시각이라 정확한 값을 고정할 수 없다. 나머지 필드는 엄격 비교 |
| `tests/session-messaging/previous-broker.test.ts` | 기존 테스트는 바뀌지 않았고 새 테스트만 추가. `managedWakeAware` 분기 | 정당. v2.7.2와 v2.7.1 dist의 capability에는 `delivery-capabilities`가 있어 엄격 분기(행이 완전히 같아야 함)를 탄다. v2.2.6 dist의 prune은 `DELETE FROM wake_nonces WHERE expires_at <= ?`로 상태와 무관하게 지우는 기존 동작이다. 그래서 "그대로 있음 또는 삭제"만 허용하고 변형은 허용하지 않는다 |

fixture(`managed-wake-process.mjs`)는 `rebuild-failure`, `open-only`, `retire-then-exit` 모드만 추가했고 기존 모드는 바꾸지 않았다.

## 4. 이관과 하향 호환 — PASS

- 상향(실제 v2.7.2 코드로 만든 DB): 기준 worktree의 v2.7.2 store 코드로 managed 행 5개(reserved·started·submitted·unknown)와 본문이 든 DB를 만들었다(`harness/make-v272-db.ts`). 후보로 열자 `user_version` 0→1, 행 수와 rowid 포함 행 digest(`ed333d34…`)·messages·presence digest가 모두 같았다. CHECK에 `expired-unobserved`가 추가됐고 `retired_at` 열과 `session_activity` 표가 생겼으며 `integrity_check`는 ok였다. 이관만으로 행 상태는 바뀌지 않았다(`logs/upgrade-before.json`, `upgrade-after-open.json`, `upgrade-after-prune-plus5h.json`). 후보 테스트는 v2.7.2 schema를 손으로 만들지만, 이 감사는 실제 v2.7.2 코드로 만든 DB로 확인했다.
- 이관 중 crash: 400,005행 DB의 이관(중단 없이 약 2.4초)을 시작 후 무작위 0.4~1.5초에 SIGKILL로 30번 끊었다. 매번 `integrity_check` ok, 행과 digest가 같았다. 29번은 version 0과 옛 schema, 1번은 version 1과 새 schema로 일관됐다(반쯤 된 상태 0건). 다시 열면 30번 모두 version 1로 수렴했고 행이 같았다(`logs/crash-migration.log`). 한계: kill 시점이 rebuild 문장 한가운데였는지는 계측하지 않았다.
- 하향(새 DB를 이전 broker로 사용): 태그 `v2.7.2`, `v2.7.1`, `v2.2.6`의 `mcp-server/dist`를 `git archive`로 추출했다. `AGS_PREVIOUS_BROKER_PATH`로 `previous-broker.test.ts`를 돌려 세 버전 모두 2/2 통과했다(`logs/previous-broker-v*.log`).
- 추가 왕복: 후보가 퇴역시킨 v1 DB에서 v2.7.2 store 코드로 새 presence, relay, reserve, +2h prune을 했다. 퇴역 행은 활성으로 보지 않았고 새 reserved가 생겼으며 version 1은 유지됐다. 이 DB를 후보로 다시 열어도 변화 없이 열렸고 `integrity_check`는 ok였다. v2.7.2는 `expired-unobserved`를 prune하지 않으므로 그 행은 후보가 다시 열 때까지 남는다. 정보 사항이며 결함은 아니다.
- 더 높은 `user_version`은 거절하고 DB를 바꾸지 않는다(후보 테스트 `G: a newer message schema version…` 통과).

## 5. advisory 신호(B·C) — PASS (F3)

- `send_session_message` 설명(`server.ts:538`)은 "broker queued …, not that the recipient received it", "not delivery, completion or permission evidence"라고 적는다. status 설명(`:550`)도 같은 취지다. schema는 `authorityEffect: const "none"`, `additionalProperties: false`다.
- 감사 5a: `submitPrepared`, `status`, `listPresence`의 모든 `autoWake`가 schema를 통과했다. `authorityEffect: "delivered"`나 추가 필드 `delivered`는 schema가 거절했다. send 결과의 키는 `messageId, createdAt, expiresAt, duplicate, autoWake`뿐이다.
- 전달 증거로 쓰이는 문구나 필드는 찾지 못했다. ACK된 행의 status는 `autoWake: null`이다.
- F3: 옛 세대 알림이 아직 주입 만료 전이어도 `latched/wake-unobserved`로 보고되고, 이때 `basisAt`은 미래다. schema 설명과 문서 표의 정의("passed its injection expiry")와 맞지 않는다.

## 6. K와 C2 — PASS

- 기준 worktree(8763cef)에 후보의 `wake-liveness.test.mjs`와 fixture만 복사해 실행했다.
  - 그대로 실행: 26개 모두 실패. 대부분은 기준에 없는 export `WAKE_RETIRE_GRACE_MS` 때문에 `RangeError: Invalid time value`로 실패해 동작 재현이 아니다(`logs/base-with-candidate-wake-liveness-test.log`). C2는 여기서도 `ok(reborn.startedAt > old.generation)`에서 실제 동작으로 실패했다.
  - 상수 10분만 테스트 안에 넣고 실행: 24개 실패, 2개 통과(`logs/base-with-candidate-wake-liveness-test-grace-inlined.log`).
    - K는 `:215`의 `assert.equal(next.dispatch, true)`에서 `false !== true`로 실패한다. 만료 뒤 활동이 있어도 기준 코드는 새 wake를 영구히 막는다.
    - C2는 같은 ms 재탄생의 `startedAt`이 이전 birth와 같아 실패한다.
- 후보에서는 같은 파일이 26/26 통과했다(전체 test 로그).
- 감사 C2 fuzz: 무작위 birth 2000개에서 같은 ms와 5ms 이른 재탄생이 모두 정확히 이전+1ms를 받았다(부동소수 반올림 오류 0건).

## 7. 벤더 비종속 — PASS (F4)

- `git diff -U0`의 추가 줄 기준으로 store, broker, service, server와 `contracts/`에 codex, claude, openai, anthropic 문자열은 0건이다. 퇴역 정책, outlook, schema 이관은 공통 store가 소유한다(요구 F 충족).
- 벤더 차이는 transport capability(`deliveryCapabilities.idleWake`, `supportedInjection`)로만 outlook에 반영된다(`session-message-store.ts:499-500`).
- 새 벤더 분기는 `session-message-hook.ts:211`의 `host === "codex"` 1건이다. 퇴역 marker를 차단하는 분기로, `:206`의 기존 패턴을 따른다. hook 경계 안이라 허용 범위이지만 capability가 아닌 제품명 분기다(F4).

## 8. 전체 검증 재실행 — PASS (validate:official만 FAIL_UNRELATED)

별도 worktree(`e739090` detached)에서 지정 순서대로 실행했다(`harness/run-full.sh`).

| 순서 | 명령 | 종료 코드 | 로그 |
|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | 0 | `logs/full-01-install.log` |
| 2 | `pnpm bundle:check` | 0 | `logs/full-02-bundle-check.log` |
| 3 | `pnpm claude:drift` | 0 (`claude-plugin: fresh`) | `logs/full-03-claude-drift.log` |
| 4 | `pnpm lint` | 0 | `logs/full-04-lint.log` |
| 5 | `pnpm build` | 0 | `logs/full-05-build.log` |
| 6 | `pnpm test` | 0 (파일 60 통과·1 skip, 테스트 838 통과·2 skip) | `logs/full-06-test.log` |
| 7 | `pnpm runtime:check` | 0 (29 skill CLI) | `logs/full-07-runtime-check.log` |
| 8 | `pnpm validate:all` | 0 | `logs/full-08-validate-all.log` |
| 9 | `pnpm validate:official` | 1, **FAIL_UNRELATED(환경)**: `validate_plugin.py` ENOENT(Codex validator 미설치) | `logs/full-09-validate-official.log` |
| 10 | `pnpm claude:build` | 0 | `logs/full-10-claude-build.log` |
| 11 | `pnpm claude:check` | 0 (`fresh`) | `logs/full-11-claude-check.log` |
| 12 | `git diff --check` | 0 | `logs/full-12-diff-check.log` |

skip 2개는 `previous-broker.test.ts`의 env 조건부 테스트이며, 항목 4에서 세 broker로 따로 실행했다.

### 항목 8b. `korean-prose-cycle-receipt` "rejects a label leaked into the independent adjudicator input"

판정: **기존부터 있던 부하 의존 flaky로 추정(원인 미확인). 이번 변경과는 관련이 없다고 판단한다.**

- 단독 반복: 기준(8763cef)과 후보(e739090)에서 `-t`로 이 테스트만 각각 10회 실행했다. 기준 10/10, 후보 10/10 통과(`logs/flaky-korean-receipt.log`).
- 부하 반복: 전체 suite(병렬)를 기준과 후보에서 각각 3회 실행했다(`logs/full-suite-repeat.log`, `logs/full-suite-repeat-runs/`). 이 테스트는 6회 모두 통과했다(실패 0/6). 이 감사의 공식 `pnpm test`(항목 8)에서도 통과했다. 재현하지 못했다.
- 부하 반복의 부수 결과: 매 실행에서 `tests/tooling/commands.test.mjs > forwards pnpm script arguments…`가 기준과 후보 양쪽에서 똑같이 실패했다. 이 테스트는 `pnpm test` lifecycle 환경(`npm_execpath`)을 전제로 하는데, 반복 하네스는 `pnpm exec vitest`(1차 시도는 `npx vitest`, `logs/full-suite-repeat-npx-attempt.log`)로 실행했다. 그래서 생긴 하네스 부산물이다. 공식 `pnpm test`에서는 통과했으므로 finding이 아니다.
- 관련성: 실패 지점은 `scripts/record-korean-prose-run.ts`를 자식 프로세스로 실행한 종료 코드다(구현 세션 로그 `15-pnpm-test.log`, `:230`). 이 스크립트가 이번 diff와 닿는 곳은 `ContractValidator`(`mcp-server/src/schema-validator.ts`) import뿐이며, 변경은 schema 1개를 추가로 결정적으로 로드하는 것이다. 결정적 결함이라면 단독 20회에서 재현됐어야 한다. 구현 세션의 실패 때 stderr가 남지 않아 근본 원인은 확인할 수 없다(UNKNOWN). 이 finding은 blocker로 올리지 않는다.
- 권장(정보): `runScript` 실패 때 stderr를 assertion 메시지로 남기도록 테스트를 바꾸면 다음 재발 때 원인을 볼 수 있다.

## 9. 생성물 일치 — PASS

항목 8 순서에서 `pnpm build`(dist 재생성)와 `pnpm claude:build`(claude-plugin 재생성) 뒤 `git status --porcelain`과 `git diff --stat`이 모두 빈 출력이었다(`logs/full-post-status.txt`, `logs/full-post-diffstat.txt`). 따라서 커밋된 `mcp-server/dist`, `claude-plugin/`은 소스 build 결과와 바이트 단위로 같다. `bundle:check`와 `claude:check`도 통과했다.

## 10. 문서 — PASS (F2·F3·F5)

`docs/session-message-lifecycle.md`의 상태도에 있는 `reserved|started|submitted|unknown → expired_unobserved`와 `expired_unobserved → expired_unobserved`(late만 기록), 퇴역 두 조건, 유예 10분(= `wakeBackoffDelay` 상한 10분, hook timeout 8초, receipt TTL 30초와 일치), `retired_at` 보관 기산, C2 +1ms, schema 1 이관, 이전 broker 동작은 코드와 일치한다. 불일치나 누락은 F2, F3, F5로 적는다.

## Findings

### F1 (minor) 퇴역 nonce와 현재 nonce가 한 prompt에 섞이면 현재 attempt가 본문 없이 observed가 되고 Codex prompt가 차단된다

- 위치: `mcp-server/src/session-message-store.ts:1020-1035`, `mcp-server/src/session-message-hook.ts:211`
- 재현: 감사 테스트 `2b`. W1 퇴역 후 W2가 submitted인 상태에서 `[wake:W1]\n[wake:W2]`를 검증된 receipt로 claim한다. 결과는 `{recognized:false, messages:[], retired:true}`이고, W2는 `state:'observed'`, `late_observed_at` 기록, 본문 pending 1이다. hook 조건상 Codex는 이 prompt를 차단한다. 이어서 W3는 곧바로 예약 가능하다(`AUDIT-2b-next {"w3dispatch":true}`).
- 영향: 본문은 잃지 않지만 wake가 한 번 더 필요하고 전달이 늦어진다. 현재 세대의 실제 도착이 "late"로 기록되는 오해 소지 있는 증거가 남는다. 실제 Codex queue가 여러 follow-up을 한 prompt로 합치는지는 확인하지 못했다(NOT_RUN).
- 권장: 퇴역 행은 late만 기록하고 판정에서 빼서, 나머지 행이 현재 세대로 valid이면 claim하게 한다. 또는 적어도 섞인 경우에는 `retired` 차단을 적용하지 않는다. 해당 시험을 추가한다.

### F2 (minor, 설계·문서) 한 turn이 길게 바쁠 때 도구 경계 활동이 약 70분마다 in-flight 알림을 퇴역시켜 host queue에 marker가 쌓일 수 있다

- 위치: `session-message-store.ts:318-319`(활동 근거), `:558`(claimDeferred 활동 기록), 문서 "보장과 남은 조건"과 "거절한 대안"
- 재현: 감사 테스트 `LT`. 한 turn이 끝나지 않은 채 도구 경계 claim·ACK와 새 메시지가 반복되면, 약 4.8시간 동안 marker 4개가 제출된다(`AUDIT-LT markers queued …: 4`).
- 영향: 요구 A가 명시적으로 허용한 "만료 뒤 활동" 근거에서 나오는 결과다. Codex에서는 늦게 도착한 퇴역 marker가 차단되므로 비용은 보이는 알림이다. 그러나 문서의 "잔여 marker 최대 1개"와 "만료만으로 해제: … 새 알림을 쌓는다"(거절 이유)는 선택한 규칙에서도 한 turn 안에서 비슷하게 누적될 수 있다는 점을 드러내지 않는다.
- 권장: 문서에 "세션이 활동하는 동안 (주입 TTL+유예)마다 최대 1개" 상한을 명시한다. 원하면 idle을 뜻하는 활동(turn-end, 일반 사용자 입력, SessionEnd)만 근거로 인정하고 도구 경계 claim은 빼는 방안을 검토한다.

### F3 (minor, 계약 문구) `latched`의 정의와 실제 출력이 다르다

- 위치: `session-message-store.ts:506-510`, `contracts/session-auto-wake-outlook.v1.schema.json:18`, 문서 표 `latched` 행
- 재현: 감사 테스트 `5b`. 새 세대가 떴고 옛 세대 알림은 만료 전일 때 출력은 `{"state":"latched","reason":"wake-unobserved","basisAt":"<미래 expires_at>"}`이다.
- 영향: advisory라 권한 영향은 없다. 다만 "기한을 넘겼다"는 설명과 달리 `basisAt`이 미래다. 새 wake가 막혀 있다는 점에서 `latched` 판단 자체는 타당하다.
- 권장: schema와 문서 설명을 "이전(현재 세대가 아니거나 만료된) 알림이 새 wake를 막고 있다"로 고친다. 또는 현재 세대가 아닌 경우의 reason을 따로 둔다.

### F4 (minor, 벤더 비종속) 새 Codex 전용 차단이 공용 hook 처리기의 제품명 분기로 들어갔다

- 위치: `mcp-server/src/session-message-hook.ts:211`(신규). 같은 패턴은 `:206`에 이미 있다.
- 영향: 공통 store와 계약은 중립이다. 다만 AGENTS.md의 "호스트 이름은 확장 가능한 식별자, 제품별 동작은 adapter 경계" 원칙에 비춰 보면, 새 호스트가 같은 차단을 쓰려면 이 파일을 고쳐야 한다.
- 권장: host delivery profile(`host-input-adapter.ts`)에 `blocksEmptyWakePrompt` 같은 capability를 두고 `:206`, `:211`을 그것으로 바꾼다.

### F5 (minor, 문서) 활동 근거의 출처가 문서보다 넓다

- 위치: `session-message-hook.ts:150`(SessionEnd의 `clear-deferred`), `session-message-store.ts:584-592`, `mcp-server/src/session-message-cli.ts:9`(hook 없는 CLI의 `claim`·`acknowledge`는 임의 target을 받음)
- 영향: 문서의 활동 목록에는 "turn-end claim과 정리"만 있다. SessionEnd 정리와 CLI 호출도 퇴역 근거가 된다는 점, 같은 OS 사용자의 아무 프로세스가 CLI로 다른 세션의 퇴역 근거를 만들 수 있다는 점은 적혀 있지 않다. 신뢰 경계(같은 사용자)는 기존 문서에 일반론으로만 있다.
- 권장: 활동 목록에 SessionEnd와 CLI를 명시하고, 근거의 provenance 수준(비권위, 같은 사용자)을 한 줄 덧붙인다.

### F6 (minor, 정보) 읽기 도구가 쓰기를 한다

- 위치: `session-message-store.ts:1151`(`listPresence`가 새로 `prune` 호출), `:616`(status의 prune은 기존 동작)
- 영향: `list_session_status`와 `readOnlyHint: true`인 `get_session_message_status`가 퇴역 UPDATE와 만료 행 삭제를 일으킨다. 정확성 문제는 아니고 멱등이다. 다만 annotation과 기대가 어긋나며, 2.7.2에서는 board 조회가 쓰기를 하지 않았다.
- 권장: 문서에 "조회도 prune과 퇴역을 일으킬 수 있다"를 명시하거나, outlook 계산을 prune 없이 조건식으로만 평가한다.

## 릴리스 노트용 사용자 영향(관찰 가능한 변화)

1. 도착 증거가 없는 wake(submitted·unknown·started·reserved)가 더 이상 세션의 자동 wake를 영구히 막지 않는다. 주입 만료(1시간)에 유예 10분이 지나고, 새 세션 세대가 살아 있거나 만료 뒤 그 세션의 활동(claim, 도구 경계, turn-end·SessionEnd 정리, ACK, 일반 입력, 검증된 wake 도착)이 있으면, 다음 prune에서 `expired-unobserved`로 퇴역하고 새 wake가 한 번 예약된다. 퇴역은 도착이나 성공으로 기록되지 않는다(`deliveryState: unknown` 유지).
2. `wake-status`와 메시지 status의 `wake`에 `state: "expired-unobserved"`, `observation: "expired-unobserved"`, `retiredAt`이 새로 나타날 수 있다.
3. `send_session_message` 결과, `get_session_message_status`의 미ACK 큐 행, 세션 현황판 presence에 advisory `autoWake`(`available | latched | no-live-relay | unsupported`, reason, basisAt, checkedAt, `authorityEffect: "none"`)가 추가된다. 전달·완료·승인 증거가 아니다. 이전 broker와 연결되면 `null`이다.
4. relay가 없거나 presence가 끊긴 세션은 `autoWake.state = "no-live-relay"`로 표시된다. 재부팅 뒤 아직 turn이 없는 Codex 세션도 여기에 해당하며, 메시지는 큐에 남는다.
5. Codex에서 이미 퇴역한 wake marker가 늦게 도착하면 hook이 `decision: block`으로 빈 모델 turn을 막는다. host 화면에는 marker가 한 번 보일 수 있다. Claude는 기존 fail-open 동작을 유지한다.
6. 같은 ms에 다시 태어난 presence는 이전 birth+1ms 세대를 받는다. 이전 세대 nonce가 현재 세대 본문을 claim하지 못한다(C2).
7. 메시지 DB가 처음 열릴 때 `PRAGMA user_version` 0→1로 한 번 이관된다. `wake_nonces`를 재구성하고 `session_activity` 표를 추가하며, 모든 행은 보존된다. 더 높은 version의 DB는 거절된다. v2.7.2, v2.7.1, v2.2.6 broker는 이관된 DB를 계속 사용할 수 있다(v2.2.6은 만료 nonce를 기존처럼 삭제).
8. 세션 현황판 조회(`list_session_status`)가 이제 만료 정리(prune)와 퇴역을 일으킬 수 있다(F6).
9. 알려진 한계: 한 turn이 길게 바쁘고 그동안 도구 활동이 있으면 약 70분마다 marker가 하나씩 더 쌓일 수 있다(F2). 퇴역 nonce와 현재 nonce가 한 prompt에 섞이면 본문 전달에 wake가 한 번 더 필요하다(F1).

## NOT_RUN과 이유

- Windows(Node 24) 전체 검증: NOT_RUN. 이 감사는 Linux cloud 한 환경이다.
- 실제 Codex와 Claude host에서의 wake 주입·관측, host queue 병합 동작(F1 실제 빈도): NOT_RUN. host 실행 환경이 없다.
- 실제 PC 설치 캐시와 marketplace 설치, 설치된 MCP 동작: NOT_RUN. 이 감사 범위 밖이고 설치 환경이 없다.
- `pnpm validate:official`: 실행했으나 FAIL_UNRELATED(환경, Codex validator 미설치). PASS로 세지 않는다.
- 이전 broker와 새 broker가 같은 DB에서 동시에 도는 혼합 운용: NOT_RUN. 문서가 범위 밖으로 둔다.
- 이관 SIGKILL이 rebuild 문장 한가운데에 떨어졌는지의 정밀 계측: NOT_RUN(무작위 시점 30회로 대신함).

## 가림(redaction)

push 전에 `harness/redact.py`로 evidence 트리의 모든 텍스트 파일을 검사했다. 걸린 값만 바꿨고 건수는 `meta.json`의 `redaction`에 있다. 대상은 GitHub·Anthropic·AWS 토큰 형태, private key 줄, Bearer 헤더, 이메일(커밋 trailer용 `noreply@anthropic.com`은 제외), 사용자 이름이 들어간 홈 경로(`/home/<name>` → `/home/[REDACTED]`), root 홈 경로(→ `/[REDACTED-HOME]`), IPv4 주소다. `env`·`printenv` 출력은 수집하지 않았다. 가린 건수는 홈 경로 27건, root 홈 경로 6건이며 나머지 규칙은 0건이다(`meta.json`). 두 번째 검사에서는 0건이었다. 하네스 스크립트 안의 작업 경로도 가려졌으므로, 다시 실행하려면 `/home/[REDACTED]`를 실제 작업 디렉터리로 바꿔야 한다. 가린 뒤 `SHA256SUMS`를 다시 만들었다.

## 산출물 목록

- `audit/REPORT.md`: 이 보고서
- `audit/meta.json`: 대상 SHA, Node, pnpm, uname, 시작·종료 UTC, 가림 건수
- `audit/logs/`: 명령별 로그와 요약 TSV
- `audit/tests/`: 감사용 테스트(`audit-retire.test.mjs`, `audit-race.test.mjs`, `fixtures/audit-race-worker.mjs`). 후보 트리의 `tests/audit/`에 두고 `npx vitest run tests/audit/…`로 실행한다
- `audit/harness/`: 전체 검증 순서, 이관·crash·하향 하네스, flaky 반복, 가림 스크립트
- `audit/SHA256SUMS`
