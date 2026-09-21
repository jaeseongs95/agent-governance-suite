---
name: context-continuity
description: 긴 작업 중 컨텍스트 압축·재시작이 예상될 때, 지금까지의 결정·진행·차단 요인을 잃으면 다음 판단이 달라질 때, 재개 후 이전 상태를 복원해야 할 때 쓴다. 핵심 상태를 선별해 로컬 continuity checkpoint로 저장하고 복원 후보를 검토한다. transcript 보관, workflow 원장 복제, 일반 메모에는 쓰지 않는다.
license: MIT
metadata:
  version: "1.0.0"
---

# Context Continuity

긴 direct task의 중요한 상태만 로컬 MCP 경계에 checkpoint한다. 이 스킬은 무엇을 보존할지 판단하며, MCP 서버는 의미를 추측하지 않고 replacement snapshot의 revision, digest, binding과 복원 상태만 관리한다.

Orchestrated workflow에는 direct snapshot을 만들지 않는다. `TaskEnvelope`, `WorkflowReceipt`, convergence root가 기준 원장이며 compact Hook이 그 구조적 상태를 투영한다.

## Checkpoint 판단

다음 중 하나라도 잃었을 때 실제 다음 행동이 달라지는 정보만 보존한다.

- 범위·권한·완료 기준 위반을 막는 정보
- 완료 작업이나 실패 시도의 반복을 막는 정보
- 다음 행동 또는 구현 분기를 바꾸는 결정
- 검증·승인 근거를 다시 찾게 만드는 참조
- 현재 blocker나 아직 필요한 사용자 결정

단순 대화 요약, 설명 가능한 배경지식, raw transcript, 원시 로그·코드, 비밀, 개인정보, chain-of-thought는 저장하지 않는다. Direct snapshot은 로컬 SQLite에 평문 JSON으로 보존되고 자동 만료되지 않는다. checkpoint가 필요하지 않으면 MCP를 호출하지 않는다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
