---
name: acceptance-evidence-validator
description: 구현을 마치고 완료를 보고하기 전, 테스트·검사 결과를 수용 기준과 대조해야 할 때, 사용자가 '다 됐는지' 물을 때 쓴다. 고정된 구현 대상과 실제 근거를 기준별로 대조해 충족·실패·증거 부족을 판정한다. 구현, 반복 실패 진단, 고위험 독립 감사, 릴리스 승인은 하지 않는다.
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

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 출력

`AcceptanceEvidenceReport.v1`과 짧은 사용자 요약을 반환한다. 기준별 상태, evidence locator, 관측 결과, 제한, 미해결 기준과 `PASS | FAIL | BLOCKED | NEEDS_INPUT`을 구분한다. `TaskEnvelope`에 해결되지 않은 충돌이 있으면 `NEEDS_INPUT`이다. 내부 추론이나 확인하지 않은 사실은 포함하지 않는다.
