---
name: recovery-strategy-selector
description: 확인된 반복 실패 원인 뒤에 실행 가능한 복구 전략을 비교하고, 새 작업 계약으로 안전하게 넘길 RecoveryHandoff.v1을 만든다. 원인 미확정 진단, 수정 실행, 기존 run 변경에는 사용하지 않는다.
license: MIT
metadata:
  version: "0.2.0"
---

# Recovery Strategy Selector

확인된 실패 원인을 해결할 독립 전략 2~3개를 만들고, 목표·권한·검증 불변조건을 통과한 전략만 비교해 새 작업용 handoff를 반환한다. 전략을 직접 실행하거나 기존 workflow를 수정하지 않는다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 출력

`RecoveryHandoff.v1`과 짧은 사용자 요약을 반환한다. verdict는 `SELECTED | NEEDS_APPROVAL | NEEDS_INPUT | NO_VIABLE_STRATEGY | BLOCKED`다.
