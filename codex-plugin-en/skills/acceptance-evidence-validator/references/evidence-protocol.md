# Evidence Protocol

## 대상 고정

판정 전에 대상의 종류, 식별자와 digest를 기록한다. commit SHA, diff digest, artifact digest, 문서 버전 또는 재현 가능한 상태 식별자를 사용할 수 있다. evidence의 `targetDigest`가 이 값과 다르면 stale로 처리한다.

## 기준별 판정

각 기준의 ID는 `AC-`와 기준 문장 원문 UTF-8 SHA-256 앞 12 hex를 결합한다. 배열 위치, trim, 공백·Unicode 정규화는 사용하지 않는다. 보고서 `criteria`의 `criterionId`와 `statement`가 ID↔문장 표다. 배열 정렬은 ID를 바꾸지 않으며 문장 변경은 새 ID와 새 근거를 요구한다. 중복 문장 또는 ID 충돌은 입력 오류다.

### v1 positional 자료 이관

기존 schemaVersion `1.0.0`의 plain 문자열 기준과 `AC-001` 형태 입력은 계속 읽는다. 다만 위치 ID만 있는 근거·명령·override는 어느 원문을 검증했는지 알 수 없으므로 자동으로 현재 배열에 붙이지 않는다. 이런 자료가 있으면 한계를 남기고 전체 기준을 `insufficient-evidence`로 유지한다. 현재 대상의 내용 ID 반증이 있으면 `unsatisfied`가 우선한다. CLI 종료 코드 계약은 유지되며 `verdict`를 확인해야 한다.

동결된 원래 요청/보고서에서 ID와 정확한 기준 원문을 가져와 optional `criterionBindings: [{"criterionId":"AC-001","statement":"원문 전체"}]`를 제공하면 이전 근거를 내용 ID로 정규화한다. 표를 현재 배열 순서로 새로 만들어 과거 근거에 붙이지 않는다. 없는 문장, 중복 ID·문장과 충돌은 입력 오류다. 원래 authority evidence digest는 이관 전 evidence의 ID 목록과 원값으로 검증한다. 보고서와 evidence index에는 내용 ID를 기록하며, 기존 위치 ID 보고서는 같은 동결 요청·이관표로 재생성해야 한다. request digest는 이관표도 포함하므로 새 요청 산출물로 동결한다. 새 형식의 보고서와 이전 요청의 digest를 섞지 않는다.

이 변경은 직접 CLI, `analyzeAcceptance`, `validateReport`, `validateReportAgainstRequest`를 사용하는 MCP acceptance gate 및 보고서/근거 소비자에 적용된다. TaskEnvelope의 문자열 배열과 공용 TaskEnvelope schema는 바꾸지 않는다. `[AC-001]` 문장 접두도 전체 원문의 일부이며 접두 숫자를 문장 정체성으로 신뢰하지 않는다.

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

## 명령 결과와 실제 검증의 구분

CLI는 `verificationCommands`에 제공된 종료 코드 0을 연결된 기준의 지지 근거로 변환한다. 명령을 실행하거나 로그·assertion의 의미를 읽지는 않는다. 따라서 입력 작성자가 실제 실행 기록에서 명령, 대상, 종료 코드와 결과를 확인하고, 그 명령이 직접 검사한 기준만 `criterionIds`에 넣는다. `echo PASS`, 실패를 숨기는 `|| true`, 발견된 테스트가 0개인 실행이나 전부 skip된 실행을 동작 검증으로 연결하지 않는다.

예상 실패를 확인하는 시험은 실제 거절·오류를 assertion으로 검사하는 harness의 결과를 사용한다. 원 명령의 비정상 종료를 임의로 0으로 고쳐 적지 않는다. 각 evidence의 `verified`도 원자료를 열어 내용을 확인한 경우에만 참으로 둔다. request/report의 digest 일치와 validator 통과는 입력의 결속을 증명하며, 입력에 적힌 관측을 실제로 수행했다는 증명은 아니다.

## 증거 기록

원문 코드나 전체 로그를 보고서에 복사하지 않는다. evidence ID, 종류, locator, digest, target digest, 검증 여부, 관측 요약만 남긴다. 명령 evidence에는 실행 명령, 종료 코드와 결과 locator를 연결한다.

보고서를 다시 검증할 때는 원 요청과 외부에서 동결한 request artifact digest가 모두 필요하다. validator는 canonical request digest를 다시 계산해 artifact digest와 비교하고, 같은 요청으로 보고서를 재생성한 결과와 제출된 보고서를 대조한다. report-only 검증은 허용하지 않는다.

`verificationCommands`는 각각 안정적인 ID와 영향을 받는 기준 ID를 가진다. 현재 대상에서 종료 코드 0은 지지 evidence, 0이 아닌 종료 코드는 반증 evidence다. 다른 대상의 명령 결과는 stale이며 연결된 기준을 `insufficient-evidence`로 둔다.
