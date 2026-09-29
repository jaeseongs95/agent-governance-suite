for V in v24.0.0 v24.21.0; do
  N=/tmp/nodes/node-$V-linux-x64/bin/node; WT=/tmp/wt/n${V#v}; D=$(mktemp -d /tmp/brk-XXXX)
  echo "== $V"
  (cd $WT && $N mcp-server/dist/session-message-broker.mjs --state-directory $D >/dev/null 2>&1 & echo $! > $D.pid)
  sleep 2
  echo '{"operation":"prepare","payload":{"sender":{"host":"test-sender","sessionId":"sender"},"target":{"host":"test-target","sessionId":"target"},"body":"Synthetic"}}' | AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR=$D $N $WT/mcp-server/dist/session-message-cli.mjs; echo "CLI_EXIT=$?"
  kill $(cat $D.pid); rm -rf $D $D.pid
done
