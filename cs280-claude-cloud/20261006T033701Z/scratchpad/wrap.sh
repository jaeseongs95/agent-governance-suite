#!/usr/bin/env bash
# usage: wrap.sh <seq> <name> <argv...>  -> raw logs in $P (postprocess-raw)
P=/root/cs280-publish/postprocess-raw
mkdir -p "$P"
seq=$(printf '%02d' "$1"); name=$2; shift 2
out="$seq-$name.stdout"; err="$seq-$name.stderr"
start=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
"$@" > "$P/$out" 2> "$P/$err"
code=$?
end=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
python3 -I - "$seq" "$name" "$PWD" "$start" "$end" "$code" "$out" "$err" "$@" >> "$P/commands.jsonl" <<'PY'
import json, sys
a = sys.argv[1:]
print(json.dumps({"seq": int(a[0]), "name": a[1], "cwd": a[2], "startUtc": a[3], "endUtc": a[4],
  "exitCode": int(a[5]), "stdout": a[6], "stderr": a[7], "argv": a[8:]}, ensure_ascii=False))
PY
echo "seq=$seq name=$name exit=$code"; tail -n "${TAIL:-20}" "$P/$out"; tail -n 5 "$P/$err"
exit $code
