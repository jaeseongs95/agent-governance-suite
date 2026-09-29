WT=/tmp/wt/n24.21.0; mkdir -p $WT/.repro1; cp /tmp/ev/scripts/repro1/{a.ts,worker.ts,main.mjs} $WT/.repro1/
for V in v24.0.0 v24.11.0 v24.12.0 v24.13.0 v24.15.0 v24.21.0 v26.10.0; do
 N=/tmp/nodes/node-$V-linux-x64/bin/node; [ -x $N ] || /tmp/ev/scripts/install-node.sh $V >/dev/null 2>&1
 printf "%s: " $V; (cd $WT && $N .repro1/main.mjs 2>&1 | tr '\n' ' '); echo
done
rm -rf $WT/.repro1
