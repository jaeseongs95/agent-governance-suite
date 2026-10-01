# G18 isolated UTF-8 stdin reproduction

The original shared CLI bytes reproduce a UTF-8 chunk-boundary defect. The evaluator can report `READY` while its original Korean/emoji text and action digest have changed; the receipt verifier rejects the original valid receipt. A disposable copy with one encoding line added to each CLI passes the bounded reproduction cases. No canonical product change or source GO is asserted.

## Candidate and results

Candidate commit: `a7c049d5de392651b102840cb7e75243e1afe317`.

Candidate tree: `7028d31985a497dfbb4f8e74c9a219b3400bffa2`. The execution checkout was clean and all three inspected original files matched Git HEAD after execution. Runtime: Node `v24.19.0` on the selected Linux execution environment.

| Phase | UTC start | UTC end | Harness exit | Passed | Failed |
| --- | --- | --- | ---: | ---: | ---: |
| Original bytes | 2026-10-01 23:29:38.904 | 2026-10-01 23:29:45.037 | 1 | 19 | 14 |
| Ephemeral proposed copy | 2026-10-01 23:30:07.170 | 2026-10-01 23:30:13.093 | 0 | 33 | 0 |

Each phase has 32 CLI cases plus one existing-contract process. That contract process runs all 13 tests in `tests/mutation-risk-preflight/preflight.node-test.mjs` and passes in both phases. Seven decoder controls also pass in each phase and are recorded separately from the 33 checks. The existing contract passed once during preparation before the recorded harness run. No tests were repeated for publication.

The evidence branch is directly based on this candidate. Its requested `20261002` name is a publication label; the executions above occurred on 2026-10-01 UTC.

## Boundary and controls

[harness.mjs](harness.mjs), [stream-preload.mjs](stream-preload.mjs), and [decoder-control.mjs](decoder-control.mjs) are the exact executed external diagnostic sources. They are artifacts outside the product test runner. The deterministic transport uses an actual `Readable` with `objectMode: false`, `highWaterMark: 1`, a `_read` callback, and asynchronous `setImmediate` ticks that call `push` with byte slices. The observer yields untouched values from Node's original async iterator. No direct `emit(data)` or decoder-bypassing mock supplies the data.

Both CLIs are exercised with Korean 3-byte codepoint boundaries after bytes 1 and 2, emoji 4-byte boundaries after bytes 1, 2 and 3, one-byte chunks, and a whole-input control. Decoder controls and the proposed reader use Node's real `setEncoding`/StringDecoder path. Original raw fixture bytes and hashes remain independent of decoded output, and the expected action/target digests use a separate canonical fixture projection.

Both CLIs are also invoked through actual OS stdin pipes, with asynchronous byte writes and backpressure, and through `--input`. Baseline large input sizes are 1,312,501 bytes for evaluation and 2,625,515 bytes for receipt verification. Actual OS receive chunk geometry is observed in trace files and is nondeterministic.

The 14 original failures consist of 12 forced-boundary failures (five multibyte cuts and one-byte chunks, each for both CLIs) plus the two large OS-stdin cases. Whole-input and `--input` equivalents pass. In the baseline large OS cases, all original bytes arrived, but per-chunk string coercion introduced replacement characters: 44 for evaluation and 86 for verification.

Fresh synthetic deny, expiry-at-exact-TTL, extended-validUntil tamper, and changed-original-text cases retain denial through both OS stdin and `--input`. The original contract's historical dates are deterministic unit-test constants, not receipts reused as current authority. The external harness generated new approval/report/verification timestamps separately for each phase.

## Inert proposed change

Only the two temporary copy files below received this inserted line immediately before `let raw = "";` and stdin iteration:

```js
process.stdin.setEncoding("utf8");
```

| Copy file | Original SHA-256 | Proposed-copy SHA-256 |
| --- | --- | --- |
| `skills/mutation-risk-preflight/scripts/evaluate-preflight.mjs` | `39ad62d3f1bde2194d3efd116ee81b52e1d59cbeb6a30d5a2a8beb3db4d4b1a5` | `109fca1977105aebf564d624470a3c38779bb0bea835ee7a7a90e970ac3279fe` |
| `skills/mutation-risk-preflight/scripts/verify-preflight-receipt.mjs` | `0c738b534c3fb15bd9919873df6cd9e05314647de9cefdba541748f8ee3e612f` | `9853f6b81f10021ed3b490036fc650291249771506768617a05bbfb47f3e2a49` |

The original contract test SHA-256 is `20e38a93b2c018f8aaa6bba938382edf4b14185e4d72e710b22900a57d08828e`. Temporary source copies were removed. This description is inert; neither product CLI, generated artifact, nor canonical test file is changed on this branch. No build ran.

## Evidence and reproduction

- [Structured report](REPORT.json) contains full command/cwd/time/exit information, gate context, routing distinction, hashes and limits.
- [Baseline summary](baseline/summary.json) retains all 14 failure identities and reasons.
- [Proposed-copy summary](proposed-copy/summary.json) retains its separate 33-pass result.
- Each case retains synthetic `.input.json`, normalized raw `.stdout`/`.stderr`, a `.receipt.json` with original byte hashes, and a `.trace.json` when the stdin observer applies.
- [artifact-review.json](artifact-review.json) records the complete publication inventory, per-file original-to-published hashes, content review, and normalization.
- [manifest.json](manifest.json) hashes every other published artifact. Its own SHA-256 is the evidence digest reported after remote verification.

For a fresh reproduction, copy only the three harness scripts into a new, empty task-owned directory and run them with `--source` pointing to a clean checkout of the exact candidate with its frozen dependencies available. Run baseline first, then separately select `--proposed-copy --allow-isolated-copy-experiment` only within authorized isolated scope. The harness creates phase output directories relative to its own location and refuses to overwrite existing ones. A baseline exit of 1 is expected when its original-byte assertions reproduce the defect.

Normalized logs use `<CANDIDATE_ROOT>`, `<EVIDENCE_ROOT>`, `<EPHEMERAL_ROOT>`, and `<NODE_EXECUTABLE>` placeholders. Candidate IDs, original fixture/output byte hashes, result values, timings, exits, and replacement-character observations are preserved. Exact executed external source retains generic task workspace paths, which contain no personal information. Original source byte hashes and original-to-published mappings distinguish source evidence from normalized records.

## Authority and limitations

Official G18 Task/spec revision, writer assignment, approved permanent file scope, and canonical source GO remain absent or unverified. Candidate guidance and current explicit delegation supported task-owned preparation and isolated reproduction; no canonical writer or completion authority is inferred from that experiment.

Historical D7 R03 was not retried and its cause remains unresolved. This result establishes only the reproduced G18 behavior on the recorded exact bytes. It does not establish historical causality, final 3.0 qualification, release readiness, or native-host compatibility. Requested routing was `gpt-6.1-sol/high`, with no fallback selected; actual routing was not exposed by the execution API. No provider/model call occurred.

All inputs are synthetic. No mutation, native effect, canonical metadata/DB change, auth change, merge, tag, release, or Library upload occurred. This publication adds evidence artifacts only. Credentials, private handover information, native/private messages, local personal paths, operating databases/WALs, and auth files are excluded.
