# Agent Governance Suite 향후 로드맵

<!-- release-version:start -->
문서 기준일은 2026년 9월 17일이다. 현재 공개 릴리스는 `v1.14.1`이다. 한국어 산문 워크플로는 확장한 용어집 검증과 사용자의 명시적 배포 승인에 따라 활성화했고, 2026년 9월 17일 동결 frame `0.3.0-gate-1`(130건, suite revision `9377b6d19eb3a07671dad85af4aaf5e5ce0f5d81`)에서 `EVALUATION_EVIDENCE_PASSED`로 품질 기준을 통과했다. 이 판정은 품질 증거의 통과를 뜻하며 별도의 릴리스 승인을 대신하지 않는다.
<!-- release-version:end -->

이 문서는 프로젝트 코드와 설계 문서뿐 아니라 이 저장소에서 진행한 Codex 작업의 논의를 함께 반영한다. 일정은 특정 날짜보다 단계별 종료 조건을 기준으로 관리한다. 각 단계의 필수 검증을 마치기 전에는 다음 릴리스 범위로 넘기지 않는다.

## 목표

향후 개발은 다음 순서로 진행한다.

1. `v1.1.0`의 거버넌스·업데이트 알림 기능을 안정적으로 운영하고 한국어 산문 품질 게이트를 통과한다.
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
| 0. `v1.1.0` 안정화 | 품질 게이트 통과 (`0.3.0-gate-1`) · 용어집 짝 비교 완료 | 거버넌스 릴리스 운영과 한국어 산문 워크플로의 계약·품질·재현성 확보 | 활성 평가 후보, 검증된 receipt 경로, 품질 평가 결과, 고정된 원본 ref |
| 0.5. 업데이트 알림 | 완료 | 안정 버전 존재 여부만 안내 | `check_for_updates`, SQLite v2 상태, 일회성 MCP notice |
| 0.6. 모델·추론 수준 안내 | 완료 | 요청 난도와 관측 가능한 현재 설정을 비교해 과다·적정·부족 여부 안내 | `model-effort-advisor`, `ModelEffortAdvice.v1`, 정상·경계·실패 fixture |
| 1. 실행 전 신뢰성 | 부분 구현 | 평가 오류와 동시 작업 충돌을 조기에 차단 | 구현된 `evaluation-validity-auditor`, 계획된 `active-workspace-guard` |
| 2. 복구 워크플로 | 구현됨 | blocker 진단 뒤 선택 가능한 복구 전략 제공 | `recovery-strategy-selector`, `RecoveryHandoff.v1` |
| 3. 실행 환경과 연속성 | 부분 구현 | 실행 가능 여부를 먼저 확인하고 세션 복원을 표준화 | 계획된 `runtime-capability-profiler`, 구현된 로컬 task continuity |
| 4. 신뢰 경계 강화 | 설계 후보 | bootstrap·증거·라우팅 선언의 신뢰 수준 향상 | `BootstrapReceipt.v1`, 증거 검증 경계 |
| 5. 공급망과 운영 | 구현 완료·운영 설정 대기 | 원본 편입과 버전·릴리스 관리를 자동화 | source lock v2, draft 업데이트 PR workflow, 버전 단일 소스, 확인 기반 SQLite 정리 |

## 0단계: `v1.1.0` 후보 안정화

한국어 산문 워크플로의 활성 후보를 실제로 시험해 품질 기준을 완료하는 단계다. 활성 후보의 신규 holdout 실행은 편집 계약 검증에서 중단됐지만, 용어집·MCP·통합 검증 성공과 사용자의 명시적 배포 승인에 따라 작업 중인 `main`에서는 registry의 `enabled` 값을 `true`로 고정했다. 품질 평가 상태와 배포 활성 상태는 별도로 기록한다.

### 구현 범위

- 선택, 편집, 검증, 최종화 단계가 같은 요청과 `edit-decision-set`을 참조하는지 끝까지 검사한다.
- receipt에는 원문이나 편집 결과 본문을 저장하지 않고 digest와 참조만 남긴다.
- 평가 cycle의 입력, 결과와 판정 근거를 재현할 수 있도록 canonical digest와 receipt 검증 경로를 확정한다.
- 품질 평가 fixture와 실제 사례에서 의미 보존을 유지하면서 개선율 기준 80% 이상을 충족한다.
- `korean-prose-editor`의 원본을 재현 가능한 공개 tag 또는 immutable commit으로 고정한다. 로컬 절대 경로는 공개 릴리스의 최종 source lock으로 사용하지 않는다.
- 공개 릴리스 버전, manifest, package, marketplace와 문서의 버전 표기가 서로 일치하는지 확인한다.

### 현재 구현 진척

- 구조화된 평가 cycle의 receipt 경로는 finalization이 selection의 `edit-decision-set`을 실제 입력과 evidence로 받는지 확인한다. JSON·JSONL 산출물은 key 순서와 무관한 canonical digest로 대조하며, receipt와 SQLite에 원문을 남기거나 기존 산출물을 덮어쓰지 않는다.
- 독립 저장소와 통합 사본은 immutable commit `c5df63749e2edfc8aa424f9935ee3cd4697d3c49`에 고정했다. 이 스냅샷은 범주·용어 보존, 대리 명사 없는 기능 동사 직접화, 편집 후 경계 공백 거부와 provenance-bound run metadata v3를 포함한다.
- 기존 11-case gate는 기록된 실패와 9/11 기준을 바꾸지 않고 `invalid-corpus`로 종결했다. 별도 12-case recovery는 edit 5/8, restraint 4/4, major meaning change 0, protected failure 0으로 실패했으며 재실행하지 않는다.
- recovery 실패 보정은 공개 회귀 fixture와 계약에 반영했지만 `IMPLEMENTED_NOT_RERUN` 상태다. 실제 활성 후보를 새 ID·새 freeze·독립 corpus 타당성 검사를 갖춘 holdout에서 시험했으나, direct editing의 첫 모델 응답이 최소 편집 범위 계약을 위반해 fail-closed로 중단됐다. 실제 모델 출력 뒤에는 같은 frame을 재시도하지 않는다.
- 다음 정식 frame용 fail-closed readiness gate를 구현했다. 새 구조화 cycle은 외부에서 보관한 frame·타당성 보고서 digest, 현재 suite revision, 실제 통합 대상과 동일한 평가 skill 사본·평가 toolchain checksum, 정답이 제거된 모델·독립 심사 입력과 별도 동결 label, corpus strata·rubric·threshold digest, 실행 횟수, 과거 terminal evidence와 독립 corpus 타당성 근거를 결속해야 receipt를 기록할 수 있다. selection 직전 만든 원자적 start claim을 후속 단계 metadata가 참조하며, 품질 판정은 self-reported 상태가 아니라 외부에서 고정한 품질 보고서, 전체 workflow receipt·SQLite·최종 case와 봉인된 독립 심사 결과에서 분자·분모를 다시 집계한다. `READY_TO_EVALUATE`와 `EVALUATION_EVIDENCE_PASSED`는 provider 활성화와 분리한다.
- registry, 직접 descriptor와 Codex implicit invocation은 함께 활성 상태인지 저장소 검증에서 검사한다. 구조·의미 감사를 통과한 100-case holdout과 SQLite 조회는 각각 100/100 일치했지만, 실제 모델 평가는 direct selection 뒤 direct editing에서 멈춰 MCP arm, 독립 품질 심사와 최종 지표를 생성하지 못했다. 그 시점의 활성화는 지표 통과 주장이 아니라 별도의 사용자 승인에 따른 배포 결정이었고, 전체 품질 `≥80%`는 이후 `0.3.0-gate-1`에서 입증했다(다음 항목).
- 2026년 9월 17일 동결 frame `0.3.0-gate-1`로 정식 평가를 1회 실행해 `EVALUATION_EVIDENCE_PASSED`를 얻었다. corpus는 legacy 100건·holdout 30건이며 원문과 label을 분리해 모델 가시 필드는 `id`·`sourceText`·`protectedStrings`뿐이다. author·auditor·adjudicator 3개 타당성 역할, selection·editing·verification 3개 언어 역할, 봉인 품질 심사자 1개까지 7개 actor를 모두 분리했고, 각 역할 지시문의 SHA-256을 `promptSha256`으로 기록했다. 재집계 지표는 protected exact 130/130, legacy meaning pass 100/100, legacy improvement 58/65(89.2%), legacy regression 0/100, legacy restraint 35/35, holdout improvement 19/20(95.0%), holdout restraint 10/10, holdout major meaning change 0건, holdout protected failure 0건이다. 제안 edit 80건은 scope·protected·minimality 검사를 전부 통과했고 verification이 3건을 retain했다. frame digest `sha256:f0c53c05bef280887b54f98aa19191da316740c17c1bad875421995f12e39930`, validity report digest `sha256:cc472f56aab9b520caf627f83a13dbc3a00564d54507ea992dcbf6d0e6986737`, quality report digest `sha256:eead07e66909bc14d761fef02426825cd1b5f445590d6b32c0505d27a031a3a5`는 저장소 밖 custody에 보관하며, 원문이 담긴 cycle 디렉터리는 저장소에 넣지 않는다. 실행 모델 정보는 host attestation adapter가 없어 caller-asserted다. 동결 전 별도 corpus 12건으로 리허설해 최소 편집 범위 계약 준수를 먼저 확인했다. `eval:receipt:verify` CLI가 품질 보고서 digest 인자를 받지 않던 결함은 이후 커밋에서 `--expected-quality-report-digest`를 추가해 고쳤지만, 이 스크립트는 toolchain digest에 포함되므로 그 전에 동결한 `0.3.0-gate-1`은 동결 당시 CLI로만 검증할 수 있고 receipt 검증은 `eval:readiness --require-quality`의 재집계 결과를 최종 근거로 삼는다.
- 0단계 종료 기준의 저장소 검증은 `0.3.0-gate-1` 기록과 verifier 수정을 반영한 `main`에서 `AGENTS.md`의 전체 검증 순서대로 `pnpm install --frozen-lockfile`, `pnpm bundle:check`, `pnpm claude:check`, `pnpm lint`, `pnpm build`, `pnpm test`(33개 파일, 285개 테스트), `pnpm runtime:check`, `pnpm validate:all`, `pnpm validate:official`, `git diff --check`가 모두 통과했다. 한국어 산문 workflow의 정상·경계·실패·원문 비저장 테스트는 이 테스트 묶음에 포함된다. 공개 릴리스·태그 생성은 별도 승인 절차로 넘긴다.
- 2026년 9월 18일 direct/MCP 용어집 짝 비교를 동결 게이트와 분리해 실행했다. 지표·임계값·근거 충분성 규칙(prefer·avoid는 정책 entry의 50% 이상이면서 최소 3개, allow·protect는 8개 이상 distinct entry)을 실행 전에 파일로 동결했고(spec digest `sha256:02e3ff5ef89ced63dbac5e03d9799abce30b47803b894aef780a90d457d69772`), 용어집 1.2.0을 표적으로 한 66건 corpus(prefer 4 entry×3, avoid 9 entry×2, allow 12, protect 12, 대조군 12 중 부분 문자열 함정 4)를 author가 작성하고 auditor가 독립 감사했으며, 언어 역할은 id 순서로 그룹을 추정하지 못하도록 섞은 불투명 id 사본(digest `sha256:7dfb0426ab00cc1881986fb17240e144fcaa4b762a66c00642df9c7f808ddd5f`)만 봤다. MCP arm은 `lookup_korean_prose_terms`와 같은 모듈을 in-process로 호출하고(라이브 도구와 `matchSetDigest` 6건 일치 확인) `bindingFromMatchSet` binding을 세 역할에 공유한 뒤 `mode: "mcp"` finalizer를 통과했다. 결과: 조회 precision·recall 1.00/1.00, 네 정책 모두 근거 충분(prefer 4/4, avoid 9/9, allow 15, protect 12 distinct). MCP arm은 protect 12/12 보존, allow 12/12 비결함, canonical화가 안전한 avoid 13/13·prefer 8/8을 canonical 표기로 바꾸고, 인용·고유 표기 안의 keep 9/9를 유지했으며 retain 기대 39건을 모두 유지했다. direct arm은 같은 corpus에서 avoid 0/13·prefer 0/8을 바꾸지 않았고(사전 없이는 표기 변형이 정책상 결함이 아님) protect·keep·restraint는 동일하게 전건 유지했다. 두 arm의 최종문이 다른 22건을 블라인드 A/B로 심사한 결과 MCP 신규 개선 20건, 회귀 2건(9.1%, 기준 ≤10% 통과)이다. 회귀 2건 중 하나는 avoid 항목 `completion-result-ko`의 `완료 영수증`→`완료 결과` 치환으로, 심사자가 `영수증`이 고정 UI 요소명일 수 있어 의미 보존을 확정할 수 없다고 판정했다 — 이 항목은 용어집 정책 재검토 후보다. 다른 하나는 용어와 무관하게 두 arm이 안내형 서두를 다르게 줄인 사례다. 역할은 author·auditor·direct 3·MCP 3·심사자 1의 9개 actor로 분리했고, 결과 digest `sha256:9364b3f8e8289614445565e5dcc8734322be991ab1cf94bbfcaa0495181a4943`와 corpus·심사 원자료는 저장소 밖에 보관한다. 이 비교는 동결 게이트 결과를 바꾸지 않는다.
- SQLite 용어집은 공식 프로젝트·표준·TTA·공식 한국어 문서에 근거한 243개 entry와 248개 form으로 확장했다. `protect` 162개, `prefer` 4개, `avoid` 9개, `allow` 68개를 각각 시험하며, 데이터 버전은 `1.2.0`이다. GitHub 한국어 용어집의 다의적인 단일어는 `allow`로 분류해 산문 편집을 과도하게 고정하지 않는다.
- 용어집 평가는 전체 편집 품질과 분리한다. 같은 신규 문장의 direct/MCP 결과를 짝지어 비교하고, 사전 적중군·미적중군, 정책별 정확도, 조회 precision/recall, MCP가 새로 만든 개선과 회귀를 각각 집계한다. 정책별 서로 다른 entry 수가 부족하면 높은 점수라도 일반화 성공이 아니라 `INSUFFICIENT_EVIDENCE`로 기록한다.

### 종료 기준

- 한국어 산문 workflow의 정상·경계·실패·원문 비저장 테스트가 모두 통과한다.
- 고정한 평가 계약과 holdout 결과가 품질 기준을 통과한다.
- `pnpm lint`, `pnpm build`, `pnpm test`, `pnpm bundle:check`, `pnpm validate:all`, `pnpm validate:official`, `pnpm runtime:check`가 통과한다.
- 릴리스 후보에 범위 밖 변경이나 다른 활성 작업의 미완료 변경이 포함되지 않는다.
- 위 근거를 기록한 뒤 별도의 공개 승인 절차로 넘긴다.

## 0.5단계: 플러그인 업데이트 알림

`v1.1.0`에 반영했다. MCP 서버는 고정된 공개 저장소의 `vMAJOR.MINOR.PATCH` 안정 tag만 확인하며, 개별 원본 스킬이나 사용자 제공 URL은 확인하지 않는다.

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

## 0.6단계: 모델·추론 수준 적합성 안내

`model-effort-advisor`는 별도 작업 브랜치에서 구현·검증한 뒤 `main`에 통합했으며 `v1.5.0`부터 공개 릴리스에 포함한다.

- 현재 task의 모델과 reasoning effort가 host runtime metadata, 사용자 설명 또는 현재 요청에 첨부된 화면에서 확인될 때만 요청 난도·위험과 비교한다.
- 판정은 `OVER_PROVISIONED`, `ADEQUATE`, `UNDER_PROVISIONED`, `UNOBSERVABLE`로 구분한다.
- 과다하거나 부족하다는 근거가 분명할 때만 짧게 안내하고 요청 처리는 계속한다. 적정하면 별도 안내를 생략한다.
- 현재 선택을 관측할 수 없으면 값을 추정하거나 일반 작업에서 사용자에게 재확인을 요구하지 않는다.
- 모델이나 reasoning effort를 자동으로 변경하지 않으며, 요금제·잔여 사용량이나 실제 비용을 관측 근거 없이 추정하지 않는다.

### 릴리스 상태와 제한

- schema, registry bootstrap provider, 오케스트레이터 라우팅과 정상·경계·실패 회귀 테스트를 `main`에 통합했다.
- `v1.5.0` 릴리스 후보에서 `pnpm bundle:check`, `pnpm lint`, `pnpm build`, `pnpm test`, `pnpm runtime:check`, `pnpm validate:all`, `pnpm validate:official`, `git diff --check`가 통과했다.
- 스킬 자체만으로는 매 요청에서 UI의 현재 선택을 읽을 수 없다. host가 runtime metadata를 제공하지 않는 환경에서는 사용자 설명이나 현재 요청의 화면 자료가 있어야 구체적인 판정이 가능하다.
- host metadata 연동이 없는 환경에서도 관측 불가를 조용히 처리하고 기존 작업을 막지 않는다.

## 1단계: 평가와 작업 공간의 신뢰성 확보

평가가 잘못됐거나 다른 작업이 같은 파일을 수정하고 있다면 이후 단계의 완료 근거도 신뢰할 수 없다. 두 검사를 일반 구현보다 앞에 배치한다.

### `evaluation-validity-auditor`

스킬 평가의 입력, 판정 방법과 결과 집계가 공정하고 재현 가능한지 독립적으로 검사한다.

- 자기보고 결과만 증거로 제출했는지 확인한다.
- 문구 일치만으로 의미 보존이나 품질 향상을 판정하지 못하게 한다.
- 평가 시점에 사용할 수 없었던 사후 정보가 입력에 섞였는지 검사한다.
- 불완전한 JSONL이나 누락된 case를 전체 평가 결과로 집계하지 않는다.
- 동결된 rubric, fixture set, 실행 revision과 결과 digest를 하나의 평가 보고서에 결속한다.

`evaluation-validity-auditor` v1.0.0을 독립 공개 저장소에 구현하고 immutable tag의 peeled commit과 checksum으로 suite에 편입했다. `EvaluationValidityRequest.v1`, case/result JSONL 계약, `EvaluationValidityReport.v1`, `EvaluationValidityValidation.v1`과 세 CLI가 동결 digest, 역할 독립성, 완전한 case/run/result 집합과 재집계 metric을 검사한다. `pre-execution PASS`는 설계 실행 가능성만 뜻하며, 품질 게이트나 릴리스 승인에는 `post-execution PASS`만 재사용할 수 있다. Suite provider는 명시적 감사 요청 또는 평가 결과가 품질·릴리스 근거로 제출될 때만 `evaluation-validity` phase order 68에서 조건부 완료 게이트로 선택된다. 공유 `TaskEnvelope.v1`은 변경하지 않고 `plan_workflow`의 별도 구조화 입력과 서명된 plan stage가 `design-readiness`와 `quality-or-release`를 구분하며, 실행 계층은 각 목적에 맞는 audit stage와 자격 boolean을 함께 검사한다.

### `active-workspace-guard`

변경을 시작하기 전에 동일 저장소를 사용하는 활성 Codex 작업과 예상 충돌을 검사한다.

- 작업의 `cwd`, 상태, 기준 revision, 예상 쓰기 경로와 실제 변경 경로를 비교한다.
- 경로가 겹치면 소유 작업과 변경 목적을 확인할 때까지 mutation을 차단한다.
- 경로가 겹치지 않으면 확인한 시점과 범위를 기록하고 작업을 계속한다.
- 작업이 길어지거나 기준 revision이 바뀌면 기존 판정을 그대로 재사용하지 않는다.

이 스킬은 Git 변경만 검사하는 `change-scope-guardian`을 대체하지 않는다. `active-workspace-guard`는 작업 간 충돌을 시작 전에 찾고, `change-scope-guardian`은 동결한 작업 범위와 실제 변경을 전후로 비교한다.

### 종료 기준

- `evaluation-validity-auditor`는 registry capability와 독립 계약을 갖췄고, `active-workspace-guard`는 아직 구현되지 않았다.
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
- provider는 `executionClass: recovery`, `recovery-strategy-selection`, `phaseOrder: 20`으로 등록하며 일반 workflow 단계와 섞지 않는다.

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

### 로컬 task continuity

컨텍스트 연속성은 전문 provider registry에 넣지 않고 `context-continuity` 인프라 스킬, 기존 MCP 프로세스와 Codex lifecycle Hook으로 구현했다. Workflow DB schema v5와 분리해 optional 상태는 같은 로컬 상태 디렉터리의 schema v2 `continuity.sqlite3`에 저장한다. snapshot에는 최소한 다음 내용을 포함한다.

- objective와 completion criteria
- constraints와 decisions
- progress와 evidence refs
- blockers와 next actions
- task correlation, epoch, revision, digest와 updated time

Direct task의 resume과 compact에는 본문 없이 metadata와 서명된 restore token만 `DEFER`로 제공하며, 본문은 명시적인 `load_context` 호출에서만 반환한다. Orchestrated workflow는 기존 `TaskEnvelope`, receipt와 convergence root에서 marker와 revision·digest가 일치하는 bounded 구조 카드만 compact 뒤 한 번 `INJECT`한다. Startup은 복원하지 않고, clear는 epoch를 회전해 이전 snapshot을 억제하되 payload를 자동 삭제하지 않는다. 현재 목표나 revision과 충돌하는 snapshot은 자동 병합하지 않는다.

Hook은 transcript를 읽지 않고 설치별 HMAC으로 session·turn·request 식별자를 결속한다. `checkpoint_context`, `inspect_context`, `load_context`, `suppress_context_restore`, `purge_direct_context`와 `open_convergence_root`의 correlation에는 task·epoch·도구·canonical input digest·만료 시간이 포함된 stateless token을 쓴다. Continuity 초기화나 lifecycle 처리 실패는 기존 workflow와 compaction을 막지 않는다.

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
- 각 완료 결과가 어떤 보증 수준에서 만들어졌는지 식별할 수 있다.
- caller-trusted 값과 실제로 검증한 값을 결과에서 구분한다.
- 기존 신뢰 모델을 사용하는 로컬 workflow의 호환 정책과 마이그레이션 절차가 문서화된다.

## 5단계: 공급망과 릴리스 운영

source lock, 업데이트 후보 탐지, 릴리스 버전 생성과 SQLite 보존 정책을 구현했다. 공개 tag·release 생성, 원격 push와 Actions 권한 변경은 이 단계에서 실행하지 않았다.

### 구현 결과

- source lock v2가 원본 경로, stable tag 또는 commit, peeled full SHA, 원본·통합 checksum, downstream 수정과 `auto-pr`/`notify-only`/`internal` 정책을 함께 고정한다.
- 오프라인 검사는 `SKILL.md` metadata 또는 legacy `VERSION`, registry, 직접 descriptor와 통합 checksum을 교차 검증하고, 원격 검사는 고정 ref checkout의 원본 checksum까지 확인한다.
- 매주 월요일 09:00 KST와 수동 실행에서 정확한 `vX.Y.Z` tag를 확인한다. 수정 없는 스킬만 스킬별 draft PR 후보가 되며 원본 코드는 실행하지 않는다. 실제 PR 생성에는 저장소 관리자의 Actions Pull Request 권한 설정이 남아 있다.
- `release/version.json`에서 package, plugin manifest, marketplace, MCP metadata와 한·영 README·roadmap의 현재 버전 표면을 생성·검사한다.
- `prepare_state_cleanup`과 `execute_state_cleanup`이 180일 terminal workflow, 30일 비활성 continuity payload와 180일 비활성 continuity record를 확인 기반으로 정리한다. 15분 일회성 token, 후보 재검증, DB별 검증 backup과 transaction을 강제한다.
- 앱 수준 DB 암호화는 추가하지 않고 OS 계정 권한·BitLocker 정책을 문서화했다. Windows에서는 보호 활성 상태를 검증하지 않았음을 receipt에 표시한다.

### 종료 기준

- 같은 원본 ref로 언제든 동일한 번들을 재구성할 수 있다.
- 버전 불일치와 원본 이탈이 릴리스 전에 자동으로 차단된다.
- 자동 생성된 업데이트 PR도 기존 전체 검증과 독립 감사 조건을 건너뛰지 않는다.

## 당분간 보류하는 항목

- `resource-profile.v1`을 이용한 요금제·잔여 사용량 기반 자동 모델 배분은 필수 로드맵에서 제외한다. 현재는 작업마다 품질, 균형, 절약 중 우선순위를 사용자가 선택하는 방식을 유지한다.
- MCP 도구는 설정으로 활성화 여부를 조절할 수 있지만 Codex의 플러그인 스킬별 on/off는 저장소만으로 해결하기 어려운 플랫폼 기능이다.
- SQLite 앱 수준 암호화와 무확인 자동 만료는 현재 정책 범위에서 제외한다. backup 삭제와 OS 저장장치 보호는 운영자가 관리한다.
- `upstream-sync`의 실제 draft PR 생성은 저장소 관리자가 Actions의 Pull Request 생성 권한을 명시적으로 활성화한 뒤 운영한다.

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
