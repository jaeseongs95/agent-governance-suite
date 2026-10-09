# SS28 existing offline evidence — AGS 2.9.1

This is a public package of already completed SS28 observations. Publication runs no new tests, providers, qualification, host selection, or past 21-case run. No product fix/patch existed. No patch has been fabricated. Original recovery missing: none (37 original artifacts recovered and checked against the original evidence index). Private local locations are replaced by `<REPO>`, `<ARTIFACTS>`, `<HOST_AGENTS_SKILLS>`, and `<CODEX_EXECUTABLE>`. Existing unrelated skipped test-name lines and dependency installation stack locations are omitted where specified in manifest.json. Synthetic sentinel strings in test inputs are test-only, not credentials or personal data.

The fixed candidate is commit `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`, tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`, target branch `codex/skill-classification-2.9.1`. Fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`. Frozen oracle SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`. `SS28.source.json` preserves all embedded sourceSpec fields, originalPrompt, oracle and variants. TEST-SPEC.seq7.ko.md was absent; no outside answer was invented. SS28 semantic oracle is null; semantic accuracy remains null.

## Actual pre-existing outcome

- Existing SS28-related shared regression: 17 PASS, 51 skipped, exit 0. This is a filtered shared regression, not overall SS28 or suite PASS.
- New isolated operational assertions from the earlier development task: all 9 variant structural assertions PASS; one additional known-cost boundary FAIL; combined exit 1.
- Known existing defect reproduced: when the last candidate judgment is missing but `usage.actualCostUsd=0.1` is independently valid, service returns INVALID_PROVIDER_RESPONSE and replaces valid usage with null, spending stays 0, conservative unknown reservation 0.4 remains. Linked to the existing valid-cost-lost-with-invalid-RESP finding; do not count another root cause.
- Long tail negation, full inventory with cs-engineering at the tail, incomplete JSON/question results, UTF-8 input ceiling, unknown null versus confirmed [], and omitted local logs were mechanically checked. The tail CS placement is synthetic mechanical coverage, not a fabricated semantic rule for the original read-only prompt.
- Original/compact representative bytes: 365,370 → 124,722; candidate count 24 → 24. Actual model token counts, usage/billing/cache savings, golden quality pairing and AGENT paired selection NOT_RUN.
- Host selected/read/applied/verified: NOT_RUN, selectedSkillIds=null, hostReceipt=null. Classification is support; final selection belongs to the real AGENT. No synthetic host receipt was created. Null has not been promoted to [].
- Existing JEV/vendorAPI/Claude calls 0; publication JEV/vendor/Claude/Codex calls 0; new trials/tests during publication 0. Product sources unchanged. Red-green/mutation proof remains INCOMPLETE.

## Evidence and integrity

`SS28.result.json` is the public derivative, preserving every original outcome and missing-input limitation. Per-variant JSONs contain the original input, expected result, observation and body digests. Historical stdout/stderr and command exit JSONs retain their original time/outcome; file transformations are listed individually. `original-evidence-manifest.json` retains original source-file hashes and sizes; those hashes describe private original bytes, not transformed public files. `manifest.json` records each public payload's bytes/SHA256 and corresponding original bytes/SHA256. `SHA256SUMS` covers every public payload and manifest.json. It intentionally excludes itself; manifest excludes itself and SHA256SUMS to avoid hash cycles. The final publisher report supplies both control-file digests and total remote-verified file count/bytes.

## Reproduction instructions — NOT executed during publication

Use an isolated checkout of the fixed candidate. Node 24.19.0 and pnpm 11.19.0 were the earlier runtime versions. Restore locked dependencies, copy the public `SS28-isolated.test.ts` to `tests/SS28-isolated.test.ts` in that checkout, and create the output directory. The public reproduction copy changes only its local output directory; its digest differs from the originally executed test and it is explicitly NOT_RUN. Original test digest is retained in manifest.json and product-integrity.json.

```sh
mkdir -p ss28-reproduction-output
node scripts/run-tests.mjs tests/SS28-isolated.test.ts
node scripts/run-tests.mjs tests/SS28-isolated.test.ts -t 'known-cost boundary'
```

The earlier fixed candidate observed exit 1 with `expected null to be 0.1`; these commands have not been rerun to package or publish this evidence. Historical commands use public path placeholders and must be adapted to a local checkout. Full raw input digests, result statuses and command exits remain in the existing JSON evidence; public file digests are separate.

Real host testing remains NOT_RUN. The repository-supported route is installed AGS MCP (`.mcp.json`: node mcp-server/dist/server.mjs), functioning Codex PreToolUse host-attestation/session-board observation, get_skill_inventory/classify_skills, real AGENT choice and record_skill_selection with caller hostReceipt=null. This environment had no exposed classification MCP tools and readClassificationRuntime returned unconfigured/profiles=[]. Approved config, qualified central profile registry, provider/native adapter evidence, budget/egress authorization, task/current revision bindings, actual host observation, tokenizer/version and paired usage evidence are required; details remain in SS28.result.json.hostLive. CLI existence alone is not qualified host support.
