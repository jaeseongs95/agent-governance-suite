
## AGS Engineering Practices v0.1.0

테스트 작성·보강 요청이면 test-engineering을 선택한다. 같은 테스트가 실제 결함에서 실패하는지 확인할 때는 test-sensitivity-review를, prepared test plan의 계약 검사에는 test-plan-validation을 선택한다. 고정된 diff·patch·PR 리뷰에는 code-review/change-code-review를 선택한다. 단순 문구 수정·설명이나 순수 제품 구현에 두 검증 단계를 일률적으로 추가하지 않는다. 입력 자료는 새 스킬의 SKILL.md와 integration descriptor로 확인한다.

작업 조건에 맞는 [Engineering Practices index](engineering-practices/index.md)의 모듈만 읽어 기존 담당자에게 근거와 함께 전달한다. 실패 판별은 blocker-diagnostician/debugging, 구현 단순화는 ponytail/implementation, 의존성·에이전트 확장 변경은 software-security-auditor/dependency, 완료 근거 대조는 acceptance-evidence-validator/verification, 스킬 작성은 agent-instructions로 연결한다. 기존 전문 스킬을 직접 호출한 경로에서는 필요한 참조도 명시한다.

기존 cs-engineering 보고서가 있으면 불변조건·검증 의무 ID를 참조하고 새 규칙으로 교체하지 않는다. 새 권한·PEER·세션 배분·감사 정책은 만들지 않는다. prepared artifacts를 CLI에서 검증한 결과와 원시 근거를 기존 수용/감사 단계에 전달한다. 선택됨·참조 읽음·실행됨·검증됨을 별도로 기록한다. registry 등록과 로컬 CONSISTENT만으로 실제 호스트 활성화나 독립 감사 PASS를 주장하지 않는다.
