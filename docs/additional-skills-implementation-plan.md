# 글로벌 작업 지침 기반 추가 스킬 구현 계획

## 1. 목적

이 문서는 글로벌 `AGENTS.md`에서 분리한 일곱 가지 기능을 각각 독립 스킬로 구현하는 계획을 정리한다. 우선순위는 스킬 자체의 목적과 품질이다. Agent Governance Suite 편입은 독립 구현을 끝낸 뒤 수행한다.

대상 스킬은 다음과 같다.

| 우선순위 | 스킬 | 글로벌 지침에서 맡는 영역 |
| --- | --- | --- |
| P0 | `instruction-scope-resolver` | 지침 우선순위, 경로별 `AGENTS.md`와 override 적용 범위 |
| P0 | `task-contract` | 목표, 범위, 완료 조건, 검증, 권한과 작업 단위 정의 |
| P0 | `change-scope-guardian` | 범위 밖 변경과 기존 사용자 변경 침범 방지 |
| P0 | `acceptance-evidence-validator` | 요구사항별 구현·검증 근거와 완료 가능 여부 확인 |
| P0 | `blocker-diagnostician` | 반복 실패의 원인 분리와 다음 판별 검사 선정 |
| P1 | `workspace-convention-profiler` | 저장소 구조, 관례, 명령과 변경 지점 조사 |
| P1 | `mutation-risk-preflight` | 파괴적·외부 상태 변경 전 대상, 승인과 복구 조건 확인 |

완료 기준은 두 단계로 나눈다.

1. **독립 스킬 완료**: 해당 스킬만 설치해 직접 호출할 수 있고, 자체 계약·스크립트·테스트로 핵심 불변조건을 검증한다.
2. **통합 준비 완료**: capability, phase, 입출력 artifact와 결과 schema를 integration descriptor로 제공해 오케스트레이터 플러그인이 스킬 이름을 하드코딩하지 않고 편입할 수 있다.

플러그인 편입 여부가 늦어져도 독립 스킬의 릴리스와 사용을 막지 않는다. 반대로 독립 검증을 통과하지 못한 스킬을 플러그인에서 먼저 보완하지 않는다.

## 2. 공통 구현 원칙

### 2.1 독립 저장소를 기준으로 개발한다

각 스킬은 별도 원본 저장소에서 `0.1.0`을 완성한다. 기본 구조는 다음과 같다.

```text
SKILL.md
agents/openai.yaml
references/
scripts/
contracts/
integration/
  skill-descriptor.json
  provider-result.v1.schema.json
tests/
package.json              # Node 스크립트가 있을 때만
pnpm-lock.yaml            # package.json이 있을 때만
README.md                 # 독립 설치·검증 설명이 필요할 때만
LICENSE
```

- `SKILL.md`에는 적용 조건, 제외 조건, 핵심 절차, 권한 경계, 출력과 실패 처리만 둔다.
- 조건별 세부 규칙과 schema 설명은 `references/`로 분리한다.
- 반복 계산, 경로 정규화, checksum, 상태 비교처럼 결정적으로 처리할 수 있는 부분만 `scripts/`에 둔다.
- 자연어 의미 판정, 위험 추론, 근거의 적절성은 정규식으로 흉내 내지 않는다.
- 스크립트는 stdin 또는 명시적 파일 입력으로 JSON을 받고 JSON을 stdout으로 반환한다. 저장소 경로와 Agent Governance Suite 모듈을 직접 참조하지 않는다.
- 스킬 본체는 다른 전문 스킬을 호출하지 않는다. 연결이 필요하면 입력 artifact와 capability로 표현한다.
- 직접 호출에서는 MCP 없이도 구조화된 결과와 사용자용 요약을 반환한다.

공통 계약을 쓰는 저장소는 해당 schema의 고정 snapshot을 `contracts/upstream/`에 함께 둔다. 예를 들어 `task-contract`와 `acceptance-evidence-validator`는 정확한 버전의 `TaskEnvelope.v1` schema, 원본 `$id`, 공급 suite 버전과 SHA-256을 `contracts/upstream/lock.json`에 기록한다. 독립 테스트는 로컬 snapshot만 사용하고, 편입 테스트는 snapshot checksum과 suite의 실제 계약이 같은지 확인한다. 호환되지 않는 계약 갱신은 스킬의 새 릴리스로 처리하며 latest URL이나 설치된 suite 모듈을 런타임에 참조하지 않는다.

### 2.2 통합 어댑터를 스킬 본체와 분리한다

`integration/skill-descriptor.json`에는 하나 이상의 provider entry를 둘 수 있다. 대부분의 스킬은 entry가 하나지만, 한 스킬이 서로 다른 실행 시점의 독립 entrypoint를 제공하면 entry마다 별도 capability와 계약을 선언한다. 각 entry에는 다음 정보만 둔다.

```text
skillId, version, enabled, capabilities, priority,
executionClass, phase, phaseOrder,
requiredInputArtifacts, inputBindings, producedArtifacts,
outputSchema, resultSchema, stateMapping,
selectionCriteria, preconditions, failureHandling, gate
```

`executionClass`는 다음 세 값으로 제한한다.

- `bootstrap`: `plan_workflow` 전에 실행해 `TaskEnvelope.v1`을 만들거나 보완한다.
- `workflow`: 동결된 계획의 stage로 실행한다.
- `recovery`: 실패한 run을 수정하지 않고 별도 진단·복구 workflow에서 실행한다.

integration adapter는 독립 스킬의 보고서를 다음 `ProviderResult.v1` envelope로 감싼다.

```text
kind: output | adapter-error
output: 독립 보고서 또는 null
artifacts[]
  artifactId, schemaId, locator, digest, targetDigest, verified
error: null 또는 { code, message, details }
```

`outputSchema`는 독립 보고서를 검증하고 `resultSchema`는 위 envelope 전체를 검증한다. envelope에는 별도 verdict를 복사하지 않으며 `stateMapping.selector`는 `output` 안의 판정 필드를 직접 가리킨다. `passed`, `needs-input`, `needs-approval`, `needs-redesign`으로 매핑되는 결과는 유효한 `output`과 `error: null`을 요구한다. `failed`와 `blocked`는 구조화된 `error`를 요구하며 `output`은 null 또는 schema를 통과한 부분 보고서만 허용한다. 따라서 baseline capture처럼 성공 산출물이 만들어지지 않은 adapter 오류도 `kind: adapter-error`, `output: null`로 기록할 수 있다.

`stateMapping`은 독립 판정 값을 `{ state, errorRequired, allowedErrorCodes }`로 바꾸는 선언형 표다. 예를 들어 acceptance `FAIL`은 `{ state: failed, errorRequired: true, allowedErrorCodes: [GATE_FAILED] }`, 증거 부족 `BLOCKED`는 `{ state: blocked, errorRequired: true, allowedErrorCodes: [MISSING_EVIDENCE] }`로 매핑한다. 원인이 여러 종류일 수 있는 `BLOCKED`는 adapter가 독립 보고서의 error code를 보존하되 descriptor가 허용한 코드인지 검사한다. 판정 필드가 없는 성공 결과는 `default`를 명시한다. output 생성 전 adapter 자체에서 실패한 경우에는 `adapterErrors`에 허용된 code만 `blocked`로 변환하고 `ProviderResult.v1.error`로 반환한다. 매핑되지 않은 값, error 누락과 허용되지 않은 코드는 `INVALID_TRANSITION`으로 거부한다.

integration descriptor는 독립 실행에 필요하지 않은 선택 파일이다. 모노레포의 `import:skill`이 clean tag를 가져올 때 descriptor와 스킬 계약을 검증하고 각 provider entry를 `skills/registry.json` 항목으로 생성한다. 초기 스킬은 capability가 겹치지 않는 동안 `priority: 50`을 사용하고, priority는 같은 capability를 제공하는 후보끼리만 비교한다.

아래 스킬별 JSON은 고유한 routing·artifact 필드를 보여 주는 요약이다. 실제 descriptor의 각 entry에는 `skillId`, `version`, `enabled`, `priority`, `selectionCriteria`, `preconditions`, `failureHandling`, `outputSchema`, `resultSchema`와 `stateMapping`을 포함한 공통 필드를 모두 채운다.

### 2.3 공통 상태와 판정 원칙

통합 시에는 기존 공통 상태를 그대로 사용한다.

| 독립 스킬 결과 | `StageResult.v1` 상태 |
| --- | --- |
| 필수 조건 충족 | `passed` |
| 사용자 정보 부족 | `needs-input` |
| 별도 승인 필요 | `needs-approval` |
| 현재 설계로 진행 불가 | `needs-redesign` |
| 확인된 실패 | `failed` |
| 도구·증거·대상 접근 불가 | `blocked` |

독립 스킬의 `PASS`는 해당 스킬이 맡은 질문에만 유효하다. `change-scope-guardian`이나 `acceptance-evidence-validator`가 통과해도 고위험 작업의 `independent-audit-gate`를 대체하지 않는다. `mutation-risk-preflight`의 통과도 실행 권한이나 사용자 승인을 새로 만들지 않는다.

### 2.4 스킬별 공통 검증

각 원본 저장소에서 다음을 통과해야 `0.1.0` 태그를 만든다.

- 공식 `quick_validate.py`
- frontmatter, 디렉터리명, 내부 링크와 `agents/openai.yaml` 검증
- 정상·경계·예상 실패 behavior fixture
- 모든 결정적 스크립트의 단위 테스트
- Windows와 Ubuntu의 경로·줄바꿈·정렬 결과 일치
- 스크립트 실행 전후 작업 트리와 외부 상태가 동일한지 확인하는 read-only 테스트
- MCP가 없는 환경의 직접 호출 forward test
- 목적 밖 행동, 권한 확대, 근거 없는 `passed`를 막는 부정 테스트

## 3. 전체 실행 흐름

일곱 스킬을 모두 설치해도 모든 요청에서 전부 실행하지 않는다. 일반적인 변경 작업의 흐름은 다음과 같다.

```text
instruction-scope-resolver       bootstrap, 필수 지침 확인
  → workspace-convention-profiler  bootstrap, 필요할 때만 저장소 조사
  → task-contract                  bootstrap, TaskEnvelope.v1 생성
  → plan_workflow
  → coordinate-subagents / independent-deliberation-panel  조건부
  → change-scope-guardian:capture  workflow, 첫 변경 전 baseline
  → mutation-risk-preflight        위험한 mutation 직전만
  → 구현 또는 상태 변경
  → change-scope-guardian:verify
  → acceptance-evidence-validator
  → independent-audit-gate         high/critical일 때 마지막
```

`blocker-diagnostician`은 위 흐름에 미리 넣지 않는다. 반복 실패가 생기면 기존 run과 영수증을 보존하고 별도의 recovery workflow를 시작한다.

```text
기존 run 실패
  → 새 TaskEnvelope.v1
  → blocker-diagnostician
  → 원인 또는 다음 판별 검사 확정
  → 필요하면 수정용 새 workflow
```

## 4. P0 스킬

### 4.1 `instruction-scope-resolver`

#### 목적과 경계

지정한 경로마다 적용되는 `AGENTS.md`와 `AGENTS.override.md`를 찾아 실제 적용 chain과 우선순위를 반환한다. 파일 발견, 경로 정규화, 같은 디렉터리의 override 대체 여부는 스크립트가 처리한다. 자연어 규칙의 의미 충돌은 에이전트가 원문 위치와 함께 판정한다.

다음 작업은 맡지 않는다.

- 지침 파일 작성·수정
- 시스템·개발자·사용자 지침을 저장소 파일로 재구성
- 사용자 권한 확대
- 작업 계약 작성, diff 검사 또는 구현

#### 독립 입력과 출력

입력 `InstructionScopeRequest.v1`:

```text
workspaceRoot
instructionRoots[]
  path, precedence, authorized
targets[]
  path
  mayNotExist
externalPolicyRefs[]
```

출력 `InstructionScopeResolution.v1`:

```text
workspaceRoot
targets[]
  requestedPath, resolvedPath, exists
  instructionChain[]
    path, kind, replacesSiblingAgents, sha256, precedence
  activeRules[]
    ruleId, summary, sourcePath, sourceLocator
  overriddenRules[]
  unresolvedConflicts[]
findings[]
verdict: PASS | NEEDS_INPUT | BLOCKED
```

산출물 ID는 `instruction-file-manifest`, `instruction-scope-resolution`, `instruction-conflict-ledger`로 고정한다.

#### 구현 파일

```text
references/resolution-model.md
references/conflict-classification.md
scripts/resolve-instruction-files.mjs
contracts/instruction-scope-request.v1.schema.json
contracts/instruction-scope-resolution.v1.schema.json
tests/fixtures/{root-only,nested,override,multi-target,unicode,escape}/
```

`resolve-instruction-files.mjs`는 다음만 결정적으로 수행한다.

1. workspace와 대상의 canonical path를 계산한다.
2. 대상이 workspace 밖으로 벗어나거나 symlink·junction이 허용된 root 밖을 가리키면 거부한다.
3. caller가 명시적으로 허용한 `instructionRoots`와 workspace root부터 대상 디렉터리까지 조상 경로를 만든다. 시스템·개발자·사용자 지침은 파일 탐색으로 추측하지 않고 `externalPolicyRefs`로만 연결한다.
4. 각 디렉터리에서 비어 있지 않은 `AGENTS.override.md`를 우선하고, 없으면 `AGENTS.md`를 선택한다.
5. 파일 경로, 크기, SHA-256과 precedence를 반환한다.
6. 여러 대상이 공유하는 파일은 manifest에서 중복 제거한다.

공백만 있는 override, 존재하지 않는 예정 경로, Windows 드라이브·Unicode 경로, 내부 symlink를 경계 사례로 둔다. workspace 탈출, 순환 junction, 읽을 수 없는 지침과 근거 없는 충돌 해소는 실패 사례다.

#### 통합 준비

```json
{
  "capabilities": ["instruction-scope-resolution"],
  "executionClass": "bootstrap",
  "phase": "instruction-resolution",
  "phaseOrder": 10,
  "requiredInputArtifacts": ["workspace-root", "target-paths"],
  "producedArtifacts": ["instruction-file-manifest", "instruction-scope-resolution", "instruction-conflict-ledger"],
  "outputSchema": "contracts/instruction-scope-resolution.v1.schema.json",
  "resultSchema": "integration/provider-result.v1.schema.json",
  "stateMapping": {
    "selector": "/output/verdict",
    "values": {
      "PASS": { "state": "passed", "errorRequired": false },
      "NEEDS_INPUT": { "state": "needs-input", "errorRequired": false },
      "BLOCKED": { "state": "blocked", "errorRequired": true, "allowedErrorCodes": ["MISSING_EVIDENCE", "INVALID_INPUT"] }
    },
    "default": "reject"
  },
  "gate": { "kind": "none", "policy": "none" }
}
```

미해결 충돌이 범위·권한·완료 조건을 바꾸면 `task-contract`로 넘기지 않고 `needs-input`으로 끝낸다.

#### 완료 기준

- 여러 대상의 서로 다른 instruction chain을 독립적으로 계산한다.
- 같은 디렉터리의 override 대체와 하위 지침의 부분 우선순위를 구분한다.
- 모든 활성 규칙 요약에 원본 파일과 위치가 남는다.
- 명시적으로 허용된 `instructionRoots` 밖의 파일을 읽지 않는다.
- 직접 호출만으로 “이 경로에 어떤 지침이 적용되는가”에 답할 수 있다.

### 4.2 `task-contract`

#### 목적과 경계

사용자 요청과 적용 지침을 `TaskEnvelope.v1`로 정리한다. 목표, 포함·제외 범위, 수용 기준, 작업 단위, 위험도, 권한과 필요한 검증의 출처를 추적할 수 있어야 한다.

이 스킬은 구현 방법, 전문 스킬 선택, 실행 순서와 최종 충족 여부를 결정하지 않는다. 모호한 요구를 임의로 확정하거나 사용자가 허용하지 않은 행동을 `allowedActions`에 추가하지 않는다.

`workUnits`에는 사용자 요청에서 확인되는 coarse unit, dependency와 예상 write target만 기록한다. `coordinate-subagents`는 이 계약을 수정하지 않고 실행 가능한 task graph, 할당과 통합 순서로 구체화한다. 작업 분해 중 목표·범위·의존성·write target을 바꿔야 한다면 기존 envelope를 조용히 고치지 않고 `task-contract`를 다시 실행해 새 digest를 발급한다.

#### 독립 입력과 출력

입력 `TaskContractRequest.v1`:

```text
taskId
request
instructionResolutionRefs[]
workspaceProfileRef?
suppliedFacts[]
userDecisions[]
```

주 출력은 기존 `TaskEnvelope.v1`이다. 함께 반환할 `TaskContractReport.v1`에는 다음을 둔다.

```text
taskEnvelope
provenance[]
  field, valueSummary, sourceLocator
  basis: explicit | instruction | verified-inference
assumptions[]
  statement, impact, confirmationRequired
ambiguities[]
  field, question, blocking
contradictions[]
verdict: PASS | NEEDS_INPUT | BLOCKED
```

`AcceptanceEvidencePlan.v1`은 각 수용 기준을 안정적인 `AC-001` 형식의 ID, 검증 방법, 기대 evidence 종류와 통과 조건에 연결한다.

#### 구현 파일

```text
references/field-guide.md
references/risk-and-authorization-rubric.md
references/acceptance-criteria.md
scripts/validate-task-contract.mjs
contracts/task-contract-request.v1.schema.json
contracts/task-contract-report.v1.schema.json
contracts/acceptance-evidence-plan.v1.schema.json
contracts/upstream/task-envelope.v1.schema.json
contracts/upstream/lock.json
tests/fixtures/{simple-read,parallel-work,high-risk,ambiguous,conflicting}/
```

validator는 다음 불변조건을 확인한다.

- `TaskEnvelope.v1` schema, work unit ID와 dependency graph
- 포함·제외 범위와 allowed·prohibited action의 모순 부재
- `writeTargets`가 제외 범위를 침범하지 않음
- 암묵적 glob 없이 repo-relative POSIX 경로 사용
- 모든 수용 기준과 evidence plan의 일대일 대응
- 목표, 범위, 위험도와 권한 필드의 provenance 존재
- blocking ambiguity가 있는데 `passed`로 표시하지 않음

#### 통합 준비

```json
{
  "capabilities": ["task-contract-definition"],
  "executionClass": "bootstrap",
  "phase": "task-definition",
  "phaseOrder": 30,
  "requiredInputArtifacts": ["task-request", "instruction-scope-resolution"],
  "producedArtifacts": ["task-envelope", "task-contract-report", "acceptance-evidence-plan"],
  "outputSchema": "contracts/task-contract-report.v1.schema.json",
  "resultSchema": "integration/provider-result.v1.schema.json",
  "stateMapping": {
    "selector": "/output/verdict",
    "values": {
      "PASS": { "state": "passed", "errorRequired": false },
      "NEEDS_INPUT": { "state": "needs-input", "errorRequired": false },
      "BLOCKED": { "state": "blocked", "errorRequired": true, "allowedErrorCodes": ["MISSING_EVIDENCE", "INVALID_INPUT"] }
    },
    "default": "reject"
  },
  "gate": { "kind": "none", "policy": "none" }
}
```

`plan_workflow`는 완성된 `TaskEnvelope.v1`을 입력으로 받으므로 일반적인 task-contract 작성은 반드시 run 생성 전 bootstrap에서 수행한다. 이미 유효한 envelope의 검토를 사용자가 직접 요청한 경우에만 일반 workflow stage로 사용할 수 있다.

#### 완료 기준

- 출력이 공통 `TaskEnvelope.v1` validator를 통과한다.
- 모든 핵심 필드의 출처와 가정 여부를 추적할 수 있다.
- 권한과 변경 범위를 원 요청보다 넓히지 않는다.
- blocking ambiguity는 `needs-input`으로 반환한다.
- 계약 작성만 요청받았을 때 구현이나 MCP run을 시작하지 않는다.

### 4.3 `change-scope-guardian`

#### 목적과 경계

작업 전 baseline과 현재 변경을 비교해 범위 밖 파일, 명시적으로 제외된 대상, 기존 사용자 변경과 겹친 부분을 찾는다. 결과는 읽기 전용 판정이며 reset, checkout, stash, 파일 복구를 수행하지 않는다.

코드 품질과 요구사항 충족 여부는 검사하지 않는다. baseline 없이 기존 변경의 소유자를 추측하지 않는다.

#### 독립 입력과 출력

`capture`와 `verify` 두 모드를 제공한다. 직접 호출에서는 한 스킬의 mode로 유지하되 통합 descriptor에서는 실행 시점과 artifact가 다른 두 provider entry로 노출한다.

```text
ChangeScopeRequest.v1
  mode: capture | verify
  repositoryRoot
  taskEnvelopeRef
  baselineRef?
  comparisonTarget: working-tree | index | commit
```

`WorkspaceBaseline.v1`은 repository identity, HEAD, staged·unstaged·untracked 상태, 경로별 checksum과 manifest checksum만 저장한다. 코드 원문과 전체 diff는 저장하지 않는다.

`ChangeScopeReport.v1`은 각 변경을 다음 중 하나로 분류한다.

```text
in-scope | excluded | unplanned | preexisting-untouched |
preexisting-overlap | ownership-unknown
```

전체 판정은 `PASS | NEEDS_APPROVAL | BLOCKED | INCONCLUSIVE`다. `INCONCLUSIVE`는 `needs-input`, `NEEDS_APPROVAL`은 `needs-approval`로 매핑한다.

#### 구현 파일

```text
references/path-policy.md
references/verdict-rules.md
scripts/capture-workspace-baseline.mjs
scripts/compare-change-scope.mjs
contracts/change-scope-request.v1.schema.json
contracts/workspace-baseline.v1.schema.json
contracts/change-scope-report.v1.schema.json
contracts/upstream/task-envelope.v1.schema.json
contracts/upstream/lock.json
tests/fixtures/{clean,dirty,rename,delete,untracked,submodule,no-baseline}/
```

스크립트는 `git status --porcelain=v2 -z`와 checksum을 이용해 경로와 상태를 수집한다. rename은 이전·새 경로를 모두 확인하고, delete는 삭제 전 경로를 검사한다. symlink 대상과 submodule 내부는 따라가지 않는다.

#### 통합 준비

```json
{
  "providers": [
    {
      "capabilities": ["change-scope-baseline-capture"],
      "executionClass": "workflow",
      "phase": "scope-baseline",
      "phaseOrder": 42,
      "requiredInputArtifacts": ["task-envelope", "current-workspace-state"],
      "producedArtifacts": ["workspace-baseline"],
      "outputSchema": "contracts/workspace-baseline.v1.schema.json",
      "resultSchema": "integration/provider-result.v1.schema.json",
      "stateMapping": { "default": { "state": "passed", "errorRequired": false }, "adapterErrors": ["MISSING_EVIDENCE", "INVALID_INPUT"] },
      "gate": { "kind": "precondition", "policy": "conditional" }
    },
    {
      "capabilities": ["change-scope-assurance"],
      "executionClass": "workflow",
      "phase": "scope-verification",
      "phaseOrder": 60,
      "requiredInputArtifacts": ["task-envelope", "workspace-baseline", "current-change-set"],
      "producedArtifacts": ["scoped-change-inventory", "ownership-collision-ledger", "change-scope-report"],
      "outputSchema": "contracts/change-scope-report.v1.schema.json",
      "resultSchema": "integration/provider-result.v1.schema.json",
      "stateMapping": {
        "selector": "/output/verdict",
        "values": {
          "PASS": { "state": "passed", "errorRequired": false },
          "NEEDS_APPROVAL": { "state": "needs-approval", "errorRequired": false },
          "BLOCKED": { "state": "blocked", "errorRequired": true, "allowedErrorCodes": ["MISSING_EVIDENCE", "INVALID_INPUT"] },
          "INCONCLUSIVE": { "state": "needs-input", "errorRequired": false }
        },
        "default": "reject"
      },
      "gate": { "kind": "precondition", "policy": "conditional" }
    }
  ]
}
```

baseline capture도 동결된 task envelope를 입력으로 받는 첫 workflow stage다. `plan_workflow` 뒤 첫 변경 전에 실행하고, verify stage는 구현 뒤 acceptance 검증 전에 둔다. 범위 확대 승인이 필요하면 기존 결과를 덮어쓰지 않고 task contract, workflow plan과 baseline을 새로 만든다.

#### 완료 기준

- staged, unstaged, untracked, rename, delete와 type change를 모두 분류한다.
- 기존 변경 미침범 판정은 검증된 baseline이 있을 때만 허용한다.
- 원문 코드와 전체 diff를 baseline에 저장하지 않는다.
- 어떤 결과에서도 사용자의 변경을 되돌리거나 수정하지 않는다.
- Windows와 Ubuntu에서 같은 논리 판정을 낸다.

### 4.4 `acceptance-evidence-validator`

#### 목적과 경계

`TaskEnvelope.v1.acceptanceCriteria`의 각 항목을 고정된 구현 대상과 실제 검증 결과에 연결해 충족, 실패, 증거 부족을 판정한다.

이 스킬은 구현자와 검증자의 분리를 요구하지 않으며, 수용 기준 밖의 보안·복구·운영 위험까지 확장하지 않는다. 릴리스 승인과 고위험 완료 판정은 `independent-audit-gate`가 맡는다. 모호한 기준은 임의로 해석하지 않고 `task-contract` 재정리 대상으로 돌린다.

#### 독립 입력과 출력

입력 `AcceptanceEvidenceInput.v1`:

```text
taskEnvelope
target
  kind, identifier, digest
evidence[]
verificationCommands[]
knownLimitations[]
criterionOverrides[]
```

출력 `AcceptanceEvidenceReport.v1`:

```text
target
criteria[]
  criterionId
  statement
  status: satisfied | unsatisfied | insufficient-evidence | not-applicable
  evidenceRefs[]
  observedResult
  rationale
unresolvedCriteria[]
limitations[]
verdict: PASS | FAIL | BLOCKED
```

모든 기준이 충족됐거나 명시적 근거로 제외된 경우만 `PASS`다. 확인된 실패가 하나라도 있으면 `FAIL`, 현재 대상의 증거가 부족하면 `BLOCKED`다. 통과율이나 가중 평균은 사용하지 않는다.

#### 구현 파일

```text
references/evidence-protocol.md
scripts/validate-report.mjs
contracts/acceptance-evidence-input.v1.schema.json
contracts/acceptance-evidence-report.v1.schema.json
contracts/upstream/task-envelope.v1.schema.json
contracts/upstream/lock.json
tests/fixtures/{passing,failed,missing,stale,not-applicable}/
```

`validate-report.mjs`는 기준과 보고서의 일대일 대응, 대상 digest 일치, 충족 기준의 검증된 evidence, `not-applicable` 근거, 전체 verdict와 개별 상태의 일관성을 확인한다. 테스트를 대신 실행하거나 파일을 수정하지 않는다.

#### 통합 준비

```json
{
  "capabilities": ["acceptance-evidence-validation"],
  "executionClass": "workflow",
  "phase": "acceptance-verification",
  "phaseOrder": 70,
  "requiredInputArtifacts": ["task-envelope", "acceptance-evidence-plan", "target-identifier", "evidence-sources"],
  "producedArtifacts": ["acceptance-evidence-report", "verified-evidence-index"],
  "outputSchema": "contracts/acceptance-evidence-report.v1.schema.json",
  "resultSchema": "integration/provider-result.v1.schema.json",
  "stateMapping": {
    "selector": "/output/verdict",
    "values": {
      "PASS": { "state": "passed", "errorRequired": false },
      "FAIL": { "state": "failed", "errorRequired": true, "allowedErrorCodes": ["GATE_FAILED"] },
      "BLOCKED": { "state": "blocked", "errorRequired": true, "allowedErrorCodes": ["MISSING_EVIDENCE"] }
    },
    "default": "reject"
  },
  "gate": { "kind": "completion", "policy": "conditional" }
}
```

`acceptance-evidence-report`가 `PASS`이고 미해결 기준이 없을 때만 stage를 `passed`로 기록한다. high/critical workflow에서는 이 stage 뒤에 독립 감사를 그대로 둔다.

#### 완료 기준

- 각 수용 기준에 안정적인 ID와 현재 대상의 근거가 연결된다.
- stale evidence와 다른 commit·artifact의 결과를 현재 근거로 인정하지 않는다.
- 실패와 증거 부족을 구분한다.
- `PASS` 보고서에 미해결 기준이나 실패 기준이 들어갈 수 없다.
- 독립 호출에서 기준별 판정표만 요청한 경우 릴리스 승인을 덧붙이지 않는다.

### 4.5 `blocker-diagnostician`

#### 목적과 경계

반복되는 실패를 관측 가능한 episode와 원인 가설로 분리하고, 가설을 가장 잘 구분하는 다음 검사를 정한다. 원인은 직접 증거가 있을 때만 확정한다.

이 스킬은 수정, 설정 변경과 배포를 수행하지 않는다. 같은 오류 메시지를 같은 원인으로 단정하지 않고, 새 정보 없이 같은 검사를 반복하지 않는다. 여러 해결안의 정책·비용·안전성 판단이 필요하면 그 시점부터 `independent-deliberation-panel`의 영역이다.

#### 독립 입력과 출력

입력 `FailureEpisodeSet.v1`:

```text
objective, expectedBehavior
episodes[]
  attemptId, operation, stableFailureTuple, environmentDigest,
  changeSummary, evidenceRefs
lastKnownGood?
constraints, authorization
attemptedChecks[]
```

출력 `DiagnosisReport.v1`:

```text
failureClusters[]
observations[]
hypotheses[]
  id, causalLayer, supportingEvidence, contradictingEvidence
  state: open | supported | refuted | confirmed
nextDiscriminatingTest
  question, preconditions, risk, requiredAuthorization
  outcomes[], stopCondition
confirmedCause?
recommendedNextAction
verdict: CAUSE_CONFIRMED | NEXT_TEST | NEEDS_INPUT |
         NEEDS_APPROVAL | BLOCKED
```

#### 구현 파일

```text
references/diagnosis-protocol.md
scripts/cluster-failures.mjs
scripts/validate-report.mjs
contracts/failure-episode-set.v1.schema.json
contracts/diagnosis-report.v1.schema.json
tests/fixtures/{same-failure,similar-message,different-environment,confirmed,approval-needed}/
```

`cluster-failures.mjs`는 caller가 제공한 안정적인 tuple을 canonical JSON과 SHA-256으로 묶는다. 시각, 임시 경로, 무작위 ID는 fingerprint에서 제외하되 오류 코드와 환경 차이는 보존한다. `validate-report.mjs`는 열린 가설의 근거, 판별 가능한 예상 결과, 중복 검사 금지, 상태 변경 검사의 권한과 중단 조건을 확인한다.

#### 통합 준비

```json
{
  "capabilities": ["blocker-diagnosis"],
  "executionClass": "recovery",
  "phase": "failure-diagnosis",
  "phaseOrder": 10,
  "requiredInputArtifacts": ["failure-episodes", "expected-behavior", "diagnostic-constraints"],
  "producedArtifacts": ["diagnosis-report"],
  "outputSchema": "contracts/diagnosis-report.v1.schema.json",
  "resultSchema": "integration/provider-result.v1.schema.json",
  "stateMapping": {
    "selector": "/output/verdict",
    "values": {
      "CAUSE_CONFIRMED": { "state": "passed", "errorRequired": false },
      "NEXT_TEST": { "state": "passed", "errorRequired": false },
      "NEEDS_INPUT": { "state": "needs-input", "errorRequired": false },
      "NEEDS_APPROVAL": { "state": "needs-approval", "errorRequired": false },
      "BLOCKED": { "state": "blocked", "errorRequired": true, "allowedErrorCodes": ["MISSING_EVIDENCE", "MCP_UNAVAILABLE"] }
    },
    "default": "reject"
  },
  "gate": { "kind": "none", "policy": "none" }
}
```

현재 MCP는 실패한 run에 stage를 삽입하거나 되살리지 않는다. 기존 run ID, revision, 실패 stage를 증거로 참조하되 진단은 별도 recovery workflow에서 수행한다.

#### 완료 기준

- 겉으로 비슷하지만 tuple이나 환경이 다른 실패를 별도 cluster로 유지한다.
- 원인 확정에는 직접 증거가 필요하다.
- `NEXT_TEST`에는 둘 이상의 구별 가능한 예상 결과와 중단 조건이 있다.
- 이미 수행한 검사를 새 정보 없이 다시 제안하지 않는다.
- 승인 대상 검사는 실행하지 않고 `needs-approval`로 반환한다.

## 5. P1 스킬

### 5.1 `workspace-convention-profiler`

#### 목적과 경계

낯선 저장소의 구조, 도구, 관례, 정의된 검증 명령과 변경 후보 지점을 읽기 전용으로 조사한다. 관측 사실, 복수 사례에서 얻은 추론, 확인할 수 없는 항목을 구분한다.

`AGENTS.md` 적용 판정은 `instruction-scope-resolver`, 작업 범위 확정은 `task-contract`, 현재 diff 판정은 `change-scope-guardian`이 맡는다. profiler는 의존성 설치, 빌드, 테스트와 포맷을 실행하거나 새로운 관례를 선언하지 않는다.

#### 독립 입력과 출력

입력 `WorkspaceProfileRequest.v1`:

```text
workspaceRoot, taskObjective, targetPaths[]
resolvedInstructionRefs[]
knownConstraints[]
evidenceLimits
```

출력 `WorkspaceConventionProfile.v1`:

```text
workspace: root, vcsType, currentRef, dirtyState
ecosystems[]: language, packageManager, manifestRefs
structure[]: role, paths, evidenceRefs
conventions[]: subject, observedPattern, confidence, evidenceRefs
commands[]: purpose, command, workingDirectory, sourceRef
changeHotspots[]
generatedOrVendoredPaths[]
openQuestions[], limitations[]
profileFingerprint, observedAt
verdict: PASS | BLOCKED
```

#### 구현 파일

```text
references/discovery-rules.md
references/evidence-confidence.md
scripts/profile-workspace.mjs
scripts/validate-profile.mjs
contracts/workspace-profile-request.v1.schema.json
contracts/workspace-convention-profile.v1.schema.json
tests/fixtures/{node-monorepo,python,mixed,dirty,sparse,nested}/
```

수집 스크립트는 매니페스트·CI·구성 파일 allowlist, Git ref와 porcelain status, workspace 구조, 선언된 build/test/lint/dev 명령, 대상 주변 코드·테스트 위치와 근거 checksum을 반환한다. 비밀 파일, `.git`, dependency 디렉터리, 생성물과 크기 제한 초과 파일은 읽지 않는다.

#### 통합 준비

```json
{
  "capabilities": ["workspace-convention-profiling"],
  "executionClass": "bootstrap",
  "phase": "workspace-discovery",
  "phaseOrder": 20,
  "requiredInputArtifacts": ["task-objective", "workspace-root"],
  "producedArtifacts": ["workspace-convention-profile", "convention-evidence-index", "validation-command-map"],
  "outputSchema": "contracts/workspace-convention-profile.v1.schema.json",
  "resultSchema": "integration/provider-result.v1.schema.json",
  "stateMapping": {
    "selector": "/output/verdict",
    "values": {
      "PASS": { "state": "passed", "errorRequired": false },
      "BLOCKED": { "state": "blocked", "errorRequired": true, "allowedErrorCodes": ["MISSING_EVIDENCE", "INVALID_INPUT"] }
    },
    "default": "reject"
  },
  "gate": { "kind": "none", "policy": "none" }
}
```

profile의 `changeHotspots`는 task 범위를 자동 확대하는 근거가 아니라 후보 정보다. 관련 매니페스트·지침·CI가 바뀌면 fingerprint를 다시 계산하고 이전 profile을 stale로 처리한다.

#### 완료 기준

- fixture에서 같은 구조·명령·근거와 fingerprint를 결정적으로 만든다.
- `confirmed` 관례에는 모두 evidence locator가 있다.
- 문서와 CI의 명령이 다르면 어느 한쪽을 지우지 않고 충돌로 남긴다.
- dirty worktree를 관측해도 변경하지 않는다.
- Git이 아닌 디렉터리와 여러 생태계가 섞인 저장소를 처리한다.

### 5.2 `mutation-risk-preflight`

#### 목적과 경계

삭제, 덮어쓰기, 대량 이동, 배포, 공개 게시, 마이그레이션, 권한·결제·전역 설정 변경 전에 정확한 대상, 권한, 승인, 영향 범위와 복구 수단을 확인한다.

실제 mutation은 수행하지 않는다. 승인이나 권한을 대신 만들지 않으며, 변경 뒤의 최종 diff와 릴리스 가능성도 판정하지 않는다. 변경 후 독립 감사와 역할이 다르다.

| 구분 | `mutation-risk-preflight` | `independent-audit-gate` |
| --- | --- | --- |
| 시점 | 실제 상태 변경 직전 | 변경·검증 완료 후 |
| 질문 | 이 대상에 이 행동을 시작해도 되는가 | 이 최종 결과를 완료·릴리스해도 되는가 |
| 핵심 근거 | 대상, 승인, 복구, blast radius | 최종 diff·artifact, 검증, 발견사항 |
| 독립 감사자 | 필수 아님 | 구현자와 분리해 필수 |
| 서로 대체 | 불가 | 불가 |

#### 독립 입력과 출력

입력 `MutationIntent.v1`:

```text
operationId
actionClass
targets[]
  locator, targetType, environment, expectedFingerprint
plannedCommandOrTool
scopeRef, authorizationRef
approvalEvidenceRefs[], currentStateEvidenceRefs[]
recoveryPlan
expectedBlastRadius
```

출력 `MutationPreflightReport.v1`:

```text
operationId, actionDigest, targetDigest
classification
checks[]
approval: required, status, evidenceRefs
recovery: available, restoreTested, evidenceRefs
blastRadius, unresolved[]
invalidationTriggers[], validUntil, observedAt
verdict: READY | NEEDS_INPUT | NEEDS_APPROVAL |
         NEEDS_REDESIGN | BLOCKED
```

광범위한 환경변수, 해석되지 않은 glob, `~`, 홈 디렉터리나 저장소 루트 전체 같은 대상은 `READY`가 될 수 없다.

#### 구현 파일

```text
references/risk-matrix.md
references/approval-and-authority.md
references/recovery-requirements.md
scripts/evaluate-preflight.mjs
scripts/verify-preflight-receipt.mjs
contracts/mutation-intent.v1.schema.json
contracts/mutation-preflight-report.v1.schema.json
contracts/upstream/task-envelope.v1.schema.json
contracts/upstream/lock.json
tests/fixtures/{local-delete,deploy,migration,permission,billing,broad-target}/
```

`evaluate-preflight.mjs`는 행동별 필수 필드, canonical target, fingerprint, 승인 범위, recovery evidence와 digest를 검사한다. `verify-preflight-receipt.mjs`는 실행 직전에 대상·환경·승인·fingerprint와 action digest가 그대로인지 재확인한다.

#### 통합 준비

```json
{
  "capabilities": ["mutation-risk-preflight"],
  "executionClass": "workflow",
  "phase": "pre-mutation-gate",
  "phaseOrder": 45,
  "requiredInputArtifacts": ["mutation-intent", "task-envelope", "authorization-boundary", "current-target-state"],
  "producedArtifacts": ["mutation-preflight-report", "approved-target-digest", "recovery-evidence"],
  "outputSchema": "contracts/mutation-preflight-report.v1.schema.json",
  "resultSchema": "integration/provider-result.v1.schema.json",
  "stateMapping": {
    "selector": "/output/verdict",
    "values": {
      "READY": { "state": "passed", "errorRequired": false },
      "NEEDS_INPUT": { "state": "needs-input", "errorRequired": false },
      "NEEDS_APPROVAL": { "state": "needs-approval", "errorRequired": false },
      "NEEDS_REDESIGN": { "state": "needs-redesign", "errorRequired": false },
      "BLOCKED": { "state": "blocked", "errorRequired": true, "allowedErrorCodes": ["INVALID_INPUT", "MISSING_EVIDENCE"] }
    },
    "default": "reject"
  },
  "gate": { "kind": "precondition", "policy": "conditional" }
}
```

현재 MCP의 `mandatory`는 독립 감사 전용 검사를 수행하므로 이 스킬에는 사용하지 않는다. 통합 전에는 gate를 `kind`, `policy`, `validator`로 일반화해 precondition gate와 completion audit를 구분해야 한다. MCP가 외부 mutation 도구를 중개하지 않는 한 stage 전이는 막을 수 있어도 임의의 외부 실행 자체를 기술적으로 막는다고 표현하지 않는다.

#### 완료 기준

- 모든 `READY`에 정확한 action·target digest와 근거가 있다.
- 대상, 환경, 승인, fingerprint가 바뀌면 이전 receipt 검증이 실패한다.
- 실제 mutation을 실행하는 코드가 없다.
- `READY`가 권한이나 승인으로 오해되지 않도록 behavior test가 확인한다.
- 고위험 흐름에서 preflight와 독립 감사가 각각 빠지면 통합 완료가 거부된다.

## 6. 오케스트레이션 플러그인 편입 전 공통 변경

스킬 자체를 완성하는 동안 다음 변경은 Agent Governance Suite에서 별도 작업으로 준비한다. 독립 스킬 저장소가 이 작업을 기다릴 필요는 없다.

### 6.1 descriptor와 stage 계약 일반화

현재 문자열 `phase`와 `TaskEnvelope.requiredCapabilities` 배열 순서만으로는 새 단계의 위치를 안정적으로 정하기 어렵다. 다음 필드를 registry 계약에 추가한다.

```text
enabled
capabilities[]
priority
executionClass
phaseOrder
requiredInputArtifacts[]
inputBindings[]
  targetArtifact
  sources[]
  operation: select | collect | combine | require-external
producedArtifacts[]
outputSchema
resultSchema
stateMapping
  selector: JSON Pointer 또는 제한된 JSONPath
  values: 독립 판정 값 → { state, errorRequired, allowedErrorCodes[] }
  default: 판정 필드가 없는 성공 결과의 매핑 또는 reject
  adapterErrors: output 생성 전 blocked로 허용할 오류 코드
gate
  kind: none | precondition | completion
  policy: none | conditional | mandatory
  validator: schema ID 또는 capability
```

MCP는 스킬 이름이 아니라 descriptor와 artifact dependency를 이용해 위상 정렬한다. `priority`는 같은 capability provider 간 선택에만 사용한다.

기존 registry는 다음 값으로 이행한다. 기존 `capabilities[]`, `priority`, `enabled`는 보존한다. `requiredArtifacts`는 `requiredInputArtifacts`로 이름을 바꾸되, 각 입력의 생산자와 투영 규칙을 아래 `inputBindings`에 함께 명시한다.

| 기존 스킬 | `executionClass` | `phaseOrder` | `gate` |
| --- | --- | ---: | --- |
| `coordinate-subagents` | `workflow` | 35 | `{ "kind": "none", "policy": "none" }` |
| `independent-deliberation-panel` | `workflow` | 40 | `{ "kind": "none", "policy": "none" }` |
| `independent-audit-gate` | `workflow` | 90 | `{ "kind": "completion", "policy": "mandatory" }` |

현재 `riskGate: conditional`은 “조건에 맞으면 스킬을 선택한다”는 routing 의미와 “선택된 stage가 후속 전이를 막는다”는 gate 의미가 섞여 있다. 이행 후 선택 조건은 `selectionCriteria`에만 두고, 실제 전이 강제만 `gate`에 둔다. 세 기존 스킬도 각 결과 schema와 `stateMapping`을 명시하며, 이를 정하지 않은 descriptor는 v2 registry 검증에서 거부한다.

기존 세 스킬의 입력 이름은 단순 rename하지 않고 descriptor의 `inputBindings`로 다음처럼 투영한다. MCP는 `select`, `collect`, `combine`, `require-external` 네 연산만 일반적으로 구현하고, 아래 규칙은 registry data로 둔다.

| 기존 스킬의 입력 artifact | source artifact와 투영 | 누락 처리 |
| --- | --- | --- |
| `coordinate-subagents:task-request` | `task-envelope`의 objective, scope, acceptance criteria를 `select` | `MISSING_EVIDENCE` |
| `coordinate-subagents:execution-unit-inventory` | `task-envelope.workUnits`를 ID, dependency, write target 보존 상태로 `select` | 빈 목록이면 스킬 미선택 |
| `coordinate-subagents:constraints` | `task-envelope.constraints`, authorization와 `instruction-scope-resolution`의 활성 제한을 `combine` | authorization이 없으면 `INVALID_INPUT` |
| `independent-deliberation-panel:case-brief` | `task-envelope`, `task-contract-report`의 provenance·ambiguity를 `combine` | `MISSING_EVIDENCE` |
| `independent-deliberation-panel:evidence-sources` | 사용자 evidence, `instruction-scope-resolution`, 선택적 `workspace-convention-profile`을 `collect` | 직접 검사 가능한 source가 없으면 `MISSING_EVIDENCE` |
| `independent-deliberation-panel:constraints` | `task-envelope.constraints`와 authorization을 `combine` | `INVALID_INPUT` |
| `independent-audit-gate:final-target-identifier` | `acceptance-evidence-report.target`을 `select` | `MISSING_EVIDENCE` |
| `independent-audit-gate:final-diff-or-artifact-digest` | acceptance target digest와 `change-scope-report`의 최종 digest를 `combine`하고 일치 확인 | 불일치하면 `STALE_REVISION` |
| `independent-audit-gate:raw-verification-results` | `verified-evidence-index`의 locator를 `collect` | 원자료를 다시 열 수 없으면 `MISSING_EVIDENCE` |
| `independent-audit-gate:rollback-or-recovery-evidence` | mutation이 있으면 `recovery-evidence`, 없으면 명시적 외부 artifact를 `require-external` | high/critical run에서는 누락 시 `MISSING_EVIDENCE` |

이 투영은 coarse `workUnits`를 실행 task graph로 바꾸거나 evidence 내용을 새로 생성하지 않는다. source artifact의 digest를 binding 결과에 포함해 입력이 바뀌면 계획을 stale로 만든다.

### 6.2 schema 기반 결과 검증

`plan_workflow`는 선택한 `outputSchema`, `resultSchema`와 `stateMapping`의 경로·checksum을 `WorkflowPlan.v1`에 넣고 함께 서명한다. `resultSchema`는 성공·중간·실패 결과를 모두 표현하는 `ProviderResult.v1` envelope이며, `outputSchema`는 envelope 안에 실제 보고서가 있을 때만 적용한다. `record_stage_result`는 다음을 확인한다.

- 필수 입력 artifact가 이전 bootstrap receipt 또는 stage 결과에 존재하는가
- provider envelope가 `resultSchema`를 통과하고, output이 있으면 `outputSchema`도 통과하는가
- descriptor의 `stateMapping`으로 계산한 상태와 `StageResult.state`가 일치하는가
- `failed`와 `blocked`에 error가 있고 그 code가 mapping의 `allowedErrorCodes`에 포함되는가
- `passed`에서는 descriptor의 모든 `producedArtifacts`가 정확히 한 번 존재하고, 각 artifact의 ID·schema·target digest가 선언과 일치하며 locator와 digest가 실제로 검증됐는가
- 비성공 상태의 부분 artifact를 현재 stage의 진단 근거로만 보존하고 후속 `inputBindings`의 source로 등록하지 않았는가
- target, baseline, profile, preflight digest가 stale하지 않은가
- precondition gate가 통과하기 전에 후속 mutation stage를 기록하지 않는가

검사 로직은 skill ID별 조건문으로 추가하지 않는다.

### 6.3 bootstrap receipt

`instruction-scope-resolver`, `workspace-convention-profiler`, `task-contract`는 run 생성 전에 실행된다. 이 결과를 잃지 않도록 `BootstrapReceipt.v1`을 추가한다.

```text
taskId
steps[]
  capability, provider, artifactRefs, state
taskEnvelopeDigest
registryDigest
receiptId
expiresAt
integrityToken
createdAt
```

caller가 receipt를 자체 작성할 수 없도록 `plan_workflow`가 원시 bootstrap 결과, artifact schema, evidence reference와 state mapping을 먼저 검증한 뒤 receipt를 발급한다. MCP 프로세스는 시작할 때 임시 비밀키를 만들고 receipt 본문에 HMAC-SHA-256 `integrityToken`을 붙인다. 원시 코드와 전체 로그는 저장하지 않으며 receipt ID, digest, 만료 시각과 사용 여부만 메모리에 보관한다.

`start_workflow`는 token, 만료, 미사용 상태, registry digest와 `TaskEnvelope.v1` digest를 모두 확인한 뒤 receipt를 한 번만 소비한다. 서버 재시작 뒤 임시 키와 메모리 상태가 사라진 receipt는 `RUN_NOT_FOUND`로 거부하고 bootstrap부터 다시 수행한다. 사용자가 task contract만 요청한 경우에는 구조화된 독립 결과만 반환하며, 실행 계획이나 receipt 발급을 요청하지 않은 한 `plan_workflow`를 호출하지 않는다.

### 6.4 import와 source lock

각 스킬 원본 저장소에서 다음 조건을 만족한 tag만 편입한다.

- clean worktree에서 만든 서명 또는 고정 tag/commit
- 독립 검증 결과와 CI run
- `integration/skill-descriptor.json`과 계약 checksum
- 생성물, 평가 결과, `.git`, dependency cache 제외

`import:skill`은 `integration/`을 allowlist에 추가하고, descriptor를 registry 형식으로 변환한 뒤 source, ref, commit과 파일 checksum을 `skills/source-lock.json`에 기록한다. 원본 저장소와 모노레포의 양방향 자동 동기화는 하지 않는다.

## 7. 구현 순서

### 단계 A — 독립 스킬 공통 골격

1. 일곱 저장소의 이름, license, Node.js 22 기준과 공통 JSON CLI 규약을 정한다.
2. 각 저장소에 `SKILL.md`, `agents/openai.yaml`, `contracts/`, `integration/`, `tests/` 기본 구조를 만든다.
3. 정상·경계·예상 실패 fixture 형식과 독립 forward-test 절차를 통일한다.
4. suite 의존 import가 없는지 검사하는 테스트를 둔다.

### 단계 B — P0 기반 계약

1. `instruction-scope-resolver`를 구현해 유효 지침과 충돌 근거를 확정한다.
2. `task-contract`를 구현해 `TaskEnvelope.v1`과 수용 근거 계획을 만든다.
3. `change-scope-guardian`의 baseline capture와 verify를 구현한다.
4. `acceptance-evidence-validator`로 기준별 완료 판정을 구현한다.
5. `blocker-diagnostician`으로 실패 분류와 recovery workflow 입력을 구현한다.

P0의 최소 연결은 다음 artifact chain으로 검증한다.

```text
instruction-scope-resolution
  → task-envelope + acceptance-evidence-plan
  → workspace-baseline
  → change-scope-report
  → acceptance-evidence-report
```

### 단계 C — P1 문맥과 사전 위험 점검

1. `workspace-convention-profiler`를 구현하고 instruction resolution을 선택 입력으로 받는다.
2. profiler 결과가 task 범위를 자동 확대하지 않는지 검증한다.
3. `mutation-risk-preflight`와 receipt 재검증을 구현한다.
4. preflight `READY`와 실제 권한·승인이 구분되는지 forward test한다.

### 단계 D — 각 스킬 독립 릴리스

각 저장소에서 validator, 테스트, Windows·Ubuntu CI와 direct-call 평가를 통과한 뒤 `v0.1.0` tag를 만든다. 한 스킬의 실패 때문에 이미 준비된 다른 스킬의 독립 릴리스를 묶어두지 않는다.

### 단계 E — 플러그인 편입

1. Agent Governance Suite의 descriptor, bootstrap receipt, artifact schema와 일반 gate 변경을 먼저 완료한다.
2. P0 스킬을 clean tag 단위로 편입한다.
3. 기존 세 스킬과 P0의 통합·실패 전파 회귀 테스트를 통과시킨다.
4. P1 스킬을 편입하고 preflight·audit 분리와 stale receipt를 검증한다.
5. MCP가 없는 환경에서 일곱 스킬의 직접 호출이 계속 가능한지 확인한다.

## 8. 통합 테스트 시나리오

| 시나리오 | 기대 결과 |
| --- | --- |
| 하위 override가 있는 두 경로 변경 | 경로별 instruction chain을 분리하고 task contract에 각각 연결 |
| dirty worktree의 제한된 수정 | baseline 이전 변경은 보존하고 overlap만 `needs-approval` |
| 단순 읽기 요청 | task contract만 만들고 mutation·scope·audit 스킬은 선택하지 않음 |
| 일반 코드 변경 | scope verify 뒤 acceptance evidence가 모두 충족돼야 완료 가능 |
| production schema migration | preflight `READY`, 실행 검증, scope·acceptance 확인, 독립 감사 `PASS`가 모두 필요 |
| preflight 뒤 target fingerprint 변경 | 기존 receipt를 stale로 거부하고 새 preflight 요구 |
| 테스트 반복 실패 | 원 run을 변경하지 않고 별도 blocker diagnosis workflow 생성 |
| acceptance test가 다른 commit에서 실행됨 | stale evidence로 `BLOCKED` |
| MCP 사용 불가 | 통합 run만 `BLOCKED`, 각 스킬의 직접 결과는 계속 제공 |
| 새 capability provider 편입 | descriptor만 등록해 선택·순서·schema 검증, MCP 소스의 skill ID 변경 없음 |

## 9. 최종 완료 기준

일곱 스킬 전체 계획은 다음 조건을 모두 충족했을 때 완료로 본다.

- 각 스킬이 자기 목적에 맞는 질문을 독립적으로 끝까지 처리한다.
- 각 스킬의 적용·제외 조건이 기존 세 스킬과 겹치지 않는다.
- 모든 결정적 로직에 Windows·Ubuntu 테스트가 있다.
- 직접 호출은 MCP와 Agent Governance Suite 설치를 요구하지 않는다.
- integration descriptor를 제거해도 독립 스킬 기능은 그대로 동작한다.
- clean tag와 checksum으로만 플러그인에 편입한다.
- 오케스트레이터와 MCP는 스킬 ID별 코드를 추가하지 않고 capability, phase, artifact와 schema로 연결한다.
- preflight, scope 검사, acceptance 검증과 independent audit의 판정 범위를 서로 대신하지 않는다.
- 실패한 run을 사후 수정하지 않고 blocker 진단과 재실행을 별도 workflow로 추적한다.
- 각 스킬의 독립 테스트와 플러그인 통합 회귀 테스트를 모두 통과한다.
