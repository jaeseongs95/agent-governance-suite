#!/bin/bash
# usage: nl-matrix.sh <runid> <category> <fixture-set> <prompt-file>
# fixture-set: fib|review|none|proj|prose|ponytail|push
# Each run: fresh uuid session id, fresh cwd /tmp/nlm/<runid> (git repo, no remote), acceptEdits, max-turns 20.
set -u
export PATH=/tmp/node-v24.21.0-linux-x64/bin:$PATH
RUNID=$1; CAT=$2; FIX=$3; PFILE=$4
FX=/tmp/ev/scripts/fixtures
OUT=/tmp/ev/runs/$RUNID; mkdir -p "$OUT"
CWD=/tmp/nlm/$RUNID; rm -rf "$CWD"; mkdir -p "$CWD"; cd "$CWD"
git init -q -b main; git config user.email nlm@example.invalid; git config user.name nlm
case $FIX in
  fib) cp $FX/fib.js . ;;
  review) cp $FX/review.diff . ;;
  proj) cp -r $FX/proj/. . ;;
  prose) cp $FX/notes-ko.md . ;;
  ponytail) cp $FX/util.js . ;;
  push) cp $FX/fib.js . ;;
  none) : ;;
esac
printf '# %s\n' "$RUNID" > README.md
git add -A; git commit -qm "init fixture"
SID=$(python3 -c 'import uuid;print(uuid.uuid4())')
ARGS=(-p --plugin-dir /tmp/v53/claude-plugin --output-format stream-json --verbose --max-turns 20
  --model claude-opus-5-5 --permission-mode acceptEdits --session-id "$SID"
  --allowedTools "Bash(node:*)" "Bash(npm test:*)" "Bash(npm run test:*)" "Read(/tmp/v53/claude-plugin/**)" "Read(//tmp/v53/claude-plugin/**)")
{
  echo "runid=$RUNID"; echo "category=$CAT"; echo "fixture=$FIX"; echo "cwd=$CWD"; echo "session_id=$SID"
  echo "start_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'cmd=timeout 1200 claude'; printf ' %q' "${ARGS[@]}"; printf ' < prompt.txt   # prompt via stdin (variadic --allowedTools would swallow a positional prompt)\n'
  echo "--- pre git state"; git remote -v; echo "remotes_count=$(git remote | wc -l)"; git tag -l; git log --oneline
} > "$OUT/meta.txt"
cp "$PFILE" "$OUT/prompt.txt"
timeout 1200 claude "${ARGS[@]}" < "$PFILE" > "$OUT/stream.jsonl" 2> "$OUT/stderr.log"
EC=$?
{
  echo "exit=$EC"; echo "end_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "--- post git state"; git remote -v; echo "remotes_count=$(git remote | wc -l)"; echo "tags:"; git tag -l; git log --oneline; git status --short
  echo "--- post diff vs fixture"; git diff HEAD
} >> "$OUT/meta.txt"
echo "$RUNID exit=$EC"
