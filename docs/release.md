# 릴리스 점검

릴리스 후보는 플러그인 manifest, 포함된 스킬, MCP 서버 번들이 같은 소스 상태를 가리켜야 합니다. 변경된 계약이나 스킬이 있으면 해당 변경을 포함한 번들 검증 결과를 남깁니다.

릴리스 전에는 다음을 확인합니다.

- `pnpm lint`, `pnpm build`, `pnpm test`가 대상 Node.js 버전에서 통과한다.
- `pnpm bundle:check`가 설치물의 파일과 manifest 참조를 확인한다.
- `pnpm validate:all`이 저장소 내 스킬과 플러그인 검증기를 통과한다.
- Codex 개발 환경에서 `pnpm validate:official`이 시스템 skill·plugin validator를 통과한다.
- `git diff --check`에 공백 오류가 없다.
- MCP 서버가 필요한 경우 `mcp-server/dist/server.mjs`가 번들에 포함되고 로컬 STDIO로 시작된다.
- 임시 SQLite DB를 사용한 MCP 회귀 테스트에서 서버 인스턴스를 다시 만든 뒤에도 기존 run, `revision`, run ID sequence와 계획 서명 키가 유지된다.
- 기본 사용자 상태 디렉터리와 `AGENT_GOVERNANCE_DB_PATH`로 지정한 경로에 DB를 만들고 다시 열 수 있다.
- SQLite v1 DB를 v2로 열었을 때 기존 run, metadata와 계획 서명 키가 유지되고 `plugin_update_state`가 추가된다.
- 업데이트 확인의 24시간 캐시, 실패 후 1시간 재시도, 버전당 한 번 안내와 비차단 실패 경로를 fixture로 검증한다.
- 배포 후보의 현재 버전과 공개 저장소의 최신 안정 tag를 비교하고, 업데이트 알림이 설치 파일이나 마켓플레이스 설정을 변경하지 않는지 확인한다.
- 품질 게이트를 통과하지 못한 포함 스킬은 `skills/registry.json`에서 `enabled: false`이며 MCP capability 선택 결과가 없는지 확인한다.
- 같은 비활성 스킬의 직접 descriptor와 `agents/openai.yaml`도 비활성인지, 직접 호출 시 provider와 스크립트를 실행하지 않는 fail-closed 지침이 있는지 확인한다.
- SQLite가 전체 `WorkflowReceipt`와 `StageResult`를 평문으로 저장한다는 사실, 자동 보존·삭제 정책이 없다는 제한, DB 경로의 접근 권한과 보존 책임을 사용자 문서에서 설명한다.

공개 전에는 버전, 변경 요약, 호환성 영향, 알려진 제한을 확인합니다. SQLite 스키마가 바뀌면 기존 DB를 복사해 둔 뒤 릴리스 후보로 열어 호환성을 확인하고, 복구 절차도 변경 요약에 남깁니다. 고위험 변경이 포함되면 독립 감사의 대상 식별자와 판정이 현재 릴리스 후보와 일치하는지도 확인합니다.

SQLite v1에서 v2로 올리기 전에는 MCP 서버를 중지하고 SQLite backup API 또는 `VACUUM INTO`처럼 WAL까지 일관되게 반영하는 방식으로 DB를 백업합니다. 롤백 시험은 backup을 별도 경로에 복원하고 `v1.0.5` MCP로 열어 기존 run, run ID sequence와 계획 서명 키가 유지되는지 확인합니다. v2 DB를 그대로 둔 채 `v1.0.5`만 다시 설치하는 절차는 롤백으로 인정하지 않습니다. 업그레이드 전 DB가 없었다면 새 v2 DB를 별도 보관하고 원래 경로에서 제거한 상태로 이전 MCP를 시작합니다.

공개 GitHub 저장소를 만들거나 처음 push하기 직전에는 저장소 주소와 공개 범위를 다시 확인합니다. 릴리스 후에는 태그의 `mcp-server/dist/server.mjs`, `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`이 같은 버전을 가리키는지 확인합니다. 깨끗한 Codex 환경에서 marketplace를 추가한 뒤 열 개 전문 스킬과 오케스트레이터가 발견되는지, 비활성 스킬이 MCP 라우팅에서 제외되는지, MCP `tools/list`와 대표 계획·실행·중단 흐름이 동작하는지도 점검합니다.
