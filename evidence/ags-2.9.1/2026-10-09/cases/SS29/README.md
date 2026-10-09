# SS29 existing evidence — AGS 2.9.1

Historical operational result: **FAIL**. This publication packages existing artifacts; it runs no new test, scoring, API/native host call or prior 21-run bootstrap.

Candidate commit `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`, tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`. Fixture SHA256 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`; frozen oracle SHA256 `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`.

`originalPrompt=null`, `oracle=null`, semantic accuracy `null`. Missing repo source `TEST-SPEC.seq7.ko.md` was not invented; embedded `sourceSpec.fields` were used. The UTF-8 mechanical input is extracted verbatim, without newline, in `inputs/embedded-mechanical-prompt.utf8`; byte count and hash are in `input-provenance.json` and the manifest.

| Variant | Historical operational status | Supporting test status |
|---|---|---|
| cosine | FAIL | FAILED |
| logit | FAIL | FAILED |
| noul | FAIL | FAILED |
| score-absent | PARTIAL | PASSED limited absent-input/no-fake-number checks |
| threshold-uncertain | FAIL | FAILED |

One deduplicated root cause: score kind and value are dropped at the service result boundary and remain absent at the full 24-skill inventory gateway. Cosine and no-score service outputs collide. Four variant assertions plus gateway are five failures from one cause; no independent defect count is inferred. See `SS29.result.json`, `SS29.report.md`, per-variant observations and `score-presence-collision.observation.json`.

Historical new development tests: **12 PASS / 5 FAIL**, exit **1**, 17 tests. Existing SS29 regression: **1 PASS / 22 skipped**, exit **0**; this is not full-case PASS. Historical plan check READY; red/green sensitivity proof NOT_RUN, consistency check INCOMPLETE, exit **1**. A test-run or consistency receipt is not actual AGENT selection evidence.

Actual host `selected/read/applied/verified`: **NOTRUN**. `agentSelectedSkillIds=null`, `hostReceipt=null`; absent final selection was not converted to `[]`. Actual JEV/vendor/Claude/native Codex provider calls were **0**. Actual host/UI/AGENT baseline/live calibration and independent audit remain NOTRUN. Mock provider methods and routeKind=native in historical fixtures do not mean real host calls.

## Reproduction guidance (not executed during publication)

Use a separate checkout of the fixed candidate and the original Node 24.19.0 / pnpm 11.19.0 / Vitest 5.0.0 dependency versions. Copy `SS29.development.test.ts` from this publication into candidate `tests/SS29.development.test.ts`. Its public copy only replaces the private fixed output location with an optional output-directory environment name; it has not been rerun. Create the output directory first. From that candidate root, the original runner command shape is:

```sh
mkdir -p SS29-output
SS29_OUTPUT_DIRECTORY=SS29-output node scripts/run-tests.mjs tests/SS29.development.test.ts --reporter=verbose --reporter=json --outputFile=SS29-output/development.vitest.json
node scripts/run-tests.mjs tests/mcp/skill-classification-providers.test.ts -t 'SS29 intermediate Noul' --reporter=verbose --reporter=json --outputFile=SS29-output/regression.vitest.json
```

The first historical command exited 1 on the preserved defect. Do not reinterpret this as runner failure, silently fix the candidate, call the full suite, or invoke live providers. Historical `*.command.json` contains exact non-private arguments and original exits; private cwd/output paths are descriptive placeholders, not newly executed commands. Historical plan/proof/snapshot digests bind original bytes, not the sanitized test file. This is explicitly disclosed by the original/public hashes in `manifest.json`.

## Public provenance and integrity

No product patch existed; `patch-status.json` explicitly reports **ABSENT_NO_PRODUCT_PATCH**. No patch or historical output was newly created. All required original artifacts were recovered; missing-original list is empty. A full corpus copy and repeated private archive are intentionally not published. Those are not missing originals. `publication-provenance.json` lists all recovered raw file bytes/SHA256, including intentionally omitted originals, using basename identifiers only.

Sanitized historical logs retain actual results/exits, remove private paths, unnecessary process diagnostics, and unexecuted other-case entries. The large gateway echo of full inventory metadata is omitted, while all inventory IDs, binding digests, judgments and raw scores are retained. Raw originals are not represented as these public bytes. Each manifest entry records both original and published bytes/SHA256 and the transformation; packaging-only metadata is labeled separately.

`manifest.json` hashes every payload file, excluding itself and `SHA256SUMS`. `SHA256SUMS` hashes every payload file plus `manifest.json`, excluding itself. This avoids circular hashes. The publication writer verifies all remote Git blob bytes/hashes independently. Publishing and remote verification are separate operations; neither upgrades historical test or host status.
