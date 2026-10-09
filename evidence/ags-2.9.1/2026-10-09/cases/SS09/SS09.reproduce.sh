#!/usr/bin/env bash
# SS09 only; expected exit 1 on fixed c6a8019 due recorded defects. No live API.
cd . || exit 2
node node_modules/vitest/vitest.mjs run tests/ss09-development/SS09.test.ts --maxWorkers=1 --no-file-parallelism --reporter=verbose --reporter=json --outputFile=./SS09-evidence/SS09.vitest.json
