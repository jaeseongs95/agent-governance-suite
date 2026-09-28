## MCP 도구 사용 계약

MCP를 사용할 때는 연결이 성공했고 도구 목록과 입력 스키마를 실제로 읽을 수 있는 경우에만 호출한다. 도구 이름, 입력 필드, 권한 범위, 대상 식별자를 추측하지 않는다.

통합 실행은 다음 순서를 지킨다.

1. 목표, 범위, 수용 기준, 작업 단위, 위험도와 필요한 capability를 `TaskEnvelope.v1`로 정리하고 `plan_workflow`를 호출한다. 이 호출은 run을 만들지 않는다. `scope`와 `workUnits[].writeTargets`에는 저장소 기준 파일 경로나 glob만 적고, 브랜치·태그·원격 같은 git 대상은 `authorization.allowedActions`와 `mutation-risk-preflight` capability의 대상으로 다룬다.
2. 최초 전체 실행 전에 `open_convergence_root`를 `responseMode: "compact"`로 호출해 작업 계약과 control/target frame을 결속한다. 같은 작업을 요약하거나 fresh context에 넘겨도 발급된 `rootId`를 유지한다. 시작한 run의 계약을 바꿔 다시 시도하면 수렴 가드의 frame 검토(`FRAME_REVIEW_REQUIRED`)와 사용자 승인을 거친다.
3. 계획이 `ready`이고 `executionMode`가 `orchestrated`이면 `claim_workflow_attempt`에서 이미 root에 결속된 `taskEnvelope`와 `frame`을 다시 보내지 않고 계획·실행자·출력 대상에 결속된 lease를 받는다. 이어 `start_guarded_workflow`를 plan 없이 `responseMode: "compact"`로 호출한다. 새 orchestrated run에 `start_workflow`를 사용하지 않는다.
4. 계획에 기록된 순서대로 각 stage의 전문 스킬을 설치된 스킬 호출 방식으로 실제 실행한다. 계획, 문서 로드나 도구 호출 수락을 스킬 실행이나 `passed`로 기록하지 않는다. provider 결과와 산출물 참조를 `ProviderResult.v1`로 묶고, 이를 `StageResult.v1.output`에 넣어 현재 revision과 `responseMode: "compact"`로 `record_stage_result`에 전달한다.
5. 사용자 입력이나 승인이 필요하면 해당 상태와 차단 사유를 그대로 보고하고 새 실행이 필요한지 판단한다. 순서를 건너뛰거나 이미 기록한 stage를 덮어쓰지 않는다.
6. 필요할 때 `get_workflow_status`와 `get_convergence_status`를 `detail: "compact"`로 호출해 현재 revision, 다음 stage와 남은 실행 예산을 확인한다. compact 결과에 오류 코드나 0보다 큰 blocker·unresolved 수가 있거나 과거 원자료가 필요한 경우에만 해당 status를 `detail: "full"`로 한 번 다시 조회한다. 모든 필수 stage와 감사 게이트가 `passed`인 경우에만 `finalize_workflow`를 `responseMode: "compact"`로 호출한다.
7. 통합 실행을 더 진행하지 않기로 확정하면 `abort_workflow`를 `responseMode: "compact"`로 호출해 해당 run을 닫는다. 시작된 run은 실패·중단돼도 해당 epoch의 시도 횟수에 남는다.

### stage 기록과 큰 출력

- `record_stage_result` 전에 계획된 stage의 `requiredArtifacts`에 있는 id를 모두 `output.artifacts`에 넣는다. 각 항목에는 실제 산출물의 locator, digest, targetDigest를 적고 `verified: true`로 표시한다. digest는 64자리 소문자 hex이며 `sha256:` 접두사는 있어도 없어도 된다.
- 실제로 만들지 않았거나 확인하지 않은 산출물은 `verified: true`로 적지 않는다. 그 stage는 `passed`로 기록하지 않고, provider 결과(verdict나 `MISSING_EVIDENCE` adapter error)가 가리키는 `needs-input`이나 `blocked` 상태로 기록한다.
- provider 출력(`output.output`)이 저장소 크기에 비례해 커지면(예: 변경 범위 baseline·보고서, 저장소 관례 조사) 도구 인자에 넣지 않는다. 스킬이 만든 JSON을 바꾸지 않고 로컬 파일에 저장한 뒤 `outputFile: { "locator": "<절대 경로>", "digest": "sha256:<그 파일 바이트의 SHA-256>" }`를 넣고 `output.output`은 `null`로 보낸다. 서버는 파일을 읽어 digest, 출력 schema와 gate를 인라인 출력과 똑같이 검사하고 receipt에는 참조만 남긴다.
- 크기를 맞추려고 항목을 줄이거나 요약하지 않는다. digest가 맞지 않으면 `INTEGRITY_FAILED`다. receipt 정책이 있는 stage(한국어 산문, 평가 타당성)는 `outputFile`을 받지 않으므로 참조 전용 출력을 인라인으로 기록한다.

MCP workflow run과 계획 서명 키는 SQLite에 저장되므로 프로세스를 다시 시작해도 이어서 처리할 수 있다. `RUN_NOT_FOUND`를 받으면 다른 데이터베이스 경로를 사용 중인지 먼저 확인하고, 저장된 상태가 실제로 없을 때만 새 계획과 run을 만든다. 이전 revision이나 stage 결과를 추측해 복구하지 않는다.

MCP 응답에 별도의 `plugin-update-notice` content block이 있으면 현재 버전과 최신 버전, 제공된 tag URL을 사용자에게 한 문장으로 안내한다. `automaticInstall: false`도 함께 밝혀 업데이트가 설치됐다고 오해하지 않게 한다. 이 알림을 이유로 현재 workflow 결과를 바꾸거나 설치, 파일 수정, 마켓플레이스 갱신을 실행하지 않는다.

- 선택한 MCP 도구가 필요한 작업만 수행하는지와 사용자가 부여한 권한 안인지 확인한다.
- 필요한 최소 입력만 전달하고, 비밀값·개인정보·확인되지 않은 사실을 도구 입력에 새로 넣지 않는다.
- 도구 응답의 구조화된 결과, 오류, 외부 상태 식별자와 관측 시각을 다음 단계에 전달한다. 도구 호출이 수락됐다는 사실만으로 작업 성공을 선언하지 않는다.
- 도구가 실패하거나 결과를 관측할 수 없으면 실패 원인과 영향을 받은 단계만 멈춘다. 다른 전문 스킬이 독립적으로 완료할 수 있는 부분은 계속할 수 있다.

MCP 연결이나 필요한 MCP 도구를 사용할 수 없더라도, 설치된 전문 스킬을 직접 호출해 처리할 수 있는 요청은 진행한다. MCP 없이는 필요한 통합 작업 자체를 수행할 수 없는 경우에만 통합 결과를 `BLOCKED`로 표시하고, 직접 사용할 수 있는 스킬과 필요한 MCP 기능을 함께 밝힌다.

MCP 미지원과 신뢰할 수 있는 실행 관측 부재는 다른 실패다. MCP가 `BINDING_REQUIRED`나 `BINDING_INVALID`를 반환하면 해당 guarded workflow를 시작하지 않고, 이미 시작한 run의 stage를 `passed`로 진행하지 않는다. 관측값이나 실행 하한을 추정·보정해 다시 보내지 않는다. 설치된 전문 스킬로 독립 처리할 수 있는 허용 부분만 진행하고, 그 결과를 필수 guarded 통합이나 감사 증거로 표현하지 않는다. 통합 실행을 더 진행하지 않으면 시작한 run은 `abort_workflow`로 닫고 반환 코드와 영향받은 완료 판정을 사용자에게 밝힌다.

실행 하한 미달이 확인된 semantic stage는 그 하한을 충족하는 실행자가 전문 작업을 실제로 다시 수행한 뒤 새 관측으로 기록한다. token이나 관측의 만료가 확인된 경우에는 호스트가 현재 호출을 다시 관측해 새 token을 제공하는 정상 호출 경로로 재시도할 수 있다. 이때도 현재 task·run·stage·revision 결속, 신선도, 한 번 소비와 기존 수렴 가드를 그대로 적용한다. `BINDING_INVALID` 코드나 승인 대기 시간만으로 원인을 만료로 단정하거나 같은 token을 재전송하지 않는다. 원인이 확인되지 않으면 영향을 받은 경계를 멈추고 진단 근거와 필요한 관측을 남긴다.
