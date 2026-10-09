# SS32 — existing AGS 2.9.1 development evidence

This is a sanitized publication of existing test evidence. Publication did not rerun tests or call JEV/vendor/Claude/Codex classification APIs. It does not represent a release, qualification PASS, real AGENT selection, or host attestation.

## Fixed test candidate

- Commit: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`
- Tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`
- Fixture bytes SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`
- Frozen oracle SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`
- Original fixture `originalPrompt=null`, `oracle=null`; embedded SS32 fields only. No semantic accuracy score was manufactured.

## Existing results (unchanged)

| Scope | PASS | FAIL | Exit |
| --- | ---: | ---: | ---: |
| Selected existing SS32 regression | 6 | 0 | 0 |
| New isolated tests from the earlier test session | 11 | 3 | 1 |

| Variant | Offline status | Limitation |
| --- | --- | --- |
| `429` | FAIL | Numeric and HTTP-date Retry-After observations are discarded for 429/529; rate-limit status and one fallback checks pass. |
| `sdk-retry-negative` | PASS | Mock direct-fetch/queued-retry and native policy guard only; actual external SDK NOTRUN. |
| `duplicate-inflight` | FAIL | Basic delayed sharing/fallback sharing/unknown-cost no-reissue pass. Added cancellation boundary still dispatches one mock wire and settles mock USD0.1 after task cancellation. |
| `digest-collision` | PASS | Valid changed digest rejected INVALID for same/different operation while first request is pending, without contaminating the first result. |

Cancellation-before-dispatch reproduces the previously known concurrency recheck gap and is not counted as a new independent cause. Retry-After loss is one cause for two failing assertions; global novelty was not assessed. API calls in the prior test and this publication: 0. Prior 21-run live work was not rerun. `selected/read/applied/verified=NOTRUN`, `agentSelectedSkillIds=null`, `hostReceipt=null`. Actual baseline B and purpose judgment were unavailable. Empty classification judgments/unresolved arrays are not an accepted AGENT no-skill selection.

Sensitivity red/green proof: INCOMPLETE, because no product repair/mutation was authorized. Local acceptance report: FAIL; its existing report consistency check was valid=true. Generation/check command process exit0 does not turn the report verdict into PASS.

## Contents and original/public distinction

- `SS32.result.public.json`: existing full result, sanitized; its embedded original SHA/canonical references refer to original bytes.
- `observations.public.json`: all 14 existing input/expected/observed observations and mock wire counters/settlement snapshots.
- `logs/`: existing stdout/stderr, command exits and Vitest results. PID values, local paths and dependency stack detail are sanitized. Skipped unrelated assertion details are omitted from the existing-regression report; original aggregate counts are retained and the omission is declared.
- `repro/SS32.isolated.test.ts`: existing test file. Only its purely synthetic credential stand-in string was replaced by a public sentinel; no assertion was added/changed or executed during publication.
- `inputs/` and `input-bytes-manifest.json`: explicit derived UTF8 encodings of existing observed inputs, with bytes/SHA256 and original observation-file binding. **Original serialized transport wire bytes: MISSING_ORIGINAL.** Parsed request IDs/digests/counters exist; no missing wire capture was invented.
- `support/`: selected existing plan/proof/acceptance/snapshot files, sanitized. Public versions are not asserted to pass original-byte canonical checks; no acceptance checks were rerun during publication.
- `PATCH_STATUS.json`: **NO_EXISTING_PATCH**. No product/test patch was reconstructed or generated.
- `manifest.json`: original/public bytes and SHA256, sanitation and omission records. It excludes its own hash and SHA256SUMS to avoid circular hashing.
- `SHA256SUMS`: every public payload file plus manifest, excluding itself. Its digest is reported independently after remote verification.

All original recorded evidence SHA values were recovered and matched. Missing-original list contains only the unsaved serialized wire capture. Original archive and redundant private metadata are not published; their original digests are recorded. Private local paths, credentials, environment values and personal conversations are excluded.

## Reproduction guidance — not executed during publication

Use a separate checkout of the fixed candidate, not the evidence branch. Node24.19.0, pnpm11.19.0 and lock-identical existing dependencies were used in the earlier session. Copy `repro/SS32.isolated.test.ts` into candidate `tests/skill-classification/SS32.isolated.test.ts`; create candidate `evidence/SS32/`. With appropriate local dependencies already available, from that candidate root:

```sh
node scripts/run-tests.mjs tests/mcp/skill-classification-providers.test.ts tests/mcp/skill-classification-service.test.ts -t 'SS30/32 HTTP (429|529)|SS28/30/32 RATE_LIMITED|SS32 (concurrent|rejects|bounded)'
node scripts/run-tests.mjs tests/skill-classification/SS32.isolated.test.ts
```

Expected existing-regression exit0 and isolated exit1 with the three captured assertion failures. No product build/full suite/bootstrap/prior live run/API request is required by these commands. The test uses mock fetch only.

Actual host follow-up would require connected classification MCP tools, trusted fixed qualified profiles/routes/balances or native retry/isolation evidence, live host task source and signed exact-call observation. These were absent. Do not generate a fake host receipt or elevate stages from NOTRUN.

## Publication boundary

Only this SS32 directory is added on `evidence`; main, tags, product roots and other cases are untouched. Non-force push is used, with fresh remote fetch/reapply if another evidence writer advances the branch. Public Git content can be corrected by a future scope-limited commit preserving other writers; an actual rollback was not executed or claimed as tested. The user's latest explicit publication authorization applies to this path. Historical push=0/prohibited-push fields retained in original test metadata describe the earlier test session, not this authorized publication.
