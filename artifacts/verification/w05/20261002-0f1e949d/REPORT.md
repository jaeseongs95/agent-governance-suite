# W05-r3 bounded executor evidence

This report preserves the completed campaign. It is published as evidence only on an independent results branch; source files and generated product paths are unchanged on that branch. See [publication scope](PUBLICATION.md) and [reconstruction instructions](REPRODUCE.md). The no-publication statements below describe the campaign before this separately authorized artifact publication.

HOLD: scoped suite has one preserved intermittent failure; actual22 generation differs from reported 15 closure.

Public source `refs/heads/codex/dot-w05-source-20261002` at `0f1e949d4ca57fe3cc9aac98767d5c0dade79c61`, tree `78c4eddb528d851cff295cba2891c2148221a3f1`, exactly one raw commit parent `247cfe3a6b6ba0ee4b38b2168930caf2000b3540`. Same selected executor; Node v24.19.0, pnpm 11.19.0, package 2.7.0. Requested gpt-6.1-sol/high preserved; actual routing is unexposed, with no model/provider invocation in this campaign.

Source 25 matched the parent-supplied path/size/SHA pins (562,803 bytes) and stayed unchanged. Expected modes were not supplied; observed Git modes are 100644. The original desktop 9307-byte manifest was not transferred, so its reported digest is provenance rather than an independently recomputed artifact hash.

Untouched bundle freshness failed: `mcp-server/dist/server.mjs is stale. Run pnpm build and commit the result.` Untouched Claude drift returned warning exit0, with the outlook schema missing and types.ts stale. These original receipts remain preserved.

| Check | Actual result |
| --- | --- |
| Frozen-lock dependency install; documented shared build | PASS |
| Official Claude generation; strict freshness | PASS; wrote 507 files, fresh |
| Generated bundle freshness | PASS |
| Scoped regression (11 files) | FAIL: 161 pass, 1 fail |
| New W05-r3 migration/wake/framing/hook/presence scope | 65 pass |
| W05-r2 scope | 24 pass |
| Claude generation contracts | 18 pass; synthetic fixtures |
| Runtime clean room | 31 skill CLIs pass, no node_modules |
| Complete copied root / Claude plugin | 1847 / 507 files match shipment tree; CLI/TLS/MCP probes pass |
| Diff whitespace check; patch/archive recovery | PASS |

The failed W05-r1 test expected queued but got held at tests/coordinate-subagents/v3x/W05-r1.test.mjs:111, before its retry assertions. Three separate isolated reruns each passed (1 pass, 8 skipped). This does not replace the suite failure. Source inspection suggests a timing-dependent fixture: activity is recorded at now+1ms, while the product rejects future observations; the cause has not been instrumented or confirmed. No source fix was made.

Both complete copied shipments contain no node_modules. Five 4060-byte Korean/emoji messages per host preserved exact body bytes, reused duplicate receipts, acknowledged 5 and left pending 0. All copied bytes matched the same shipment tree and stayed unchanged; temporary synthetic state was removed. Public boundaries held: online activity remains unknown, activity/outcome reporter bindings are unavailable, contact is held, and privileged CLI operations are rejected. These copies and fixtures are portable verification, not a native installed-host observation.

The actual generated closure is 22 paths / 11,001,114 bytes, all Git mode 100644: 11 root and 11 Claude paths. The reported 15 closure has no supplied exact path/byte/hash manifest. Resulting shipment tree is `56aaea2a1b0509b6d9f9b428228619ded640dc1a`. Applying generated-actual22.patch to the exact source candidate reconstructs that tree. generated-actual22.tar verifies every generated path, size, SHA and mode. No commit/ref/push/release was created.

Patch SHA-256 `b0d4ece00cb8598679ee91287165d191970b8b94ed723f3a8425ad3704532d57` (272060 bytes). Archive SHA-256 `b587d43ec718115a5fcdc1b6504156769f02f8a85aaef0870dd1cb2a506a0dd4` (11018240 bytes).

| Generated path | Bytes | SHA-256 |
| --- | ---: | --- |
| claude-plugin/contracts/session-auto-wake-outlook.v1.schema.json | 1594 | `dff6c334cf6aaf10d6ddb6787bc6a35d6f40d2d195b13cb3dc90b79b80e6b565` |
| claude-plugin/contracts/types.ts | 48293 | `3b71a88326beef712e9ae381b852b61486e10e439ac014e7ffc964d50994d5b0` |
| claude-plugin/mcp-server/dist/host-attestation-api.mjs | 40713 | `12fefa5cc52c4cc8ebf1f221eea3eb9c983c317bf36777e6ff7b71f37d221e46` |
| claude-plugin/mcp-server/dist/model-routing-host-hook.mjs | 713671 | `aa4166b45ed20c147eb45d7ab02e5b644e5963ee003a4911d0be37c47a160fcf` |
| claude-plugin/mcp-server/dist/model-routing-peer-cli.mjs | 782962 | `8617ec0856b75af2327895bece4f1d162147c0fbff7a11396d1ff5b1653bebe9` |
| claude-plugin/mcp-server/dist/server.mjs | 2074121 | `efc1c5627750649f299ea560812d307bab398895cae2d04000e38dc467b45606` |
| claude-plugin/mcp-server/dist/session-board-hook.mjs | 26410 | `4a585084d3436f944a3e1c466730286442b303821e1dc6b4f7e4524758300bff` |
| claude-plugin/mcp-server/dist/session-message-broker.mjs | 739212 | `96b18e7adc6a264e04e580e3f9fda9b27546655d249ca738558623659d498faa` |
| claude-plugin/mcp-server/dist/session-message-cli.mjs | 16192 | `4d3023be81623fa5acdfc21f3491f32d5ce43bde24a76f97a8b03c6211aa545b` |
| claude-plugin/mcp-server/dist/session-message-hook.mjs | 822233 | `aa02c66fdf0c738e1015bcfaf676a6311b36f0159b8badc157eb4db4bf4e62d6` |
| claude-plugin/mcp-server/dist/session-message-relay.mjs | 24050 | `721a40cb342dc76fda3d8d2d2aba2a3442a08e8755b38e3ae37bf455a7ecdae8` |
| host-integration.json | 48589 | `64fc1c65d8b29190612ae7a127258081cd746b19469f98076c28a9b43501f4a2` |
| mcp-server/dist/flowmarshal-profile-probe.mjs | 423510 | `3e5984e94ddfb401102e5ab4be1b30756dbff1f198b15ac7c06656f994937509` |
| mcp-server/dist/host-attestation-api.mjs | 40713 | `12fefa5cc52c4cc8ebf1f221eea3eb9c983c317bf36777e6ff7b71f37d221e46` |
| mcp-server/dist/model-routing-host-hook.mjs | 713671 | `aa4166b45ed20c147eb45d7ab02e5b644e5963ee003a4911d0be37c47a160fcf` |
| mcp-server/dist/model-routing-peer-cli.mjs | 782962 | `8617ec0856b75af2327895bece4f1d162147c0fbff7a11396d1ff5b1653bebe9` |
| mcp-server/dist/server.mjs | 2074121 | `efc1c5627750649f299ea560812d307bab398895cae2d04000e38dc467b45606` |
| mcp-server/dist/session-board-hook.mjs | 26410 | `4a585084d3436f944a3e1c466730286442b303821e1dc6b4f7e4524758300bff` |
| mcp-server/dist/session-message-broker.mjs | 739212 | `96b18e7adc6a264e04e580e3f9fda9b27546655d249ca738558623659d498faa` |
| mcp-server/dist/session-message-cli.mjs | 16192 | `4d3023be81623fa5acdfc21f3491f32d5ce43bde24a76f97a8b03c6211aa545b` |
| mcp-server/dist/session-message-hook.mjs | 822233 | `aa02c66fdf0c738e1015bcfaf676a6311b36f0159b8badc157eb4db4bf4e62d6` |
| mcp-server/dist/session-message-relay.mjs | 24050 | `721a40cb342dc76fda3d8d2d2aba2a3442a08e8755b38e3ae37bf455a7ecdae8` |

Remaining blockers: preserve and route the intermittent W05-r1 failure to the existing source writer; reconcile actual22 versus reported 15; perform separately authorized native two-host acceptance and independent qualification. Full product acceptance, lint/full validators and release were outside this bounded campaign. Parent projection receipts were not treated as Task/source GO. Main and prior evidence worktrees remain clean and unchanged.

Transport copies normalize local workspace/temp paths and omit the internal executor identifier. Raw local receipts/logs remain retained. No personal credential value, native transcript, native DB, private ancestry, auth configuration, or legacy Cloud operation is included.

Collector note: the first external closure capture failed on Git-quoted Unicode path spelling; NUL-delimited inventory fixed the diagnostic collector only, and the completed recovery evidence is recorded separately.
