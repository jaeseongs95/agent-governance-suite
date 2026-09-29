# Minimal reproductions (all deterministic; no random seed involved)
Prereq: Node 24 on PATH (`. /tmp/ev/scripts/env.sh`), worktrees /tmp/v53 (53eff30a) and /tmp/prev-v2.7.1 (v2.7.1), /tmp/prev-v2.7.0 (v2.7.0) built.

## R1 previous-broker.test.ts fails against every release >= v2.3.0 (incl. the actual previous release v2.7.1)
    cd /tmp/v53 && AGS_PREVIOUS_BROKER_PATH=/tmp/prev-v2.7.1/mcp-server/dist/session-message-broker.mjs \
      npx vitest run tests/session-messaging/previous-broker.test.ts
    -> AssertionError: expected [ 'atomic-wake-claim', …(3) ] to not include 'deferred-boundary'
    (soft variant /tmp/ev/scripts/pbv: next failure "send accepts only sender and the ID returned by prepare..." = legacy send payload rejected since v2.6.0)
    Passes only with v2.2.6 broker (/tmp/prev-v2.2.6/...).

## R2 v2.7.1-latched old-generation wake row survives upgrade to 53 and blocks managed wake for that session (observed through +25h)
    cd /tmp/ev/scripts && node scen-b-expiry.mjs 2.7.1 53 90000000
    -> newWakeDispatch=false; wake_nonces row state='unknown', late_observed_at set, expires_at in the past (dump 01/02 in dumps/b-expiry-w2.7.1-b53-off90000000/)
    control: node scen-b-expiry.mjs 53 53 7200000 -> newWakeDispatch=true
    releases only if the same old marker is re-observed by a 53 broker (scen-b.mjs late-latched 2.7.1 53 53: afterReplay dispatch=true)

## R3 53 -> 2.7.0 -> 53 round trip leaves a 53 'submitted' wake row unretired (2.7.0 hook delivers the body without touching managed rows)
    cd /tmp/ev/scripts && node scen-c.mjs 2.7.0 && node scen-c2.mjs c-down-2.7.0 90000000
    -> newWakeDispatch=false, observation='observation-overdue'. Same with 2.7.1 instead of 2.7.0 -> dispatch=true.
    NOTE control (scen-ctl.mjs 53 90000000): pure 53 also latches a 'submitted' row whose marker never arrives -> dispatch=false. Base design, not mixing-specific.

## R4 mixed hook/broker loses the 38bd227 "verified empty Codex wake" block
    cd /tmp/ev/scripts && node scen-b.mjs empty-wake 2.7.1 53 2.7.1   # 2.7.1 hook + 53 broker -> {} (no block)
    cd /tmp/ev/scripts && node scen-b.mjs empty-wake 2.7.1 2.7.1 53   # 53 hook + 2.7.1 broker (no `managed` field) -> {} (no block)
    cd /tmp/ev/scripts && node scen-b.mjs empty-wake 2.7.1 53 53      # -> {"decision":"block"}
