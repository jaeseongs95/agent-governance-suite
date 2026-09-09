# Repository Guidelines

## Project Structure & Module Organization

이 저장소는 여러 전문 스킬과 하나의 오케스트레이터를 함께 배포하는 플러그인 모노레포다. 스킬을 하나의 거대한 `SKILL.md`로 합치지 않는다.

```text
.codex-plugin/plugin.json        # 플러그인 매니페스트
skills/orchestrator/SKILL.md     # 선택·순서·입출력 연결
skills/<skill-name>/SKILL.md     # 한 가지 역할을 맡는 전문 스킬
skills/<skill-name>/references/  # 해당 스킬 전용 참고 자료
skills/<skill-name>/scripts/     # 반복 가능한 실행 로직
tests/<skill-name>/              # 스킬별 fixture와 회귀 테스트
```

전문 스킬은 독립 호출 가치가 있어야 한다. 오케스트레이터는 요청 분류, 실행 순서, 공통 입출력, 중간 검증, 결과 통합만 담당한다. 반드시 지켜야 하는 순서는 지침에만 의존하지 말고 스크립트나 MCP 실행 계층에서 강제한다.

## Build, Test, and Development Commands

Node.js 22 이상과 pnpm 11.19.0을 사용한다. TypeScript 빌드는 `pnpm build`, Vitest 회귀 테스트는 `pnpm test`, ESLint와 저장소 계약 검사는 `pnpm lint`, 개발용 MCP 서버 실행은 `pnpm dev`로 통일한다. 배포 전에는 `pnpm validate:all`, `pnpm validate:official`, `pnpm bundle:check`, `pnpm runtime:check`도 실행한다. 로컬과 CI는 같은 명령을 사용하고, 문서 변경 후에는 `git diff --check`로 공백 오류를 확인한다.

## Coding Style & Naming Conventions

스킬 디렉터리는 `instruction-scope-resolver`처럼 `kebab-case`로 짓고, `SKILL.md`의 frontmatter `name`과 일치시킨다. YAML은 2칸 들여쓰기를 사용한다. 지침은 명령형으로 쓰고 적용 조건, 제외 조건, 입력, 출력, 실패 처리를 명시한다. 공통 규칙을 여러 스킬에 복사하지 말고 오케스트레이터 계약이나 공유 참고 자료로 관리한다.

## Testing Guidelines

각 스킬에는 정상 사례, 경계 사례, 예상 실패 사례를 둔다. 오케스트레이터 테스트는 올바른 스킬 선택, 실행 순서, 입출력 계약, 중간 실패 전파를 검증한다. 네트워크, 시간, 사용자 환경에 의존하는 값은 fixture로 격리한다. 자동화하기 어려운 검증은 PR에 재현 절차와 실제 결과를 적는다.

## Commit & Pull Request Guidelines

이 작업 디렉터리에는 Git 기록이 없으므로 기존 규칙을 추정하지 않는다. 규칙이 정해지기 전에는 `feat: add acceptance evidence validator`, `docs: define skill boundaries`처럼 명령형 Conventional Commit을 사용한다.

PR에는 변경 목적, 영향받는 스킬, 검증 결과, 계약 또는 매니페스트 변경을 적는다. 기능과 무관한 정리는 분리하고, 기존 스킬의 책임 범위를 넓힐 때는 중복되는 스킬과 마이그레이션 영향을 함께 설명한다.
