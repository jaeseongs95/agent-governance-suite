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
