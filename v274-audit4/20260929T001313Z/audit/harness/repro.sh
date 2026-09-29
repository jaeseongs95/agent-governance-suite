#!/bin/bash
# Audit 4 reproduction steps, as run (inline) during the audit. Worktrees: 0135326a and b31da778, both with node_modules.
# 1) Broker clock shift: clockshift.mjs makes only the broker process see the wall clock +SHIFT ms (a slow runner between
#    seeding and the broker's judgement). The test process and client keep the real clock.
#      AGS_AUDIT_CLOCK_SHIFT_MS=25000 NODE_OPTIONS="--import $PWD/clockshift.mjs" \
#        pnpm exec vitest run tests/session-messaging/presence-retention.test.ts tests/session-messaging/presence-batches.test.ts
#    Sweep: same env over tests/session-messaging tests/session-board, and previous-broker.test.ts with AGS_PREVIOUS_BROKER_PATH.
#    Threshold: shifts 5000..21000 on session-message.test.ts -t "blocks only verified empty Codex wake prompts".
# 2) Real wait (no clock change): a temporary copy tests/audit/presence-retention-realwait.test.ts inserts
#      await new Promise((resolve) => setTimeout(resolve, 20_000));
#    right after `expect(largeFixture(...)).toEqual({ rows: 1302, identities: 342 });`, run with -t "342-identity", then deleted.
#    Hook test: session-message.test.ts temporarily got
#      if (scenario === "submitted") await new Promise((resolve) => setTimeout(resolve, Number(process.env.AGS_AUDIT_WAIT_MS ?? 0)));
#    before `const output = await invoke();`, run with AGS_AUDIT_WAIT_MS=18000 and 21000 and --testTimeout=120000,
#    then restored with `git checkout --`.
# 3) Phase timing: a temporary copy tests/audit/phase.test.ts appends "[phase] seeded|broker-ready|listed <ms>" to
#    logs/phase-timing.log around largeFixture, waitForSessionMessageBrokerReady and listPresence; deleted after.
# 4) prune-cost: tsx script seeding the same 1302-row fixture (counting write calls) and timing store.prune twice.
echo "see comments"
