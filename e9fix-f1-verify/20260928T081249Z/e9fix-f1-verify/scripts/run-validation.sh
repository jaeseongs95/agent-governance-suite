#!/bin/bash
. /tmp/env.sh
cd /tmp/fix
run(){ n=$1; shift; echo "\$ $*" > /tmp/ev/$n.log; "$@" >> /tmp/ev/$n.log 2>&1; e=$?; echo "EXIT=$e" >> /tmp/ev/$n.log; echo "$n EXIT=$e"; }
run 10-bundle-check pnpm bundle:check
run 11-claude-drift pnpm claude:drift
run 12-claude-check pnpm claude:check
run 13-lint pnpm lint
run 14-build pnpm build
git status --porcelain > /tmp/ev/15-post-build-status.log; echo "EXIT=$?" >> /tmp/ev/15-post-build-status.log; echo "15 dirty lines: $(grep -vc EXIT= /tmp/ev/15-post-build-status.log)"
run 16-test1 pnpm test -- --reporter=default --reporter=json --outputFile=/tmp/ev/16-test1.json
run 17-test2 pnpm test -- --reporter=default --reporter=json --outputFile=/tmp/ev/17-test2.json
git status --porcelain > /tmp/ev/18-post-test-status.log; echo "18 dirty lines: $(wc -l < /tmp/ev/18-post-test-status.log)"
run 19-runtime-check pnpm runtime:check
run 20-validate-all pnpm validate:all
run 21-validate-official pnpm validate:official
run 22-diff-check git diff --check
