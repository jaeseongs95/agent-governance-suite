# SS27 — provider 출력의 ID와 구조 검증

Preparation complete; real Claude product/host test **NOT_RUN**. Waiting for parent-verified candidate, common Claude execution settings and prerequisite outcomes. No product code or generated deployment file was modified. No paid inference, JEV, or product test was started.

Evidence authority: `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`, `evidence/ags-2.9.1/2026-10-09/cases/SS27/`. The exact public source-case SHA256 is `a69888b0116e69c29ec9bdd953c143e0a033445a7d680bca7db79895576ab4c1`. All 37 SHA256SUMS entries and 36 manifest byte/hash entries match. All eight compact UTF-8 variant input projections were rehashed and match public provenance. See source-verification.json for complete identities and derivative-versus-original distinctions.

Original input: raw에 존재하지 않는 ID, 중복 CS, disabled SEC, host 미지원 ID, 잘못된 judgment 값, NaN score를 각각 주입한다.

Required behavior: 유효 항목을 위조하지 않고 오류 항목·사유를 보존한다.

Pass criterion: 미등록·구조 오류 항목은 유효 선택으로 채택하지 않는다. 등록된 필요 스킬의 비활성·미지원은 needed에 남기되 runnable에는 0개이며 실행을 차단한다. 중복·충돌·숫자 유효성 결과가 결정적이고 이유가 남는다.

Permitted choice: 미등록·구조 오류에는 INVALID로 baseline fallback하고 원시 오류를 보존한다. 알려진 ID의 미설치·미지원은 목적 판단을 지우지 않고 실행 가용성 경계로 처리한다. provider의 중복·추가·누락 응답은 INVALID다. 상위의 서로 다른 유효 집합에서 반복되는 ID를 결합 시 한 번만 유지하는 것과 구분한다.

Forbidden behavior: unknown ID 실행; invalid 구조를 성공으로 처리; disabled를 모델 고득점 때문에 되살림.

Hold condition: 스키마 또는 inventory membership 검증 실패.

`originalPrompt=null`, case `oracle=null`. The missing TEST-SPEC file was not reconstructed. Its embedded section digest is preserved but cannot be independently rehashed without that file. Recorded corpus oracle digest `sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055` was confirmed in the historical fixture's digest field; this is not a recomputation or semantic oracle. The historical full fixture bytes match `sha256:17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9` and its SS27 record exactly equals the public source-case.

The existing result is **FAIL** on historical candidate `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`; 18 new assertions passed, 4 failed, and 5 targeted regressions passed. Raw failure-reason loss, invalid-response cost loss, duplicate JSON answer keys and host-state supply require inspection on the verified new candidate. Existing host selected/read/applied/verified are NOTRUN with null identities/receipt. Existing failures and missing observations are neither expected success nor the new test's result. No synthetic receipt or no-skill selection was created.

Expected R17 candidate: `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb`, tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`. Delegation reports local pinning only; independent SOURCE verdict and remote publication are pending. It was not fetched, checked out, tested, or replaced by old main/c6a8019. Historical c6a8019 was fetched solely to verify original fixture and instructions. Local main was used only to read available preparation instructions/tools.

The explicit Claude path `/workspace/cloud-tools/claude/node_modules/.bin/claude` runs and reports `2.1.286 (Claude Code)`. Node is v24.19.0 and pnpm is 11.19.0. `claude` is absent from PATH; explicit-path installation is confirmed. Only local --version/--help probes ran; API authentication/connectivity and host/plugin functionality remain unverified. No secret value was read or copied; no permanent auth, permissions or network policy was changed.

Execution-plan.json preserves each original expected result and lists the actual Claude work required after resume. Frozen tests must keep their bytes and original evidence/SS27 placement in a separate test workspace. Claude must execute the host work; Sol handles environment/evidence. Mechanical injected providers remain mocks and require no real JEV calls. Live signed selection/read/apply/verify requires approved runtime/profile/inventory/host observation prerequisites and must be reported separately from mechanical checks.

Budget: **US$0 consumed, 0 tokens/cache/retries/failures, US$2 remaining soft case budget**, including preparation. The 39-case US$78 reservation is not a spending target. JEV calls are unassigned. Every future paid attempt, including failures, retries, cache and unknown timeout consumption, must be logged; stop near the limit before another call. Model, effort, route and authentication method are deliberately pending the parent’s common settings.

Publication is restricted to `evidence/ags-2.9.1/2026-10-09/claude-cases/SS27/prep-20261009T074434Z-a6a406c7/` on the existing evidence branch. This directory contains sanitized preparation reports, original public case facts, hash evidence and a zero-call ledger only. Scope/preflight receipts are local preparation controls; they do not certify product PASS, SOURCE independence, or a release.
