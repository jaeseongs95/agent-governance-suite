# Review protocol

## Evidence boundary

검토자는 `IterationFrameAuditRequest.v1`에 포함된 artifact와 locator만 근거로 사용한다. 최소한 contract, control frame, target frame 비교 근거, 이전 attempt outcome과 reviewer 분리 근거가 각각 하나 있어야 한다. locator가 존재한다는 사실만으로 내용을 확인했다고 간주하지 않는다. 읽을 수 없거나 digest가 맞지 않는 근거는 누락된 근거로 취급하고 review를 발행하지 않는다.

`requestArtifactDigest`는 검토자가 받은 request 전체의 canonical JSON digest다. orchestrator가 검토 전에 보관한 digest와 `IterationFrameComparison.v1` sidecar의 digest를 함께 검사해 중간 입력 교체를 막는다. 최종 판정은 저장소 공개 계약인 `ConvergenceReview.v1`으로 반환하고 sidecar는 그 판정의 비교 근거를 보존한다.

## Comparison vocabulary

- Contract impact
  - `unchanged`: canonical contract가 동일하다.
  - `semantics-changing`: 목표, 범위, 수용 기준, 제약, 권한, workspace 또는 대상 위치 중 하나라도 달라졌다.
  - `uncertain`: 차이의 사용자 가치 영향을 근거로 결정할 수 없다.
- Control impact
  - `unchanged`: canonical control frame이 동일하다.
  - `semantics-preserving`: 표현이나 구현은 달라졌지만 같은 입력에 같은 평가 의미와 pass/fail 경계를 유지함을 직접 근거로 확인했다.
  - `semantics-changing`: verifier, rubric, oracle, aggregation, pass condition 또는 evaluation input의 의미가 달라졌다.
  - `uncertain`: 동등성 또는 변경의 영향을 결정할 근거가 부족하거나 해석이 충돌한다.
- Target impact
  - `unchanged`: canonical target frame이 동일하다.
  - `changed`: 수정 대상 또는 후보가 달라졌다.
  - `uncertain`: 변경 대상이나 영향을 확인할 수 없다.

## Deterministic routing matrix

| Condition | Classification | Comparability | Route |
| --- | --- | --- | --- |
| Contract unchanged, control unchanged/equivalent, target changed | `semantics-preserving` | `comparable` | `resume-new-epoch`, `diagnose`, or `stop` |
| Contract unchanged, control unchanged/equivalent, target unchanged | `semantics-preserving` | `comparable` | `diagnose` or `stop` |
| Contract changed | `semantics-changing` | `non-comparable` | `needs-user` |
| Control semantics changed | `semantics-changing` | `non-comparable` | `needs-user` |
| Any comparison uncertain or interpretations conflict | `ambiguous` | `non-comparable` | `panel` |

`resume-new-epoch`는 reviewer의 권고다. 서버는 epoch 횟수, attempt budget, review freshness와 root revision을 별도로 확인한 뒤에만 gate를 연다.

## Separation of duties

검토자 ID는 request에 기록된 모든 implementation actor ID와 달라야 한다. `freshContext: true`는 cooperative-sealed assertion이며 악의적인 ID 위조를 방지하는 attestation은 아니다. 이 assertion을 제공할 수 없는 환경에서는 fail-closed로 유지한다.

## Handoffs

- `diagnose`: 같은 실패에 새 관측이 필요하다. `blocker-diagnostician`에 failure episodes와 권한 경계를 전달한다.
- `panel`: 의미 보존 여부에 복수의 타당한 해석이나 증거 충돌이 있다. `independent-deliberation-panel`에 원 근거와 dissent를 전달한다.
- `needs-user`: 사용자 가치 또는 평가 계약이 바뀐다. 변경 전후와 영향을 사용자에게 제시한다.
- `stop`: 의미 보존 여부는 정해졌지만 정책 한도, 안전 조건 또는 실행 가능성 때문에 더 진행하지 않는다.
