# Step 2 — 2.7.1 회귀 재현 절차 (코드 근거)

대상: 2.7.1 = d5c5932 (/tmp/v271), 후보 = 53eff30a (/tmp/v53, tree c030fa4e…). 전체 diff: `08-diff-271-53.patch`.

## 스키마
- 두 버전 `SessionMessageStore` 생성자(session-message-store.ts:128-247)는 동일. wake_nonces 추가 열 migration(:230-239)과 부분 unique index `wake_active_target ... WHERE state IN ('reserved','started','submitted','unknown')`(:240-241)도 같다. 53eff30a는 스키마를 바꾸지 않는다(diff에 store 생성자 변경 없음).

## 2.7.1에서 새 세대 wake가 막히는 경로
1. 한 target에 활성 행(reserved/started/submitted/unknown)이 있으면 `reserveManagedWake`는 새 행을 만들지 않는다(v271 store.ts:722-737, `if (active) {...}`). 새 행 INSERT는 `else if (wakeBindingCurrent && wakeClaimable)` 분기(:738)에서만. unique index(:240)도 두 번째 활성 행을 금지한다.
2. 옛 세대 활성 행이 풀리는 경로는 `claimHostWake`뿐(ACK/claim/prune은 활성 managed 행을 지우지 않음; prune :253-265는 legacy·observed·not-submitted만 삭제).
3. 2.7.1 `claimHostWake`(:815-856): row의 instance_id·birth_generation·transport가 현재 presence와 다르거나 expires_at 경과면 `valid=false`(:831-834) → `late_observed_at` 설정 + `state='unknown'`(:835-838). 즉 검증된 옛 도착도 행을 활성 상태 unknown에 영구히 남긴다 → 새 세대 reserve 영구 차단.
4. started 상태에서 dispatcher가 죽고 세대가 바뀌면 reserve가 started→unknown으로 바꾸기만 한다(:725-728) → 여전히 활성.
5. `recordManagedWakeOutcome`(:782-797)는 late_observed_at 있는 행을 거절하므로 늦은 결과로도 풀리지 않는다.
- 2.7.1 테스트 근거: wake-lifecycle.test.mjs:164-182 ('unknown survives ... generation replacement' → 새 세대 reserve dispatch=false), :200-214 (세대 변경 후 관측 → state 'unknown').

## 53eff30a 변경 (store.ts:816-856)
- `!valid`일 때 옛/만료 행을 `state='observed'`, consumed_at/observed_at/late_observed_at 설정(:836-841), 결과는 recognized:false, messages 없음, binding null. → 활성 fence 해제, 새 세대는 별도 reserve/start.
- managedWakeStatus(:803-813): observed 우선 표시.
- 이 변경은 **새 hook 도착이 있을 때만** 동작한다. 이미 2.7.1이 `unknown + late_observed_at`으로 바꿔 둔 행은 같은 marker가 다시 도착하지 않는 한(원 receipt TTL 30s, wake-port.ts recordWakeHookObservation) 53eff30a에서 풀릴 코드 경로가 없다. open/migration 시 재분류 코드 없음.
- 53 테스트 근거: wake-lifecycle.test.mjs:250-286 (옛 세대 검증 도착 → observed → 새 reserve true), :288-309 (mixed/wrong target/unregistered receipt/stale receipt는 종료 근거 아님, unknown 유지).

## 재현 target 설계 (한 DB, target별 유형)
| target | 2.7.1 조작 | 기대 2.7.1 결과 |
|---|---|---|
| T1-gen-unknown | 세대1 accepted-or-unknown → 세대2 presence → 새 body | 새 reserve 차단 |
| T2-gen-submitted | 세대1 submitted → 세대2 | 새 reserve 차단 (53에서 검증 옛 도착 재생 대상) |
| T3-late-unknown | 세대1 submitted → 세대2 → 검증된 옛 hook 도착(2.7.1이 처리) | unknown+late_observed_at, 새 reserve 차단 |
| T4-started-crash | 세대1 started(결과 없음) → 세대2 → reserve 시도 | started→unknown, 차단 |
| T5-ttl-unknown | 같은 세대, unknown, WAKE_TTL 경과(관측 없음) | observation-overdue, 차단 |
| T6-ttl-late | 같은 세대 submitted, TTL 경과 후 검증 도착(2.7.1) | unknown+late, 차단 |
