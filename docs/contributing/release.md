# 발행

판 번호, 릴리스 노트, 발행 전 점검, 공급망 메타데이터를 정리합니다. 발행(main 병합, tag, GitHub Release, 설치)은 사용자의 명시적 승인이 있을 때만 합니다.

## 판 번호

판 번호는 SemVer를 따릅니다. 기존 계약·스킬 이름·권한 범위·사용자 설정을 깨는 변경은 major, 호환되는 기능 추가는 minor, 수정만 있으면 patch입니다. 전문 스킬 자체의 버전과 플러그인 버전은 따로 관리합니다.

플러그인 현재 버전의 단일 소스는 `release/version.json`입니다. `pnpm release:sync -- --write`가 현재 버전 표면(manifest·marketplace·`mcp-server/src/plugin-info.ts`·README 두 개의 `release-version`·`release-install`·`release-agy` 표식·[로드맵](roadmap.md)의 `release-version` 표식)을 생성하고, `pnpm release:check`는 누락·중복 표식과 drift를 실패시킵니다. 이 명령들은 tag, GitHub Release, marketplace 설치나 배포를 만들지 않습니다.

## 릴리스 노트

- 위치: `docs/release-notes/release-notes-v<버전>.md`(한국어). 예: 4.0.0은 `docs/release-notes/release-notes-v4.0.0.md`입니다.
- GitHub Release 본문은 이 파일로 만듭니다.

  ```bash
  gh release create v<버전> --notes-file docs/release-notes/release-notes-v<버전>.md
  ```

- 이미 발행한 판의 노트는 내용을 고치지 않습니다. 문서 경로가 바뀌어 상대 링크가 깨지면 링크 대상만 고칩니다.
- 노트에는 「업그레이드 전 확인」(데이터 이관, 깨지는 변경, 되돌리기), 고친 결함, 알려진 한계, 검증(실행한 것과 실행하지 않은 것)을 적습니다.
- Antigravity 설치 ZIP은 release가 발행되면 `.github/workflows/antigravity-package.yml`이 만들어 그 release에 올립니다.

## 발행 전 점검

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
- continuity SQLite schema 1·2·3을 4로 이관할 때 2000 byte 이하 current와 명시적 삭제 의사, 비공개 이전 내용이 보존되고, 초과 current에는 의미를 보존한 mapping이 필요하다. current/history 분리, 실패 시 원 schema 유지와 원자 rollback, receiver 소유 task의 보호를 확인한다.
- 업데이트 확인의 24시간 캐시, 실패 후 1시간 재시도, 버전당 한 번 안내와 비차단 실패 경로를 fixture로 검증한다.
- 배포 후보의 현재 버전과 공개 저장소의 최신 안정 tag를 비교하고, 업데이트 알림이 설치 파일이나 마켓플레이스 설정을 변경하지 않는지 확인한다.
- 포함 스킬의 품질 평가 상태와 runtime 활성 상태를 공개 문서에 분리해 기록한다. 품질 게이트를 통과하지 못한 스킬은 기본적으로 비활성화하되, 사용자가 현재 후보와 남은 제한을 확인하고 활성 배포를 명시적으로 승인한 경우에는 registry, 직접 descriptor와 implicit invocation을 같은 릴리스에서 일관되게 활성화한다.
- orchestrated semantic workflow의 `bootstrapExecution`, stage별 `executionRequirement`와 `StageResult.executionContext`가 계획 HMAC·저장 receipt에 결속되고, missing/under-provisioned 실행이 각각 `BINDING_REQUIRED`/`BINDING_INVALID`로 차단되는지 확인한다. observation ID가 서버 재시작과 동시 SQLite 연결 뒤에도 한 번만 소비되는지, HMAC token의 same-byte 비정규 base64url 표기가 schema와 내부 검사 모두에서 거부되는지도 확인한다. 이전 버전 receipt에 새 필드가 없어도 읽기·종료 상태 조회가 깨지지 않아야 하지만, strict MCP claim·guarded start·semantic stage 경계에서는 assurance가 없는 legacy plan을 진행시키지 않는다.
- Claude host attestation은 `AGENT_GOVERNANCE_HOST_ATTESTATION`이 없는 서버에서 `BINDING_REQUIRED`를 유지하고, Claude 배포물에서는 입력 변경·서명 위조·다른 키·재사용·만료 토큰을 `BINDING_INVALID`로 거절하는지 테스트로 확인한다. 릴리스 전에 빌드한 `claude-plugin`으로 transcript를 남기는 새 Claude Code 세션을 띄워 `plan_workflow`부터 `open_convergence_root`, `claim_workflow_attempt`, `start_guarded_workflow`, `record_stage_result`, `finalize_workflow`까지 한 흐름이 관측값으로 통과하는지, 서브에이전트가 부른 `plan_workflow`가 서브에이전트 actor로 관측되는지 확인한다. `anthropic` 프로필의 공개 도구 스키마에 `$ref`가 남아 있지 않은지도 테스트로 확인한다.
- `record_stage_result`의 `outputFile`이 digest 불일치·상대 경로·JSON 아님·16 MiB 초과를 거절하고, 인라인 출력과 같은 검사를 거쳐 receipt에 참조만 남기는지 테스트로 확인한다. 저장소 크기에 비례하는 stage 출력이 있는 실제 요청으로 새 Claude Code 세션을 띄워 orchestrated run이 finalize까지 가는지 확인한다.
- 비활성 스킬은 직접 호출 시 provider와 스크립트를 실행하지 않는 fail-closed 지침을 유지한다. 활성 스킬은 registry, 직접 descriptor, `agents/openai.yaml`과 `SKILL.md`의 상태가 모두 일치하는지 확인한다.
- SQLite가 전체 `WorkflowReceipt`·`StageResult`와 direct continuity snapshot의 `core`·`evidenceRefs`를 평문으로 저장한다는 사실, 확인 기반 보존·삭제 정책, backup의 수동 삭제 책임과 OS 접근 권한 정책을 사용자 문서에서 설명한다.

공개 전에는 버전, 변경 요약, 호환성 영향, 알려진 제한을 확인합니다. SQLite 스키마가 바뀌면 기존 DB를 복사해 둔 뒤 릴리스 후보로 열어 호환성을 확인하고, 복구 절차도 변경 요약에 남깁니다. 고위험 변경이 포함되면 독립 감사의 대상 식별자와 판정이 현재 릴리스 후보와 일치하는지도 확인합니다.

continuity schema 4의 실제 DB 확인·WAL 백업·current 최적화·이관·구버전 복구는 [3.8.0 이관 가이드](../user/migrate-to-v3.8.0.md)를 따른다. workflow DB는 continuity 이관 CLI의 대상이 아니다.

workflow SQLite v1~v4를 v5로 올리기 전에는 MCP 서버를 중지하고 `VACUUM INTO`처럼 WAL까지 일관되게 반영하는 방식으로 각 DB를 백업합니다. 롤백 시험은 backup을 별도 경로에 복원하고 이전 MCP로 열어 기존 run, run ID sequence, 계획 서명 키, 업데이트 상태와 continuity snapshot이 유지되는지 확인합니다. 새 schema DB를 그대로 둔 채 이전 MCP만 다시 설치하는 절차는 롤백으로 인정하지 않습니다. 업그레이드 전 DB가 없었다면 새 DB를 별도 보관하고 원래 경로에서 제거한 상태로 이전 MCP를 시작합니다.

공개 GitHub 저장소를 만들거나 처음 push하기 직전에는 저장소 주소와 공개 범위를 다시 확인합니다. 릴리스 후에는 태그의 `mcp-server/dist/server.mjs`, `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`이 같은 버전을 가리키는지 확인합니다. 깨끗한 Codex 환경에서 marketplace를 추가한 뒤 registry의 전문 스킬 전부(4.0.0 기준 23개)와 오케스트레이터가 발견되고 연속성 MCP 도구(`checkpoint_context` 등)가 `tools/list`에 나오는지, 비활성 스킬이 MCP 라우팅에서 제외되는지 확인합니다. MCP `tools/list`, 대표 계획·실행·중단 흐름과 explicit continuity 도구도 함께 점검합니다. 설치 확인은 Claude Code·Codex·Antigravity 세 호스트에서 각각 하고, 하지 못한 호스트는 미검증으로 노트에 적습니다.

`v1.2.0`은 SQLite schema를 v2에서 v3으로 올려 convergence root, epoch, attempt, lease, review와 workflow 연결을 보존했습니다. 이전 버전으로 돌아갈 가능성이 있다면 업그레이드 전에 MCP 서버를 중지하고 DB를 SQLite의 일관된 backup 방식으로 복사해야 합니다. v3 DB는 v2 서버에서 열 수 없으므로 플러그인만 다시 설치해서는 롤백되지 않습니다. 롤백할 때는 MCP를 중지한 상태에서 업그레이드 전 v2 backup을 복원해야 합니다. 이후 schema 변경도 같은 원칙을 따릅니다.

## 공급망과 원본 스킬

`skills/source-lock.json` v2는 각 스킬의 원본 저장소·하위 경로·버전·ref 종류·peeled commit·원본 checksum·통합본 checksum·업데이트 정책을 함께 고정한다. `pnpm source:check`는 네트워크 없이 registry, 직접 descriptor, `SKILL.md` metadata 또는 legacy `VERSION`, 로컬 checksum을 교차 검사한다. `pnpm source:verify`는 원격 ref를 checkout해 원본 checksum과 commit도 확인한다.

`auto-pr`은 downstream 수정이 없고 stable `vX.Y.Z` tag로 고정한 외부 스킬에만 사용한다. tag가 없는 commit으로 고정하면 버전이 실제 통합 내용을 가리키지 못하므로 `pnpm source:check`가 실패하고, `pnpm import:skill`도 `auto-pr` 스킬을 commit ref로 가져오기를 거부한다. 원본에서 버전을 올려 tag를 먼저 발행하거나, 예외가 필요하면 그 스킬을 `notify-only`로 내린다. `notify-only`는 로컬 수정이 있어 자동 덮어쓰기가 안전하지 않은 스킬, `internal`은 이 모노레포에서 직접 관리하는 스킬이다. 주간 `upstream-sync` workflow는 정확한 `vX.Y.Z` tag만 후보로 보고 스킬별 draft PR을 만든다. 더 높은 stable 버전 tag가 있으면 갱신 후보다. 버전이 같을 때는 tag로 고정한 항목의 tag가 다른 commit을 가리키거나, commit으로 고정한 항목의 commit에 그 tag가 붙은 경우만 후보다. commit으로 고정한 항목이 같은 버전의 tag와 다른 commit을 가리키면 어느 쪽이 최신인지 알 수 없으므로 자동으로 갱신하지 않고, 실행 요약의 `needs attention`과 report의 `attention`에 표시한다. 조회 오류가 난 `auto-pr` 항목도 같은 곳에 표시한다. 가져온 파일은 실행하지 않는다. 이 저장소에서는 Actions의 `GITHUB_TOKEN` Pull Request 생성 권한을 관리자가 수동으로 허용해야 한다. 그 token으로 만든 PR은 `pull_request` CI를 자동으로 발생시키지 않으므로, 검토자가 CI의 `workflow_dispatch`를 해당 PR branch에서 수동 실행한다.

업데이트 PR을 적용하는 `scripts/apply-upstream-update.mjs`는 `README.md`와 `README.en.md`의 스킬 표에서 그 스킬의 행을 정확히 하나 찾아 출처 링크와 버전 칸을 고친다. 스킬 표의 형식을 바꿀 때는 이 스크립트도 함께 확인한다.

### 업데이트 PR 검토

1. source lock의 tag, peeled commit과 checksum 변경을 확인한다.
2. 스킬의 계약·문서·테스트 변경을 검토한다.
3. 전체 저장소 검증과 원격 source 검증을 실행한다.
4. draft를 해제하고 병합할지는 사람이 결정한다. 자동 병합과 자동 릴리스는 사용하지 않는다.
