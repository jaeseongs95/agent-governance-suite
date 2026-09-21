## 시작 조건

이 스킬을 직접 실행하는 경로는 SQLite 사전을 열거나 조회하지 않는다. MCP 경로는 자동 보호 구간 추출을 마친 직후 `lookup_korean_prose_terms`를 정확히 한 번 호출하고, 비공개 `glossary-match-set.v1`과 `GlossaryBinding.v1`을 만들어 아래 세 언어 판단 역할에 같은 digest로 전달한다. 역할별 재조회는 금지한다. 조회가 실패하거나 입력 한계·정규화 제약에 걸리면 사전 없이 기본 규칙으로 계속 진행하고 고정 경고 코드를 남긴다.

언어 판단에는 서로 다른 세 행위자가 필요하다. selection, editing, verification provider에 각각 고유한 `actorId`를 배정하고 `actorIds` 배열을 같은 순서로 기록한다. finalization provider는 결정적 로컬 스크립트이므로 별도의 판단 행위자를 두지 않는다. 서브에이전트를 사용할 수 없거나 세 행위자를 분리할 수 없으면 편집하지 말고 실패를 알린다.

provider 교환 객체를 만들기 전에 [contracts.md](contracts.md)를 읽는다. 원문과 보호 manifest로 결정적 source-unit manifest를 먼저 만들고, 각 역할의 비공개 work product를 앞선 artifact의 digest에 연결한다. MCP 통합이면 [integration.md](integration.md)도 읽는다.

저장소의 동결 평가에서는 각 언어 판단 provider를 호출하기 직전에 `eval:preflight`를 해당 단계(`selection`, `editing`, `verification`)로 실행한다. 모든 결과를 만든 뒤 workflow receipt를 기록하기 전에는 `record` 단계로 다시 검사한다. 실패하면 해당 provider와 이후 단계를 호출하지 않으며, 같은 입력과 출력 경로로 재시도하거나 기존 결과를 덮어쓰지 않는다.

## Provider 흐름

1. selection provider는 원문, source-unit manifest, glossary binding, 사용자의 목적과 문체 샘플만 보고 모든 unit을 `edit`, `retain`, `defer` 중 하나로 분류한다. `edit`이면 추상적인 선호가 아니라 실제 문제가 있는 원문 `issueRanges`와 제한된 결함 코드를 기록한다. 필요한 추가 보호 문자열은 기록하되 replacement는 만들지 않는다. 자세한 기준은 [selection-policy.md](selection-policy.md)를 따른다.
2. editing provider는 selection work product, 원문과 보호 구간 manifest를 받아 `edit`로 선택된 prose unit 안에서 `issueRanges`와 겹치는 최소 범위 edit를 `editing-draft`에 만든다. 호스트는 draft를 검증한 뒤 per-record `selectionDigest`와 `candidateDigest`를 계산해 `editing-work-product`로 봉인한다. 새 사실을 보태지 않으며 애매한 표현은 유지한다. [editing-policy.md](editing-policy.md)를 따른다.
3. verification provider는 원문과 각 edit를 직접 대조한다. edit마다 `sourceDefect`, `invariantDelta`와 `accept` 또는 `retain`을 판정하며, 구체적인 원문 결함이 없거나 의미 불변량 보존을 확신할 수 없으면 해당 edit만 `retain`한다. [verification-rubric.md](verification-rubric.md)를 따른다.
4. finalization provider는 `scripts/finalize.mjs`로 구조화된 selection, editing, verification work product를 검증하고 승인된 edit만 적용한다. 범위 밖 edit, 보호 구간 edit와 누락·`retain` 결정은 해당 edit만 원문으로 남긴다. artifact 계약이나 digest 연결을 신뢰할 수 없으면 원문 전체로 복귀한다. [finalization.md](finalization.md)를 따른다.

## 공통 불변 조건

- 사실, 이름, 숫자, 날짜, 인용, 출처, 링크, 사건 순서, 부정·조건과 확신 수준을 보존한다.
- 코드, 명령어, 경로, URL, Markdown 링크 대상과 구조화 데이터는 문자 그대로 둔다.
- 새 경험, 감정, 행위자, 인과, 평가, 오탈자나 비문을 만들지 않는다.
- 법률·학술·의료·보안 문서의 유보와 면책을 제거하지 않는다.
- 짧아졌거나 매끄럽다는 이유만으로 의미가 달라진 수정을 채택하지 않는다.
- 의미를 확신하지 못하면 해당 edit만 `retain`한다. 계약이나 보호 조건 전체를 신뢰할 수 없으면 원문 전체로 복귀한다.
