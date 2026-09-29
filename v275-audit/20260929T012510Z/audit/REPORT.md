# AGS v2.7.5 독립 사전 감사 (0c8b52d9 → 3501e7c5)

- 판정 대상: `claude/v275-wake-retire` = `3501e7c5fe998a554e8fa3e3ab795b469dccf2e8` (tree `b8526aebedd80364f684c6113276fb46d43fc96d`)
- 기준: `main` = `0c8b52d97d1ccdda1768c18422d073d674e2c785` (v2.7.4, tag `v2.7.4`)
- 커밋: `a1068f3` test(T-1), `d6c0a64` fix(L1), `a30b8fd` docs, `3501e7c` chore: release 2.7.5
- writer 근거 `claude/evidence-v275-wake-retire-20260929T010538Z`(`757cae0`)는 대조용이다. 체크섬은 59/59 일치한다. 판정은 직접 재현한 결과로만 한다.
- 구현하지 않은 세션으로 읽기 전용 감사를 했다. 감사용 probe와 mutant는 버리는 worktree(`0c8b52d9`, `3501e7c5`)에서만 적용하고 되돌렸다.
- 환경: Linux cloud 컨테이너 1대, Node v24.21.0, pnpm 11.19.0.

## 판정: **PASS_WITH_FINDINGS**. 출시를 막지 않는다

- L1이 해소됐다. 운영 DB 모양의 fixture에서 설치 뒤 첫 prune이 정확히 13행(submitted 9, unknown 3, reserved 1)을 퇴역시켰다. 바뀐 칸은 `state`와 `retired_at`뿐이다. 살아 있는 세션의 latch 3개는 남았고, 메시지·영수증·presence 표는 기준과 byte 단위로 같다.
- 누적 억제 범위: 퇴역 뒤 새 wake가 나갈 수 있는 상태는 2.7.4와 같다. 예외는 같은 ms에 태어난 두 instance뿐이다(I-1).
- 총괄이 물은 동작 변화(잠자기 복귀): 달라지는 경우는 한 가지다. 만료와 유예가 지난 뒤 다른 요청의 prune이 먼저 돌고, 그 뒤 옛 marker가 도착한 경우다.
  - 2.7.4: 빈 모델 턴이 한 번 생긴다.
  - 2.7.5: 모델 요청 전에 막힌다.
  - 두 버전 모두 본문은 유실되거나 지연되지 않았다. 복귀한 세션의 새 birth에서 새 wake가 본문을 전달했다.
  - 2.7.4도 재등록이 먼저면 같은 경로로 막았다.
  - 출시를 막을 사유가 아니며, 빈 턴이 줄어드는 개선이다.
- T-1과 I-1(audit3)은 해소됐다.
- finding은 minor 1건이다. 설계 근거인 writer 반례를 고정하는 시험이 없다(T-2). 정보 2건을 함께 적는다.

## 항목별 결과

| # | 항목 | 결과 |
|---|---|---|
| 1 | 범위 | PASS |
| 2 | L1 설계와 안전성 | PASS (I-1) |
| 3 | 운영 DB 영향 | PASS |
| 4 | 문서 | PASS (I-2) |
| 5 | T-1 | PASS |
| 6 | 검증 | PASS_WITH_FINDINGS (T-2) |

### 1. 범위 — PASS

`git diff --stat 0c8b52d9 3501e7c5`의 19개 파일은 다음뿐이다.

- **L1:** `session-message-store.ts` (`retireUnobservedWakes`의 SQL 조건과 주석, +8 −4)
- **dist 재생성:** `mcp-server/dist/session-message-broker.mjs`, `claude-plugin/mcp-server/dist/session-message-broker.mjs`. 같은 SQL과 주석이다.
- **시험:** `wake-liveness.test.mjs`(L1), `previous-broker.test.ts`(혼합 버전과 targeted broker 판별), `session-message.test.ts`(T-1, +5)
- **문서:** `release-notes-v2.7.5.md`(신규), `session-message-lifecycle.md`(L1과 I-1). 공개된 `release-notes-v2.7.4.md`는 바뀌지 않았다.
- **버전 올림(`3501e7c`):** 11개 파일로, v2.7.4의 `056d148 chore(release): prepare v2.7.4`와 파일 집합이 같다. `.agents/plugins/marketplace.json`, `.codex-plugin/plugin.json`, `README.md`, `README.en.md`, `claude-plugin/.claude-plugin/plugin.json`, 두 `dist/server.mjs`, `docs/roadmap.md`, `plugin-info.ts`, `package.json`, `release/version.json`이다.

`bundle:check` 0, `claude:drift` 0, `claude:check` fresh였고, 생성 뒤 `git status --porcelain`은 0 byte다.

### 2. L1 설계와 안전성 — PASS

**새 조건** (`session-message-store.ts:342-353`)

- 퇴역 전제는 그대로다: `expires_at <= now - grace`.
- 퇴역 근거는 다음 둘 중 하나다.
  - 만료 뒤 활동이 있다.
  - 세션 최신 presence 행(`started_at DESC, rowid DESC`)이 다음을 모두 만족하지 않는다: `ended_at IS NULL`, `lease_until > now`, `instance_id`가 wake와 같음, `started_at = birth_generation`. 행이 없으면 `coalesce(..., 1)`로 퇴역한다.
- transport는 보지 않는다.

**같은 최신 행을 읽는다는 writer 주장: 코드로 확인했다**

모두 `presence()`(`ORDER BY started_at DESC, rowid DESC LIMIT 1`)를 읽는다. `presence()`의 online 판정은 `ended_at` 없음과 `Date.parse(lease_until) > nowMs`다.

| 함수 | 위치 | 확인한 내용 |
|---|---|---|
| `reserveManagedWake` | `:895` | `wakeBindingCurrent`(`:852`, 최신 행 online, instance·transport 일치, live relay) |
| `wakeBindingCurrent` | `:852` | 위와 같다 |
| `autoWakeOutlook` | `:720` 부근 | `presence()` |
| `relayTick` | `:786-790` | 최신 행 online, 같은 instance·transport가 아니면 `alive:false` |
| `claimHostWake` | `:1075-1078` | 행의 instance·birth·transport가 최신 행과 같고 online일 때만 claim |

**누적 억제 범위**

새 wake는 최신 행이 online이고 live relay가 있어야 나간다. 퇴역한 wake의 birth가 최신의 살아 있는 행이 아닌데 새 wake가 나갈 수 있는 경우는 다음뿐이다.

- **최신 행이 더 늦은 live birth인 경우:** 2.7.4도 퇴역시켰다.
- **같은 ms에 태어난 다른 instance가 rowid로 최신인 경우:** 2.7.4는 영구 latch였다(I-1).

그 밖의 경우는 새 wake가 나가지 않는다.

- 최신 행보다 이른 live 행은 최신 행이 될 수 없다.
- wake의 birth 행이 최신이면 다른 live 행이 있는 동안 presence prune이 지우지 않는다(`:326-331`).

**살아 있는 행의 latch 유지**

- 살아 있지만 조용한 birth는 latch를 유지한다. writer 시험 `same-generation`과 운영 DB fixture의 `live-quiet`에서 확인했다.
- transport만 다른 live birth도 유지한다. writer 시험 `other-transport`, mutant N6, fixture의 `live-other-transport`에서 확인했다.
- `startPresence`는 살아 있는 같은 instance의 transport가 바뀌어도 birth를 유지한다(`:1125-1134`).

**writer 반례와 총괄 원안(instance 행)** (`logs/counterexample.log`)

A(더 이른 birth, lease 유지)에 wake가 묶여 있고, 더 늦은 B가 태어났다가 끝난 경우를 재현했다.

| 대상 | 최신 행 | A의 relay tick | wake | A 새 wake |
|---|---|---|---|---|
| 후보 | B(ended) | `alive:false` | expired-unobserved | 없음 |
| 0c8b52d9 | B(ended) | `alive:false` | submitted 유지 | 없음 |
| A6(가장 이른 행 기준, instance 원안과 같은 결과) | B(ended) | `alive:false` | submitted 유지 | 없음 |

- A의 wake는 현재 세대로 claim될 수 없고 새 wake도 나가지 않는다.
- instance 행 기준이면 A가 끝날 때까지 풀리지 않는 활성 행이 남는다. writer의 비교는 맞다. 다만 이 사례를 고정하는 시험은 없다(T-2).

**동작 변화: 잠자기 복귀 재현** (`logs/probes-*.jsonl`)

실제 source broker와 packaged Codex hook(`dist/session-message-hook.mjs`, codex-queue)으로 재현했다. 두 commit에서 같은 시험 파일을 썼다.

- 설정: 만료 + 유예 + 5분 전에 birth·relay·본문·wake(submitted)를 만든다. lease는 끊긴 채 둔다(end 없음).
- 이어서 옛 marker를 hook에 넣는다. 복귀는 같은 instance의 `startPresence`와 relay 재획득이다. 그 뒤 새 wake를 예약하고 새 marker를 넣는다.

| 순서 | 0c8b52d9 | 3501e7c5 |
|---|---|---|
| O1. 다른 요청의 prune → 옛 marker → 재등록 | hook `{}`(빈 모델 턴), 행 `observed` | hook `block`("already retired"), 행 `expired-unobserved`+late |
| O2. prune 없이 옛 marker 먼저 | `{}`, `observed` | `{}`, `observed` (같음) |
| O3. 재등록(`acquireRelay`의 prune) → 옛 marker | `block`, `expired-unobserved` | `block`, `expired-unobserved` (같음) |

- **본문:** 세 순서 모두, 두 버전 모두 첫 marker 뒤에도 미ACK·미claim 상태로 큐에 남았다. 복귀 뒤 새 wake 예약은 `dispatch:true`였고, 새 marker가 본문을 전달했다(`secondHookDeliversBody:true`). 유실이나 무기한 지연은 없다.
- **차이가 나는 경우:** O1 하나다. 만료와 유예가 지난 뒤, 복귀한 세션의 옛 marker보다 다른 세션의 요청(relay tick의 `pendingCount`, send, status, 현황판 조회 등)이 먼저 prune을 부른 경우다. 한 PC에 다른 live 세션이 있으면 흔히 일어나는 순서다.
- **사용자에게 보이는 증상:**
  - 2.7.4에서는 marker만 있는 프롬프트가 모델까지 가서 빈 턴이 한 번 생겼다.
  - 2.7.5에서는 hook이 모델 요청 전에 막고 host에 marker와 차단 사유가 보인다.
  - 사용자 입력이 섞인 프롬프트는 wake-only가 아니므로 이 경로로 막히지 않는다(`session-message-hook.ts:198`, 기존 `mixed` 시험).
  - 2.7.4도 O3 순서에서는 같은 증상이었다.
- **판정:** 출시 차단 사유가 아니다.

**그 밖의 점검**

- **보관 뒤 한계:** 퇴역 행이 1시간 뒤 지워진 다음 옛 marker가 오면 미등록 nonce가 된다. 이때 `claimHostWake`는 거절(recognized false, retired 없음)하고, hook은 막지 않으며 `observe-native-input`을 부른다. 기존 `forged` 시나리오(`{}`)와 같은 경로다. release notes 알려진 한계의 "미등록 nonce로 거절되어 hook이 막지 않습니다… 빈 모델 턴 한 번"은 정확하다. lifecycle 문서에는 보관 상한 1000개도 적혀 있다.
- **시각 경합** (`B-lease-boundary`): 같은 ms 경계에서 판정이 일관된다.
  - `now = lease_until`: presence `unreachable`, heartbeat 거절, 퇴역한다.
  - `now = lease_until - 1`: presence online, heartbeat 수락, 퇴역하지 않는다.
  - 운영에서 store를 여는 것은 broker 한 process뿐이다(`session-message-broker.ts:490`). 요청은 동기적으로 차례대로 처리되고 각자 `Date.now()`를 받는다. 그래서 "먼저 잡은 시각의 heartbeat가 퇴역 뒤 commit"되는 경우는 두 broker가 같은 DB를 쓰거나 시계가 되돌아갈 때만 생긴다. writer의 판단("실제로는 생기기 어렵고, 생겨도 비용은 wake 하나")에 동의한다. mutant A2(`>=`)가 살아남아, 경계 자체는 시험이 고정하지 않는다.
- **혼합 버전:** previous-broker 시험 "leaves a previous broker's latch of an ended birth for the new broker to retire"가 v2.7.4, v2.7.3, v2.7.2, v2.7.1, v2.2.6에서 모두 통과했다.
  - managed wake를 아는 이전 broker는 행을 그대로 둔다.
  - 새 store의 prune은 그 행을 `expired-unobserved`로 바꾸고, `observed_at`과 `consumed_at`은 null이다.
  - 퇴역 행을 이전 broker가 읽는 경로는 기존 schema 1 시험으로, 다섯 broker 모두 통과했다.
- **두 process 경합:** writer 시험 "two independent processes racing ..."이 10회 반복에서 매번 통과했다. 운영 DB fixture의 두 번째 prune(+5초)에서는 모든 표가 같았다(`retired_at` 불변).
- **legacy 행과 NULL instance** (`logs/null-legacy.log`)
  - legacy 행은 `ACTIVE_WAKE_STATES` 밖이라 그대로다.
  - `instance_id`와 `birth_generation`이 NULL인 활성 행(migrated 모양)은 2.7.4에서는 영구 활성, 2.7.5에서는 만료와 유예 뒤 퇴역한다.
  - 이런 행은 `claimHostWake`의 instance 비교를 통과할 수 없어 현재 세대로 claim될 수 없다. 그러므로 퇴역이 맞다.

### 3. 운영 DB 영향 — PASS

`harness/opdb.ts`, `logs/opdb-compare.txt`

**fixture**

기준 worktree의 store로 만든 뒤 2.7.4 prune을 한 번 돌려 "현재 상태"를 만들었다.

| 구분 | 구성 |
|---|---|
| 퇴역 대상 13개 | 재부팅으로 lease가 3시간 전에 끊긴 submitted 5, lease가 31시간 전에 끊겨 2.7.4 prune이 presence 행을 지운 submitted 4, session-end로 끝난 unknown 3, lease가 끊긴 reserved 1 |
| 보호 대상 3개 | live-quiet, 만료 전인 recent-lapsed, transport만 다른 live |
| 다른 기록 | Claude 세션 사이 메시지 6개(3개 ACK), prepared 영수증 7개 |

**같은 DB 사본에 같은 `nowMs`로 prune 한 번**

- 0c8b52d9: reserved 1, submitted 12, unknown 3으로 변화가 없다.
- 3501e7c5: 13행이 `expired-unobserved`가 되고, submitted 3개(보호 대상)가 남는다.
  - 13행은 이전 상태로 submitted 9, unknown 3, reserved 1이다.
  - 바뀐 칸은 `state`와 `retired_at`뿐이다.
- `messages`(18), `prepared_messages`(7), `session_presence`(12), `session_activity`, `relay_leases`, `input_observations`는 두 결과가 완전히 같다.
- 13개 세션 앞으로 큐에 있던 본문 가운데, 메시지 TTL(24시간) 안의 9개는 그대로 남는다. 31시간 전 본문 4개는 두 버전 모두 이미 TTL로 지워져 있었다.

**뒤이은 prune**

- 두 번째 prune(+5초): 모든 표가 같다.
- 퇴역 1시간 1초 뒤: 13행이 지워진다. 메시지 변화는 1시간 지난 ACK 3개가 지워진 것뿐이다. 0c8b52d9의 같은 시각 prune과 `messages`, `prepared_messages`가 같다.

**결론**

이 PC 모양의 DB에서 설치 뒤 첫 prune에 13행이 퇴역할 것으로 판단한다. 메시지와 영수증에는 부작용이 없다. 실제 운영 DB는 쓰지 않았다.

### 4. 문서 — PASS (I-2)

**release notes와 lifecycle의 서술이 코드·재현과 맞다**

- 근거 2 문구, "판정은 instance와 birth generation, transport는 보지 않음"
- "새 wake 조건은 최신 행 기준", "살아 있지만 조용한 세션만 latch"
- "퇴역 행 1시간 뒤 삭제, `deliveryState` unknown"
- "본문은 큐에 남고 재개하면 새 wake"
- "퇴역은 broker prune에서만, 이전 broker는 활성으로 둠"
- "previous-broker 다섯 버전 통과"(직접 재실행으로 확인했다. writer evidence에는 v2.7.4와 v2.7.3 로그만 있다)
- 알려진 한계(보관 뒤 미등록 nonce, 벽시계, L3 범위 밖)

**I-1(audit3) 문구**

- 혼합 버전 표가 "첫 묶음이 응답 한도 초과(전송 실패)로 끝나 남은 묶음은 요청하지 않고"로 바뀌었다. `session-message-service.ts`의 전송 실패 중단 동작과 맞다.
- 열 이름 "2.7.4 이상"도 맞다.
- 공개된 v2.7.4 notes는 바뀌지 않았다.

**링크**

- 추가된 줄에 외부 링크는 없다.
- 새 notes의 링크는 저장소 안 상대 경로 2개다.
- lifecycle의 `learn.chatgpt.com/docs/hooks` 링크는 기준에 이미 있던 host 문서 링크다. 외부 스킬 저장소 링크는 없다.

### 5. T-1 — PASS

- 수정 내용: 시나리오마다 시드한 뒤, 그 세션의 `ended_at IS NULL` 행과 relay lease의 `lease_until`만 지금부터 10분으로 다시 쓴다(+5줄).
- assertion, timeout, 제품 상수는 그대로다.
- `late` 시나리오의 두 live birth는 수정 전에도 모두 live였고, 둘 다 연장되므로 판정 관계가 같다.
- broker 시계 +25초(`logs/clockshift-sweep.log`)
  - 0c8b52d9: `expected {} to match object { decision: 'block' }`로 실패한다(audit4 T-1과 같다).
  - 3501e7c5: `tests/session-messaging`과 `tests/session-board` 전체 314 통과·4 skip, previous-broker v2.7.4·v2.7.3 각 4/4.
- 실제 25초 대기(`submitted` 시나리오, `logs/t1-realwait.log`): 3501e7c5에서 통과한다.

### 6. 검증 — PASS_WITH_FINDINGS

모두 `3501e7c5`에서 실행했다(`logs/full-summary.tsv`).

| 검증 | 결과 |
|---|---|
| `pnpm install --frozen-lockfile`, `bundle:check`, `claude:drift`, `lint`, `build` | 모두 0 |
| `pnpm test` | 0, 877 통과·4 skip |
| `runtime:check`, `validate:all`, `claude:build`, `claude:check`(fresh), `source:check` | 모두 0 |
| `git diff --check` | 0 (작업 트리와 `0c8b52d9..3501e7c5` 범위) |
| `validate:official` | 1, FAIL_UNRELATED(환경: Codex validator ENOENT) |
| wake-liveness, presence-retention, presence-batches 10회 | 10/10 (각 46/46). 남은 임시 디렉터리와 broker process 0 (`logs/repeat10.txt`) |
| previous-broker v2.7.4, v2.7.3, v2.7.2, v2.7.1, v2.2.6 (태그 dist 파일 경로) | 각 4/4 (`logs/previous-broker.log`) |
| 느린 runner 흉내(broker +25초, 실제 25초 대기) | 5절 참고 |
| 감사 probe(잠자기 복귀 3순서, 시각 경계, 같은 ms instance) | 두 commit 모두 5/5 실행, 결과는 2절 |

**mutant** (`logs/mutants/mutants.tsv`, 대상은 wake-liveness, presence-retention, session-message)

| mutant | 결과 | 실패 시험 수 | 비고 |
|---|---|---|---|
| N1 2.7.4 조건으로 되돌림 | KILLED | 9 | writer |
| N2 유예 삭제 | KILLED | 15 | writer |
| N3 live 조건 반전 | KILLED | 5 | writer |
| N4 세션의 live 행 존재만 봄 | KILLED | 12 | writer |
| N5 instance·birth 비교 삭제 | KILLED | 11 | writer |
| N6 transport도 결속 | KILLED | 1 | writer |
| A1 행이 없으면 latch 유지(`coalesce(...,0)`) | KILLED | 2 | 감사자 |
| A2 경계 `lease_until >= now` | SURVIVED | 0 | 1 ms 경계. B probe로 후보 동작만 확인 |
| A3 birth 비교 삭제(instance만) | KILLED | 2 | 감사자 |
| A4 instance 비교 삭제(birth만) | SURVIVED | 0 | 같은 ms에 태어난 다른 instance에서만 다르다(I-1). 시험 없음 |
| A5 `ended_at` 검사 삭제 | SURVIVED | 0 | 동치. `endPresence`가 `lease_until`을 종료 시각으로 쓴다(`:1167`) |
| A6 최신 대신 가장 이른 행 | SURVIVED | 0 | T-2 |

## Findings

### T-2 (minor, 시험 공백, 비차단) 최신 행 기준을 택한 근거인 writer 반례를 시험이 고정하지 않는다

- 위치: `tests/session-messaging/wake-liveness.test.mjs`의 `deaths` 표(`:127-150`)
  - `ended-new-generation`은 wake의 birth(instance-1)를 살려 두지 않는다(`alive = null`).
  - `older-instance-live`는 wake가 더 늦은 birth에 묶인 경우다.
  - 그래서 "wake의 birth A는 살아 있고, 더 늦은 B가 태어났다가 끝남"은 시험에 없다.
- 재현: mutant A6(서브쿼리를 `started_at ASC`로)가 모든 대상 시험을 통과한다. 같은 사례에서 A6은 총괄 원안(instance 행 기준)과 같은 결과를 낸다. 직접 만든 사례(`logs/counterexample.log`)에서는 후보만 퇴역하고, A6과 0c8b52d9는 `submitted`를 유지한다.
- 영향: 제품 동작은 맞다. 다만 이후 누가 판정 행을 바꿔도 시험이 막지 못한다.
- 권장(선택): `deaths`에 A를 `keep`하는 사례를 하나 추가하고, 퇴역과 "A의 새 wake 없음"을 단언한다. A2(경계)와 A4(같은 ms)도 필요하면 같은 방식으로 고정할 수 있다.

## 정보

### I-1 (정보) "새 wake가 나갈 수 있는 상태가 2.7.4와 같다"의 예외: 같은 ms에 태어난 두 instance

- probe `E-same-ms-instances`: 같은 ms에 A와 B가 태어났고, wake는 A에 묶여 있으며, B가 rowid로 최신이고 live이며 조용하다.
  - 0c8b52d9: 영구 latch다(B의 새 wake 없음).
  - 3501e7c5: 퇴역하고 B에 새 wake가 나간다.
- B는 A와 다른 instance다. 이 동작은 2.7.4가 "더 늦은 live birth"에 하던 것과 같다. 같은 instance queue에 marker가 쌓이는 경우가 아니므로 누적 억제 목적에 어긋나지 않는다.
- 문서 문장은 사실상 맞다. 엄밀히는 이 동률만 다르다.

### I-2 (정보) 동작 변화 절에 잠자기 복귀 경우를 한 줄 더하면 좋다

- release notes는 "퇴역한 알림이 늦게 도착하면 … hook이 모델 요청 전에 막습니다"를 일반 규칙으로 적는다.
- 사용자가 체감하는 변화는 O1 순서에서의 차이다. 잠자기나 재부팅 뒤 복귀해 옛 marker가 먼저 오면, 2.7.4의 빈 모델 턴 대신 막힌 marker가 보인다. 본문은 새 wake로 전달된다.
- 선택 사항으로, "동작 변화" 절에 이 경우를 명시할 수 있다.

## NOT_RUN / NOT_VERIFIABLE

- Windows 실행과 실제 host(Codex)의 queue 재제출 순서: 환경이 없다. 잠자기 복귀는 실제 broker와 packaged hook으로 세 순서를 재현했지만, host가 실제로 어느 순서로 보내는지는 확인하지 않았다.
- 이 PC의 운영 DB: 없다. 같은 모양의 fixture로 판단했다.
- CI(`3501e7c5`의 GitHub Actions): 이 감사에서 조회하지 않았다.
- `pnpm source:verify`: 삭제된 외부 저장소 때문에 NOT_VERIFIABLE이다.
- 시계가 되돌아가는 환경: 확인하지 않았다(release notes에도 한계로 적혀 있다).

## 가림(redaction)

`harness/redact.py`를 적용했다. 규칙은 토큰 패턴, 이메일, 사용자명 경로, `/[REDACTED-HOME]`, IP, URL 안의 GitHub 계정명, 계정명 문자열, Windows 사용자 홈 경로다. 건수는 `meta.json`에 있다. `SHA256SUMS`는 커밋된 blob 기준이다. harness의 경로도 함께 가려졌으므로, 다시 실행하려면 경로를 되돌려야 한다.

## 산출물

- `audit/REPORT.md`, `audit/meta.json`, `audit/SHA256SUMS`
- `audit/logs/`: 전체 검증, 10회 반복, previous-broker 다섯 버전, mutant(`mutants/`), probe 결과, 반례, NULL·legacy, 운영 DB 비교, 느린 runner 흉내, T-1 실제 대기, writer evidence 체크섬
- `audit/harness/`: `run-full.sh`, `mutants.py`(writer 6종과 감사자 6종), `v275-audit.test.ts`, `opdb.ts`, `nullrow.ts`, `counterexample.ts`, `clockshift.mjs`, `redact.py`, `make-meta.sh`
