# Agent Governance Suite

Agent Governance Suite는 전문 스킬을 한 플러그인으로 묶되, 각 스킬의 책임과 단독 호출 가능성을 유지하는 프로젝트입니다. 오케스트레이터는 요청을 분류하고 스킬의 실행 순서와 입출력을 연결합니다. 전문 판단, 구현, 독립 감사의 결론은 해당 전문 스킬이 맡습니다.

플러그인 식별자는 `agent-governance-suite`이며 현재 버전은 `1.0.0`입니다. 저장소와 홈페이지는 [https://github.com/jaeseongs95/agent-governance-suite](https://github.com/jaeseongs95/agent-governance-suite)입니다.

## 구성

```text
.codex-plugin/plugin.json  플러그인 메타데이터
.mcp.json                  로컬 STDIO MCP 서버 설정
skills/                    오케스트레이터와 전문 스킬
mcp-server/                MCP 서버 구현
contracts/                 스킬 간 계약
scripts/                   검증과 번들 확인
```

`skills/orchestrator/`는 라우팅과 결과 통합만 담당합니다. 플러그인에는 다음 전문 스킬이 들어 있습니다.

| 실행 시점 | 전문 스킬 | 버전 |
| --- | --- | --- |
| bootstrap | `instruction-scope-resolver` | 0.1.0 |
| bootstrap | `workspace-convention-profiler` | 0.1.1 |
| bootstrap | `task-contract` | 0.1.0 |
| workflow | `coordinate-subagents` | 0.1.1 |
| workflow | `independent-deliberation-panel` | 1.0.0 |
| workflow | `change-scope-guardian` | 0.1.1 |
| workflow | `mutation-risk-preflight` | 0.1.1 |
| workflow | `acceptance-evidence-validator` | 0.1.0 |
| workflow | `independent-audit-gate` | 0.1.1 |
| recovery | `blocker-diagnostician` | 0.1.0 |

각 스킬은 독립적으로 호출할 수 있습니다. 공통 규칙은 전문 스킬에 복제하지 않고 계약과 오케스트레이터 경계에서 관리합니다. 정확한 원본 태그·커밋·checksum은 `skills/source-lock.json`에 고정합니다.

MCP 서버는 `node mcp-server/dist/server.mjs`로 로컬 STDIO에서 실행됩니다. 서버를 사용할 수 없으면 오케스트레이터는 가능한 전문 스킬의 직접 호출을 계속합니다. MCP가 없으면 수행할 수 없는 통합 작업만 `BLOCKED`로 표시합니다.

MCP는 `SkillDescriptor.v2`의 capability, `executionClass`, `phaseOrder`, artifact 의존성을 읽어 계획을 만듭니다. 스킬 이름별 분기 없이 provider의 결과 schema와 checksum, 선언형 `stateMapping`, gate를 검사합니다. 독립 숙고 단계는 schema-valid `DecisionRecord.v1`과 진행 가능한 assurance·consensus를 요구하고, 필수 감사 단계는 fresh auditor, 현재 대상 일치, 열린 blocking finding과 stale 여부, 실행 후 확인 상태까지 확인합니다. 실행 상태는 프로세스 메모리에만 두며 원문 코드나 전체 로그를 보관하지 않습니다. 서버가 다시 시작되어 `RUN_NOT_FOUND`가 반환되면 새 워크플로를 시작해야 합니다.

`bootstrap` provider는 `plan_workflow` 전에 직접 실행해 지침 범위, 저장소 관례와 `TaskEnvelope.v1`을 확정합니다. 일반 `workflow` provider는 artifact 의존성과 `phaseOrder`에 따라 정렬됩니다. `blocker-diagnostician` 같은 `recovery` provider는 실패한 run을 고치지 않고 별도 workflow에서 실행합니다.

이 검사는 로컬 워크플로의 구조적 게이트입니다. MCP는 호출자가 제출한 `verified`, 증거 위치, 작업자 식별자를 신뢰하며 파일 내용이나 실제 에이전트 신원을 인증하지 않습니다. 독립 감사자는 `independent-audit-gate` 절차에 따라 원자료와 구현자 분리를 직접 확인해야 합니다. 적대적인 클라이언트까지 통제해야 하는 환경에서는 인증된 신원·증거 저장소를 별도로 연결해야 합니다.

전문 스킬을 직접 사용하려면 위 표의 이름 앞에 `$`를 붙여 지정합니다. 둘 이상의 역할을 연결하고 실행 순서와 증거를 관리하려면 `$orchestrator`를 사용합니다.

## 설치

GitHub 마켓플레이스에서는 `v1.0.0` 태그를 기준으로 설치합니다.

```bash
codex plugin marketplace add jaeseongs95/agent-governance-suite --ref v1.0.0
codex plugin add agent-governance-suite@agent-governance
```

저장소 안의 marketplace 파일 자체를 확인하려면 플러그인 루트의 절대 경로를 등록할 수 있습니다. 현재 marketplace entry는 로컬 작업 트리가 아니라 GitHub의 `v1.0.0`을 source로 사용하므로, 아래 명령 뒤 `plugin add`를 실행해도 공개 태그가 설치됩니다.

```bash
codex plugin marketplace add <absolute-repo-path>
```

로컬 작업 트리는 `pnpm dev`, 검증 명령과 직접 STDIO 통합 테스트로 확인합니다. 위 명령은 로컬 Codex의 marketplace 상태를 변경하므로 이 저장소에서는 실행하지 않습니다.

설치 전에 `node --version`으로 Node.js 22 이상인지 확인합니다. 설치 후 저장소나 설치 캐시의 플러그인 루트에서 `node scripts/check-runtime.mjs`를 실행하면 Node.js 버전, MCP 설정, 번들과 registry 존재 여부를 검사합니다. Node.js가 없으면 [Node.js 다운로드 페이지](https://nodejs.org/en/download)에서 LTS 버전을 설치한 뒤 새 터미널에서 다시 확인합니다. MCP가 시작되지 않아도 열 개 전문 스킬의 직접 호출은 사용할 수 있습니다.

## 개발

Node.js 22 또는 24와 Corepack이 필요합니다. 의존성을 설치한 뒤 아래 명령을 사용합니다.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm build
pnpm test
pnpm bundle:check
pnpm validate:all
```

`pnpm validate:all`은 저장소에 포함된 스킬과 플러그인 검증기를 실행해야 합니다. 검증 명령과 실제 결과는 같은 변경에서 함께 관리합니다. 문서를 수정한 뒤에는 `git diff --check`로 공백 오류도 확인합니다.

Codex 개발 환경에서는 시스템 `skill-creator`와 `plugin-creator`의 공식 validator까지 실행할 수 있습니다. 시스템 Python을 찾지 못하면 `PYTHON`에 Python 3 실행 파일의 절대 경로를 지정합니다.

```bash
pnpm validate:official
```

## 스킬 추가와 편입

새 전문 스킬의 기본 구조와 정상·경계·실패 fixture를 만들려면 다음 명령을 사용합니다.

```bash
pnpm new:skill --name evidence-normalizer --phase validation --capability evidence-normalization
```

별도 저장소에서 개발한 스킬은 깨끗한 태그나 커밋만 편입합니다. `integration/skill-descriptor.json`이 있으면 provider 선언을 그대로 사용합니다. 이전 형식의 스킬은 `--phase`와 `--capability`로 단일 provider를 보완할 수 있습니다. 이미 편입한 스킬을 새 ref로 교체할 때는 `--replace true`를 명시합니다.

```bash
pnpm import:skill --source <path-or-url> --ref <tag-or-sha> --skill-path <path> --phase <phase> --capability <capability>
pnpm import:skill --source <path-or-url> --ref <new-tag-or-sha> --skill-path <path> --replace true
pnpm validate:skill --name <skill-name>
```

편입 명령은 임시 checkout에서 지정한 Git ref만 읽습니다. `.git`, `__pycache__`, `evals/results`, 일반 빌드 결과는 제외하고, 원본 ref·commit·checksum을 `skills/source-lock.json`에 기록합니다. 편입 PR에서는 자동 생성된 기본 fixture를 실제 스킬의 동작 사례로 교체해야 합니다.

이전 버전으로 되돌릴 때도 같은 import 경로를 사용합니다. `--ref`에 되돌릴 태그나 commit SHA를 넣고 `--replace true`로 편입한 뒤, `pnpm validate:skill --name <skill-name>`과 전체 테스트를 다시 실행합니다. 작업 트리 파일을 직접 덮어쓰거나 source-lock만 수정하지 않습니다.

공개 계약은 `contracts/`에 JSON Schema 2020-12로 정의되어 있습니다. `SkillDescriptor.v2`는 한 스킬의 여러 provider, 입력 binding, 출력 schema, 결과 상태와 gate를 선언합니다. 상태와 오류 코드는 계약에 선언된 값만 사용하며, 호환 가능한 스킬 추가는 minor, 수정은 patch, 계약·권한·식별자의 호환되지 않는 변경은 major 버전으로 관리합니다.

글로벌 작업 지침에서 분리한 일곱 스킬의 설계와 편입 근거는 [추가 스킬 구현 계획](docs/additional-skills-implementation-plan.md)에 정리했습니다. 각 스킬은 독립 저장소의 clean tag와 integration descriptor를 기준으로 이 플러그인에 편입했습니다.

## 기여와 보안

변경 범위, 전문 스킬의 책임, 계약 영향, 검증 결과는 [CONTRIBUTING.md](CONTRIBUTING.md)에 기록합니다. 보안 관련 문제를 다룰 때는 [SECURITY.md](SECURITY.md)를 따릅니다. 구조와 릴리스 절차는 [docs/architecture.md](docs/architecture.md), [docs/release.md](docs/release.md)에서 확인할 수 있습니다.

## 라이선스

[MIT License](LICENSE)를 적용합니다.
