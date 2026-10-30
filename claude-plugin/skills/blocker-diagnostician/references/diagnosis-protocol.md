# Diagnosis Protocol

## 관측과 가설

로그, 테스트 결과, 환경 digest와 직접 검사 결과만 관측으로 기록한다. 가설의 지지·반박 evidence ref는 적어도 한 episode의 evidence inventory에 존재해야 한다. 각 ref는 artifact digest, 가설 ID와 `supports | refutes` 관계를 함께 기록하고, 같은 관계를 해당 가설의 `supportingEvidence` 또는 `contradictingEvidence`에도 정확히 반영한다. 한쪽에만 존재하거나 같은 evidence–가설–관계가 중복된 binding은 거부한다. “이 원인일 가능성이 높다”는 가설이며, inventory의 직접 evidence가 해당 가설에 `supports`로 결속되기 전에는 원인으로 확정하지 않는다. confirmed 가설에 `refutes` binding이 하나라도 있으면 확정 판정을 거부한다. `DiagnosisReport.v1`은 확정 원인을 하나만 표현하므로 confirmed 가설이 둘 이상인 입력도 거부한다.

가설은 필요에 따라 입력, 상태, 권한, 환경, dependency, timing, 구현, 도구 계층으로 나눈다. 분류표를 채우기 위해 근거 없는 가설을 만들지 않는다. 확정 가설에는 `causeAnalysis`를 붙여 증상, 작동 메커니즘, 근본 조건과 각각 supporting episode evidence를 가리키는 판별 evidence·경쟁 가설 제거 관측을 기록한다. 이 다섯 요소가 없으면 `CAUSE_CONFIRMED`로 올리지 않는다.

## Failure fingerprint

caller가 제공한 stable tuple과 operation, environment digest를 canonical JSON으로 직렬화해 SHA-256을 계산한다. timestamp, 임시 경로, request·trace ID 같은 변동 필드는 제외할 수 있지만 오류 코드, 핵심 stack frame, dependency 또는 환경 차이는 보존한다. 동일 fingerprint만 기본적으로 같은 cluster다.

진단 request 전체도 canonical JSON으로 직렬화해 SHA-256을 계산한다. 이 값은 보고서를 만들기 전에 외부 workflow 상태에 동결한다. 보고서 검증 시 원 request, 외부 동결 digest와 보고서의 `requestArtifactDigest`가 모두 일치해야 한다.

실제 진단의 `artifactDigest`는 참조한 원 산출물의 바이트에서, `environmentDigest`와 `resultDigest`는 각각 실제 환경 관측과 검사 결과 원자료에서 기존 표준 SHA-256 기능(예: `node:crypto`의 `createHash`)으로 계산한다. 구조화한 원자료는 기존 `core.mjs`의 `canonicalJson`으로 직렬화하고 계산 대상과 근거 위치를 보존한다. `inputDigest`는 `checkInputDigest`, `requestArtifactDigest`는 `digest-request.mjs`의 계산값을 사용한다. 계산하지 않은 반복값·예시값을 실측 digest로 쓰지 않는다. 원자료나 계산 권한이 없으면 그 한계를 보고하며 가짜 값으로 보고서를 완성하지 않는다. 검증기의 통과는 원자료를 실제 측정했다는 증명이 아니다.

## 다음 판별 검사

유효한 검사는 다음 조건을 모두 만족한다.

- 서로 구별되는 예상 결과가 둘 이상이다.
- 각 결과가 어떤 가설을 지지하거나 기각하는지 다르다.
- 이미 같은 canonical check content로 실행한 검사가 아니다.
- 실행 전 조건, 위험, 필요한 권한과 중단 조건이 있다.

후보는 정보가치가 큰 순서로 보고, 값이 같으면 read-only, reversible, external, destructive 순으로 위험이 낮은 검사를 우선한다. 이후 비용과 ID로 결정적인 순서를 만든다. 승인이 필요한 검사는 제안만 하고 실행하지 않는다.

후보 검사와 `attemptedChecks`는 실행 대상을 나타내는 `checkInput`을 함께 보존한다. 스크립트는 `checkId + checkInput`의 canonical JSON에서 `inputDigest`를 다시 계산한다. caller가 digest, 질문 문구, 정보가치나 비용 점수만 바꿔 중복 검사를 새 입력처럼 만들 수 없다. 한 outcome의 `supportsHypotheses`와 `refutesHypotheses`에는 같은 가설 ID가 함께 들어갈 수 없다.

후보의 작업 범위와 권한은 원 사용자 요청·goal·프로젝트 지침에 근거한다. `prohibitedChecks`가 최우선이고, 다음이 `approvalRequired`, 마지막이 `allowedChecks`다. check ID나 `requiredAuthorization` 중 하나라도 금지 목록에 있으면 선택하지 않고, 승인 목록에 있으면 `NEEDS_APPROVAL`로 제안한다. 그 밖의 기존 작업 범위 read-only 검사는 check ID의 별도 허용 없이 진행하되 `requiredAuthorization`에 기록한 추가 권한은 모두 허용돼야 한다. 개인정보·비밀·다른 작업·저장된 receipt 접근의 확대를 통상 읽기로 취급하지 않는다. read-only가 아닌 검사는 check ID와 추가 권한이 모두 허용돼야 한다. caller의 위험 등급·peer 승인 주장 자체는 권한의 출처가 아니며, 원래의 금지·승인 경계를 제거하지 않는다.

## 종료

- 직접 evidence로 한 가설이 확인되면 `CAUSE_CONFIRMED`
- 안전하고 승인된 다음 검사가 있으면 `NEXT_TEST`
- 다음 검사에 승인이 필요하면 `NEEDS_APPROVAL`
- episode, evidence 또는 후보가 부족하면 `NEEDS_INPUT`
- 필수 자료나 도구에 접근할 수 없으면 `BLOCKED`

새 정보 없이 같은 검사를 다시 제안하지 않는다. 진단 자체는 수정이나 저장된 workflow 상태 변경을 실행하지 않는다. 진단 뒤 실제 수정·재시도는 원 사용자 요청·goal·프로젝트 지침이 이미 허용한 범위에서 계속하고, 새 승인 대상 행위만 별도 승인을 받는다.

도구의 권한 거절은 원문과 실패 단계를 보존하고 같은 행위를 다른 표현이나 도구로 재요청하지 않는다. 응답을 계속할 수 있으면 이미 얻은 실패·확인된 원인 또는 미확정 사항·기존 권한 안의 다음 행동을 요약하고, 거절된 명령·보고서 생성·검증을 미실행으로 밝힌다. 실행기가 거절 뒤 응답을 종료했다면 최종보고 부재를 별도 미충족으로 남긴다. 프로세스 종료 코드 0만으로 진단이나 보고서 생성을 성공으로 집계하지 않는다.
