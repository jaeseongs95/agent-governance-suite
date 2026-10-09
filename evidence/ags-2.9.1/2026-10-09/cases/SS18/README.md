# SS18 — AGS 2.9.1 existing offline evidence

This package publishes an existing test result. Publication ran zero new tests and zero JEV, external vendor, Claude or Codex model/API calls. Git fetch/push and file/hash inspection are publication operations.

- Candidate: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`; tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`.
- Source fixture: `tests/skill-classification/fixtures.json`, SHA256 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`.
- Frozen oracle SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`.
- `TEST-SPEC.seq7.ko.md` was absent. Only the embedded SS18 fields were used. SS18 has one frozen variant, `base`; eight extra boundary checks are distinctly identified.

## Existing outcomes

| Existing check | Actual outcome | Exit |
|---|---|---|
| SS18 evaluator regression only | 1 PASS, 14 skipped | 0 |
| SS18 independent offline checks | 7 PASS, 2 FAIL | 1 |
| Scoped strict TypeScript check | PASS | 0 |
| Test-plan consistency | READY | 0 |
| Sensitivity proof consistency | INCOMPLETE; red/green NOT_RUN | 1 |
| Native host selected/read/applied/verified | all NOT_RUN; observed selection null | none |

Raw injected `{ponytail}` remains FAIL for missing security and orchestrator. The mandatory security rule is retained as `{ponytail, software-security-auditor}` and does not manufacture orchestrator. A separately supplied synthetic `{ponytail, software-security-auditor, orchestrator}` decision passes mechanical acceptance; this is not actual AGENT selection, a security audit or execution approval. Real model accuracy is unmeasured. Null and empty arrays are preserved.

Two already known root causes were reproduced, with no new-root-cause count: cancellation during asynchronous acceptance is accepted with `valid:true`, and trusted host-supported skill state has no gateway supplier. The loader observes simulated unsupported SEC as false; gateway defaults to true. Actual native host state was not tested.

## Contents and reproduction

`SS18.public.result.json` preserves the historical result with private absolute paths replaced by placeholders. `observations.public.json` contains existing input/expectation/observation objects. Necessary combined logs and original exit files are under `logs/`; separate stdout/stderr and original provider wire bytes are `MISSING_ORIGINAL` in `ORIGINALS.json`. No existing patch exists.

`SS18.fixture.json` is the byte-identical existing SS18 extraction, not the full fixture file. The original full fixture SHA above is retained. `reproduce/original-prompt.utf8.txt` and `SS18.input.derived.json` are labelled derived extractions, not captured transport bytes. The portable reproduction test changes only its output path and has NOT_RUN status after packaging. Follow `reproduce/commands.txt` in the fixed candidate checkout with prepared dependencies; instructions were not executed during publication. Adapted plans/proofs preserve their original digests as historical evidence, and are not revalidated proofs for the portable adaptation.

Actual host testing needs an approved current classification config, centrally qualified fixed provider profile, approved route/quota/budget, trusted mandatory-rule revision and conflict authority, live native exact-call attestation and task observation, and fixes for the host-state supplier/post-await recheck gaps. Codex executable existence alone was not qualification. Claude was not available. No prior 21-case run was rerun.

## Provenance and integrity

`manifest.json` records public file bytes/SHA256 and original source bytes/SHA256 with transformations. Omitted originals are listed by digest; personal paths, environment values, credentials and private conversations are not published. README/commands/manifest are newly prepared publication metadata, not newly generated test results or logs.

The manifest excludes itself and `SHA256SUMS` to avoid circular hashes. `SHA256SUMS` covers all payload files plus the manifest and excludes itself. Publication commit and final remote verification are reported by the publishing agent after push. Package status remains INCOMPLETE_WITH_REPRODUCED_KNOWN_DEFECTS, not complete-case PASS or release approval.
