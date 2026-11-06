---
name: orchestrator
description: 어떤 거버넌스 전문 스킬이 필요한지 정해야 하거나 여러 전문 결과의 실행 순서·입출력·gate를 연결해야 할 때 사용한다. 한 전문 스킬로 충분하면 그 스킬을 직접 쓰고, 전문 스킬이 필요 없는 요청이나 전문 판단·감사 자체에는 사용하지 않는다.
license: MIT
metadata:
  version: "1.2.0"
---

# Governance Orchestrator

이 스킬을 적용할 때 [공통 행동 기준](../independent-audit-gate/references/specialist-behavior.md)을 먼저 읽고 따른다.

전문 스킬의 책임을 바꾸지 않고 요청을 적절한 실행 흐름으로 연결한다. 이 스킬은 분류, 선택, 순서 결정, 입출력 전달, 중간 결과 확인과 최종 결과 통합만 맡는다. 보안 판단, 독립 감사, 반박 작성, 구현, 배포를 대신 수행하지 않는다.

공통 접수·선택 기준은 MCP 서버 instructions로 이미 받았으며, 받지 못한 호스트에서는 [공통 접수·선택 기준](references/intake.md)을 읽고 따른다.

일반 한국어 답변·진행 보고·결과 설명은 요청 목적에 맞게 직접 작성한다. 한국어라는 이유만으로 산문 전문 스킬이나 네 단계 workflow를 추가하지 않는다. 독립된 산문 편집·자연스러움 검증이 필요한 경우에만 요청한 capability를 선택한다. 전체 산문 workflow를 명시적으로 수행할 때는 `korean-prose-selection`, `korean-prose-editing`, `korean-prose-verification`, `korean-prose-finalization` 네 capability를 요청하고 descriptor의 artifact 의존성과 `phaseOrder`를 지킨다. 일부 단계만 요청하면 필요한 기존 artifact를 제공하며, 누락을 다른 단계의 자동 실행이나 검증 완료로 메우지 않는다. 원문은 전문 스킬 내부에서만 다루고 MCP 영수증의 reference-only policy는 유지한다.

## Claude Code에서의 호출과 관측

이 절은 호출 방식과 실행 관측만 바꾸며 위의 선택 기준, 아래 참고 자료의 실행 순서·결과 기록 규칙은 그대로 적용한다.

- 전문 스킬은 Skill 도구나 `/agent-governance-suite:<skill-name>` 명령으로 실제 호출한다. 사용자가 slash 명령이나 스킬 이름으로 지정한 스킬을 "이름으로 지정한 스킬"로 본다.
- 공통 계약이 요구하는 독립 감사자를 Claude Code에서 호출할 때는 `agent-governance-suite:independent-auditor` 서브에이전트 유형을 사용한다.
- SessionStart 훅은 공통 접수 기준을 다시 싣지 않고, MCP 서버 instructions를 따르라는 한 줄 호출 안내만 context로 전달한다. 훅 자체가 스킬을 선택하거나 실행했다고 간주하지 않는다.

### 실행 관측

- `plan_workflow`와 `record_stage_result`를 호출할 때마다 플러그인 훅이 그 호출을 낸 세션(서브에이전트가 호출했으면 그 서브에이전트)의 모델과 추론 수준을 transcript에서 관측해 서버에 넘긴다. 도구 인자에 `executionContext`나 `_hostAttestation`을 넣지 않는다. 넣어도 훅이 지우거나 덮어쓴다.
- `record_stage_result`의 관측 대상은 도구 호출자다. 메인 세션이 호출하면 메인 세션 관측이, 서브에이전트가 호출하면 그 서브에이전트 transcript 관측이 전달된다.
- 메인 세션의 SessionStart·PostModelSwitch 훅은 현재 세션 모델을 기록하고, PreToolUse 훅은 각 대상 도구 호출의 관측을 공통 host-attestation 경로로 전달한다. 관측 실패 뒤 처리 기준은 [MCP 실행 계약](references/mcp-execution.md)을 따른다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 결과 통합

최종 응답에는 선택한 스킬과 실행 순서, 각 단계의 확인된 결과, 열린 제한사항, 다음에 필요한 입력만 포함한다. 전문 스킬의 판정을 덮어쓰지 않는다. 고위험 변경의 완료 가능 여부는 독립 감사 게이트가 `PASS`로 판정한 경우에만 그렇게 표현한다.
