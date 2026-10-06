
## CS Engineering 연결 (AGS 2.8.0 후보)

정확성에 관련 CS 조건이 필요한 동작 변경이면 `cs-constraint-derivation`을 bootstrap 25에서
선택하고, 핵심 5분야20규칙과 추가 draft5분야를 구분한다. 실제 관련 분야만 로딩한다.
[2.x 인계·리뷰 계약](../../cs-engineering/references/ags-2x-integration.md)을 읽고
READY 조건을 task-contract에 전달해 사용자 요구·수용 기준·검증 계획의 출처로 기록한다.
TaskEnvelope.v1을 바꾸지 않고 최종 task digest로 binding을 만든다.

`handoff`로 동결 입력을 재검사하고 같은 reference/digest와 required obligation ID를
ponytail의 구현 지시로 넘긴다. 수신자는 원자료 접근과 조건 수신을 확인한다. 기존
ponytail inputBindings는 유지되며 모든 구현의 자동 인계 증명으로 표현하지 않는다.

리뷰 capability만 workflow에 요청한다. 선택된 phase67의 MCP stage는
`cs-review-bundle`과 `cs-review-report` artifact를 받아 CLI로 task·후보·조건·원시
파일을 기록 시와 finalize 시 재검사한다. FAIL·BLOCKED를 PASS로 바꾸지 않는다.
같은 의무 ID와 실제 원시 근거를 기존 수용 근거 검증에 연결하고 보안·독립 감사 책임을 유지한다.

계획·lease·start·resume 전체 binding과 전역 적용성·acceptance 강제 정책은 미구현이다.
unknown field를 삭제해 약한 경로로 재시도하지 않는다. 직접 CLI 결과와 선택된
MCP stage 검증·실호스트 자동 선택·독립 감사를 각각 구분한다.
