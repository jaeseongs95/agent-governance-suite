# 기여 안내

변경은 한 스킬 또는 하나의 공통 계약 경계를 기준으로 작게 나눕니다. 전문 스킬의 책임을 넓히거나 다른 스킬과 겹치게 만들기 전에는 오케스트레이터 라우팅, 계약, 기존 단독 호출에 미치는 영향을 설명하세요.

pull request에는 변경 목적, 영향을 받는 스킬과 MCP 경로, 계약 또는 manifest 변경 여부, 실행한 검증 명령과 결과를 적습니다. 구현과 무관한 형식 정리는 별도 변경으로 분리합니다.

기존 capability와 겹치는 provider를 추가할 때는 서로 다른 priority와 비어 있지 않은 `selectionCriteria`를 기록합니다. v1 MCP는 priority가 큰 provider를 우선하며 `selectionCriteria` 자연어를 실행 중에 해석하지 않습니다. 요청 조건에 따라 자동으로 다른 provider를 골라야 한다면 각각 구체적인 capability를 선언합니다.

로컬에서는 아래 순서로 확인합니다.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm build
pnpm test
pnpm bundle:check
pnpm validate:all
git diff --check
```

새 전문 스킬은 `kebab-case` 디렉터리와 일치하는 frontmatter `name`을 사용하고, 적용 조건·제외 조건·입력·출력·실패 처리를 명시해야 합니다. 오케스트레이터에는 전문 판단을 넣지 말고, 필요한 연결 규칙만 추가합니다.

새 스킬은 `pnpm new:skill`로 시작하고, 별도 저장소의 스킬은 `pnpm import:skill`로 고정된 Git ref에서 가져옵니다. 추가한 스킬은 `skills/registry.json`에 capability, phase, 선행조건, 필수·생성 산출물과 risk gate를 등록해야 합니다. capability가 겹치면 서로 다른 priority와 구체적인 selection criteria를 함께 제출합니다.

호환 가능한 스킬 추가는 플러그인 minor, 기존 동작의 수정은 patch, 계약·스킬 이름·권한 범위를 깨는 변경은 major 버전으로 분류합니다. 전문 스킬 자체의 버전과 플러그인 버전은 별도로 유지합니다.
