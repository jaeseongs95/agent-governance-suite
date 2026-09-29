#!/usr/bin/env bash
# Full verification rerun on the candidate worktree. Usage: run-full.sh <repo> <logdir>
set -u
export PATH=/opt/node24/bin:$PATH
cd "$1"; L="$2"; mkdir -p "$L"
run() { n="$1"; shift; echo "\$ $*" > "$L/$n.cmd"; "$@" >"$L/$n.stdout.log" 2>"$L/$n.stderr.log"; echo $? > "$L/$n.exit"; echo "$n exit=$(cat $L/$n.exit)"; }
git status --porcelain > "$L/00-status-before.log"; git rev-parse HEAD >> "$L/00-status-before.log"
run 01-install pnpm install --frozen-lockfile
run 02-bundle-check pnpm bundle:check
run 03-claude-drift pnpm claude:drift
run 04-lint pnpm lint
run 05-build pnpm build
run 06-test pnpm test
run 07-runtime-check pnpm runtime:check
run 08-validate-all pnpm validate:all
run 09-validate-official pnpm validate:official
run 10-claude-build pnpm claude:build
run 11-claude-check pnpm claude:check
run 12-git-diff-check git diff --check
run 12b-git-diff-check-range git diff --check 8763cef2b11f2635d6c9af7861b5bffd496e2a30 HEAD
run 13-source-check pnpm source:check
run 14-source-verify pnpm source:verify
git status --porcelain > "$L/15-status-after.log"; echo "status-after lines: $(wc -l < $L/15-status-after.log)"
