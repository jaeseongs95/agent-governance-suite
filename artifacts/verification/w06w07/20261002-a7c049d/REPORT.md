# W06/W07 portable boundary evidence at a7c049d

The bounded independent executor shard passed. The product broker still has no trusted task-binding or activity reader: privileged reports fail closed, and online presence does not become trusted activity. This is evidence for the exact candidate below, not final AGS 3.0 qualification or completion of W06/W07.

## Candidate and isolation

- Candidate: `a7c049d5de392651b102840cb7e75243e1afe317`, fetched from `codex/v260-semantic-decision-layer`.
- Candidate tree: `7028d31985a497dfbb4f8e74c9a219b3400bffa2`.
- Execution cwd: `/workspace/ags-a7c-w06w07`, detached HEAD, clean before and after verification.
- Original checkout: branch `work`, HEAD `ba85fdcf245b9910674d88fffdd125f6f0454027`, preserved clean.
- Node `v24.19.0`, pnpm `11.19.0`; frozen lockfile SHA-256 `00441d0136cbba033c66eeb94dc1bb194d5d98a5ca0a8a843db326969d74402e`.
- Verification ran on 2026-10-01 UTC. The publication branch uses the separately requested `20261002` label.
- This branch adds artifacts only and is based directly on the candidate. It does not modify the parent's separate `dot/ags-3x-results-20261002` branch.

## Executed checks

All commands ran in the execution cwd above. Each numbered `.json` receipt contains the complete argv, cwd, UTC start, exit code and wall duration; matching `.stdout` and `.stderr` files preserve normalized output. Empty streams are retained.

| Receipt | Command/check | Exit | Wall seconds | Result |
| --- | --- | ---: | ---: | --- |
| [01](01-install.json) | `pnpm install --frozen-lockfile --ignore-scripts` | 254 | 0.560 | Setup failure: default store directory unavailable |
| [02](02-install-local-store.json) | Same install with `--store-dir /tmp/ags-a7c-pnpm-store` | 0 | 18.746 | Setup recovered; lockfile unchanged |
| [03](03-bundle-freshness.json) | `node scripts/check-bundle.mjs` | 0 | 0.574 | PASS; comparison build used temporary output only |
| [04](04-claude-drift.json) | `node scripts/build-claude-plugin.mjs --drift` | 0 | 0.666 | `claude-plugin: fresh` |
| [05](05-reader-boundaries.json) | Targeted existing W03/W04 cases | 0 | 2.323 | 3 passed; 17 skipped |
| [06](06-public-installed-probe.json) | Disposable public TLS/MCP/CLI and installed-byte probe | 0 | 3.722 | PASS for both distributions |
| [07](07-final-tree.json) | Candidate/original checkout and lockfile inspection | 0 | 0.220 | Both clean; candidate pinned |
| [08](08-existing-public-cli-codex.json) | Existing packaged CLI lifecycle case, root bytes | 0 | 2.000 | 1 passed; 5 skipped |
| [09](09-existing-public-cli-claude.json) | Same lifecycle case, Claude distribution bytes | 0 | 2.113 | 1 passed; 5 skipped |

There were **5 passed test executions, 0 failed, 27 skipped executions**, representing four unique existing test cases. The diagnostic probe is reported separately, not counted as repository tests. The setup failure and expected rejected public calls are not test failures. No product build or generated-artifact rewrite ran.

## Observed public behavior

At `mcp-server/src/session-message-broker.ts:576`, `startSessionMessageBroker` explicitly supplies `undefined` for both reader arguments. This is missing provider wiring, not an undefined-variable exception. [Source excerpts](source-boundaries.json) and [probe output](06-public-installed-probe.stdout) substantiate the following on both distribution copies:

| Actual invocation | Observed result |
| --- | --- |
| TLS `session-activity` and MCP `get_session_contact_state` | `activity: unknown`, including while synthetic presence is online |
| TLS `record-session-activity` | `Current activity reporter is unavailable.` |
| TLS `record-task-outcome` | `Current task binding is unavailable.` |
| MCP `contact_session` | `ok: true`, `state: held`, `reason: activity-unknown`, `messageId: null` |
| MCP `record_session_task_outcome`, with bound synthetic actor | `MCP_UNAVAILABLE`, missing-binding message |
| Same MCP call without session binding | `BINDING_REQUIRED` |
| Public CLI `record-task-outcome` | Expected exit 1: `Unsupported session message operation.` |

Both disposable spools ended with zero `messages`, `task_outcomes`, `task_requests` and `wake_nonces`. Both fixture directories were removed. Broker and server stderr were empty.

## Installed bytes and limits

The probe copied only committed `contracts`, `skills`, `runtime` and `mcp-server/dist` into disposable installations. Every copied file matched its source before invocation and remained unchanged afterward: 525 root-distribution files and 494 Claude-distribution files. Neither installation contained `node_modules`. The harness used development dependencies outside those installations; the invoked runtime processes used the copied bundles.

Both distributions had these identical selected SHA-256 values:

| Runtime file | SHA-256 |
| --- | --- |
| `mcp-server/dist/server.mjs` | `518c3b2eb26be3feb089a98a81f8e68fc8cff5fdc740d3006e136d1c290f33de` |
| `mcp-server/dist/session-message-broker.mjs` | `1683888d556d11d0372cf645a85b6487fb3c70b37ae7b71322d6463c2ead85a9` |
| `mcp-server/dist/session-message-cli.mjs` | `c6ca220572f3cac882f32f343d4b552c6b5279ada07f89966cce0e36dbd31905` |

These are portable synthetic invocations, not real Codex/Claude host sessions, marketplace installations, native hook acceptance, or a positive trusted-reader integration. The probe deliberately seeds only a disposable update-cache record to suppress the MCP surface's automatic update lookup. It makes no provider/model call and exercises no native authority effect. Source and generated bytes remained unchanged.

Parent-reported stale-generated and W05-r1 failure results on `247cfe3` remain separate evidence; this shard did not test that commit or supersede those failures. Frozen W05 `fa68c3a` was not tested. A fresh `a7c` result does not qualify any later candidate.

## Proposals only

1. Promote the public no-reader TLS/MCP probe into dedicated W06/W07 regression coverage for both distributions, including held/no-enqueue/no-callback assertions.
2. Once trusted-reader wiring exists, add authenticated positive cases and stale-instance, replaced-turn and forged-proof failures across source and installed bytes. Injected-reader unit passes alone do not establish product wiring.
3. Keep host hook/manifest invocation and native installation acceptance separate from portable copied-byte checks.

## Evidence handling

[public-probe.mjs](public-probe.mjs) is the executed synthetic diagnostic source, stored here as an artifact; it is not added to the product test runner. Its absolute workspace paths describe the original execution. [run.py](run.py) is the receipt-capture helper. These scripts are inert unless explicitly invoked.

The raw selected content was reviewed before publication. [sanitization.json](sanitization.json) documents normalization and removal of the execution-environment identifier. Home/runtime paths and random fixture-directory suffixes are normalized; candidate IDs, commands, exits, timestamps, timings and result values are retained. No credentials, private/native messages, user information, native transcripts, operating databases, WALs or auth files are included. No original archive is published.

[manifest.json](manifest.json) gives byte lengths and SHA-256 values for every other artifact in this directory. The SHA-256 of that manifest is the publication evidence digest, reported separately after remote verification.
