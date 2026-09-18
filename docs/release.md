# 릴리스 점검

릴리스 후보는 플러그인 manifest, 포함된 스킬, MCP 서버 번들이 같은 소스 상태를 가리켜야 합니다. 변경된 계약이나 스킬이 있으면 해당 변경을 포함한 번들 검증 결과를 남깁니다.

릴리스 전에는 다음을 확인합니다.

- `pnpm lint`, `pnpm build`, `pnpm test`가 대상 Node.js 버전에서 통과한다.
- `pnpm bundle:check`가 설치물의 파일과 manifest 참조를 확인한다.
- `pnpm validate:all`이 저장소 내 스킬과 플러그인 검증기를 통과한다.
- Codex 개발 환경에서 `pnpm validate:official`이 시스템 skill·plugin validator를 통과한다.
- `pnpm release:check`가 `release/version.json`과 모든 현재 버전 표면의 일치를 확인한다.
- `pnpm source:check`가 registry·descriptor·metadata·통합 checksum을, `pnpm source:verify`가 고정된 원격 ref·peeled commit·원본 checksum을 확인한다.
- `git diff --check`에 공백 오류가 없다.
- MCP 서버가 필요한 경우 `mcp-server/dist/server.mjs`가 번들에 포함되고 로컬 STDIO로 시작된다.
- 임시 SQLite DB를 사용한 MCP 회귀 테스트에서 서버 인스턴스를 다시 만든 뒤에도 기존 run, `revision`, run ID sequence와 계획 서명 키가 유지된다.
- 기본 사용자 상태 디렉터리와 `AGENT_GOVERNANCE_DB_PATH`로 지정한 경로에 DB를 만들고 다시 열 수 있다.
- workflow SQLite v1~v4 DB를 v5로 열었을 때 기존 run, metadata, 계획 서명 키, run sequence, `plugin_update_state`와 convergence guard 이력이 유지되고 cleanup index·claim 및 trusted execution observation claim 저장소가 추가된다.
- continuity SQLite v1 DB를 v2로 열었을 때 기존 task·snapshot·request·tombstone·observation이 유지되고 보존 기간 조회 index가 추가된다.
- 업데이트 확인의 24시간 캐시, 실패 후 1시간 재시도, 버전당 한 번 안내와 비차단 실패 경로를 fixture로 검증한다.
- 배포 후보의 현재 버전과 공개 저장소의 최신 안정 tag를 비교하고, 업데이트 알림이 설치 파일이나 마켓플레이스 설정을 변경하지 않는지 확인한다.
- 포함 스킬의 품질 평가 상태와 runtime 활성 상태를 공개 문서에 분리해 기록한다. 품질 게이트를 통과하지 못한 스킬은 기본적으로 비활성화하되, 사용자가 현재 후보와 남은 제한을 확인하고 활성 배포를 명시적으로 승인한 경우에는 registry, 직접 descriptor와 implicit invocation을 같은 릴리스에서 일관되게 활성화한다.
- orchestrated semantic workflow의 `bootstrapExecution`, stage별 `executionRequirement`와 `StageResult.executionContext`가 계획 HMAC·저장 receipt에 결속되고, missing/under-provisioned 실행이 각각 `BINDING_REQUIRED`/`BINDING_INVALID`로 차단되는지 확인한다. observation ID가 서버 재시작과 동시 SQLite 연결 뒤에도 한 번만 소비되는지, HMAC token의 same-byte 비정규 base64url 표기가 schema와 내부 검사 모두에서 거부되는지도 확인한다. 이전 버전 receipt에 새 필드가 없어도 읽기·종료 상태 조회가 깨지지 않아야 하지만, strict MCP claim·guarded start·semantic stage 경계에서는 assurance가 없는 legacy plan을 진행시키지 않는다.
- Claude host attestation은 `AGENT_GOVERNANCE_HOST_ATTESTATION`이 없는 서버에서 `BINDING_REQUIRED`를 유지하고, Claude 배포물에서는 입력 변경·서명 위조·다른 키·재사용·만료 토큰을 `BINDING_INVALID`로 거절하는지 테스트로 확인한다. 릴리스 전에 빌드한 `claude-plugin`으로 transcript를 남기는 새 Claude Code 세션을 띄워 `plan_workflow`부터 `open_convergence_root`, `claim_workflow_attempt`, `start_guarded_workflow`, `record_stage_result`, `finalize_workflow`까지 한 흐름이 관측값으로 통과하는지, 서브에이전트가 부른 `plan_workflow`가 서브에이전트 actor로 관측되는지 확인한다. `anthropic` 프로필의 공개 도구 스키마에 `$ref`가 남아 있지 않은지도 테스트로 확인한다.
- `record_stage_result`의 `outputFile`이 digest 불일치·상대 경로·JSON 아님·16 MiB 초과를 거절하고, 인라인 출력과 같은 검사를 거쳐 receipt에 참조만 남기는지 테스트로 확인한다. 저장소 크기에 비례하는 stage 출력이 있는 실제 요청으로 새 Claude Code 세션을 띄워 orchestrated run이 finalize까지 가는지 확인한다.
- 비활성 스킬은 직접 호출 시 provider와 스크립트를 실행하지 않는 fail-closed 지침을 유지한다. 활성 스킬은 registry, 직접 descriptor, `agents/openai.yaml`과 `SKILL.md`의 상태가 모두 일치하는지 확인한다.
- SQLite가 전체 `WorkflowReceipt`·`StageResult`와 direct continuity snapshot의 `core`·`evidenceRefs`를 평문으로 저장한다는 사실, 확인 기반 보존·삭제 정책, backup의 수동 삭제 책임과 OS 접근 권한 정책을 사용자 문서에서 설명한다.

공개 전에는 버전, 변경 요약, 호환성 영향, 알려진 제한을 확인합니다. SQLite 스키마가 바뀌면 기존 DB를 복사해 둔 뒤 릴리스 후보로 열어 호환성을 확인하고, 복구 절차도 변경 요약에 남깁니다. 고위험 변경이 포함되면 독립 감사의 대상 식별자와 판정이 현재 릴리스 후보와 일치하는지도 확인합니다.

workflow SQLite v1~v4를 v5로, continuity SQLite v1을 v2로 올리기 전에는 MCP 서버를 중지하고 `VACUUM INTO`처럼 WAL까지 일관되게 반영하는 방식으로 각 DB를 백업합니다. 롤백 시험은 backup을 별도 경로에 복원하고 이전 MCP로 열어 기존 run, run ID sequence, 계획 서명 키, 업데이트 상태와 continuity snapshot이 유지되는지 확인합니다. 새 schema DB를 그대로 둔 채 이전 MCP만 다시 설치하는 절차는 롤백으로 인정하지 않습니다. 업그레이드 전 DB가 없었다면 새 DB를 별도 보관하고 원래 경로에서 제거한 상태로 이전 MCP를 시작합니다.

공개 GitHub 저장소를 만들거나 처음 push하기 직전에는 저장소 주소와 공개 범위를 다시 확인합니다. 릴리스 후에는 태그의 `mcp-server/dist/server.mjs`, `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`이 같은 버전을 가리키는지 확인합니다. 깨끗한 Codex 환경에서 marketplace를 추가한 뒤 전문 스킬 15개, 오케스트레이터와 registry 밖의 `context-continuity` 인프라 스킬이 발견되는지, 비활성 스킬이 MCP 라우팅에서 제외되는지 확인합니다. MCP `tools/list`, 대표 계획·실행·중단 흐름과 explicit continuity 도구도 함께 점검합니다.
