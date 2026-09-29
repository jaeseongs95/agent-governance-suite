# run from inside worktree so tsx resolves from its node_modules
for V in v24.0.0 v24.21.0 v26.10.0; do
 WT=/tmp/wt/n${V#v}; N=/tmp/nodes/node-$V-linux-x64/bin/node
 cp /tmp/ev/scripts/repro1/*.ts /tmp/ev/scripts/repro1/main.mjs $WT/tests/ 2>/dev/null; mkdir -p $WT/.repro1; cp /tmp/ev/scripts/repro1/*.ts /tmp/ev/scripts/repro1/main.mjs $WT/.repro1/; rm -f $WT/tests/a.ts $WT/tests/worker.ts $WT/tests/child.ts $WT/tests/main.mjs
 echo "== $V worker(--import tsx) with .js->.ts specifier"; (cd $WT && $N .repro1/main.mjs 2>&1 | head -5)
 echo "== $V child process node --import tsx child.ts"; (cd $WT && $N --import tsx .repro1/child.ts 2>&1 | head -5)
 echo "== $V tsx version"; (cd $WT && $N -e "console.log(require('tsx/package.json').version)" 2>&1)
 rm -rf $WT/.repro1
done
