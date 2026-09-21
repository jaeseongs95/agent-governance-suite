---
name: workspace-convention-profiler
description: 처음 보는 저장소에서 작업을 시작할 때, 어떤 명령으로 검증하는지·어디를 고쳐야 하는지 모를 때, 코드 변경 전에 관례를 확인해야 할 때 쓴다. 구조·도구·관례·정의된 검증 명령과 변경 후보 지점을 읽기 전용으로 조사한다. AGENTS.md 우선순위 판정·범위 확정·diff 감사는 다른 스킬이 맡는다.
license: MIT
metadata:
  version: "1.0.0"
---

# Workspace Convention Profiler

현재 작업과 관련된 저장소 구조와 관례를 근거와 함께 정리한다. 관측된 사실, 반복 사례에서 얻은 추론, 확인하지 못한 항목을 구분하고 저장소에 새 관례를 만들지 않는다.

## 적용 조건

- 사용자가 저장소 구조, 관례, 명령 또는 변경 후보 지점을 조사해 달라고 요청했다.
- 낯선 저장소의 여러 파일이나 모듈을 수정하기 전에 기존 방식을 확인해야 한다.
- 작업 분해나 검증 계획에 필요한 코드, 테스트, 설정 위치가 아직 확인되지 않았다.

단일 파일의 명백한 수정, 이미 유효한 profile이 있는 작업, 적용 `AGENTS.md`·`CLAUDE.md`만 묻는 요청, 현재 diff의 범위 판정에는 사용하지 않는다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 출력

출력은 [profile 계약](references/profile-contract.md)을 따른다. `profileFingerprint`는 결과에 영향을 주는 요청 필드, Git ref와 revision, 관측한 구조·근거로 계산하며 `observedAt`은 포함하지 않는다. 요청, 관련 매니페스트, CI, 지침, Git 상태나 구조가 바뀌면 이전 profile을 다시 사용하지 않는다.
