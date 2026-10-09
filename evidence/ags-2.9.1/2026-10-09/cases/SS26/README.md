# SS26 existing evidence publication

This package publishes prior offline evidence only. No new environment, test run,
previous provider run, JEV/vendor/Claude/Codex model call, or repaired-candidate test was performed.

Candidate: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`, tree
`28f2f2ed8a864405320f6d20e7bc5004e8466ad3`, target branch
`codex/skill-classification-2.9.1`.
Fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`.
Frozen oracle digest: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`.
SS26 is an operational mechanical case: originalPrompt and semantic oracle are null.

| Existing variant | Status |
| --- | --- |
| description | PASS |
| applicability | PASS |
| exclusion | PASS |
| new-skill | PASS |
| duplicate-id | FAIL |
| missing-description | FAIL |
| id-conflict | FAIL |
| version-conflict | FAIL |
| taxonomy-conflict | FAIL |
| source-generated-conflict | FAIL |
| delete | FAIL |
| disable | FAIL |

Final isolated run: exit 1, 13 tests (5 passed including binding, 8 failed).
Existing targeted regressions: exit 0, 2 passed, 4 skipped. Neither is full-suite PASS.
Prepared-plan consistency was READY; repaired-candidate red/green proof was INCOMPLETE,
with all such proof items NOT_RUN. This does not erase executed variant observations.

Findings: incomplete/conflicting subject metadata hides independent complete candidates
at gateway (and generated-projection loader); late delete/disable advice is returned as
SUCCESS against old inventory. Final selected IDs remain null. The current-inventory
selection validator rejected stale inventory; real AGENT selection overwrite was not observed.
The latter is linked to the known state/concurrency recheck gap, not counted per variant.

Actual host selected/read/applied/verified: NOT_RUN. No host receipt was issued.
Missing host configuration/qualified profile/signed observation and repaired candidate remain open.
No product patch exists; `tracked-diff.txt` is the original empty tracked diff.

`public.result.json`, per-variant observations, prior r1 records, synthetic snapshots,
retained stdout/stderr, command records, and test copies are derived from existing files.
Private local paths are redacted. Original byte counts/hashes and public byte counts/hashes
are separate in `manifest.json`; internal historical digest fields retain their original meaning.
The public test copies were not executed. See `repro/COMMANDS.txt` for reproduction instructions.

MISSING_ORIGINAL: standalone TEST-SPEC.seq7.ko.md; version-specific r1 stdout/stderr/command
receipt. Embedded source, r1 JSON and test remain available. Missing records were not reconstructed.

`manifest.json` hashes payload files and excludes itself and `SHA256SUMS` to avoid cycles.
`SHA256SUMS` hashes all other published files including manifest.json, and excludes itself.
The publisher separately reports hashes of both index files and verifies Git remote blob bytes.
Publication checks are packaging/remote integrity checks, not new AGS tests, host verification,
independent audit, release acceptance, or corrected-candidate PASS.
