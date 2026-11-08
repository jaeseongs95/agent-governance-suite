# v1.13.0 — Semantic execution assurance

## 핵심 변경

- MCP orchestrated workflow가 bootstrap 실행 모델·model class·reasoning effort를 `bootstrapExecution`으로 계획 HMAC에 결속합니다.
- 새 workflow stage에 `ExecutionRequirement.v1`을 추가합니다.
- semantic stage가 `passed`를 제출하려면 `StageResult.executionContext`가 계획된 최소 model class와 reasoning effort를 만족해야 합니다.
- 실행 메타데이터가 없으면 `BINDING_REQUIRED`, 하한보다 낮으면 `BINDING_INVALID`로 fail-closed 처리합니다.
- `korean-prose-finalization`처럼 결정적 단계는 `deterministic`으로 표시해 불필요한 모델 하한을 요구하지 않습니다.
- 특정 제품 모델 이름 대신 `lightweight < general < deep < frontier`와 `low < medium < high < xhigh < max < ultra` 순서를 사용합니다.
- bootstrap은 일반 orchestrated 작업에서도 최소 `general/high`, complex·high·critical 작업에서는 `deep/high`를 요구합니다.
- 독립 감사, 독립 숙고, 평가 유효성 감사, blocker diagnosis, recovery selection, 한국어 selection/verification 등 높은 의미 판단 비용의 stage는 기본 `deep/high` 하한을 사용합니다.

## 호환성

공유 v1 receipt schema의 새 필드는 optional로 추가했습니다. 따라서 v1.12 이하에서 저장한 plan·stage result·receipt는 새 필드가 없어도 계속 읽을 수 있습니다. 새 v1.13 orchestrated plan은 host runtime 또는 worker spawn 결과에서 관측한 execution context가 없으면 시작되지 않습니다.

MCP는 model class 선언의 암호학적 진위를 증명하지 않습니다. 이 값은 host runtime 또는 spawn 결과에서 직접 관측한 신뢰 입력이어야 합니다. 이 릴리스의 목적은 모델 능력을 만들어 내는 것이 아니라, 실행 설정이 낮은데도 동일한 semantic assurance를 가진 것처럼 workflow가 통과하는 경로를 차단하는 것입니다.

## 검증 요구

공개 릴리스 전에 저장소 `AGENTS.md`의 전체 검증 순서, 독립 사전 감사, mutation preflight, CI, 설치 캐시·MCP 확인, 독립 사후 감사를 완료해야 합니다. 이 적용 번들은 소스 변경과 테스트를 준비하지만 독립 감사나 GitHub Release 게시를 대신하지 않습니다.

## Trusted host attestation boundary

- Public MCP `plan_workflow` and `record_stage_result` no longer accept caller-supplied `executionContext`.
- Strict semantic assurance requires a server-side `TrustedExecutionContextProvider`.
- Trusted observations are bound to task/run/stage/revision, carry a one-use observation ID and a bounded validity window, and reject stale or replayed observations.
- The packaged server intentionally fails closed with `BINDING_REQUIRED` until the host supplies an authoritative attestation adapter; it does not infer or fabricate model/reasoning metadata.
- Provider-level capability classification prevents aliases of high-assurance providers from lowering the `deep/high` floor.
- Workflow HMAC tokens now require the canonical 43-character base64url spelling.
- Trusted observation IDs are atomically claimed in workflow SQLite schema v5, so replay is rejected across process restarts and concurrent database connections.
- Legacy plans and receipts remain readable, but strict MCP claim, guarded start and semantic stage boundaries reject assurance-less legacy plans with `BINDING_REQUIRED`.

Execution profiles encapsulate the minimum observed conditions under which a semantic stage may advance; they do not guarantee identical output quality across models or sessions. Frozen evaluation inputs, rubrics, thresholds and independent judgments remain a separate evidence layer.
