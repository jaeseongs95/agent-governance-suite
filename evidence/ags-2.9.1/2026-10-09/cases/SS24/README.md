# SS24 — existing AGS 2.9.1 development evidence

Historical overall result: **FAIL**. All four embedded-spec variants passed offline mock checks; two additional boundaries failed. Existing targeted regressions: 8 passed. Real host selected/read/applied/verified remain **NOTRUN**. Semantic oracle and originalPrompt are `null`; accuracy stays `null`. Provider API calls: JEV 0, vendor 0, Claude 0. This publication executes no new tests or provider calls.

Candidate commit: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`; tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`.
Full frozen fixture SHA256: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`.
Frozen oracle SHA256: `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`.

| Scope | Historical state |
| --- | --- |
| on-to-off | PASS, new offline mock |
| profile-ref-change | PASS, new offline mock |
| profile-revision-change | PASS, new offline mock |
| before-selection-race (OFF) | PASS, new offline mock |
| Cancellation during acceptance await | FAIL: cancelled task still accepted by synthetic gateway |
| Known cost in invalid delayed response | FAIL: mock cost 0.1 became null; ledger spent 0 retained unknown 0.4 reservation |
| Real provider / host selection | NOTRUN |

Both failures witness already-known root causes: the pre-selection current-task recheck gap and valid-cost loss with invalid RESP. New unique root causes claimed: 0. Mock signatures/receipts/choices are synthetic test inputs; they are not real AGENT selection evidence. Final choice belongs to AGENT, classification is support only.

`SS24.result.json` preserves input/expected/observed references, command exits and limitations. `logs/final-isolated.vitest.json` is the final historical 4-pass/2-fail run (exit 1). `logs/existing-*` are the two historical 4-pass runs (exit 0), not a whole-suite pass. `logs/initial-test-counter-error.isolated.*` records an initial test-helper counter error; it is superseded and is not a product finding. Intermediate `logs/isolated.*` is also retained separately. Empty historical stderr files remain empty. Engineering proof remains INCOMPLETE: no fixed candidate green/mutation pair was authorized or claimed.

## Provenance and missing originals

All public files are individually bound in `manifest.json` to bytes/SHA256 and original artifact bytes/SHA256 where applicable. Raw local paths were redacted. Large observation logs replace repeated public repository inventory bodies with one `inputs/mock-inventory.json` reference; outputs are labelled sanitized source projections. Input subtrees were extracted from existing observations and reserialized; these are not original provider wire bytes. Their public bytes/SHA256 are in the manifest. The original full fixture remains in the pinned repository and is not duplicated into this single-case package.

Missing originals: `TEST-SPEC.seq7.ko.md` was absent at original validation; embedded SS24 fields alone were used. Exact serialized provider wire was not captured (offline mocks, no network wire). `originalPrompt=null` and `oracle=null` are intentional source values, not recovered or invented answers. Real host/provider logs were never run. **No product patch exists; no patch was generated for publication.** All pre-existing local SS24 evidence artifacts listed in the original inventory were recovered.

The manifest inventories payload files, excluding `manifest.json` and `SHA256SUMS` to avoid circular hashes. `SHA256SUMS` covers payload files and `manifest.json`, excluding itself. The final publication report reports separate manifest/SHA256SUMS digests and verifies all remote files, including these two integrity files.

## Reproduction guidance — not executed for publication

Use a separate checkout of the fixed candidate, Node 24.19.0 and the pinned repository dependencies. The evidence branch itself contains evidence rather than the product checkout. Copy `reproduce/SS24-isolated.test.ts` and `reproduce/SS24-cost-boundary.test.ts` into `tests/mcp/` of that checkout; create the `SS24-evidence` output directory there. These public test copies only replace the original machine-specific output directory with the portable relative `SS24-evidence` directory. Their assertions were not rerun after this packaging edit.

```sh
mkdir -p SS24-evidence
node node_modules/vitest/vitest.mjs run \
  tests/mcp/SS24-isolated.test.ts \
  tests/mcp/SS24-cost-boundary.test.ts
```

Historical expected exit: **1**, with four variant passes and the two boundary failures. Exact original commands and exits are retained with local-path redaction in `logs/*.command.json`. Do not reinterpret reproduction guidance as new execution evidence.

Real host support would require trusted classification config, qualified profile/route and budget/native allowance, exact-call attestation and authoritative current-task/cancellation state. Those inputs were missing. The configured installation entry point is `node mcp-server/dist/server.mjs` with trusted classification configuration; no host or native Codex/Claude classifier was invoked by this publication.
