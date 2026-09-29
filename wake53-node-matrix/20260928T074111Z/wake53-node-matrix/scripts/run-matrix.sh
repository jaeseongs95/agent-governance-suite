#!/bin/bash
# usage: run-matrix.sh <nodeVersion> <logPrefixNumber(2digits tens)> <worktreeDir> [label]
set -u
V=$1; N=$2; WT=$3; L=${4:-$V}
SHA=53eff30a2984d41fc749d38dd2062966017684fa
export PATH=/tmp/nodes/node-$V-linux-x64/bin:/usr/local/bin:/usr/bin:/bin
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
REPO=/home/user/agent-governance-suite
LOG() { echo "/tmp/ev/${N}$1-$L-$2.log"; }
run() { local k=$1 name=$2; shift 2; local f; f=$(LOG $k $name); { echo "# cwd=$PWD node=$(node -v) cmd=$*"; echo "# start $(date -u +%FT%TZ)"; } > "$f"; "$@" >> "$f" 2>&1; local rc=$?; echo "# end $(date -u +%FT%TZ)" >> "$f"; echo "EXIT=$rc" >> "$f"; echo "$name EXIT=$rc"; }
if [ ! -d "$WT" ]; then mkdir -p "$(dirname "$WT")"; git -C $REPO worktree add --detach "$WT" $SHA > "$(LOG 0 worktree)" 2>&1; echo "EXIT=$?" >> "$(LOG 0 worktree)"; fi
cd "$WT" || exit 1
{ node -v; corepack --version; corepack enable; echo corepack-enable=$?; pnpm -v; git rev-parse HEAD; git rev-parse HEAD^{tree}; } > "$(LOG 1 env)" 2>&1
run 2 install pnpm install --frozen-lockfile
run 3 bundle-check-prebuild pnpm bundle:check
run 4 build pnpm build
{ git status --porcelain; echo "PORCELAIN_LINES=$(git status --porcelain | wc -l)"; git status --porcelain --ignored=no -uall | head -50; } > "$(LOG 5 postbuild-clean)" 2>&1
run 6 bundle-check pnpm bundle:check
run 7 lint pnpm lint
run 8 test pnpm test --reporter=default --reporter=json --outputFile.json=/tmp/ev/${N}8-$L-test.json
run 9 runtime-check pnpm runtime:check
f=$(LOG 9 mcp); f=${f/-runtime-check/}; f=/tmp/ev/${N}9-$L-mcp-probe.log
{ echo "# cwd=$PWD node=$(node -v)"; node /tmp/ev/scripts/mcp-probe.mjs mcp-server/dist/server.mjs "$WT"; echo "EXIT=$?"; } > $f 2>&1; tail -1 $f
{ git status --porcelain; echo "PORCELAIN_LINES=$(git status --porcelain | wc -l)"; } > /tmp/ev/${N}9-$L-final-clean.log 2>&1
