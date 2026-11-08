# 기여 안내

AGS 자체를 고치는 사람을 위한 안내입니다. 저장소 작업 규칙(구조와 책임, 벤더 독립 원칙, 브랜치, 배포물 계약)은 [AGENTS.md](AGENTS.md)가 정본이며, 이 문서는 변경을 준비하고 제출하는 순서를 정리합니다.

## 원칙

- **벤더 독립:** 공용 스킬, 계약, MCP 도구, 런타임은 특정 AI 제품이나 호스트 API를 전제로 하지 않습니다. 호스트별 hook, 신원 관측, 깨우기, 배포 형식은 어댑터나 overlay 경계에만 둡니다. 어떤 호스트·모델·실행 주체(메인 세션·서브에이전트)가 실행해도 같은 코드로 같은 판정을 내려야 합니다.
- **세 호스트 시험:** 결함 하나를 고치는 작은 수정을 포함한 모든 수정은 Claude Code·Codex·Antigravity 세 호스트에서 조사하고 실제로 시험합니다. 시험하지 못한 호스트는 미검증으로 보고합니다.
- **작게 나누기:** 변경은 한 스킬 또는 하나의 공통 계약 경계를 기준으로 작게 나눕니다. 전문 스킬의 책임을 넓히거나 다른 스킬과 겹치게 만들기 전에는 오케스트레이터 라우팅, 계약, 기존 단독 호출에 미치는 영향을 설명합니다. 구현과 무관한 형식 정리는 별도 변경으로 분리합니다.

## 변경 순서

1. 작업 브랜치를 만듭니다. Codex 세션은 `codex/<작업명>`, Claude Code 세션은 `claude/<작업명>`, Gemini 세션은 `gemini/<작업명>` 형식을 씁니다.
2. 저장소 구조와 관례는 [아키텍처](docs/contributing/architecture.md)와 [개발 참고](docs/contributing/development.md)에서 확인합니다.
3. 변경과 함께 시험을 둡니다. 각 스킬에는 정상, 경계, 예상 실패 사례를 둡니다. 어떤 시험이 CI에서, 어떤 시험이 시험 서버에서 도는지는 [시험과 CI](docs/contributing/testing-and-ci.md)에 있습니다.
4. 생성물(`mcp-server/dist/`, `claude-plugin/`, `claude-plugin-en/`, `codex-plugin-en/`)이 원본을 담고 있으면 다시 만들어 함께 커밋합니다. [생성물](docs/contributing/development.md#생성물)
5. 아래 검증 명령을 실행합니다.
6. 커밋은 `feat: add acceptance evidence validator`, `docs: define skill boundaries`처럼 명령형 Conventional Commit으로 씁니다.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm bundle:check
pnpm lint
pnpm build
pnpm test
pnpm validate:all
git diff --check
```

전체 검증 순서와 각 명령의 역할은 [개발 참고](docs/contributing/development.md#개발-환경과-검증-명령)에 있습니다.

## pull request

pull request에는 변경 목적, 영향을 받는 스킬과 MCP 경로, 계약 또는 manifest 변경 여부, 실행한 검증 명령과 결과, 시험한 호스트와 시험하지 못한 호스트를 적습니다.

## 스킬 추가와 provider

- 새 전문 스킬은 `pnpm new:skill`로 시작하고, 별도 저장소의 스킬은 `pnpm import:skill`로 고정된 Git ref에서 가져옵니다. [스킬 추가와 편입](docs/contributing/development.md#스킬-추가와-편입)
- 스킬 디렉터리는 `kebab-case`로 짓고 frontmatter `name`과 맞춥니다. 적용 조건·제외 조건·입력·출력·실패 처리를 명시합니다. 오케스트레이터에는 전문 판단을 넣지 말고 필요한 연결 규칙만 추가합니다.
- 추가한 스킬은 `skills/registry.json`에 capability, phase, 선행조건, 필수·생성 산출물과 risk gate를 등록합니다.
- 기존 capability와 겹치는 provider를 추가할 때는 서로 다른 priority와 비어 있지 않은 `selectionCriteria`를 기록합니다. MCP는 priority가 큰 provider를 우선하며 `selectionCriteria` 자연어를 실행 중에 해석하지 않습니다. 요청 조건에 따라 자동으로 다른 provider를 골라야 한다면 각각 구체적인 capability를 선언합니다.
- 스킬을 추가·삭제하거나 이름, 버전, 역할을 바꾸면 같은 변경에서 `README.md`와 `README.en.md`의 스킬 표도 고칩니다.

## 판 번호와 발행

호환 가능한 스킬 추가는 플러그인 minor, 기존 동작의 수정은 patch, 계약·스킬 이름·권한 범위를 깨는 변경은 major로 분류합니다. 전문 스킬 자체의 버전과 플러그인 버전은 따로 유지합니다. 릴리스 노트 위치와 발행 절차는 [발행](docs/contributing/release.md)에 있습니다.

## 보안

취약점은 공개 이슈가 아니라 [보안 정책](SECURITY.md)의 비공개 신고 경로로 알립니다.
