# SS22 — existing AGS 2.9.1 development evidence

Overall: **FAIL_OFFLINE; HOST_NOTRUN**. This package republishes existing evidence; publication ran **0 new tests and 0 JEV/vendor/Claude/Codex model API calls**.

Candidate commit: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`.
Candidate tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`.
Frozen fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`.
Frozen oracle SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`.

| Existing execution | Observed result |
| --- | --- |
| Existing filtered shadow validator regression | 1 PASS, 25 skipped; exit 0 |
| Existing filtered shadow MCP regression | 1 PASS, 37 skipped; exit 0 |
| New isolated offline SS22 run | 12 PASS, 1 FAIL; exit 1 |
| Formal red/green sensitivity proof check | INCOMPLETE; exit 1; no authorized product mutation/green |
| Provider-live and host-live | NOTRUN |

`shadow` preserves B={P}; CS/T/O omissions remain quality FAIL. Raw mock advice is {P,CS,T,O}; adviceApplied=false. `select` records the supplied full set only at a synthetic component-test boundary. The cancellation-during-runtime-read assertion fails: task.cancelled=true but accept returns valid=true and stores selection. This reproduces the **existing acceptance recheck gap**, counted under its existing root cause.

Actual SS22 selected/read/applied/verified all remain **NOTRUN**. Injected observations and gateway-generated synthetic receipts are not real AGENT selection evidence. Classification supports the AGENT; validator valid=true does not establish purpose correctness. Null and [] remain distinct. SS22 originalPrompt=null and oracle=null are retained; no semantic accuracy score is invented. The embedded fields in SS22.fixture.json are the source authority; TEST-SPEC.seq7.ko.md was absent. SS03 supplies referenced synthetic input only; its case was not executed.

Original result and necessary log derivatives retain their original digest in manifest.json. Local paths are replaced; stdout excludes unrelated skipped-test rows and trailing blank lines; stderr excludes local PIDs. Published commands are sanitized records of the earlier executions, not commands executed during publication. The reproduction test changes only its output location to ./SS22-output. Its published and original SHA256 differ and are both recorded. Sensitive credentials, environment values and private conversations are not included.

No product patch exists. Native host receipts and original complete mock wire bytes are MISSING_ORIGINAL; they were not regenerated. ORIGINAL_STATUS.json distinguishes missing original evidence from an absent product patch. Full frozen fixtures.json remains at the candidate commit; the case and linked-input files here preserve their recovered original bytes.

## Reproduction guidance — NOT EXECUTED during publication

Use a checkout of the fixed candidate with its existing Node 24.19.0 / pnpm 11.19.0 / Vitest 5 dependencies. Copy reproduce/SS22.test.ts into tests/ss22-isolated/SS22.test.ts in that checkout and create SS22-output there. Preserve the full frozen fixtures.json and verify its SHA above. Run only this file if later authorized:

```sh
node scripts/run-tests.mjs tests/ss22-isolated/SS22.test.ts --reporter=verbose --reporter=json --outputFile=./SS22-output/SS22.vitest.json
```

Expected at the fixed candidate: 12 passed, 1 failed, exit 1. The failed assertion is “SS22 select must reject cancellation occurring during runtime reread”. Do not run the entire suite, historical 21-run batch or real providers to reproduce this offline boundary. The test uses the real gateway/service/validator and mocked provider plus injected host observations. It does not exercise native host attestation. Compare source/SS22.gateway-accept.source.txt with the fixed candidate's gateway.ts:117–136.

## File integrity

manifest.json lists payload bytes/SHA256 and source-original bytes/SHA256, plus publication transformations. It excludes itself and SHA256SUMS to avoid circular hashes. SHA256SUMS covers every payload file and manifest.json, but excludes itself. Verification is file integrity, not a rerun or new test PASS.
