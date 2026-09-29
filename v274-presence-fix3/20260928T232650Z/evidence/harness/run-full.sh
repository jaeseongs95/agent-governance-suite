#!/bin/bash
export PATH=/opt/node24/bin:$PATH
cd /home/[REDACTED]/agent-governance-suite
L=/tmp/claude-0/-home-user-agent-governance-suite/d12fc7a7-9717-5ea2-a8f9-25ec60e52e75/scratchpad/ev274fix3/logs
: > $L/full-summary.tsv
i=0
run() { i=$((i+1)); n=$(printf "%02d" $i); name=$1; shift; "$@" > $L/full-$n-$name.log 2>&1; c=$?; printf "%s\t%s\t%s\n" "$n" "$*" "$c" >> $L/full-summary.tsv; }
run install pnpm install --frozen-lockfile
run bundle-check pnpm bundle:check
run claude-drift pnpm claude:drift
run lint pnpm lint
run build pnpm build
run test pnpm test
run runtime-check pnpm runtime:check
run validate-all pnpm validate:all
run validate-official pnpm validate:official
run claude-build pnpm claude:build
run claude-check pnpm claude:check
run source-check pnpm source:check
run diff-check git diff --check
git status --porcelain > $L/full-post-status.txt
