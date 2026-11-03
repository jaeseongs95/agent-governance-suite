---
name: recovery-strategy-selector
description: blocker-diagnostician이 원인을 확정한 뒤 어떻게 복구할지 골라야 할 때, 우회·롤백·재설계 중 선택이 필요할 때 쓴다. 실행 가능한 복구 전략을 비교하고 새 작업 계약으로 넘길 RecoveryHandoff.v1을 만든다. 원인 미확정 상태의 진단, 수정 실행, 기존 run 변경은 하지 않는다.
license: MIT
metadata:
  version: "0.2.0"
---

# Recovery Strategy Selector

이 스킬을 적용할 때 [공통 행동 기준](../independent-audit-gate/references/specialist-behavior.md)을 먼저 읽고 따른다.

확인된 실패 원인을 해결할 독립 전략 2~3개를 만들고, 목표·권한·검증 불변조건을 통과한 전략만 비교해 새 작업용 handoff를 반환한다. 전략을 직접 실행하거나 기존 workflow를 수정하지 않는다.

## 전략을 비교하는 기준

- 각 전략이 확인된 근본 조건을 어떻게 바꾸는지 실제 대상과 검증 방법으로 설명한다. 재시작·대기 증가·예외 무시는 그 원인을 해결한다는 근거 없이 직접 해결책으로 분류하지 않는다.
- 후보 수를 채우려고 실행 불가능한 안이나 같은 안의 이름만 바꾼 대안을 만들지 않는다. 필요한 독립 전략을 근거 있게 작성할 수 없으면 부족한 입력을 보고한다.
- 유리한 비교값을 먼저 정하고 근거를 맞추지 않는다. `causeFit`, 검증 강도와 복구 가능성은 실제 근거로 정하며, `SELECTED`를 복구 실행·성공으로 보고하지 않는다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 출력

`RecoveryHandoff.v1`과 짧은 사용자 요약을 반환한다. verdict는 `SELECTED | NEEDS_APPROVAL | NEEDS_INPUT | NO_VIABLE_STRATEGY | BLOCKED`다.
