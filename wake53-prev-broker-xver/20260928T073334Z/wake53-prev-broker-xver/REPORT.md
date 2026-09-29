# wake53-prev-broker-xver — previous-broker compatibility and mixed-version experiments

- Target: `53eff30a2984d41fc749d38dd2062966017684fa` (tree `c030fa4e19411ef511c5d5c89cf588aa6f42c059` confirmed), branch `codex/v2711-codex-empty-wake`
- Baseline: v2.7.1 = `d5c5932c` (= origin/main). Other previous tags: v2.7.0 (`41e056a4`), v2.6.0 (`5479f4eb`, broker byte-identical to v2.7.0), and v2.2.6 (`863ed7ac`). I added v2.2.6 because it is the last release without the `deferred-boundary` capability, which the test asserts on.
- Node v24.21.0 (checked against SHASUMS256), pnpm 11.19.0. For every worktree, `pnpm install --frozen-lockfile`, `bundle:check` and `build` returned EXIT=0 (logs 03–07), and `git status` stayed clean (log 82).
- Scope: I ran this once in a disposable Linux cloud container. It is **not** evidence about the user's PC or live installs. No source, test or config was modified. The experiment scripts are in `scripts/`.
- Verdicts: PASS / FAIL / UNKNOWN / NOT_RUN. "Observed" means within the run as logged. A clock-shift preload (`scripts/clock-shift.mjs`, `node --import`) simulates time passing for the broker process only.

## 1. `tests/session-messaging/previous-broker.test.ts` actually executed (not skipped)

`AGS_PREVIOUS_BROKER_PATH` expects the path to a released `mcp-server/dist/session-message-broker.mjs` file. The test spawns it with `node <file> --state-directory <dir>`.

| Broker (AGS_PREVIOUS_BROKER_PATH) | Result (JSON) | First failure | Log |
|---|---|---|---|
| unset | skipped | – | 14 |
| v2.7.1 | **FAIL** (executed) | `expected [ 'atomic-wake-claim', …(3) ] to not include 'deferred-boundary'` | 10 |
| v2.7.0 | **FAIL** (executed) | same | 11 |
| v2.6.0 | **FAIL** (executed) | same | 12 |
| v2.2.6 | **PASS** (executed) | – | 13 |

In a soft variant (`scripts/pbv/`) I turned only the capability, status and delivery-attempt assertions into `expect.soft` (diff in log 15). Against v2.7.1, v2.7.0 and v2.6.0 it then fails with `Error: send accepts only sender and the ID returned by prepare; message content is immutable...`. The test calls the pre-v2.6.0 legacy `send {sender,target,messageId,body}`, which brokers from v2.6.0 onward reject. v2.2.6 PASS (logs 15–18).

**Conclusion (observed):** the test only validates against pre-v2.3.0 brokers. Pointed at the actual previous release (v2.7.1), it fails on test assumptions, not on a message-loss defect. The test's full name is `preserves queued messages when new hooks meet the previous released broker`.

## 2. Mixed-version scenarios

"Hook"/"CLI" means the version's `dist/session-message-hook.mjs` / `dist/session-message-cli.mjs`. "Broker" means the `dist/session-message-broker.mjs` serving the shared state directory. Wake rows were driven through the broker TLS protocol (`presence-start`, `acquire-relay`, `reserve-wake`, `start-wake`, `record-wake-outcome`), as the relay does. Every step has a row and schema dump in `dumps/<scenario>/NN-*.json`.

### (a) 2.7.1 ↔ 53 sessions, bidirectional prepare/send/claim/ACK — **PASS**
- Seeds 101 (initial broker 2.7.1), 202 (53), 303 (2.7.1), and 404 (53, with the old side = 2.7.0). 60 random steps each. Random broker-version swaps happened 2–7 times per seed.
- Each run included: a send issued by the other version than the one that prepared (a session upgraded between prepare and send), a duplicate send by the other version, and an ACK by the other version.
- A concurrent claim race used 12 messages and 6 simultaneous claimer processes of mixed versions.
- Violations: 0. Errors: 0. No duplicate claims, lost messages or double ACKs. Every duplicate send returned `duplicate:true`. Final `integrity_check=ok`, `user_version=0` (logs 21-*, `dumps/a-*/summary.json`).

### (b) 2.7.1 leaves unACKed message + wake row, then replaced by 53

W = writer, B = broker after the swap, H = hook after the swap. The "next" column is whether a fresh managed wake could be reserved afterwards. The "active at end" column includes the new wake created by "next" (by design).

| Variant | W→B/H | Arrival of pre-swap marker | Duplicate arrival | Next wake | Verdict |
|---|---|---|---|---|---|
| submitted / unknown / started | 2.7.1→53/53, 53/2.7.1, 2.7.1/53 (and controls) | body delivered once | `{}` (no redelivery) | dispatch | PASS |
| reserved (never started) | every combination incl. pure 53 | `{}` (not recognized) | `{}` | no (the row stays `reserved`; the relay resume path was not exercised) | UNKNOWN (not mixing-specific; same in pure 53) |
| empty wake (body already ACKed) | 2.7.1→53/53 | `decision:block` | `{}` | dispatch | PASS |
| empty wake | 2.7.1→53 broker / 2.7.1 hook | `{}` (no block) | `{}` | dispatch | **FAIL** vs the 53 intent (38bd227 block is lost) |
| empty wake | 2.7.1 broker (still running) / 53 hook | `{}` (no block: the 2.7.1 broker returns no `managed` field) | `{}` | dispatch | **FAIL** vs the 53 intent |
| late-latched (2.7.1 old-generation arrival → `unknown`+`late_observed_at`) | 2.7.1→53/53 and 53/2.7.1 | – | – | **no** (blocked right after upgrade and for a fresh message); body still reachable via native input + PostToolUse | **FAIL** (blocking row) |
| late-latched | the same, after replaying the old marker through a 53 broker | – | – | dispatch; the new wake delivers the body | the row retires only on re-observation |
| late-latched | 2.7.1→2.7.1 broker/53 hook | – | – | no, even after replay | FAIL (2.7.1 behaviour persists while the old broker runs) |
| late-latched control | 53 only | – | – | dispatch | PASS |
| lease (2.7.1 claim with no ACK, swap, lease wait 125 s) | 2.7.1→53/53 | – | – | – | PASS: redelivered with deliveryAttempt=2, ACK=1, no loss |

**Expiry check** for the late-latched row (logs 62–66, `dumps/b-expiry-*`):

| Writer→broker | Clock offset | New wake | Row at end |
|---|---|---|---|
| 2.7.1→53 | 0 | no | `unknown`+late |
| 2.7.1→53 | +2 h | no | `unknown`+late |
| 2.7.1→53 | +25 h | no | `unknown`+late (expires_at already passed; the pre-swap acked message was pruned, which confirms the shift took effect) |
| 2.7.1→2.7.1 | +2 h | no | same |
| 53→53 | +2 h | yes | – |

### (c) Downgrade: 53-built state reopened by an older broker, hook and CLI, then by 53 again

53 built a state containing: an `observed`+late row, a `submitted` row, a claimed-but-not-ACKed message, a queued message and a draft.

| Downgrade to | Opens | Schema change | Old CLI sends the 53 draft | Old hook on 53 wake | Loss or duplicate | Back on 53 | Verdict |
|---|---|---|---|---|---|---|---|
| 2.7.1 | yes | none | OK | body delivered | none | no active leftover; new wake OK (+0 and +25 h) | PASS |
| 2.7.0 | yes (no managed-wake ops: `wake-status` returns `Unknown broker operation.`) | none | OK | body delivered through the legacy path | none | a 53 `submitted` row stays active; new wake **no** at +0 and +25 h (`observation-overdue`) | **FAIL** (blocking row) |
| 2.2.6 | yes | none (unknown columns ignored) | `Session identity is required.` (pre-prepare API) | body delivered | none observed | schema round trip unchanged | UNKNOWN (API incompatible; the client flow was only partly exercised) |

Control (logs 77–80): in pure 53 **and** pure 2.7.1, a `submitted` wake whose marker never reaches the host also blocks new wakes, even with a new presence instance and at +25 h. So the unretired-active-row mechanism is pre-existing. Mixing adds two new ways to create such a row: 2.7.1 late-latching and delivery by a 2.7.0 hook.

### (d) Two broker versions at once: lock, schema, user_version — **PASS for what was observed**
- **Sequential start (d1):** with 2.7.1 serving, starting a 53 broker exits 0 (`already-running`). Endpoint and lock pid are unchanged, and the lock is removed on stop. The reverse, 2.2.6→53 and 53→2.2.6 all behave the same. Across 2.2.6↔53, clients cannot talk to the other broker: `Unknown broker operation.` / `Unsupported session message operation.`
- **Start races (d2):** seeds 1–10, each with 6 simultaneous mixed-version starts, fresh and with a stale lock (pid 999999). That is 20 races. Each time exactly 1 broker survived, the endpoint owner equalled the lock pid, a message round trip worked, lock and endpoint were cleaned up, and integrity was ok. The lock's read-then-remove TOCTOU window was **not** hit; it is not proven absent.
- **Schema (d3):** 2.7.1 and 53 create identical schemas (`schema_version` 25). 53 migrates schemas created by 2.7.0 and 2.6.0 (`schema_version` 10→25) to exactly the 53 fresh schema. A 2.2.6-created DB is migrated additively (`schema_version` 28, equivalent columns, different SQL text). A later reopen by 2.7.1 changes nothing. `user_version` = 0 everywhere, so no version gate exists. Integrity was ok in every dump.

## 3. Implications for the user's upgrade procedure (observation-based only)
1. A still-running old broker keeps serving new 53 hooks until it idles out (IDLE_EXIT_MS = 60 s). Until then, 53's empty-wake block and cross-generation retirement do not apply (b: 2.7.1 broker/53 hook). Stopping the old broker after the install makes the 53 fixes effective at once.
2. Late-latched rows (`unknown` + `late_observed_at`) created by 2.7.1 are **not** retired by upgrading. They kept blocking managed wakes for that host+sessionId through +25 h. The session still receives the body through the native input / PostToolUse path. Before or after the upgrade, check `wake_nonces` for `state IN ('reserved','started','submitted','unknown')`. Any such row with `late_observed_at` set, or with `expires_at` in the past, blocks wakes for that session.
3. Downgrading from 53 to 2.7.1 did not lose, duplicate or corrupt anything. Downgrading to 2.7.0 or older leaves 53 `submitted` rows unretired, which blocks later wakes. Downgrading to 2.2.6 breaks the client API.
4. Schema and user_version gave no reason to back up or migrate between 2.7.1 and 53: the schemas are identical and `user_version` is unused.

## 4. Invariant violations
- V1 `preserves queued messages when new hooks meet the previous released broker`: FAIL against v2.7.1, v2.7.0 and v2.6.0. Test-assumption failure; see repro R1.
- V2 Permanent blocking row: 2.7.1-latched late row after upgrade to 53. Deterministic, no seed. Repro R2: `scripts/scen-b-expiry.mjs 2.7.1 53 90000000`, dumps `dumps/b-expiry-w2.7.1-b53-off90000000/`.
- V3 Permanent blocking row after a 53→2.7.0→53 round trip. Deterministic. Repro R3.
- V4 The empty-wake block is lost when hook and broker versions are mixed. Deterministic. Repro R4.
- No message loss, duplicate delivery, schema corruption or integrity failure was observed in any scenario.

## NOT_RUN / UNKNOWN
- Windows: NOT_RUN (Linux only).
- A real Codex / Claude host, a real relay process with `resume` of a `reserved` row: NOT_RUN. The `reserved` row outcome is UNKNOWN.
- The lock TOCTOU (two brokers alive at once): not reproduced in 20 races. UNKNOWN.
- Real multi-hour wall-clock runs: not run. I used the clock-shift preload for the broker process only.
