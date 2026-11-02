#!/usr/bin/env bash
# M1 runner on the Linux test server. usage: run-m1.sh <killIterations>
set -u
export PATH=/home/mcpops/ags-tests/tester-7452-20261028-r01/runtime/node-v24.22.1-linux-x64/bin:$PATH
W=/home/mcpops/ags-tests/measure-dbms-20261102
cd "$W"
L=$W/logs
D=$W/data
mkdir -p "$L" "$D"
ITERS=${1:-100}
echo "== basic (3 runs) $(date -Is)"
for i in 1 2 3; do node m1-basic.mjs "$D/basic-$i"; echo "exit=$?"; done > "$L/m1-basic.log" 2>&1
echo "== bundle $(date -Is)"
{
  rm -rf bundle-out bundle-run && mkdir -p bundle-out
  npx --no-install esbuild m1-bundle-entry.mjs --bundle --platform=node --format=esm --outfile=bundle-out/app.mjs \
    --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" 2>&1 | tail -3
  echo "bundle esbuild exit=${PIPESTATUS[0]}"
  echo "remaining imports in bundle:"; grep -o -E 'from ?"[^".][^"]*"' bundle-out/app.mjs | sort | uniq -c
  echo "file refs in bundle:"; grep -o -E '"[a-z]+\.(wasm|data)"' bundle-out/app.mjs | sort | uniq -c
  mkdir -p bundle-run/a bundle-run/b bundle-run/c
  for x in a b; do cp bundle-out/app.mjs node_modules/@electric-sql/pglite/dist/{pglite.wasm,pglite.data,initdb.wasm} bundle-run/$x/; done
  cp bundle-out/app.mjs bundle-run/c/
  ls -la bundle-out bundle-run/a
  cd /tmp
  node "$W/bundle-run/a/app.mjs" default "$D/bundle-a"; echo "a(default, files beside) exit=$?"
  node "$W/bundle-run/b/app.mjs" explicit "$D/bundle-b"; echo "b(explicit options) exit=$?"
  node "$W/bundle-run/c/app.mjs" default "$D/bundle-c" > "$L/m1-bundle-c.err" 2>&1; echo "c(default, no files) exit=$?"
  grep -m3 -E 'Error|ENOENT' "$L/m1-bundle-c.err" | cut -c1-300
  cd "$W"
} > "$L/m1-bundle.log" 2>&1
echo "== concurrent (3 runs) $(date -Is)"
for i in 1 2 3; do node m1-concurrent.mjs "$D/conc-$i" 3; echo "exit=$?"; done > "$L/m1-concurrent.log" 2>&1
echo "== kill x$ITERS $(date -Is)"
node m1-kill.mjs "$D/kill" "$ITERS" "$L/m1-kill.jsonl" > "$L/m1-kill-summary.log" 2>&1
echo "kill exit=$?" >> "$L/m1-kill-summary.log"
echo "== kill during first initdb x20 $(date -Is)"
FRESH=1 node m1-kill.mjs "$D/kill-init" 20 "$L/m1-kill-init.jsonl" > "$L/m1-kill-init-summary.log" 2>&1
echo "kill-init exit=$?" >> "$L/m1-kill-init-summary.log"
echo "== done $(date -Is)"
