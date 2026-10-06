export CLAUDE_CONFIG_DIR=$ST/claude-config
unset CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CODE_SESSION_ID
M=mcp__plugin_agent-governance-suite_agent-governance-suite
exec strace -f -tt -qq -e trace=execve,openat -e signal=none -s 512 -o $ST/C2b-strace.raw \
  claude -p --output-format stream-json --verbose --effort high \
  --allowedTools "$M" "Read" < $ST/flow/PROMPT-c2b.md
