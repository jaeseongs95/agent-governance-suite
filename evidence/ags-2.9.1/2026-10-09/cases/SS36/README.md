# SS36 — AGS 2.9.1 offline evaluator evidence

Historical SS36 result: **PASS for seven offline evaluator variants only**. Existing scoped regression: 5 passed / 10 skipped (exit 0). Final isolated suite: 12 passed / 0 failed (exit 0). Initial test-authoring attempt: 8 passed / 3 failed (exit 1); its records are preserved in `archive/`. Those failures mistakenly treated SS03 `notApplicable` IDs as `forbidden`; final controls use the unmodified frozen SS14 oracle. No product defect is claimed.

Candidate commit `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`, tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`. Fixture SHA256 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`; frozen oracle SHA256 `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`. `frozen-fixtures.json` retains the complete pinned fixture bytes. `SS36.fixture-extract.json` contains the embedded SS36 spec; the referenced standalone TEST-SPEC file was absent. SS36 originalPrompt/oracle/semanticAccuracy remain `null`.

`SS36.result.json`, `SS36.observations.json`, `SS36.commands.json`, `reports/` and `logs/` preserve input/expectation/observation, exit and actual execution status. select-all fails despite recall 1; required-only passes; missing-required and forbidden-extra fail; two wrong hosts fail despite agreement 1; all-abstain and failure-denominator probes retain failures. These are parameterized **offline evaluator mocks**, not semantic quality runs of the borrowed cases or host selections. Mock receipts never prove actual selection.

Actual host selected/read/applied/verified: **NOTRUN**. JEV/vendor/Claude API calls during original verification: **0**. This publication executes **0 new tests and 0 JEV/vendor/Claude/Codex API calls**, and does not repeat historical qualification runs. No product patch exists (`NONE_CREATED`). Publication into the evidence branch is separately authorized; the historical test result's no-push record is unchanged.

Separate stdout/stderr: **MISSING_ORIGINAL** (only merged captures exist). Intermediate 11-test green report: **MISSING_ORIGINAL** (superseded by final 12-test outputs). Nothing is reconstructed or promoted to PASS. See `recovery-status.json`.

Public copies remove private local paths and literal environment values. `manifest.json` records original/public bytes and SHA256, plus transformation descriptions; `archive/original-SHA256SUMS` is the original evidence index. `SHA256SUMS` covers every public payload file and `manifest.json`, but excludes itself. The manifest excludes its own digest and SHA256SUMS to avoid cycles. No credentials, personal conversation or private environment values are included.

## Reproduction instructions — not executed during publication

Use a separate checkout of the pinned public candidate with Node 24 and the repository's pinned pnpm/dependencies. The evidence branch is an archive, not the product checkout. Let `PINNED_REPO` refer to that checkout and `EVIDENCE_DIR` to this package. The following is a future user-invoked offline reproduction, not a performed run:

```sh
git -C "$PINNED_REPO" rev-parse HEAD
git -C "$PINNED_REPO" rev-parse 'HEAD^{tree}'
cd "$EVIDENCE_DIR"
SS36_PINNED_REPO="$PINNED_REPO" node "$PINNED_REPO/node_modules/vitest/vitest.mjs" run --config reproduce/vitest.config.mjs
```

The evidence directory must be writable. Make the repository's existing `vitest` dependency available to module resolution in the evidence directory (for example a local node_modules link); no new runner is required. Public path adaptations are explicitly **NOT_RUN** and are not a tested patch. Original command records remain in `SS36.commands.json`; initial code is archived, not intended for replay. Original provenance verification already checked candidate/fixture/oracle and 24 skill-source digests. Do not infer host support, qualification or live acceptance from an offline test exit.
