export CLAUDE_CONFIG_DIR=$ST/claude-config
unset CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN
M=mcp__plugin_agent-governance-suite_agent-governance-suite
exec claude -p --output-format stream-json --verbose --effort high \
  --allowedTools "$M" "Read" "Agent" "Bash(python3 $ST/scripts/mutate1byte.py:*)" \
  < $ST/flow/PROMPT.md
