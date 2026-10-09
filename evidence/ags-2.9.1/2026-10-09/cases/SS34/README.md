# SS34 — existing AGS 2.9.1 offline evidence

Publication only. No new test, past run, provider request, credential access, or live host trial was executed while packaging and publishing this directory. JEV / external vendor / Claude / Codex API calls: **0**. No product patch existed and none was generated.

## Original result

**FAIL**, original Vitest exit **1**. The original 19 assertions contain 13 PASS and 6 FAIL. The eight frozen variants contain 7 PASS and 1 FAIL:

| Variant | Original offline result |
|---|---|
| recommend-only | PASS |
| selected | PASS |
| read | PASS |
| applied | PASS |
| verified | PASS |
| wrong-candidate | PASS |
| missing-k-phase | PASS |
| no-admission-negative | FAIL (expected FAIL; evaluator returned PASS) |

Additional failing boundaries: wrong environment, wrong source digest, missing/unplanned verification evidence, unrelated obligation artifact, and a shortened required K phase list. These are grouped into three evaluator root causes in `SS34.result.json`, not five new product defects. The operational evaluator rejects the real SS34 `oracle=null`; a separate, explicitly synthetic sentinel exercises only the stage predicates. No semantic oracle or accuracy for SS34 was invented.

Actual host **selected/read/applied/verified: NOT_RUN**. The gateway integration used a mocked service port and synthetic unsigned observation; its separation check passed offline and does not establish real AGENT selection or workflow admission bypass. Original red/green sensitivity and independent audit remain NOT_RUN; the original engineering proof check is INCOMPLETE, exit 1.

## Fixed original candidate and inputs

- Repository: https://github.com/jaeseongs95/agent-governance-suite
- Candidate branch: `codex/skill-classification-2.9.1`
- Commit: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`
- Tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`
- Full original fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`
- Frozen oracle digest: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`
- `SS34.fixture.json` preserves the extracted SS34 bytes and every embedded sourceSpec field exactly. `SS34.observations.json` preserves the existing trace inputs, expected values and observations exactly. Input bytes and SHA256 are listed in `manifest.json`.
- SS34 originalPrompt/oracle/semanticAccuracy remain `null`; `null` and `[]` retain their original distinctions.
- `TEST-SPEC.seq7.ko.md`: **MISSING_ORIGINAL**, already absent at the original test. Only its embedded SS34 source was used. No missing source, log, result or patch was recreated.

## Evidence and sanitization

`SS34.command.json`, stdout/stderr, Vitest report and evidence-check commands preserve the original run/exit evidence. Private absolute paths are replaced only in derived files. `REPOSITORY_ROOT` and `PUBLIC_REPRO_OUTPUT` are symbolic replacement labels, not original path values. The unrelated private environment file is withheld; its original bytes/hash remain in the provenance inventory.

`manifest.json` records each public payload's actual bytes/SHA256 plus its recovered original artifact's bytes/SHA256 and whether it is exact or sanitized. `SS34.original-manifest.json` is the recovered original inventory, not the new public manifest. Original plan/proof/snapshot digests refer to original bytes. A sanitized plan or reproduction file does not claim to retain original byte identity or to have been revalidated/reexecuted.

`manifest.json` hashes payloads, but excludes itself and SHA256SUMS. SHA256SUMS hashes all payloads and manifest.json, but excludes itself. Their two final hashes are reported separately after remote verification; no circular hash is used.

## Reproduction instructions — written, NOT EXECUTED

Use a separate checkout at the exact original commit/tree with Node v24.19.0, pnpm 11.19.0 and the original repository dependencies. Copy `reproduce/SS34.delegated.test.ts` to `tests/skill-classification/SS34.delegated.test.ts` in that checkout. The public reproduction changes only the private output directory to `SS34_EVIDENCE_OUTPUT` or the current directory. Its digest is distinct from the original test digest and no new run is asserted.

From that checkout, the documented offline command is:

```sh
mkdir -p SS34-repro-output
SS34_EVIDENCE_OUTPUT=SS34-repro-output node node_modules/vitest/vitest.mjs run tests/skill-classification/SS34.delegated.test.ts --reporter=verbose --reporter=json --outputFile.json=SS34-repro-output/SS34.vitest.json
```

At the recorded candidate the original result was exit 1 (13 PASS / 6 FAIL), not a full-case or full-suite PASS. Do not rerun other cases, the 21-call bootstrap, provider-live or host-live paths as part of reproduction. This publication has not run the command above.

Real host completion still requires AGS MCP tool exposure, an approved classification configuration if classification is used, exact current-session attestation and host task inputs, independent admission, skill/reference digests, mandatory capability stages, candidate/environment bindings, and planned actual verification artifacts. Executable presence and mock receipts establish none of these.

This publication is authorized only in `evidence/ags-2.9.1/2026-10-09/cases/SS34/` on the `evidence` branch. No main, tag, product root, or other case path is changed. Publication checks are not an independent audit or release approval.
