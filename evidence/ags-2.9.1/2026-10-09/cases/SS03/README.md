# SS03 — existing offline development evidence

This is a public, sanitized package of the **already completed** SS03 evidence. Packaging/publication ran **0 new tests** and **0 JEV, external vendor, Claude or Codex model API calls**. It is not a fresh evaluation or release approval.

## Fixed candidate and input

- Candidate commit: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`
- Candidate tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`
- Full frozen corpus `tests/skill-classification/fixtures.json` SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`
- Frozen computed oracle SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`
- SS03 variant: `base` only; exact prompt UTF-8 bytes, request and embedded spec excerpt are under `inputs/`. The excerpt file hash is distinct from the full corpus hash.
- Required recommendations: `ponytail`, `cs-engineering`, `test-engineering`, `orchestrator`.

## Historical results and limits

- Existing SS03 evaluator regressions: **2 PASS**, 0 FAIL, exit **0**; 13 assertions skipped by filter.
- New isolated SS03 controls: **15 PASS**, 0 FAIL, exit **0**. The control group was repeated once to recover overwritten observation output after fixing only journal preservation; the two 15-test runs are not counted as 30 independent controls.
- Known-defect reproductions: **2 FAIL**, exit **1**. Invalid RESP discards valid reported cost `0.1` to `null` while spent remains `0` and reservation `0.4` remains. A synthetic budget-port cancellation interleaving permits **1 mock provider dispatch** before fencing the result as stale; expected dispatches were 0. These connect to previously known defects; **0 new root causes** are counted.
- Full SS03 status remains `INCOMPLETE_WITH_REPRODUCED_KNOWN_DEFECTS`. Model semantic accuracy and actual handoff loss/duplicate correctness were not measured.
- Host **selected/read/applied/verified: NOTRUN**. `agentSelectedSkillIds=null`, host receipt `null`; null is not replaced with `[]`.
- ACK-as-business-completion, automatic queue/DB/daemon installation, and actual handoff implementation verification: **NOTRUN**.
- The existing evaluator stage regression uses a `mock-only` receipt. New isolated tests do not create accepted host receipts. No test receipt proves actual AGENT selection.
- Historical live JEV/vendor/Claude/Codex model calls: **0**. Historic 21-run qualification batch reruns: **0**. No production source, push/PR/release changes occurred during the original tests.

`SS03.result.public.json` retains existing status and source pins. `observations.public.json` retains every existing input/expected/observed journal row. Identical repeated request, skills, fixture and projection objects use `$publicationRef` and optional JSON Pointer references to the files under `inputs/`; this is lossless representation, not a new observation.

## Original recovery and privacy

`provenance.json` records original and public bytes/SHA256 independently. Public logs redact machine/workspace paths only. Reproduction test copies change only the output directory to `./SS03-evidence`; these adapted copies have **not been executed**. Existing initial test reconstruction stays labeled reconstructed.

`MISSING_ORIGINAL`: contemporaneously captured initial test snapshot, overwritten first controls journal, and absent `TEST-SPEC.seq7.ko.md`. Existing reconstruction, initial run reports, later journal and embedded spec remain available without changing their evidentiary status. **NO_EXISTING_PATCH**: no product patch/diff existed and none was created for publication.

No credential values, environment variable values, personal conversations or private machine paths are published. Executable/config presence booleans are historical observations; missing trusted profile/route/qualification/budget/native isolation and live host call/task evidence continue to block host claims.

## Reproduction instructions — written only, not executed during publication

Use a separate checkout of the candidate commit above with Node `24.19.0`, pnpm `11.19.0`, and the locked existing dependencies. After copying the package to an accessible directory, copy `repro/SS03-isolated.public.test.ts` to candidate `tests/SS03-isolated.test.ts`. Run from the candidate repository root, with `mkdir -p SS03-evidence` beforehand.

```sh
node node_modules/vitest/vitest.mjs run tests/skill-classification/evaluation.test.ts --testNamePattern 'rejects select-all despite recall 1 and accepts only R|never promotes stage labels without source, obligation, phase and candidate evidence'
node node_modules/vitest/vitest.mjs run tests/SS03-isolated.test.ts --testNamePattern 'SS03 offline controls'
node node_modules/vitest/vitest.mjs run tests/SS03-isolated.test.ts --testNamePattern 'SS03 known-defect reproductions'
```

The last command should exit **1** on this pinned candidate due to the two expected-behavior defect assertions. No repaired-candidate green result exists. Do not execute the whole suite or a live qualification/bootstrap batch to reproduce this package. `commands.public.json` preserves the historical argv/exit/times with path placeholders; it is not a claim that the public placeholder commands ran.

## Hash inventory

`manifest.json` lists each payload file's bytes/SHA256 and original-to-public mapping. It excludes itself and `SHA256SUMS` to avoid circular hashes. `SHA256SUMS` hashes every payload file **and manifest.json**, excluding itself; its own digest is returned in the publication completion report. This inventory verifies package integrity, not evaluation correctness or host acceptance.
