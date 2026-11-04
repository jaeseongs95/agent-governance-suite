# AGS 3.5.2 릴리스 노트

3.5.2는 실제 사용에서 드러난 행동 결함 세 가지를 고친다. 사용자 원문은 「3.5.1 발행하고 3.5.2 개선 진행해.」이다. 항목별 원문은 아래에 있다.

호환성: 공개 도구 계약, 오류 code, DB schema 버전은 바뀌지 않는다. 세션 메시지 wake 계약은 바뀐다(아래 「빈 wake」).

## 백업할 수 없는 사용자 상태를 덮어쓸 때 묻기

### 원인

Codex가 한글 입력 시험에서 클립보드를 백업할 수 없게 되었다. 그러자 사용자에게 덮어써도 되는지 묻지 않고 시험 도구를 만들어 우회했다. 사용자는 「걍 클립보드 써도 되는지 나한테 물어보면 되는거아냐?」라고 했다. `mutation-risk-preflight` 본문은 복구 근거가 부족할 때 그것을 승인으로 대신하지 말라고만 했다. 복구가 원래 불가능할 때 사용자에게 손실 수용을 묻는 경로(`irreversibilityAccepted`)는 참고 문서(`references/recovery-requirements.md`)에만 있었다.

### 바뀐 점

- `skills/mutation-risk-preflight/SKILL.md`에 한 경우를 넣었다. 사용자의 현재 상태(클립보드, 열린 문서, 설정 값 등)를 백업할 수 없는데 덮어써야 한다고 하자. 그러면 백업 도구나 우회 시험을 만들지 않는다. 무엇을 잃는지 적어 사용자에게 바로 묻고, 사용자가 받아들이면 `irreversibilityAccepted`로 진행한다.
- 분류 결속: 본문 바이트가 바뀌어 `skills/mutation-risk-preflight/classification.json`의 span digest와 위치를 다시 계산했다. 새 바이트는 r20 후속본(`tests/skill-classification/fixtures.mutation-risk-preflight-overwrite-ask-source-successor.json`)으로 이었다. `skills/source-lock.json`의 통합 checksum도 바뀌었다.

## 빈 wake

사용자 원문: 「근데 빈 wake는 아직도 발생하는거같거든?」「저거 참고로 codex야.」「걍 세션이 살아있으면 에이전트에서 wake를 보내도 mcp에서 막아주면 되지 않을까?」→「3.5.2 에 같이 넣자.」

### 원인

wake 관문은 최근 60초(`WAKE_QUIET_MS`) 안에 도구 경계 claim이 있을 때만 그 세션을 바쁘다고 봤다. 세션이 60초 넘게 걸리는 명령을 실행하는 동안 메시지가 오면, relay는 wake를 호스트 대기열로 보냈다. 같은 턴의 다음 도구 경계가 본문을 먼저 받아 갔고, 대기열의 wake는 그 턴이 끝난 뒤 빈 채로 도착했다. 호스트 대기열로 넘어간 wake는 취소할 수 없다.

### 바뀐 점

- broker가 세션의 턴이 열려 있는 동안에도 wake를 보내지 않는다(`mcp-server/src/session-message-store.ts`의 `wakePathOpen`).
  - 턴이 열리는 때: 사용자 프롬프트 관측(`observeNativeInput`)과 인식된 wake(`claimHostWake`).
  - 턴이 닫히는 때: 턴 끝(`claimTurnEnd`, `clearDeferred`).
  - 턴이 닫힌 뒤 남은 미인수 메시지에만 wake를 보낸다.
- 호스트 이름 분기는 없다. 프롬프트나 턴 끝을 알리지 않는 호스트는 턴이 열리지 않으므로 전과 같이 동작한다.
- `get_session_message_status`의 수신자 전망은 턴이 열려 있으면 `recipient-active`를 낸다.

### wake 계약 변경

- 인식된 wake도 턴을 연다. 따라서 woken 턴이 끝나야(턴 끝 hook) 다음 wake가 나간다. 이전에는 woken 턴이 끝나지 않아도 60초가 지나면 다음 wake가 나갈 수 있었다.
- 같은 세션의 미인수 claim lease가 남아 있으면 그동안 wake를 보내지 않는 기존 관문은 그대로다.

### 남은 한계

- 턴 끝 hook이 돌지 않고 끝난 턴(사용자 중단 등)은 열린 채 남는다. 그 동안 온 메시지는 가장 오래된 본문이 `WAKE_QUIET_MAX_MS`(10분)를 기다린 뒤에 wake된다. 상한은 바꾸지 않았다.

## 설계 전제를 추측하지 않고 묻기

사용자 원문: 「대체 codex는 왜이런걸까? … 이것도 AGS로 행동교정이 될까?」→「저것도 3.5.2에 넣어줘.」

### 원인

Codex 세션이 원격 Windows 시험 서버에 「GUI shell」을 붙이는 작업을 받았다. 그 GUI shell의 사용 주체는 에이전트였다. 그런데 Codex는 사람이 쓰고 포털에서 인증한다고 가정했다. 그 가정 위에 인증 화면과 정책 변경을 만들었고, 한 번도 묻지 않았다. 공통 접수 블록에는 확인되지 않은 설계 전제를 다루는 문장이 없었다.

### 바뀐 점

- 방향은 independent-deliberation-panel 토론(reviewer 3명, 조건부 합의)으로 정했다. 공통 접수 블록(`skills/orchestrator/SKILL.md`)에 한 문장을 넣었다(원문은 그 파일에만 둔다). 산출물의 사용 주체·목적·인증과 권한 경계·실행 환경에 대한 전제가 요청과 근거로 정해지지 않았다고 하자. 그리고 그 값이 반대면 구조가 달라진다고 하자. 그러면 그 전제 위에 처음 쓰기 전에 한 번에 묻는다. 되돌릴 수 있는 구현 선택, 관례로 정해지는 값, 이미 답한 사항은 묻지 않는다.
- MCP 서버 instructions와 세션 시작 hook이 같은 블록을 쓰므로 Claude Code·Codex·agy가 모두 받는다.
- 하지 않은 것: TaskEnvelope·`start_workflow` schema에 전제 칸 추가, 서버 차단, `task-contract` 강제 경유. 토론에서 문장만으로 막지 못하는 호스트가 실호스트 시험에서 확인되면 `start_workflow`·`plan_workflow` 도구 설명에 같은 확인을 넣기로 했다(아래 검증 결과 참조).
- 분류 결속: 접수 블록 바이트가 바뀌어 `skills/orchestrator/classification.json`의 digest와 `applicability[5]` 끝 위치를 다시 계산했다. 새 바이트는 r21 후속본(`tests/skill-classification/fixtures.orchestrator-intake-premise-ask-source-successor.json`)으로 이었다. 문맥 검사(`scripts/check-skill-context-optimization.mjs`)는 후속본 사슬을 따라 기존 고정값의 바이트까지 투영한다.

## 미룬 것

- 시험 속도 개선(3.5.1에서 미룬 것)은 계속 후속 과제다.
- Codex에서 AGS MCP 도구가 보이지 않은 경우(클립보드 3차 시험 6회 중 1회)는 조사 후보로 남긴다.
- DBMS 전환은 3.6.0이다.

## 검증
