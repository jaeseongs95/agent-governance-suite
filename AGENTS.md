# Repository Guidelines

## 구조와 책임

이 저장소는 열 개 전문 스킬, 한국어 산문 워크플로, 오케스트레이터와 로컬 MCP 서버를 함께 배포하는 플러그인 모노레포다.

```text
.codex-plugin/plugin.json        # 플러그인 매니페스트
.claude-plugin/marketplace.json  # Claude Code 마켓플레이스 배포 정보
claude-overlay/                  # Claude 전용 파일과 스킬별 Claude 보정(adaptations/)
claude-plugin/                   # 생성된 Claude Code 플러그인(직접 수정 금지)
.agents/plugins/marketplace.json # 마켓플레이스 배포 정보
contracts/                       # 공유 JSON Schema와 TypeScript 계약
mcp-server/src/                  # MCP 서버 소스
mcp-server/dist/                 # 커밋하는 서버 번들
runtime/                         # 설치물용 공용 런타임과 제3자 고지
skills/orchestrator/             # 요청 분류와 실행 흐름 연결
skills/<skill-name>/             # 독립된 전문 스킬
tests/                           # 계약·회귀·런타임 테스트
```

전문 스킬은 한 가지 역할과 독립 호출 가치를 유지한다. 오케스트레이터는 요청 분류, 실행 순서, 공통 입출력, 중간 검증과 결과 통합만 맡는다. 필수 순서와 불변조건은 지침만으로 두지 말고 스크립트, schema 또는 MCP 실행 계층에서 강제한다.

공용 스킬, 계약, MCP 도구와 런타임은 특정 AI 제품이나 호스트 API를 전제로 하지 않는다. 호스트 이름은 확장 가능한 식별자로 다루고, Codex·Claude Code·Grok·Spark 등 제품별 훅, 신원 관측, 깨우기와 배포 형식은 adapter 또는 overlay 경계에만 둔다. 새 호스트를 지원할 때 공용 계약을 복제하거나 제품명을 박아 넣지 말고 같은 계약에 얇은 adapter를 추가한다. 제품 자체의 로그처럼 본질적으로 호스트 전용인 기능은 이름과 적용 범위에 그 제약을 명시한다.

## 기준 상태

정확한 버전, 명령, 필수 파일은 현재 `package.json`, `.codex-plugin/plugin.json`, `skills/registry.json`, 소스와 테스트에서 확인한다. 문서나 과거 채팅이 다르면 현재 구현을 우선한다.

작업 폴더 소스, Git commit/tag, 공개 릴리스와 Codex 설치 캐시는 서로 다른 상태다. 설치·실행 여부를 확인할 때는 버전 문자열만 보지 말고 설치 캐시의 런타임, MCP 호출과 대표 흐름을 직접 검사해 각각 보고한다. Codex가 플러그인을 구동 중이면 별도의 `pnpm dev` 프로세스가 없어도 정상일 수 있다.

## 개발과 검증

Node.js 22.13 이상과 `pnpm@11.19.0`을 사용한다. 주요 명령은 다음과 같다.

- `pnpm dev`: 개발용 MCP 서버
- `pnpm lint`: ESLint와 저장소 계약 검사
- `pnpm build`: TypeScript 검사와 배포 번들 생성
- `pnpm test`: Vitest 회귀 테스트
- `pnpm bundle:check`: 커밋된 번들의 신선도와 구성 검사
- `pnpm runtime:check`: `node_modules` 없는 설치물 형태의 공개 CLI 검사
- `pnpm validate:all`: 저장소·스킬 전체 검증
- `pnpm validate:official`: Codex 공식 validator 검사

전체 검증은 `pnpm install --frozen-lockfile` 후 `pnpm bundle:check`를 빌드보다 먼저 실행한다. 이어 `pnpm claude:drift`, `pnpm lint`, `pnpm build`, `pnpm test`, `pnpm runtime:check`, `pnpm validate:all`, `pnpm validate:official`, `git diff --check`를 실행한다. 빌드가 stale 번들을 덮어쓸 수 있으므로 순서를 바꾸지 않는다. CI는 Ubuntu와 Windows의 Node.js 22·24 조합을 기준으로 한다.

## 배포물 계약

플러그인 설치 과정은 `node_modules`를 설치하지 않는다. 배포되는 모든 스킬 CLI는 외부 패키지 설치 없이 실행돼야 하며, 개별 CLI에서 bare npm import를 추가하지 않는다. JSON Schema 검증은 `runtime/schema-validation.mjs`의 공용 번들을 사용한다.

런타임 의존성이 바뀌면 번들, `runtime/THIRD_PARTY_NOTICES.md`, 신선도 검사와 clean-room 검사를 함께 갱신한다. `mcp-server/dist/server.mjs`를 비롯한 커밋 산출물은 같은 소스 상태를 가리켜야 한다.

업데이트 확인 기능은 설치 파일이나 마켓플레이스 설정을 바꾸지 않으며 `automaticInstall: false`를 유지한다. 저장 실패나 손상된 업데이트 상태가 기존 workflow를 막아서는 안 된다. SQLite 변경에는 기존 데이터 보존, 두 연결의 경합, 성공·실패 경합, 알림 버전의 단조 증가와 버전당 한 번 claim을 검증하는 테스트를 둔다.

## Claude Code 배포물

Claude Code 배포물은 Codex 플러그인과 서로 영향을 주지 않아야 한다. 공용 원본(`skills/`, `mcp-server/dist/`, `runtime/`, `contracts/`, `release/version.json`)은 두 배포물이 함께 쓰고, 호스트별 부분은 따로 둔다. Codex 전용 부분은 Codex가 저장소 루트를 그대로 설치하므로 `.codex-plugin/`, `.agents/`, `hooks/`, `.mcp.json`, 스킬의 `agents/openai.yaml`에 있다. Claude 전용 파일은 `claude-overlay/`에, 스킬별 Claude 문구(description과 호스트 중립 표현이 없는 문장)는 `claude-overlay/adaptations/<스킬명>.json`에 둔다. Claude 작업을 위해 Codex 전용 부분과 루트 `skills/`의 Codex 동작을 바꾸지 않는다.

`claude-plugin/`은 `pnpm claude:build`로만 생성하고 직접 고치지 않는다. 공용 원본이나 Codex 전용 부분을 바꾸는 변경은 Claude 생성물을 다시 만들거나 `claude-overlay/`를 고칠 필요가 없다. CI의 `pnpm claude:drift`는 생성물과 원본의 차이, Codex 훅 이벤트 누락을 경고로만 알린다. 릴리스를 준비하거나 Claude 쪽을 작업할 때 `pnpm claude:build`와 `pnpm claude:check`로 맞추고, 치환할 원문이 사라지거나 생성물에 Codex 전용 표현이 남아 생성이 실패하면 오류에 표시된 adaptation 파일을 고친다. 생성을 맞추지 못해도 Codex 릴리스는 막지 않으며, 그때 Claude 배포물은 이전 버전으로 남는다. Claude Code 배포물의 workflow·continuity 상태 DB는 `${CLAUDE_PLUGIN_DATA}` 아래에만 둔다. 예외는 모든 호스트가 함께 쓰는 세션 현황판(`session-board.sqlite3`)과 TLS broker 상태(`session-messaging/`)이며 사용자 상태 디렉터리에 둔다. 현황판에는 요청 원문·비밀을 저장하지 않고, 메시지 spool에는 제한된 본문만 저장하며 인증 비밀은 넣지 않는다.

## 스킬과 라우팅 규칙

스킬 디렉터리는 `kebab-case`로 짓고 `SKILL.md` frontmatter의 `name`과 일치시킨다. YAML은 2칸 들여쓰기를 사용한다. 지침에는 적용 조건, 제외 조건, 입력, 출력과 실패 처리를 명령형으로 적는다. 공통 규칙은 복사하지 말고 오케스트레이터 계약이나 공유 참고 자료로 관리한다.

스킬을 추가·삭제하거나 이름, 버전, 역할을 바꾸면 같은 변경에서 `README.md`의 `포함된 스킬` 표와 `README.en.md`의 `Included skills` 표도 갱신한다. 두 표의 스킬 수, 이름, 버전, 원본 링크와 역할 설명은 `skills/registry.json`과 `skills/source-lock.json`에 맞춘다.

`economy`, `balanced`, `quality` 프리셋은 지원되는 모델과 추론 수준만 선택한다. 위임 여부, 에이전트 수, 배치, 권한과 감사 요구에는 영향을 주지 않는다. 사용자 지정값과 호스트의 실제 지원 범위를 우선하며, 고위험 작업은 `general`급 이상과 `high` 이상의 추론 하한을 유지한다.

## 테스트 규칙

각 스킬에는 정상, 경계와 예상 실패 사례를 둔다. 오케스트레이터는 스킬 선택, 실행 순서, 입출력 계약과 중간 실패 전파를 검증한다. 네트워크, 시간과 사용자 환경 값은 fixture로 격리한다. 배포 경로나 런타임 의존성이 바뀌면 개발 저장소 테스트만으로 끝내지 말고 실제 설치 트리와 같은 clean-room 검사를 추가한다.

## 변경과 릴리스

새 스킬이나 기능은 구현을 시작하기 전에 `codex/<작업명>` 형식(Claude Code 세션에서는 `claude/<작업명>`)의 전용 브랜치를 만들고, 해당 브랜치나 연결된 worktree에서 작업한다. 사용자가 브랜치 이름을 지정하면 그 이름을 따른다.

작업 전 `git status`, 관련 worktree와 적용 지침을 확인한다. 미추적 파일, 다른 작업의 커밋과 변경은 사용자 소유로 보고 보존한다. 파일과 외부 상태는 한 작업자만 쓰게 하고, 별도 worktree의 결과는 commit과 검증 근거로 통합한다.

커밋은 `feat: add acceptance evidence validator`, `docs: define skill boundaries`처럼 명령형 Conventional Commit을 사용한다. PR에는 변경 목적, 영향받는 스킬, 계약·매니페스트 변경과 실제 검증 결과를 적는다.

배포는 명시적 요청이 있을 때만 수행한다. 버전과 후보 commit을 고정하고 전체 검증, 독립 사전 감사, mutation preflight, `origin/main`과 annotated tag·GitHub Release 반영, CI 확인, 로컬 marketplace 갱신·설치, 설치 캐시와 MCP 동작 확인, 독립 사후 감사 순서로 진행한다. 감사 후 후보가 바뀌면 영향 범위를 다시 감사한다.
