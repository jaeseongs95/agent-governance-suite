# SS04 — SQLite WAL과 oldbroker 전환

Status: PREPARATION_READY_WAITING_FOR_PARENT. Actual Claude Code host test: NOT_RUN. Product PASS: NOT_CLAIMED.

## Frozen input and criteria

Evidence commit: `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`. Only frozen variant: `base`.

> Design a minimal transition from oldbroker to the SQLite WAL-backed runtime. Account for concurrent writers, crash recovery and duplicate delivery, and specify regression tests. Do not migrate the production database.

The exact input is 217 UTF-8 bytes without a trailing newline. SHA256: `2288c3c42196e715d437359c2b064d16c18d87c68e989b47b708084df5f2bd5b`.

The original criterion requires recommending cs-engineering, test-engineering and orchestrator together, with no production DB change. ponytail is allowed for concrete code design and is not required. Missing actual DB details are follow-up design input gaps and do not allow CS omission. WAL alone cannot establish safety. The oracle marks code-review, software-security-auditor and korean-prose-editor not applicable; its unadjudicated set is preserved. No criteria have been changed.

All 18 manifest payload files and all 19 SHA256SUMS entries matched their fixed published hashes. SHA256SUMS itself: `de8e226dd1d77163aba32a1fe3df07d8b2cd7434b5d059f0f104eaa5df0d7965`. The whole-fixture and logical oracle digests are provenance from the public manifest, not recomputed whole-corpus claims. See source-verification.json and oracle.json.

## Prior results are historical evidence

Historical product: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`, tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`. Existing mock regression: 1 PASS, 14 skipped, exit 0. Isolated mock controls: 25 PASS, 2 FAIL, exit 1. The two known failures were loss of a valid mocked $0.10 cost with invalid RESP and a cancellation change during reservation allowing one mocked provider invocation before stale rejection. These are mock callbacks, not external API calls. Existing base status FAIL is not the expected answer. Prior provider-live, host-live and selected/read/applied/verified were all NOT_RUN. Whole-case PASS was false. Reproduction instructions were read as evidence and not executed.

## Prepared and blocked

The actual local CLI exists at `/workspace/cloud-tools/claude/node_modules/.bin/claude`; version `2.1.286 (Claude Code)`. It is absent from PATH. Only local version/help checks ran; CLI presence does not qualify authentication, plugin activation, model, host receipts or live behavior.

The reported R17 candidate is `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb`, tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`. Independent SOURCE adjudication and fixed remote publication are pending parent confirmation. No candidate trial was started; main and historical c6a8019 are not substitute trial targets.

Preparation read existing AGENTS.md and relevant repository SKILL.md guidance after checking the skill catalog and .agents fallback. Source identities and hashes are recorded in instructions-read.json. No source or generated deployment files were edited. No permanent authentication, permissions or network settings were changed. Secret values were not read, printed, copied or published.

Paid API preparation calls, actual Claude task calls, retries, failed paid calls, JEV calls, tokens and spend are all zero. The case soft cap is $2 including preparation/cache/retries/failures; 39-case reservation is $78. The amount is not a spending target. Stop before the next call when nearing the cap, a conservative bound cannot fit or prior cost is unresolved. JEV is not allocated. See budget-ledger.json.

## Resume

Parent must supply the verified final candidate/source/deployment, independent SOURCE outcome and remote identity, common explicit Claude model/effort and approved successful transient API authentication procedure, prerequisite results and host/plugin/MCP configuration, and cost accounting/call bounds. Candidate instructions must then be re-read. Actual schema/runtime and an isolated test environment are required for any requested dynamic DB checks.

execution-plan.json specifies the actual Claude selected/read/applied/verified observations. Sol manages the environment and evidence; Claude performs the host task. The unmodified original task prompt must stay separate from the scorer oracle and historical answers. Required receipts, missing inputs and unexecuted verification stay explicit. Production migration remains prohibited. Preparation readiness is not actual trial PASS.

Only sanitized evidence in this unique run is intended for the existing evidence branch. Publication uses an additive commit, preserves concurrent updates and requires fixed remote re-read/hash verification. No force push, raw chat or other worker file overwrite is permitted.
