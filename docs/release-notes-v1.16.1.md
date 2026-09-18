# v1.16.1 — 공용 원본과 Claude 전용 보정 분리

## 핵심 변경

- Claude 전용 문구를 한 파일(`claude-overlay/replacements.json`)의 원문 치환 목록에서 스킬별 파일(`claude-overlay/adaptations/<스킬명>.json`)로 옮겼습니다. 공용 원본(`skills/`, `runtime/`, `contracts/`, MCP 서버 번들)은 두 배포물이 그대로 함께 쓰고, Codex 전용 부분은 Codex가 설치하는 자리(`.codex-plugin/`, `.agents/`, `hooks/`, `.mcp.json`, 스킬의 `agents/openai.yaml`)에 그대로 둡니다.
- Claude용 스킬 `description`은 `SKILL.md` frontmatter 필드를 통째로 바꿉니다. 공용 description의 문구가 바뀌어도 Claude 생성이 실패하지 않습니다. 원문을 찾아 바꾸는 치환은 35건에서 16건으로 줄었고, 호스트 중립 표현이 없는 문장에만 남았습니다.
- 배포하는 스킬을 Codex 방식으로 호출한 `$스킬명` 표기는 Claude 생성물에서 `/agent-governance-suite:스킬명`으로 자동 변환합니다.
- MCP 서버가 `AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE=anthropic`일 때 세션 `instructions`를 내보냅니다. Claude Code는 이를 세션 시작 때 시스템 프롬프트에 넣습니다. 내용은 "파일을 고치거나 명령을 실행하기 전에 요청의 실패 영향을 한 줄로 분류하고, CI·CD·릴리스·권한 경계·전역 설정·데이터처럼 영향이 크면 orchestrator나 해당 전문 스킬을 먼저 호출한다"는 접수 규칙입니다. 환경 변수가 없는 Codex 서버는 `instructions`를 내보내지 않습니다.
- 공용 원본이나 Codex 전용 부분을 고치는 변경은 Claude 생성물을 다시 만들 필요가 없습니다. CI는 `pnpm claude:check` 대신 `pnpm claude:drift`를 실행해 생성물과 원본의 차이, Claude 배포물에 없는 Codex 훅 이벤트를 경고로만 알립니다. 테스트는 커밋된 Claude 생성물의 구조만 확인하며, 원본과 맞는지는 릴리스 준비나 Claude 쪽 작업에서 `pnpm claude:build`와 `pnpm claude:check`로 확인합니다.

## 배경

v1.16.0까지는 공용 스킬을 고칠 때마다 같은 변경에서 Claude 생성물을 다시 만들어야 했고, Claude 치환이 가리키는 원문을 바꾸거나 스킬에 `$스킬명` 호출을 추가하면 CI가 실패했습니다. upstream 스킬을 자동으로 들여오는 PR도 Claude 생성물을 갱신하지 않으므로 같은 이유로 실패할 수 있었습니다. Codex 쪽 변경이 Claude 배포물 때문에 막히지 않도록 두 배포물의 갱신 시점을 나눴습니다.

접수 규칙은 2026년 9월 18일 새 세션 측정에서 정했습니다. CI 워크플로를 고치고 커밋하는 같은 과제를 조건 다섯 개로 각 2회 실행했을 때, 첫 파일 편집 전에 거버넌스 스킬을 스스로 호출한 비율은 현재 플러그인 0/2, 설명문을 Codex 원문으로 되돌린 플러그인 0/2, 프롬프트마다 orchestrator 지침 전문을 넣어 준 플러그인 0/2였고, 프롬프트마다 접수 규칙을 넣은 훅과 서버 `instructions`의 접수 규칙은 각각 2/2였습니다. 열 세션 모두 커밋 전 독립 감사까지는 이어지지 않았으며, 이 부분은 측정 환경이 MCP 도구 호출을 허용하지 않은 영향이 섞여 있어 따로 확인해야 합니다.

## 호환성

- 스킬 구성, 공개 계약 schema, 용어집 데이터(1.2.1), SQLite schema, MCP 서버 동작은 v1.16.0과 같습니다. 환경 변수 없이 띄운 서버가 내보내는 도구 목록도 같습니다.
- Codex 배포물에서 버전 문자열 외에 바뀐 실행 파일은 없습니다.
- 새 구조로 생성한 Claude 배포물은 v1.16.0과 비교해 버전 문자열과 `README.md`만 다릅니다.

## 알려진 제한

- Claude 생성물은 릴리스 사이에 공용 원본보다 뒤처질 수 있습니다. 차이는 CI 경고로 드러납니다.
- 남은 원문 치환 16건 가운데 12건은 upstream이 자동 업데이트 PR을 여는 `independent-audit-gate`, `independent-deliberation-panel`에 있습니다. upstream이 해당 문장을 바꾸면 다음 Claude 생성 때 이 스킬의 adaptation 파일을 고쳐야 합니다.
- Claude 생성을 맞추지 못한 채 릴리스하면 Codex 배포물만 새 버전이 되고 Claude 배포물은 이전 버전으로 남습니다.
