#!/bin/bash
# Old (46859d04) vs new (e3220a48) wake-lifecycle.test.mjs against prune/budget mutants.
export PATH=/opt/node24/bin:$PATH
cd /home/[REDACTED]/ags-fmut; T=tests/session-messaging/wake-lifecycle.test.mjs; S=mcp-server/src/session-message-store.ts
apply() { case $1 in
  none) :;;
  B1-budget-check-removed) python3 - <<'PY'
p='mcp-server/src/session-message-store.ts'; s=open(p).read(); a='if (count.n >= MESSAGE_LIMIT) throw new Error("The bounded active wake store is full.");'
assert s.count(a)==1; open(p,'w').write(s.replace(a,'if (false && count.n >= MESSAGE_LIMIT) throw new Error("The bounded active wake store is full.");'))
PY
;;
  B2-budget-ignores-cooldown) python3 - <<'PY'
p='mcp-server/src/session-message-store.ts'; s=open(p).read(); a="""WHERE state IN ('reserved', 'started', 'submitted', 'unknown')
              OR (state = 'not-submitted' AND retry_not_before > ?)`).get(iso(nowMs))"""
assert s.count(a)==1; open(p,'w').write(s.replace(a,"""WHERE state IN ('reserved', 'started', 'submitted', 'unknown')
              OR (0 AND retry_not_before > ?)`).get(iso(nowMs))"""))
PY
;;
  P1-cap-drops-backoff-guard) python3 - <<'PY'
p='mcp-server/src/session-message-store.ts'; s=open(p).read(); a="""WHERE state IN ('observed', 'not-submitted', 'expired-unobserved') AND (retry_not_before IS NULL OR retry_not_before <= ?)
      ORDER BY"""
assert s.count(a)==1; open(p,'w').write(s.replace(a,"""WHERE state IN ('observed', 'not-submitted', 'expired-unobserved') AND (1 OR retry_not_before <= ?)
      ORDER BY"""))
PY
;;
  P2-cap-offset-plus-10) python3 - <<'PY'
p='mcp-server/src/session-message-store.ts'; s=open(p).read(); a=""".run(now, MESSAGE_LIMIT);
    this.database.prepare("DELETE FROM prepared_messages"""
assert s.count(a)==1; open(p,'w').write(s.replace(a,""".run(now, MESSAGE_LIMIT + 10);
    this.database.prepare("DELETE FROM prepared_messages"""))
PY
;;
  P3-cap-keeps-oldest) python3 - <<'PY'
p='mcp-server/src/session-message-store.ts'; s=open(p).read(); a="ORDER BY coalesce(consumed_at, observed_at, retired_at, outcome_at) DESC LIMIT -1 OFFSET ?)"
assert s.count(a)==1; open(p,'w').write(s.replace(a,"ORDER BY coalesce(consumed_at, observed_at, retired_at, outcome_at) ASC LIMIT -1 OFFSET ?)"))
PY
;;
  esac; }
echo -e "mutant\ttestfile\trc\tsummary\tfailed_in_bulk_tests"
for m in ${MUTANTS:-none B1-budget-check-removed B2-budget-ignores-cooldown P1-cap-drops-backoff-guard P2-cap-offset-plus-10 P3-cap-keeps-oldest}; do for v in old new; do
  git checkout -q HEAD -- .; apply $m || { echo "$m apply failed"; continue; }
  [ $v = old ] && cp /home/[REDACTED]/final2/wake-lifecycle.46859d04.test.mjs $T
  npx vitest run $T --reporter=verbose > /home/[REDACTED]/final2/logs/lm-$m-$v.log 2>&1; rc=$?
  s=$(grep -E "^ +Tests " /home/[REDACTED]/final2/logs/lm-$m-$v.log | tr -s ' ')
  b=$(grep -E "^ +×" /home/[REDACTED]/final2/logs/lm-$m-$v.log | grep -cE "outstanding old-generation backoff|share the active wake budget|active budget overflow|terminal observation retention")
  echo -e "$m\t$v\t$rc\t$s\t$b"
  grep -E "^ +×" /home/[REDACTED]/final2/logs/lm-$m-$v.log | sed 's/^ */    /' | cut -c1-150
done; done
git checkout -q HEAD -- .; git status --porcelain | grep -v '^??'
