#!/usr/bin/env bash
# usage: timing.sh <label> <outdir>  (runs in cwd; 10 runs per test + one strace run)
export PATH=/opt/node24/bin:$PATH
label=$1; out=$2; F=tests/session-messaging/wake-lifecycle.test.mjs
for name in "terminal pruning cannot erase an outstanding old-generation backoff" "outstanding terminal backoffs share the active wake budget and release it at the deadline" "W05-r2 active budget overflow is an explicit rejection and does not remove unknowns" "W05-r2 terminal observation retention is bounded while unresolved rows are retained"; do
  slug=$(echo "$name" | tr -c 'A-Za-z0-9' '-' | cut -c1-40); ms=()
  for r in $(seq 1 10); do
    node_modules/.bin/vitest run $F -t "$name\$" --reporter=json --outputFile=$out/$label-$slug-$r.json > /dev/null 2>&1
    ms+=($(node -e 'const j=require(process.argv[1]);const a=j.testResults.flatMap(f=>f.assertionResults).filter(x=>x.status!=="skipped");console.log(a.length===1&&a[0].status==="passed"?Math.round(a[0].duration):"FAIL")' $out/$label-$slug-$r.json))
  done
  strace -f -c -e trace=fsync,fdatasync -o $out/$label-$slug.strace node_modules/.bin/vitest run $F -t "$name\$" > /dev/null 2>&1
  calls=$(awk '/ total$/{print $4}' $out/$label-$slug.strace)
  median=$(printf '%s\n' "${ms[@]}" | sort -n | awk '{a[NR]=$1} END{print (NR%2)?a[(NR+1)/2]:(a[NR/2]+a[NR/2+1])/2}')
  echo -e "$label\t$name\tfsync=$calls\tmedian=${median}ms\truns=${ms[*]}"
done
