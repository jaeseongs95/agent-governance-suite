# AGS 2.7.5: 끝난 세션의 미관측 wake 퇴역 (L1), T-1, I-1

- 기준: `main` = `0c8b52d97d1ccdda1768c18422d073d674e2c785` (v2.7.4)
- 브랜치: `claude/v275-wake-retire` = `3501e7c5fe998a554e8fa3e3ab795b469dccf2e8`, tree `b8526aebedd80364f684c6113276fb46d43fc96d`. 새 브랜치로 non-force push했고 `git ls-remote`로 확인했다.
- commit(`logs/commits.txt`). 네 commit 모두 `bundle:check` 0이고 `claude:check`가 fresh다(`logs/commit-freshness.log`).
  - `a1068f3` test: keep packaged hook presence live on slow runners
  - `d6c0a64` fix: retire unobserved wakes of ended session instances
  - `a30b8fd` docs: describe the ended-birth wake retirement rule
  - `3501e7c` chore: release 2.7.5
- Skill `agent-governance-suite:ponytail`은 이 세션에 등록되어 있지 않다. 저장소의 `skills/ponytail/SKILL.md` 지침(가장 단순한 올바른 구현)을 따랐다.

## 설계 판정: 총괄안을 수정해 채택

총괄안은 "wake가 묶인 인스턴스(instance_id, birth_generation, transport)의 presence가 live가 아니면 퇴역"이다. 방향은 맞다. 다만 두 곳을 바꿨다.

1. **판정 행: 인스턴스의 행 대신 세션의 최신 presence 행(birth 기준)을 쓴다.**
   - 규칙: 최신 행이 wake의 살아 있는 birth가 아니면 퇴역한다. 여기서 살아 있는 birth는 `ended_at IS NULL AND lease_until > now AND instance_id = wake.instance_id AND started_at = wake.birth_generation`이다. 최신 행이 없어도 퇴역한다.
   - 이 조건 하나가 기존 근거 2(더 늦은 birth가 live)를 포함한다. 새 근거를 따로 덧붙이지 않고 기존 subquery 한 줄을 바꿨다.
   - 이유: presence 조회, `relayTick`, `claimHostWake`의 현재 세대 판정, `autoWakeOutlook`, `wakeBindingCurrent`가 모두 이 최신 행을 읽는다. 그래서 "latch로 남는 조건"이 "claim이 가능할 수 있는 조건"과 같은 행을 본다.
   - 총괄안(인스턴스 행)의 반례: wake의 인스턴스 A는 살아 있고, 더 늦은 birth B가 태어났다가 끝난 경우다.
     - 최신 행 B가 ended이므로 A의 relay tick은 `alive: false`이고, A의 wake는 현재 세대로 claim될 수 없다.
     - 그런데 A의 행은 live이므로 총괄안에서는 A가 끝날 때까지 퇴역하지 않는다.
     - 최신 행 규칙에서는 퇴역한다. 이 상태에서 새 wake도 예약되지 않는다(최신 행이 online이 아님).
2. **transport는 판정에 넣지 않는다.**
   - `startPresence`는 살아 있는 같은 instance의 transport를 바꿔도 birth를 유지한다(`session-message-store.ts:1125-1134`). 되돌리면 다시 현재 binding이 된다.
   - 따라서 transport만 다른 live birth는 죽은 것이 아니다. latch로 남는 쪽이 보수적이다. 시험 `other-transport`와 mutant N6이 이것을 고정한다.

schema, 상태 이름, 주입 만료 + 유예 조건, 활동 근거, 늦은 도착 처리(`session-message-store.ts:1068`)는 바꾸지 않았다. 코드 변경은 `retireUnobservedWakes`의 SQL 조건과 주석뿐이다(`logs/change.diff`).

## 반례 조사

| 점검 | 결과 |
|---|---|
| 끝나거나 lapse된 birth가 같은 세대로 다시 live가 되는가 | 아니다. `heartbeatPresence`는 `ended_at IS NULL AND lease_until > now`인 행만 갱신한다. `relayTick`은 최신 행이 online이고 같은 instance·transport일 때만 갱신한다. `startPresence`는 ended/lapsed 행에 더 늦은 새 `started_at`(같은 ms면 +1 ms)을 준다(C2). |
| 같은 instance_id로 다시 태어나는 경로 | 있다(`ON CONFLICT (host, session_id, instance_id)`). 하지만 birth가 바뀌므로 `started_at = birth_generation`이 거짓이다. 재탄생이 live이면 2.7.4도 퇴역시켰다(기존 근거 2). |
| Codex queue에 남은 wake와 누적 | 퇴역 뒤 새 wake는 `reserveManagedWake`의 `wakeBindingCurrent`(최신 행 online, live relay)를 통과해야 한다. 최신 행이 wake의 살아 있는 birth가 아니면 가능한 경우는 두 가지다. 하나는 최신 행이 online이 아니어서 새 wake를 보내지 않는 경우다. 다른 하나는 최신 행이 더 늦은 live birth인 경우로, 2.7.4도 퇴역시킨 경우다. 따라서 새 wake가 나갈 수 있는 상태는 2.7.4와 같고, 누적 억제 범위는 줄지 않는다. 결과가 다른 구간은 죽음과 재탄생 사이뿐이고, 그 구간에는 dispatch가 없다. |
| 부수 효과: 퇴역이 앞당겨짐 | 퇴역 행은 1시간 뒤 지워진다. 1시간보다 오래 지나 세션이 다시 열리고 host가 옛 marker를 다시 제출하면, 미등록 nonce가 되어 hook이 막지 않는다. 이 한계는 2.7.3부터 있었고, release notes 알려진 한계에 적었다. 반대로 lease만 끊긴 상태(잠자기 뒤 복귀)에서 marker가 먼저 도착하면, 전에는 `observed`로 끝나 막지 않았지만 이제는 `retired: true`로 막는다. |
| reserved | 외부 효과가 없다. 만료 + 유예 뒤 퇴역해도 손실이 없다. 기존 not-submitted 전환 경로(세대 교체)는 그대로다. |
| started | dispatcher가 죽은 경우다. 퇴역 뒤 늦은 `recordManagedWakeOutcome`은 `state IN ('started','unknown')` 조건으로 거절된다(기존 시험 80행이 retired 행에 대해 확인). |
| transport가 다른 presence | 위 설계 2. latch로 남는다(`other-transport` 시험, N6). |
| legacy 행 | `ACTIVE_WAKE_STATES`에 없어 대상이 아니다. 기존 `expires_at` prune을 따른다. instance_id가 NULL인 활성 행은 비교가 NULL이 되고 `coalesce(..., 1)`로 퇴역한다. 이런 행은 현재 세대로 claim될 수 없다. |
| 혼합 버전 | 퇴역은 broker의 prune에서만 일어난다. 2.7.4 이하 broker는 이런 행을 활성으로 둔다. 새 broker의 첫 prune에서 퇴역한다. 새 시험 "leaves a previous broker's latch of an ended birth for the new broker to retire"가 v2.7.4·v2.7.3·v2.7.2·v2.7.1·v2.2.6 broker로 통과했다. 퇴역 행은 2.7.3 이상 broker에서 terminal로 보인다(기존 schema 1 시험). |
| 두 process 경합 | UPDATE 한 문장이고 `state IN active` 조건이라 한 번만 바뀐다. 두 process 시험에서 `retired_at`은 두 시각 중 하나이고, 이후 prune에서 바뀌지 않는다. |
| 시각 경합(남은 한계) | 판정은 요청마다 받은 `nowMs`를 쓴다. lease 끝과 같은 ms에서, 먼저 시각을 잡은 heartbeat가 나중에 commit되는 경우를 생각할 수 있다. 이때 이미 퇴역한 birth가 다시 갱신될 수 있다. broker 한 process가 요청을 차례로 처리하는 구조라 실제로는 생기기 어렵다. 생겨도 옛 marker는 retired로 막히고, 비용은 wake 하나가 더 나가는 것이다. |

## 반증 시험: 수정 전 실패, 수정 후 통과

`tests/session-messaging/wake-liveness.test.mjs`

- `logs/before-fix-0c8b52d-wake-liveness.log`: 0c8b52d의 store에 새 시험을 돌려 exit 1, 9 failed / 24 passed였다(이 로그만 Node 22).
- `logs/after-fix-wake-liveness.log`: 33 passed였다.

수정 전에 실패한 9개:

- 퇴역 사례 6개 ("an expired latch whose birth is no longer live retires after the grace without activity")
  - `unreachable`: lease 만료
  - `ended`
  - `ended-new-generation`: 더 늦은 birth도 끝남
  - `purged`: 2.7.4 prune이 presence 행을 모두 지움
  - `older-instance-live`: 더 이른 다른 instance는 살아 있음
  - `generation-missing`: 같은 instance가 살아 있지만 그 birth가 아님
- 늦은 도착: "a wake of an ended birth retired without activity records a late arrival as evidence only, then a rebirth delivers"
- G 이관: 행이 없는 옛 instance의 migrated unknown 행이 첫 prune에서 퇴역
- 두 process 경합: "two independent processes racing the retirement of an ended birth retire it once"

보호 시험(수정 전후 모두 통과):

- live이지만 조용한 birth는 latch로 남는다(`same-generation`: `autoWake` `latched`/`wake-unobserved`, 새 reserve 없음). `other-transport`도 같다.
- 만료 + 유예 1 ms 전에는 끝난 birth라도 퇴역하지 않는다(각 퇴역 사례 안에서 확인).
- 퇴역 행은 퇴역 1시간 뒤 prune에서 지워진다. 1 ms 전에는 남아 있다.
- 퇴역 뒤 늦은 도착은 `late_observed_at`만 기록하고 messages를 바꾸지 않는다. 재탄생하면 새 wake가 본문을 전달한다.

기존 시험 변경:

- "stays latched" 표에서 `unreachable`, `ended-new-generation`, `older-live-instance`를 빼고 퇴역 표로 옮겼다. 이 세 경우가 바로 L1이다. 옛 `ended-new-generation` 사례는 `live()`가 먼저 prune해 버려 공허하게 통과하고 있었다.
- G 이관 시험의 `digest-late` 기대값을 바꿨다.

## T-1

`session-message.test.ts` "blocks only verified empty Codex wake prompts in the packaged hook"에서, 각 시나리오의 시드 뒤 그 세션의 살아 있는 presence 행과 relay lease의 `lease_until`을 지금부터 10분 뒤로 다시 쓴다. assertion, 시험 timeout, 제품 상수는 바꾸지 않았다.

broker 시계 +25초로 흉내 냈다(`harness/clockshift.mjs`, broker process만 이동).

- 수정 전 시험(0c8b52d): exit 1. `expected {} to match object { decision: 'block' }`로 감사 T-1과 같다(`logs/slow-shift25-before-T1-0c8b52d-test.log`).
- 수정 후: 통과(`logs/slow-shift25-after-T1.log`).

## I-1

`docs/session-message-lifecycle.md` 혼합 버전 표의 문구를 바꿨다. 이전 broker의 응답이 한도를 넘으면 "첫 묶음이 응답 한도 초과(전송 실패)로 끝나 남은 묶음은 요청하지 않고" 모두 `unknown`/`null`이다. 표의 service·broker 열은 "2.7.4 이상"으로 맞췄다. 공개된 `docs/release-notes-v2.7.4.md`는 바꾸지 않았다.

## 문서와 버전

- `docs/release-notes-v2.7.5.md`를 새로 썼다. H1은 "v2.7.5: 끝난 세션의 미관측 wake 퇴역"이다. 무엇이 바뀌었는지, 기존 DB에서 설치 뒤 첫 prune에 활성 행이 퇴역한다는 것, 혼합 버전, 알려진 한계를 적었다.
- lifecycle 퇴역 절: 근거 2 문구, 활성으로 남는 행, 누적 상한 문장, 거절한 대안(인스턴스 행만 보는 판정), 혼합 버전 문단을 고쳤다.
- 2.7.5로 올린 파일은 v2.7.4 때와 같은 집합이다: `package.json`, `.codex-plugin/plugin.json`, `release/version.json`, `.agents/plugins/marketplace.json`(ref v2.7.5), `mcp-server/src/plugin-info.ts`, `README.md`, `README.en.md`(릴리스와 `--ref v2.7.5`), `docs/roadmap.md`. dist와 `claude-plugin`은 다시 생성했다.

## mutant (`logs/mutants/mutants.tsv`)

대상 시험은 wake-liveness, presence-retention, session-message다.

| mutant | 결과 | 실패 시험 수 |
|---|---|---|
| BASELINE | PASS | 0 |
| N1 새 근거 삭제(2.7.4 조건으로 되돌림) | KILLED | 9 |
| N2 유예 조건 삭제 | KILLED | 15 |
| N3 live 조건 반전(live birth도 퇴역) | KILLED | 5 |
| N4 instance 결속 대신 세션의 live 행 존재만 봄 | KILLED | 12 |
| N5 최신 행 live 여부만 보고 instance·birth 비교 삭제 | KILLED | 11 |
| N6 transport도 결속에 넣음 | KILLED | 1 |

## 검증 (Node v24.21.0, `logs/summary.tsv`)

| 단계 | 종료 코드 |
|---|---|
| install --frozen-lockfile, bundle:check, claude:drift(fresh), lint, build | 모두 0 |
| test | 0 (877 passed, 4 skipped) |
| runtime:check, validate:all | 0 |
| validate:official | 1, FAIL_UNRELATED(환경: Codex validator ENOENT) |
| claude:build, claude:check(fresh), source:check | 0 |
| git diff --check, git diff --check 0c8b52d..HEAD | 0 |

- 검증 뒤 `git status`는 비어 있다.
- 처음 한 번은 기본 Node 22로 돌려 `runtime:check`가 "Node.js 24.0.0 or newer is required"로 1이었다. 그 기록은 `logs/node22-first-run/`에 있고, 위 표는 Node 24로 다시 돌린 결과다.

추가 검증:

- 새 시험 파일, presence-retention, presence-batches 10회 반복: 10/10, 매회 46/46(`logs/repeat-10x.log`). 끝난 뒤 broker process는 0개였다. `/tmp/ags-*` 3개는 2026-09-28 15:04에 만들어진 이전 작업의 잔여물이다.
- previous-broker: v2.7.4 4/4, v2.7.3 4/4(`logs/previous-broker-*.log`). 개발 중에는 v2.7.2, v2.7.1, v2.2.6도 4/4였다(로그 없음).
  - 기존 presence 시험은 v2.7.4 broker가 `targets`를 지키므로 실패했다. 응답에 다른 identity가 섞였는지로 targeted broker를 구분해, targeted이면 target만 online으로 오는 것을 확인하게 고쳤다.
- 느린 runner 흉내(broker 시계 +25초): 새 시험과 presence-retention 42/42, T-1 1/1, previous-broker v2.7.4 4/4(`logs/slow-shift25-after-*.log`). 새 퇴역 시험은 모두 명시적 시각을 쓰고 벽시계 lease에 기대지 않는다. 혼합 버전 시험도 이미 끝난 birth를 쓴다.

## NOT_RUN

- Windows 실행: 이 환경은 Linux다. 새 시험은 SIGSTOP을 쓰지 않고, 자식 process는 종료를 기다린다. broker는 `exit`를 기다린 뒤 디렉터리를 지운다.
- 이 PC의 운영 DB 13개 행에 대한 실제 적용: 운영 DB를 쓰지 않았다. 같은 모양(끝남, lapse, presence 행 삭제)은 시험으로 확인했다.
- `source:verify`: 삭제된 외부 저장소 때문에 NOT_VERIFIABLE이며 실행하지 않았다.
- CI: push 뒤의 결과는 이 세션에서 확인하지 않았다.
- 실제 host(Codex)의 queue 재제출 동작.

## 남은 한계

- 퇴역 1시간 뒤 지워진 행의 marker가 도착하면 막지 않는다(2.7.3부터 있음). 끝난 세션이 오래 뒤 다시 열리는 경우에 해당할 수 있다.
- 살아 있지만 조용한 세션의 latch는 설계대로 남는다.
- 위 시각 경합(ms 창)과 시계가 되돌아가는 환경.
- L3(공통 접수 원문 이중 주입)는 범위 밖이다.

## 가림

같은 규칙으로 가렸다. 건수는 `meta.json`에 있다. `SHA256SUMS`는 커밋된 blob 기준이다.
