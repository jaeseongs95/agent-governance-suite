# 기존 테스트 커버리지 (53eff30a, tree c030fa4e)

W = `tests/session-messaging/wake-lifecycle.test.mjs`, S = `tests/session-messaging/session-message.test.ts`, fixture = `tests/session-messaging/fixtures/managed-wake-process.mjs` (모드: migration-failure, sender, observe-wake, claim-and-ack, relay, crash-before-start(17), crash-after-start(18), crash-after-effect(19)).
W에는 describe 블록이 없고 테스트는 44–512줄에 최상위로 있다. S의 wake 관련 테스트는 `describe("session message spool")`(129–538)과 `describe("TLS 1.3 broker and vendor-neutral adapter")`(540–1437)에 있다. `relayTick`은 두 파일 모두에서 쓰지 않는다(message-lifecycle.test.ts에서만 사용).
라인 번호는 독립 에이전트가 정리하고 W:250, W:288, W:413, W:465, W:478, S:1172를 직접 대조해 확인했다.
불변식 표기: (a) target당 활성 ≤1, (b) 종료 행 재활성 없음, (c) 옛 세대 도착은 그 attempt만 종료, (d) 세대 교체당 새 effect ≤1, (e) nonce/attempt/epoch effect 중복 없음, (f) 늦은 outcome이 종료·late 행을 바꾸지 않음, (g) 근거 없는 unknown 해제 없음.

## wake-lifecycle.test.mjs

| file:line | 테스트 이름 | 연산 순서 | 프로세스 | 세대/TTL | 명시 nowMs | 불변식 |
|---|---|---|---|---|---|---|
| W:44 | W05-r2 body claim and ACK cannot authorize another unobserved managed wake | send→reserve-wake(n1)=true→claim→ACK→send→reserve(n2)=false | 단일 | 같은 세대 | no | a,g |
| W:54 | W05-r2 board ownership check has no nonce state effect | send→reserve→claim→consumeWake=true→consumed_at NULL | 단일 | 같은 세대 | no | g |
| W:64 | W05-r2 %s and ACK leave the managed notification fenced | body→reserve→start→claimDeferred/claimTurnEnd→ACK→body→reserve(n2)=false | 단일 | 같은 세대 | yes | a,g |
| W:95 | W05-r2 start rechecks claim/ACK and persists no-effect retirement | body→reserve→claim→ACK→start=false(not-submitted)→body→reserve(n2)=true | 단일 | 같은 세대 | yes | b,e,a |
| W:105 | W05-r2 claim after start keeps one fence until the actual hook, including an empty batch | body→reserve→start→claim→ACK→outcome(submitted)→reserve(n2)=false→hook(현재)→observed→late outcome=false | 단일 | 같은 세대 | yes | a,b,f,g |
| W:119 | W05-r2 reserved crash recovery keeps the nonce/attempt and rejects replaced lease CAS | reserve(relay-1)→2번째 연결 acquireRelay(relay-2)→resume→start(옛 lease)=false→start=true→재start=false | 단일·2연결 | relay 교체 | yes | a,e |
| W:131 | W05-r2 transport remains part of the exact stored attempt binding | reserve→transport 변경→start=false→복원→start=true→틀린 transport outcome=false | 단일 | transport 교체 | yes | e,f |
| W:147 | W05-r2 definite failure uses durable backoff and exact dispatch epoch for late results | reserve→start→definite-failure→backoff 중 resume=false→30s 후 resume→start(epoch2)→late outcome(epoch1)=false→outcome(unknown) | 단일 | 같은 세대, backoff | yes | a,e,f |
| W:164 | W05-r2 unknown survives restart, both TTLs, ordinary claim, ACK and generation replacement | reserve→start→unknown→prune(TTL 뒤)→legacy reserve=false→instance-2→reserve=false | 단일·2연결 | 메시지·WAKE TTL 경과, 새 instance | yes | g,a (제목과 달리 claim/ACK 호출 없음) |
| W:183 | W05-r2 ordinary peer provenance, expired hook receipts and changed observation digests cannot release a fence | reserve→start→일반 peer receipt/actor 변경/30s 지난 receipt 모두 false→started 유지 | 단일 | receipt TTL 밖 | yes | g,e |
| W:200 | W05-r2 observation holds the SQLite generation lock and notices a generation change during verification | 검증 중 reader가 endPresence 시도→recognized=false, observed | 단일·2연결 | 검증 중 세대 종료 | yes | c(경합) |
| W:217 | W05-r2 lost committed outcome response never dispatches again | dispatchManagedWake(outcome 응답 유실)→재호출=false, port 1회 | 단일 | 같은 세대 | no | e,a |
| W:233 | W05-r2 forged nonce, caller approved and normalized observation cannot observe without the hook receipt | legacy claimWake/consume/release, 빈 receipt, reader 없음, approved:true, 위조 후보 모두 거절→정상 hook→replay=false | 단일 | 같은 세대 | yes | e,g |
| W:250 | verified expired/old-generation arrival retires only its attempt before a separate current wake | {expired,new-instance,same-instance-new-birth}: submitted→claim→ACK→세대 교체→reserve(현재)=false→옛 hook→observed+late→late outcome=false→reserve(현재)=true→start→옛 replay=false→현재 hook 전달 | 단일 | TTL 밖/새 instance/같은 instance 새 birth | yes | a,b,c,d,e,f,g |
| W:288 | old-generation retirement still rejects wrong target, unknown or mixed nonces and stale provenance | unknown→instance-2→mixed/일반 입력/틀린 target/미등록 receipt/30s 지난 receipt 모두 false→unknown 유지 | 단일 | 새 instance | yes | g,c(음성),e |
| W:311 | W05-r2 batch/ACK-loss redelivery and hook rollback preserve exact nonce consumption | 2 bodies→start→budget 오류 rollback→maxMessages 1→replay=false→lease 만료 재전달 | 단일 | 같은 세대 | yes | e,b |
| W:324 | W05-r2 hook-before-outcome, adapter exception and new vendor use the same core | dispatch 중 hook(현재) observed→adapter throw→unknown→3번째 dispatch=false | 단일 | 같은 세대 | no | b,f,g,e |
| W:352 | W05-r2 both host capabilities preserve submission/observation distinction and deferred idle wake zero | capability 매핑, idleWake none이면 요청 0 | 단일 | - | - | e |
| W:370 | W05-r2 additive legacy migration never imports old consumed_at as observed | legacy DB→state legacy, status null | 단일 | - | - | g |
| W:378 | W05-r2 active budget overflow is an explicit rejection and does not remove unknowns | unknown 1000개→reserve 예외→unknown 유지 | 단일 | TTL 경과 | yes | g |
| W:386 | W05-r2 terminal observation retention is bounded while unresolved rows are retained | observed 1005개→prune→1000→TTL 뒤 0 | 단일 | TTL | yes | 직접 없음(제목과 달리 미해결 행 없음) |
| W:413 | verified old arrival in another process releases only the old attempt and permits one new effect | submitted→claim→ACK→instance-2→child observe-wake(옛 hook)→child relay 2개 동시→effect 1 | 자식 3 | 새 instance | no | c,d,e,a |
| W:437 | Codex running body claim in another process prevents the external queue call before start | start 직전 child claim-and-ack→start=false, not-submitted | 자식 1 | 같은 세대 | no | e,a |
| W:451 | Codex post-start claim in another process leaves one marker and a verified empty discard | dispatch 중 child claim-and-ack→submitted→hook 빈 batch observed | 자식 1 | 같은 세대 | no | g,e |
| W:465 | W05-r2 independent senders and relay processes perform exactly one external call | sender 2 + relay 2 동시→effect 1, 활성 1 | 자식 4 | 같은 세대 | no | a,e |
| W:478 | W05-r2 independent process crash before start recovers the same attempt; after effect never resends | crash 3종→대체 relay→같은 attemptId, effect 1/0/1 | 모드당 자식 2 | 같은 세대 | no | e,g,a |
| W:494 | W05-r2 independent migration failure rolls back every added nonce column and preserves legacy bytes | migration 실패 rollback | 자식 1 | - | - | 없음 |
| W:506 | public wake binding requires a fresh presence birth after lease expiry | 21s 뒤 heartbeat=false→startPresence→새 startedAt | 단일 | lease 만료 | yes | 세대 정의 |

## session-message.test.ts (wake 관련)

| file:line | 테스트 이름 | 요약 | 불변식 |
|---|---|---|---|
| S:130 | keeps stable IDs until ACK, enforces limits, and recovers stale relay leases | legacy reserve/consume, 24h 뒤 consume=false | e(legacy) |
| S:199 | allows only one unconsumed wake and suppresses wakes during a live claim | legacy 1개 제한, claim/ACK/lease | a(legacy) |
| S:233 | expires an unconsumed wake after one hour independently of message TTL | legacy WAKE_TTL | g(legacy TTL 해제) |
| S:251 | tracks portable presence generations and derives lifecycle state from the lease | presence 세대/lease | 세대 정의 |
| S:281 | does not let an explicit stale presence end offline the current generation | 옛 instance end가 현재를 끄지 않음 | 세대 정의 |
| S:337 | locks claim selection before a competing connection can reserve a wake | 2연결 lock | a |
| S:376 | keeps a recognized wake latched until claim consumes it atomically | legacy latch | a,e |
| S:424 | atomically verifies a session-bound wake before claiming and rejects reuse or mismatch | legacy claimWake | e |
| S:449 | allows one wake claim across two concurrent SQLite connections | Worker thread 2개 claimWake | e |
| S:752 | treats merged wake bells as internal only when every nonce is broker-recognized | 미발급 nonce 혼합 | e,g |
| S:794/927/936/1001 | backoff·codex/claude outcome·retry 순수 함수 | 순수 함수 | g,e |
| S:976 | consumes queued peers at safe boundaries after restart without waking again after ACK | legacy reopen·boundary | a,e |
| S:1013 | serializes wake reservation and release through the TLS broker | TLS legacy reserve/release | a |
| S:1172 | blocks only verified empty Codex wake prompts in the packaged hook | 9 시나리오(submitted/unknown/duplicate/late/idle/forged/mixed/claude/legacy), 번들 hook spawn | b,c,e,g |

## 기존 테스트가 다루지 않는 조합(이번 fuzz·repro의 표적)

1. 옛 세대에서 `unknown`(accepted-or-unknown)인 attempt에 검증된 도착이 온 뒤 새 effect 1회 → repro G1, fuzz.
2. outcome 전 `started` 상태에서 옛 세대 도착, 이후 outcome 도착 → repro C1, fuzz.
3. 현재 reserve 없이 옛 도착이 먼저 오는 순서, 새 attempt start 이후 옛 도착이 처음 오는 순서(W:250은 replay만) → fuzz.
4. 서로 다른 프로세스의 옛/현재 hook 경합 → fuzz(N=2/4/8).
5. 세대 2회 이상 연속 교체와 여러 세대의 늦은 hook → fuzz(gencross 프로필).
6. 세대 교체를 가로지르는 crash(start 후 kill → 새 birth → 대체 relay) → fuzz(SIGKILL, abandon-after-start/effect).
7. 다른 프로세스에서 오는 늦은 outcome(submitted/unknown/definite-failure) → fuzz(lateOutcome).
8. legacy reserveWake와 managed attempt를 프로세스 사이에서 섞는 경우 → fuzz(legacyReserve, 낮은 가중치).
9. **reserved 상태에서 세대가 바뀌는 경우(start 전 세대 교체, definite-failure backoff 중 세대 교체)는 어떤 테스트에도 없다** → repro H1/H2/H3.
10. W:386은 제목과 달리 미해결 행 보존을 확인하지 않고, W:164도 제목과 달리 claim/ACK를 호출하지 않는다.
11. `relayTick`과 relay loop 전체, 여러 프로세스에 걸친 backoff는 테스트하지 않는다.

## v2.7.1 대비 새 테스트

- W: W:250, W:288, W:413, W:437, W:451 추가. v2.7.1 250줄의 `W05-r2 expired/old-generation hook records only late observation and preserves the current fence`는 제거되었다. v2.7.1은 unknown 유지와 lateObservedAt만 기록했고, 53eff30a는 observed로 종료한다.
- S: S:1172 추가.
- fixture: `observe-wake`, `claim-and-ack` 모드와 relay의 `input.instanceId`가 추가되었다.
