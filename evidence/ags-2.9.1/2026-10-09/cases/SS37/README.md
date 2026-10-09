# SS37 — existing AGS 2.9.1 evidence

This publication packages existing evidence only. No new environment, tests, past-run replay, or JEV/vendor/Claude/Codex model/API calls were performed. GitHub fetch/push is publication transport, not a model call.

Historical verdict: **FAIL**. Original targeted regression: **4 PASS / 0 FAIL / 17 skipped**, exit **0**. Original isolated SS37 checks: **10 PASS / 5 FAIL**, exit **1**. Original supplement: **2 PASS / 0 FAIL / 15 skipped**, exit **0**. These are separate recorded runs; skipped tests are not passes. Sensitivity proof: **INCOMPLETE**, exit **1**, all 15 red/green proofs **NOT_RUN**.

The eight variants were checked for structural metadata/input/expected/observed behavior. new-neutral-id, roles-swapped, id-renamed, dependency-hidden, and metadata-missing passed the offline structural checks. orchestrator-hidden, continuity-hidden, and session-board-hidden failed the gateway exposure check. Semantic selection/negative controls and two approved real-host runs remain **NOTRUN**. `selected/read/applied/verified` remain **NOTRUN**, selected remains **null**, and no host receipt was generated. The parent oracle is **null**, with no numeric accuracy score. `null` and `[]` were preserved.

Five failing assertions correspond to two previously known root causes: host inventory/state supply gap (four assertions) and identical applicability/exclusions for 23/24 canonical skills (one assertion). No new root cause is claimed. Local source MCP inventory exposed 24 IDs, compared with 21 registry IDs and 24 selector-request IDs. This was local source MCP, not host-live.

Fixed product candidate: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`; tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`. Fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`. Frozen oracle digest: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`. The oracle digest is the recorded corpus digest, not the file-byte SHA256 of a nonexistent standalone oracle file. `TEST-SPEC.seq7.ko.md` was absent; embedded SS37 source fields alone were used.

`SS37.result.json` is the sanitized public derivative of the original result. `SS37.observations.json` and `SS37.supplement.observations.json` preserve recorded inputs, expectations, observations, failures and limitations. Existing command JSONs preserve argv structure and actual exit codes, with local paths replaced by placeholders and environment override values removed. Existing stdout/stderr files are included; empty original stderr files remain empty. Vitest report copies omit skipped assertion details while retaining the original totals. No missing log was fabricated.

`manifest.json` records original and public byte counts/SHA256 independently. Original digests retained inside result/proof/observation objects bind historical original bytes; they do not attest sanitized objects. Test snapshots were sanitized only to replace the private output-directory literal with a repository-relative directory. These reproduction copies have **not** been executed. No original patch existed: see `PATCH_STATUS.json`. Original-recovery missing list: **[]**. There is no original model wire/real-host receipt/green fix because those actions were **NOT_RUN**; no such evidence is synthesized. The public prompt file contains the existing UTF-8 prompt string, without an added newline; it is not a transmitted wire capture.

Manifest hashing avoids a cycle: the manifest lists all payload files and excludes itself and SHA256SUMS. SHA256SUMS covers every payload file plus manifest.json, excluding itself. Both files' SHA256 values are returned in the publication completion report.

## Reproduction guidance — written only, not executed in this publication

Use a separate checkout of the fixed product commit with the original Node.js v24.19.0 and already provided compatible repository dependencies. Retrieve the frozen fixture from that commit and verify its SHA256. Do not use the moving evidence branch as the product candidate. Copy the desired recorded test snapshot into `tests/skill-classification/ss37-delegated.test.ts` in that product checkout.

For the original 15-check run, use `repro/SS37.test.v1.ts`:

```sh
node node_modules/vitest/vitest.mjs run tests/skill-classification/ss37-delegated.test.ts --maxWorkers=1
```

For the original two-check supplement, use `repro/SS37.test.ts` and the recorded filter:

```sh
node node_modules/vitest/vitest.mjs run tests/skill-classification/ss37-delegated.test.ts --maxWorkers=1 --testNamePattern='boundary-registry-neutral-addition|boundary-local-stdio-inventory'
```

The recorded original exit/status expectations are 10 PASS/5 FAIL (exit 1) and 2 PASS (exit 0), respectively. Running the current combined test file without a filter would be a new 17-check execution; this publication did not do that. Recorded command JSON contains the earlier exact commands in sanitized form. Placeholder paths are descriptive, not runnable environment values.

Real-host completion requires two approved inventories with installation/activation/support and revision observations, a gateway supply path, connected AGS MCP tools, approved qualified classification config/profile/route/budget or native allowance, and real host hook/task/session observations. Codex executable discovery alone was not route qualification; Claude was not invoked. New model calls and tests require a separate subsequent instruction.
