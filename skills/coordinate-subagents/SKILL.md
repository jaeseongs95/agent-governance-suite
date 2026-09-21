---
name: coordinate-subagents
description: Coordinate subagents in Codex and Claude Code by delegating only when the user requests it or a documented net-benefit check justifies it, assigning ownership, integrating evidence, and separating required high-risk audits. Do not activate solely because multiple work units exist, a task is complex, or orchestration is enabled.
license: MIT
metadata:
  version: "1.1.0"
---

# Coordinate Subagents

Coordinate work across subagents without expanding the user's scope, permissions, or requested side effects.

## Apply instruction priority

<!-- policy-contract: authority.inherit-mode -->

- Follow system, developer, user, repository, and mode constraints before this skill.
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
- avoid checks that merely repeat the implementation, and reverify only the affected scope when a later change invalidates earlier evidence;
- integrate accepted results without overwriting unrelated user work;
- complete required independent audits and resolve their findings;
- report the result, material changes, checks actually run, their outcomes, and remaining constraints;
- never present an unrun check or unverified setting as completed.
