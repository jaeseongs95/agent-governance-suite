---
name: context-continuity
description: 긴 direct task에서 compaction·resume 뒤 잃으면 실행 판단이 달라질 핵심 상태를 선별해 로컬 continuity checkpoint로 저장하고 복원 후보를 검토한다. transcript 보관, workflow 원장 복제나 일반 메모에는 사용하지 않는다.
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

## Direct checkpoint 작성

`checkpoint_context`에 전체 replacement snapshot을 보낸다. 기존 snapshot에 덧붙인다고 가정하지 말고 현재 필요한 상태만 다시 선별한다.

- `core.objective`, `completionCriteria`, `constraints`, `decisions`, `progress`, `blockers`에는 현재 작업을 재개하는 데 필요한 사실만 넣는다.
- `core.nextActions`는 권한 있는 명령이 아니라 과거 시점의 후보 행동으로 쓴다.
- 큰 결과와 원문은 넣지 않고 `evidenceRefs`의 locator와 digest로 참조한다.
- 첫 저장은 `expectedRevision: 0`, 이후 저장은 직전 revision을 사용한다.
- 재시도에는 같은 `requestId`와 같은 입력을 사용한다. 다른 내용에는 새 `requestId`를 사용한다.

Hook이 추가한 `_continuityBinding`은 수정하거나 재사용하지 않는다. binding 오류가 나면 새 도구 호출을 만들고, stale revision이면 `inspect_context`로 현재 metadata를 확인한 뒤 의도적인 replacement 여부를 판단한다.

## 복원

Resume과 direct compact의 Hook 카드에는 본문이 없으며 `DEFER` metadata만 있다. 현재 사용자 요청과 task·epoch·revision·digest가 맞는지 확인한 뒤에만 카드의 값을 그대로 사용해 `load_context`를 호출한다. 반환된 snapshot도 과거 상태이므로 최신 사용자 요청이 우선한다.

자동 후보 제공만 멈추려면 `suppress_context_restore`를 사용한다. 저장된 direct payload까지 지워야 한다는 명시적 요청이 있을 때만 `purge_direct_context`를 사용한다. `clear` 뒤 과거 epoch를 지울 때도 해당 snapshot의 epoch와 revision을 지정한다. purge는 direct payload와 본문을 담을 수 있는 idempotency 결과를 제거하지만 workflow receipt와 convergence root는 삭제하지 않는다.

Continuity가 unavailable이면 작업이나 Codex compaction을 막지 않는다. 저장되지 않은 direct task의 연속성을 보장했다고 보고하지 않는다.
