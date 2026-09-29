#!/usr/bin/env bash
# Runs the AGENTS.md full validation order, one log per command.
cd /home/[REDACTED]/agent-governance-suite
E=$1
i=10
: > $E/sequence-summary.txt
for cmd in "pnpm install --frozen-lockfile" "pnpm bundle:check" "pnpm claude:drift" "pnpm lint" "pnpm build" "pnpm test" "pnpm runtime:check" "pnpm validate:all" "pnpm validate:official" "git diff --check" "pnpm claude:check"; do
  name=$(echo "$cmd" | tr ' :' '--' | tr -s '-')
  log="$E/$i-$name.log"
  start=$(date -u +%FT%TZ)
  { echo "\$ $cmd"; echo "start=$start head=$(git rev-parse HEAD)"; } > "$log"
  bash -c "$cmd" >> "$log" 2>&1
  code=$?
  echo "exit=$code end=$(date -u +%FT%TZ)" >> "$log"
  echo "$cmd => $code" >> $E/sequence-summary.txt
  i=$((i+1))
done
git status --short > $E/$i-git-status-after.log
