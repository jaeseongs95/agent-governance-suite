---
name: change-scope-guardian
description: 작업 전 기준 상태와 현재 Git 변경을 비교해 요청 범위 밖 파일, 제외 경로, 기존 사용자 변경과의 겹침을 판정한다. 요구사항 충족이나 코드 품질 검토에는 사용하지 않는다.
---

# Change Scope Guardian

현재 변경이 합의된 작업 범위와 기존 작업 상태를 침범했는지 읽기 전용으로 확인한다.

## 적용할 때

- 첫 변경 전에 기존 staged, unstaged, untracked 상태를 기준선으로 남겨야 할 때
- 구현 뒤 현재 diff가 `TaskEnvelope.v1`의 포함·제외 범위와 write target을 지키는지 확인할 때
- dirty worktree에서 기존 변경과 새 작업이 같은 파일을 건드렸는지 판정할 때

단순 코드 품질 검토, 요구사항 충족 판정, 파일 복구에는 적용하지 않는다. baseline이 없으면 변경 소유자를 추측하지 않는다.

## 절차

1. 대상 저장소와 적용 지침을 확인한다.
2. 첫 변경 전이면 `scripts/capture-workspace-baseline.mjs`로 `WorkspaceBaseline.v1`을 만들고 `manifestSha256`을 baseline artifact의 신뢰 경계에 동결한다.
3. 검증 시에는 task envelope, baseline과 동결한 `baselineArtifactDigest`를 `scripts/compare-change-scope.mjs`에 전달한다.
4. `excluded`, `unplanned`, `preexisting-overlap`, `ownership-unknown`을 근거 경로와 함께 보고한다.
5. `PASS`, `NEEDS_APPROVAL`, `BLOCKED`, `INCONCLUSIVE` 중 하나만 반환한다.

경로 판정 규칙은 [references/path-policy.md](references/path-policy.md), verdict 조건은 [references/verdict-rules.md](references/verdict-rules.md)를 읽는다.

## 불변조건

- reset, checkout, restore, stash, clean이나 파일 쓰기를 실행하지 않는다.
- 원문 코드와 전체 diff를 baseline에 저장하지 않는다.
- rename은 이전 경로와 새 경로를 함께 검사하고 delete는 삭제 전 경로로 검사한다.
- symlink 대상과 submodule 내부를 따라가지 않는다.
- baseline과 현재 저장소 identity가 다르면 비교하지 않는다.
- 입력 artifact 자체의 checksum만 다시 계산해 신뢰하지 않는다. baseline과 report는 오케스트레이터나 호출자가 별도로 동결한 artifact digest와 일치해야 한다.
- 범위 확대가 필요하면 기존 결과를 덮어쓰지 말고 task contract와 baseline을 새로 만든다.

직접 호출은 MCP를 요구하지 않는다. 오케스트레이션에서는 capture와 verify가 서로 다른 provider stage로 등록된다.
