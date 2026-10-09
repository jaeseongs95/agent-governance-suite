SS38 — fixed c6a8019 offline validation; operational acceptance incomplete

Commit c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6 / tree 28f2f2ed8a864405320f6d20e7bc5004e8466ad3
Fixture 17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9
Oracle 5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055

Existing scoped regressions: 5 PASS (14 filtered out). New isolated assertions: 11 PASS / 5 FAIL / 2 NOTRUN.
4 evaluator root causes; no product source modified. JEV/vendor API/Claude/native CLI/old21 rerun = 0.
SS38 oracle=null; semantic accuracy=null. Actual selected/read/applied/verified all NOTRUN.
120 planned mock protocol records pass cross-decoder parity; actual120 paired host trials remain NOTRUN.

Variant | result | scope
--- | --- | ---
paired-matrix | FAIL | offline=FAIL; live=NOTRUN
replay-contract | PASS | offline=PASS; live=NOTRUN
independent-provider-live | NOTRUN | offline=NOTRUN; live=NOTRUN
host-selection-live | NOTRUN | offline=FAIL; live=NOTRUN
unmatched-pair | FAIL | offline=FAIL; live=NOTRUN
same-wrong | PASS | offline=PASS; live=NOTRUN
null-vs-empty | FAIL | offline=FAIL; live=NOTRUN
allowed-alternative-disagreement | PASS | offline=PASS; live=NOTRUN

Findings (all offline evaluator/component boundaries):
- SS38-EVAL-01: Two state=NOT_RUN, skillIds=null observations give comparedPairs=1/exactSetAgreement=1; three null NOT_RUN repeats give stableGroups=1 for each host (tests/skill-classification/evaluation.ts:177,182,185-189)
- SS38-EVAL-02: Selected-only synthetic pair returns status=PASS, host golden=PASS/PASS with read/applied/verified all false; separately aggregate.stageCoverage is zero (tests/skill-classification/evaluation.ts:176-180)
- SS38-EVAL-03: Valid no-skill []/[] input produces status=PASS record with codex=null and claude=null (tests/skill-classification/evaluation.ts:171-180)
- SS38-EVAL-04: conditionDigest="" on both hosts yields comparedPairs=1, agreement=1, pair status=PASS (tests/skill-classification/evaluation.ts:173)

Reproduce:
```sh
cd <REPO>
pnpm exec vitest run tests/skill-classification/SS38.isolated.test.ts --reporter=json --outputFile=<EVIDENCE_DIR>/isolated.vitest.json
```
Expected exit1: five real spec assertion failures, not runner/import failures. See isolated.vitest.json and SS38.observations.json.

Host blockers: config absent, no callable AGS tools, no Claude executable. Codex executable exists but was not invoked; that alone is not qualified route evidence. Full authorization/profile/budget/task/host/stage/equivalence inputs are enumerated in SS38.result.json.
Generated Claude inventory semantics regression passes, but actual source/availability digest differs. Never silently treat it as a matched live pair.
No real host/provider trial, independent audit, or release acceptance claimed.
