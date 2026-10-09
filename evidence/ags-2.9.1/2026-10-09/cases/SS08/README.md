# SS08 existing AGS 2.9.1 evidence

Only previously captured SS08 evidence is published here. No new test, historical run replay, JEV/vendor/Claude/Codex model API call, product change, or patch was performed during publication. Publication checksum checks do not change test verdicts.

Candidate commit: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`
Candidate tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`
Fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`
Frozen oracle SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`

Declared variants: **base only**. Required CS: `cs-engineering`; allowed extras: `[]`; forbidden: `ponytail`, `orchestrator`. Exact prompt UTF-8 bytes (without an added newline) and the complete embedded input/expected oracle are under `inputs/`. The external TEST-SPEC file is absent; no replacement answer was invented.

| Existing execution | PASS | FAIL | Skipped | Exit |
|---|---:|---:|---:|---:|
| Final isolated SS08 run | 13 | 4 | 0 | 1 |
| Earlier isolated SS08 version, supplementary | 13 | 3 | 0 | 1 |
| Selected shared contract regressions | 4 | 0 | 22 | 0 |
| Current local runtime, empty provider ports | 1 | 0 | 0 | 0 |

Overall case status remains **FAIL**. Real host selected/read/applied/verified remain **NOTRUN**, selected IDs and hostReceipt remain **null**. Synthetic component receipts are not actual AGENT selection. Simulated raw omission remains a raw oracle failure even after separate explicit-CS correction. No measured model accuracy is asserted.

Four already-known causes reproduced: host availability supply gap, cancellation during asynchronous selection acceptance, valid cost lost with invalid RESP, and timeout overflow to 1ms. They are not four new defect causes. Mocked cost 0.1 is not actual spending. Metadata condition duplication was not independently probed here.

## Evidence and redaction

`SS08.result.public.json` and `observations/` preserve original input/expected/observed values, null versus empty arrays, commands, exits, and limitations. Public logs are sanitized copies of existing **combined stdout/stderr** captures. Separate stdout/stderr originals and the executed earlier-version test snapshot are **MISSING_ORIGINAL**. Product patch and original patch file: **NONE**.

Private absolute paths are replaced by `<REPO>`, `<ARTIFACTS>`, `<HOST_CONFIG>`, and similar placeholders. Private conversation metadata is removed. No credential or environment variable value is published. Synthetic/public fixture prompts are retained. Original digests identify unpublished originals; they are not claims that public sanitized bytes equal originals.

`manifest.json` records every payload file's public bytes/SHA256, its recovered original's bytes/SHA256 where applicable, and transformations. It excludes itself and SHA256SUMS to avoid circular hashing. `SHA256SUMS` covers payloads and manifest.json, excluding itself. Original files are retained privately unchanged.

## Reproduction instructions — NOT executed during publication

Use Node 24+ and pnpm 11.19.0 in a separate checkout of the fixed candidate. Retrieve fixture bytes from that commit and verify the frozen SHA above. Copy `reproduction/ss08.development.public.test.ts` into the candidate as `tests/skill-classification/ss08.development.test.ts`. Create a relative `ss08-artifacts/` directory in that candidate. The public test changes only the artifact output directory; it has not been rerun and is not proof of an additional pass.

```sh
pnpm install --frozen-lockfile
mkdir -p ss08-artifacts
pnpm exec vitest run tests/skill-classification/ss08.development.test.ts --reporter=verbose
pnpm exec vitest run tests/mcp/skill-classification-validation.test.ts --testNamePattern='keeps needed skill while|requires applicability and selection reasons' --reporter=verbose
```

Expected captured final isolated outcome is 13 PASS / 4 FAIL, exit 1. These commands are instructions only. Do not run the whole suite or live bootstrap to reproduce this evidence. Real host completion additionally requires approved classification configuration/profiles, AGS MCP/hook connection, exact current host task/call observations, and an actual retry-design target; see `host-readiness.public.json`.
