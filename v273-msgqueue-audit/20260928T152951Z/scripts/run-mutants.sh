#!/usr/bin/env bash
# Mutation run: candidate suite (tests/session-messaging + tests/session-board) and the audit suite per mutant.
export PATH=/opt/node24/bin:$PATH
WT="${1:?mutation worktree}"; OUT="${2:?log dir}"; AUDIT_SRC="${3:?audit tests dir}"
mkdir -p "$OUT"; cd "$WT"
echo -e "mutant\tapply\tbuild\tcandidate_rc\tcandidate_summary\taudit_rc\taudit_summary" > "$OUT/mutants.tsv"
for m in BASELINE $(python3 /home/user/audit-out/scripts/mutants.py --list); do
  git checkout -q -- . ; git clean -fdq tests/session-messaging
  apply=0; [ "$m" = BASELINE ] || { python3 /home/user/audit-out/scripts/mutants.py "$WT" "$m" > "$OUT/$m.apply.log" 2>&1; apply=$?; }
  git diff -- mcp-server/src > "$OUT/$m.diff"
  node scripts/build.mjs > "$OUT/$m.build.log" 2>&1; build=$?
  timeout 900 npx vitest run tests/session-messaging tests/session-board > "$OUT/$m.candidate.log" 2>&1; crc=$?
  csum=$(grep -E "^\s+Tests " "$OUT/$m.candidate.log" | tail -1 | sed 's/^ *//')
  cp "$AUDIT_SRC"/audit-*.test.ts tests/session-messaging/
  AUDIT_RACE_ROUNDS=${AUDIT_RACE_ROUNDS:-5} timeout 900 npx vitest run tests/session-messaging/audit-msgqueue.test.ts > "$OUT/$m.audit.log" 2>&1; arc=$?
  asum=$(grep -E "^\s+Tests " "$OUT/$m.audit.log" | tail -1 | sed 's/^ *//')
  echo -e "$m\t$apply\t$build\t$crc\t$csum\t$arc\t$asum" >> "$OUT/mutants.tsv"
done
git checkout -q -- . ; git clean -fdq tests/session-messaging
echo done > "$OUT/DONE"
