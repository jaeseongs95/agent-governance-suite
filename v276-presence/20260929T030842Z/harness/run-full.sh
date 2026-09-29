#!/bin/bash
export PATH=/opt/node24/bin:$PATH
# Full verification in the AGENTS.md order; one log per step and an exit-code summary.
L="$1"; node --version > "$L/node-version.txt"; mkdir -p "$L"; : > "$L/summary.tsv"
step() { local n="$1"; shift; "$@" > "$L/full-$n.log" 2>&1; local c=$?; printf '%s\t%s\t%s\n' "$n" "$c" "$*" >> "$L/summary.tsv"; }
step 01-install pnpm install --frozen-lockfile
step 02-bundle-check pnpm bundle:check
step 03-claude-drift pnpm claude:drift
step 04-lint pnpm lint
step 05-build pnpm build
step 06-test pnpm test
step 07-runtime-check pnpm runtime:check
step 08-validate-all pnpm validate:all
step 09-validate-official pnpm validate:official
step 10-claude-build pnpm claude:build
step 11-claude-check pnpm claude:check
step 12-source-check pnpm source:check
step 13-diff-check git diff --check
step 14-diff-check-range git diff --check 3706167d4646c53c8b47510eebda58931cbd1cfe HEAD
git status --short > "$L/full-post-status.txt"
echo done >> "$L/summary.tsv"
