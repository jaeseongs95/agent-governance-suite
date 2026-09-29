#!/usr/bin/env bash
# usage: measure.sh <tree> <label> <outdir> <test-file> <name>...
export PATH=/opt/node24/bin:$PATH
tree=$1; label=$2; out=$3; file=$4; shift 4
cd "$tree"
for name in "$@"; do
  slug=$(echo "$name" | tr -c 'A-Za-z0-9' '-' | cut -c1-50)
  strace -f -c -e trace=fsync,fdatasync -o "$out/$label-$slug.strace" node_modules/.bin/vitest run "$file" -t "$name" --reporter=json --outputFile="$out/$label-$slug.json" > "$out/$label-$slug.log" 2>&1
  rc=$?
  fs=$(awk '/total/{print $4}' "$out/$label-$slug.strace")
  dur=$(node -e 'const j=require(process.argv[1]);const a=j.testResults.flatMap(f=>f.assertionResults).filter(x=>x.status!=="skipped");console.log(a.map(x=>x.status+":"+Math.round(x.duration)).join(","))' "$out/$label-$slug.json")
  echo -e "$label\t$name\trc=$rc\tfsync=$fs\t$dur"
done
