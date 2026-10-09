# SS09 existing evidence — AGS 2.9.1

This is a public, sanitized package of **existing** SS09 evidence. Publication executed **0 new tests and 0 JEV/vendor/Claude/Codex inference API calls**. No historical 21-run replay, product changes, PR, tag or release was performed. Only this case directory is published.

Candidate commit: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`
Candidate tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`
Frozen fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`
Frozen oracle digest: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`

## Existing outcomes, unchanged

- Frozen variant: `base` only. Its offline boundary check passed with a synthetic provider response and all 24 skill judgments `not-needed`.
- Existing generic no-skill regression: **1 PASS, 37 skipped, exit 0**. Its synthetic host receipts are test data, excluded from actual AGENT stage evidence.
- SS09 isolated development checks: **18 PASS, 4 FAIL, exit 1**. Four failed checks correspond to three causes: existing valid-cost loss on invalid RESP; existing timeout overflow (fake and real Node timers, one cause); evaluator overlapping false-positive categories.
- Actual provider/host-live case status remains **NOTRUN**; `selected/read/applied/verified` remain **NOTRUN**. `agentSelectedSkillIds=null`, `hostReceipt=null`. A synthetic `[]` no-skill recommendation is not a live accepted selection. No model accuracy is invented.
- Existing test-plan check: **READY, exit 0**. Existing targeted type check: **PASS, exit 0**. Paired red/green sensitivity: **NOT_RUN**; proof consistency: **INCOMPLETE, exit 1** because no product mutation/corrected green candidate was permitted.
- Original actual inference API calls: **0**; publication inference API calls: **0**. GitHub fetch/push is publication transport, not model inference.

The public result is `SS09.result.json`. Inputs, expectations, observations and raw synthetic provider evaluations remain in `SS09.observed.json`; exact prompt bytes and their hash are in `SS09.input.utf8.txt` and `SS09.input-binding.json`. Command files preserve existing argv, exit and timestamps with local path placeholders. Existing stdout/stderr and Vitest JSON are included; empty original stderr/stdout files remain empty.

`TEST-SPEC.seq7.ko.md` is **MISSING_ORIGINAL**: absent from the original repository. The embedded SS09 `sourceSpec.fields` and oracle are preserved in `SS09.fixture.json`. **No original patch existed; no patch was created or published.** All 32 existing files in the original evidence manifest were recovered and matched their recorded original hashes. Intermediate superseded-run logs and unrelated skipped titles are omitted from public logs.

## Sanitization and hash boundaries

`<CANDIDATE_ROOT>`, `<EVIDENCE_ROOT>` and `<WORKSPACE>` replace private local directory prefixes. Executable path values are omitted, and process PIDs are anonymized. No credentials, secrets, raw environment values, personal conversations or private paths are published. These are **sanitized copies**, not byte-identical originals unless stated by a manifest entry. `manifest.json` records both original and published bytes/SHA256 for each derived or sanitized artifact. Retained binding digests, candidate/test snapshots and plan digests refer to the **original historical bytes**; they are not assertions that modified public copies have those historical digests.

`manifest.json` lists payload files and intentionally excludes itself and `SHA256SUMS` to avoid a circular hash. `SHA256SUMS` covers every payload and `manifest.json`, and excludes itself. The publication report separately records the SHA256 of both metadata files. Verify published bytes from this directory with `sha256sum -c SHA256SUMS`; this is an artifact-integrity check, not a new product test or host verification.

## Reproduction instructions — NOT executed during publication

Use an isolated checkout of the candidate commit, Node 24.19.0 and the locked pnpm 11.19.0 dependencies. Verify the frozen fixture/oracle before any later test. Copy this package's `SS09.test.ts` into `tests/ss09-development/SS09.test.ts` in that candidate checkout. The public test changes **only two root/output path literals** from the original existing test to `.` and `./SS09-evidence`; no assertions or cases are changed. Run the following only after a later explicit decision to reproduce:

```sh
# cwd: the fixed candidate checkout, not this evidence branch directory
node node_modules/vitest/vitest.mjs run tests/ss09-development/SS09.test.ts --maxWorkers=1 --no-file-parallelism --reporter=verbose --reporter=json --outputFile=./SS09-evidence/SS09.vitest.json
```

Expected on the fixed original candidate: **exit 1, 18 passed and 4 failed**. `SS09.reproduce.sh` records the same relocated command and must also be invoked from the candidate checkout. Do not use `pnpm test` or run the full suite. Provider/host-live quality stays unverified. Real host work requires approved configuration, qualified fixed profile/route/budget, actual host observations and active/support state; these missing inputs are preserved in the result. This publication does not authorize any new live invocation.
