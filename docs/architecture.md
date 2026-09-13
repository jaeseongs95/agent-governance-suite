# 아키텍처

이 저장소는 하나의 설치 가능한 플러그인 안에서 여러 전문 스킬을 배포합니다. 소스가 한 저장소에 있어도 전문 스킬의 실행 책임은 분리합니다.

```text
plugin manifest
├── skills/orchestrator/       분류·순서·입출력·결과 통합
├── skills/<specialist>/       전문 판단과 해당 결과 형식
├── contracts/                 여러 스킬이 공유하는 명시적 계약
└── mcp-server/                통합에 필요한 도구 경계
```

오케스트레이터는 스킬 이름을 하드코딩하지 않고 `skills/registry.json`의 provider capability와 실행 메타데이터를 조회합니다. provider는 `bootstrap`, `workflow`, `recovery`로 나뉩니다. 지침 범위, 저장소 관례와 작업 계약을 만드는 bootstrap provider는 `plan_workflow` 전에 직접 실행합니다. 일반 workflow provider는 artifact 의존성을 먼저 만족시키고 `phaseOrder`를 안정적인 보조 정렬 기준으로 사용합니다. blocker 진단 같은 recovery provider는 일반 workflow와 섞지 않고 별도 실행으로 계획합니다.

같은 capability를 여러 provider가 제공하면 숫자가 큰 priority를 우선합니다. `selectionCriteria`는 사람이 검토할 선택 조건과 이유이며 MCP가 자연어를 해석하지는 않습니다. 조건별 자동 분기가 필요하면 서로 다른 구체적 capability로 등록합니다. 같은 capability에 priority가 겹치거나 선택 조건이 비어 있으면 저장소 검증이 실패합니다.

공개 계약은 `TaskEnvelope.v1`, `SkillDescriptor.v2`, `ProviderResult.v1`, `WorkflowPlan.v1`, `StageResult.v1`, `WorkflowReceipt.v1`, `ApiResult.v1`로 나뉩니다. `SkillDescriptor.v2`는 한 스킬의 여러 provider, 입출력 artifact, 결과 schema, 상태 매핑과 gate를 선언합니다. `plan_workflow`가 레지스트리를 읽어 schema checksum이 포함된 계획을 HMAC으로 서명하고, `start_workflow`가 같은 MCP 프로세스에서 서명을 확인한 뒤 계획을 동결합니다.

`record_stage_result`는 revision과 실행 순서를 확인한 뒤 provider envelope와 내부 output을 각각 선언된 schema로 검증합니다. 계획에 생산자가 있는 입력 artifact는 해당 선행 단계가 검증된 artifact를 남긴 경우에만 소비할 수 있습니다. bootstrap·task 입력처럼 계획 밖에서 들어오는 artifact의 내용과 출처 확인은 실행한 전문 스킬이 책임지고, MCP는 제출된 locator·digest·`verified` 선언의 구조를 확인합니다. descriptor의 선택적 `receiptPolicy`는 계획 stage로 복사되어 HMAC에 결속됩니다. `reference-only` mode는 닫힌 output schema와 opaque reference만 허용하고, 선언된 actor pointer에는 canonical UUID와 run 단위 고유성을 적용합니다. `finalize_workflow`는 모든 필수 단계가 통과하고 미해결 항목이 없으며 각 stage의 receipt policy가 다시 확인된 경우에만 최종 영수증을 만듭니다.

MCP 서버는 플러그인 루트의 `.mcp.json`에 등록됩니다. MCP 응답은 외부 상태를 관측하는 근거일 수 있지만, 호출 수락만으로 성공을 뜻하지 않습니다. MCP가 없을 때도 단독 전문 스킬로 처리할 수 있는 요청은 계속할 수 있습니다.

run, revision, run ID sequence와 계획 서명 키는 SQLite에 저장합니다. 서버를 다시 시작해도 이전 run을 복구하고, 같은 데이터베이스를 공유하는 서버 인스턴스는 optimistic revision 검증으로 충돌을 거부합니다. 저장 단위는 전체 `WorkflowReceipt`의 평문 JSON입니다. 따라서 `StageResult`의 provider output, evidence note, findings, blockers와 error에 원문 코드, 로그, 비밀값이나 개인정보가 들어 있으면 그 내용도 DB에 남습니다. MCP 서버는 필드 내용을 걸러 내거나 자동으로 만료·삭제하지 않으므로 호출자는 민감한 원문을 제출하지 않고 DB 경로의 접근 권한과 보존 기간을 관리해야 합니다.

## 플러그인 업데이트 알림

MCP 서버는 고정된 공개 저장소에서 `vMAJOR.MINOR.PATCH` 형식의 안정 tag만 확인합니다. 성공한 결과는 같은 SQLite DB의 `plugin_update_state`에 24시간 동안 보관하고, 실패하면 마지막 성공 결과를 유지한 채 1시간 뒤 다시 시도합니다. 업데이트 확인 오류는 workflow 상태나 도구 결과를 바꾸지 않습니다.

설치된 버전보다 높은 tag가 있고 아직 안내하지 않은 버전이면 기존 MCP 도구 결과 뒤에 `plugin-update-notice` content block을 붙입니다. 같은 버전의 안내는 DB 전체에서 한 번만 claim합니다. `check_for_updates`에 `force: true`를 전달하면 TTL을 무시하고 다시 확인할 수 있습니다. 서버는 설치 파일이나 마켓플레이스 설정을 수정하지 않으며 `automaticInstall`은 항상 `false`입니다.

고위험 변경의 완료 판정은 오케스트레이터가 내리지 않습니다. 최종 대상과 증거를 확인한 독립 감사 스킬의 결과를 그대로 통합합니다. `mutation-risk-preflight`의 통과는 실행 승인이나 감사 통과를 대신하지 않습니다.

MCP는 적대적인 호출자를 인증하는 보안 경계가 아닙니다. `verified`, locator, auditor ID는 전문 스킬이 직접 확인한 뒤 제출하는 신뢰 입력이며, MCP는 그 선언의 구조와 단계 불변조건을 검사합니다. 실제 신원 인증이나 원자료 무결성이 필요한 배포에서는 인증된 외부 신원·증거 서비스를 추가해야 합니다.
