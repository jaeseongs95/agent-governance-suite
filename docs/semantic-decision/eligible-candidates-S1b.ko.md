# S1b — 적격 후보 계산과 baseline 정렬 분리

## 기준과 범위

S1a 구현 `d52afb6f3f982def9bd010a339d6118b72317c07`을 잇는 작업이다.
작업 브랜치는 `codex/v260-semantic-decision-layer`이며, 소스·Git 이력 확보용
검증 지원 commit은 `30f244d6b170058faab84c3613d4aae10db53ef7`이다.
이 지원 commit은 S1b 검증 workflow만 추가하고 라우팅 동작을 바꾸지 않는다.

이 단계는 기존 `resolveV2()` 내부의 hard filter와 정렬을 순수 함수로 분리한다.
v2 wire payload와 digest, required/preferred 우선순위, 고위험 하한, 독립성 검사,
model → host/reasoning/runtime binding을 유지한다. v3 writer, semantic reducer,
새 MCP 도구, provider 호출, DB·reader·peer 변경은 포함하지 않는다.

## 내부 함수

### `collectEligibleCandidatesV2(request, environment)`

기존 request/catalog/policy/capability 검증과 hard filter를 수행한다.
시간은 `environment.now`로만 받으며 파일·DB·네트워크·현재 시각을 조회하지 않는다.

반환값은 다음과 같다.

- `candidates`: `{ key, model, snapshot, binding }` 목록. 후보 키 순으로 정규화한다.
- `rejectedCandidates`: 기존 후보 키와 중복 제거·정렬된 reason code 목록.
- `capabilitySetDigest`: **구조 검증에 통과한 모든 snapshot digest**를 정렬한 뒤 계산한 기존 v2 digest.

만료·정책 거부·빈 supportedBindings인 유효 snapshot도 `capabilitySetDigest`에 포함한다.
형식이 잘못된 snapshot은 기존과 동일하게 거부 기록에 남기고 집계에서는 제외한다.
중복 유효 snapshot, 과도한 목록, 잘못된 시간 등의 입력 오류를 숨기지 않는다.
원래 `request.binding.candidateDigest`나 S1a의 별도 `eligibleSetDigest` 의미를 재해석하지 않는다.

반환 데이터는 `structuredClone`으로 입력과 분리한다. 같은 모델을 제공하는 여러
host/session/native-control/runtime binding을 하나로 합치지 않는다. 후보 키 계산은
기존 `digest({ snapshotDigest, binding })` 그대로다. snapshot 목록의 입력 순서는
정규화하지만, snapshot 내부 binding 배열의 순서는 digest로 결속된 snapshot 내용의 일부이므로
임의로 정규화하지 않는다.

### `rankBaselineCandidatesV2(candidates, request, environment)`

동일한 request/environment에서 방금 계산한 적격 후보의 복제본을 정렬해 반환한다.
입력 배열이나 중첩 객체를 수정하지 않는다. 기존 정렬 기준은 아래 순서다.

1. 사용자 지정값과 일치하는 우선 그룹.
2. 정렬·중복 제거한 task-trait seed의 모델 위치.
3. profile/role seed의 모델 위치. profile 생략 시 `balanced`.
4. 해당 host/role/profile의 native-control 위치.
5. 위 네 항목이 같을 때 후보 키의 사전식 순서.

`required`는 앞 단계에서 일치하지 않는 후보를 제거하는 hard filter다.
`preferred`는 적격 후보 사이의 우선 그룹이고, 해당 그룹이 없으면 기존 fallback을 유지한다.
카탈로그 alias는 기존 방식으로 비교하되 선택된 실제 host binding을 재작성하지 않는다.
존재하지 않는 native reasoning, runtime mode, host 또는 실행 권한을 생성하지 않는다.

정렬 함수 자체는 적격성·출처·최신성을 검증하지 않는다. caller가 임의로 만든 후보나
다른 request의 후보를 전달해 얻은 정렬 결과는 admission 근거가 아니다. 입력·정책·시각이
변경되면 collector부터 다시 실행해야 한다. 미래 S1c의 baseline 동률 판단에서는 마지막
후보 키가 결정적 tie-breaker라는 점을 앞선 네 정렬 기준과 구분해야 한다.

### `resolveV2()`와 실행 경계

`resolveV2()`는 두 함수를 순서대로 재사용하고 기존 payload를 그대로 seal한다.
`revalidateDispatch()`와 `recordV2()`의 구현은 바꾸지 않았다. 이 함수들이 내부에서
다시 호출하는 `resolveV2()`도 동일한 검증·출력 의미를 유지한다.

순수 함수의 반환값은 내부 계산 데이터이며 별도 wire 계약이나 admission receipt가 아니다.
JSON 형식 검증, digest 일치, 적격성 계산은 host 신원 인증이나 실제 관측을 대신하지 않는다.
기존 `executionAuthorized: false`, `trustedGateSatisfied: false`를 유지한다.
원시 snapshot을 provider에 전송하는 통로도 추가하지 않는다.

## 검증 설계와 재현

`tests/coordinate-subagents/semantic-decision/eligible-candidates.test.mjs`에 75개 테스트를
추가했다. 고정 golden 21개를 직접 oracle로 사용하고, 27개 hard-filter reason code,
입력/반환값 분리, 순서 불변성, 빈/만료/잘못된 snapshot, required/preferred,
alias와 native-control, 고위험 거부, TypeScript 선언의 실제 사용 형태를 검사한다.

고정 `fixtures/v2-golden.json`은 변경하지 않는다. SHA-256은 다음과 같다.

```text
6e6ab050a229b4ae9aeb2e767722f69498a873bed02a3854c4e351c13749d54f
```

기존 golden 검사와 새 테스트는 전체 payload의 JSON 문자열, canonical 문자열 및
decision digest를 확인한다. 변경된 두 함수끼리만 비교하거나 테스트 도중 expected를
재생성하지 않는다. 별도 세션 evidence에는 `d52afb6` 원본 core와 현재 core의 512개
고정-seed 입력 비교도 보존한다. 이는 오프라인 회귀 검증이며 모델 품질 실측이 아니다.

```sh
pnpm install --frozen-lockfile
pnpm bundle:check  # build보다 먼저
pnpm claude:drift
pnpm lint
pnpm build
pnpm exec vitest run tests/coordinate-subagents/semantic-decision tests/coordinate-subagents/model-routing-v2/contracts.test.mjs
pnpm test
pnpm runtime:check
pnpm validate:all
pnpm validate:official
pnpm source:check
pnpm bundle:check
git diff --check
```

실제 실행 수·실패·종료 코드는 작업 인계문서와 Actions artifact를 기준으로 확인한다.
공식 validator 파일이 없는 환경의 ENOENT는 공식 검증 성공이 아니며, 기능 회귀 실패와도
구분한다. `.github/workflows/semantic-s1b-verification.yml`은 고정 의존성, 변경 전 bundle,
전달 patch/파일 hash/전체 tree를 대조하고 검증 후 작업 브랜치만 fast-forward한다.
원격 HEAD가 달라지면 덮어쓰지 않는다. 임시 candidate payload는 최종 tree에서 제거한다.

## 변경하지 않는 상태와 다음 단계

패키지 버전은 `2.4.0`이다. v2.6은 목표 릴리스이며 semantic policy의 `off`,
`adoption.status: unvalidated`, disabled egress를 유지한다. main, tag/Release,
marketplace·설치 캐시·Claude 생성물은 수정하지 않는다.

다음 단위는 S1c다. 기존 인계/구현 계획을 다시 확인한 뒤 S1a 계약과 이 내부 후보 계산을
사용해 semantic reducer/replay를 구현한다. S1b 후보 데이터가 최신 admission이나
운영 writer 활성화 근거라고 가정하지 않는다. S2의 서비스·로컬 접근 권한·최신 상태
재검증 책임도 이 단계에서 대신 구현하지 않는다.
