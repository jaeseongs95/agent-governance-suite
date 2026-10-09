# Independent provider publication evidence review

## Audit Target

- Stage: pre-publication static evidence review of a source-only candidate. This is not a merge, install, deployment, or public release gate.
- Candidate: `b5a04ff82f9863383de00d75de5841af5223041b`; tree `f82f927c49ba368e17843abc8548ef9cea60107c`.
- Base: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`; tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`.
- Scope: `mcp-server/src/skill-classification/providers.ts` and `tests/mcp/skill-classification-providers.test.ts`. The exact commit diff has 216 insertions and 10 deletions across those two files only.
- Risk: the provider governs approved remote dispatch, possible external content transmission, and potentially chargeable calls. Static publication of the isolated source patch is reversible by omitting the patch. Broader operational completion requires separate validation and gating.
- Latest authorization permits publishing the prepared evidence at the unique evidence path. This review distinguishes that documentation action from applying the patch or completing integration; the integration FAIL does not prohibit accurately publishing the failures and limitations.

## Independence

- Implementer: coordinating implementation worker.
- Auditor: separate publication-review worker; no implementation, fixes, or implementation test execution performed by this auditor.
- `fresh_context=true`: the auditor began from a new audit briefing without inherited implementation conversation history.
- Delegation: none; no subagents created.
- Applicable instructions read directly: repository `AGENTS.md`, `skills/independent-audit-gate/SKILL.md`, `references/entry-details.md`, and `references/audit-protocol.md`.

## Evidence Checked

Evidence root: `/workspace/ags-provider-fix-evidence`. Timeout evidence root: `/workspace/ags-timeout-fix-evidence`.

1. Read the exact base-to-candidate Git diff and both changed files, plus request projection, profile validation, shared types, service, gateway, and relevant existing test source. Current candidate HEAD/tree match the target; candidate checkout is clean. The red checkout HEAD/tree match the base and its only working-tree modification is the final provider test file used for the red run.
2. Preserved raw diff: [candidate.diff](/workspace/ags-provider-fix-evidence/candidate.diff). Its SHA-256 is `b1c150a06a499b1791e2744fadc8a999236e5eb7dcd9ce7ad27f41357d52466d`, identical to the freshly read pinned Git diff. No format-patch author header is reproduced in this review.
3. Independently compared every `source-manifest.json` entry against actual candidate and base-checkout bytes. All recorded hashes match. Gateway, service, inventory, types, evaluation files, live-bootstrap files, test runner, and subreaper are byte-identical to the base. Git's complete changed-file inventory independently confirms the two-file scope.
4. Directly parsed [red-receipt.json](/workspace/ags-provider-fix-evidence/red-receipt.json) and [green-receipt.json](/workspace/ags-provider-fix-evidence/green-receipt.json), inspected their raw assertion output, and checked stdout/stderr hashes, receipt seals, snapshot seals, and unchanged before/after snapshots. All checks match. Red and green use the same argv, final test digest `605eada6cbcaf074a877496671a227abbfc389a7c55faf915350b342feb73468`, and Vitest config digest. The sole production delta is the provider: base SHA-256 `f191c46db32f38248ebdd23be725b426a0b3020e0bb464b36bcc57521983651c`, candidate SHA-256 `b8136ca3451aa2b2f2b2e8d2ffccd2b38d71e0edbaf1b6a22f702f345181846d`.
5. Final raw counts: red **63 total, 26 pass, 37 fail**, exit 1; green **63 total, 63 pass, 0 fail**, exit 0. Red failures are actual behavioral assertions: 14 Retry-After observation cases, 16 stale binding/expiry/encoding cases, and 7 ambiguous answer-key cases. The added cancellation case and two acceptance/metadata compatibility cases already pass on the base. Earlier 60-case JSON reports are historical runs, not final-candidate proof.
6. [regression-results.json](/workspace/ags-provider-fix-evidence/regression-results.json) has 100 passing assertions across five test-file results: profiles 24, request 5, runtime 5, service 40, validation 26. Its `numTotalTestSuites=11` counts nested suites and must not be described as 11 test files. Existing assertions cover OFF no-call behavior, fixed profiles, at-most-once fallback, service deduplication, cancellation, and stale-result rejection. This is not a whole-repository or full gateway integration run.
7. All entries in the evidence `hashes.json` match actual file bytes. The local engineering result says `CONSISTENT` and explicitly disclaims independent audit/host attestation; it was treated only as supporting consistency evidence. Empty lint/typecheck logs have no independently captured command or exit code, so they do not establish those checks passed.
8. Read [integration-gap.json](/workspace/ags-provider-fix-evidence/integration-gap.json), its recorded fixture source and log, and traced the observed behavior to unchanged service/types. Read the separate timeout fixture and raw `red-results.json`: **20 total, 18 pass, 2 fail**, with failures for `2147483648` and `Number.MAX_SAFE_INTEGER`. These pass the loader's timeout schema and reach a deliberately missing profile read instead of receiving the expected timeout-field validation error.
9. Read the prepared bundle's `README.ko.md`, `PROVENANCE.json`, and `PACKAGING-CHECK.json` under `/workspace/ags-provider-publication/evidence/ags-2.9.1/2026-10-09/cloud-provider-b5a04ff8`. Its metadata pins the same source target, distinguishes historical runs from packaging, excludes the format-patch author header, and discloses timeout and both integration gaps. Final bundle manifests, privacy checks, archive hashes, and publication receipts remain the publisher's responsibility; this review does not attest a final remote bundle.

## Findings

- **P1 — non_blocking, resolved for narrow scope:** Provider-local dispatch fences cover route identity/configuration, original and cloned request/profile binding, qualification validity/expiry, adapter and credential function identity, and cancellation. Checks run after the credential await and immediately before the single fetch, including after synchronous encoding. Native invocation receives bound snapshots and an immediate local check. Recorded no-fetch assertions demonstrate the relevant local mutation boundaries. These checks cannot observe independent external task/config/runtime changes.
- **P2 — non_blocking, resolved for narrow scope:** HTTP 429/529 retains only structured safe delay seconds or canonical date observations on `ClassificationProviderError`. Arbitrary raw headers and error bodies are suppressed; redirects remain disabled and there is one fetch invocation without a retry layer. Existing malformed, over-limit, invalid UTF-8, partial-stream, and response-ID/model/score checks remain intact. The bounded raw JEV check rejects duplicate answer containers, skill keys including escaped equivalents, and duplicate `type`/`noul` fields; unrelated metadata retains existing JSON.parse behavior.
- **P3 — non_blocking, resolved for narrow scope:** The patch preserves centralized profile/model selection and common request/response contracts. RAW original prompt, negations, confirmed context, and semantic skill metadata still pass through deterministic projection; local source references are omitted without prompt truncation or a preprocessing LLM. Provider judgments remain advice; the unchanged gateway requires a separate observed AGENT selection. Static gateway source was reviewed, but no gateway test pass is claimed from this evidence set.
- **I1 — blocking for broader integration, open:** External snapshot closure is unwired. `SkillClassificationProviderPort.classify` accepts only request/profile/signal; service checks `getCurrentSnapshot` before entering the provider and after completion. A snapshot change during the provider's second credential lookup can therefore precede a fetch without aborting the signal. The recorded `snapshotChange=true` case has `fetchCalls=1` and a final `STALE_CLASSIFICATION` response. Rejecting the final result does not undo transmission or potential charge. Evidence: unchanged types/service and `integration-gap.json`.
- **I2 — blocking for broader integration, open:** Sanitized rate-limit observations are lost at the service boundary. Its catch reconstructs `ClassificationProviderError` without the new observation and `ClassificationAttempt` has no corresponding field. Both recorded integration cases retain the provider observation but have `serviceAttemptHasObservation=false`. Forwarding is documented only in [interface-proposal.md](/workspace/ags-provider-fix-evidence/interface-proposal.md).
- **I3 — blocking for broader integration, open:** The actual configuration loader in unchanged `gateway.ts` uses `z.number().int().positive()` without the timer upper bound; service also lacks that upper bound. Two recorded loader assertions fail as described above. The separate timeout record is test-only and explicitly states `productFixApplied=false`; an unapplied proposed patch is not a fix. Evidence: gateway source, timeout test source, timeout `red-results.json`, and `source-and-commit.json`.
- **R1 — blocking for release readiness, not_observable:** No candidate bundle generation/freshness verification, required full repository checks, installed runtime verification, remote release state, or post-deployment observations were supplied. Those are outside this static review and cannot be inferred from the provider passes.

## Remediation/Re-audit

- No implementation change is required by this review for the narrow provider-only source patch.
- Broader integration requires the responsible writers to connect a synchronous current-snapshot check immediately before actual remote/native dispatch, preserve sanitized observation metadata through the service attempt contract, and enforce the timeout range at the actual loader and relevant service boundary.
- Add recorded fixtures for external snapshot changes during credential lookup, service observation forwarding, and timeout boundary rejection. New source/contracts/tests/results must be pinned and freshly re-audited; the present narrow PASS cannot be carried over to a changed candidate automatically.
- Rollback for this source-only stage: omit the patch and retain the pinned base. This auditor made no source changes, release/install calls, remote writes, or test executions. The report is the sole written deliverable.

## Gate

- **Narrow provider candidate: PASS**, limited to static source-only publication evidence for the exact commit and two-file scope above. The final raw evidence is internally consistent with the target, the tests have meaningful causal failures on the base, and no open blocker was found inside that narrow scope.
- **Broader integration: FAIL**, because I1–I3 are confirmed open requirement gaps. Ownership restrictions explain why those changes were not applied; they do not establish completed behavior.
- **Merge/deploy/release readiness: BLOCKED**, because the required broader verification and actual publication/install observations were not provided. The narrow PASS supplies no release authorization.

## Limitations

- Static-only review; no tests rerun and no new reproductions written or executed. Receipts and checks are local, unsigned implementation evidence; hash consistency is not independent execution attestation.
- Mock transports/native callbacks support the recorded tests. The fixtures have no paid network calls or preprocessing model calls, but this review does not attest live credentials, live provider availability, pricing, billing, or external-network behavior.
- No full R13/R14 suite or installation-level integration was verified. The remaining unknown-cost reservations in the integration evidence are conservative accounting, not proof of zero charges or refunds.
- Findings apply to the exact pinned commit and evidence reviewed. Later semantic changes require re-audit.
