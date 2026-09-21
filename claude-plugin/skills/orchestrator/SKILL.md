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

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 결과 통합

보안 전문 분석을 요청했거나 수용 기준에서 요구하면 `software-security-audit`를 선택한다. 보안 관련 파일의 존재만으로 추가하지 않는다. phase 65의 `security-audit-request`에는 실제 파일 내용을 고정한 대상과 허용 범위를 전달한다. 보고서는 로컬 CLI로 대상·근거를 검증하고 원자료를 확인한 뒤 기록한다. 이 provider의 `passed`는 조사 산출물 생성 성공이며 안전 판정이 아니다. `partial`의 미검사 항목과 limitations를 생략하지 않는다.

수용 근거 검증도 선택됐다면 `security-audit-report` artifact의 locator·digest·targetDigest와 원시 근거를 기존 `workflow:verification-evidence`에 추가하고 해당 보안 수용 기준에 연결한다. 기준 불충족과 검사 공백은 기존 수용 검증·독립 감사 게이트에서 판단한다. 취약점 심각도만으로 전역 차단 정책을 새로 만들지 않는다. 감사 후 대상 변경이 있으면 영향받은 분석과 근거 결속을 다시 확인한다.

최종 응답에는 선택한 스킬과 실행 순서, 각 단계의 확인된 결과, 열린 제한사항, 다음에 필요한 입력만 포함한다. 전문 스킬의 판정을 덮어쓰지 않는다. 고위험 변경의 완료 가능 여부는 독립 감사 게이트가 `PASS`로 판정한 경우에만 그렇게 표현한다.
