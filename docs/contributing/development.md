# 개발 참고

개발 환경, 검증 명령, 생성물, 동결 평가, 스킬 편입 절차를 정리합니다. 기여 원칙은 [기여 안내](../../CONTRIBUTING.md)에 있습니다.

## 개발 환경과 검증 명령

Node.js 24.0.0 이상과 `pnpm@11.19.0`을 씁니다. 주요 명령은 `package.json`의 `scripts`가 정본입니다.

| 명령 | 하는 일 |
| --- | --- |
| `pnpm dev` | 개발용 MCP 서버 |
| `pnpm lint` | ESLint, 저장소 계약 검사(`validate-repository.mjs`), 메시지 카탈로그 검사, 관리자 페이지 생성물 검사, 도메인 중립 문구 검사 |
| `pnpm build` | TypeScript 검사와 배포 번들 생성 |
| `pnpm test` | 번들 생성 뒤 vitest와 node:test 회귀 시험 |
| `pnpm bundle:check` | 커밋된 번들의 신선도와 구성 검사 |
| `pnpm runtime:check` | `node_modules` 없는 설치물 형태의 공개 CLI 검사 |
| `pnpm validate:all` | 저장소·스킬 전체 검증 |
| `pnpm validate:official` | Codex 공식 validator 검사 |
| `pnpm claude:build`, `pnpm claude:check`, `pnpm claude:drift` | Claude Code 배포물 생성·검사·차이 경고 |

전체 검증은 `pnpm install --frozen-lockfile` 뒤 `pnpm bundle:check`를 빌드보다 먼저 실행합니다. 이어 `pnpm claude:drift`, `pnpm lint`, `pnpm build`, `pnpm test`, `pnpm runtime:check`, `pnpm validate:all`, `pnpm validate:official`, `git diff --check`를 실행합니다. 빌드가 stale 번들을 덮어쓸 수 있으므로 순서를 바꾸지 않습니다. 어떤 시험을 어디서 돌리는지는 [시험과 CI](testing-and-ci.md)에 있습니다.

## 생성물

`mcp-server/dist/`, `claude-plugin/`, `mcp-server/src/admin-page.generated.ts`는 생성물이며 직접 고치지 않습니다. 생성물이 포함하는 원본(`README.md`, `README.en.md`, `contracts/`, `skills/` 등)을 바꾸면 다음으로 다시 만들어 함께 커밋합니다.

```bash
corepack pnpm run build && corepack pnpm run claude:build && node scripts/admin-page.mjs --write
```

공용 원본과 호스트별 부분의 경계는 [AGENTS.md](../../AGENTS.md)의 「Claude Code 배포물」 절을 따릅니다.

## 한국어 산문 평가

동결된 한국어 산문 평가에서는 각 모델 단계 직전에 공통 사전 검사를 실행합니다. `<evaluation-root>`에는 `evals/runs`와 평가에 사용한 `skills/korean-prose-editor`가 있어야 합니다.

```bash
pnpm eval:preflight -- selection 1 <evaluation-root>
pnpm eval:preflight -- editing 1 <evaluation-root>
pnpm eval:preflight -- verification 1 <evaluation-root>
pnpm eval:preflight -- record 1 <evaluation-root>
```

검사는 승인된 실행 횟수, 기존 출력, 입력·후보·루브릭 digest, ID 순서, 빈 후보, 역할 결속과 블라인드 검증 입력을 확인합니다. 실패하면 해당 모델 단계를 실행하지 않습니다. `record` 검사는 `pnpm eval:receipt`에도 자동으로 적용됩니다.

새 구조화 cycle은 경로를 명시하고, 모델 호출 전에 동결 frame과 독립 corpus 타당성 보고서를 검사합니다. 품질 결과를 릴리스 근거로 사용할 때는 `--require-quality`를 붙입니다.

```bash
pnpm eval:readiness -- <cycle-directory> --expected-frame-digest <sha256:digest> --expected-validity-report-digest <sha256:digest> --evaluation-root <evaluation-root>
pnpm eval:preflight -- selection 1 <evaluation-root> --cycle-dir <cycle-directory> --expected-frame-digest <sha256:digest> --expected-validity-report-digest <sha256:digest>
pnpm eval:readiness -- <cycle-directory> --expected-frame-digest <sha256:digest> --expected-validity-report-digest <sha256:digest> --expected-quality-report-digest <sha256:digest> --evaluation-root <evaluation-root> --require-quality
```

`READY_TO_EVALUATE`는 새 평가를 시작할 수 있다는 뜻이고, `EVALUATION_EVIDENCE_PASSED`는 receipt·SQLite·최종 case와 독립 심사 결과에서 다시 집계한 모든 실행이 동결 기준을 통과했다는 뜻입니다. 어느 상태도 provider 활성화나 릴리스 승인을 뜻하지 않습니다. frame·타당성 보고서·품질 보고서의 digest를 cycle 밖에 먼저 보관한 뒤 각각 전달해야 합니다. selection 사전 검사는 모델 실행 전에 start claim을 원자적으로 만들고 이후 단계 metadata가 그 digest를 참조합니다. 언어 모델과 독립 심사자 입력에는 정답 label을 넣지 않으며, 심사가 봉인된 뒤 별도 동결 label 파일을 결합해 점수만 집계합니다. 기존 `invalid-corpus`와 `failed-recovery` cycle은 재해석하지 않으며, 새 frame은 현재 suite revision, 실제 통합 skill과 동일한 평가 사본의 checksum, 평가 toolchain의 checksum, corpus strata·rubric·threshold의 digest, 실행 횟수, 독립 역할을 함께 결속해야 합니다.

동결 threshold 값은 source lock의 upstream commit `c5df63749e2edfc8aa424f9935ee3cd4697d3c49`에 있는 `evals/cycles/0.1.0-rc2/thresholds.json`을 그대로 보존합니다.

## 스킬 추가와 편입

새 전문 스킬의 기본 구조와 정상·경계·실패 사례용 `fixture`를 만들려면 다음 명령을 사용합니다.

```bash
pnpm new:skill --name evidence-normalizer --phase validation --capability evidence-normalization
```

별도 저장소에서 개발한 스킬은 태그나 커밋으로 버전을 고정한 뒤 편입합니다. `integration/skill-descriptor.json`이 있으면 `provider` 선언을 그대로 사용합니다. 기존 형식의 스킬에는 `--phase`와 `--capability`를 지정해 단일 `provider`를 보완할 수 있습니다.

```bash
pnpm import:skill --source <path-or-url> --ref <tag-or-sha> --skill-path <path> --phase <phase> --capability <capability>
pnpm import:skill --source <path-or-url> --ref <new-tag-or-sha> --skill-path <path> --replace true
pnpm validate:skill --name <skill-name>
```

편입 명령은 임시 checkout에서 지정한 Git `ref`의 파일만 가져옵니다. `.git`, `__pycache__`, `evals/results`, 일반적인 빌드 산출물은 제외하며, 원본 경로, tag 또는 commit, peeled full SHA와 원본/통합 `checksum`을 `skills/source-lock.json`에 기록합니다. 편입 PR에서는 자동 생성된 `fixture`를 실제 동작 사례로 교체해야 합니다.

### 편입 실패 뒤 복구 상태

`import-skill.mjs`는 실패 원인과 `recovery` 정보를 함께 반환한다. 최초 실패는 `cause`와 `errors` 연결을 따라 확인할 수 있다.

- `state: completed`, `transactionState: removed`: rollback과 transaction 정리가 끝났다. transactionDirectory·previousSkill.path·metadataOriginals는 null이며, 남아 있는 백업 경로가 아니다.
- `state: incomplete`, `preserveTransaction: true`: transaction을 보존한다. metadataOriginals는 변경 전 registry/source-lock의 원본 바이트이며, previousSkill.state로 이전 스킬의 복원·보존 여부를 구분한다. previousSkill.path는 state가 retained일 때 보존된 백업을 가리킨다.
- cleanup 자체가 실패하면 복구가 완료된 경우에도 남은 디렉터리의 실제 상태를 별도로 확인해야 한다. 이전 경로가 모두 남았다고 가정하지 않는다.

저장소 루트의 `.agent-governance-import-*` transaction은 복구 자료가 조용히 사라지지 않도록 현재 의도적으로 숨기거나 자동 삭제하지 않는다. 실패 후에는 error.recovery에 표시된 해당 transaction만 확인하고, 다른 실행의 transaction을 정리 대상으로 삼지 않는다. 정상 성공과 완전한 rollback은 기존처럼 자동 정리한다.

이 동작은 프로세스 종료·전원 손실에 대한 내구성 보장이 아니다. CLI catch→cleanup 전체 경로의 fault 회귀는 아직 별도 검증이 필요하며, helper 회귀가 이를 대신하지 않는다.

## 계약과 버전

공개 계약은 `contracts/`에 JSON Schema 2020-12로 정의되어 있습니다. 기존 버전과 호환되는 스킬 추가는 `minor`, 동작 수정은 `patch`, 계약·권한·식별자의 호환성을 깨는 변경은 `major` 버전으로 관리합니다.
