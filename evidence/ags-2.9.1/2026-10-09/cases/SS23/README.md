# SS23 — AGS 2.9.1 existing evidence

This package publishes **existing** results only. No new test, environment, native host/model API invocation, or rerun of the earlier 21 provider runs occurred during packaging/publication.

- Candidate commit: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`
- Candidate tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`
- Fixture raw SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`
- Frozen oracle digest: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`
- SS23 oracle: `null`; semantic accuracy score: `null`.
- Actual selected/read/applied/verified: **NOTRUN**. Actual selection remains `null`, not `[]`. All host receipts from tests are synthetic.
- Existing new variant/contract checks: **7 PASS**, exit 0. Existing targeted regression: **6 PASS / 58 skipped**, exit 0. Existing acceptance cancellation reproduction: **1 FAIL**, exit 1.
- Original JEV/vendor/Claude API calls: **0**. Publication-time JEV/vendor/Claude/Codex API calls: **0**. Git transport is used only for the authorized evidence publication.
- Patch: **NOT_PRESENT**. No repair, product diff, or repaired green evidence exists.

## Existing variant outcomes

| Variant | Existing offline observation | Actual AGENT behavior |
| --- | --- | --- |
| normal | Recommendation does not select automatically; synthetic S accepted | NOTRUN |
| irrelevant-baseline | Synthetic final set excludes K even when raw includes K; B is test-owned input outside gateway | NOTRUN |
| missing-raw-cs | Raw CS miss stays observable; explicit/rule omissions rejected; synthetic S accepted | NOTRUN |
| force-copy-negative | Unsigned/caller receipt/raw omission rejected. Complete S copied with synthetic reasons/signature is structurally accepted, so the known copied control remains behavioral FAIL | NOTRUN |
| optional-uncertain-independent-partial | Settled S allowed as PARTIAL alongside optional K uncertainty | NOTRUN |

`S={ponytail,cs-engineering,software-security-auditor,test-engineering,orchestrator}`; `K=korean-prose-editor`. Same IDs are deduplicated while raw/explicit/rule sources remain recorded. Disabled SEC stays needed and leaves runnable; admission remains NOT_EVALUATED.

## Existing failure and limitations

Cancellation while `record_skill_selection` awaits runtime/inventory reads yields `valid=true`. Source: `mcp-server/src/skill-classification/gateway.ts:117–136`. This reproduces the **already known immediate-recheck concurrency gap**, with no additional root-cause count. The existing race log contains expected false versus observed true. Structural receipt validation cannot establish independent AGENT reasoning for a full copied S.

`TEST-SPEC.seq7.ko.md` is absent; only embedded SS23 source was used. `.agents/skills` was absent. Host paths and missing approved config/profile/route/allowance/task/skill observations are recorded in `SS23.host-support.json`. Engineering plan consistency was READY; engineering sensitivity proof remains INCOMPLETE because no product mutation/red-green or actual host run occurred.

## Reproduction instructions — not executed during publication

In an isolated checkout of the candidate commit, use Node >=24 and pnpm 11.19.0. Install the candidate's frozen dependencies using your approved package path. Copy the three published `.ts` reproduction files into `tests/ss23/` of that candidate checkout. Output-directory-only portability changes are declared in the manifest; observation files are written into the current checkout.

```sh
node scripts/run-tests.mjs tests/ss23/SS23.test.ts --maxWorkers=1
node scripts/run-tests.mjs tests/ss23/SS23-race.test.ts --maxWorkers=1
```

The existing first command passed 7 checks; the second failed at the cancellation assertion. Do not execute these instructions as part of evidence publication. The unchanged original argv and exit/status are retained in each public receipt; existing targeted regression argv is in `SS23.regression-receipt.json`.

## Public derivatives and missing originals

Original files remain private locally and are listed by bytes/SHA256 in `ORIGINALS.json`. Public JSON/log/test derivatives are explicitly labeled and separately hashed in `manifest.json`. Private checkout paths are replaced or removed; full repeated inventory source text is reduced to canonical IDs/count plus its existing digest. Necessary logs are extracted from original receipt fields; they were not generated again. Original receipt/plan/proof digests are not reissued as public derivative authority.

`SS23.input.txt` preserves UTF-8 bytes of the existing embedded originalPrompt without an added newline; it is not a provider wire capture. Missing: standalone original provider wire bytes, full saved request object for force-copy-negative, and actual host selected/read/applied/verified evidence. Each is **MISSING_ORIGINAL**; no result/log/patch or PASS was invented to replace them.

`manifest.json` covers all payload files except itself and `SHA256SUMS`; `SHA256SUMS` covers payload plus manifest, excluding itself. There is no circular hash. Remote publication and byte verification are reported separately after push.
