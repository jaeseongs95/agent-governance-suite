# 반증 비교 (기준 d5c5932c + 후보 테스트 파일 vs 후보 53eff30a)

## 결과가 다른 테스트 (4)

| 전체 이름 | 파일:줄 | 기준 | 후보 | 기준 실패 assertion 요지 |
|---|---|---|---|---|
| TLS 1.3 broker and vendor-neutral adapter blocks only verified empty Codex wake prompts in the packaged hook | tests/session-messaging/session-message.test.ts:1172 | failed | passed | AssertionError: expected {} to match object { decision: 'block' } ⏎     at Proxy.<anonymous> (file:///tmp/base/node_modules/.pnpm/vitest@5.0.0_@types+node@26.5.0_vite@8.2.2_@types+node@26.5.0_esbuild@0.28.2_tsx@4.23.13_/node_modules/vitest/dist/chunks/index.OVGXnVRj.js:2040:10) ⏎     at Proxy.<anonymous> (file:///tmp/base/node_modules/.pnpm/vitest@5.0.0_@types+node@26.5.0_vite@8.2.2_@types+node@26.5.0_esbuild@0.28.2_tsx@4.23.13_/node_modules/vitest/dist/chunks/index.OVGXnVRj.js:1934:14) |
| W05-r2 observation holds the SQLite generation lock and notices a generation change during verification | tests/session-messaging/wake-lifecycle.test.mjs:200 | failed | passed | AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: ⏎ + actual - expected ⏎  |
| verified expired/old-generation arrival retires only its attempt before a separate current wake | tests/session-messaging/wake-lifecycle.test.mjs:250 | failed | passed | AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: ⏎ + actual - expected ⏎  |
| verified old arrival in another process releases only the old attempt and permits one new effect | tests/session-messaging/wake-lifecycle.test.mjs:413 | failed | passed | AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: ⏎ + actual - expected ⏎  |

## 전체 (99)

| 전체 이름 | 파일:줄 | 기준 | 후보 | 기준 실패 assertion 요지 |
|---|---|---|---|---|
| session message spool keeps stable IDs until ACK, enforces limits, and recovers stale relay leases | tests/session-messaging/session-message.test.ts:130 | passed | passed |  |
| session message spool applies caller claim budgets before leasing messages | tests/session-messaging/session-message.test.ts:168 | passed | passed |  |
| session message spool rejects newline, control, and unsafe host or session identifiers | tests/session-messaging/session-message.test.ts:181 | passed | passed |  |
| session message spool allows only one unconsumed wake and suppresses wakes during a live claim | tests/session-messaging/session-message.test.ts:199 | passed | passed |  |
| session message spool expires an unconsumed wake after one hour independently of message TTL | tests/session-messaging/session-message.test.ts:233 | passed | passed |  |
| session message spool tracks portable presence generations and derives lifecycle state from the lease | tests/session-messaging/session-message.test.ts:251 | passed | passed |  |
| session message spool does not let an explicit stale presence end offline the current generation | tests/session-messaging/session-message.test.ts:281 | passed | passed |  |
| session message spool exposes presence lifecycle through vendor-neutral broker operations | tests/session-messaging/session-message.test.ts:300 | passed | passed |  |
| session message spool leaves queued messages intact when an older broker rejects a new operation | tests/session-messaging/session-message.test.ts:328 | passed | passed |  |
| session message spool locks claim selection before a competing connection can reserve a wake | tests/session-messaging/session-message.test.ts:337 | passed | passed |  |
| session message spool keeps a recognized wake latched until claim consumes it atomically | tests/session-messaging/session-message.test.ts:376 | passed | passed |  |
| session message spool caps the unacknowledged spool and expires messages | tests/session-messaging/session-message.test.ts:397 | passed | passed |  |
| session message spool keeps delivery receipt metadata stable across lease redelivery and stops after ACK | tests/session-messaging/session-message.test.ts:409 | passed | passed |  |
| session message spool atomically verifies a session-bound wake before claiming and rejects reuse or mismatch | tests/session-messaging/session-message.test.ts:424 | passed | passed |  |
| session message spool allows one wake claim across two concurrent SQLite connections | tests/session-messaging/session-message.test.ts:449 | passed | passed |  |
| session message spool defers one boundary, then keeps claiming new and redelivered messages until a new native input | tests/session-messaging/session-message.test.ts:487 | passed | passed |  |
| session message spool migrates legacy messages without inventing unknown first-delivery evidence | tests/session-messaging/session-message.test.ts:519 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter fails fast on broker exit and leaves deadline cleanup to the state-directory owner | tests/session-messaging/session-message.test.ts:541 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter converges simultaneous startup requests on one broker | tests/session-messaging/session-message.test.ts:564 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter returns at the startup deadline while state preparation is still blocked and never spawns afterward | tests/session-messaging/session-message.test.ts:576 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter handles a state-preparation rejection that arrives after the startup deadline | tests/session-messaging/session-message.test.ts:598 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter preserves the top-level deadline reason when the event loop resumes after expiry | tests/session-messaging/session-message.test.ts:623 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter enforces an absolute request deadline while a TLS peer keeps sending partial data | tests/session-messaging/session-message.test.ts:638 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter rejects a reused PID when its process-start token changes | tests/session-messaging/session-message.test.ts:679 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter parses merged wake bells without hiding mixed user text | tests/session-messaging/session-message.test.ts:688 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter maps vendor input once and keeps mixed user text as a user-input observation | tests/session-messaging/session-message.test.ts:699 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter keeps injection and idle wake as separate arbitrary-host capabilities | tests/session-messaging/session-message.test.ts:719 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter denies observed subagents before session-bound message calls and binds collaboration validation observations | tests/session-messaging/session-message.test.ts:727 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter treats merged wake bells as internal only when every nonce is broker-recognized | tests/session-messaging/session-message.test.ts:752 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter backs off definite wake submission failures without exceeding ten minutes | tests/session-messaging/session-message.test.ts:794 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter keeps Codex wake deferred by default and makes visible queue wake explicit | tests/session-messaging/session-message.test.ts:798 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter resolves plugin queue settings only after explicit ENV and only for Codex | tests/session-messaging/session-message.test.ts:808 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter disables malformed plugin queue settings 0 with a bounded diagnostic | tests/session-messaging/session-message.test.ts:? | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter disables malformed plugin queue settings 1 with a bounded diagnostic | tests/session-messaging/session-message.test.ts:? | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter disables malformed plugin queue settings 2 with a bounded diagnostic | tests/session-messaging/session-message.test.ts:? | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter disables malformed plugin queue settings 3 with a bounded diagnostic | tests/session-messaging/session-message.test.ts:? | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter disables malformed plugin queue settings 4 with a bounded diagnostic | tests/session-messaging/session-message.test.ts:? | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter disables malformed plugin queue settings 5 with a bounded diagnostic | tests/session-messaging/session-message.test.ts:? | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter disables malformed plugin queue settings 6 with a bounded diagnostic | tests/session-messaging/session-message.test.ts:? | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter disables malformed plugin queue settings 7 with a bounded diagnostic | tests/session-messaging/session-message.test.ts:? | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter disables malformed plugin queue settings 8 with a bounded diagnostic | tests/session-messaging/session-message.test.ts:? | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter bounds plugin queue settings by bytes, permits false, and rejects read errors and relative paths | tests/session-messaging/session-message.test.ts:842 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter uses one plugin queue profile for packaged presence and relay until the next SessionStart | tests/session-messaging/session-message.test.ts:872 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter releases Codex wake reservations only for definite submission failures | tests/session-messaging/session-message.test.ts:927 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter retains Claude wake reservations whenever the inbox may have accepted bytes | tests/session-messaging/session-message.test.ts:936 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter serializes a Claude wake with next priority through an isolated inbox socket | tests/session-messaging/session-message.test.ts:943 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter does not dispatch a Claude wake when socket is missing | tests/session-messaging/session-message.test.ts:? | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter does not dispatch a Claude wake when token is missing | tests/session-messaging/session-message.test.ts:? | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter does not dispatch a Claude wake when both is missing | tests/session-messaging/session-message.test.ts:? | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter consumes queued peers at safe boundaries after restart without waking again after ACK | tests/session-messaging/session-message.test.ts:976 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter retries only a definitely failed wake whose reservation was released | tests/session-messaging/session-message.test.ts:1001 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter serializes wake reservation and release through the TLS broker | tests/session-messaging/session-message.test.ts:1013 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter stops relay acquisition after three consecutive unknown identity checks | tests/session-messaging/session-message.test.ts:1031 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter does not pass Claude inbox credentials into the broker process | tests/session-messaging/session-message.test.ts:1040 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter pins the certificate, authenticates requests, survives restart, and supports arbitrary hosts | tests/session-messaging/session-message.test.ts:1048 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter blocks only verified empty Codex wake prompts in the packaged hook | tests/session-messaging/session-message.test.ts:1172 | failed | passed | AssertionError: expected {} to match object { decision: 'block' } ⏎     at Proxy.<anonymous> (file:///tmp/base/node_modules/.pnpm/vitest@5.0.0_@types+node@26.5.0_vite@8.2.2_@types+node@26.5.0_esbuild@0.28.2_tsx@4.23.13_/node_modules/vitest/dist/chunks/index.OVGXnVRj.js:2040:10) ⏎     at Proxy.<anonymous> (file:///tmp/base/node_modules/.pnpm/vitest@5.0.0_@types+node@26.5.0_vite@8.2.2_@types+node@26.5.0_esbuild@0.28.2_tsx@4.23.13_/node_modules/vitest/dist/chunks/index.OVGXnVRj.js:1934:14) |
| TLS 1.3 broker and vendor-neutral adapter keeps a maximum-size peer message within the hook context limit | tests/session-messaging/session-message.test.ts:1239 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter escapes peer bodies inside one bounded JSON block | tests/session-messaging/session-message.test.ts:1276 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter losslessly bounds an escape-heavy controls envelope | tests/session-messaging/session-message.test.ts:? | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter losslessly bounds an escape-heavy quotes envelope | tests/session-messaging/session-message.test.ts:? | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter losslessly bounds an escape-heavy backslashes envelope | tests/session-messaging/session-message.test.ts:? | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter starts the relay without spending a second claim budget during SessionStart | tests/session-messaging/session-message.test.ts:1331 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter leaves Codex Stop messages queued for a supported context event | tests/session-messaging/session-message.test.ts:1352 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter does not register an unsupported Codex Stop context hook | tests/session-messaging/session-message.test.ts:1372 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter keeps packaged hook and relay entrypoints isolated | tests/session-messaging/session-message.test.ts:1381 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter keeps Claude Code Stop context delivery enabled | tests/session-messaging/session-message.test.ts:1395 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter binds message tools to host hook identity | tests/session-messaging/session-message.test.ts:1412 | passed | passed |  |
| TLS 1.3 broker and vendor-neutral adapter does not speak plaintext on the loopback port | tests/session-messaging/session-message.test.ts:1422 | passed | passed |  |
| session message MCP tools reports an overlong Unicode body as INVALID_INPUT before broker access | tests/session-messaging/session-message.test.ts:1460 | passed | passed |  |
| session message MCP tools validates bound send, status, and acknowledgement calls | tests/session-messaging/session-message.test.ts:1470 | passed | passed |  |
| W05-r2 body claim and ACK cannot authorize another unobserved managed wake | tests/session-messaging/wake-lifecycle.test.mjs:44 | passed | passed |  |
| W05-r2 board ownership check has no nonce state effect | tests/session-messaging/wake-lifecycle.test.mjs:54 | passed | passed |  |
| W05-r2 claimDeferred and ACK leave the managed notification fenced | tests/session-messaging/wake-lifecycle.test.mjs:? | passed | passed |  |
| W05-r2 claimTurnEnd and ACK leave the managed notification fenced | tests/session-messaging/wake-lifecycle.test.mjs:? | passed | passed |  |
| W05-r2 start rechecks claim/ACK and persists no-effect retirement | tests/session-messaging/wake-lifecycle.test.mjs:95 | passed | passed |  |
| W05-r2 claim after start keeps one fence until the actual hook, including an empty batch | tests/session-messaging/wake-lifecycle.test.mjs:105 | passed | passed |  |
| W05-r2 reserved crash recovery keeps the nonce/attempt and rejects replaced lease CAS | tests/session-messaging/wake-lifecycle.test.mjs:119 | passed | passed |  |
| W05-r2 transport remains part of the exact stored attempt binding | tests/session-messaging/wake-lifecycle.test.mjs:131 | passed | passed |  |
| W05-r2 definite failure uses durable backoff and exact dispatch epoch for late results | tests/session-messaging/wake-lifecycle.test.mjs:147 | passed | passed |  |
| W05-r2 unknown survives restart, both TTLs, ordinary claim, ACK and generation replacement | tests/session-messaging/wake-lifecycle.test.mjs:164 | passed | passed |  |
| W05-r2 ordinary peer provenance, expired hook receipts and changed observation digests cannot release a fence | tests/session-messaging/wake-lifecycle.test.mjs:183 | passed | passed |  |
| W05-r2 observation holds the SQLite generation lock and notices a generation change during verification | tests/session-messaging/wake-lifecycle.test.mjs:200 | failed | passed | AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: ⏎ + actual - expected ⏎  |
| W05-r2 lost committed outcome response never dispatches again | tests/session-messaging/wake-lifecycle.test.mjs:217 | passed | passed |  |
| W05-r2 forged nonce, caller approved and normalized observation cannot observe without the hook receipt | tests/session-messaging/wake-lifecycle.test.mjs:233 | passed | passed |  |
| verified expired/old-generation arrival retires only its attempt before a separate current wake | tests/session-messaging/wake-lifecycle.test.mjs:250 | failed | passed | AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: ⏎ + actual - expected ⏎  |
| old-generation retirement still rejects wrong target, unknown or mixed nonces and stale provenance | tests/session-messaging/wake-lifecycle.test.mjs:288 | passed | passed |  |
| W05-r2 batch/ACK-loss redelivery and hook rollback preserve exact nonce consumption | tests/session-messaging/wake-lifecycle.test.mjs:311 | passed | passed |  |
| W05-r2 hook-before-outcome, adapter exception and new vendor use the same core | tests/session-messaging/wake-lifecycle.test.mjs:324 | passed | passed |  |
| W05-r2 both host capabilities preserve submission/observation distinction and deferred idle wake zero | tests/session-messaging/wake-lifecycle.test.mjs:352 | passed | passed |  |
| W05-r2 additive legacy migration never imports old consumed_at as observed | tests/session-messaging/wake-lifecycle.test.mjs:370 | passed | passed |  |
| W05-r2 active budget overflow is an explicit rejection and does not remove unknowns | tests/session-messaging/wake-lifecycle.test.mjs:378 | passed | passed |  |
| W05-r2 terminal observation retention is bounded while unresolved rows are retained | tests/session-messaging/wake-lifecycle.test.mjs:386 | passed | passed |  |
| verified old arrival in another process releases only the old attempt and permits one new effect | tests/session-messaging/wake-lifecycle.test.mjs:413 | failed | passed | AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: ⏎ + actual - expected ⏎  |
| Codex running body claim in another process prevents the external queue call before start | tests/session-messaging/wake-lifecycle.test.mjs:437 | passed | passed |  |
| Codex post-start claim in another process leaves one marker and a verified empty discard | tests/session-messaging/wake-lifecycle.test.mjs:451 | passed | passed |  |
| W05-r2 independent senders and relay processes perform exactly one external call | tests/session-messaging/wake-lifecycle.test.mjs:465 | passed | passed |  |
| W05-r2 independent process crash before start recovers the same attempt; after effect never resends | tests/session-messaging/wake-lifecycle.test.mjs:478 | passed | passed |  |
| W05-r2 independent migration failure rolls back every added nonce column and preserves legacy bytes | tests/session-messaging/wake-lifecycle.test.mjs:494 | passed | passed |  |
| public wake binding requires a fresh presence birth after lease expiry | tests/session-messaging/wake-lifecycle.test.mjs:506 | passed | passed |  |

## 비고
- 기준 실행 = d5c5932c worktree(/tmp/base)에 53eff30a 버전의 tests/session-messaging 변경 3개 파일(fixture 포함)을 복사한 상태. 소스는 기준 그대로.
- "blocks only verified empty Codex wake prompts in the packaged hook"는 시나리오 반복의 첫 항목 `submitted`에서 hook 출력이 `{}`(block 아님)로 실패해 이후 시나리오는 기준에서 실행되지 않았다. 53eff30a에서 새로 추가된 테스트.
- "W05-r2 ..."는 기준에도 같은 이름으로 존재하지만 53eff30a에서 내용이 바뀐 테스트. 나머지 두 wake-lifecycle 테스트는 53eff30a 신규.
- wake-lifecycle 3건 모두 managedWakeStatus(...).state 기대 'observed', 실제 'unknown'.
