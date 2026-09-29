#!/usr/bin/env bash
# Minimal reproduction: broker SIGKILL right after claimHostWake's BEGIN IMMEDIATE, broker kept down for
# downMs, hook retries the same claim (same sourceReceiptId) once the broker is back.
#   downMs=35000 (> receipt TTL 30s)  -> claim rejected, attempt stays submitted/unknown, body not delivered   (FAIL b)
#   downMs=25000 / 10000              -> attempt attaches (observed)                                             (PASS b)
# Deterministic kill point: trace event numbers from ref/trace-<ver>.tsv (no seed needed; plan seed recorded in ref/plan-extra-*.json).
set -eu
export PATH=/tmp/node24/bin:$PATH AGS_HOOK_WAIT_MS=60000
DOWN=${1:-35000}
cd /tmp/e9 && node --import tsx /tmp/ev/scripts/orchestrator.mjs "{\"version\":\"e9\",\"worktree\":\"/tmp/e9\",\"dir\":\"/tmp/work/repro-e9-$DOWN\",\"refSchema\":\"/tmp/ev/ref/schema-e9.json\",\"outcome\":\"submitted\",\"spec\":{\"id\":\"repro\",\"mode\":\"event\",\"role\":\"broker\",\"event\":464,\"step\":\"S16-hooks\",\"label\":\"exec:post|BEGIN IMMEDIATE\",\"downMs\":$DOWN}}"
cd /tmp/v53 && node --import tsx /tmp/ev/scripts/orchestrator.mjs "{\"version\":\"53\",\"worktree\":\"/tmp/v53\",\"dir\":\"/tmp/work/repro-v53-$DOWN\",\"refSchema\":\"/tmp/ev/ref/schema-v53.json\",\"outcome\":\"submitted\",\"spec\":{\"id\":\"repro\",\"mode\":\"event\",\"role\":\"broker\",\"event\":350,\"step\":\"S16-hooks\",\"label\":\"exec:post|BEGIN IMMEDIATE\",\"downMs\":$DOWN}}"
