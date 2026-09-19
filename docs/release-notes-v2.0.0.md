# v2.0.0 — 호스트 공용 세션 현황판

## 핵심 변경

- 세션 현황판을 Claude Code와 Codex가 함께 씁니다. 두 호스트가 사용자 상태 디렉터리의 같은 파일(Windows `%LOCALAPPDATA%\agent-governance-suite\session-board.sqlite3`, macOS `~/Library/Application Support/agent-governance-suite/session-board.sqlite3`, 그 밖에는 `$XDG_STATE_HOME/agent-governance-suite/session-board.sqlite3` 또는 `~/.local/state/agent-governance-suite/session-board.sqlite3`)을 읽고 씁니다.
- `list_session_status`는 모든 호스트의 세션을 `host`와 함께 보여 줍니다. Claude Code 세션은 Codex 세션의 한 줄을, Codex 세션은 Claude Code 세션의 한 줄을 봅니다.
- 요청마다 한 번 거부하는 게이트, 훅의 세션 결속, 한 줄 규칙은 호스트마다 그대로입니다. 요청 기준은 호스트와 세션 ID별로 따로 계산합니다.
- 구조는 그대로입니다. 규칙과 저장은 스킬의 저장소 모듈(`skills/session-board/scripts/board-store.mjs`)이 맡고, 훅과 MCP 도구는 그 모듈을 부르는 인터페이스입니다.
- major 버전인 이유: Claude 상태 일부가 플러그인 데이터 디렉터리(`${CLAUDE_PLUGIN_DATA}`) 밖으로 나가고 호스트 사이에 정보가 보이게 되어 신뢰 경계가 바뀝니다. `AGENTS.md`의 "Claude 상태 DB는 `${CLAUDE_PLUGIN_DATA}` 아래에만 둔다" 규칙에 현황판 예외를 적었습니다.

## 호환성

- MCP 도구 22개의 이름·입력 schema·오류 코드는 바뀌지 않았습니다. `update_session_status`와 `list_session_status`의 설명만 공용 현황판에 맞게 고쳤습니다.
- `workflows.sqlite3`와 `continuity.sqlite3`의 위치와 내용은 바뀌지 않았고 호스트별로 따로 있습니다.
- Claude Code: 현황판이 `${CLAUDE_PLUGIN_DATA}/session-board.sqlite3`에서 공용 경로로 옮겨졌습니다. 매니페스트의 `AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH` 설정을 지웠고, 훅 launcher는 더 이상 `CLAUDE_PLUGIN_DATA`를 쓰지 않습니다.
- Codex: 기본 위치는 v1.21.0과 같습니다. 다만 `AGENT_GOVERNANCE_DB_PATH`로 workflow DB를 옮긴 경우에도 현황판은 공용 경로에 남습니다.
- `AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH`를 지정하면 그 파일을 씁니다. 두 호스트가 함께 보려면 양쪽에 같은 값을 주거나 둘 다 비워 둡니다.
- v1.21.0의 Claude 현황판 파일은 옮기지 않습니다. 행은 24시간 뒤 사라지는 정보라 설치 뒤 각 세션이 새로 적으면 됩니다. 남은 파일은 지워도 됩니다.

## 알려진 제한

- Codex에서는 여전히 실행해 확인하지 않았습니다. v1.21.0의 Codex 제한(도구 이름 후보, `deny`·`updatedInput` 지원, MCP 도구 이름 형식, 세션당 한 번 강제)이 그대로입니다. 공용 파일에 쓰고 읽는 부분은 아래처럼 Codex 없이 확인했습니다.
- 같은 OS 사용자로 실행되는 로컬 프로세스는 현황판 파일을 읽을 수 있습니다. 한 줄에 비밀이나 개인정보를 적지 않습니다.
- 이 플러그인의 MCP 도구 호출은 게이트하지 않습니다(v1.21.0과 같음).
- 훅이 없는 실행기(예: 별도 워크플로 엔진)가 현황판에 쓰는 CLI는 넣지 않았습니다.

## 검증

- 구현 후보에서 `bundle:check`, `claude:drift`, `lint`, `build`, `test`(372건 통과), `runtime:check`, `validate:all`, `validate:official`, `claude:check`가 모두 종료 코드 0이었습니다.
- 새 테스트가 확인하는 것:
  - override가 없으면 현황판 경로가 `AGENT_GOVERNANCE_DB_PATH`와 무관하게 사용자 상태 디렉터리를 가리키고, override는 그대로 우선한다.
  - Claude launcher(`claude-plugin/hooks/session-board-hook.mjs`)와 Codex 훅 번들을 따로 실행해도 같은 파일에 쓰고, `CLAUDE_PLUGIN_DATA` 아래에는 파일을 만들지 않으며, 목록이 두 호스트의 행을 함께 보여 준다.
  - Claude 매니페스트에 현황판 경로 설정이 없다.
- 실제 Claude Code 헤드리스 세션(Opus 5, 후보 플러그인)과 Codex 설정으로 띄운 MCP 서버로 교차 확인했습니다.
  - Codex 훅 번들로 기록한 행을 Claude Code 세션이 `list_session_status`로 읽어 `codex` 호스트의 한 줄을 그대로 보고했습니다.
  - Claude 관련 환경 없이 Codex처럼 띄운 MCP 서버의 목록에 그 Claude Code 세션의 행과 Codex 행이 함께 나왔습니다.
