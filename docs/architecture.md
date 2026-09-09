# 아키텍처

이 저장소는 하나의 설치 가능한 플러그인 안에서 여러 전문 스킬을 배포합니다. 소스가 한 저장소에 있어도 전문 스킬의 실행 책임은 분리합니다.

```text
plugin manifest
├── skills/orchestrator/       분류·순서·입출력·결과 통합
├── skills/<specialist>/       전문 판단과 해당 결과 형식
├── contracts/                 여러 스킬이 공유하는 명시적 계약
└── mcp-server/                통합에 필요한 도구 경계
```

오케스트레이터는 스킬 이름을 하드코딩하지 않고 `skills/registry.json`의 capability와 phase를 조회합니다. 초기 통합 흐름은 독립 작업 단위의 배정에 `coordinate-subagents`, 충돌하는 근거의 판단에 `independent-deliberation-panel`, 최종 고위험 변경의 완료 판정에 `independent-audit-gate`를 차례로 사용합니다. 이 순서는 MCP 실행 계층의 stage 순서와 같습니다. 한 전문 스킬의 결과가 다음 단계에 필요하면 대상 식별자, 원시 증거 위치, 제한사항을 함께 전달합니다. 실패한 선행 단계에 의존하는 후속 단계는 실행하지 않습니다.

같은 capability를 여러 descriptor가 제공하면 v1은 숫자가 큰 priority를 우선합니다. `selectionCriteria`는 사람이 검토할 선택 조건과 이유이며 MCP가 자연어를 해석하지는 않습니다. 조건별 자동 분기가 필요하면 서로 다른 구체적 capability로 등록합니다. 같은 capability에 priority가 겹치거나 선택 조건이 비어 있으면 저장소 검증이 실패합니다.

공개 계약은 `TaskEnvelope.v1`, `SkillDescriptor.v1`, `WorkflowPlan.v1`, `StageResult.v1`, `WorkflowReceipt.v1`, `ApiResult.v1`로 나뉩니다. `plan_workflow`가 레지스트리를 읽어 HMAC으로 서명한 계획을 반환하고, `start_workflow`가 같은 MCP 프로세스에서 서명을 확인한 뒤 계획을 동결합니다. 이후 `record_stage_result`는 revision, 실행 순서, 필수 산출물 ID와 감사 게이트 선언을 검사합니다. `finalize_workflow`는 모든 필수 단계가 통과하고 미해결 항목이 없을 때만 최종 영수증을 만듭니다.

MCP 서버는 플러그인 루트의 `.mcp.json`에 등록됩니다. MCP 응답은 외부 상태를 관측하는 근거일 수 있지만, 호출 수락만으로 성공을 뜻하지 않습니다. MCP가 없을 때도 단독 전문 스킬로 처리할 수 있는 요청은 계속할 수 있습니다.

run과 revision은 프로세스 메모리에만 저장합니다. 서버를 다시 시작하면 이전 run은 복구하지 않으며 `RUN_NOT_FOUND`를 반환합니다. 저장되는 증거는 경로·식별자·검증 여부·요약뿐이고 원문 코드와 전체 로그는 저장하지 않습니다.

고위험 변경의 완료 판정은 오케스트레이터가 내리지 않습니다. 최종 대상과 증거를 확인한 독립 감사 스킬의 결과를 그대로 통합합니다.

MCP는 적대적인 호출자를 인증하는 보안 경계가 아닙니다. `verified`, locator, auditor ID는 전문 스킬이 직접 확인한 뒤 제출하는 신뢰 입력이며, MCP는 그 선언의 구조와 단계 불변조건을 검사합니다. 실제 신원 인증이나 원자료 무결성이 필요한 배포에서는 인증된 외부 신원·증거 서비스를 추가해야 합니다.
