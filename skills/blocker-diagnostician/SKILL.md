---
name: blocker-diagnostician
description: 반복되는 실패를 관측 episode와 원인 가설로 분리하고, 새 정보를 얻을 수 있는 다음 판별 검사를 정한다. 수정 구현, 일반 설계 비교, 같은 검사의 반복 실행이나 최종 독립 감사에는 사용하지 않는다.
license: MIT
metadata:
  version: "1.0.0"
---

# Blocker Diagnostician

반복 실패를 같은 원인으로 단정하지 않고 증거로 구분한다. 확인된 원인이 있으면 그 근거를 반환하고, 아직 구분할 수 없으면 정보가치가 높고 권한 범위 안에 있는 다음 검사를 하나 정한다.

## 적용 범위

- 같은 작업이 반복해서 실패했거나 수정 뒤에도 실패가 이어질 때 사용한다.
- 사용자가 원인 후보 분리나 다음 판별 검사를 요청했을 때 사용한다.
- 명확한 단일 오타, 일반 코드 리뷰, 설계안의 정책·비용 비교에는 자동 적용하지 않는다.
- 해결안 사이의 안전·비용·정책 판단이 핵심이 되면 별도의 숙의가 필요하다고 보고한다.

## 입력

`FailureEpisodeSet.v1`을 받는다. 각 episode에는 작업, caller가 선별한 안정적인 failure tuple, 환경 digest와 evidence locator를 둔다. `evidenceBindings`에는 evidence artifact digest, 결속된 가설 ID와 `supports | refutes` 관계를 기록한다. 후보 가설과 후보 검사의 의미는 에이전트가 증거를 읽고 작성하며, 스크립트는 fingerprint, 중복 검사, 권한과 결과 분기만 결정적으로 검증한다.

진단 전에 [references/diagnosis-protocol.md](references/diagnosis-protocol.md)를 읽는다.

```bash
node scripts/cluster-failures.mjs --input failures.json
node scripts/digest-request.mjs --input failures.json
node scripts/cli.mjs --input failures.json
node scripts/validate-report.mjs --request failures.json --request-digest "sha256:..." --report diagnosis.json
```

보고서를 만들기 전에 `digest-request.mjs`가 반환한 digest를 외부 workflow 상태에 동결한다. `validate-report.mjs`에는 원 request와 외부에 보관한 digest를 함께 전달한다. 모든 명령은 stdin도 지원하고 JSON만 stdout으로 반환한다. 제안한 검사를 직접 실행하거나 파일·외부 상태를 바꾸지 않는다.

## 절차

1. episode별 operation, stable tuple과 환경 digest를 보존해 cluster를 만든다.
2. 관측 사실과 가설을 분리하고 각 가설의 지지·반박 evidence를 기록한다.
3. 각 `evidenceBinding`의 evidence ref와 `supports | refutes` 관계가 결속된 가설의 `supportingEvidence` 또는 `contradictingEvidence`에 정확히 반영됐는지 양방향으로 확인한다. episode의 evidence inventory에 실제로 존재하고 artifact digest와 가설 ID가 `supports`로 결속된 직접 evidence가 있는 가설 하나만 `confirmed`로 인정한다. `confirmed` 가설에 `refutes` binding이 있거나 confirmed 가설이 둘 이상이면 입력을 거부한다.
4. 후보와 과거 검사에는 실행 대상을 나타내는 `checkInput`을 기록한다. `checkId + checkInput`의 canonical JSON에서 `inputDigest`를 다시 계산하고, 같은 digest로 이미 실행한 검사는 후보에서 제외한다. 질문 문구나 정보가치·비용 점수만 바꿔 새 검사로 만들지 않는다.
5. 서로 다른 두 개 이상의 관측 결과가 가설을 다르게 지지·기각하는 검사만 판별 검사로 인정한다.
6. 정보가치가 높은 검사를 우선하고, 같은 정보가치에서는 위험과 비용이 낮은 검사를 선택한다.
7. `prohibitedChecks`, `approvalRequired`, `allowedChecks` 순으로 권한을 판정한다. read-only 검사도 명시적 허용 없이는 실행 가능하다고 보지 않으며, 승인이 필요한 검사는 실행하지 않고 `NEEDS_APPROVAL`로 반환한다.
8. 새 관측이나 입력 변화가 없으면 같은 검사를 반복하지 않고 필요한 입력을 보고한다.

## 경계

- 진단 결과를 근거로 수정, 설정 변경, 배포를 수행하지 않는다.
- 비슷한 메시지만으로 다른 환경이나 오류 코드를 같은 cluster로 합치지 않는다.
- 최종 diff, rollback과 릴리스 가능성을 판정하지 않는다.
- 실패한 기존 workflow를 수정하거나 되살리지 않는다. 통합 시 별도 recovery workflow를 사용한다.

## 출력

`DiagnosisReport.v1`과 짧은 사용자 요약을 반환한다. 보고서에는 원 request의 `requestArtifactDigest`를 포함한다. cluster, 관측, 가설, 확정 원인 또는 다음 검사, 중단 조건과 `CAUSE_CONFIRMED | NEXT_TEST | NEEDS_INPUT | NEEDS_APPROVAL | BLOCKED`를 구분한다.
