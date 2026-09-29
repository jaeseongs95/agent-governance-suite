#!/bin/bash
# Copy 53eff30a versions of changed session-messaging test files into /tmp/base
set -e
cd /home/user/agent-governance-suite
for f in $(git diff --name-only d5c5932c 53eff30a -- tests/session-messaging); do
  git show 53eff30a2984d41fc749d38dd2062966017684fa:"$f" > /tmp/base/"$f"
  echo "copied $f $(sha256sum /tmp/base/$f | cut -c1-16)"
done
cd /tmp/base && git status --porcelain
