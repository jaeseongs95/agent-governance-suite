# AGS provider boundary 수정 후보

**provider 소유 범위의 수정과 로컬 커밋을 완료했다. 최종 provider 테스트 63 PASS, 주변 표적 회귀 100 PASS다. 외부 snapshot 재검증 연결과 service의 Retry-After 관측 전달은 별도 writer 인터페이스 제안으로 남긴다.**

- 브랜치: `codex/cloud-provider-boundary-fix`
- base commit/tree: `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6` / `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`
- 후보 commit: **`b5a04ff82f9863383de00d75de5841af5223041b`** — `fix: guard classification provider transport boundaries`
- 후보 tree: `f82f927c49ba368e17843abc8548ef9cea60107c`
- 별도 clone: `/workspace/ags-cloud-provider-fix` (`--no-hardlinks`)
- 변경 파일: **`mcp-server/src/skill-classification/providers.ts`**, **`tests/mcp/skill-classification-providers.test.ts`**만. 216 insertions / 10 deletions.
- 정확한 diff: `candidate.diff`; 로컬 커밋 전달: `candidate-commit.patch`.

## 구현과 실제 결과

### 1. HTTP429/529 Retry-After 관측

`ClassificationProviderError.rateLimitObservation`에 `{httpStatus: 429|529, retryAfter: ...|null}`을 남긴다. `retryAfter`는 `delay-seconds`의 nonnegative safe integer 또는 엄격한 canonical IMF-fixdate에서 변환한 ISO date다. 잘못된 값, 범위 초과 숫자, 임의 문자열·secret text는 `null`로 억제한다. 헤더 원문·응답 body·credential·endpoint는 관측에 복사하지 않는다. Rate limit 이외 HTTP 오류에는 관측을 만들지 않는다.

0/15/leading-zero/max-safe delay, HTTP-date, 지난 날짜, HTTP429/529, 없는 헤더, 잘못된 타입/음수/소수/unsafe 숫자/weekday mismatch/달력 오류/secret text를 검사했다. 각 classify의 fetch는 **정확히 1회**, 대기·자동 재시도·추가 LLM 호출은 없다. 날짜는 관측값일 뿐 scheduling input으로 쓰지 않는다. 안전한 allowlist 범위 밖의 obsolete HTTP date 문자열도 `null`이므로 모든 HTTP-date 관용 표기를 보존한다고 주장하지 않는다.

**서비스 전달 한계:** 현재 `service.ts` catch가 오류를 새로 구성하고 관측 필드를 버린다. 따라서 이 후보는 provider error까지 관측을 보존하며, 최종 service attempt에 보존된다고 주장하지 않는다. `integration-gap.json`의 첫 기록은 provider에서 `429/15s`가 남고 service attempt에는 관측이 없음을 실제로 확인한다. 전달용 타입/정산 동작은 변경하지 않았다.

### 2. credential await 후 실제 dispatch 전 재검증

request/profile을 snapshot으로 묶고, credential await 이후와 동기 wire encode 이후 실제 fetch 바로 앞에서 다음을 재확인한다.

- 같은 route identity와 routeRef/approvalRef/approved/provider/vendor/adapter revision/model 목록/effort 목록/structured capability/kind/endpoint.
- 같은 credential 함수, adapter 객체와 encode/decode/raw-validator 함수.
- 원래 request/profile 및 encode에 전달한 snapshot의 동일 digest.
- profile qualification/config binding/유효기간과 기존 signal cancellation.

바뀐 binding은 `STALE_CLASSIFICATION / not-started`, 취소는 `CANCELLED / not-started`로 반환하고 실제 모의 fetch는 **0회**다. profile의 유효기간이 credential 대기 중 끝나는 경우, route 교체, encode가 route/전달 snapshot을 바꾸는 경우도 포함한다. native callback 직전에도 기존 값/qualification/cancellation 검사를 적용하며 실제 native CLI는 호출하지 않았다.

**외부 snapshot 한계:** 기존 port는 `(request, profile, signal)`뿐이다. signal을 abort하지 않고 바뀌는 task/config/profile/inventory/current runtime snapshot은 provider가 볼 수 없다. `integration-gap.json`의 두 번째 기록에서 credential await 중 외부 config revision을 c1→c2로 바꿨지만 모의 fetch **1회** 후 service가 `STALE_CLASSIFICATION`을 반환했다. 이 공백을 고쳤다고 주장하지 않는다.

정확한 인터페이스 제안은 `interface-proposal.md`에 있으며 제품 변경 전에 보고했다.

```ts
classify(request, profile, signal, beforeDispatch?: () => void): Promise<ProviderEvaluation>
```

service가 현재 snapshot을 검사하는 **동기** closure를 넘기고 provider가 dispatch 직전에 호출하는 연결이다. 소유권 밖 `types.ts/service.ts/gateway.ts`는 수정하지 않았다. 실제 오류 metadata를 전달할 때는 임의 custom provider metadata를 그대로 신뢰하지 말고 구조와 값도 검증해야 한다.

### 3. SS27 중복 JEV wire answer 방어

고정 `tests/skill-classification/fixtures.json`의 SS27은 "provider의 중복·추가·누락 응답은 INVALID"라고 요구한다. SS32는 Retry-After를 관측만 보존하고 JEV 재시도를 하지 않도록 요구한다. 파일은 읽기만 했다. SS27의 logical candidate duplicate 계약을 JEV `answers` map의 물리 중복 candidate key에 적용한 것은 이 후보의 명시적 설계 해석이다.

`JSON.parse`의 표준 last-wins 동작 자체를 버그로 취급하지 않는다. JSON.parse가 원래 bounded wire의 문법을 먼저 검증한다. 이후 JEV adapter의 선택적 `validateRawResponse`가 **top-level answers, 각 candidate key, 판정 type/noul 필드**에서만 중복·충돌을 탐지한다. 문자열 escape를 실제 key로 decode하므로 `review/revi\\u0065w`, `noul/no\\u0075l`도 중복이다. 같은 값의 반복도 ambiguous wire로 거부한다. decode 전에 `INVALID_PROVIDER_RESPONSE / started / invalid:true`로 반환한다.

다른 metadata의 중복, nested object의 noul key, JSON처럼 생긴 quoted text에는 새 정책을 적용하지 않는다. 원문은 변형/재직렬화하지 않으며 일반 JSON 전체를 새로운 parser로 재해석하지 않는다. 검사는 bounded response에서 iterative token scan이며 깊이 재귀 parser를 추가하지 않는다. decorated JEV adapter의 spread도 raw guard를 유지한다. custom vendor protocol은 해당 adapter가 별도 raw guard를 명시할 수 있지만 모든 vendor wire에서 중복을 방어했다고 주장하지 않는다.

## red→green 및 회귀 근거

최종 63-case 테스트 파일을 기준 R13의 **별도 red clone** `/workspace/ags-cloud-provider-red`에 복사했다. 같은 argv, 같은 테스트 SHA, 같은 Vitest config, 같은 의존성/환경에서 실행했고 오직 providers.ts만 바뀌었다.

- 최종 red: **26 PASS / 37 FAIL**, exit1. 실제 assertion 실패이며 import/runner 실패가 아니다.
- 최종 green: **63 PASS / 0 FAIL**, exit0.
- 주변 회귀: service/runtime/profiles/request/validation 5파일 **100 PASS**.
- `tsc --noEmit`, 해당 두 파일 ESLint, `git diff --check`: exit0.
- 저장소 test-engineering plan/proof checker: **READY / CONSISTENT**. 이는 로컬 unsigned consistency/동일성 검사이며 최종 독립 감사나 전체 정확성 보장은 아니다.
- 실제 유료 API·Claude 호출: **0**. 외부 transport는 모두 모의 fetch 또는 local synthetic callback이다.

최종 red/green의 실행 결과·시간·stdout/stderr·source/test snapshot/digest·argv·exit는 `red-receipt.json`/`green-receipt.json`에 있다. `source-manifest.json`은 후보 SHA와 테스트 동일성, 제외 파일의 SHA-256 및 R13과 byte equality를 기록한다. 초기 60-case 실행 보고서는 `initial-*`로 분리했고 최종 63건에 섞지 않았다. 초기 lint의 test 문자열 escape 경고는 고쳤고 같은 최종 테스트로 red와 green을 다시 캡처했다.

## 인계 파일

- `candidate-commit.patch`, `candidate.diff`: 로컬 후보 전달.
- `red-receipt.json`, `green-receipt.json`, `red-final.log`, `green-final.log`: 동일 최종 테스트의 실제 red/green 근거.
- `regression-results.json`/`.log`, `typecheck.log`, `lint.log`: 회귀/정적 검사.
- `integration-gap.mts`, `integration-gap.json`, `.log`: metadata 전달과 외부 snapshot 연결 공백의 모의 재현.
- `interface-proposal.md`: types/service writer용 정확한 연결 제안.
- `engineering-test-plan.json`, `engineering-test-proof.json`, checker 결과: 계획과 계산된 로컬 consistency 결과.
- `source-manifest.json`, `hashes.json`, `git-final.json`: source/evidence 해시와 최종 Git 상태.

## 남은 작업과 제외 범위

총괄/기존 리드가 types/service 포트 연결과 관측 forwarding을 소유 writer와 통합해야 한다. 해당 두 공백은 입증한 미구현 항목이다. source-only 후보이므로 배포 bundle 재생성과 통합 회귀도 최종 writer가 수행한다. SS31 비용0 확정/예약 환급은 구현하지 않았고 unknown 비용/예약의 service 정책은 그대로다. 기존 D01과 timeout 수정, R14 5파일, gateway/service/inventory/types, R13 하네스 2파일, main, remote push/PR/릴리스는 변경하지 않았다. R13 원본 checkout도 clean/pinned 상태를 유지했다.
