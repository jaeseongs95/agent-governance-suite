# Evidence Protocol

## 대상 고정

판정 전에 대상의 종류, 식별자와 digest를 기록한다. commit SHA, diff digest, artifact digest, 문서 버전 또는 재현 가능한 상태 식별자를 사용할 수 있다. evidence의 `targetDigest`가 이 값과 다르면 stale로 처리한다.

## 기준별 판정

- `satisfied`: 현재 대상에 맞고 직접 확인된 evidence가 기준을 지지하며 반증이 없다.
- `unsatisfied`: 현재 대상에 맞는 테스트 실패, 관측 결과 또는 구현 상태가 기준과 양립할 수 없다.
- `insufficient-evidence`: 필요한 검사를 하지 않았거나 locator를 열 수 없거나 evidence가 다른 대상을 가리킨다.
- `not-applicable`: 현재 대상에서 검증된 `user-input` 또는 `document` evidence가 기준 ID와 `TaskEnvelope.scope.excluded` 또는 `authorization.prohibitedActions`의 실제 항목을 가리킨다. authority evidence digest는 evidence ID, 종류, locator, 현재 target digest, 검증 상태, criterion IDs, 방향, 관측 결과와 locator가 가리킨 값을 canonical JSON으로 묶는다. 기존 digest를 둔 채 criterion ID나 target만 바꾼 evidence는 사용할 수 없다.

반증은 지지 근거보다 우선한다. 일반 테스트 성공을 특정 기준의 근거로 확대하지 않는다. 정적 파일 검사는 구조적 기준을 증명할 수 있지만 실행 동작을 자동으로 증명하지 않는다.

## 전체 판정

- `FAIL`: `unsatisfied`가 하나 이상이다.
- `BLOCKED`: 실패는 확인되지 않았지만 `insufficient-evidence`가 하나 이상이다.
- `PASS`: 나머지 두 조건이 없고 모든 기준이 `satisfied` 또는 정당한 `not-applicable`이다.

일부 통과율, 중요도 가중치나 에이전트의 확신으로 전체 판정을 바꾸지 않는다.

## 증거 기록

원문 코드나 전체 로그를 보고서에 복사하지 않는다. evidence ID, 종류, locator, digest, target digest, 검증 여부, 관측 요약만 남긴다. 명령 evidence에는 실행 명령, 종료 코드와 결과 locator를 연결한다.

보고서를 다시 검증할 때는 원 요청과 외부에서 동결한 request artifact digest가 모두 필요하다. validator는 canonical request digest를 다시 계산해 artifact digest와 비교하고, 같은 요청으로 보고서를 재생성한 결과와 제출된 보고서를 대조한다. report-only 검증은 허용하지 않는다.

`verificationCommands`는 각각 안정적인 ID와 영향을 받는 기준 ID를 가진다. 현재 대상에서 종료 코드 0은 지지 evidence, 0이 아닌 종료 코드는 반증 evidence다. 다른 대상의 명령 결과는 stale이며 연결된 기준을 `insufficient-evidence`로 둔다.
