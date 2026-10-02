This evidence supplement appends to the original AGS F06/F07 result without changing earlier evidence. Canonical millisecond-Z A2 compatibility currently passes in the isolated fixtures. The microsecond/offset signing example is historical VM evidence; no current A2 producer failure or admission bypass is established. The earlier failing proposed parity test remains **diagnostic**, not a normative release gate.

Required AGS surface pin is `0e88cb6039e143e79dd8c68c7aecc3e45da41d43`; integration review candidate is `a7c049d5de392651b102840cb7e75243e1afe317`. A2 dispatch, shared receipt-parser and VM dispatch source files are byte-identical across these pins. The strict freshness-helper text is also identical. [Exact source hashes](source-evidence.json) bind these findings to both commits.

| Terminal form | Emission/signing evidence available here | A2 reserve | A2 pure receipt | VM reserve/pure reader |
|---|---|---|---|---|
| Millisecond `Z`, e.g. `.000Z` | Signed AGS A2 synthetic fixtures; unsigned VM bodyGolden examples | Accept | Accept | Accept |
| Six digits plus offset, e.g. `.000500+00:00` | Stored signed historical VM fixture, declared producer 2deb96e; not current A2 evidence | Reject | Accept | Accept |
| Six digits plus `Z`, e.g. `.000500Z` | Synthetic probe only; no current producer emission established | Reject | Accept | Accept |

Cells describe new synthetic envelopes with consistent profile/domain/key/input bindings and fixed clocks, not actual admission. The historical VM envelope was decoded only for static timestamp inspection, never replayed. Its signed body contains terminal `2026-09-23T00:00:05.000500+00:00`, issued/invocation `2026-09-23T00:00:05.000Z`, expiry `2026-09-23T00:01:05.000Z`; body SHA-256 is `f3bc3ac988d09547255f75729287b3284932a58f56536a640606c173a535ed89`.

Exact public source references:

- At the required pin, [A2 reserve](https://github.com/jaeseongs95/agent-governance-suite/blob/0e88cb6039e143e79dd8c68c7aecc3e45da41d43/mcp-server/src/host-integration/flowmarshal-current-invocation.ts#L148) uses an exact millisecond ISO round-trip parser at line 25; [A2 receipt](https://github.com/jaeseongs95/agent-governance-suite/blob/0e88cb6039e143e79dd8c68c7aecc3e45da41d43/mcp-server/src/host-integration/observation-challenge.ts#L417) uses terminalMicros at line 74, accepting one-to-six fractional digits and Z/numeric offset.
- [VM reserve](https://github.com/jaeseongs95/agent-governance-suite/blob/0e88cb6039e143e79dd8c68c7aecc3e45da41d43/mcp-server/src/host-integration/vm-current-invocation.ts#L89) uses Date.parse for terminal observedAt; [VM receipt validation](https://github.com/jaeseongs95/agent-governance-suite/blob/0e88cb6039e143e79dd8c68c7aecc3e45da41d43/mcp-server/src/host-integration/observation-challenge.ts#L218) uses terminalMicros and accounts for issuedAt serialization down to milliseconds.
- [Strict freshness at the required pin](https://github.com/jaeseongs95/agent-governance-suite/blob/0e88cb6039e143e79dd8c68c7aecc3e45da41d43/mcp-server/src/workflow-service.ts#L1410) and [at the integration candidate](https://github.com/jaeseongs95/agent-governance-suite/blob/a7c049d5de392651b102840cb7e75243e1afe317/mcp-server/src/workflow-service.ts#L1414) have identical helper text. They compare verification time with observedAt and enforce expiry and validity-window bounds.
- [Stored historical VM fixture](https://github.com/jaeseongs95/agent-governance-suite/blob/a7c049d5de392651b102840cb7e75243e1afe317/tests/coordinate-subagents/v3x/fixtures/V03-vm-producer-receipt.json), [its generator](https://github.com/jaeseongs95/agent-governance-suite/blob/a7c049d5de392651b102840cb7e75243e1afe317/tests/coordinate-subagents/v3x/fixtures/generate-V03-vm-receipt.py), and [A2 fixture generation](https://github.com/jaeseongs95/agent-governance-suite/blob/a7c049d5de392651b102840cb7e75243e1afe317/tests/coordinate-subagents/v3x/F04.test.mjs#L73) explain the observed forms. The historical V03 tests were inspected, not replayed or rerun.

Date parsing discards submillisecond precision, but the five-minute **age predicate** has the same result for the actual whole-millisecond verification clock. If terminal time is q ms plus r microseconds (0–999) and verification is whole-millisecond N, `N-q > 300000` is equivalent to `(N-q)*1000-r > 300000000`. The nine rows below expand the already executed probe's inputs and successful assertions; they are not new executions or full admission decisions.

| Terminal remainder (µs) | Parsed age (ms) | Exact age (µs) | Exact five-minute age decision | Parsed decision |
|---|---|---|---|---|
| 0 | 299999 | 299999000 | fresh | fresh |
| 0 | 300000 | 300000000 | fresh | fresh |
| 0 | 300001 | 300001000 | stale | stale |
| 500 | 299999 | 299998500 | fresh | fresh |
| 500 | 300000 | 299999500 | fresh | fresh |
| 500 | 300001 | 300000500 | stale | stale |
| 999 | 299999 | 299998001 | fresh | fresh |
| 999 | 300000 | 299999001 | fresh | fresh |
| 999 | 300001 | 300000001 | stale | stale |

[Machine-readable comparisons and their provenance](freshness-comparisons.json) bind this expansion to the preserved probe/raw hashes. The conclusion is bounded to accepted forms, positive synthetic epoch and whole-millisecond verification time.

The existing full-helper probes preserved the 60-second receipt TTL. With terminal `.000500+00:00`, issued `00:04:00.000Z`, expiry `00:05:00.000Z`, both receipt verification and strict freshness accepted at `00:04:59.999Z` and rejected at expiry and the next tick. Separately, a canonical terminal at `00:00:00.000Z`, newly issued receipt at `00:05:00.000Z`, expiry `00:06:00.000Z`, checked at `00:05:00.001Z`, passed the pure receipt verifier but failed strict freshness for stale terminal/overlong validity window. Pure receipt verification and strict service admission are separate boundaries. No EngineService or WorkflowService admission was attempted; only the freshness helper was invoked in isolation, with synthetic Date.now restored afterward.

The exact missing current authoritative inputs remain `src/flowmarshal/engine/ags_observation_producer.py` and `tests/fixtures/engine/ags_a2_producer_golden.json`, bound to the approved producer commit, immutable profileId/freezeIdentity and golden byte/digest provenance. Historical VM signing evidence and synthetic A2 fixtures do not establish current A2 emission.

For joint-owner decision: if current A2 emits the passing canonical millisecond-Z form, no producer compatibility failure is demonstrated. If its authoritative current golden emits microseconds/offsets, a later consumer-side compatibility alternative is reuse of the existing receipt terminal grammar and compatible serialized-issue causal bound, preserving original signed bytes, canonical equality and all profile/domain/key/input/TTL/freshness/single-use guards. Neither alternative is implemented. Rewriting signed timestamps or frozen goldens conflicts with current preservation requirements; a future producer-format migration would require a separate explicit contract/version decision. No new schema or fractional precision policy is mandated.

The existing bounded probe exited 0. [Raw stdout](probe.stdout), [receipt](probe-receipt.json) and [probe source](probe.mjs) are preserved; raw stdout SHA-256 is `7269b7c854d37d89b990d1120acb1bd65efa96d0e08b66719942e7eba1300b46`. This supplement redacts only receipt execution paths, with the original receipt hash recorded. No probe or prior 14-check suite was repeated for this append. Earlier evidence files remain unchanged.

First-four HOLD/write=false, unassigned producer-three and the first-four main no-ff merge order remain unchanged. No product/canonical source write, timestamp normalization, frozen golden change, TTL weakening, private ledger, local identity, DB/WAL, native message, model/provider call or Library upload is included. Publication adds documentation/evidence only. **Hold this issue pending the current producer/golden identity; do not repeatedly probe it without new authoritative input.**
