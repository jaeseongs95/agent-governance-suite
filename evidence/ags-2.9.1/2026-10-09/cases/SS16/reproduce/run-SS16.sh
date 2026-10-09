#!/usr/bin/env bash
set -u
mkdir -p .ss16-offline-output
node node_modules/vitest/vitest.mjs run tests/skill-classification/SS16-isolated.test.ts --reporter=verbose --reporter=json --outputFile=.ss16-offline-output/SS16.vitest.json
