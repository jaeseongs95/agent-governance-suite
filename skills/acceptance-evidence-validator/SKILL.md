---
name: acceptance-evidence-validator
description: 고정된 구현 대상과 실제 테스트·검사 근거를 수용 기준별로 대조해 충족, 실패, 증거 부족을 판정한다. 구현, 반복 실패 원인 분석, 고위험 독립 감사나 릴리스 승인에는 사용하지 않는다.
license: MIT
metadata:
  version: "1.0.0"
---

# Acceptance Evidence Validator

수용 기준마다 현재 대상에 맞는 직접 근거가 있는지 확인한다. 이 스킬의 `PASS`는 요구사항 충족 판정이며, 고위험 변경에 필요한 독립 감사나 릴리스 승인을 대신하지 않는다.

## 적용 범위

- 사용자가 요구사항별 구현·테스트 근거 판정을 요청했을 때 사용한다.
- 구현이나 산출물이 끝난 뒤 완료 선언에 필요한 근거를 점검할 때 사용한다.
- 단순 조회, 설계 대안 선택, 실패 원인 분석에는 사용하지 않는다.
- 모호하거나 충돌하는 수용 기준은 임의로 해석하지 않고 계약 재정리가 필요하다고 보고한다.

## 입력

`AcceptanceEvidenceInput.v1`을 받는다. 최소 입력은 `TaskEnvelope.v1`, 고정 대상 식별자와 digest, 기준에 연결된 evidence다. evidence에는 locator, 검증 여부, 대상 digest, `supports | refutes` 방향이 있어야 한다.

판정 전에 [references/evidence-protocol.md](references/evidence-protocol.md)를 읽는다. 기계적인 일대일 대응과 stale 검사는 다음 명령으로 재현할 수 있다.

```bash
node scripts/cli.mjs --input request.json
node scripts/validate-report.mjs --request request.json --request-artifact request-artifact.json --report report.json
```

명령은 JSON을 stdin으로도 받으며 JSON만 stdout으로 반환한다. 테스트를 대신 실행하거나 파일을 수정하지 않는다.

## 절차

1. commit, diff, artifact 또는 관측 상태의 식별자와 digest를 고정한다.
2. `acceptanceCriteria` 순서로 `AC-001` 형식의 ID를 부여한다.
3. 각 evidence가 한 개 이상의 유효한 기준 ID와 현재 대상 digest를 가리키는지 확인한다.
4. 검증되고 현재 대상에 맞는 반증이 있으면 `unsatisfied`, 지지 근거가 있으면 `satisfied`로 둔다.
5. 근거가 없거나 stale하면 `insufficient-evidence`로 둔다. `not-applicable`은 현재 대상에서 검증된 authority evidence가 해당 기준과 `TaskEnvelope.scope.excluded` 또는 `authorization.prohibitedActions`의 실제 항목을 함께 가리키고, 기준 ID와 대상 digest를 포함한 canonical evidence digest가 일치할 때만 허용한다.
6. 모든 기준이 `satisfied` 또는 정당한 `not-applicable`일 때만 `PASS`한다. 반증이 하나라도 있으면 `FAIL`, 남은 근거 부족이 있으면 `BLOCKED`다.
7. 기존 보고서는 원 요청과 외부에서 동결한 request artifact digest를 함께 받아 다시 검증한다. report만 전달하거나 request digest가 일치하지 않으면 통과시키지 않는다.

## 권한과 경계

- 요청된 검증만 실행하고 새 외부 작업, 배포, 승인 또는 권한을 만들지 않는다.
- 파일 존재나 테스트 이름만으로 동작 충족을 추정하지 않는다.
- 다른 commit·artifact에서 얻은 결과를 현재 근거로 사용하지 않는다.
- 선언된 verification command가 현재 대상과 다르면 해당 기준을 완료하지 않고, 현재 대상에서 종료 코드가 0이 아니면 반증으로 처리한다.
- 수용 기준 밖의 보안·복구·운영 실패 모드를 독립 감사처럼 확장하지 않는다.

## 출력

`AcceptanceEvidenceReport.v1`과 짧은 사용자 요약을 반환한다. 기준별 상태, evidence locator, 관측 결과, 제한, 미해결 기준과 `PASS | FAIL | BLOCKED | NEEDS_INPUT`을 구분한다. `TaskEnvelope`에 해결되지 않은 충돌이 있으면 `NEEDS_INPUT`이다. 내부 추론이나 확인하지 않은 사실은 포함하지 않는다.
