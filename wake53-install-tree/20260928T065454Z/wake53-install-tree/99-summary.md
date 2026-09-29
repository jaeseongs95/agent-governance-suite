# wake53-install-tree summary (Linux cloud container; not evidence of the user's PC Codex/Claude installs or live host behavior)

| step | Codex tree (/tmp/install/codex, git archive of repo root) | Claude tree (/tmp/install/claude, git archive of claude-plugin/) | log |
|---|---|---|---|
| 2 archive, node_modules | 1189 files, node_modules=0 | 404 files, node_modules=0 | 04 |
| shipped bare npm imports (mcp-server/runtime/skills/hooks) | none | none | 05 |
| 3 MCP initialize/tools/list | PASS: 28 tools, serverInfo 2.7.1, stderr empty, exit 0, plan_workflow top-level oneOf=true | PASS: 28 tools, same names, stderr empty, exit 0, oneOf=false (anthropic profile), instructions 1022 chars | 06, 07 |
| 3 entry bytes | server.mjs sha256 95ccc725...5de3 == git blob | same bytes == git blob of claude-plugin/mcp-server/dist/server.mjs == root dist | 06, 07, 16 |
| all files vs git | 1189/1189 match | 404/404 match; claude-plugin mcp-server/dist, runtime, contracts identical to root | 16 (15 = first run, 1 false mismatch from git path quoting) |
| 4 hooks (every declared entry) | 14/14 exit 0, stderr empty, no MODULE_NOT_FOUND | 18/18 exit 0, stderr empty; launcher dynamic imports resolve | 08, 09, 10 |
| 5 message round trip | sender: prepare->send->status(queued) PASS | receiver: delivered at Stop hook (claim-turn-end), ack PASS, sender status=acknowledged | 11 (FAIL: my wrong expectation of UserPromptSubmit delivery), 12 PASS |
| 6 check-runtime in tree | PASS "runtime: ready (29 skill CLIs, Node.js 24.21.0)" | NOT_RUN: no scripts/ in claude tree | 14, 13 |
| dev tree | pnpm install --frozen-lockfile EXIT=0; bundle:check EXIT=0; claude:check "fresh" EXIT=0; runtime:check EXIT=0; dev MCP 28 tools same list, same sha | | 18-22 |

Observations (not failures):
- Codex hooks depend on host-provided $PLUGIN_ROOT; unset -> MODULE_NOT_FOUND '/mcp-server/dist/...' exit 1 (23). Codex plugin.json has no hooks key (default-discovery assumption unverifiable here).
- Claude launchers swallow all errors (claude-plugin/hooks/session-message-hook.mjs:5-11, session-board-hook.mjs:11, continuity-hook.mjs:15, host-attestation-hook.mjs:17/30/46, skill-trigger-hook.mjs:49/87): a missing module would be silent exit 0; verified separately in 10.
- Codex host-attestation hook with synthetic session returns "observation unavailable" (no real Codex session metadata) - expected.
- Claude UserPromptSubmit/PostToolUse do not deliver non-wake messages; delivery is at Stop via hookSpecificOutput.additionalContext on the Stop event. Whether Claude Code consumes that output on Stop is not verifiable here.
- acknowledge_session_messages accepted an unclaimed message (claimedAt=null) in 11.
- Codex marketplace pins ref v2.7.1 (.agents/plugins/marketplace.json:12), so a marketplace install would not get 53eff30a.
- Session-message brokers/relays spawned by hooks run detached from install-tree paths (15/16 process list); killed at end.
