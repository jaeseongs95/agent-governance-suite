#!/usr/bin/env bash
# Adapted from the audit's run-mutants.sh: candidate suite only (tests/session-messaging + tests/session-board).
export PATH=/opt/node24/bin:$PATH
WT="$1"; OUT="$2"; MUT="$3"; shift 3
mkdir -p "$OUT"; cd "$WT"
[ -f "$OUT/mutants.tsv" ] || echo -e "mutant\tapply\tbuild\tcandidate_rc\tcandidate_summary" > "$OUT/mutants.tsv"
for m in "$@"; do
  git checkout -q -- .
  apply=0; [ "$m" = BASELINE ] || { python3 "$MUT" "$WT" "$m" > "$OUT/$m.apply.log" 2>&1; apply=$?; }
  git diff -- mcp-server/src > "$OUT/$m.diff"
  node scripts/build.mjs > "$OUT/$m.build.log" 2>&1; build=$?
  timeout 900 npx vitest run tests/session-messaging tests/session-board > "$OUT/$m.candidate.log" 2>&1; crc=$?
  csum=$(grep -E "^\s+Tests " "$OUT/$m.candidate.log" | tail -1 | sed 's/^ *//')
  echo -e "$m\t$apply\t$build\t$crc\t$csum" >> "$OUT/mutants.tsv"
done
git checkout -q -- .
