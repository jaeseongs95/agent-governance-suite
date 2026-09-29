#!/bin/bash
# usage: cond-run.sh <num> <label> <worktree> <full:0|1> [VAR=VAL ...]
set -u
N=$1; L=$2; WT=$3; FULL=$4; shift 4
export PATH=/tmp/nodes/node-v24.21.0-linux-x64/bin:/usr/bin:/bin COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
for kv in "$@"; do export "$kv"; done
cd "$WT" || exit 1
H() { echo "# label=$L node=$(node -v) cwd=$PWD LANG=${LANG-unset} LC_ALL=${LC_ALL-unset} TZ=${TZ-unset} HOME=$HOME date=$(date)"; echo "# node Intl: $(node -e 'console.log(Intl.DateTimeFormat().resolvedOptions().locale, Intl.DateTimeFormat().resolvedOptions().timeZone, new Date(0).toString())')"; }
if [ "$FULL" = 1 ]; then
  { H; corepack enable; pnpm -v; pnpm install --frozen-lockfile; echo EXIT=$?; } > /tmp/ev/${N}a-$L-install.log 2>&1; tail -1 /tmp/ev/${N}a-$L-install.log
  { H; pnpm build; echo EXIT=$?; git status --porcelain; echo "PORCELAIN_LINES=$(git status --porcelain | wc -l)"; } > /tmp/ev/${N}b-$L-build.log 2>&1; grep -E '^EXIT|PORCELAIN' /tmp/ev/${N}b-$L-build.log
fi
{ H; pnpm test --reporter=default --reporter=json --outputFile.json=/tmp/ev/${N}c-$L-test.json; echo EXIT=$?; } > /tmp/ev/${N}c-$L-test.log 2>&1; grep -E '^EXIT|Tests  |^ FAIL' /tmp/ev/${N}c-$L-test.log
{ H; node /tmp/ev/scripts/mcp-probe.mjs mcp-server/dist/server.mjs "$WT"; echo EXIT=$?; } > /tmp/ev/${N}d-$L-mcp-probe.log 2>&1; grep -E 'TOOLS_COUNT|PROBE_RESULT' /tmp/ev/${N}d-$L-mcp-probe.log
{ git status --porcelain; echo "PORCELAIN_LINES=$(git status --porcelain | wc -l)"; } > /tmp/ev/${N}e-$L-final-clean.log 2>&1; tail -1 /tmp/ev/${N}e-$L-final-clean.log
