# SS35 existing evidence publication

This package publishes the already executed SS35 offline assessment for AGS 2.9.1. Publication did not run a new test, create a new environment, replay prior runs, or invoke JEV/vendor/Claude/Codex APIs. GitHub Git fetch/push are publication operations only.

Candidate commit: c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6. Candidate tree: 28f2f2ed8a864405320f6d20e7bc5004e8466ad3.
Fixture SHA256: 17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9.
Frozen embedded oracle SHA256: 5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055.

Original SS35 assessment: FAIL. Existing regression: 1 PASS, 14 skipped, exit 0. New offline checks from the earlier run: 17 executed, 10 PASS, 7 FAIL, exit 1. Publication-phase new tests: 0. Historical 21-run replay: 0. API calls: 0.

family-clean passed structural family disjointness only; real threshold/prompt freeze and independent holdout provenance were unavailable. translation-leak and paraphrase-leak were detected in both directions. post-holdout-tuning exposes an unsupported history/revision input rather than an actual final score reuse. Seven failed assertions group into three causes: absent tuning-history input, missing family validation, and conflicting duplicate case ID overriding a family in a Map. Malformed runtime inputs were synthetic test data, not changes to the frozen fixture.

Host selected/read/applied/verified: NOTRUN. selectedSkillIds and hostReceipt: null. originalPrompt and semantic oracle for SS35: null. No accuracy score is invented. An issue list [] is not accepted AGENT no-skill selection []. Worker reading/testing is separate from host observations. Engineering consistency result is INCOMPLETE (red/green NOT_RUN); final-integrity PASS refers only to evidence consistency and tracked-file preservation and does not override SS35 FAIL.

TEST-SPEC.seq7.ko.md was absent; only recovered embedded SS35 source fields were used. All required result, stdout/stderr, command exits, observations and test source originals were recovered. No existing product patch existed. A separate original oracle file is not claimed: its complete bytes live in the frozen fixture, and fixtures/oracle-digest-preimage.json is a clearly derived digest preimage.

## Public bytes and provenance

All files under records/, commands/ and logs/ are clearly identified sanitized copies. Machine-local paths become symbolic placeholders. Existing test JSON retains actual failures but omits irrelevant dependency stack frames; stderr omits process IDs. No credential/environment values, private conversations or personal absolute paths are included. Original references use filenames or pinned repository-relative paths; original bytes/SHA256 and public bytes/SHA256 are recorded separately in manifest.json.

Historical fields such as push:false describe the original test run, not this publication. Original artifact checksum lists cover original bytes; they must not be used as checksums of sanitized public files. manifest.json and SHA256SUMS cover this package's public bytes.

## Reproduction instructions — not executed during publication

Use an already prepared checkout at the exact candidate commit/tree with the repository's existing Node 24.19.0, pnpm 11.19.0 and dependencies. Copy reproduction/SS35-probes.ts and reproduction/SS35-isolated.test.ts into tests/skill-classification/ in that checkout. The only adaptation to the original test source is observation output relative to the test file. The full original fixture is provided for byte comparison; do not change its bytes or invent the missing source specification.

From the candidate repository root:

```sh
node scripts/run-tests.mjs tests/skill-classification/SS35-isolated.test.ts --reporter=json --outputFile=ss35-isolated-report.json
node scripts/run-tests.mjs tests/skill-classification/evaluation.test.ts -t 'rejects translations and synonyms leaking across split' --reporter=json --outputFile=ss35-existing-report.json
```

Expected historical exits are 1 and 0 respectively. The observation output of the adapted test is tests/skill-classification/ss35-reproduction-observations.json. Do not run the entire suite or any model/provider bootstrap to reproduce this offline case. Raw historical command records are under commands/ and contain symbolic cwd/output placeholders, not executable guessed local paths.

Remaining inputs: a trusted threshold/prompt revision freeze, holdout/tuning access history and fresh unseen holdout provenance. Host evidence additionally needs an installed trusted AGS plugin, actual active inventory, approved/qualified configuration and authentic signed selection/stage observations; no host behavior was established by these records.

## Hash closure

manifest.json lists payload files with file sizes and SHA256 plus original provenance; it deliberately excludes itself and SHA256SUMS to avoid circular hashing. SHA256SUMS lists every public payload file plus manifest.json and excludes only itself. Final remote verification checks every published file, including SHA256SUMS, against locally prepared bytes. This publication changes only evidence/ags-2.9.1/2026-10-09/cases/SS35/.
