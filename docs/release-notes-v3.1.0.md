# AGS 3.1.0 릴리스 노트

3.1.0은 workflow 없이 여러 제품 파일을 바꾸는 작업을 실제로 막는다. 긴 Claude 세션에서 workflow를 시작할 수 없던 결함도 고친다. 계약·DB 스키마는 바뀌지 않았다. MCP 도구 목록도 같고, `start_workflow`의 동작만 바뀌었다. 3.0.x를 쓰는 호스트는 3.1.0으로 바꾸고 AGS 프로세스를 다시 시작한다.

## 바뀐 점

### workflow 강제

- workflow 없이 한 구간에서 서로 다른 제품 파일 3개째를 편집하면 그 편집 도구 호출을 거부한다(PreToolUse deny). 이미 센 파일을 다시 고치는 것은 허용한다. 거부한 뒤에는 workflow를 시작할 때까지 제품 파일 편집을 막는다.
- 구간은 마지막 단계 확인(Stop)이나 마지막 workflow 시작 뒤부터 센다. abandoned root와 끝난 run은 workflow 없음으로 본다.
- 세는 도구: Claude `Edit`·`Write`·`MultiEdit`·`NotebookEdit`, Codex `apply_patch`(패치 안의 모든 파일), Antigravity의 편집 도구(`write_file`·`edit_file`·`write_to_file`·`replace_file_content`·`multi_replace_file_content`). Claude와 Codex의 subagent 편집은 부모 세션 구간에 더한다.
- 세지 않는 경로: OS 임시 폴더, 호스트 메모 폴더(Claude `projects/*/memory`, agy `brain`), `AGENT_GOVERNANCE_PHASE_EXEMPT_PATHS`에 적은 절대 경로.
- 거부 문구에는 이번 경로, 앞서 센 파일 수, 최소 시작 호출 예가 들어간다.
- 거부 전용이던 `start_workflow`가 최소 시작으로 바뀌었다. `goal`·`stages`·`acceptanceCriteria`만 넣으면 계획·root·attempt·run 시작을 한 번에 처리한다. 나머지는 기본값으로 채우고 `defaultsUsed`에 적는다. `workspace`를 생략하면 세션 현황판에 기록된 작업 폴더를 쓴다. 거부 뒤에 시작하면 「사후 편입·근거 미검증」으로 표시한다.
- Stop 단계 확인은 진행 중인 workflow에 통과하지 않은 단계가 있을 때만 한 번 알린다. 3.0.2의 「workflow 없이 변경함」과 「필요 없으면 이유를 한 줄로 밝히고 끝내라」 문구는 없앴다. Codex는 `stop_hook_active`가 true면 출력하지 않는다.
- AGS 인프라 오류(저장소를 열지 못함, 시작 호출의 `BINDING_REQUIRED` 등)는 원인 코드를 보이고 그 구간의 편집을 막지 않는다. Claude governance hook이 시작 호출을 거부한 경우도 같다. 입력 오류(`INVALID_INPUT`, `ROOT_CONFLICT` 등)는 통과 사유가 아니다.
- 접수 기준(`skills/orchestrator/SKILL.md`)에 최소 시작과 3개째 거부를 적었다.

### 긴 Claude transcript

- 3.0.x의 governance hook은 transcript가 8MB를 넘으면 `plan_workflow`·`record_stage_result`를 거부했고, 원인을 `GOVERNANCE_HOOK_FAILED`로 덮었다. 긴 세션에서는 workflow를 시작할 수 없었다.
- 이제 크기와 상관없이 1MiB 창으로 읽고, 호출한 메시지는 끝에서부터 찾는다. 한 줄이 8MiB를 넘을 때만 `TRANSCRIPT_LINE_LIMIT_EXCEEDED`로 거부한다.
- governance hook 거부 사유에 실제 원인 코드가 나온다. 세션 현황판 hook과 실행 관측 hook의 오류 분류도 원인별로 나눴다.

### 설치 문서

- `agy`에는 `plugin marketplace` 명령이 없고 `plugin install`은 로컬 디렉터리만 받는다. README의 Antigravity 설치 절차를 「릴리스 태그를 clone한 뒤 그 디렉터리를 설치」로 고쳤다.

### 시험

- 로그 회전 시험이 경과 시간 대신 실제 파일 번호가 늘어나는 것을 기다리게 했다. Windows CI에서 회전이 느릴 때 가끔 실패하던 문제다.

## 업그레이드 시 확인할 것

- Codex는 `/hooks`에서 AGS hook을 다시 검토하고 신뢰해야 거부가 동작한다.
- 다단계 작업을 하던 세션은 3개째 파일에서 거부될 수 있다. 거부 문구의 예처럼 `start_workflow`로 시작하면 된다.

## 알려진 제한

- Antigravity(agy 1.4.12)는 호출 정보에 모델을 싣지 않는다. 그래서 신뢰 실행 관측이 필요한 workflow 시작(`plan_workflow`·`start_workflow`)이 `BINDING_REQUIRED`(`ANTIGRAVITY_EXECUTION_UNOBSERVED`)로 실패한다. 3.0.2부터 같은 상태다. agy에서는 3개째 거부 뒤 시작이 인프라 실패로 처리되어 편집이 다시 허용되므로, 강제가 한 번의 거부에 그친다. 3.1.1에서 고친다.
- 셸(`Bash`·`PowerShell`·`run_command`)로 바꾼 파일은 세지 않는다.
- 구간은 turn마다 다시 센다. 한 turn에 2개씩 나눠 고치면 거부되지 않는다.
- agy runner의 실행 관측 단계가 시작 호출을 거부하는 경우는 아직 통과 처리를 하지 않는다.

## 검증

- 검증 결과는 발행 직전에 채운다.
