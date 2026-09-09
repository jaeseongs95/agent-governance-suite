# Diagnosis Protocol

## 관측과 가설

로그, 테스트 결과, 환경 digest와 직접 검사 결과만 관측으로 기록한다. 가설의 지지·반박 evidence ref는 적어도 한 episode의 evidence inventory에 존재해야 한다. 각 ref는 artifact digest, 가설 ID와 `supports | refutes` 관계를 함께 기록하고, 같은 관계를 해당 가설의 `supportingEvidence` 또는 `contradictingEvidence`에도 정확히 반영한다. 한쪽에만 존재하거나 같은 evidence–가설–관계가 중복된 binding은 거부한다. “이 원인일 가능성이 높다”는 가설이며, inventory의 직접 evidence가 해당 가설에 `supports`로 결속되기 전에는 원인으로 확정하지 않는다. confirmed 가설에 `refutes` binding이 하나라도 있으면 확정 판정을 거부한다. `DiagnosisReport.v1`은 확정 원인을 하나만 표현하므로 confirmed 가설이 둘 이상인 입력도 거부한다.

가설은 필요에 따라 입력, 상태, 권한, 환경, dependency, timing, 구현, 도구 계층으로 나눈다. 분류표를 채우기 위해 근거 없는 가설을 만들지 않는다.

## Failure fingerprint

caller가 제공한 stable tuple과 operation, environment digest를 canonical JSON으로 직렬화해 SHA-256을 계산한다. timestamp, 임시 경로, request·trace ID 같은 변동 필드는 제외할 수 있지만 오류 코드, 핵심 stack frame, dependency 또는 환경 차이는 보존한다. 동일 fingerprint만 기본적으로 같은 cluster다.

진단 request 전체도 canonical JSON으로 직렬화해 SHA-256을 계산한다. 이 값은 보고서를 만들기 전에 외부 workflow 상태에 동결한다. 보고서 검증 시 원 request, 외부 동결 digest와 보고서의 `requestArtifactDigest`가 모두 일치해야 한다.

## 다음 판별 검사

유효한 검사는 다음 조건을 모두 만족한다.

- 서로 구별되는 예상 결과가 둘 이상이다.
- 각 결과가 어떤 가설을 지지하거나 기각하는지 다르다.
- 이미 같은 canonical check content로 실행한 검사가 아니다.
- 실행 전 조건, 위험, 필요한 권한과 중단 조건이 있다.

후보는 정보가치가 큰 순서로 보고, 값이 같으면 read-only, reversible, external, destructive 순으로 위험이 낮은 검사를 우선한다. 이후 비용과 ID로 결정적인 순서를 만든다. 승인이 필요한 검사는 제안만 하고 실행하지 않는다.

후보 검사와 `attemptedChecks`는 실행 대상을 나타내는 `checkInput`을 함께 보존한다. 스크립트는 `checkId + checkInput`의 canonical JSON에서 `inputDigest`를 다시 계산한다. caller가 digest, 질문 문구, 정보가치나 비용 점수만 바꿔 중복 검사를 새 입력처럼 만들 수 없다. 한 outcome의 `supportsHypotheses`와 `refutesHypotheses`에는 같은 가설 ID가 함께 들어갈 수 없다.

권한은 `prohibitedChecks`가 최우선이고, 다음이 `approvalRequired`, 마지막이 `allowedChecks`다. check ID나 `requiredAuthorization` 중 하나라도 금지 목록에 있으면 선택하지 않는다. 승인 목록에 있거나 허용 목록에 명시되지 않은 검사는 `NEEDS_APPROVAL`로만 제안한다. read-only 위험 등급은 명시적 허용을 대신하지 않는다.

## 종료

- 직접 evidence로 한 가설이 확인되면 `CAUSE_CONFIRMED`
- 안전하고 승인된 다음 검사가 있으면 `NEXT_TEST`
- 다음 검사에 승인이 필요하면 `NEEDS_APPROVAL`
- episode, evidence 또는 후보가 부족하면 `NEEDS_INPUT`
- 필수 자료나 도구에 접근할 수 없으면 `BLOCKED`

새 정보 없이 같은 검사를 다시 제안하지 않는다. 진단 뒤 실제 수정은 별도 작업으로 다룬다.
