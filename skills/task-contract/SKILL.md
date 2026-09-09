---
name: task-contract
description: 사용자 요청과 적용 지침을 목표·범위·수용 기준·작업 단위·위험도·권한·검증 근거가 추적되는 TaskEnvelope.v1으로 정리한다. 구현, 실행 계획 수립이나 완료 판정에는 사용하지 않는다.
license: MIT
metadata:
  version: "0.1.0"
---

# Task Contract

사용자 요청을 실행 전에 확인할 수 있는 작업 계약으로 정리한다. 계약 작성만 요청받으면 구현이나 MCP workflow를 시작하지 않는다.

## 작성 절차

1. 원 요청, 이미 결정된 사용자 선택과 하나 이상의 `instructionResolutionRefs`를 구분한다. 대상 저장소의 경로 비교 방식은 `pathSemantics`에 `windows` 또는 `posix`로 명시한다. 저장소 관례가 필요하고 이미 제공됐다면 `workspaceProfileRef`를 근거로 쓴다.
2. [field-guide.md](references/field-guide.md)에 따라 `TaskEnvelope.v1`을 작성한다. `workUnits`에는 확인된 coarse unit, dependency와 예상 write target만 넣는다. 실행 가능한 task graph나 담당자는 정하지 않는다.
3. [acceptance-criteria.md](references/acceptance-criteria.md)에 따라 모든 수용 기준에 `AC-001` 형식의 ID를 붙이고 `AcceptanceEvidencePlan.v1`과 일대일로 연결한다.
4. [risk-and-authorization-rubric.md](references/risk-and-authorization-rubric.md)에 따라 위험과 권한을 분리한다. 각 action에는 요청 입력의 `authorizationEvidence`와 정확히 일치하는 `authorizationProvenance`를 하나만 연결한다. 프로젝트 지침은 행동을 제한할 수 있지만 `allowedActions`를 늘리는 권한 근거로 쓰지 않는다.
5. 목표, 범위, 위험도와 권한의 출처를 `provenance`에 기록한다. 권한 action의 authority·effect·source는 `authorizationProvenance`에도 별도로 보존한다. 확인되지 않은 가정은 `assumptions`, 결론을 바꾸는 질문은 `ambiguities`, 양립할 수 없는 입력은 `contradictions`에 둔다.
6. 요청과 보고서를 `{ schemaVersion, request, report }`로 감싸 `node scripts/validate-task-contract.mjs`에 전달한다.

스크립트는 자연어 요청을 추출하거나 위험을 추측하지 않는다. JSON Schema, dependency graph, 운영체제별 경로 충돌, action별 권한 근거, 모순과 수용 기준–증거 대응을 검사한다.

## 판정과 실패 처리

- 계약이 유효하고 blocking ambiguity와 contradiction이 없으면 `PASS`다.
- 사용자 답이 있어야 계약을 확정할 수 있으면 `NEEDS_INPUT`이다.
- 필수 지침이나 원 요청에 접근할 수 없거나 입력 자체를 검증할 수 없으면 `BLOCKED`다.

기존 계약의 목표, 범위, dependency 또는 write target이 달라지면 기존 envelope를 고치지 말고 새 계약과 digest를 만든다. 다른 전문 스킬을 직접 호출하지 않으며, Agent Governance Suite 연결 정보는 `integration/skill-descriptor.json`에만 둔다.
