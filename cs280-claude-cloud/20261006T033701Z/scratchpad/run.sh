#!/usr/bin/env bash
# usage: run.sh <seq> <name> <argv...>   (runs in $REPO, logs to $E)
SP=$(dirname "$(readlink -f "$0")")
source "$SP/env.sh"
seq=$1; name=$2; shift 2
log="$(printf '%02d' "$seq")-$name.log"
cd "$REPO" || exit 99
headBefore=$(git rev-parse HEAD)
start=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
"$@" > "$E/$log" 2>&1
code=$?
end=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
headAfter=$(git rev-parse HEAD)
treeAfter=$(git rev-parse 'HEAD^{tree}')
dirty=$(git status --porcelain --untracked-files=all | wc -l)
post="$(printf '%02d' "$seq")-$name.post-git.txt"
{ echo "# git status --porcelain --untracked-files=all"; git status --porcelain --untracked-files=all
  echo "# git diff --stat"; git diff --stat; } > "$E/$post" 2>&1
sha=$(sha256sum "$E/$log" | cut -d' ' -f1)
python3 -I - "$seq" "$name" "$PWD" "$start" "$end" "$code" "$log" "$sha" "$headBefore" "$headAfter" "$treeAfter" "$dirty" "$post" "$@" >> "$E/commands.jsonl" <<'PY'
import json, sys
a = sys.argv[1:]
print(json.dumps({"seq": int(a[0]), "name": a[1], "argv": a[13:], "cwd": a[2], "startUtc": a[3], "endUtc": a[4],
  "exitCode": int(a[5]), "logFile": a[6], "logSha256": a[7], "headBefore": a[8], "headAfter": a[9],
  "treeAfter": a[10], "dirtyAfterCount": int(a[11]), "postGitFile": a[12]}, ensure_ascii=False))
PY
echo "seq=$seq name=$name exit=$code dirty=$dirty head=$headAfter start=$start end=$end log=$log"
tail -n "${TAIL:-25}" "$E/$log"
exit $code
