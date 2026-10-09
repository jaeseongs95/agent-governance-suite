# SS30 prior offline evidence — public package

This directory packages existing SS30 results; publication ran **zero new tests** and made zero JEV/vendor/Claude/Codex API calls. No prior live run was repeated.

Candidate: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`, tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`.

The prior result remains **FAIL**: 7 existing regression assertions passed (56 skipped), and 21 newly written offline assertions previously ran with 19 PASS / 2 FAIL. The two failures are known valid cost loss on invalid RESP (same existing root cause) and missing binding of uncertain judgments to unresolvedItems. selected/read/applied/verified and host-live remain NOTRUN. Sensitivity proof is NOT_RUN / INCOMPLETE. SS30 oracle and originalPrompt are null; no semantic accuracy score exists.

- `SS30.public.result.json`: sanitized prior result, preserving statuses, commands, exits and variants.
- `inputs/source.SS30.json`: exact embedded SS30 source input; missing TEST-SPEC was never invented.
- `inputs-expectations-observations.json`: exact recovered synthetic input/expected/observed bytes.
- `logs/`: earlier stdout/stderr/exit and assertion results, sanitized; no test rerun during packaging.
- `reproduce/`: previously existing test and runner sources; **not executed during publication**.
- `provenance/publication.json`: recovered originals, fixture bytes/hash, missing inputs, patch status and publication limits.
- `manifest.json`: every payload's public bytes/hash and source original bytes/hash. It excludes itself and SHA256SUMS to avoid cycles.
- `SHA256SUMS`: payloads plus manifest; excludes itself. Its own digest is reported by the publisher.

Personal paths are descriptive placeholders. Redacted files are public derivatives, not asserted byte-identical originals. The original snapshot and original digest file record original provenance only. Literal test markers such as SYNTHETIC_KEY are deliberately fake fixture values and never fetched credentials.

## Reproduction instructions (not run for publication)

Use a separate checkout of the pinned candidate with Node >=24 and the repository's existing Vitest 5 dependencies. Copy `reproduce/SS30.test.ts` into `evidence/SS30/SS30.test.ts` in that checkout; keep its relative imports unchanged. Then, only when separately requested, run:

```sh
node node_modules/vitest/vitest.mjs run evidence/SS30/SS30.test.ts --reporter=json --outputFile=evidence/SS30/new-vitest.json
```

The recorded original result is 19 pass / 2 fail, exit 1. The exact earlier SS30-only existing-regression argv is in `logs/existing-regression.command.public.json` (7 pass, exit 0). No whole suite is needed. Sanitized original packaging runner files are archival sources; placeholder paths are not approved live host inputs. Do not infer actual host selection from mock outputs or engineering receipts.

For a real host step, approved AGS MCP exposure, qualified fixed profiles, approved route/budget or native allowance, confirmed task context and actual host observations are still missing; see the prior public report/result. This package does not fill those gaps.

No existing product patch was available. See PATCH_STATUS.md. Missing original artifacts among the 20 recovered files: none.
