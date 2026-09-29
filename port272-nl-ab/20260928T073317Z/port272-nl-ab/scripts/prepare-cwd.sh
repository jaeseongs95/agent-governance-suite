#!/bin/bash
# usage: prepare-cwd.sh <prompt_id> <dir> — creates a git repo with no remote and the files the prompt needs
set -eu
PID=$1; D=$2; F=/tmp/ev/scripts/fixtures
mkdir -p "$D"; cd "$D"
git init -q -b main
git config user.name "AB Tester"; git config user.email "ab@example.invalid"
echo "# sandbox" > README.md
case "$PID" in
  p1|x2) cp $F/fib.js . ;;
  p2) cp $F/change.diff . ;;
  p4) cp -r $F/proj/. . ;;
  p7) cp $F/fib.js . ;;
  p8) cp $F/util.js . ;;
  p9) cp $F/cleanup.sh . ;;
esac
git add -A; git commit -qm "initial"
if [ "$PID" = p7 ]; then echo "// note" >> fib.js; git commit -qam "chore: add note"; fi
git remote -v; git log --oneline
