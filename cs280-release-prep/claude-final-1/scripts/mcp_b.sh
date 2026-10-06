export AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE=anthropic AGENT_GOVERNANCE_HOST_ATTESTATION=claude-code
export CLAUDE_PLUGIN_DATA=$ST/B-mcp-state PLUGIN_DATA=$ST/B-mcp-state AGENT_GOVERNANCE_SHARED_STATE_DIR=$ST/B-mcp-state/shared HOME_UNCHANGED=1
export MCP_CWD=$1
exec python3 $ST/scripts/mcp_list.py $1/mcp-server/dist/server.mjs $ST/out/B/mcp-stdio-response.json
