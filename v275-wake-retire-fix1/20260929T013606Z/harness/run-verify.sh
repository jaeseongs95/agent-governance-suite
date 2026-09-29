#!/bin/bash
# Requested verification subset; one log per step and an exit-code summary.
export PATH=/opt/node24/bin:$PATH
L="$1"; mkdir -p "$L"; node --version > "$L/node-version.txt"; : > "$L/summary.tsv"
step() { local n="$1"; shift; "$@" > "$L/full-$n.log" 2>&1; local c=$?; printf '%s\t%s\t%s\n' "$n" "$c" "$*" >> "$L/summary.tsv"; }
step 01-install pnpm install --frozen-lockfile
step 02-bundle-check pnpm bundle:check
step 03-lint pnpm lint
step 04-build pnpm build
step 05-test pnpm test
step 06-claude-check pnpm claude:check
step 07-diff-check git diff --check
step 08-diff-check-range git diff --check 3501e7c5fe998a554e8fa3e3ab795b469dccf2e8 HEAD
git status --short > "$L/full-post-status.txt"
echo done >> "$L/summary.tsv"
