# Claude native T2·T4 절차 경계 수리

기준은 `7652c71037c07c4744b9d8f37f0a327d454d8c53`이다. 독립 검토보고서 `v380-claude-native-pilot-review.ko.md`를 먼저 읽고, 명시 허용된 TEST pilot의 `turn-2.jsonl`·`turn-4.jsonl` 중 해당 사건만 읽었다. 다른 턴·세션·인증·전역 설정은 열지 않았다.

- T2 원자료 SHA256 `c9447ce566dc831dda20b3441b37413ec7cdd4b280399a6c2d11ea43a581c4fe`: L74의 INVALID_INPUT exit2는 실제 assertion RED와 구분한다. L78의 RED exit1→GREEN exit0 뒤 L103에서 plan.json을 작성했고 L104의 READY/CONSISTENT는 사후 정합성만 보여 준다. 원 계획 선작성 실패는 유지한다.
- T4 원자료 SHA256 `5556fb469bfcf0f54fb2b7631df2bc001a37d29610669995db9f261fb8098f6a`: L11에서 외부 workflow 상태 쓰기까지 금지하는 entry-details를 읽은 뒤 L26~27 checkpoint_context가 revision3→4로 실제 상태를 썼다. 원 절차 FAIL은 유지한다.
- 소스 원인: 공통 intake와 checkpoint 도구 설명은 기록 호출을 조건 없이 요구하지만 blocker의 읽기 전용 계약은 이를 금지한다. test-engineering은 계획 작성 순서가 있으나 저장·사전 검사 시점이 불명확하고, 공통 CLI 목록은 run을 check-plan보다 먼저 제시하며 root-relative 파일 참조를 명확히 구별하지 않는다. 모델 내부 선택의 인과관계는 미확인이다.
- 연결: D31 실제 소비 진입점 확인, D32 단일 공통 intake와 기존 5,229자 cap, D36 사례 선작성, D38 도메인·호스트 독립, 기존 task의 읽기 전용/허용 실행 환경/권한을 유지한다. 새 감시·도구·registry·모델 호출은 추가하지 않는다.

| 사례 | 공개 경계·입력·전제 | 절차 | 기대 결과·판정 | 실제 |
| --- | --- | --- | --- | --- |
| NP01 | `skillIntakeText`와 MCP `serverInstructions`, ko/en; 읽기 전용 또는 상태 쓰기 금지 요청 | 실제 공통 intake 전달문과 blocker 계약을 대조 | checkpoint는 읽기 전용·상태 쓰기 금지가 아닐 때만 요구. 기존 허용 저장 조건과 원 금지는 유지 | NOT_RUN |
| NP02 | MCP `tools/list`의 checkpoint_context, ko/en | 실제 서버의 공개 도구 설명을 조회 | 각 locale 설명도 읽기 전용·상태 쓰기 금지를 우선하며 다른 schema/도구 정책을 변경하지 않음 | NOT_RUN |
| NP03 | native가 읽는 test-engineering SKILL 본문·공통 CLI 안내 | 계획 저장·check-plan이 테스트 구현·실행보다 먼저 명시되는지 확인 | 사후 READY/CONSISTENT가 선작성 근거가 되지 않음. `--root` 절대경로와 그 아래 상대 파일 참조를 구분 | NOT_RUN |
| NP04 | 기존 source classification, content lock, frozen successor chain | 공식 pin 갱신 또는 append successor로 현재 바이트를 결속하고 원 역사 파일은 비교 | D32 cap≤5229, 과거 원본 hash 불변, 현재 source hash·선택 span의 의도한 변경만 추적 | NOT_RUN |
| NP05 | 별도 TEST native T2/T4 재실행, root가 정한 동일 조건 | 실제 도구 순서와 상태 쓰기 유무를 관찰 | 계획이 RED/GREEN보다 앞서며 읽기 전용 진단에서 checkpoint 호출 0. 원 pilot FAIL은 덮지 않음 | NOT_RUN |

NP01~04는 전달문·계약 검사이며 실제 모델 행동 성공을 뜻하지 않는다. NP05는 root와 조율한 TEST에서만 실행한다. 로컬 제품 시험은 금지된다. 원자료 읽기 조회 `9a24c89a55a6b7bbcad9f8c055492bc3f66081f36d7c13d7` 및 좁은 사건 추출 `e9107acd2b39c73b3256a6dae8133c5697f79400e9b926a1`은 exit0/cleanupComplete:true로 끝났다.
