#!/bin/sh
# One gated push: window check, exact remote ref check, preflight receipt re-verification, then a single push.
ST=<REDACTED_HOME>/cs281-b28a-20261006T110419Z; PF=$ST/preflight; WT=<REDACTED_HOME>/evidence-wt2
URL=https://github.com/jaeseongs95/agent-governance-suite.git; BASE=023097dfe99e0c99b89dcaab30a7418eb51c59f0
I=$ST/claude-config/plugins/cache/agent-governance-claude/agent-governance-suite/2.8.1/skills/mutation-risk-preflight
NOW=$(date -u +%s); START=$(date -u -d 2026-10-06T11:35:00Z +%s); END=$(date -u -d 2026-10-06T12:00:00Z +%s)
echo "now=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ "$NOW" -lt "$START" ] || [ "$NOW" -ge "$END" ]; then echo "STOP: outside write window"; exit 10; fi
REMOTE=$(git -C "$WT" ls-remote "$URL" refs/heads/evidence | cut -f1)
echo "remote_before=$REMOTE"
if [ "$REMOTE" != "$BASE" ]; then echo "STOP: remote ref changed"; exit 11; fi
VT=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
sed "s/__NOW__/$VT/" "$PF/verify-input.template.json" > "$PF/verify-input.json"
VERIFY=$(node "$I/scripts/verify-preflight-receipt.mjs" --input "$PF/verify-input.json"); VRC=$?
echo "verify_exit=$VRC"; echo "$VERIFY" | head -c 600; echo
echo "$VERIFY" | grep -q '"valid":true' || { echo "STOP: preflight receipt not valid"; exit 12; }
{"_excludedLine": 17, "rawLineSha256": "d461108ce7b26e6309f6f5a295bffa60798ae9437faa9e8e1e7d2b337f407fe3", "rawLineBytes": 75, "reason": "JSON parse failure; raw withheld"}
git -C "$WT" push origin prep/claude-b28a-2:refs/heads/evidence; PRC=$?
echo "push_exit=$PRC"
echo "remote_after=$(git -C "$WT" ls-remote "$URL" refs/heads/evidence)"
exit $PRC
