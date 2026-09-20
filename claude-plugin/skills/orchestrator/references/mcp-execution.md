## MCP 도구 사용 계약

MCP를 사용할 때는 연결이 성공했고 도구 목록과 입력 스키마를 실제로 읽을 수 있는 경우에만 호출한다. 도구 이름, 입력 필드, 권한 범위, 대상 식별자를 추측하지 않는다.

통합 실행은 다음 순서를 지킨다.

1. 목표, 범위, 수용 기준, 작업 단위, 위험도와 필요한 capability를 `TaskEnvelope.v1`로 정리하고 `plan_workflow`를 호출한다. 이 호출은 run을 만들지 않는다.
2. 최초 전체 실행 전에 `open_convergence_root`를 `responseMode: "compact"`로 호출해 작업 계약과 control/target frame을 결속한다. 같은 작업을 요약하거나 fresh context에 넘겨도 발급된 `rootId`를 유지한다.
3. 계획이 `ready`이고 `executionMode`가 `orchestrated`이면 `claim_workflow_attempt`에서 이미 root에 결속된 `taskEnvelope`와 `frame`을 다시 보내지 않고 계획·실행자·출력 대상에 결속된 lease를 받는다. 이어 `start_guarded_workflow`를 plan 없이 `responseMode: "compact"`로 호출한다. 새 orchestrated run에 `start_workflow`를 사용하지 않는다.
4. 계획에 기록된 순서대로 전문 스킬을 사용한다. provider 결과와 산출물 참조를 `ProviderResult.v1`로 묶고, 이를 `StageResult.v1.output`에 넣어 현재 revision과 `responseMode: "compact"`로 `record_stage_result`에 전달한다.
5. 사용자 입력이나 승인이 필요하면 해당 상태와 차단 사유를 그대로 보고하고 새 실행이 필요한지 판단한다. 순서를 건너뛰거나 이미 기록한 stage를 덮어쓰지 않는다.
6. 필요할 때 `get_workflow_status`와 `get_convergence_status`를 `detail: "compact"`로 호출해 현재 revision, 다음 stage와 남은 실행 예산을 확인한다. compact 결과에 오류 코드나 0보다 큰 blocker·unresolved 수가 있거나 과거 원자료가 필요한 경우에만 해당 status를 `detail: "full"`로 한 번 다시 조회한다. 모든 필수 stage와 감사 게이트가 `passed`인 경우에만 `finalize_workflow`를 `responseMode: "compact"`로 호출한다.
7. 통합 실행을 더 진행하지 않기로 확정하면 `abort_workflow`를 `responseMode: "compact"`로 호출해 해당 run을 닫는다. 시작된 run은 실패·중단돼도 해당 epoch의 시도 횟수에 남는다.

MCP workflow run과 계획 서명 키는 SQLite에 저장되므로 프로세스를 다시 시작해도 이어서 처리할 수 있다. `RUN_NOT_FOUND`를 받으면 다른 데이터베이스 경로를 사용 중인지 먼저 확인하고, 저장된 상태가 실제로 없을 때만 새 계획과 run을 만든다. 이전 revision이나 stage 결과를 추측해 복구하지 않는다.

MCP 응답에 별도의 `plugin-update-notice` content block이 있으면 현재 버전과 최신 버전, 제공된 tag URL을 사용자에게 한 문장으로 안내한다. `automaticInstall: false`도 함께 밝혀 업데이트가 설치됐다고 오해하지 않게 한다. 이 알림을 이유로 현재 workflow 결과를 바꾸거나 설치, 파일 수정, 마켓플레이스 갱신을 실행하지 않는다.

- 선택한 MCP 도구가 필요한 작업만 수행하는지와 사용자가 부여한 권한 안인지 확인한다.
- 필요한 최소 입력만 전달하고, 비밀값·개인정보·확인되지 않은 사실을 도구 입력에 새로 넣지 않는다.
- 도구 응답의 구조화된 결과, 오류, 외부 상태 식별자와 관측 시각을 다음 단계에 전달한다. 도구 호출이 수락됐다는 사실만으로 작업 성공을 선언하지 않는다.
- 도구가 실패하거나 결과를 관측할 수 없으면 실패 원인과 영향을 받은 단계만 멈춘다. 다른 전문 스킬이 독립적으로 완료할 수 있는 부분은 계속할 수 있다.

MCP 연결이나 필요한 MCP 도구를 사용할 수 없더라도, 설치된 전문 스킬을 직접 호출해 처리할 수 있는 요청은 진행한다. MCP 없이는 필요한 통합 작업 자체를 수행할 수 없는 경우에만 통합 결과를 `BLOCKED`로 표시하고, 직접 사용할 수 있는 스킬과 필요한 MCP 기능을 함께 밝힌다.
