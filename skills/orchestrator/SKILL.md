---
name: orchestrator
description: 여러 거버넌스 스킬이 함께 필요한 요청을 분류하고, 사용 가능한 전문 스킬의 실행 순서·입출력·결과를 연결한다. 전문 판단이나 감사 자체를 수행할 때는 사용하지 않는다.
license: MIT
metadata:
  version: "1.0.0"
---

# Governance Orchestrator

전문 스킬의 책임을 바꾸지 않고 요청을 적절한 실행 흐름으로 연결한다. 이 스킬은 분류, 선택, 순서 결정, 입출력 전달, 중간 결과 확인과 최종 결과 통합만 맡는다. 보안 판단, 독립 감사, 반박 작성, 구현, 배포를 대신 수행하지 않는다.

## 시작 전 확인

먼저 요청의 목표, 상태 변경 여부, 완료 조건과 명시적으로 호출된 스킬을 확인한다. 명시적으로 `$skill-name`을 지정한 요청에서는 그 스킬을 우선하며, 다른 스킬로 대체하지 않는다.

라우팅 전에 `skills/registry.json`을 읽고 `enabled: true`인 `SkillDescriptor.v2` provider와 실제 스킬 경로를 대조한다. 요청에서 필요한 capability와 실행 class를 먼저 정하고, 일치하는 provider의 `selectionCriteria`, precondition, priority를 선택 설명에 남긴다. 같은 capability의 후보 중 priority가 가장 큰 항목을 선택하되, 동률이나 descriptor 충돌은 임의로 고르지 말고 `needs-input`으로 돌린다. `selectionCriteria`는 사람이 검토하는 근거이며 런타임 필터가 아니다. 필요한 역할이 없으면 가능한 직접 스킬 호출 경로와 부족한 capability를 분리해 설명한다.

초기 정책 capability는 `subagent-coordination`, `independent-deliberation`, `independent-audit`다. 일반 변경 흐름에 필요한 지침 범위, 작업 계약, 저장소 관례, 변경 기준선·범위 확인, mutation 사전 점검, 수용 근거 확인과 실패 진단도 capability로 찾는다. 현재 provider 이름을 라우팅 조건으로 사용하지 않는다.

## 실행 class와 단계 구성

`executionClass`별로 흐름을 분리한다.

- `bootstrap`: `plan_workflow` 전에 실행한다. `phaseOrder` 순으로 지침 범위를 확인하고, 필요할 때 저장소 관례를 조사한 뒤, 유효한 `TaskEnvelope.v1`과 수용 근거 계획을 만든다. 이미 같은 대상과 지침 revision에 대해 검증된 산출물이 있으면 중복 실행하지 않는다.
- `workflow`: 동결된 `TaskEnvelope.v1`에서 필요한 capability만 선택한다. `phaseOrder`와 artifact 의존성을 함께 지키며, 첫 변경 전 기준선, 위험한 상태 변경 직전 precondition gate, 구현 후 범위·수용 근거 확인, 마지막 완료 gate 순서를 유지한다.
- `recovery`: 기존 run의 실패 기록을 바꾸지 않고 별도 workflow로 실행한다. 반복 실패가 없으면 미리 넣지 않으며, recovery provider와 일반 workflow provider를 한 run에 섞지 않는다.

여러 provider가 같은 스킬에 있어도 각 provider의 capability, phase, 입력·출력 artifact를 독립 단계로 취급한다. 스킬 디렉터리명이나 배열 위치로 순서를 추측하지 않는다.

## 초기 라우팅

다음 순서로 분류한다.

1. 사용자가 특정 전문 스킬을 명시했으면 해당 스킬의 적용 조건을 확인하고 그 스킬을 호출한다.
2. 그 밖의 전문 기능은 요청의 목표와 수용 기준에서 capability를 추출하고 레지스트리 descriptor로 찾는다. 선택한 capability, provider, phase와 선택 이유를 계획에 남긴다.
3. 사용자가 하위 에이전트·병렬 작업을 요청했거나, 서로 독립적으로 실행할 수 있는 작업 단위가 둘 이상인 구현·분석 요청에는 `subagent-coordination`을 추가한다. 고위험 변경의 구현 흐름에서도 이 provider가 작업 소유권과 독립 감사 배정을 조정한다.
4. 설계·정책·요구사항·장애 원인처럼 충돌하는 근거를 독립 관점과 교차 반박으로 판단해야 하는 요청에는 `independent-deliberation`을 추가한다. 이 단계는 방안을 고르기 위한 것이며, 구현이나 완료 게이트를 대체하지 않는다.
5. 정확한 최종 대상이 있는 고위험 변경의 실행·병합·릴리스·완료 가능 여부를 판정하는 요청에는 `independent-audit`을 추가한다. 감사 전의 구현·수정·자체 검증은 이 provider의 역할이 아니다.
6. 하나의 전문 스킬로 충분한 요청은 오케스트레이터 단계를 생략하고 그 스킬을 직접 사용할 수 있다고 안내한다.

통합 워크플로에서는 bootstrap을 마친 뒤 작업 단위 조정, 독립 숙고, 요청된 전문 작업, 범위·수용 근거 확인, 최종 고위험 감사 순으로 연결한다. 구체적인 순서는 provider의 `phaseOrder`와 artifact 의존성으로 정하며 MCP stage 순서와 같아야 한다. 각 전문 스킬이 이미 내부적으로 worker를 조정하는 경우에는 같은 단위를 다시 배정하지 않는다.

## 실행 순서와 입출력 연결

- 각 단계마다 담당 스킬, 입력 출처, 기대 산출물, 다음 단계와 중단 조건을 기록한다.
- provider가 선언한 `inputBindings`의 `select`, `collect`, `combine`, `require-external`만 사용한다. 누락된 입력을 새로 만들거나 다른 artifact로 조용히 대체하지 않는다.
- 전문 스킬 결과는 선언된 `ProviderResult.v1` envelope로 연결한다. `outputSchema`, `resultSchema`, `stateMapping`을 통과하지 못한 결과를 다음 단계의 입력으로 사용하지 않는다.
- 한 스킬의 결과를 다음 스킬에 전달할 때는 확인한 사실, 대상 식별자, 원시 증거 위치, 열린 제한사항을 보존한다. 요약으로 원시 결과나 불확실성을 대체하지 않는다.
- 이전 단계의 필수 입력이 없거나 결과가 실패·차단 상태이면 그 의존 단계는 실행하지 않는다. 이미 확인된 결과와 누락된 입력을 구분해 보고한다.
- 독립 감사가 필요한 흐름에서는 구현자와 감사자를 분리하고, 감사 후 의미 있는 변경이 생기면 감사 대상과 판정을 다시 연결한다.

### 독립 숙고 handoff

통합 워크플로에서 `independent-deliberation` provider를 호출할 때는 원래 요청과 원자료를 보존하고 `include_decision_record: true`를 지정한다. HIGH·CRITICAL 또는 독립 판단이 승인 조건인 요청에는 `execution_assurance: strict`를 사용한다. 그 밖의 제어는 provider가 선언한 허용값과 기본값을 따른다.

반환된 `DecisionRecord.v1`은 provider 패키지의 canonical schema와 validator로 확인한다. 검증 실패, `run.assurance: provisional`, `run.capability_shortfall: true`, `consensus_proposal: null`은 다음 자동 단계를 승인하지 않는다. `conditional_consensus`는 record에 적힌 조건을 외부 workflow가 확인한 뒤에만 진행하고, `no_consensus`는 미해결 선택지와 `decision_owner`에게 반환한다. schema-valid record만으로 주장 진위, 실제 worker 격리나 final audit 완료를 추정하지 않는다.

MCP에 기록할 때는 전체 record를 `StageResult.v1.output.decisionRecord`에 넣고, `conditional_consensus`의 외부 조건을 실제로 확인한 경우에만 `output.conditionsVerified: true`를 함께 기록한다. `decision-record` 증거 항목은 canonical record의 실제 위치를 가리켜야 한다.

### 독립 감사 handoff

`independent-audit` provider에는 현재 단계, 구현자 ID, fresh auditor ID, 최종 대상 식별자, 변경 범위, 원시 검증 위치, rollback 근거와 알려진 제한을 전달한다. 감사 결과의 일곱 섹션을 보존하고 다음처럼 `StageResult.v1.output`에 투영한다.

- `gateVerdict`: `Gate`의 `PASS | FAIL | BLOCKED`
- `auditorId`: `Independence`에서 확인한 fresh auditor ID
- `implementationActorIds`: `Independence`에서 확인한 구현자 ID 목록
- `auditTarget`: `Audit Target`의 현재 최종 대상 식별자
- `currentTarget`: 결과 기록 시점에 오케스트레이터가 확인한 최종 대상 식별자. `auditTarget`과 같아야 한다.
- `phase`: `pre-execution | post-execution | pre-deploy | post-deploy`
- `freshContext`, `delegationAllowed`, `blockingFindings`, `stale`, `postExecutionVerified`: 감사 결과에서 직접 확인한 값

현재 최종 대상과 `auditTarget`이 다르거나, fresh context가 아니거나, 재위임이 허용됐거나, 열린 blocking finding이 있거나, 판정이 stale하면 `passed`로 기록하지 않는다. 실제 상태 변경 뒤에는 `post-execution` 또는 `post-deploy` 확인이 끝난 경우에만 완료할 수 있다. MCP의 구조적 필드 검사는 감사 사실이나 신원을 인증하지 않으므로 오케스트레이터가 원자료를 직접 대조한다.

## MCP 도구 사용 계약

MCP를 사용할 때는 연결이 성공했고 도구 목록과 입력 스키마를 실제로 읽을 수 있는 경우에만 호출한다. 도구 이름, 입력 필드, 권한 범위, 대상 식별자를 추측하지 않는다.

통합 실행은 다음 순서를 지킨다.

1. 목표, 범위, 수용 기준, 작업 단위, 위험도와 필요한 capability를 `TaskEnvelope.v1`로 정리하고 `plan_workflow`를 호출한다. 이 호출은 run을 만들지 않는다.
2. 계획이 `ready`이고 `executionMode`가 `orchestrated`일 때만 계획 전체를 `start_workflow`에 전달한다.
3. 계획에 기록된 순서대로 전문 스킬을 사용한다. provider 결과와 산출물 참조를 `ProviderResult.v1`로 묶고, 이를 `StageResult.v1.output`에 넣어 현재 revision과 함께 `record_stage_result`에 전달한다.
4. 사용자 입력이나 승인이 필요하면 해당 상태와 차단 사유를 그대로 보고하고 새 실행이 필요한지 판단한다. 순서를 건너뛰거나 이미 기록한 stage를 덮어쓰지 않는다.
5. 필요할 때 `get_workflow_status`로 현재 revision과 다음 stage를 확인한다. 모든 필수 stage와 감사 게이트가 `passed`인 경우에만 `finalize_workflow`를 호출한다.
6. 통합 실행을 더 진행하지 않기로 확정하면 `abort_workflow`로 해당 run을 닫는다.

MCP workflow run과 계획 서명 키는 SQLite에 저장되므로 프로세스를 다시 시작해도 이어서 처리할 수 있다. `RUN_NOT_FOUND`를 받으면 다른 데이터베이스 경로를 사용 중인지 먼저 확인하고, 저장된 상태가 실제로 없을 때만 새 계획과 run을 만든다. 이전 revision이나 stage 결과를 추측해 복구하지 않는다.

- 선택한 MCP 도구가 필요한 작업만 수행하는지와 사용자가 부여한 권한 안인지 확인한다.
- 필요한 최소 입력만 전달하고, 비밀값·개인정보·확인되지 않은 사실을 도구 입력에 새로 넣지 않는다.
- 도구 응답의 구조화된 결과, 오류, 외부 상태 식별자와 관측 시각을 다음 단계에 전달한다. 도구 호출이 수락됐다는 사실만으로 작업 성공을 선언하지 않는다.
- 도구가 실패하거나 결과를 관측할 수 없으면 실패 원인과 영향을 받은 단계만 멈춘다. 다른 전문 스킬이 독립적으로 완료할 수 있는 부분은 계속할 수 있다.

MCP 연결이나 필요한 MCP 도구를 사용할 수 없더라도, 설치된 전문 스킬을 직접 호출해 처리할 수 있는 요청은 진행한다. MCP 없이는 필요한 통합 작업 자체를 수행할 수 없는 경우에만 통합 결과를 `BLOCKED`로 표시하고, 직접 사용할 수 있는 스킬과 필요한 MCP 기능을 함께 밝힌다.

## 결과 통합

최종 응답에는 선택한 스킬과 실행 순서, 각 단계의 확인된 결과, 열린 제한사항, 다음에 필요한 입력만 포함한다. 전문 스킬의 판정을 덮어쓰지 않는다. 고위험 변경의 완료 가능 여부는 독립 감사 게이트가 `PASS`로 판정한 경우에만 그렇게 표현한다.
