#!/bin/bash
# lists real-HOME governance/claude state (path size mtime), no contents
for d in /root/.agent-governance-suite /root/.local/state/agent-governance-suite /root/.claude/plugins /root/.claude/projects /root/.claude/sessions; do
  find "$d" -printf '%p %s %TY-%Tm-%TdT%TH:%TM:%TS\n' 2>/dev/null
done | sort
stat -c '%n %s %y' /root/.claude.json
