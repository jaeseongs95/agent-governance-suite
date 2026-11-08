---
name: task-contract
description: "Turn requests open to interpretation or with high failure impact into a TaskEnvelope.v1 tracing goal, scope, acceptance criteria, work units, risk, permissions and verification evidence. Not for clear small tasks, implementation, execution planning or completion judgment."
license: MIT
metadata:
  version: "1.1.0"
---

# Task Contract

이 스킬을 적용할 때 [공통 행동 기준](../independent-audit-gate/references/specialist-behavior.md)을 먼저 읽고 따른다.

사용자 요청을 실행 전에 확인할 수 있는 작업 계약으로 정리한다. 계약 작성만 요청받으면 실제 작업이나 MCP workflow를 시작하지 않는다. 계약은 해석이 갈리거나 실패 영향이 큰 작업에만 만들고, 계약이 없다는 이유로 배정받은 일을 미루지 않는다.

## 계약 작성의 기준

- 요청의 대상, 포함·제외 범위, 조건, 비교 기준과 이미 정정된 선택을 그대로 보존한다. 선호를 의무로, 예외를 기본값으로, 검토 요청을 실행 요청으로 바꾸지 않는다.
- 수용 기준은 사용자에게 필요한 관측 결과로 작성한다. 임의의 수행 방식, 추가 문서나 선택 기능을 완료 조건에 끼워 넣지 않는다.
- 목표·범위·수용 기준·권한을 정할 수 없게 하는 모호함만 질문한다. 기존 근거로 정할 수 있는 수행 방식 선택은 가정과 근거를 남기고 진행하며, 계약을 만든 사실을 작업 진척으로 보고하지 않는다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 판정과 실패 처리

- 계약이 유효하고 blocking ambiguity와 contradiction이 없으면 `PASS`다.
- 사용자 답이 있어야 계약을 확정할 수 있으면 `NEEDS_INPUT`이다. 필요한 질문을 한 번에 모아 사용자에게 바로 묻는다.
- 필수 지침이나 원 요청에 접근할 수 없거나 입력 자체를 검증할 수 없으면 `BLOCKED`다.

기존 계약의 목표, 범위, dependency 또는 write target이 달라지면 기존 envelope를 고치지 말고 새 계약과 digest를 만든다. 다른 전문 스킬을 직접 호출하지 않으며, Agent Governance Suite 연결 정보는 `integration/skill-descriptor.json`에만 둔다.
