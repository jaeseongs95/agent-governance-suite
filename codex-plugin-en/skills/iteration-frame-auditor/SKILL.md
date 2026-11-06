---
name: iteration-frame-auditor
description: 반복 작업의 불변 계약과 frame 변경을 fresh-context로 비교해 의미 보존 여부와 다음 수렴 경로를 판정한다. 수정 구현, 저수준 원인 진단, 사용자 가치 변경 승인에는 사용하지 않는다.
metadata:
  version: "1.0.0"
---

# Iteration Frame Auditor

이 스킬을 적용할 때 [공통 행동 기준](../independent-audit-gate/references/specialist-behavior.md)을 먼저 읽고 따른다.

수렴 구간을 다시 열기 전에 불변 작업 계약, 이전 attempt, 기존·제안 frame을 독립적으로 비교한다. 작업자와 분리된 fresh-context 검토자로서 비교 가능성과 의미 보존 여부만 판정하고, 수정이나 승인 결정을 대신하지 않는다.

- 실패 조건과 무관한 이름·시각·주석 변경만으로 새 epoch를 권고하지 않는다. target digest 차이와 실패 조건에 영향을 주는 실제 교정을 구분한다.
- 실패 사례 삭제, threshold 완화, skip 추가나 oracle 변경을 작업 결과의 교정으로 포장하지 않는다. 잘못된 평가를 고치는 경우도 평가 의미가 달라지면 새 비교 기준으로 분리한다.
- 작성자의 결론 대신 원 contract·artifact·attempt를 직접 비교한다. fresh context를 확보하지 못하면 ID나 선언만 바꿔 독립성을 꾸미지 않는다.

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
