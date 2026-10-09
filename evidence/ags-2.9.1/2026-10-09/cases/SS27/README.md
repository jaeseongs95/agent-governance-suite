# SS27 — public evidence package

This is a publication-only package of existing SS27 evidence. No tests, prior runs, host CLI calls or classification APIs were rerun for this publication. No product patch exists.

Candidate commit: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`
Candidate tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`
Fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`
Frozen oracle SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`

## Existing results, unchanged

Overall SS27: **FAIL**. All 8 frozen variants were observed offline. Existing targeted regressions: 5 passed. New isolated assertions from the prior test phase: 18 passed / 4 failed. Eight primary safety checks passed, but raw failure-reason retention failed for five variants; these counts do not mean full-case PASS.

| Variant | Existing mechanical requirement status |
| --- | --- |
| unknown-id | FAIL: membership/missing errors detected, causes lost after fallback |
| duplicate-id | FAIL: array duplicate rejected, cause lost after fallback |
| disabled | PASS only for supplied metadata: needed retained, runnable=[] |
| unsupported | PASS only for supplied metadata: needed retained, runnable=[] |
| invalid-judgment | FAIL: schema invalid rejected, cause lost after fallback |
| nan-score | PASS offline: true NaN rejects before serialization; tag preserves NaN |
| omitted-id | FAIL: omitted judgment rejected, cause lost after fallback |
| additional-id | FAIL: ID outside supplied inventory rejected, cause lost after fallback |

Four failed assertions are grouped into three causes: new duplicate JSON answer keys accepted after JSON.parse; existing INVALID-response propagation loses known cost and raw failure details; existing host-support observation supply gap. Cost and error-detail loss share a propagation group and are not counted separately per variant.

`originalPrompt=null`, `oracle=null`; no semantic accuracy was created. Actual host `selected/read/applied/verified`: **NOTRUN**, with selected IDs and receipt **null**. `runnable=[]` in blocked synthetic boundaries is not accepted actual AGENT no-skill selection. Final choice belongs to AGENT; classifier advice is supporting evidence only. No synthetic acceptance receipt was generated.

Historical and publication JEV/vendor/Claude/Codex classification or host API calls: **0**. Publication new tests: **0**. Git transport used to publish this directory is separate from classification APIs.

## Bytes and provenance

`manifest.json` records each public artifact's bytes/SHA256 and the source artifact's original bytes/SHA256. Original digests identify recovered private evidence; they are not digests of redacted files. `original-recovery.json` inventories all recovered originals and intentional omissions. Raw skipped assertion rows were removed from public Vitest projections, while original counts and all executed assertion outcomes remain. Private absolute paths and dependency stack locations were redacted. `PUBLIC` files are derivatives where marked, not new observations.

No original evidence artifact is missing. Standalone regression/plan/proof exit files were not present: **MISSING_ORIGINAL** for those standalone files; the already-existing command/exit JSON records are included. No such logs or exits were manufactured. Patch: **NO_PATCH_EXISTS**. Source TEST-SPEC.seq7.ko.md was already absent; embedded SS27 fields were used without reconstructing it.

Manifest hashing is acyclic: manifest excludes itself and SHA256SUMS; SHA256SUMS covers all other public files including manifest, excludes itself. Both control-file digests are reported by the publisher after remote byte verification.

## Reproduction instructions — not executed during publication

Use a separate checkout of the fixed candidate with its documented Node 24/pnpm dependencies. Copy the included `SS27.offline.test.ts` and `SS27.extra-boundaries.test.ts` unchanged into `evidence/SS27/` of that checkout. This original relative placement is required for imports and report paths. The files retain explicit synthetic fixture strings and mock credentials, never real credentials.

```sh
node scripts/run-tests.mjs evidence/SS27/SS27.offline.test.ts --reporter=json --outputFile=evidence/SS27/new-tests.vitest.json
# prior observed exit 1: 12 passed / 4 failed
node scripts/run-tests.mjs evidence/SS27/SS27.extra-boundaries.test.ts --reporter=json --outputFile=evidence/SS27/extra-tests.vitest.json
# prior observed exit 0: 6 passed
python evidence/SS27/run-regressions.py
# prior targeted regressions: 5 passed, recorded individual exit 0
```

The published run-regressions.py is a derivative using the current directory instead of a private absolute path. Existing commands and exits are in SS27.result.json; failure assertion text is in new-tests.vitest.json. The original test plan was READY; paired red/green sensitivity proof is **NOT_RUN/INCOMPLETE** because no corrected candidate or authorized product mutation existed. This publication does not change that.

## Host limits

A Codex executable was previously found; no qualified native route or runtime config was configured. Required qualified model/profile/runtime route, confirmed allowance/cost, no-retry/isolation/capability evidence, current host state supply and signed task/actor/tool observations were missing. Actual read/apply/verify evidence was missing. These remain limitations, not PASS. Public result preserves the exact missing-input list while redacting host/private paths.

Only `evidence/ags-2.9.1/2026-10-09/cases/SS27/` is authorized for this publication. Main, product roots, tags and other cases are untouched by the SS27 commit.
