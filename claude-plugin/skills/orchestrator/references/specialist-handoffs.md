# 전문 단계 handoff 계약

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
