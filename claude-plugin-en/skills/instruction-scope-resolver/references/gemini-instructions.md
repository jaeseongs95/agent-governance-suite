# Gemini / Antigravity 지침 파일 확인

Google Gemini / Antigravity 환경에서는 명시적인 호스트 adapter로 `GEMINI.md`와 `AGENTS.md` 계층을 읽고 해석한다. 공통 CLI의 기본값은 `AGENTS.override.md` → `AGENTS.md`이며 다른 호스트의 파일로 바뀌지 않는다.

이 호스트에서는 `node antigravity-connector/scripts/resolve-instructions.mjs --input request.json`을 사용한다. adapter는 공통 해석기에 파일 이름·종류의 순서만 전달한다. 요청·출력 schema, 허용 루트와 realpath 경계 검사는 동일하다.

## 확인할 위치

넓은 범위부터 적는다. 파일이 없으면 없다고 기록한다.

1. 전역 설정: `~/.gemini/config/` (또는 `~/.gemini/`)
2. 작업공간 커스터마이징: 저장소 루트의 `.agents/` (또는 `.agent/`, `_agents/`, `_agent/`)
3. 디렉터리 및 프로젝트 규칙: 대상 파일 경로에서 저장소 루트까지 상위 디렉터리를 거슬러 올라가며 발견되는 `GEMINI.override.md`, `AGENTS.override.md`, `GEMINI.md`, `AGENTS.md`, `.agents/rules/*.md`
4. 플러그인 규칙: 활성화된 플러그인 내부의 `rules/AGENTS.md` 또는 `rules/GEMINI.md`

## 해석 규칙

- 이 adapter의 같은 디렉터리 우선순위는 `GEMINI.override.md` → `AGENTS.override.md` → `GEMINI.md` → `AGENTS.md`이다. 처음 발견한 비어 있지 않은 파일 하나를 선택한다. 이 순서는 공통 기본 규칙에 적용하지 않는다.
- 상위 디렉터리에서 하위 디렉터리 순으로 체인을 구성하며, 더 가까운 하위 지침이 상위 지침의 충돌 부분을 덮어쓴다.
- 단일 규칙 파일 크기 제한은 24 KB(24,000 바이트)이며, 항상 활성화된 규칙들의 총 토큰 예산은 20,000 토큰이다.
- `@[label](path)` 구문으로 다른 지침 파일을 포함할 수 있다.
- 충돌이 발생하면 더 가까운 지침의 우선순위를 존중하되, 미해결 충돌은 `unresolvedConflicts`에 기록한다.

## 기록

- 확인한 파일마다 경로, 존재 여부, precedence를 `findings`에 적는다.
- 확인하지 못한 지침 위치가 작업 권한이나 완료 조건을 변경할 수 있으면 `NEEDS_INPUT`으로 반환한다.
