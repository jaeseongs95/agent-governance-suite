# S1a — semantic/v3 계약 동결

## 구현 범위

`SemanticDecisionRequest.v1`, `SemanticDecisionAdvice.v1`,
`SemanticDecisionPolicy.v1`, `SemanticModelAssignmentRequest.v1`,
`SemanticDecisionQuestion.v1`, `ModelRoutingDecision.v3`,
`ModelApplicationRequest.v3`, `ModelApplicationRecord.v3`의 JSON Schema와
TypeScript 타입, `ContractValidator` 진입점을 추가했다. 질문 설정에도 스키마를
부여하여 문구·버전·판단 종류의 구조를 함께 고정했다.

기존 v2 스키마, `resolveV2`, `recordV2`, 서비스 호출, MCP 도구 등록, DB,
peer CAS/원장, host observation admission은 수정하지 않았다.
`model-routing-core.d.mts`는 기존 순수 함수에 대한 타입 선언일 뿐이다.
공유 canonical/digest 함수를 사용하며 새 종류의 digest 알고리즘을 만들지 않는다.

## 입력과 신뢰 경계

외부 MCP 입력에는 기존 v2 `routingRequest`와 `taskRef`만 허용한다.
`taskRef`는 task ID와 선택적 frame/artifact ID다. URL, raw state, provider 설정,
정책, capability, eligible set, advice, admission은 입력할 수 없다.
실제 로컬 참조 권한 검사는 S2 서비스의 책임이며, ID 형식 검사만으로 허가하지 않는다.
이번 단계에서 새 MCP 도구는 등록하지 않았다.

내부 prepared request는 평가 시도 ID(`evaluationId`), 기존 binding,
effective routing request/state/question/catalog/routing policy/semantic policy/
capability set/eligible set/option mapping digest, provider·model·adapter·reducer
식별 및 버전, 요청 시각과 만료를 결속한다. `candidateDigest`의 기존 의미는
바뀌지 않는다. provider/model revision을 보고할 수 없으면 명시적 `null`로 남기며
새 API의 버전 고정 가능성을 추정하지 않는다.

state는 명시적 text와 원자료 참조를 포함한다. task source ID는 기존 binding과
맞아야 한다. 요약을 사용하면 `summaryDigest`는 **전송된 text의 canonical JSON
문자열**에 대한 digest이며 원자료 참조는 별도로 남는다. scalar text의 raw UTF-8
hash와 혼용하지 않는다. 다른 내용 digest도 모두 기존 `canonical`/`digest`를 쓴다.
내용 digest는 식별·변조 검사이지 출처 인증, 권한 또는 원자료 접근 허가가 아니다.

## Choice와 후보 매핑

v1은 provider-neutral `Choice`만 표현한다. `selectedOptionIds`는 공동 최고 모델
선택지의 집합이며 배열 순서가 실행 순위나 host 선택을 의미하지 않는다.
confidence는 유한한 0~1 또는 null이다. 이를 작업 성공 확률로 해석하지 않는다.
기권/timeout/형식 오류는 유효 advice로 위장하지 않으며 후속 평가 상태로 분리한다.
Score/Noul의 실행 의미나 특정 Jev endpoint 형식은 구현하지 않았다.

prepared request의 적격 candidate에는 모델, 기존 preference group, baseline rank가
있고 모델별 option은 해당 candidate key들을 가리킨다. 후보 key/순위/option ID의
중복, 다른 모델 연결, 미등록 후보, 부분 매핑을 거부한다. 하나의 모델에 여러
host/reasoning binding이 있어도 모델당 option은 하나다. 이 메타데이터를 AGS의
기존 후보 계산에서 생성하는 것은 S1b다. S1a 검사는 hard filter를 새로 수행하거나
caller가 만든 후보를 적격으로 승인하지 않는다.

advice는 prepared request의 binding·digest·버전·만료와 일치해야 한다. 등록 여부와
admission metadata는 외부 wire payload에 넣지 않는다. `...ForRequestV1`은 결속
검사이며 AGS 등록 함수가 아니다. 외부 provider가 이 검사를 통과하는 JSON을
만들 수 있다는 사실만으로 해당 artifact가 소비 가능해지는 것은 아니다.

## off/shadow/assist 및 v3

배포된 policy는 `mode: off`, `adoption.status: unvalidated`, 임계값과 증거는 null,
egress는 disabled/빈 allowlist다. 검증되지 않은 숫자를 자동 채택 임계값으로
지정하지 않았다. assist 형식은 검증된 평가 참조와 provider/version/question/
reducer 결속 및 명시적 egress allowlist를 요구한다. 실제 평가 증거와 provider
사용 권한을 인정하는 서비스는 S3/S4에서 구현한다.

초기 scope는 low-risk model-ranking뿐이다. `highRisk`, `independentAudit`는 false,
required/preferred 보존과 baseline 동률 해소는 true/고정값이다. scope를 완화하는
필드는 schema가 거부한다. off/shadow/fallback은 기존 v2 결정을 유지한다.
S1a는 provider를 호출하거나 policy에 따라 라우팅하는 실행 경로 자체를 추가하지 않았다.

v3 decision은 채택된 assist의 selected 결과만 표현하며 advice/semantic request/
policy/eligible set/mapping/reducer/selected option/baseline decision을 참조한다.
`executionAuthorized`와 `trustedGateSatisfied`는 false다. 기존 selected/target/
native setting 필드의 의미는 v2의 해당 shape를 재사용한다. v3 application은 같은
advice를 참조하고 실제 dispatched 설정이 decision과 일치해야 한다. record는
기존 observation 필드와 미관측 상태를 유지하며 새 관측 성공을 발급하지 않는다.

`...ForAdviceV3`, `...ForDecisionV3`는 참조 일치 검사다. baseline digest 재현,
선호 보존을 포함한 실제 모델 선택, 순수 reducer/replay는 S1c이며, 최신 정책·lease·
capability/독립 이력 재검증 및 실제 observation receipt의 admission은 S2 이후다.
이 단계의 schema-valid v3 fixture를 운영 writer에 넣지 않는다.

시각 검사는 외부에서 받은 명시적 시각의 형식/순서를 검사한다. 숨은 현재 시각 조회는
없다. 늦은 완료와 historical replay를 막지 않도록 과거 유효 artifact의 형식 검증을
현재 시각 기준 만료 거부로 바꾸지 않는다. 실제 dispatch-time 유효성 검사는 후속
replay/재검증에서 수행한다. `dispatchedAt`의 의미는 기존 claim 시각 그대로다.

## 검증과 이후 작업

신규 99 tests: 계약 75, 고정 v2 golden/원본 schema/버전 격리 23, 재귀적인 TS-schema
구조 상호 할당 검사 1. 숫자 범위·유일성·조건부 관계는 runtime 테스트로 별도 확인한다.
기존 v2 계약 2 tests를 포함한 focused 계약 실행은 101 tests 통과다.
fixture-provider라는 문자열은 테스트 데이터에만 있고 배포 provider registry가 아니다.

공유 소스에 영향받은 MCP 번들 5개를 동일 lockfile 의존성으로 재생성했고
`skills/source-lock.json`을 갱신했다. Claude 생성물은 직접 수정하지 않았다.
common/Codex 변경의 Claude drift 경고를 릴리스 동기화 완료로 표시하지 않는다.

다음 단위는 **S1b — 기존 적격 후보 계산과 baseline 정렬의 순수 함수 추출**이다.
새로운 v3 운영 writer, API 호출, DB migration, peer executor, 버전 bump, main/tag/
Release/설치 캐시 변경은 이번 단계와 다음 S1b의 범위 밖이다.

## 브랜치 검증 지원

이 세션의 컨테이너는 GitHub 직접 네트워크 접근이 되지 않았다. 전용 workflow의
`[apply-semantic-contracts]` 모드는 명시적으로 올린 후보만 처리한다. 압축된 전달
파일의 digest, 변경 전 blob, 허용 경로, 변경 후 파일 hash와 전체 tree를 검사하고
동일 tree의 전체 회귀를 실행한다. 관련 검사가 성공해야만 현재 원격 HEAD를 다시
확인한 후 이 기능 브랜치로 fast-forward한다. main/tag/Release/설치물은 다루지 않는다.
공식 validator ENOENT는 기록하되 통과로 위장하지 않는다. 전달 파일은 적용 후 삭제한다.
보통 push의 경로에서는 소스를 자동 수정하거나 commit하지 않는다.
