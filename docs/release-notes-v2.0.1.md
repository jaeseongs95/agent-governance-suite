# v2.0.1 — Codex 요청 경계 추적

## 핵심 변경

- Codex 세션 현황판 훅에 `UserPromptSubmit` 이벤트를 추가했습니다. 같은 세션에서 새 사용자 요청이 들어오면 `lastPromptAt`이 즉시 갱신되어, 다음 변경 명령 전에 `update_session_status`를 다시 호출해야 하는 요청 경계를 정확히 구분합니다.
- Codex 데스크톱에서 신뢰한 훅으로 `exec_command` 거부, `update_session_status`의 `_sessionBinding` 주입, Claude Code와 Codex의 공용 현황판 조회를 실검증했습니다.
- 현황판은 계속 상태 공유용입니다. 다른 세션을 실시간으로 깨우거나 실행 중인 턴에 메시지를 밀어 넣지는 않습니다.

## 호환성

- MCP 도구 22개의 이름, 입력 schema, 오류 코드와 SQLite schema는 바뀌지 않았습니다.
- 훅 명령과 번들 파일 내용은 v2.0.0의 Codex 훅 보완 이후와 같습니다. 기존에 현재 훅 정의를 신뢰한 설치에서는 버전 번호만으로 새 훅 권한을 요구하지 않습니다.
- Claude Code 배포물에는 동작 변경이 없습니다. 공용 버전과 MCP 서버 버전만 `2.0.1`로 맞춥니다.

## 검증

- Codex 훅 설정에 `UserPromptSubmit`이 정확히 한 번 있고 세션 현황판 번들을 가리키는지 회귀 테스트로 확인합니다.
- 전체 저장소 검증, Claude 생성물 일치 검사와 `node_modules` 없는 설치 형태의 런타임 검사를 수행합니다.
