# SS13: AGS 2.9.1 existing offline evidence

This is a sanitized publication of existing SS13 evidence. Publication ran **0 new tests** and **0 JEV/vendor/Claude/Codex model calls**. Only `SS13/base` was investigated. No product patch exists.

The historical run executed 19 offline mock boundary tests: **18 PASS, 1 FAIL, exit 1**. Full live SS13 completion and actual AGENT `selected/read/applied/verified` remain **NOTRUN**. Actual selected IDs are `null`; expected accepted no-skill is `[]`. Mock recommendations and test records are not real AGENT selection receipts. The original engineering sensitivity result is `INCOMPLETE`; a corrected green candidate was not produced.

The single failing test reproduces the previously known valid-cost-loss defect: a mock provider returns actual cost `0.1` with an incomplete response; service returns `INVALID_PROVIDER_RESPONSE`, changes cost to `null`, records spent `0`, and retains a `0.4` unknown reservation. This is the existing root cause, not a new deduplicated finding. No real charge occurred.

## Fixed source and input

- Product commit: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`
- Product tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`
- Fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`
- Frozen oracle SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`
- Inventory: all 24 AGS candidates; digest `sha256:b7aa250a96c14ebc7132d3a0c20895ef6a07ec023a85ec1cb6cc04e4eaa7dc82`
- `input.prompt.txt` preserves the exact UTF-8 prompt bytes with no newline. `input.request.json` and `input.inventory.json` extract existing objects from the original observations; their file SHA256s describe public serialization, not a previously recorded transport wire.
- `source.fixture.SS13.json` preserves the original prompt, embedded sourceSpec fields, oracle, and sole `base` variant. `TEST-SPEC.seq7.ko.md` was absent; no missing specification or answer was invented.

## Files and provenance

`SS13.result.json` preserves variant status and each boundary's input/expected/observed references. `SS13.observations.json` replaces repeated equal request/inventory/fixture objects with references to the three public input/source files; expand those references to recover those original objects. Personal machine paths are redacted as root placeholders. `logs/offline.combined.log` is the sanitized existing combined stdout/stderr, and `exit-code.txt` is byte-identical. The independent stdout/stderr files are `MISSING_ORIGINAL`; no split logs were reconstructed.

`supporting/` contains sanitized existing runner and engineering reports. Historical snapshot/plan digests remain hashes of the original bytes and do not validate the public adaptations. Public bytes/SHA256 and original artifact bytes/SHA256 are separately listed in `manifest.json`. Original logs/results/tests remain locally retained; their digests are not substituted with public file digests.

There is no original live wire capture, host receipt, or product patch (`MISSING_ORIGINAL`, never created). Missing approved classification configuration, profile/route qualification, budget/allowance evidence, connected AGS MCP tools, and host-signed task observation prevent host-live completion.

## Future reproduction instructions — not executed for publication

Use a separate product checkout at the fixed commit with already prepared frozen dependencies (Node 24.19.0, pnpm 11.19.0, Vitest 5.0.0). The evidence branch contains evidence, not the required product checkout. From this SS13 directory:

```sh
bash reproduce/reproduce.sh /path/to/fixed-product-checkout /path/to/new-output-directory
```

The public test is mechanically adapted from the existing test only to use supplied root/output paths and resolve imports. Assertions are retained; the adaptation was **NOT_EXECUTED**. The script runs only SS13 offline mocks and is expected to return exit `1` for the known cost-loss assertion on the fixed candidate. Do not confuse this future command with the historical run already recorded.

## Integrity

`SHA256SUMS` hashes all payload files except itself and `manifest.json`. The manifest records every other published file, including SHA256SUMS, and excludes its own hash to avoid a cycle. Its independent SHA256 is reported in the publication completion message. No main/tag/product/other-case path is part of this publication.
