---
name: blocker-diagnostician
description: 반복되는 실패를 관측 episode와 원인 가설로 분리하고, 새 정보를 얻을 수 있는 다음 판별 검사를 정한다. 수정 구현, 일반 설계 비교, 같은 검사의 반복 실행이나 최종 독립 감사에는 사용하지 않는다.
license: MIT
metadata:
  version: "1.1.0"
---

# Blocker Diagnostician

이 스킬을 적용할 때 [공통 행동 기준](../independent-audit-gate/references/specialist-behavior.md)을 먼저 읽고 따른다.

반복 실패를 같은 원인으로 단정하지 않고 증거로 구분한다. 확인된 원인이 있으면 그 근거를 반환하고, 아직 구분할 수 없으면 정보가치가 높고 권한 범위 안에 있는 다음 검사를 하나 정한다.

## 진단의 기준

- 오류가 사라진 것과 원인 메커니즘을 확인한 것을 구분한다. 재시작·시간 경과·timeout 증가 뒤 성공했다는 사실만으로 근본 원인을 확정하지 않는다.
- 실패한 실제 실행 경로(예: 코드 경로, 작업 절차)와 해당 버전의 의존성·환경을 먼저 대조한다. 비슷한 오류 문구만으로 다른 환경의 실패를 합치거나 근거 없는 원인 목록을 늘리지 않는다.
- 다음 검사는 경쟁 가설을 가르는 관측 하나를 목표로 한다. 이름·표현·무관한 입력값만 바꾼 검사를 새 시도로 제안하지 않는다.

## 적용 범위

- 같은 작업이 반복해서 실패하거나 수정 뒤에도 실패가 이어질 때, adapter·운영체제·패키징 관측이 서로 모순될 때, 실제 호스트와 시험 결과가 다를 때, 또는 evidence가 충돌할 때 사용한다. 단순한 첫 수정 실패는 기존 사용자 요청·goal·프로젝트 지침의 권한으로 수정·재시도하며, 실패 한 번만으로 진단·새 계약·다중감사를 자동 요구하지 않는다.
- 사용자가 원인 후보 분리나 다음 판별 검사를 요청했을 때 사용한다.
- 명확한 단일 오타, 일반 코드 리뷰, 설계안의 정책·비용 비교에는 자동 적용하지 않는다.
- 해결안 사이의 안전·비용·정책 판단이 핵심이 되면 별도의 숙의가 필요하다고 보고한다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 출력

`DiagnosisReport.v1`과 짧은 사용자 요약을 반환한다. 보고서에는 원 request의 `requestArtifactDigest`를 포함한다. cluster, 관측, 가설, 확정 원인 또는 다음 검사, 중단 조건과 `CAUSE_CONFIRMED | NEXT_TEST | NEEDS_INPUT | NEEDS_APPROVAL | BLOCKED`를 구분한다.
