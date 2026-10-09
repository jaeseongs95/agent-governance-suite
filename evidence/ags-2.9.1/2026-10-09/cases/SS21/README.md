# SS21 — Existing AGS 2.9.1 evidence

This publication packages existing results only. Publication performed no new tests, no past run reruns, and no JEV/vendor/Claude/Codex model API calls. GitHub publication transport is separate from model API calls.

- Original candidate: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`, tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`.
- Fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`.
- Frozen oracle SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`.
- SS21 `originalPrompt=null`, `oracle=null`. The embedded `sourceSpec.fields` is the source; `TEST-SPEC.seq7.ko.md` was absent. Synthetic mock inputs are explicitly recorded, not invented original semantic prompts or oracle answers.
- Existing targeted regression: **8 PASS, 65 SKIPPED**, exit **0**. This is not full-suite PASS.
- Existing isolated tests: **12 PASS, 1 FAIL**, exit **1**. The ten base variant contract controls passed; quoted-data semantic interpretation remains NOTRUN.
- Overall: **FAIL**, known valid-cost/invalid-RESP defect reproduced. Input321/output42 tokens and valid cost0.125 became null, spent remained0 with pending reservation0.4. This shares the existing known root cause and is not counted as a new root cause.
- Host-live, semantic quality, selected/read/applied/verified: **NOTRUN**. `agentSelectedSkillIds=null`, `hostReceipt=null`. Real input usage/cost remain null. Synthetic mock usage is not real telemetry.
- Product patch: **NO_EXISTING_PATCH**. No product source edits, new patch, PR, release or tag is included.

## Reading the files

`SS21.result.json` retains existing status and limits. `SS21.observations.json.gz` is a lossless gzip of the sanitized existing JSON and contains recovered embedded input/expectation/observation records, full24-candidate inventories, parsed wire objects and original request/prompt/context/inventory/RESP digests. These are existing captured JSON objects, not new provider observations. Exact raw transport-body strings were not separately retained: **MISSING_ORIGINAL_RAW_WIRE_BYTES**. Do not claim newly reconstructed JSON is original network bytes.

`logs/` contains sanitized existing stdout/stderr, exact historic argv/exit metadata and Vitest reports. Empty stdout/stderr files remain empty. Local paths are placeholders; skipped unrelated assertion records were removed from the public regression report while totals remain preserved. JSON null and [] retain their distinct meanings. Test-code credential literals were synthetic; their public copies are redacted.

`manifest.json` records original artifact bytes/SHA256 and separate public bytes/SHA256. Historic internal artifact digests refer to originals, not sanitized copies. Use the manifest for public copy integrity; sanitized engineering proofs are not independently revalidated execution receipts. `SHA256SUMS` lists every public file except itself, including manifest.json. The manifest excludes itself and SHA256SUMS from its hash list to avoid circular hashes.

## Reproduction instructions — written, not executed in this publication

Use a separately prepared local checkout at the exact original candidate and the existing Node24.19.0/pnpm11.19.0/Vitest5.0.0 dependencies. Copy `reproduction/SS21.test.ts` into that checkout as `tests/ss21-isolated/SS21.test.ts`. The public copy changes only local output-path references and synthetic credential markers; manifest records its original test digest and public digest.

From that pinned checkout:

```sh
mkdir -p SS21-reproduction-output
node node_modules/vitest/vitest.mjs run tests/ss21-isolated/SS21.test.ts --maxWorkers=1
```

Expected original candidate result is exit1 from the valid-cost preservation assertion. This instruction was not executed when publishing. Existing exact historical command arrays and reports are in logs/. Do not run live bootstrap, whole suite, or other cases to reproduce this record. AGENT remains the final selector; test receipts are not AGENT acceptance.

Actual host testing requires a separately authorized, qualified fixed profile/config/runtime, full observed installation/support state, real operational prompt and confirmed provenance, native/remote route approval and budget/quota evidence, and signed host task/selection observations. The available Codex executable did not establish such qualification; AGS classification configuration and connected selection tools were absent. All live/lifecycle observations remain NOTRUN.

## Original recovery

All36 artifacts bound by the recovered original SHA256SUMS.json were available and hash-matched. No original result/test/stdout/stderr/exit artifact used here is missing. Patch files never existed. Raw provider transport-body strings were not separately retained. Full raw logs with local filesystem paths, the original archive, and unnecessary skipped-case assertion records are intentionally not published.

For local reading, decompress SS21.observations.json.gz. The compressed public bytes and decompressed JSON bytes/digests are both recorded in manifest.json. Compression is publication packaging only.
