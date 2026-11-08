---
name: acceptance-evidence-validator
description: Use when the user asks for a per-requirement verdict on work products and verification evidence, or when contract work with several acceptance criteria or high-risk work is finished and its completion evidence must be checked. Judges each criterion met, failed or lacking evidence by matching the frozen work product against actual evidence. Not for small single-task completion reports, simple lookups, choosing design alternatives, repeated-failure diagnosis, high-risk independent audit or release approval.
license: MIT
metadata:
  version: "1.0.0"
---

# Acceptance Evidence Validator

이 스킬을 적용할 때 [공통 행동 기준](../independent-audit-gate/references/specialist-behavior.md)을 먼저 읽고 따른다.

수용 기준마다 현재 대상에 맞는 직접 근거가 있는지 확인한다. 이 스킬의 `PASS`는 요구사항 충족 판정이며, 고위험 변경에 필요한 독립 감사나 릴리스 승인을 대신하지 않는다.

## 근거를 채택하기 전

- `verified: true`, digest 일치나 종료 코드 0만으로 동작을 인정하지 않는다. 원자료를 열어 해당 기준의 입력·실행 대상·검사 내용·관측 결과가 실제로 연결되는지 확인한다.
- 시험·검사 파일의 존재, skip된 사례, 빈 실행, lint·schema 통과를 실제 호스트 동작이나 의미 품질의 증거로 확대하지 않는다. 확인한 범위만 기준에 연결한다.
- 검사를 실행하지 못한 기준은 근거 부족으로 남긴다. 통과를 만들려고 기준을 삭제하거나 실패를 `not-applicable`로 바꾸지 않는다.

## 적용 범위

- 사용자가 요구사항별 결과물·검증 근거 판정을 요청했을 때 사용한다.
- 수용 기준이 여럿인 계약 작업이나 고위험 작업을 마친 뒤 완료 선언에 필요한 근거를 점검할 때 사용한다. 작은 단일 작업은 이 스킬 없이 실제로 실행한 검사와 결과를 보고에 바로 적는다.
- 단순 조회, 설계 대안 선택, 실패 원인 분석에는 사용하지 않는다.
- 모호하거나 충돌하는 수용 기준은 임의로 해석하지 않고 계약 재정리가 필요하다고 보고한다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 출력

`AcceptanceEvidenceReport.v1`과 짧은 사용자 요약을 반환한다. 기준별 상태, evidence locator, 관측 결과, 제한, 미해결 기준과 `PASS | FAIL | BLOCKED | NEEDS_INPUT`을 구분한다. `TaskEnvelope`에 해결되지 않은 충돌이 있으면 `NEEDS_INPUT`이다. 내부 추론이나 확인하지 않은 사실은 포함하지 않는다.
