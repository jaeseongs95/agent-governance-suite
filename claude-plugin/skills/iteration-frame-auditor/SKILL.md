---
name: iteration-frame-auditor
description: 반복 작업의 불변 계약과 frame 변경을 fresh-context로 비교해 의미 보존 여부와 다음 수렴 경로를 판정한다. 수정 구현, 저수준 원인 진단, 사용자 가치 변경 승인에는 사용하지 않는다.
metadata:
  version: "1.0.0"
---

# Iteration Frame Auditor

수렴 구간을 다시 열기 전에 불변 작업 계약, 이전 attempt, 기존·제안 frame을 독립적으로 비교한다. 구현자와 분리된 fresh-context 검토자로서 비교 가능성과 의미 보존 여부만 판정하고, 수정이나 승인 결정을 대신하지 않는다.

## 적용 범위

- attempt 예산 소진 뒤 새 epoch를 열 수 있는지 검토할 때 사용한다.
- 목표·수용 기준·검증 의미 또는 평가 입력의 변경 가능성이 감지됐을 때 사용한다.
- 일반 코드 리뷰, 구현, 저수준 실패 원인 분석, 최종 릴리스 감사에는 사용하지 않는다.

## 입력

`IterationFrameAuditRequest.v1`을 받는다. 입력에는 다음 항목이 모두 있어야 한다.

- 불변 `root.contract`, 기준 `root.frame.controlArtifacts`와 `root.frame.targetArtifacts`, 서버가 계산한 각 digest
- append-only attempt history와 각 attempt의 evidence locator
- 제안 contract와 공개 `ConvergenceFrame.v1`, 각 digest와 변경 요약
- fresh-context reviewer ID와 모든 implementation actor ID
- contract/control/target 비교와 attempt 결과를 직접 확인할 evidence inventory

검토 전에 [references/review-protocol.md](references/review-protocol.md)를 읽는다. 원 request를 받은 뒤 먼저 digest를 외부 workflow 상태에 동결한다.

```bash
node scripts/digest-request.mjs --input audit-request.json
node scripts/validate-review.mjs --request audit-request.json --request-digest "sha256:..." --comparison comparison.json --review review.json
```

두 명령은 stdin도 지원하며 JSON만 stdout으로 반환한다. validator는 의미를 대신 추론하지 않고 reviewer가 작성한 `IterationFrameComparison.v1`과 공개 `ConvergenceReview.v1`이 입력, 근거와 결정 규칙에 맞는지만 검사한다.

## 절차

1. `reviewer.freshContext`가 `true`이고 reviewer가 모든 `implementationActorIds`와 다른지 확인한다. 분리된 fresh context를 확보할 수 없으면 판정하지 말고 fail-closed로 중단한다.
2. root와 proposal의 contract, control frame, target frame을 직접 비교한다. 객체 key 순서나 표현 차이가 아니라 canonical artifact digest와 실제 의미를 함께 확인한다.
3. 목표, 범위, 수용 기준, 제약, 권한, workspace 또는 대상 위치가 달라지면 사용자 가치 변경으로 기록한다. 이를 의미 보존으로 승인하지 않는다.
4. verifier, rubric, oracle, aggregation, pass condition 또는 evaluation input의 의미가 바뀌면 `semantics-changing`으로 판정한다. 영향이 불명확하거나 복수의 타당한 해석이 충돌하면 `ambiguous`로 판정한다.
5. 불변 계약이 같고 control frame이 같거나 근거로 의미 동등하며 target만 교정된 경우에만 `semantics-preserving`과 `comparable`을 선택할 수 있다.
6. 동일 target과 실패에서 새 원인 판별이 필요하면 `diagnose`로 보내고, 저수준 원인을 직접 분석하지 않는다.
7. `ambiguous`는 `panel`로 보내 `independent-deliberation-panel`이 검토하게 한다. 사용자 가치 변경은 패널이 승인하지 못하므로 `needs-user`로 보낸다.

## 경계

- 구현, 파일 변경, 검사 재실행, lease 발급 또는 epoch 개방을 수행하지 않는다.
- 자신의 구현 결과를 검토하거나 구현 actor ID를 바꿔 독립성을 가장하지 않는다.
- 누락된 근거를 추정하거나 reviewer 선언만으로 semantic equivalence를 증명하지 않는다.
- 사용자의 목표·범위·수용 기준·권한 변경을 의미 보존 교정으로 재분류하지 않는다.
- 두 번째 epoch 허용 여부와 남은 budget 같은 정책 상태는 convergence guard가 결정한다. 이 스킬의 `resume-new-epoch`는 검토 권고일 뿐이다.

## 출력

공개 `ConvergenceReview.v1`, 근거가 결속된 `IterationFrameComparison.v1` sidecar와 짧은 사용자 요약을 반환한다.

- `classification`: `semantics-preserving | semantics-changing | ambiguous`
- `comparability.comparable`: `true`(`comparable`) 또는 `false`(`non-comparable`)
- `route`: `resume-new-epoch | diagnose | panel | needs-user | stop`

sidecar의 각 comparison과 rationale은 입력 evidence inventory의 locator를 참조해야 한다. `resume-new-epoch`는 의미 보존·비교 가능·실제 target 변경이 모두 검증된 경우에만 반환한다.
