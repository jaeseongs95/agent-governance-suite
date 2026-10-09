# SS02 existing evidence publication

This directory publishes only the prior SS02 isolated development run. Packaging and Git publication performed **zero new tests**, zero JEV/vendor/Claude/Codex model or host invocations, and no product modification. Git fetch/push is repository traffic, not model API traffic.

Pinned product commit: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`
Pinned tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`
Fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`
Frozen oracle SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`

The original single `base` variant's prompt, all embedded source fields and oracle are retained. The unavailable external TEST-SPEC file and unspecified E0 definition were not invented. SS01 was read only to resolve SS02's inherited hold condition; no SS01 execution occurred. The English prompt requires ponytail; adding CS/CR/SEC/O is forbidden. Missing implementation code does not turn the request into no-skill.

## Existing observations, unchanged

- Offline derived controls: **17 total, 15 PASS, 2 FAIL; process exit 1**.
- The two failures reproduce existing roots: valid cost 0.125 disappears into null for INVALID_PROVIDER_RESPONSE (spent 0, reservation 0.4 retained); gateway lacks a way to propagate observed empty host installed/supported lists and defaults to true/true.
- These are synthetic provider/public support boundary tests, not model classification accuracy. New root cause count: 0. Semantic accuracy: null.
- Actual SS02 host `selected/read/applied/verified`: **NOTRUN**. Original observation `state` remains `NOT_RUN`, `skillIds` and `hostReceipt` remain null; null is not converted to [].
- Existing direct SS02 regressions: none run; whole suite and previous 21-call batch were not run. Plan `READY` is consistency only. No green fix/mutation proof exists.
- JEV, external vendor API, Claude, Codex CLI and host-live invocations: **0** in both the original case work and this publication.

## File provenance and missing originals

`manifest.json` inventories original private artifact byte counts/SHA256 separately from public file byte counts/SHA256 and explains transformations. Local paths and irrelevant PIDs are removed from public derivatives. Public originals or responses are not regenerated. `SHA256SUMS` covers payload files and manifest, excluding itself to prevent a circular hash. The manifest excludes itself and SHA256SUMS; their final SHA256 values are reported by the publisher.

Original combined stdout/stderr: recovered as `SS02.test.combined.public.log`. Separate stdout and separate stderr files: **MISSING_ORIGINAL**, because the original run redirected both streams into one log. The original exit 1 is retained in result and subreaper output. Existing product patch: **NO_EXISTING_PATCH**; no patch was generated during publication. All 12 existing artifact files are inventoried and recovered; the old artifact manifest is inventoried instead of reused as the public manifest. Fixture bytes remain at the pinned product commit; only the SS02 case is published here.

## Reproduction instructions — NOT EXECUTED during publication

Use an isolated checkout of the pinned product commit with its frozen lockfile, Node 24.19.0 and existing Vitest 5.0.0 dependencies. Copy `SS02.independent.public.test.ts` to `tests/skill-classification/SS02.independent.test.ts` in that checkout. Create relative output folder `.ss02-evidence`, then run from the product root:

```sh
mkdir -p .ss02-evidence
node scripts/run-tests.mjs tests/skill-classification/SS02.independent.test.ts --reporter=json --outputFile=.ss02-evidence/SS02.vitest.json
```

At the pinned product candidate, expected exit is **1** for the two retained failures. The public test differs only in output locators; its public SHA256 is separate from the original test SHA256. This example is guidance only and was not executed by the publisher. Original command/exit records are in `SS02.result.public.json`; `<PRODUCT_CHECKOUT>` denotes a redacted locator, not literal shell syntax to execute.

Real host testing still requires the AGS MCP inventory/classify/record tools, qualified fixed profile/runtime/route, trusted host inventory/attestation/session bindings, and original function/code target. Neither a binary's presence nor test-made receipts establish AGENT selection. See the existing result's hostLive.requiredInputs. No approvals, settings or secrets are shipped here.
