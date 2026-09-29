#!/bin/bash
export PATH=/opt/node24/bin:$PATH
cd /home/[REDACTED]/ags-v276d; L=/home/[REDACTED]/v276b/logs; : > $L/full-summary.tsv
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
run 13-diff-check-range git diff --check 93a7e4bc69f556859bc929af1df871dfc74eae68 906a023a565806756bb6accc37d71970c35b740b
run 14-source-check pnpm source:check

git status --porcelain > $L/full-post-status.txt
echo DONE >> $L/full-summary.tsv
