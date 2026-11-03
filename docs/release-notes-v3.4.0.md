# AGS 3.4.0 릴리스 노트

3.4.0은 네 가지를 담는다. 시험 구조를 고쳤고, JEV를 교체 가능한 조언 계층으로 정리했다. 압축 관련 hook이 실제로 도움이 되는지 실호스트에서 시험했고, 3.3.0에서 미룬 결함과 최적화를 반영했다. 시험 구조와 JEV는 방향이 갈릴 수 있어서 사용자 지시(「테스트 방법에 대해서는 토론으로 방향성 결정해야된다고 적어주고.」)에 따라 각각 reviewer 3명의 토론으로 방향을 정했다.

호환성: 공개 도구 계약, 오류 code, DB schema 버전은 바뀌지 않는다. `BINDING_INVALID`에 `details.reasonCode`가 더해졌고, continuity DB는 열 때 인덱스 하나를 더 만든다. 3.3.0 서버도 이 인덱스가 있는 DB를 그대로 연다. JEV route의 인증 헤더는 지정하지 않으면 지금처럼 Bearer다. 분류 시도의 이유 코드에 `CREDENTIAL_MALFORMED`가 더해졌다.

## 바뀐 점

### 시험 구조

토론 결정: 시험을 새 단계로 쪼개기 전에 느린 시험의 실제 원인을 고친다. 개발 중 확인은 기존 분류 규칙을 반대로 쓰는 범위 하나로 CI와 테스트 서버가 나눠 돈다. 발행 게이트(Linux·Windows 테스트 서버 전체 시험, CI 두 OS)는 그대로 둔다.

- **분류 대상 일치.** 3.3.0까지 `scripts/test-scope.mjs`는 `tests/` 아래만 분류했다. vitest는 `antigravity-connector/hooks/*.test.mjs`도 모으는데, 그중 프로세스를 띄우는 2개가 CI에서 돌았다. 이제 vitest가 모으는 모든 파일(저장소에서 `node_modules`·`.git` 제외)과 node:test 파일을 분류한다. `tests/tooling/test-scope.test.mjs`가 `vitest list` 결과와 분류 대상이 같은지 확인한다.
- **`AGS_TEST_SCOPE=server`.** 서버 전용 시험만 돈다. 개발 중에는 CI(`ci`)와 테스트 서버(`server`)를 동시에 돌린다. 두 범위를 합치면 전체이고 서로 겹치지 않는다. 실측 결과 vitest 파일은 server 128개와 ci 148개, node:test 파일은 15개와 11개였다. 정해지지 않은 값은 오류로 멈춘다.
- **실행기.** `scripts/run-tests.mjs`는 vitest가 실패해도 node:test를 끝까지 돌리고 두 종료 코드를 함께 알린다. node:test 단계가 오류로 끝나도 그 오류 보고에 vitest 종료 코드가 남는다. 예전에는 vitest 실패 뒤 node:test 결과를 보려고 다시 돌려야 했다.
- **바꾸지 않은 것.** vitest의 isolate·pool·worker 수는 그대로다. 모듈 캐시(`workspace-identity.ts`), `node:` mock 35개 파일, `process.env` 대입 24개 파일, 한 실행이 공유하는 상태 디렉터리 때문에 시험 사이 상태가 섞일 수 있다. 2코어 서버에서는 vitest가 이미 worker를 1개만 쓴다(기본값 `max(코어 수 - 1, 1)`).
- **느린 시험의 반복 작업 제거.** 아래는 Linux 시험 서버(2코어)에서 잰 파일별 시간이다. 전은 3.3.0 후보 전체 시험(en2 로그), 후는 b0fc2b4d 시험이다.

  | 파일 | 전 | 후 | 바꾼 것 |
  |---|---|---|---|
  | `tests/tooling/skill-context-optimization.test.mjs` | 95.9초 | 22.6초 | 커밋 SHA로만 이름 붙은 `git show`·`git diff` 결과를 프로세스 안에서 재사용한다. 작업 트리와 index 읽기는 매번 한다. 검사 출력은 바이트 단위로 같다. |
  | `tests/tooling/specialist-behavior-source.test.mjs` | 48.9초 | 10.3초 | 같은 검사 스크립트를 쓰므로 같은 효과 |
  | `tests/mcp/skill-selection-agent-continuation.test.ts` | 46.7초 | 32.4초 | 시험마다 만들던 `ContractValidator`를 모듈에서 한 번 만든다. |
  | `tests/skill-classification/live-bootstrap/bootstrap-contract.test.mjs` | 128.0초 | 129.0초 | mutation 6종마다 복원 뒤 GREEN 재실행 대신 바이트 동일성을 확인한다(oracle 실행 18회 → 12회). |
  | `tests/skill-classification/live-bootstrap/prepared-bootstrap.test.ts` | 44.3초 | 47.1초 | fixture 18개를 한 번 준비한 seed에서 복사한다. |

  앞의 세 파일은 합계 191.5초에서 65.3초로 줄었다. 뒤의 두 파일은 줄지 않았다. 사례별로 재 보니 `bootstrap-contract`는 16개 사례가 각각 tsx 자식 프로세스를 띄우고 2코어에서 2개씩 돌며, 가장 긴 사례(`history-r04-budget.mjs` 52.0초, `budget-regression.mts` 29.1초, `history-r04-boundary.mjs` 27.0초)가 전체 시간을 정한다. mutation 사례는 하나에 9.7~14.5초이고 대부분이 소스 사본 준비와 프로세스 시작이라 oracle 실행을 줄여도 차이가 나지 않았다. `prepared-bootstrap`도 실제 프로세스 경계(IPC, crash cut, 재시작)를 시험하므로 자식 프로세스 시작이 시간 대부분이다. 이 두 파일을 더 줄이려면 자식을 tsx 대신 미리 빌드한 JS로 띄워야 하며, 3.4.0에서는 하지 않았다.

### JEV 계층

토론 결정: JEV는 결정 계층이 아니라 선택을 돕는 조언 계층이고, TypeSafe는 그 구현 하나다. 이 원칙에 맞게 TypeSafe 고유 규칙을 공통 계층에서 adapter로 옮기고, 전송 엔진을 스킬 분류 용도에서 떼어 냈다. 공개 계약, port 시그니처, `"jev"` 값, 기존 qualification digest는 바꾸지 않았다.

- **인증 헤더는 adapter가 정한다.** 신뢰된 adapter의 transport 계약에 `credentialHeader`를 둘 수 있고, 없으면 지금처럼 `authorization: Bearer <key>`를 보낸다. profile, route JSON, 요청은 인증 헤더를 정하지 못한다. 추가 헤더로 인증 헤더를 덮을 수 없고, 인증 헤더 이름은 route binding과 configuration fence에 들어가서 호출 중이나 수락 뒤에 바뀌면 `STALE_CLASSIFICATION`이 된다. 키는 fetch의 헤더 정규화처럼 앞뒤 탭·공백·CR·LF를 떼고 보낸다(CRLF 파일이나 `set KEY=값 `에서 읽은 키도 그대로 동작한다). 그러고도 출력 가능한 ASCII가 아닌 바이트(가운데의 줄바꿈, NUL, 비ASCII)가 남으면 예산 예약과 전송 전에 새 이유 코드 `CREDENTIAL_MALFORMED`로 거부한다. 키가 없거나 비어 있으면 지금처럼 `CREDENTIAL_UNAVAILABLE`이다. 예전에는 이런 키가 fence를 지난 뒤 fetch의 TypeError로 실패해 helper 실패 증거로 남았다. 추가 헤더 값도 탭과 출력 가능한 ASCII만 허용한다.
- **TypeSafe 규칙은 TypeSafe adapter에 있다.** reasoning effort를 받지 않고 `judgmentPolicy`가 있어야 한다는 noul 규칙을 noul adapter 7개의 `validateConfiguration`으로 옮겼다. 훅이 없는 port를 위한 옛 함수도 같은 규칙을 부른다. 기본 제공 adapter 9개 전부에서 옛 규칙과 새 규칙의 결과가 같은지 표로 확인한다. 동작이 바뀐 곳은 하나다. vendor route에 TypeSafe noul adapter를 직접 묶으면 이제 noul 규칙이 적용된다.
- **전송 엔진과 용도를 나눴다.** `dispatchAdvisoryAttempt`는 용도에 묶이지 않은 엔진으로 외부 전송 허용, 예산 예약·정산, dispatch fence, usage 검증, helper 실패 증거를 맡는다. 스킬 분류는 이 엔진을 쓰는 task이며 실패 응답, qualification, stale 판정, 응답 검증을 준다. helper 실패 증거는 엔진이 정한 코드로만 남는다. task가 응답에 다른 코드를 적거나 task 메서드가 오류를 던져도 증거가 되지 않는다.
- **문서.** `docs/architecture.md`와 `skills/orchestrator/references/skill-classification.md`에 계층과 구현의 관계, `noul_*`·`JEV_*` 값의 출처, 예산 상한(USD 5)이 서버 프로세스 하나의 수명 동안의 한도라는 점을 적었다.
- **하지 않은 것.** native CLI를 JEV로 쓰기, 호출마다 켜고 끄는 값이나 예산, taskId 결속, 독립 선택 거부 완화, 기본값 변경은 토론에서 이번 범위가 아니라고 정했다. 설정하지 않은 상태의 `jevEnabled: true`는 전송이나 비용이 생기지 않아 결함이 아니고, 독립 선택 거부는 의도된 계약(AO16)이다.

### 압축 관련 hook

사용자 질문(「압축관련 hook이 실효성이 있는지」)에 답하려고 Linux 시험 서버에서 Claude Code 실호스트 비교 시험을 했다. 판정 규칙은 시험 전에 정했다. 압축 hook을 켠 쪽의 평균 위반이 대조군보다 1개 이상 적고, 단측 permutation p < 0.1이고, hook이 실제로 넣은 내용을 모델이 쓴 증거가 함께 있으면 「효과 있음」이다. 대조군도 위반이 거의 없으면 「효과 없음 또는 천장」, 그 밖은 「판별 불가」다.

- **시험.** 3.3.0 후보(460ab868), Claude Code 2.1.314, `claude-sonnet-5-5`, `/compact`를 쓰는 stream-json 세션이다. 사용자 규칙 6개와 방해 문서를 준 뒤 압축하고, 압축 뒤 작업에서 규칙 위반을 파일 결과로 셌다. 조건은 다음과 같다.

  | 조건 | 뜻 | 횟수 |
  |---|---|---|
  | A0 | direct 작업, 압축 hook 없음 | 6 |
  | A1 | direct 작업, 압축 hook 있음, 저장본 없음 | 4 |
  | A2 | direct 작업, 압축 hook 있음, 저장본 있음 | 3 |
  | A2S | A2와 같고 시작 뒤 교정을 추가 | 3 |
  | W0 | workflow 작업, 압축 hook 없음 | 3 |
  | W1 | workflow 작업, 압축 hook 있음 | 3 |

- **결과: 「효과 없음 또는 천장」.** 22회 모두 위반이 0건이었다. 켠 조건과 대조군의 평균 위반 차는 모두 0.00이고 p는 모두 1.000이다. 22회 모두 Claude Code 자체 압축 요약에 규칙 키워드 6개가 남았다. 예비 시험에서 방해 문서를 3개에서 10개로 늘려도 대조군 위반이 0이어서 목표 난도(위반 20~80%)를 맞추지 못했다. 그래서 본 시험은 조건당 3회로 줄였다.
- **hook이 실제로 한 일.** 켠 조건에서는 압축마다 PreCompact·PostCompact가 성공했다. W1은 3회 모두 workflow 구조 카드(`INJECT`)가 모델 요청까지 들어갔다. A2·A2S는 저장본 후보(`DEFER`)만 들어갔고, 압축 뒤 모델이 `load_context`를 부른 경우는 6회 중 0회였다. A1은 4회 모두 「저장본 없음」 안내만 들어갔다.
- **판단.** 이 난도에서는 Claude 자체 요약으로 충분했다. 이 결과는 hook을 고치거나 빼는 근거가 되지 못한다. 그래서 3.4.0에서는 압축 hook의 동작을 바꾸지 않았다.
- **시험으로 드러난 한계.**
  - direct 저장본은 `DEFER`로만 들어가서 모델이 `load_context`를 불러야 쓰인다. 이번 시험에서는 한 번도 불리지 않았다.
  - workflow 카드는 목록마다 4개만 싣는다. 모델이 사용자 규칙을 수용 기준에 넣어서 6개 중 4개만 실리고 `[+2 omitted]`로 잘렸다. `start_workflow`에 constraints 필드가 없어서 생긴 일이다. workflow 시작 뒤에 한 교정은 카드에 없었다.
  - 코드 확인 결과, PostCompact는 모델에 아무것도 넣지 않는다. lineage 재고정은 SessionStart(compact)도 한다.
- **하지 않은 것.** 요약이 실제로 규칙을 잃는 더 어려운 조건, 자동 압축, 대화형 세션, Codex·agy, 여러 root가 묶인 작업의 카드(N7)는 시험하지 않았다. 비용은 약 USD 10이다.

### 결함 수정과 최적화

3.3.0을 검토하며 찾았지만 3.3.0 범위 밖이었던 결함이다.

- **끊긴 symlink.** 실제 경로를 구할 때 끊긴 링크를 없는 폴더처럼 지나쳐, 키가 실제로 파일이 생길 위치가 아니라 링크 경로를 가리켰다. 이제 링크를 대상까지 따라간다(`workspace-identity.ts`). 링크 대상 앞쪽의 `..`는 물리 경로로 푼 부모에서 계산한다. 이름 뒤에 오는 `..`(`a/../b`)는 커널과 문자열 계산이 다를 수 있어서 식별할 수 없음으로 거부한다.
- **식별하지 못한 root의 겹침.** 식별 정보를 도출하지 못한 root는 lexical 경로를 그대로 썼다. 그래서 alias나 glob으로 같은 파일을 가리켜도 겹침으로 잡지 못했고, 판정 대기 root의 편집 관문을 그 경로로 비켜 갈 수 있었다. 이제 읽을 수 있는 만큼 링크와 glob을 실제 경로로 풀어 비교한다(`convergence-logic.ts`).
- **VCS 밖 경로와 편집 관문.** VCS 밖 경로는 편집 개수에서 빠지는데(설계 7.3), 판정 대기 root 검사 전에 빠져서 저장소 밖에 있는 판정 대기 root의 파일을 바꿀 수 있었다. 이제 판정 대기 root 검사는 받고, 개수에 세거나 기록하지는 않는다(`continuity-hook.ts`, `continuity-service.ts`). 경로를 알 수 없는 도구는 막으려면 컴퓨터 전체를 막아야 하므로 한계로 두고 설계 문서 7.8에 적었다.
- **`BINDING_INVALID` 원인.** 신뢰 실행 관측 오류와 continuity 토큰 오류가 모두 reasonCode 없는 `BINDING_INVALID`라 `workflow-start-failed:*` 관측에서 원인을 구분할 수 없었다. 새 공개 code는 만들지 않고 `details.reasonCode` 12종을 붙였다. 이미 소비된 관측은 `EXECUTION_OBSERVATION_CONSUMED`다(`docs/ags30-error-model.md` 8).
- **hard link가 없는 파일 시스템.** 기계 ID가 없는 OS에서 `host-id`를 게시할 때 `linkSync`가 EEXIST가 아닌 오류로 실패하면 배타 생성으로 게시한다. 기계 ID가 있는 경로는 그대로다.
- **observation 조회 인덱스.** 다른 task 소유 여부 조회(`ownedElsewhere`)가 `continuity_observations` 전체를 훑었다(EXPLAIN으로 SCAN 확인). `(event, task_correlation, epoch)` 인덱스를 더했고, 기존 v2 DB도 열 때 인덱스를 얻는다. schema 버전은 바꾸지 않았다.
- **판단만 하고 고치지 않은 것.** sandbox가 기계 ID 파일을 가리는 경우에 ID가 갈라지는 것은 Linux에서 두 기계 ID 파일이 모두 안 보일 때뿐이다. 프로세스 안에서 「OS에 기계 ID가 없음」과 「sandbox가 가림」을 구별할 방법이 없어 설계 문서에 한계로 적었다.

## 토론 기록

두 패널 모두 `independent-deliberation-panel`의 MEDIUM 등급으로 진행했다. 같은 case brief를 받은 reviewer 3명(opus, effort high)이 서로의 결과를 보지 않고 검토했고, Coordinator가 증거로 통합했다. 사용자가 fresh Judge를 요구하지 않아 Judge는 두지 않았으므로 assurance는 partially_independent다.

### 시험 구조

- **reviewer.** Evidence Skeptic, Performance, Operability/Minimalist.
- **입력 사실.** 3.3.0 후보 Linux 서버 실측이다. vitest 275파일·4082시험 1178초, node:test 26파일·499시험 159초로 합계 약 22분이었다. 파일 합 1067초가 벽시계 1178초와 비슷해서 병렬이 거의 없었다. 상위 10개 파일이 42.8%를 차지했다. 정적 검사를 통과하고 전체 시험에서만 드러난 실패가 3건 있었다.
- **결정(conditional_consensus).** 새 단계로 쪼개기 전에 느린 시험의 원인을 먼저 고친다. 분류 대상을 vitest가 찾는 파일과 같게 하고 집합 일치 시험을 둔다. `AGS_TEST_SCOPE=server`를 추가하고, 실행기는 두 단계를 모두 보고한다. isolate·pool·worker 수·시간 한도와 발행 게이트는 그대로 둔다.
- **쟁점.** 빠른 확인을 어떻게 할지가 갈렸다. Skeptic은 `vitest related`에 그래프 밖 파일이 바뀌면 전체로 넘기는 방식을, Minimalist는 범위 분리만을, Performance는 바꾼 디렉터리와 CI 범위를 함께 돌리는 방식을 냈다. 앞의 실패 3건을 잡은 시험이 모두 서버 전용이라 server 범위가 그대로 잡는다. 그래서 범위 분리를 채택하고 `related`는 선택이 빠질 위험이 있어 선택 사항으로 남겼다. 쟁점이 서로 배타적이지 않아 반박 단계는 생략했다.
- **이탈.** Performance reviewer가 읽기 전용 지시와 달리 측정 스크립트를 써서 실행했다. 실행한 것은 검사 스크립트뿐이었고, 그 측정값은 reviewer 보고로만 확인한 값으로 분류했다.

### JEV 계층

- **reviewer.** Contract·벤더 독립, Minimalist, Security·비용.
- **입력.** 지침 「JEV는 결정 계층이 아니라 선택을 도와주는 계층으로 설계한다」와 「JEV도 교체 가능한 다목적 계층으로 다루며 스킬선택 기능만으로 축소하지 않는다」, 사용자 질문 「내가 jev 계층 추상화하라는거 지켜지고있어?」, 현재 코드다.
- **결정(반박 1회 뒤 consensus).** 위 「JEV 계층」 절의 세 가지 변경과 문서다.
- **쟁점.** dispatch 엔진과 task를 나눌지가 갈렸다. Minimalist는 처음에 문서만 고치자고 했다. 반박에서 엔진 자체가 스킬 분류 전용이면 문서만으로는 지침을 지켰다고 보기 어렵다는 주장을 받고, port 시그니처를 유지하고 fence 순서 밖에서 호출하지 않는다는 조건으로 `service.ts` 안의 분리를 받아들였다. 이 reviewer는 그 뒤 non_independent로 본다.
- **채택하지 않은 제안.**
  - helper-unavailable용 별도 source: AO16 계약과 맞지 않는다.
  - 출시 경로에서 비내장 adapter를 고르는 경로: 다른 공급자를 추가하려면 어차피 adapter 코드가 필요하다. 선택 사항으로 남겼다.

## 알려진 제한

- 압축 hook이 모델 행동을 낫게 하는지는 아직 입증되지 않았다. 이번 시험은 천장이었다. direct 저장본의 `DEFER` 경로가 실제로 쓰이지 않은 점, workflow 카드가 목록마다 4개로 잘리는 점, 여러 root가 묶인 작업의 카드(N7)는 더 어려운 조건의 시험 뒤 다룬다.
- CI windows-latest에서 `tests/mcp/skill-classification-gateway.test.ts`의 「does not approve changed inventory or source metadata despite an eligible fixed profile」이 가끔 30초를 넘긴다. 3.4.0 코드로 돈 8번 중 2번(f4b6e0c7, 3984fae7)이 시간 초과였고, 정리 단계에서 복사한 `skills` 폴더가 `ENOTEMPTY`로 지워지지 않았다. 나머지 6번은 3~8초였다. 같은 시험이 Linux에서는 0.9초이고 3.3.0 CI 두 번은 4초·8초였다. JEV 변경만 넣은 판과 결함 수정만 넣은 판, 코드 전체를 넣은 판은 각각 통과해서 원인 커밋을 특정하지 못했다. 시간 한도는 바꾸지 않았다. 원인(복사한 파일을 무언가가 쥐고 있는 것으로 보임)은 후속 과제로 남긴다.
- `bootstrap-contract`와 `prepared-bootstrap`은 시간이 줄지 않았다. 원인과 남은 방법은 위 「시험 구조」 절에 적었다.
- 경로를 알 수 없는 편집 도구는 편집 관문이 막지 못한다. 막으려면 컴퓨터 전체를 막아야 한다(설계 문서 7.8).
- sandbox가 기계 ID 파일을 모두 가리는 Linux에서는 sandbox 밖과 다른 host ID가 생길 수 있다.
- hard link가 없는 파일 시스템에서 `host-id`를 처음 게시하는 동안 읽은 프로세스는 그 호출만 `HOST_IDENTITY_UNRESOLVED`가 된다. 그 사이에 프로세스가 죽으면 빈 파일이 남고, 지울 때까지 같은 상태가 이어진다.
- Codex 실호스트 시험은 이번에도 돌리지 않았다. Codex API 크레딧 문제가 풀린 뒤 전체 시험에서 확인한다.

## 검증
<!-- TODO -->
