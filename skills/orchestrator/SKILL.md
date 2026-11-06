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

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 결과 통합

최종 응답에는 선택한 스킬과 실행 순서, 각 단계의 확인된 결과, 열린 제한사항, 다음에 필요한 입력만 포함한다. 전문 스킬의 판정을 덮어쓰지 않는다. 고위험 변경의 완료 가능 여부는 독립 감사 게이트가 `PASS`로 판정한 경우에만 그렇게 표현한다.
