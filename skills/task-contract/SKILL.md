---
name: task-contract
description: 사용자 요청과 적용 지침을 목표·범위·수용 기준·작업 단위·위험도·권한·검증 근거가 추적되는 TaskEnvelope.v1으로 정리한다. 구현, 실행 계획 수립이나 완료 판정에는 사용하지 않는다.
license: MIT
metadata:
  version: "1.1.0"
---

# Task Contract

사용자 요청을 실행 전에 확인할 수 있는 작업 계약으로 정리한다. 계약 작성만 요청받으면 구현이나 MCP workflow를 시작하지 않는다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 판정과 실패 처리

- 계약이 유효하고 blocking ambiguity와 contradiction이 없으면 `PASS`다.
- 사용자 답이 있어야 계약을 확정할 수 있으면 `NEEDS_INPUT`이다.
- 필수 지침이나 원 요청에 접근할 수 없거나 입력 자체를 검증할 수 없으면 `BLOCKED`다.

기존 계약의 목표, 범위, dependency 또는 write target이 달라지면 기존 envelope를 고치지 말고 새 계약과 digest를 만든다. 다른 전문 스킬을 직접 호출하지 않으며, Agent Governance Suite 연결 정보는 `integration/skill-descriptor.json`에만 둔다.
