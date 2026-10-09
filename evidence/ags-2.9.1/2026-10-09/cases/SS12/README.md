# SS12 — existing AGS 2.9.1 evidence

This directory publishes existing records only. No test, provider request, credential lookup, or Codex/Claude CLI invocation was executed during publication. The portable reproductions are NOT_RUN after path-only editing. Product sources were not changed; no patch exists (`ABSENT`).

Candidate: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`, tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3` on intended branch `codex/skill-classification-2.9.1`.

Frozen fixture file SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`. Frozen oracle SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`. The full frozen fixture is obtainable from the candidate; only SS12 is published here.

## Existing outcomes

- Official variant `base`: original prompt “그거 처리해 줘.” with no confirmed action, target, or prior reference. Expected `NEEDS_INPUT`, selected IDs `null`, reasons `missing-action` and `missing-target`.
- Isolated controls: **19 PASS / 0 FAIL**, exit 0, with 25 input/expected/observed records. Only two existing SS12 regression assertions were extracted; the original shared test was not invoked because it also runs another case.
- Additional spec boundary: **0 PASS / 1 FAIL**, exit 1. The exact source-extracted bootstrap mapping turns schema-valid `PARTIAL` / all-uncertain into `NEEDS_INPUT` / `[]`; expected null is lost. The evaluator reports `UNCERTAINTY_HIDDEN_AS_SELECTION`. This is an offline synthetic response boundary, not a whole bootstrap/provider/host trial.
- Initial harness attempt: **15 PASS / 4 FAIL**, exit 1, from `it.each` parameter expansion errors in the separate test. The test code was corrected for the final 19-pass run. Original initial logs are retained, not presented as product failures.
- Engineering plan check: `READY`, exit 0. Proof check: `INCOMPLETE`, exit 1; repaired product red/green pair absent.
- Actual host `selected/read/applied/verified`: **NOTRUN**. JEV/vendor/Claude calls: **0**. No original 21-run replay, other original case, full suite, or real host receipt was executed or fabricated.

The fixed candidate remains `INCOMPLETE_WITH_REPRODUCED_BOOTSTRAP_BOUNDARY`. R14 bootstrap-scoring follow-up is related work; exact prior defect identity was unconfirmed. Do not count multiple assertions as separate root causes or claim a repaired green candidate.

## Files and provenance

`SS12.result.json` retains the result with path redaction and labeled publication metadata. `SS12.controls.json` contains the original inputs/expected/observed records. `input/originalPrompt.utf8.txt` is exact existing embedded prompt UTF-8 bytes with no trailing newline; `input/request.json` is an extraction of the existing request object, not a new dispatch. `logs/` contains existing stdout, stderr and Vitest results with concrete local roots redacted. `execution-records.json` preserves existing exit codes. `original-recovery.json` records each recovered original file digest, deliberate omissions, absent patch and missing external specification.

`TEST-SPEC.seq7.ko.md` is **MISSING_ORIGINAL**, as it was absent during the original test. Its contents were never invented. Embedded SS12 sourceSpec fields and oracle are preserved. All required result/log/test originals were recovered.

`manifest.json` records each public file's bytes/SHA256 and, for every source-derived file, the original bytes/SHA256 and transformation. Original plan/proof/snapshot/target digests were not rewritten to imply that sanitized or ported files were the executed originals. `SHA256SUMS` covers payload files and manifest; it excludes itself. The manifest excludes both itself and SHA256SUMS, avoiding circular hashes.

## Reproduction instructions — not executed during publication

Use a development checkout of the exact candidate, Node.js 24.19.0 and its existing locked development dependencies (Vitest 5.0.0). Copy `repro/*.test.ts` into a separate writable artifact directory. Set `AGS_CANDIDATE_ROOT` to that candidate checkout and `AGS_EVIDENCE_ROOT` to the separate artifact directory. No original private paths or environment values are published. Run from the candidate checkout:

```sh
node scripts/run-tests.mjs --root "$AGS_EVIDENCE_ROOT" SS12.test.ts --reporter=json --outputFile="$AGS_EVIDENCE_ROOT/vitest.result.json"
node scripts/run-tests.mjs --root "$AGS_EVIDENCE_ROOT" SS12.bootstrap-boundary.test.ts --reporter=json --outputFile="$AGS_EVIDENCE_ROOT/bootstrap-boundary.result.json"
```

Existing outcomes: first command exit 0 with 19 assertions; second command exit 1 at expected-null/observed-[] assertion. These portable copies change only imports/paths and have not been rerun. Do not overwrite published historical logs. No build, whole suite, bootstrap batch, or provider API call is necessary for these reproductions. Both tests guard fetch and use only SS12.

## Remaining gaps

No qualified approved route/profile/runtime/budget configuration, real signed current host observation or task-source evidence was supplied. A local Codex CLI existed but was not invoked; a Claude CLI was absent. Native adapter support requires explicit qualification, isolation and retry evidence. CLI presence is not proof of an approved route. The gateway cannot issue an accepted-selection receipt for clarification-only null; authentic NEEDS_INPUT host transcript observation is needed. No live correctness score or release acceptance is claimed.
