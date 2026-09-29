#!/bin/bash
# usage: fulltest.sh <lognum-name> <nodebin-dir>
export PATH=$2:$PATH
/tmp/ev/scripts/run.sh "$1" node ./node_modules/vitest/vitest.mjs run --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=/tmp/ev/$1.json
