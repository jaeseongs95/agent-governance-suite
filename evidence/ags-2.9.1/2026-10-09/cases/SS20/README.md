# SS20 — AGS 2.9.1 existing offline evidence

This publication packages existing results only. New tests, reruns, provider calls, native CLI/model calls and external JEV/vendor/Claude/Codex API calls: **0**.

Candidate: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`; tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`.
Frozen fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`.
Frozen oracle SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`.
SS20 originalPrompt and semantic oracle are **null**. Use embedded SS20 source fields; TEST-SPEC.seq7.ko.md was absent. The SS03 fixture prompt is only SS20's specified input. No semantic accuracy score exists.

| Frozen variant | Existing offline result | Mock vendor sends | JEV lookup/call |
|---|---|---:|---:|
| normal | PASS; SUCCESS with injected P/CS/T/O advice and fixed synthetic model/low effort | 1 | 0 |
| missing-profile | PASS; PROFILE_UNAVAILABLE | 0 | 0 |
| unavailable-model | PASS; ROUTE_CAPABILITY_MISMATCH | 0 | 0 |
| unsupported-option | PASS; UNSUPPORTED_OPTIONS | 0 | 0 |

Targeted final file: **11 PASS / 2 FAIL, exit 1** (four required variants + seven other passing boundaries + two known-defect reproductions). Existing regression: **2 PASS / 61 skipped, exit 0**; this is not full SS20 coverage or suite PASS. Initial harness schema mistake: 13 failures before provider execution; retained as HARNESS_ERROR, not product evidence. Local plan check: exit 0. Sensitivity check: INCOMPLETE, exit 1 because repaired green is NOT_RUN.

Known roots reproduced, not newly counted: valid actualCostUsd=0.70 disappears with invalid RESP while spent stays 0 and reservation stays 0.40; timeoutMs=2147483648 produces Node's 1ms overflow warning and a dispatched mock vendor timeout. No product patch exists, and no repaired green was run.

Host selected/read/applied/verified: **NOTRUN**. agentSelectedSkillIds and hostReceipt remain **null**; unavailable advice judgments `[]` are not a selected no-skill answer. Injected classification advice and developer inventory/source reads are not real AGENT selection or skill application. Full acceptance remains INCOMPLETE. Current live configuration/profile/qualification/route/budget and signed host observations were missing. Stock MCP startup supports configured native adapters; remote vendor mapping requires explicit registration, used only as a mock in this result.

See [public result](SS20.result.public.json), [all variant inputs/expectations/observations](observations.public.json), [final assertions](results/isolated-vitest.public.json), [recorded combined log](logs/isolated-vitest.combined.public.log), and [manifest](manifest.json). Every public artifact is marked as sanitized, extracted, or new publication documentation, with original byte count/hash. Original artifact hashes bind private retained originals, not these transformed public bytes.

## Reproduction instructions — written only, NOT EXECUTED during publication

In a separately prepared checkout of the pinned candidate, copy `reproduce/SS20.test.ts` to `tests/ss20-isolated/SS20.test.ts`. Use Node 24.19.0/pnpm 11.19.0 and the pinned lockfile. The public test differs from the original only in output-path portability and synthetic credential redaction; its original/public digests are in the manifest. Prepare `SS20-reproduction-output/` under that checkout before running. `SS20_EVIDENCE_DIR` can optionally specify a writable output directory. This candidate-specific test uses mocked fetch/credential/profile/budget; no live provider route is needed.

```sh
pnpm exec vitest run tests/ss20-isolated/SS20.test.ts --reporter=json --outputFile=SS20-reproduction-output/isolated-vitest.json
```

Recorded expected outcome at the pinned unmodified candidate: 11 passed, two known-defect assertions failed, exit 1. Instructions are not evidence of a new run. Fixture input text bytes, request object representation and the full frozen fixture byte SHA are separately identified; the raw original serialized network body was not stored, so it is MISSING_ORIGINAL and no exact raw-wire hash is invented.

## Missing originals / patch

- Separate stdout and stderr files: **MISSING_ORIGINAL**; existing logs contain the combined redirected streams.
- Original raw serialized HTTP wire bytes: **MISSING_ORIGINAL**; parsed wire objects exist in recorded observations.
- Installation stdout/stderr logs: **MISSING_ORIGINAL as standalone artifacts**; existing result records setup command/exit.
- Product fix patch: **NO_EXISTING_PRODUCT_PATCH**; none fabricated.
- Live host receipts and target skill execution artifacts: **NOTRUN**, no originals created.

Manifest lists payload files only, excluding manifest.json and SHA256SUMS to avoid circular hashes. SHA256SUMS covers payload files plus manifest.json, and excludes itself. Publication and remote verification are reported separately by the publisher; these recorded test verdicts are unchanged.
