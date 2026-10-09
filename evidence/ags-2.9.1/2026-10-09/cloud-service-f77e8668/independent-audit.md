# Independent audit: isolated service source candidate

Gate: **PASS for the exact isolated local source candidate only**. No integration, deployment or release approval is asserted. This publication summarizes an already completed independent audit; publication did not rerun tests.

## Target and independence

- Base/sole parent: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`; base tree: `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`.
- Candidate: `f77e8668ff32246c5a6bb02659472c5610a60792`; candidate tree: `150e699ccb04f93e50188fca4ac4cd3c4d2819c0`.
- Scope: service.ts plus three new service usage/binding/qualification regression tests; 4 files, 336 insertions, 5 deletions. No forbidden product/harness/generated paths changed.
- A separately spawned worker with fresh context performed the audit and had no implementation or implementation-validation participation. The auditor inspected source, tests, committed diff, profile/request/response-validation boundaries and runner configuration. Implementer conclusions were not accepted as evidence.
- Local worker metadata and unsigned receipts support this separation; they are not signed host attestation.

## Observed checks and causal witnesses

| Family | Fixed-base RED | Candidate GREEN | Observed failure repaired |
| --- | --- | --- | --- |
| Usage | 5 PASS / 8 FAIL | 13 PASS | malformed RESP or invalid tokens/diagnostics erased an independently valid reported cost; a reported 0.7 overrun left spent at 0 |
| Binding | 3 PASS / 11 FAIL | 14 PASS | same-revision config/profile content changes reused stale success; qualification deadline reused cached success |
| Qualification | 5 PASS / 10 FAIL | 15 PASS | expiry during availability still allowed reserve/classify; completed success remained reusable after expiry |

The auditor compared RED/GREEN argv arrays and frozen test bytes within each family, checked archived exact-base/candidate service bytes, and inspected raw assertion failures. Binding RED afterDigest was reconstructed from a coordinated source hold/archive rather than separately observed immediately after the run; that historical observation is weaker. Final candidate behavior was independently rerun.

Independent candidate rerun: **10 files, 203/203 PASS**, no pending/skipped tests, runner exit 0, remainingChildren false. TypeScript `--noEmit`, targeted ESLint and exact diff check returned 0. The 203 count includes the same 42 new regressions and 161 existing related tests; it does not count repeated executions as additional coverage. Reproduction argv and per-file counts are in `test-summary.json`. Original raw report digests are in `provenance.json`; raw logs and local paths are deliberately not published.

Direct inspection established these local boundaries:

- Finite nonnegative independently reported cost survives token/diagnostic/RESP errors. Invalid or absent costs stay unknown; started/unknown calls with unknown cost retain maximum reservation.
- The race has one settlement location. Late timeout/cancellation completion cannot settle or publish twice. Mock duplication tests verify one provider call and one charge per identical operation.
- Canonical cache identity binds frozen request/snapshot/vendor/config and registry content, including model, options, cost ceiling and qualification. Same-operation content conflict prevents resend; key ordering does not cause a conflict; caller mutation does not alter the frozen flight.
- Successful advice is qualification-checked when published/reused. After availability resolves, qualification is checked before synchronous reservation/provider invocation. At the exact deadline it is expired. JEV fallback remains the one fixed current-vendor route.
- JEV remains supporting classification, with final selection owned by AGENT. JEV OFF and global external egress OFF remain separate policy boundaries; no dynamic premium/model selection was added.

No open blocking defect was found within this exact local source scope. Patch bytes were checked against the candidate Git diff; source/test digests were unchanged before/after audit. The public patch differs only in author header normalization to a public identity already used in repository history. Its code diff is byte-identical to the original audited patch.

## Explicit limits / NOT_RUN

- Actual model/API/Claude, real billing, semantic qualification, host E2E, full repository 1257-test suite, R14 and global claim/new-run-directory redesign: NOT_RUN.
- Committed runtime/Claude generated bundles were unchanged and not rebuilt. Integration must regenerate and check freshness/build/runtime clean-room behavior separately.
- No cross-process, durable or global budget claim is proven. Unknown dispatched costs can consume conservative in-memory reservations and prevent later calls; late billing reconciliation is outside scope.
- Monetary correctness trusts independently valid provider-reported synthetic numbers. No invoice, actual remaining balance or real model cost was observed.
- Qualification is guarded at service reservation/provider invocation. Provider-internal asynchronous credentials/wire work can cross expiry; strict wire-time enforcement needs provider-owner review.
- Hidden route/credential changes under unchanged references and service restart/global operation identity are not modeled. Bounded claims remain for the service-instance lifetime.
- This audit does not cryptographically attest historical execution, original shared-checkout history, or later integrated/deployed artifacts. Any behavior/test/oracle/dependency/generated-artifact change requires impact review.
