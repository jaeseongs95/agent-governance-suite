# 릴리스 점검

릴리스 후보는 플러그인 manifest, 포함된 스킬, MCP 서버 번들이 같은 소스 상태를 가리켜야 합니다. 변경된 계약이나 스킬이 있으면 해당 변경을 포함한 번들 검증 결과를 남깁니다.

릴리스 전에는 다음을 확인합니다.

- `pnpm lint`, `pnpm build`, `pnpm test`가 대상 Node.js 버전에서 통과한다.
- `pnpm bundle:check`가 설치물의 파일과 manifest 참조를 확인한다.
- `pnpm validate:all`이 저장소 내 스킬과 플러그인 검증기를 통과한다.
- Codex 개발 환경에서 `pnpm validate:official`이 시스템 skill·plugin validator를 통과한다.
- `git diff --check`에 공백 오류가 없다.
- MCP 서버가 필요한 경우 `mcp-server/dist/server.mjs`가 번들에 포함되고 로컬 STDIO로 시작된다.

공개 전에는 버전, 변경 요약, 호환성 영향, 알려진 제한을 확인합니다. 고위험 변경이 포함되면 독립 감사의 대상 식별자와 판정이 현재 릴리스 후보와 일치하는지도 확인합니다.

공개 GitHub 저장소를 만들거나 처음 push하기 직전에는 저장소 주소와 공개 범위를 다시 확인합니다. 릴리스 후에는 태그의 `mcp-server/dist/server.mjs`, `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`이 같은 버전을 가리키는지 확인합니다. 깨끗한 Codex 환경에서 marketplace를 추가한 뒤 열 개 전문 스킬과 오케스트레이터가 발견되는지, MCP `tools/list`와 대표 계획·실행·중단 흐름이 동작하는지도 점검합니다.
