---
name: ponytail
description: 코드를 작성·수정·리팩터링·설계하거나 라이브러리와 의존성을 고를 때, 그리고 거버넌스 흐름의 구현 단계에서 쓴다. 기능이 꼭 필요한지부터 따지고 저장소에 이미 있는 것, 표준 라이브러리, 플랫폼 기능, 이미 설치된 의존성 순으로 찾아 요구사항과 필요한 검증을 충족하는 가장 작은 완전한 구현을 고른다. 과잉 설계나 불필요한 추상화·의존성을 줄여 달라는 요청에도 쓴다. 강도는 lite, full(기본), ultra 중에서 고른다. 코딩이 아닌 요청(일반 지식, 문서, 번역, 요약)에는 쓰지 않는다. 코드 검토·감사·검증·완료 판정 작업에는 쓰지 않는다.
argument-hint: "[lite|full|ultra]"
license: MIT
---

# Ponytail

이 스킬을 적용할 때 [공통 행동 기준](../independent-audit-gate/references/specialist-behavior.md)을 먼저 읽고 따른다.

Minimize unnecessary implementation while preserving requested behavior,
correctness, resource limits and verification. Less code is useful only when
it solves the actual task completely.

## Persistence

ACTIVE EVERY RESPONSE THAT WRITES OR CHANGES CODE. No drift back to
over-building while the skill is available and enabled. Explicit disable or user override takes precedence over automatic selection and mandatory-first wording. Do not reactivate a disabled skill or stop the task because it is absent: continue with ordinary engineering, preserving requirements and necessary tests. "stop ponytail" / "normal mode" are examples, not the only ways to disable it. A later explicit user request may enable this skill for that request; it does not change persistent settings. Default: **full**.
Switch: `/agent-governance-suite:ponytail lite|full|ultra`.

## The ladder

Stop at the first rung that satisfies the current requirements, relevant
invariants and actual target environment:

1. **Does this need to exist at all?** Skip speculative additions. An explicit requirement is not speculative; propose a scope change before dropping it. (YAGNI)
2. **Already in this codebase?** A helper, util, type, or pattern that already lives here → reuse it. Look before you write; re-implementing what's a few files over is the most common slop.
3. **Stdlib does it?** Use it.
4. **Native platform feature covers it?** `<input type="date">` over a picker lib, CSS over JS, DB constraint over app code.
5. **Already-installed dependency solves it?** Use it. Never add a new one for what a few lines can do.
6. **Can it be one clear line?** Keep it only if error handling, ownership and behavior stay explicit.
7. **Only then:** the minimum complete implementation.

The ladder is a reflex, not a research project — but it runs *after* you
understand the problem, not instead of it. Read the task and the code it
touches first, trace the real flow end to end, then climb. Two rungs work →
take the higher one and move on. Check semantics, supported platform,
concurrency and resource lifetime before treating a library or native feature
as equivalent. A short happy-path demo is not sufficient evidence.

**Bug fix = root cause, not symptom.** A report names a symptom. Before you
edit, inspect the relevant callers and shared execution path. Put the fix
where the violated invariant belongs. Use a shared guard only when it is
correct for all affected callers; a caller-specific condition does not become
a global rule because that produces fewer lines. Cover sibling paths affected
by the same cause and preserve callers that already behave correctly.
Same for a hand-written list that must mirror the code (files to copy,
imports, paths): one more entry is the caller-by-caller patch. Derive the list
with existing code, or add a check that fails when it is incomplete; deliberate
allowlists and test case tables stay hand-written. A typo or wrong constant in
the line itself is its own root cause: fix the line.

## Rules

- No speculative abstractions: require a current caller, variation axis, or contract boundary; no factory for one product or config for a value that never changes. A vendor/host adapter may have one implementation and still be necessary to isolate protocol, permissions, transport, or resource lifetime. Preserve that boundary and use the smallest existing function, port, or interface; do not add layers just to increase implementation count.
- No boilerplate, no scaffolding "for later", later can scaffold for itself.
- Prefer deletion when behavior and required evidence remain intact. Prefer readable code over clever compression.
- Minimize the complete change, including affected callers and verification. File count and diff length are not acceptance criteria.
- For complex requests, deliver the requested behavior with the smallest adequate design. Resolve routine choices directly; do not ship a reduced substitute and ask whether the user still wants the original requirement.
- Two stdlib options, same size? Take the one that's correct on edge cases. Lazy means writing less code, not picking the flimsier algorithm.
- Mark deliberate simplifications that cut a real corner with a known ceiling (global lock, O(n²) scan, naive heuristic) with a `ponytail:` comment naming the ceiling and upgrade path (`# ponytail: global lock, per-account locks if throughput matters`).

## Output

Present the code or artifact, the verification actually performed and any
material remaining limit. Keep routine explanations brief without deleting
failure evidence or an important tradeoff to meet a line count. Give reports,
walkthroughs and per-phase notes in full when the user requests them.

Pattern: `[result] → verified: [evidence] → remaining: [only if material].`

## Intensity

| Level | What change |
|-------|------------|
| **lite** | Build what is requested; mention a simpler equivalent only when it changes a useful decision. |
| **full** | Apply the ladder to the complete requirement. Prefer existing, standard and native solutions that preserve semantics. Default. |
| **ultra** | Remove optional complexity aggressively while preserving every requested behavior and necessary check. |

Example: "Add a cache for these API responses."
First establish freshness, tenant/auth isolation, invalidation and capacity.
Reuse an existing cache that satisfies them. A plain `lru_cache` is suitable
only when its semantics cover those requirements; it does not supply TTL or
tenant isolation by itself. All intensity levels preserve these conditions.

## Operational work

Operational tasks (moving files, applying ledger rows, changing a setting, running a
requested migration) climb the same ladder. Use the existing tool or command
in the authorized execution environment and check the result directly: counts,
hashes, a query or the relevant existing test. Create an isolated checkout or
fixture when the user's constraints or actual interference risk require it;
do not build unrelated tools or analysis documents. Real high-risk gates (permanent deletion,
production data, deploy, permissions, secrets, payment) still apply. When approval is
missing, ask once with the target, impact, and exact command instead of building around it.

## When NOT to be lazy

Never simplify away: input validation at trust boundaries, error handling
that prevents data loss or tells the caller what failed (never swallow or
flatten an error to shorten code), security measures, accessibility basics, anything
explicitly requested. User insists on the full version → build it, no
re-arguing.

Never lazy about understanding the problem. The ladder shortens the
solution, never the reading. Trace the whole thing first — every file the
change touches, the actual flow — before picking a rung. Laziness that skips
comprehension to ship a small diff is the dangerous kind: it dresses up as
efficiency and ships a confident wrong fix. Read fully, then be lazy.

Hardware is never the ideal on paper: a real clock drifts, a real sensor
reads off, a PCA9685 runs a few percent fast. Leave the calibration knob, not
just less code, the physical world needs tuning a minimal model can't see.

Code without its necessary check is unfinished. Reuse the repository's test
runner, fixtures and relevant checks. Add a focused regression only when the
existing coverage cannot detect the defect; do not impose a one-test ceiling
or replace integration evidence with an ad hoc self-check. Trivial reversible
changes do not need invented tests. A bug fix's check must exercise the original
failure condition on the intended environment; demonstrate failure on the
pre-fix behavior when reproducible and state the gap when it is not.

## Boundaries

When implementing code, apply the relevant [Engineering Practices implementation rules](../orchestrator/references/engineering-practices/implementation.md). Preserve CS invariants and verification obligations supplied for the task; minimal implementation does not replace CS review or test design.

Ponytail governs what you build, not how you talk. It does not apply to
reviews, audits, verification, completion reports, or non-coding answers.
User, project, and repository instructions (report format, language, test
location and tooling) override the Output and test rules above. Requested
behavior and acceptance criteria are never cut; offer cuts as suggestions.
Explicit disable and user overrides apply to the entire skill, not only Output and test rules. Level persists only while enabled, until changed or session end.

Choose the smallest complete, verified path to the requested result.
