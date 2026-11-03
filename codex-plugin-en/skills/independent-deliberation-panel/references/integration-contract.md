# Orchestration Integration Contract

이 문서는 미래 오케스트레이션 플러그인이 standalone 패널을 호출하고 결과를 읽기 위한 최소 연결 규칙만 정의한다. 플러그인, audit-gate 또는 외부 권한을 구현하지 않는다.

## 호출

오케스트레이터는 원래 사용자 요청과 필요한 원자료를 그대로 전달하고 다음 제어만 명시한다.

```yaml
deliberation:
  execution_assurance: strict | degraded_ok
  adaptive_review: bounded | off
  max_distinct_workers: 8  # 0–8 정수
  include_decision_record: true
```

HIGH·CRITICAL 또는 사용자가 독립 판단을 승인 조건으로 요구한 실행에서는 `execution_assurance: strict`를 사용한다. 런타임이 필요한 collaboration capability를 제공하지 않으면 결과를 약한 성공으로 바꾸지 않는다.

## 반환값

스킬은 사용자용 10개 섹션과 canonical [DecisionRecord.v1 schema](../contracts/decision-record.v1.schema.json)에 맞는 record를 반환한다. 오케스트레이터가 안정적으로 읽을 값은 다음과 같다.

- 스킬 이름 `$independent-deliberation-panel`
- `Executive Verdict`부터 `Method / Run Summary`까지의 사용자용 10개 섹션
- `schema_version`, `skill_version`
- `run.stage`, `run.assurance`, `run.capability_shortfall`
- `material_claims[].provenance[].verification_status`
- `issue_ledger[].status`
- `axis_decisions`
- `consensus_proposal.status`, 조건, 미해결 사유와 결정권자

오케스트레이터는 record를 사용하기 전에 다음 검증을 실행하거나 동등한 검사를 수행한다.

```powershell
$env:PYTHONUTF8='1'
python scripts/validate_decision_record.py <decision-record.json>
```

검증 실패, `run.assurance: provisional`, `run.capability_shortfall: true` 또는 `consensus_proposal: null`은 다음 자동 단계를 승인하지 않는다. `conditional_consensus`는 명시된 조건을 외부 workflow가 확인한 뒤에만 진행할 수 있다. `no_consensus`는 남은 선택지와 `decision_owner`에게 반환한다.

## 책임 경계

`DecisionRecord.v1`은 비신뢰 입력이다. schema-valid 여부가 claim의 진위, 실제 컨텍스트 격리, participant identity 또는 final audit 완료를 증명하지 않는다. 오케스트레이터는 실행 권한, 재시도, 비용·한도, worker lifecycle과 다음 단계 handoff를 별도로 관리한다. final audit가 필요하면 패널과 분리된 감사 절차와 계약을 사용한다.
