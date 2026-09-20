---
name: orchestrator
description: 요청을 받아 어떤 거버넌스 스킬이 필요한지 분류해야 할 때 쓴다. 실패 영향이 큰 요청에서 필요한 단계와 생략할 단계를 정할 때, 거버넌스 스킬을 둘 이상 이어 써야 할 때(계약 정리→관례 조사→구현→범위·근거 확인→감사), 어느 스킬을 먼저 써야 할지 애매할 때, 여러 산출물을 하나의 완료 판정으로 묶을 때가 해당한다. 요청을 분류하고 전문 스킬의 실행 순서·입출력·결과를 연결하며, 실패 영향이 큰 여러 단계 요청은 MCP orchestrated workflow로 순서와 감사 게이트를 강제한다. MCP가 BINDING_REQUIRED나 BINDING_INVALID를 반환하면 전문 스킬을 직접 순서대로 호출한다. 전문 판단이나 감사 자체는 각 스킬이 맡는다.
license: MIT
metadata:
  version: "1.2.0"
---

# Governance Orchestrator

전문 스킬의 책임을 바꾸지 않고 요청을 적절한 실행 흐름으로 연결한다. 이 스킬은 분류, 선택, 순서 결정, 입출력 전달, 중간 결과 확인과 최종 결과 통합만 맡는다. 보안 판단, 독립 감사, 반박 작성, 구현, 배포를 대신 수행하지 않는다.

## Claude Code에서의 선택 결정

이 문서를 읽는 것은 실행이 아니다. 첫 파일 편집이나 명령 실행 전에 다음 결정을 한 단락으로 적고, 그 결정대로 각 시점에 실제로 실행한다.

- 이 요청이 잘못 수행됐을 때의 실패 영향과 그 근거.
- 필요한 단계와 생략하는 단계를 각각 이유와 함께. 후보는 다음과 같고, 조건에 맞는 것만 고른다.
  - `task-contract`: 요청이 여러 해석을 허용하거나 범위·완료 조건·권한이 불명확할 때.
  - `change-scope-guardian`: 기존 변경이 있는 트리에서 작업하거나 커밋할 때(첫 변경 전 baseline, 커밋 전 범위 확인).
  - `acceptance-evidence-validator`: 수용 기준이 명시됐거나 완료를 보고해야 할 때.
  - `independent-audit-gate`: 실패 영향이 큰 변경(CI·CD, 릴리스·배포, 권한·신뢰 경계, 전역 설정, 데이터·스키마)을 커밋·병합·릴리스로 확정하기 전. 구현자와 분리된 fresh 서브에이전트(`agent-governance-suite:independent-auditor`)가 최종 diff를 본다.
  - `mutation-risk-preflight`: 삭제·배포·push·태그처럼 되돌리기 어려운 명령 직전.
  - `ponytail`(`minimal-implementation`): 코드를 작성·수정하는 구현 단계. 필요 없는 기능·추상화·의존성을 만들지 않는 가장 단순한 구현을 고르고, 의도적으로 뺀 것을 남긴다.
- 실행 방식과 그 이유. 둘 중 하나를 고른다.
  - `orchestrated`: 실패 영향이 크고 고른 단계가 둘 이상이며 `plan_workflow` MCP 도구를 쓸 수 있을 때. 아래 "MCP 도구 사용 계약" 순서로 계획, 수렴 root, attempt claim, guarded start, stage별 기록, finalize를 진행한다. 각 stage의 전문 스킬은 Skill 도구로 실제 호출하고 그 결과를 `record_stage_result`로 기록한다. MCP 원장이 단계 순서와 감사 게이트를 강제하므로, 지침만으로 순서를 지키는 것보다 이 방식을 우선한다.
  - `direct`: 그 밖의 경우, 또는 MCP 도구를 쓸 수 없거나 `BINDING_REQUIRED`·`BINDING_INVALID`로 계획이나 stage 기록이 거절됐을 때. 결정한 스킬을 그 순서대로 직접 호출한다. `orchestrated`에서 전환했다면 반환 코드와 전환 이유를 사용자에게 한 줄로 밝히고, 이미 시작한 run은 `abort_workflow`로 닫는다.
- `orchestrated`로 계획할 작업 계약(`TaskEnvelope.v1`)은 `plan_workflow` 전에 확정한다. `orchestration`에는 `{ "requested": true, "mcpAvailable": true }`를 적는다. 서버는 `requested` 값으로 실행 방식을 정하므로 `false`를 적으면 direct 계획이 돌아온다. `scope`와 `workUnits[].writeTargets`에는 저장소 기준 파일 경로나 glob만 적는다. 브랜치·태그·원격 같은 git 대상은 `authorization.allowedActions`와 `mutation-risk-preflight`의 대상으로 다룬다(`change-scope-guardian`은 경로가 아닌 규칙을 `INVALID_INPUT`으로 거절한다). 시작한 run의 계약을 바꿔 다시 시도하면 수렴 가드가 frame 검토(`FRAME_REVIEW_REQUIRED`)와 사용자 승인을 요구한다.
- 단순 조회·저위험 수정이라 전문 스킬이 필요 없으면 그렇게 적고 진행한다.

### Claude Code의 실행 보증

- `plan_workflow`와 `record_stage_result`를 호출할 때마다 플러그인 훅이 그 호출을 낸 세션(서브에이전트가 호출했으면 그 서브에이전트)의 모델과 추론 수준을 transcript에서 관측해 서버에 넘긴다. 도구 인자에 `executionContext`나 `_hostAttestation`을 넣지 않는다. 넣어도 훅이 지우거나 덮어쓴다.
- semantic stage의 관측값은 그 stage를 기록한 호출자의 것이다. 서브에이전트에 맡긴 stage를 메인 세션이 기록하면 메인 세션의 모델과 추론 수준이 결속되므로, 그 서브에이전트가 계획된 하한(`executionRequirement`) 이상의 모델과 추론 수준으로 실행됐는지 확인한 뒤 기록한다.
- 관측값이 하한보다 낮아 `BINDING_INVALID`가 나오면 값을 고쳐 다시 보내지 않는다. 더 높은 모델·추론 수준의 세션에서 다시 실행하거나 `direct`로 전환한다. 대화형 세션에서 도구 승인에 5분 넘게 걸려 `BINDING_INVALID`가 나오면 같은 호출을 다시 한다.

### 큰 stage 출력

- provider 출력(`output.output`)이 저장소 크기에 비례해 커지면(예: `change-scope-guardian` baseline, 변경 범위 보고서, 저장소 관례 조사) 도구 인자에 넣지 않는다. 스킬이 만든 JSON을 바꾸지 않고 로컬 파일에 저장한 뒤, `record_stage_result`에 `outputFile: { "locator": "<절대 경로>", "digest": "sha256:<그 파일 바이트의 SHA-256>" }`를 넣고 `output.output`은 `null`로 보낸다. 서버가 파일을 읽어 digest와 출력 schema, 게이트를 인라인 출력과 똑같이 검사하고 receipt에는 참조만 남긴다.
- 크기를 맞추려고 항목을 줄이거나 요약하지 않는다. digest가 맞지 않으면 `INTEGRITY_FAILED`다.
- receipt 정책이 있는 stage(한국어 산문, 평가 타당성)는 `outputFile`을 받지 않으므로 인라인으로 기록한다. 이 stage들의 출력은 참조 전용이라 크지 않다.

### stage 기록

- `record_stage_result` 전에 계획된 stage의 `requiredArtifacts`에 있는 id를 모두 `output.artifacts`에 넣는다. 각 항목에는 실제 산출물의 locator, digest, targetDigest를 적고 `verified: true`로 표시한다. digest는 64자리 소문자 hex이며 `sha256:` 접두사는 있어도 없어도 된다.
- 실제로 만들지 않았거나 확인하지 않은 산출물은 `verified: true`로 적지 않는다. 그 stage는 `passed`로 기록하지 않고, provider 결과(verdict나 `MISSING_EVIDENCE` adapter error)가 가리키는 `needs-input`이나 `blocked` 상태로 기록한다.

## 시작 전 확인

먼저 요청의 목표, 상태 변경 여부, 완료 조건과 명시적으로 호출된 스킬을 확인한다. `/agent-governance-suite:<skill-name>` 호출이나 스킬 이름으로 명시적으로 지정한 요청에서는 그 스킬을 우선하며, 다른 스킬로 대체하지 않는다.

라우팅 전에 설치 시 노출된 스킬 설명으로 후보 capability를 정하고 `node scripts/query-registry.mjs --capability <capability>`를 실행해 일치하는 활성 provider만 조회한다. 여러 capability는 `--capability`를 반복한다. 후보를 특정할 수 없을 때만 `--all`로 compact 전체 목록을 조회하며, `skills/registry.json` 원문 전체를 모델 컨텍스트로 읽지 않는다. 조회 결과의 `selectionCriteria`, precondition, priority를 선택 설명에 남긴다. 같은 capability의 후보 중 priority가 가장 큰 항목을 선택하되, 동률이나 descriptor 충돌은 임의로 고르지 말고 `needs-input`으로 돌린다. `selectionCriteria`는 사람이 검토하는 근거이며 런타임 필터가 아니다. 필요한 역할이 없으면 `missingCapabilities`, 가능한 직접 스킬 호출 경로와 부족한 capability를 분리해 설명한다.

초기 정책 capability는 `subagent-coordination`, `independent-deliberation`, `independent-audit`다. 일반 변경 흐름에 필요한 모델·추론 수준 적합성, 지침 범위, 작업 계약, 저장소 관례, 변경 기준선·범위 확인, mutation 사전 점검, 수용 근거 확인과 실패 진단도 capability로 찾는다. 현재 provider 이름을 라우팅 조건으로 사용하지 않는다.

한국어 산문을 작성·편집하거나 자연스러움을 검증하는 요청은 일부 단계만 선택하지 않는다. `korean-prose-selection`, `korean-prose-editing`, `korean-prose-verification`, `korean-prose-finalization` 네 capability를 모두 요청하고, descriptor의 artifact 의존성과 `phaseOrder`에 따라 순서대로 실행한다. 원문은 전문 스킬 내부에서만 다루고 MCP 영수증에는 reference-only policy가 허용하는 digest, artifact reference와 고정 토큰만 전달한다.

## 실행 class와 단계 구성

`orchestrated` workflow를 실제 실행하거나 실패 뒤 다시 실행할 때는 먼저 [수렴 가드 계약](references/convergence-guard.md)을 읽고 같은 `rootId`를 유지한다. 단순 조회나 전문 스킬 단독 호출에는 수렴 root를 만들지 않는다.

`executionClass`별로 흐름을 분리한다.

- `bootstrap`: `plan_workflow` 전에 실행한다. `phaseOrder` 순으로 지침 범위를 확인하고, 신뢰할 수 있는 현재 선택값이 있을 때 모델·추론 수준 적합성을 평가하며, 필요할 때 저장소 관례를 조사한 뒤 유효한 `TaskEnvelope.v1`과 수용 근거 계획을 만든다. 이미 같은 대상과 지침 revision에 대해 검증된 산출물이 있으면 중복 실행하지 않는다.
- `workflow`: 동결된 `TaskEnvelope.v1`에서 필요한 capability만 선택한다. `phaseOrder`와 artifact 의존성을 함께 지키며, 첫 변경 전 기준선, 위험한 상태 변경 직전 precondition gate, 구현 후 범위·수용 근거 확인, 마지막 완료 gate 순서를 유지한다.
- `recovery`: 기존 run의 실패 기록을 바꾸지 않고 별도 workflow로 실행한다. 반복 실패가 없으면 미리 넣지 않으며, recovery provider와 일반 workflow provider를 한 run에 섞지 않는다. `blocker-diagnostician`이 `CAUSE_CONFIRMED`를 반환한 뒤에만 별도의 recovery run에서 `recovery-strategy-selector`를 실행한다. 검증된 `RecoveryHandoff.v1`은 새 작업 계약의 입력일 뿐 권한이나 실행 승인이 아니며, 새 `TaskEnvelope.v1` 결속 검사 전에는 후속 workflow를 시작하지 않는다.

첫 수정 실패, adapter·운영체제·패키징 관측의 모순, 실제 호스트와 테스트의 불일치, evidence 충돌 중 하나가 생기면 일반 재시도 대신 `blocker-diagnosis` capability를 먼저 선택한다. 확정 원인은 증상→메커니즘→근본 조건과 판별·제거 관측을 보존한 경우에만 recovery 입력이 된다.

여러 provider가 같은 스킬에 있어도 각 provider의 capability, phase, 입력·출력 artifact를 독립 단계로 취급한다. 스킬 디렉터리명이나 배열 위치로 순서를 추측하지 않는다.

에이전트 간 이견이나 통합 대상 변경으로 기준선을 재배치할 때는 [협업 상세 계약](references/collaboration.md#전체-최적화와-기준선-재배치)을 먼저 읽는다.

## 초기 라우팅

첫 라우팅에서 `CollaborationDecision.v1`을 `schemaVersion: "1.2.0"`으로 만든다. 기존 `1.0.0`과 `1.1.0` 기록은 당시 의미로 검증하며 새 결정은 현재 입력으로 만든다. 결정에는 출처 주장인 `sourceOriginKind`, 관측 가능한 경우의 `sourceReceiptId`, 항상 `none`인 `authorityEffect`, `userDirective`(`require | forbid | unspecified`), 다섯 위임 조건과 독립 감사 분리 필요 여부를 기록한다. 출처 판단과 검증에는 [입력 출처 규칙](references/input-origin.md)을 적용한다. 결정적 validator가 `direct | delegate | audit-only | needs-input`을 도출하되 결정 artifact와 TLS 메시지는 권한을 만들지 않는다.

구조·라우팅만 검사할 때는 결정 JSON을 stdin으로 [검증 CLI](scripts/validate-collaboration-decision.mjs)에 전달한다. 영수증 관측까지 확인하려면 읽기 전용 `validate_collaboration_decision` 도구를 사용한다. CLI의 `structural-only` 결과를 영수증 검증이나 사용자 승인 증명으로 해석하지 않는다.

다음 순서로 분류한다.

1. 사용자가 특정 전문 스킬을 명시했으면 해당 스킬의 적용 조건을 확인하고 그 스킬을 호출한다.
2. 그 밖의 전문 기능은 요청의 목표와 수용 기준에서 capability를 추출하고 레지스트리 descriptor로 찾는다. 선택한 capability, provider, phase와 선택 이유를 계획에 남긴다.
   `evaluation-validity-audit`를 선택할 때는 공유 `TaskEnvelope.v1`을 변경하지 않는다. `plan_workflow`에 `{ schemaVersion, taskEnvelope, evaluationAuditPurpose }` 구조를 넘기고, 실행 전 설계 감사면 `evaluationAuditPurpose`를 `design-readiness`로, 평가 결과를 품질·릴리스 근거로 제출하는 감사면 `quality-or-release`로 고정한다. 후자는 `post-execution PASS`와 `qualifiesAsQualityOrReleaseEvidence: true`가 모두 확인되지 않으면 완료하지 않는다.
3. 호스트 runtime metadata, 사용자 텍스트나 이번 요청의 화면 캡처에서 현재 task의 모델과 추론 수준을 모두 관측한 경우 `model-effort-fit-assessment`를 요청한다. 현재 선택이 없으면 일반 direct 작업에서는 이 capability 때문에 묻거나 작업을 멈추지 않으며, 결과가 `ADEQUATE`이면 사용자 안내를 생략한다. 단, MCP `orchestrated` workflow를 계획할 때는 별도 규칙을 적용한다. caller는 `plan_workflow` 인자에 `executionContext`를 넣지 않는다. 현재 bootstrap 실행에 대한 model class·추론 수준과 task 결속은 호스트가 서버 측 `TrustedExecutionContextProvider`를 통해 authoritative observation으로 제공해야 한다. provider가 없거나 관측값이 최소 semantic assurance 하한보다 낮아 MCP가 `BINDING_REQUIRED` 또는 `BINDING_INVALID`를 반환하면 값을 임의로 보정·추정하지 않고 해당 workflow를 시작하지 않는다.
4. `CollaborationDecision.v1.route`가 `delegate`인 경우에만 `subagent-coordination`을 `TaskEnvelope.v1.requiredCapabilities`에 명시한다. `auditSeparationRequired`는 route와 독립된 의무다. `delegate`와 함께 참이면 구현 위임과 별도 감사자를 모두 계획한다. `audit-only`는 구현 위임 없이 감사 의무만 남은 경우다. 감사자는 구현에 참여하지 않고 최종 후보가 준비된 뒤 감사하며, 사용자 금지나 실행 불가가 있으면 감사 완료로 처리하지 않는다. 작업 단위가 둘 이상이거나 `orchestration.requested: true`라는 사실만으로 추가하지 않는다.
5. 실제로 양립할 수 없는 대안이나 충돌하는 근거 중 하나를 선택해야 하고, 독립 관점과 교차 반박이 그 선택에 필요한 경우에만 `independent-deliberation`을 `TaskEnvelope.v1.requiredCapabilities`에 명시한다. `decision.complexity: complex`만으로 추가하지 않으며, 이 단계는 구현이나 완료 게이트를 대체하지 않는다.
6. 정확한 최종 대상이 있는 고위험 변경의 실행·병합·릴리스·완료 가능 여부를 판정하는 요청에는 `independent-audit`을 추가한다. 감사 전의 구현·수정·자체 검증은 이 provider의 역할이 아니다.
7. 코드를 작성·수정하는 구현 단계가 있는 요청에는 `minimal-implementation`을 `TaskEnvelope.v1.requiredCapabilities`에 명시한다. 이 단계는 변경 전 기준선 뒤, 위험한 상태 변경의 사전 점검과 범위·수용 근거 확인 전에 실행된다. 구현 단계에서는 Git이 추적하는 파일의 편집·삭제, 새 파일 생성, 확인용 테스트·빌드 실행만 한다. 추적되지 않는 기존 파일이나 저장소 밖 대상의 삭제·덮어쓰기, 마이그레이션·데이터 변경의 실제 실행, 배포·push·태그처럼 사전 점검 대상인 작업은 사전 점검 뒤에 실행하고, MCP 계획에 그 stage가 없으면 실행하지 않고 최종 결과에 남은 작업으로 적는다. provider는 필요 없는 기능·추상화·의존성을 만들지 않는 가장 단순한 구현을 고르고, 의도적으로 뺀 것을 결과에 남긴다. MCP 없이 직접 진행할 때도 구현 단계에서 이 capability의 provider를 호출한다. 동결된 `TaskEnvelope.v1`의 범위와 수용 기준은 명시적 요청으로 보고 줄이지 않으며, 줄일 후보는 최종 결과에 제안으로만 남긴다. 검사용 테스트를 포함한 새 파일은 `scope.included`·`workUnits[].writeTargets` 안에서 저장소의 기존 테스트 관례와 위치를 따라 만든다. 작업 계약이 없으면 사용자 요청이 정한 범위를 같은 기준으로 삼는다.
8. 하나의 전문 스킬로 충분한 요청은 오케스트레이터 단계를 생략하고 그 스킬을 직접 사용할 수 있다고 안내한다.

통합 워크플로에서는 bootstrap을 마친 뒤 작업 단위 조정, 독립 숙고, 변경 전 기준선, 최소 구현, 위험한 상태 변경 직전의 사전 점검, 요청된 전문 작업, 범위·수용 근거 확인, 최종 고위험 감사 순으로 연결한다. 구체적인 순서는 provider의 `phaseOrder`와 artifact 의존성으로 정하며 MCP stage 순서와 같아야 한다. 각 전문 스킬이 이미 내부적으로 worker를 조정하는 경우에는 같은 단위를 다시 배정하지 않는다.

위임 여부를 결정하기 전에 [협업 상세 계약의 위임 판단](references/collaboration.md#위임-판단)을 읽고 자동·명시적 위임의 조건과 예외를 적용한다.

## 실행 순서와 입출력 연결

- 각 단계마다 담당 스킬, 입력 출처, 기대 산출물, 다음 단계와 중단 조건을 기록한다.
- provider가 선언한 `inputBindings`의 `select`, `collect`, `combine`, `require-external`만 사용한다. 누락된 입력을 새로 만들거나 다른 artifact로 조용히 대체하지 않는다.
- 전문 스킬 결과는 선언된 `ProviderResult.v1` envelope로 연결한다. `outputSchema`, `resultSchema`, `stateMapping`을 통과하지 못한 결과를 다음 단계의 입력으로 사용하지 않는다.
- MCP 계획 stage에 `executionRequirement`가 있으면 그 stage를 요구 하한을 충족하는 실행자 설정으로 수행하되, caller는 `StageResult.v1`이나 `record_stage_result` 인자에 `executionContext`를 넣지 않는다. 실제 실행자의 model class·추론 수준과 정확한 run·stage·revision 결속은 호스트가 서버 측 `TrustedExecutionContextProvider`를 통해 관측한다. 현재 세션 값, 다른 worker 값이나 모델 이름에서 추측한 class를 caller 입력으로 대신하지 않는다. semantic stage의 관측값이 없거나 하한 미달이면 MCP의 `BINDING_REQUIRED` 또는 `BINDING_INVALID`를 그대로 처리하고 `passed`로 진행하지 않는다. `korean-prose-finalization`처럼 계획이 `deterministic`으로 표시한 stage에는 이 관측값을 요구하지 않는다.
- 한 스킬의 결과를 다음 스킬에 전달할 때는 확인한 사실, 대상 식별자, 원시 증거 위치, 열린 제한사항을 보존한다. 요약으로 원시 결과나 불확실성을 대체하지 않는다.
- 하위 실행에는 전체 대화를 기본 상속하지 않는다. 목표, 성공 조건, 책임 범위, 원자료 위치, 확정된 결정, 검증과 반환 형식만 담은 제한된 brief를 사용한다. 전체 대화가 없으면 정확성을 유지할 수 없는 경우에만 예외 사유를 기록하고 상속한다.
- 큰 로그와 전문 결과는 artifact 참조와 digest로 전달하고, 상위 컨텍스트에는 결론, 근거 위치와 미해결 사항만 유지한다.
- 이전 단계의 필수 입력이 없거나 결과가 실패·차단 상태이면 그 의존 단계는 실행하지 않는다. 이미 확인된 결과와 누락된 입력을 구분해 보고한다.
- 독립 감사가 필요한 흐름에서는 구현자와 감사자를 분리하고, 감사 후 의미 있는 변경이 생기면 감사 대상과 판정을 다시 연결한다.
- 같은 명령, 입력·candidate digest, 실패 원인과 판별 가설이 모두 그대로라면 다시 실행하지 않는다. 다른 원인 가설을 가르는 검사가 없으면 해당 단계만 중단하고 실패 근거와 필요한 새 입력을 보고한다.

`independent-deliberation` 또는 `independent-audit` provider를 호출하기 전에 [전문 단계 handoff 계약](references/specialist-handoffs.md)에서 해당 절을 읽고 입력, 결과 투영과 진행 조건을 적용한다.

## MCP 도구 사용 계약

MCP로 계획·실행·결과 기록을 하기 전에 [MCP 실행 계약](references/mcp-execution.md)을 읽는다. 연결과 도구 스키마를 확인한 뒤 계약의 호출 순서, revision, compact 응답과 실패 처리를 따른다.

MCP를 사용할 수 없어도 설치된 전문 스킬로 독립 처리 가능한 부분은 진행한다. 필요한 통합 실행 자체가 불가능할 때만 통합 결과를 `BLOCKED`로 보고하며, 직접 실행 결과를 guarded 완료 근거로 표현하지 않는다.

## 결과 통합

보안 전문 분석을 요청했거나 수용 기준에서 요구하면 `software-security-audit`를 선택한다. 보안 관련 파일의 존재만으로 추가하지 않는다. phase 65의 `security-audit-request`에는 실제 파일 내용을 고정한 대상과 허용 범위를 전달한다. 보고서는 로컬 CLI로 대상·근거를 검증하고 원자료를 확인한 뒤 기록한다. 이 provider의 `passed`는 조사 산출물 생성 성공이며 안전 판정이 아니다. `partial`의 미검사 항목과 limitations를 생략하지 않는다.

수용 근거 검증도 선택됐다면 `security-audit-report` artifact의 locator·digest·targetDigest와 원시 근거를 기존 `workflow:verification-evidence`에 추가하고 해당 보안 수용 기준에 연결한다. 기준 불충족과 검사 공백은 기존 수용 검증·독립 감사 게이트에서 판단한다. 취약점 심각도만으로 전역 차단 정책을 새로 만들지 않는다. 감사 후 대상 변경이 있으면 영향받은 분석과 근거 결속을 다시 확인한다.

최종 응답에는 선택한 스킬과 실행 순서, 각 단계의 확인된 결과, 열린 제한사항, 다음에 필요한 입력만 포함한다. 전문 스킬의 판정을 덮어쓰지 않는다. 고위험 변경의 완료 가능 여부는 독립 감사 게이트가 `PASS`로 판정한 경우에만 그렇게 표현한다.
