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

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 출력

공개 `ConvergenceReview.v1`, 근거가 결속된 `IterationFrameComparison.v1` sidecar와 짧은 사용자 요약을 반환한다.

- `classification`: `semantics-preserving | semantics-changing | ambiguous`
- `comparability.comparable`: `true`(`comparable`) 또는 `false`(`non-comparable`)
- `route`: `resume-new-epoch | diagnose | panel | needs-user | stop`

sidecar의 각 comparison과 rationale은 입력 evidence inventory의 locator를 참조해야 한다. `resume-new-epoch`는 의미 보존·비교 가능·실제 target 변경이 모두 검증된 경우에만 반환한다.
