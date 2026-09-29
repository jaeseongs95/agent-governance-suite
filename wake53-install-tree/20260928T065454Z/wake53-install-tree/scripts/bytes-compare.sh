#!/bin/bash
# Compare every file in each install tree with its blob in 53eff30a.
REV=53eff30a2984d41fc749d38dd2062966017684fa
cmp_tree() { # $1=install dir  $2=git prefix
  local ok=0 bad=0
  while IFS= read -r p; do
    rel=${p#$2}
    a=$(sha256sum "$1/$rel" | cut -d' ' -f1); b=$(git cat-file -p "$REV:$p" | sha256sum | cut -d' ' -f1)
    if [ "$a" = "$b" ]; then ok=$((ok+1)); else bad=$((bad+1)); echo "MISMATCH $p $a $b"; fi
  done < <(git -c core.quotepath=off ls-tree -r --name-only $REV $2 | grep -v '^$')
  echo "TREE $1 prefix='$2' match=$ok mismatch=$bad"
}
cmp_tree /tmp/install/codex ""
cmp_tree /tmp/install/claude "claude-plugin/"
echo "== executed entry files (sha256 install tree vs git blob)"
for f in mcp-server/dist/server.mjs mcp-server/dist/session-message-hook.mjs mcp-server/dist/continuity-hook.mjs mcp-server/dist/session-board-hook.mjs mcp-server/dist/host-attestation-hook.mjs mcp-server/dist/session-message-broker.mjs mcp-server/dist/session-message-relay.mjs mcp-server/dist/session-message-cli.mjs; do
  echo "codex  $f $(sha256sum /tmp/install/codex/$f | cut -c1-64) git=$(git cat-file -p $REV:$f | sha256sum | cut -c1-64)"
  echo "claude $f $(sha256sum /tmp/install/claude/$f | cut -c1-64) git=$(git cat-file -p $REV:claude-plugin/$f | sha256sum | cut -c1-64)"
done
for f in hooks/session-message-hook.mjs hooks/continuity-hook.mjs hooks/session-board-hook.mjs hooks/host-attestation-hook.mjs hooks/skill-trigger-hook.mjs; do
  echo "claude $f $(sha256sum /tmp/install/claude/$f | cut -c1-64) git=$(git cat-file -p $REV:claude-plugin/$f | sha256sum | cut -c1-64)"
done
echo "== claude-plugin shared copies vs root originals (mcp-server/dist, runtime, contracts)"
for d in mcp-server/dist runtime contracts; do
  diff -rq /tmp/install/codex/$d /tmp/install/claude/$d && echo "IDENTICAL $d" || echo "DIFFERS $d"
done
echo "== running processes from install trees (entry path)"
ps -eo pid,args | grep -E '/tmp/install/(codex|claude)/' | grep -v grep
