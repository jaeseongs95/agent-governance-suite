# v1.21.0 — 세션 현황판

## 핵심 변경

- 새 인프라 스킬 `session-board`를 더했습니다. 같은 컴퓨터에서 동시에 일하는 세션들이 서로 무엇을 하는지 알고 부딪히지 않게 하는 로컬 현황판입니다. 세션마다 호스트, 세션 ID, 작업 디렉터리, 지금 하는 일 한 줄, 요약 시각, 마지막 요청 시각을 로컬 SQLite 파일(`session-board.sqlite3`)에 둡니다. 요청 원문은 저장하지 않습니다.
- 새 MCP 도구 2개를 더했습니다.
  - `update_session_status`는 지금 하는 일 한 줄을 적습니다. 플러그인 훅이 호스트의 세션 ID와 작업 디렉터리로 행을 기록하고, 서버는 기록된 행을 읽어 돌려줍니다. 훅이 거치지 않은 호출은 `BINDING_REQUIRED`입니다.
  - `list_session_status`는 최근 24시간 안에 활동한 세션을 보여 줍니다. 요약이 마지막 요청보다 오래됐으면 `stale`, 호출한 세션이면 `current`로 표시합니다.
- 한 줄 갱신은 필수입니다. 사용자 요청마다 처음 파일을 고치거나(Edit·Write·MultiEdit·NotebookEdit) 명령(Bash·PowerShell)이나 서브에이전트(Agent)를 실행하려 할 때 그 요청 뒤 요약이 없으면 훅이 한 번 거부하고 이유를 알립니다. 다음 시도는 허용하므로 현황판에 장애가 있어도 작업은 멈추지 않습니다. 연산자·리다이렉션이 없는 읽기 전용 단일 명령(`git status`·`git log`·`git diff`·`git show`·`git branch`, `ls`, `cat`, `pwd`, `rg`, `grep`)은 거부하지 않습니다. 서브에이전트 호출은 막지 않지만 서브에이전트가 부모 세션의 줄을 바꾸지는 못합니다. 훅의 모든 오류는 호출을 통과시킵니다. 강제 시점과 강도는 독립 숙고 패널(blind reviewer 3명과 fresh Judge)이 정했습니다.
- 구조: 규칙과 저장은 스킬의 저장소 모듈(`skills/session-board/scripts/board-store.mjs`)이 모두 맡고, 훅과 MCP 도구는 그 모듈을 부르는 인터페이스입니다.

## 호환성

- 기존 MCP 도구 20개의 이름·입력 schema·오류 코드와 기존 SQLite 파일(`workflows.sqlite3`, `continuity.sqlite3`)은 바뀌지 않았습니다. 도구 목록 끝에 2개가 더해져 22개입니다.
- 플러그인을 쓰는 세션은 사용자 요청마다 첫 변경 전에 도구 호출이 한 번 늘어납니다.
- Claude Code: 현황판은 `${CLAUDE_PLUGIN_DATA}/session-board.sqlite3`에 있고 MCP 서버에는 `AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH`로 전달합니다. UserPromptSubmit 훅과 PreToolUse 훅 두 묶음(게이트, 현황판 도구 결속)이 더해졌습니다.
- Codex: 현황판은 workflow DB 옆 `session-board.sqlite3`입니다. SessionStart 훅과 PreToolUse 훅 두 묶음이 더해졌으며, 처음 설치하거나 훅 정의가 바뀌면 `/hooks`에서 신뢰해야 실행됩니다.
- 현황판은 호스트마다 따로 있어 Claude Code 세션은 Claude Code 세션만, Codex 세션은 Codex 세션만 봅니다.

## 알려진 제한

- Codex에서는 실행해 확인하지 않았습니다. 훅 번들을 직접 실행해 Codex 형식 입력으로 모의 시험만 했습니다.
  - 셸·패치 도구 이름은 후보(`shell`, `local_shell`, `exec_command`, `apply_patch`, `Bash`, `Edit`, `Write`)로 걸어 두었습니다. 실제 이름이 다르면 게이트가 걸리지 않습니다.
  - Codex가 PreToolUse의 `deny`를 따르지 않으면 거부 없이 통과합니다.
  - Codex 설정에는 UserPromptSubmit 훅이 없으므로 세션 시작을 요청 기준으로 삼아 세션당 한 번만 강제합니다.
  - 셸 호출이 인자 배열로 오면 읽기 전용 명령도 요청당 한 번 거부될 수 있습니다.
- 토론 결정과 다른 점: 이 플러그인의 상태를 바꾸는 MCP 도구(`record_stage_result` 등)는 게이트하지 않습니다. `plan_workflow`·`record_stage_result`의 입력은 host attestation 훅만 다룬다는 기존 불변조건을 지키기 위해서입니다. 세션의 첫 상태 변경은 대개 파일 편집이나 명령이라 그쪽이 먼저 걸립니다.
- 같은 문장을 반복 제출하면 형식상 최신이지만 내용은 낡을 수 있습니다.
- 허용 목록 밖의 읽기 명령(예: `pnpm test`, 파이프가 들어간 조회)도 요청당 한 번 거부됩니다.
- 벤더 간 공유(Claude 세션의 현황을 Codex가 보는 것)는 다음 단계입니다.

## 검증

- 구현 후보에서 `bundle:check`, `claude:drift`, `lint`, `build`, `test`(368건 통과, 새 현황판 테스트 9건과 경로 테스트 1건 포함), `runtime:check`, `validate:all`, `validate:official`, `claude:check`가 모두 종료 코드 0이었습니다.
- 새 테스트가 확인하는 것:
  - 요청마다 한 번만 거부하고 갱신 뒤 허용한다.
  - 요청 이벤트가 없는 호스트는 세션 시작을 기준으로 삼는다.
  - 한 줄·200자 제한을 지킨다.
  - 목록의 `stale`·`current` 표시와 24시간 정리가 맞다.
  - 두 연결이 같은 요청을 경합해도 거부는 한 번이다.
  - 읽기 전용 명령을 판정한다.
  - 서브에이전트는 면제되고 부모의 줄을 쓰지 못하며, 오류가 나면 통과한다.
  - MCP 도구 2개의 기록 확인, `BINDING_REQUIRED`, 설정 없음 처리가 맞다.
- clean-room 검사: `node_modules` 없는 설치 형태에서 훅 번들이 첫 편집을 한 번 거부하고 다음 시도를 허용합니다.
- 실제 Claude Code 헤드리스 세션(Opus 5, 후보 플러그인) 2회:
  - 갱신 없이 편집하라고 지시한 세션에서 첫 게이트 대상 호출이 사유와 함께 거부됐고, 모델이 `update_session_status`를 호출한 뒤 작업을 마쳤습니다.
  - 일반 요청에서는 모델이 현황판 스킬을 읽고 먼저 갱신해 거부 없이 진행했습니다.
  - 두 세션 모두 훅이 채운 세션 ID와 작업 디렉터리로 행이 기록됐습니다.
