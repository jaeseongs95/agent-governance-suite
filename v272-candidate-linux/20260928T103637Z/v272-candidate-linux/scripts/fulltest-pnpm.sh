#!/bin/bash
# usage: fulltest-pnpm.sh <log-name> <nodebin-dir>   (runs via `pnpm test` so npm_execpath is set)
export PATH=$2:$PATH
/tmp/ev/scripts/run.sh "$1" pnpm test --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=/tmp/ev/$1.json
