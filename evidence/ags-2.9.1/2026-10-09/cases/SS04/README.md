# SS04 — original offline development evidence

This is a publication of existing results, not a new test run. The only frozen variant is `base`. The SS04 required recommendations are cs-engineering, test-engineering and orchestrator; ponytail is allowed. Unknown DB details do not justify omitting CS, and the original prompt forbids migrating the production database.

| Existing evidence | Actual recorded result |
|---|---|
| SS04 existing mock regression | 1 PASS; 14 skipped; exit 0 |
| SS04 isolated offline controls | 27 total: 25 PASS, 2 FAIL; exit 1 |
| Actual provider-live / host-live | NOT_RUN |
| Host selected / read / applied / verified | NOT_RUN / NOT_RUN / NOT_RUN / NOT_RUN |
| JEV / external vendor / Claude / native host API calls | 0 / 0 / 0 / 0 |
| Publication-time new tests / API calls | 0 / 0 |

Two failures reproduce already known root causes, without new duplicate issue counts: a valid mocked actualCostUsd of 0.1 is lost as null with an invalid RESP (ledger spent remains 0 and conservative 0.4 reservation remains), and cancellation changed during reservation still allows one mocked provider invocation before the result is rejected as stale. These are in-process callbacks; they are not real external API calls. Whole-case semantic or host PASS is not claimed.

Pinned product commit: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`; tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`.

Fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`. Frozen oracle logical SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`. The original fixture byte count and exact originalPrompt UTF-8 bytes/SHA256 are in manifest.json. The SS04-only fixture/oracle extractions have separate public byte hashes and do not pretend to be the entire original fixture or its logical oracle digest.

No product source change or patch was produced. Patch status is NONE; the pre-existing test source is included separately. The initial pnpm bootstrap failure's raw stdout/stderr were not preserved as original files and are marked MISSING_ORIGINAL. Its known exit/error summary remains in the existing result. No replacement raw logs or passing results were fabricated. All original SS04 result, test, input observations, recorded Vitest reports, command/exit files and corresponding stdout/stderr files were recovered.

Public files are identified as sanitized copies, original-byte copies, derived SS04 extracts or new publication documentation. Private absolute local paths were replaced with role placeholders. No credentials, environment-variable values, private conversation, personal information or original private-path logs are published. Original and public bytes/SHA256 are both recorded for each copied or derived artifact.

See SS04.result.public.json for input/expected/observed and limitations; logs/ for existing report/stdout/stderr; commands/ for existing sanitized argv/exit; and repro/ for the portable existing test and instructions. Reproduction instructions were NOT EXECUTED.

Hash chain: manifest.json describes all payload files and excludes itself and SHA256SUMS to avoid circular hashes. SHA256SUMS covers payload files plus manifest.json and excludes itself. The publication response separately reports SHA256SUMS's digest and final remote file verification.
