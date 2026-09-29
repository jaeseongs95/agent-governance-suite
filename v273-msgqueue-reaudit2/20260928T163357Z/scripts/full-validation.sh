#!/usr/bin/env bash
# Full validation in the required order; one log + exit code per command.
export PATH=/opt/node24/bin:$PATH
cd "${1:?worktree}"
OUT="${2:?logdir}"
mkdir -p "$OUT"
: > "$OUT/exit-codes.tsv"
run() { local name="$1"; shift; local start=$(date -u +%FT%TZ); "$@" > "$OUT/$name.log" 2>&1; local rc=$?; echo -e "$name\t$rc\t$start\t$(date -u +%FT%TZ)" >> "$OUT/exit-codes.tsv"; }
run 01-install pnpm install --frozen-lockfile
run 02-bundle-check pnpm bundle:check
run 03-claude-drift pnpm claude:drift
run 04-lint pnpm lint
run 05-build pnpm build
git status --porcelain > "$OUT/05b-git-status-after-build.txt"
run 06-test pnpm test
run 07-runtime-check pnpm runtime:check
run 08-validate-all pnpm validate:all
run 09-validate-official pnpm validate:official
run 10-claude-build pnpm claude:build
git status --porcelain > "$OUT/10b-git-status-after-claude-build.txt"
run 11-claude-check pnpm claude:check
run 12-git-diff-check git diff --check
git status --porcelain > "$OUT/12b-git-status-final.txt"
echo done > "$OUT/DONE"
