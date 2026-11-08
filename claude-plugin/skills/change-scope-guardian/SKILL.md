---
name: change-scope-guardian
description: "Compare the pre-work baseline with current Git changes to flag files outside the requested scope, excluded paths and overlap with existing user changes. Call only when work overlaps other work or before a default-branch merge or publication. Not for requirement fulfilment or code quality review."
---

# Change Scope Guardian

이 스킬을 적용할 때 [공통 행동 기준](../independent-audit-gate/references/specialist-behavior.md)을 먼저 읽고 따른다.

현재 변경이 합의된 작업 범위와 기존 작업 상태를 침범했는지 읽기 전용으로 확인한다.

- 검사를 통과시키려고 포함 경로를 저장소 전체로 넓히거나 변경 후 상태를 새 원본 baseline으로 캡처하지 않는다. 범위 조정은 원 요청의 근거와 작업 시작 전 상태를 보존한다.
- 같은 파일 안의 기존 사용자 변경과 이번 변경을 구분한다. 경로가 허용됐다는 이유로 파일 전체 덮어쓰기·일괄 stage·다른 작업 커밋 포함을 정당화하지 않는다.
- `PASS`는 실제 비교한 Git 변경의 범위 판정이다. 검사 밖의 외부 자원·무시된 파일·submodule 내부까지 확인했다고 보고하지 않는다.

## 적용할 때

- 첫 변경 전에 기존 staged, unstaged, untracked 상태를 기준선으로 남겨야 할 때
- 구현 뒤 현재 diff가 `TaskEnvelope.v1`의 포함·제외 범위와 write target을 지키는지 확인할 때
- dirty worktree에서 기존 변경과 새 작업이 같은 파일을 건드렸는지 판정할 때

단순 코드 품질 검토, 요구사항 충족 판정, 파일 복구에는 적용하지 않는다. baseline이 없으면 변경 소유자를 추측하지 않는다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 불변조건

- reset, checkout, restore, stash, clean이나 파일 쓰기를 실행하지 않는다.
- 원문 코드와 전체 diff를 baseline에 저장하지 않는다.
- rename은 이전 경로와 새 경로를 함께 검사하고 delete는 삭제 전 경로로 검사한다.
- symlink 대상과 submodule 내부를 따라가지 않는다.
- baseline과 현재 저장소 identity가 다르면 비교하지 않는다.
- 입력 artifact 자체의 checksum만 다시 계산해 신뢰하지 않는다. baseline과 report는 오케스트레이터나 호출자가 별도로 동결한 artifact digest와 일치해야 한다.
- 범위 확대가 필요하면 기존 결과를 덮어쓰지 말고 task contract와 baseline을 새로 만든다.

직접 호출은 MCP를 요구하지 않는다. 오케스트레이션에서는 capture와 verify가 서로 다른 provider stage로 등록된다.
