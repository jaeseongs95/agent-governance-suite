# Agent Governance Suite 향후 로드맵

문서 기준일은 2026년 9월 13일이다. 현재 공개 릴리스는 `v1.0.5`이며, 작업 트리의 `v1.1.0` 후보는 한국어 산문 워크플로의 품질 게이트를 통과하지 못해 아직 릴리스 대상으로 승인되지 않았다.

이 문서는 프로젝트 코드와 설계 문서뿐 아니라 이 저장소에서 진행한 Codex 작업의 논의를 함께 반영한다. 일정은 특정 날짜보다 단계별 종료 조건을 기준으로 관리한다. 각 단계의 필수 검증을 마치기 전에는 다음 릴리스 범위로 넘기지 않는다.

## 목표

향후 개발은 다음 순서로 진행한다.

1. 진행 중인 `v1.1.0` 후보를 안정화하고 한국어 산문 품질 게이트를 통과한다.
2. 평가 결과의 신뢰성과 여러 Codex 작업 사이의 변경 충돌을 먼저 통제한다.
3. 반복 실패 뒤에 사용할 복구 워크플로를 정식 실행 경로로 추가한다.
4. 실행 환경의 기능 확인과 세션 연속성을 공통 인프라로 제공한다.
5. bootstrap 증거와 외부 증거의 신뢰 경계를 강화한다.
6. 원본 스킬 동기화와 릴리스 운영을 자동화한다.

## 계획 원칙

- 하나의 전문 스킬은 독립 호출 가치가 있는 한 가지 역할만 맡는다. 오케스트레이터는 요청 분류, 실행 순서, 입출력 연결과 결과 통합에 집중한다.
- 자연어 지침에만 의존하지 않고, 반드시 지켜야 하는 순서와 무결성 조건은 계약이나 MCP 실행 계층에서 검사한다.
- 신규 기능보다 현재 릴리스 차단 사유와 평가 신뢰성 문제를 먼저 해결한다.
- 새 계약은 schema, registry descriptor, 정상·경계·실패 fixture와 회귀 테스트를 함께 추가한다.
- 여러 작업이 같은 작업 트리를 사용하는 경우, 기존 변경의 소유권과 예상 쓰기 경로를 확인하기 전에는 구현을 시작하지 않는다.
- 배포, 태그 생성과 공개 설치본 갱신은 별도 승인 대상이다. 이 로드맵의 단계 완료는 자동 배포 승인을 뜻하지 않는다.

## 단계 개요

| 단계 | 상태 | 목표 | 주요 결과물 |
| --- | --- | --- | --- |
| 0. `v1.1.0` 안정화 | 진행 중 | 한국어 산문 워크플로의 계약·품질·재현성 확보 | 검증된 receipt 경로, 품질 평가 결과, 고정된 원본 ref |
| 0.5. 업데이트 알림 | 구현 후보 | `v1.1.0` 릴리스 뒤 안정 버전 존재 여부만 안내 | `check_for_updates`, SQLite v2 상태, 일회성 MCP notice |
| 1. 실행 전 신뢰성 | 다음 | 평가 오류와 동시 작업 충돌을 조기에 차단 | `evaluation-validity-auditor`, `active-workspace-guard` |
| 2. 복구 워크플로 | 계획됨 | blocker 진단 뒤 선택 가능한 복구 전략 제공 | `recovery-strategy-selector`, `RecoveryHandoff.v1` |
| 3. 실행 환경과 연속성 | 설계 필요 | 실행 가능 여부를 먼저 확인하고 세션 복원을 표준화 | `runtime-capability-profiler`, continuity provider |
| 4. 신뢰 경계 강화 | 설계 후보 | bootstrap·증거·라우팅 선언의 신뢰 수준 향상 | `BootstrapReceipt.v1`, 증거 검증 경계 |
| 5. 공급망과 운영 | 보류 | 원본 편입과 버전·릴리스 관리를 자동화 | 동기화 검사, 업데이트 PR, 버전 단일 소스화 |

## 0단계: `v1.1.0` 후보 안정화

현재 진행 중인 한국어 산문 워크플로를 완료하는 단계다. 다른 신규 스킬을 추가하기 전에 이 단계의 변경 범위와 평가 결과를 고정한다.

### 구현 범위

- 선택, 편집, 검증, 최종화 단계가 같은 요청과 `edit-decision-set`을 참조하는지 끝까지 검사한다.
- receipt에는 원문이나 편집 결과 본문을 저장하지 않고 digest와 참조만 남긴다.
- 평가 cycle의 입력, 결과와 판정 근거를 재현할 수 있도록 canonical digest와 receipt 검증 경로를 확정한다.
- 품질 평가 fixture와 실제 사례에서 의미 보존을 유지하면서 개선율 기준 80% 이상을 충족한다.
- `korean-prose-editor`의 원본을 재현 가능한 공개 tag 또는 immutable commit으로 고정한다. 로컬 절대 경로는 공개 릴리스의 최종 source lock으로 사용하지 않는다.
- 공개 릴리스 버전, manifest, package, marketplace와 문서의 버전 표기가 서로 일치하는지 확인한다.

### 종료 기준

- 한국어 산문 workflow의 정상·경계·실패·원문 비저장 테스트가 모두 통과한다.
- 고정한 평가 계약과 holdout 결과가 품질 기준을 통과한다.
- `pnpm lint`, `pnpm build`, `pnpm test`, `pnpm bundle:check`, `pnpm validate:all`, `pnpm validate:official`, `pnpm runtime:check`가 통과한다.
- 릴리스 후보에 범위 밖 변경이나 다른 활성 작업의 미완료 변경이 포함되지 않는다.
- 위 근거를 기록한 뒤 별도의 공개 승인 절차로 넘긴다.

## 0.5단계: 플러그인 업데이트 알림

`v1.1.0`을 깨끗하게 릴리스한 뒤 별도 `v1.1.x` 유지보수 변경으로 반영한다. MCP 서버는 고정된 공개 저장소의 `vMAJOR.MINOR.PATCH` 안정 tag만 확인하며, 개별 원본 스킬이나 사용자 제공 URL은 확인하지 않는다.

- 성공 결과는 기존 SQLite DB에 24시간 동안 저장하고, 실패하면 마지막 성공 결과를 보존한 채 1시간 뒤 다시 시도한다.
- 설치된 버전보다 높은 안정 버전이 있을 때 MCP 응답에 `plugin-update-notice`를 붙이고, 같은 버전은 DB 전체에서 한 번만 안내한다.
- `check_for_updates`는 캐시 상태를 반환하며 `force: true`일 때만 TTL을 무시한다.
- 저장 항목은 버전, tag, commit, ETag, 비교 상태, 확인·재시도·안내 시각과 내부 오류 코드로 제한한다.
- 네트워크, 응답 검증이나 SQLite 기록 실패는 기존 workflow 도구의 성공·실패를 바꾸지 않는다.
- 알림은 업데이트를 설치하지 않는다. 플러그인 파일, 설치 캐시와 마켓플레이스 설정은 수정하지 않으며 `automaticInstall`은 항상 `false`다.

### 종료 기준

- SQLite v1에서 v2로 올려도 기존 run, revision, sequence와 계획 서명 키가 유지된다.
- 캐시, 강제 확인, 실패 재시도, SemVer 비교, 버전당 한 번 안내와 재시작 후 상태 복구 테스트가 통과한다.
- STDIO 통합 테스트에서 새 도구와 조건부 두 번째 notice block이 확인된다.
- 전체 릴리스 검증을 통과하고 `v1.1.0` 변경과 섞이지 않은 별도 변경으로 검토할 수 있다.

## 1단계: 평가와 작업 공간의 신뢰성 확보

평가가 잘못됐거나 다른 작업이 같은 파일을 수정하고 있다면 이후 단계의 완료 근거도 신뢰할 수 없다. 두 검사를 일반 구현보다 앞에 배치한다.

### `evaluation-validity-auditor`

스킬 평가의 입력, 판정 방법과 결과 집계가 공정하고 재현 가능한지 독립적으로 검사한다.

- 자기보고 결과만 증거로 제출했는지 확인한다.
- 문구 일치만으로 의미 보존이나 품질 향상을 판정하지 못하게 한다.
- 평가 시점에 사용할 수 없었던 사후 정보가 입력에 섞였는지 검사한다.
- 불완전한 JSONL이나 누락된 case를 전체 평가 결과로 집계하지 않는다.
- 동결된 rubric, fixture set, 실행 revision과 결과 digest를 하나의 평가 보고서에 결속한다.

계약 이름은 구현 시작 시 확정하되, `EvaluationValidityReport.v1`과 같은 독립 결과물을 우선 검토한다. 이 결과는 품질 게이트나 릴리스 승인 근거로 재사용할 수 있어야 한다.

### `active-workspace-guard`

변경을 시작하기 전에 동일 저장소를 사용하는 활성 Codex 작업과 예상 충돌을 검사한다.

- 작업의 `cwd`, 상태, 기준 revision, 예상 쓰기 경로와 실제 변경 경로를 비교한다.
- 경로가 겹치면 소유 작업과 변경 목적을 확인할 때까지 mutation을 차단한다.
- 경로가 겹치지 않으면 확인한 시점과 범위를 기록하고 작업을 계속한다.
- 작업이 길어지거나 기준 revision이 바뀌면 기존 판정을 그대로 재사용하지 않는다.

이 스킬은 Git 변경만 검사하는 `change-scope-guardian`을 대체하지 않는다. `active-workspace-guard`는 작업 간 충돌을 시작 전에 찾고, `change-scope-guardian`은 동결한 작업 범위와 실제 변경을 전후로 비교한다.

### 종료 기준

- 두 전문 스킬이 registry capability와 독립 계약을 갖는다.
- 정상 사례, 정보 부족, 충돌·오염 사례를 포함한 회귀 테스트가 있다.
- 오케스트레이터가 평가 작업과 mutation 작업에서 필요한 검사만 선택한다.
- 검사 실패나 불확실한 결과가 후속 mutation 또는 릴리스 승인으로 전달되지 않는다.

## 2단계: 복구 전략 선택 워크플로

`blocker-diagnostician`은 반복 실패의 관측 사실과 원인 가설을 분리하고 다음 판별 검사를 정한다. 진단 뒤 어떤 복구 경로를 선택할지는 별도의 `recovery-strategy-selector`가 맡는다.

### 구현 범위

- blocker 진단 결과를 입력으로 받아 서로 독립적인 복구 전략 2~3개를 만든다.
- 각 전략에 필요한 권한, 예상 변경 범위, 선행 조건, 검증 방법과 실패 영향을 기록한다.
- 필수 조건을 만족하지 못하는 전략은 점수 보정 없이 Objective Gate에서 제외한다.
- 둘 이상의 전략이 남은 경우에만 조건부 교차 검토를 수행한다.
- 선택 결과를 `RecoveryHandoff.v1`로 만들고, 후속 작업은 새 `TaskEnvelope.v1`과 새 workflow run으로 시작한다.
- provider는 `executionClass: recovery`를 사용하며 일반 workflow 단계와 섞지 않는다. 기존 논의의 `recovery-strategy-selection`, `phaseOrder: 20`은 구현 시 registry 충돌 여부를 다시 확인한다.

### 종료 기준

- 단일 생존 전략, 복수 전략, 모든 전략 탈락, 추가 승인 필요 사례를 모두 검증한다.
- 복구 결과가 기존 동결 계획을 몰래 수정하거나 실패한 run을 성공으로 바꾸지 않는다.
- `RecoveryHandoff.v1`의 근거와 선택 결과가 새 작업 계약까지 추적된다.

## 3단계: 실행 환경 확인과 컨텍스트 연속성

### `runtime-capability-profiler`

비용이 큰 실행이나 독립 감사를 시작하기 전에 실제 실행 환경이 요구 조건을 지원하는지 확인한다.

- 모델과 reasoning effort 지원 여부
- sandbox와 파일·네트워크 권한
- 사용 가능한 도구와 MCP 기능
- 구현자와 감사자의 실행 격리 가능 여부
- 관측하지 못한 항목의 `unobserved` 처리

결과는 `supported`, `unsupported`, `unobserved`를 구분해야 한다. 설정값이 존재한다는 이유만으로 실제 적용됐다고 판정하지 않는다.

### continuity provider

컨텍스트 연속성은 독립 판단 스킬보다 공통 인프라 provider로 구현한다. snapshot에는 최소한 다음 내용을 포함한다.

- objective와 completion criteria
- constraints와 decisions
- progress와 evidence refs
- blockers와 next actions
- task correlation, epoch, revision, digest와 updated time

compact, resume, startup, clear 이벤트에서 snapshot을 `INJECT`, `DEFER`, `REJECT` 중 하나로 처리한다. 현재 목표나 revision과 충돌하는 snapshot은 자동 병합하지 않고 사용자 판단으로 넘긴다.

### 종료 기준

- 지원 여부를 확인하지 못한 환경에서 고비용 workflow나 필수 감사를 시작하지 않는다.
- 재시작·요약 뒤에도 현재 revision과 일치하는 근거만 복원한다.
- 오래됐거나 다른 작업의 snapshot을 주입하는 회귀 사례가 거부된다.
- continuity 기능이 없어도 기존 단일 세션 workflow는 이전과 같이 동작한다.

## 4단계: bootstrap과 증거의 신뢰 경계 강화

현재 MCP 서버는 계획의 서명, 단계 순서, schema와 artifact 연결을 검사하지만 적대적인 호출자를 인증하는 보안 경계는 아니다. `verified`, 증거 locator와 actor ID의 실제 진위는 호출자와 전문 스킬을 신뢰한다.

### `BootstrapReceipt.v1`

- `plan_workflow` 전에 만든 지침 범위, 저장소 관례와 작업 계약을 하나의 bootstrap receipt에 결속한다.
- bootstrap 결과의 digest, 생성 주체, task correlation, revision과 유효 범위를 기록한다.
- HMAC 무결성과 일회성 소비를 검사한다.
- workflow 시작 뒤 다른 bootstrap 결과로 바꾸거나 오래된 receipt를 재사용하지 못하게 한다.

### 증거와 라우팅 강화

- `verified` boolean만 신뢰하지 않고, 가능한 provider에는 검증 가능한 digest 또는 외부 attestation을 요구한다.
- 감사 보증 수준을 `cooperative-sealed`, `native-atomic`, `external-attested`처럼 명시한다. 지원하지 않는 보증을 성공으로 표시하지 않는다.
- 자연어 `selectionCriteria`를 MCP가 임의로 해석하지 않는다. 자동 분기가 필요한 조건은 구체적인 capability, 구조화된 routing input 또는 결정적 policy로 옮긴다.
- 신원 인증과 원본 증거 검증이 필요한 위협 모델은 별도 신원·증거 저장소와의 연동 범위로 분리한다.

### 종료 기준

- bootstrap receipt 변조, 재사용, revision 불일치가 거부된다.
- 각 완료 영수증이 어떤 보증 수준에서 만들어졌는지 식별할 수 있다.
- caller-trusted 값과 실제로 검증한 값을 결과에서 구분한다.
- 기존 신뢰 모델을 사용하는 로컬 workflow의 호환 정책과 마이그레이션 절차가 문서화된다.

## 5단계: 공급망과 릴리스 운영

프로젝트 구조와 기능이 안정된 뒤 원본 스킬 편입과 릴리스 유지보수를 자동화한다. 이 단계의 정책은 구현 전에 다시 확정한다.

### 후보 작업

- suite 안에서 편입 스킬을 직접 수정했는지 CI에서 검사하고, 원본 commit과 checksum을 다시 비교한다.
- 원본 tag, `SKILL.md` metadata version, registry version과 source lock의 full SHA 일치를 검사한다.
- 원본 저장소에 새 tag가 생기면 검증용 업데이트 PR을 만든다.
- manifest, package, marketplace, README와 서버에 흩어진 플러그인 버전을 단일 소스에서 생성한다.
- SQLite receipt의 보존 기간, 삭제 절차, 접근 권한과 필요 시 암호화 정책을 정한다.

### 종료 기준

- 같은 원본 ref로 언제든 동일한 번들을 재구성할 수 있다.
- 버전 불일치와 원본 이탈이 릴리스 전에 자동으로 차단된다.
- 자동 생성된 업데이트 PR도 기존 전체 검증과 독립 감사 조건을 건너뛰지 않는다.

## 당분간 보류하는 항목

- `resource-profile.v1`을 이용한 요금제·잔여 사용량 기반 자동 모델 배분은 필수 로드맵에서 제외한다. 현재는 작업마다 품질, 균형, 절약 중 우선순위를 사용자가 선택하는 방식을 유지한다.
- MCP 도구는 설정으로 활성화 여부를 조절할 수 있지만 Codex의 플러그인 스킬별 on/off는 저장소만으로 해결하기 어려운 플랫폼 기능이다.
- SQLite 암호화와 자동 만료는 보안 요구가 확정되기 전까지 5단계 후보로 둔다. 현재는 평문 receipt 저장과 운영자 관리라는 제한을 문서에 계속 명시한다.
- 공급망 자동화 정책은 프로젝트가 개발 중이라는 기존 결정을 존중해 기능 안정화 뒤 확정한다.

## 공통 구현 단위

각 신규 전문 스킬이나 provider는 다음 단위를 한 묶음으로 구현한다.

1. 적용 조건, 제외 조건, 입력, 출력과 실패 처리를 정의한 `SKILL.md`
2. 독립 저장소 또는 고정 가능한 원본 ref
3. 입력·출력 JSON Schema와 `ProviderResult.v1` adapter
4. `skills/registry.json`의 capability, artifact binding, state mapping과 gate
5. 정상, 경계, 예상 실패 fixture와 회귀 테스트
6. 오케스트레이터 선택·순서·실패 전파 테스트
7. source lock, manifest, README와 아키텍처 문서 갱신
8. 전체 검증 결과와, 위험도가 높을 경우 구현자와 분리된 감사 결과

## 기획 근거

이 로드맵은 다음 프로젝트 작업에서 나온 결론을 통합했다.

- [workflow-guard 아이디어 정리](codex://threads/01a08681-45b5-7a63-840d-2ea89fef4fd7): 증거 참조, 동결 계획, capability routing, artifact DAG, 감사 freshness, recovery 분리와 source lock
- [세션 내용의 스킬 추가 검토](codex://threads/01a0866c-69bd-7280-a42a-242f58d770f1): `recovery-strategy-selector`와 `RecoveryHandoff.v1`
- [codex-context-continuity 스킬화 검토](codex://threads/01a0866e-cb36-76a0-87c2-d29eeb84d576): continuity snapshot과 provider 경계
- [스킬생성 세션 아이디어 추리기](codex://threads/01a0867f-9c97-7033-848f-083abd0cacf2): workspace guard, evaluation auditor, runtime profiler와 continuity adapter
- [스킬 저장소 동기화 방안 찾기](codex://threads/01a0842d-b038-75b0-bf5d-70106f6bfad9): 원본 저장소, source lock과 업데이트 자동화
- [요금제별 서브에이전트 최적화](codex://threads/01a085f9-6a92-77a3-9bc6-dc58d5424729): resource profile 검토와 수동 선택 유지

현재 동작과 제한은 [아키텍처](architecture.md), 배포 절차는 [릴리스 문서](release.md), 기존 계약 확장안은 [추가 스킬 구현 계획](additional-skills-implementation-plan.md)을 기준으로 다시 확인한다. 이 문서와 실제 구현이 달라지면 구현 상태와 검증 근거를 우선하고 로드맵을 함께 갱신한다.
