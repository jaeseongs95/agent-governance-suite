# SS25 — existing AGS 2.9.1 evidence

Publication of existing evidence only. No new test, completed-21 rerun, model API or native host invocation was performed for publication. This directory is the sole Git write scope.

Candidate commit: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`  
Candidate tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`  
Exact fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`  
Frozen oracle SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`

SS25 has originalPrompt=null and oracle=null. Only embedded sourceSpec.fields were used; missing TEST-SPEC.seq7.ko.md was not fabricated. SS03/SS09 in `engineering/source.json` are A/B inputs for SS25, not separate case runs. No semantic accuracy score exists for SS25.

Existing outcome: FAIL. Existing targeted regressions: 7 PASS. Existing isolated test: 17 assertions, 11 PASS / 6 FAIL. All 3 variants were exercised. Revision/digest cache fences and ordinary cancellation checks passed. Missing/conflicting initial task binding and accept-time task-change races failed. Six assertion witnesses represent two causes: one missing initial-binding validation and one known pre-write recheck gap; duplicates are not separate defects. Known host-state supply gap is static-source evidence only.

Actual host selected/read/applied/verified: NOTRUN each. Actual selected IDs and host receipt remain null. Synthetic [] acceptance and test-generated receipts are offline fixture observations only. JEV/external vendor/Claude/native Codex calls: 0. Original product modifications/push/PR/release: 0; this publication is the newly authorized evidence-only push. Red/green sensitivity proof remains NOT_RUN/INCOMPLETE because no corrected product candidate was supplied.

Files named `.public` are sanitized derivatives. Original bytes/SHA256 and public bytes/SHA256 are recorded separately in `manifest.json`. Generic `<CANDIDATE_ROOT>` and `<CODEX_EXECUTABLE>` replace private paths; output directories are `./ss25-reproduction`. Exact public fixture/input bytes and unchanged source references retain original hashes. Original merged logs are included; no split stream or missing receipt has been reconstructed. No existing patch file was recovered: `NO_PATCH` (not a new patch).

## Reproduction instructions — not executed during publication

Use a separate checkout/worktree at the candidate commit. Copy `reproduction/SS25.isolated.test.ts` to `tests/skill-classification/SS25.isolated.test.ts` in that candidate checkout. The public derivative changes only the original absolute observation-output path to a relative output path. From the candidate checkout:

```sh
mkdir -p ss25-reproduction
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec vitest run tests/skill-classification/SS25.isolated.test.ts --reporter=json --outputFile=./ss25-reproduction/isolated-tests.json
```

Expected existing outcome: exit 1, 11 PASS / 6 FAIL. Dependency setup is not a model invocation; this package has not run these commands again. Do not run the whole suite or any historical 21-request batch. Existing targeted regression commands and recorded exits are in `commands.public.json`; their paths are sanitized descriptions, not newly executed receipts. Use the relative SS25 output directory when reproducing them.

`reports/*.public.json` contain existing assertion results. `observations/isolated-observations.public.json` preserves variant input/expected/observed data and null vs []; `observations/source-inspection.public.json` contains existing reviewed excerpts. `engineering/source.json` preserves original input source artifact bytes. `inputs/fixtures.frozen.json` is the full exact frozen public fixture, provided to preserve fixture SHA; no additional case was executed.

## Missing originals and limits

- Split stdout/stderr: MISSING_ORIGINAL. The existing capture combined both streams; only the merged originals are available.
- Standalone command-exit receipt files: MISSING_ORIGINAL. Existing result JSON preserves recorded actual exits.
- Early typecheck-error raw logs: MISSING_ORIGINAL; overwritten originally. Final empty typecheck log exists.
- Patch: NO_PATCH. No patch is manufactured.
- Actual host evidence, independent audit, corrected green candidate and provider semantic quality: NOTRUN.

The current environment had no AGS classification MCP tools or supplied classification configuration. Real host checks additionally need an approved installed MCP/hook path, qualified fixed vendor registry/runtime, native capability/no-retry/isolation and budget evidence, and independent current task revision/digest/cancellation observations. This publication does not claim to supply those inputs.

`manifest.json` hashes payload files and intentionally excludes itself and SHA256SUMS to avoid cycles. `SHA256SUMS` hashes payload files plus manifest.json and excludes itself. The publication completion record reports both index hashes and remote verification separately. File bytes must be verified from the final remote commit.
