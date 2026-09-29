# start packaged broker directly with each Node, capture stderr, check readiness
for V in v24.0.0 v24.21.0; do
  N=/tmp/nodes/node-$V-linux-x64/bin/node; D=$(mktemp -d /tmp/brk-XXXX)
  echo "== $V broker dist"
  (cd /tmp/wt/n${V#v} && timeout 6 $N mcp-server/dist/session-message-broker.mjs --state-directory $D; echo "BROKER_EXIT=$?") 2>&1 | head -30 &
  sleep 4; echo "files: $(ls $D | tr '\n' ' ')"; wait; rm -rf $D
done
