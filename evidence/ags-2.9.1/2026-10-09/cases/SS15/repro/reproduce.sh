#!/usr/bin/env bash
# Reproduction instructions only. NOT EXECUTED during publication.
# Run from a separate checkout of the pinned product commit with original locked dependencies ready.
set -u
publication_dir="$1"
expected_commit=c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6
test "$(git rev-parse HEAD)" = "$expected_commit" || exit 2
test ! -e tests/skill-classification/SS15.development.test.ts || exit 2
mkdir -p ss15-public-repro-output
export SS15_EVIDENCE_OUTPUT="$PWD/ss15-public-repro-output"
cp "$publication_dir/repro/SS15.development.test.ts" tests/skill-classification/SS15.development.test.ts
node scripts/run-tests.mjs tests/mcp/skill-classification-validation.test.ts   -t 'keeps needed skill while.*(enabled|hostSupported)'   --reporter=json --outputFile=ss15-public-repro-output/existing-regression-corrected.json
regression_exit=$?
node scripts/run-tests.mjs tests/skill-classification/SS15.development.test.ts   --reporter=json --outputFile=ss15-public-repro-output/development-tests.json
development_exit=$?
printf 'Observed reproduction exits: regression=%s development=%s; original recorded exits: 0 and 1.\n' "$regression_exit" "$development_exit"
# Original recorded counts: filtered regression 2 PASS / 24 skipped; isolated development 12 PASS / 5 FAIL.
# A different count/status is a new result; never overwrite this published historical evidence.
