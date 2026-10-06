# NOT_VERIFIABLE

이 실행에서 캡처하지 못했거나 확인할 수 없는 항목이다. 이 항목들은 PASS로 계산하지 않는다.

| 항목 | 상태 | 이유 |
|---|---|---|
| cutoff(2026-10-06T11:34:29Z) 이후의 세션 로그 | 캡처 안 됨 | 공개본 생성, preflight, commit, push 단계는 동결된 transcript에 없다. push 결과는 원격 ref를 직접 관측해 확인한다. |
| 스킬 본문이 프로세스 메모리에 실제로 올라간 bytes | UNKNOWN | child transcript에 주입된 텍스트만 관측했다. 이 텍스트는 SKILL.md 본문과 같다(raw/092, 093). 메모리는 관측하지 않았다. |
| child가 cache installPath `<I>`에서 로드했는지 | 관측상 아님 | init plugins path, Skill base directory, mcp list가 모두 repo의 `claude-plugin/`(readFromFolder)을 가리킨다. bytes는 506/506 같지만 로드 경로는 `<I>`가 아니다. |
| test-plan-validation의 runtime phaseOrder 35 | UNKNOWN(runtime) | plan_workflow 응답에 stage가 없고 GATE_FAILED(bootstrap)만 있다. 35는 정적 descriptor에서만 확인했다(raw/091). |
| setup snapshot·backend cache 재사용, CS280과 host 동일성 | unknown | 관측 출처가 없다. container ID는 CS280과 다르다. |
| Cloud main의 effort·provider | unknown | get_session은 model만 보고한다. |
| child credential 출처 | unknown | 원칙상 credential 파일을 읽지 않았다. |
| child session_id가 Cloud main과 같은 원인 | 추론 | 상속된 env가 원인이라고 추정할 뿐, 검증하지 않았다. |
| generated-actual.tsv와 private expectation의 대조 | NOT_RUN | 로컬 담당이 수행한다. |
| raw/incident-023/*(seq 23에서 repo cwd에 생긴 Claude 설정 3개) | 비공개 | org policy와 remote settings 내용이다. sha256은 raw/024 stdout에 있다. |
| 격리 config `.claude.json`, plugin data SQLite, broker key·token | 비공개 | 상태 파일과 비밀이다. |
| 리터럴 비밀 목록 | 비공개(삭제) | 잔여 검사에만 쓰고 삭제했다. |
| 이전 로컬 commit `a7a63c2`(prep/claude-b28a-1, parent e352b53d) | push 안 함 | 이번 이송(parent 023097df)으로 대체했다. |
