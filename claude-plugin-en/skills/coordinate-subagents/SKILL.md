---
name: coordinate-subagents
description: 사용자가 서브에이전트·병렬 작업·독립 감사자를 요청했을 때, 또는 문서화된 순이익 검사가 위임을 정당화할 때 쓴다. 소유권 배정, 근거 통합, 고위험 감사 분리를 맡는다. 작업 단위가 많거나 복잡하다는 이유만으로, 또는 orchestration이 켜져 있다는 이유만으로는 쓰지 않는다.
license: MIT
metadata:
  version: "1.1.0"
---

# Coordinate Subagents

이 스킬을 적용할 때 [공통 행동 기준](../independent-audit-gate/references/specialist-behavior.md)을 먼저 읽고 따른다.

Coordinate work across subagents without expanding the user's scope, permissions, or requested side effects.

Keep delegation, agent count, batching, context, permissions, and independent-audit decisions here. For an approved assignment, `model-effort-advisor` supplies the pre-dispatch role/difficulty/risk/preference/verification judgment and reuses this skill's resolver; its advice never authorizes dispatch or attests effective settings.

## Apply instruction priority

<!-- policy-contract: authority.inherit-mode -->

- Follow system, developer, user, project instruction, and mode constraints before this skill.
- Treat delegation as a way to execute authorized work, never as new authorization.
- Apply the current mode and write restrictions to every delegated task.
- Honor an explicit user choice about whether to delegate, how many agents to use, and which supported model or reasoning effort to select.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## Complete the task

Before reporting completion:

<!-- policy-contract: completion.current-evidence -->
<!-- policy-contract: completion.report-facts -->

- account for every assignment;
- confirm that each subagent's scoped verification actually passed;
- verify each requirement against current evidence with checks proportional to its failure impact;
- avoid checks that merely repeat the work being checked, and reverify only the affected scope when a later change invalidates earlier evidence;
- integrate accepted results without overwriting unrelated user work;
- complete required independent audits and resolve their findings;
- report the result, material changes, checks actually run, their outcomes, and remaining constraints;
- never present an unrun check or unverified setting as completed.
