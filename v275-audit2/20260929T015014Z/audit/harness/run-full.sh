#!/bin/bash
export PATH=/opt/node24/bin:$PATH
cd /home/[REDACTED]/ags-v275d; L=/home/[REDACTED]/v275b/logs; : > $L/full-summary.tsv
run() { name=$1; shift; s=$(date -u +%FT%TZ); "$@" > $L/full-$name.log 2>&1; rc=$?; echo -e "$name\t$rc\t$s\t$(date -u +%FT%TZ)\t$*" >> $L/full-summary.tsv; }
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
run 12-diff-check git diff --check
run 13-diff-check-range git diff --check 3501e7c5fe998a554e8fa3e3ab795b469dccf2e8 44235fb5c0fc7efab69c989df4d8eff3975af26f
run 13b-diff-check-range-main git diff --check 0c8b52d97d1ccdda1768c18422d073d674e2c785 44235fb5c0fc7efab69c989df4d8eff3975af26f
run 14-source-check pnpm source:check

git status --porcelain > $L/full-post-status.txt
echo DONE >> $L/full-summary.tsv
