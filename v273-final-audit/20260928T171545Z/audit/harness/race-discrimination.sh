#!/bin/bash
# Race-test discrimination: same mutants, old (9a678df) vs new (46859d04) test file, N runs each.
export PATH=/opt/node24/bin:$PATH
cd /home/[REDACTED]/ags-fmut; N=${N:-10}; T=tests/session-messaging/message-retention.test.ts
NEW=$(git show HEAD:$T); OLD=/home/[REDACTED]/final/message-retention.9a678df.test.ts
apply() { case $1 in
  none) :;;
  M02) python3 /home/[REDACTED]/final/mutants-q-final.py . M02-F1-sender-check-removed;;
  M06) python3 /home/[REDACTED]/final/mutants-q-final.py . M06-F1-check-outside-transaction;;
  M06-wide) python3 /home/[REDACTED]/final/mutants-q-final.py . M06-F1-check-outside-transaction && python3 - <<'PY'
p='mcp-server/src/session-message-store.ts'; s=open(p).read()
a='if (pre && pre.receipt === null) { this.prune(nowMs); this.assertReceiptCapacity(sender, "."); }'
assert s.count(a)==1; s=s.replace(a,'if (pre && pre.receipt === null) { this.prune(nowMs); this.assertReceiptCapacity(sender, "."); if (process.argv[1]?.includes("issued-send-worker")) { const until = Date.now() + 150; while (Date.now() < until) { /* audit: widen TOCTOU window in race workers only */ } } }')
open(p,'w').write(s)
PY
  ;; esac; }
echo -e "mutant\ttestfile\truns\tfailures\tmean_ms"
for m in ${MUTANTS:-none M02 M06 M06-wide}; do for v in old new; do
  git checkout -q HEAD -- .; apply $m >/dev/null || { echo "$m apply failed"; continue; }
  [ $v = old ] && cp $OLD $T
  fails=0; total=0
  for i in $(seq 1 $N); do s=$(date +%s%3N); npx vitest run $T -t "two processes sending for one sender at limit-1" > /tmp/claude-race-$m-$v-$i.log 2>&1 || fails=$((fails+1)); total=$((total + $(date +%s%3N) - s)); done
  echo -e "$m\t$v\t$N\t$fails\t$((total / N))"
done; done
git checkout -q HEAD -- .; git status --porcelain | grep -v '^??'
