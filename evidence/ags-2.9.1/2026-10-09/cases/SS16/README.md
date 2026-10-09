# SS16 — AGS 2.9.1 existing offline evidence

This package publishes an existing SS16 run. Publication executed **zero new tests, zero historical reruns, and zero JEV/vendor/Claude/Codex model API calls**. No product patch exists.

Candidate commit: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`
Candidate tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`
Original fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`
Frozen oracle SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`

## Existing results

Existing Vitest run: **18 PASS / 2 FAIL / 20 tests**, recorded exit **1**. Three SS16 inventory variants retained all 24 candidates and the same inventory digest. K occupied positions 14, 11, and 24. Request projection byte count was 124567 in each variant (compact projection, not a complete provider wire measurement). One-byte overflow held without dispatch. Offline planning expanded any Korean capability to four ordered phases `[50,55,60,65]`, using one distinct skill, korean-prose-editor.

Failures: the evaluator accepts unrelated nonempty O reasons despite the required four-phase-linking condition; valid synthetic known cost 0.003 becomes null with INVALID_PROVIDER_RESPONSE when the K judgment is missing. The latter is a witness for the already known cost-loss finding, not another root cause. Mock recommendation responses were predetermined and establish no provider semantic quality.

Actual host **selected/read/applied/verified: NOTRUN**; selectedSkillIds and hostReceipt remain null. Existing regression runs/provider-live/host-live were not executed. Formal paired red/green sensitivity proof remains NOT_RUN. Existing plan consistency was READY (exit 0), not actual implementation/host verification. Historical setup/plan input errors retain exit 1 and exit 2 respectively; their original raw logs are missing.

## Provenance and omissions

`manifest.json` records public bytes/SHA256 and source artifact bytes/SHA256 for each derivative. `ORIGINAL_ARTIFACTS.json` records the recovered original artifact inventory. Originals with private local paths are not published. Private path labels and local in-memory plan signatures were redacted; original digests were not replaced by public digests. Snapshot/plan/proof references bind original artifacts and are not silently rebound to derivatives.

`SS16.vitest.public.log` is a redacted existing **merged stdout/stderr** log. Separate streams, initial setup and initial plan-error raw logs, complete serialized request/wire bytes, full external source-spec file, announcement body, and host evidence are MISSING_ORIGINAL as detailed in `MISSING_ORIGINAL.json`. Missing logs/results/patches were not reconstructed. `SS16.fixture-excerpt.json` retains its existing bytes. The prompt text file extracts the exact originalPrompt UTF-8 bytes without a final newline or normalization.

## Reproduction guide — not executed during publication

Use a separate disposable checkout of the exact candidate commit with Node 24.19.0 and already installed compatible dependencies (original Vitest version 5.0.0). The evidence branch is an artifact archive, not the source checkout. Do not run historical live-bootstrap batches.

Copy `reproduce/SS16-isolated.test.ts` into `tests/skill-classification/SS16-isolated.test.ts` in that disposable pinned source checkout, and run the archived portable script from that source root:

```sh
bash <SS16_PACKAGE>/reproduce/run-SS16.sh
```

The script uses the existing command:

```sh
node node_modules/vitest/vitest.mjs run tests/skill-classification/SS16-isolated.test.ts --reporter=verbose --reporter=json --outputFile=.ss16-offline-output/SS16.vitest.json
```

Expected recorded behavior is exit 1 with the two requirement assertion failures above, not a whole-case PASS. The test is a derivative whose sole code change is the artifact output pathname; it was not rerun. The script is also a portable derivative and was not executed. Future reproduction creates new evidence and must not overwrite this archive or promote host stages. No provider/host credential or native API configuration is supplied by these files.

## Hash layout

`manifest.json` hashes every payload file and deliberately excludes itself and SHA256SUMS. SHA256SUMS hashes all payload files plus manifest.json, excluding itself. This is acyclic. Remote publication verification must compare actual blobs for every file, including both metadata files, with the locally prepared bytes. Publication/remote-verification status is reported separately from the preserved test results.
