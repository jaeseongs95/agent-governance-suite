# Evidence and Verdict Schema

이 문서는 독립 분석 결과를 수집하거나 증거 충돌과 최종 판정을 구조화할 때 읽는다. YAML은 모델 간 전달 형식을 명확히 하기 위한 논리 스키마이며 별도 parser나 설정 파일을 뜻하지 않는다.

## Case brief

```yaml
decision: "판정해야 하는 질문"
facts:
  - statement: "직접 관찰하거나 제공받은 사실"
    provenance: "파일, 테스트, 사용자 제공 내용 또는 공식 자료"
assumptions:
  - "검증되지 않았지만 현재 분석에 사용하는 전제"
constraints:
  - "반드시 지킬 요구사항이나 권한 경계"
unknowns:
  - "아직 확인할 수 없는 정보"
success_criteria:
  - "판정이 만족해야 하는 조건"
failure_modes:
  - "놓치면 결론이 잘못되는 방식"
```

## Panel manifest

```yaml
- role_id: "contract-auditor"
  failure_function: "명시된 계약 위반 탐지"
  scope: "승인된 요구사항과 제안의 일치 여부"
  model: "실제로 사용한 모델과 추론 수준"
  status: "planned | running | completed | failed | skipped | reused"
```

계획만 하고 실행하지 않은 역할은 분석 참가자로 세지 않는다. 같은 worker를 follow-up에 사용하면 새 역할로 집계하지 않는다.

## Independent review

```yaml
position: "현재 결론"
claims:
  - id: "role-id:C1"
    kind: "fact | inference | hypothesis"
    statement: "검토 가능한 단일 주장"
    evidence_refs:
      - ref: "파일, 테스트, 문서 또는 URL"
        verification_status: "unverified | verified | refuted | not_observable"
        verification_note: "Coordinator가 실제 확인한 결과 또는 미확인 사유"
    assumptions: []
risks: []
recommended_action: "권고 조치"
confidence: "low | medium | high"
open_questions: []
```

Round 1의 `evidence_refs`는 기본적으로 `unverified`다. reviewer가 출처를 제시했다는 사실만으로 검증 상태를 올리지 않는다. Coordinator가 실제 자료를 확인한 뒤에만 상태와 note를 갱신한다. `confidence`는 reviewer의 자기 평가이므로 확률로 해석하거나 reviewer 간 평균을 내지 않는다. 큰 주장은 각각 독립적으로 검증할 수 있는 단위로 나눈다.

## Cross-examination

먼저 실행 여부와 범위를 기록한다.

```yaml
cross_examination_plan:
  decision: "run | skip"
  reason: "결론을 바꿀 정보가치를 기준으로 한 이유"
  trigger_items:
    - id: "claim, issue, assumption, counterexample, failure mode 또는 explicit request ID"
      kind: "claim | issue | assumption | counterexample | failure_mode | explicit_request"
      statement: "반박 gate를 실행시킨 내용"
      origin_reviewer: "처음 제기한 reviewer 또는 null"
  selected_items: []
  excluded_material_claims:
    - claim_id: "material하지만 반박 set에서 제외한 claim"
      reason: "검증된 사실, 중복 claim 또는 낮은 추가 정보가치"
  coverage:
    - item_id: "selected item"
      reviewer_ids: []
```

`skip`이면 `trigger_items`, `selected_items`, `coverage`를 비워 두고 gate 조건이 모두 거짓인 근거를 쓴다. `run`이면 모든 `trigger_items`가 `selected_items`에 포함돼야 한다. selected item마다 원 claim 작성자 또는 `origin_reviewer`가 아닌 reviewer가 한 명 이상 있어야 한다. 명시적 논쟁 요청도 ID가 있는 item으로 만들고 검토할 가장 강한 쟁점을 statement에 적는다.

각 reviewer의 결과는 다음과 같다.

```yaml
target_item_id: "cross_examination_plan의 selected item id"
assessment: "supported | weakened | contradicted | unresolved"
weak_evidence: []
hidden_assumptions: []
fact_inference_mix: []
counterexamples: []
missing_failure_modes: []
changed_position:
  changed: false
  previous: "기존 결론 또는 null"
  current: "수정 결론 또는 기존 결론"
  reason: "결론을 유지하거나 바꾼 근거"
```

동의 여부만 적지 않는다. `changed_position`은 변화가 없어도 기록해 반박이 실제 업데이트를 만들었는지 확인한다. 관련 item 두 개를 한 follow-up에서 검토했다면 item별 결과를 각각 기록한다.

## Issue ledger

```yaml
- issue_id: "I1"
  claim_a: "claim id 또는 statement"
  claim_b: "충돌 claim id 또는 statement"
  required_evidence: []
  available_evidence:
    - ref: "파일, 테스트, 문서 또는 URL"
      supports: "A | B | neither | both-partially"
  status: "CONFIRMED | REFUTED | PARTIALLY_SUPPORTED | UNRESOLVED | NOT_OBSERVABLE"
  rationale: "확인된 증거에 연결한 짧은 판정 이유"
```

상태 정의:

- `CONFIRMED`: 필요한 provenance가 claim을 직접 지지한다.
- `REFUTED`: 확인된 증거가 claim과 양립할 수 없다.
- `PARTIALLY_SUPPORTED`: claim의 일부 범위만 증거가 지지한다.
- `UNRESOLVED`: 필요한 증거가 없거나 현재 증거가 충돌한다.
- `NOT_OBSERVABLE`: 대상 시스템이나 자료가 판정에 필요한 값을 제공하지 않는다.

논리적 추론은 근거가 될 수 있지만 코드·계약·외부 사실의 provenance를 대신하지 않는다. `NOT_OBSERVABLE`을 추정값으로 채우지 않는다.

## Judge dossier와 axis verdict

Judge에게 raw chain-of-thought나 전체 대화 기록 대신 아래 dossier를 전달한다.

```yaml
decision:
constraints: []
success_criteria: []
panel_manifest: []
material_claims: []
cross_examinations: []
issue_ledger: []
candidate_axes: []
```

`material_claims`의 각 항목에는 claim의 종류, provenance와 `verified | unverified | refuted | not_observable` 상태가 있어야 한다. Judge는 `unverified` 항목을 확인된 사실로 사용할 수 없다.

Judge 출력:

```yaml
verdict:
  overall: "전체 판단"
consensus_proposal:
  status: "consensus | conditional_consensus | no_consensus"
  action: "함께 수용할 실행안, 조건부 대안 또는 null"
  supported_by_verified_claims: []
  satisfied_constraints: []
  axis_alignment:
    - axis: "관련 판정축"
      decision_ref: "axis decision id 또는 정확한 이름"
  conditions:
    - condition: "합의안이 성립하기 전에 충족할 조건"
      evidence_needed: []
  reconsideration_conditions:
    - alternative: "현재 채택하지 않고 보류한 대안"
      conditions: []
      evidence_needed: []
  unresolved_dissent: []
  no_consensus_reason: "status가 no_consensus일 때의 이유 또는 null"
  remaining_options: []
  decision_owner: "합의 불가 시 선택해야 할 권한자 또는 null"
axis_decisions:
  - axis: "실제 의미가 있는 판정축"
    decision: "축별 결론"
    evidence_refs: []
    confidence: "low | medium | high"
accepted_claims: []
rejected_claims: []
unresolved: []
required_actions: []
optional_optimizations: []
deferred_items: []
```

한 축의 이점으로 다른 축의 위반을 상쇄하지 않는다. Judge는 표 수가 아니라 증거 우선순위와 명시된 제약으로 판단한다.

`consensus_proposal`은 verified claim과 모든 필수 제약·판정축에 연결돼야 한다. 현재 `action`이 선행 조건 없이 수용되면 `consensus`이고 `conditions`는 비워 둔다. 현재 action 자체가 조건 충족을 기다리면 `conditional_consensus`로 두고 `conditions`에만 그 선행 조건을 쓴다. 채택하지 않은 대안을 나중에 다시 검토하기 위한 기준은 `reconsideration_conditions`로 분리하며 현재 합의 상태를 조건부로 바꾸지 않는다. 실행안의 안전성이나 요구 충족 여부를 바꿀 수 있는 `unresolved_dissent`가 남으면 `consensus`로 표시하지 않는다. 필수 제약이 양립할 수 없으면 `no_consensus`로 두고 action은 `null`, 불가 사유·남은 선택지·결정권자를 반환한다. `decision_owner`는 `no_consensus`가 아니면 `null`이다.

## 사용자 출력

사용자에게 내부 YAML 전체를 기본 출력하지 않는다. 다음 순서로 간결하게 통합한다.

1. Executive Verdict
2. Consensus Proposal
3. Strong Consensus
4. Material Disagreements
5. Decision by Axis
6. Evidence
7. Required Actions
8. Optional Optimizations
9. Unresolved
10. Method / Run Summary

Method / Run Summary에는 등급, 실제 수행 역할, 교차 반박의 실행·생략과 근거, 사용 모델과 fallback, 실패·생략을 기록한다. 내부 프롬프트, raw reasoning, 숨은 chain-of-thought는 제외한다.
