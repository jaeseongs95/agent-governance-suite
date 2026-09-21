---
name: blocker-diagnostician
description: 같은 실패가 반복될 때 쓴다. 테스트·빌드·명령·배포·외부 호출 등 무엇이든 같은 증상으로 두 번 이상 실패했을 때, 고쳤는데 또 실패할 때, 원인 후보가 여럿이라 무엇을 먼저 확인할지 정해야 할 때가 해당한다. 관측된 실패 episode와 원인 가설을 분리하고 새 정보를 주는 다음 판별 검사를 고른다. 수정 구현, 같은 검사 반복, 최종 감사는 하지 않는다.
license: MIT
metadata:
  version: "1.1.0"
---

# Blocker Diagnostician

반복 실패를 같은 원인으로 단정하지 않고 증거로 구분한다. 확인된 원인이 있으면 그 근거를 반환하고, 아직 구분할 수 없으면 정보가치가 높고 권한 범위 안에 있는 다음 검사를 하나 정한다.

## 적용 범위

- 첫 수정이 실패한 뒤, adapter·운영체제·패키징 관측이 서로 모순될 때, 실제 호스트와 테스트 결과가 다를 때, 또는 evidence가 충돌할 때 사용한다. 이후 같은 작업이 반복해서 실패하거나 수정 뒤에도 실패가 이어질 때도 사용한다.
- 사용자가 원인 후보 분리나 다음 판별 검사를 요청했을 때 사용한다.
- 명확한 단일 오타, 일반 코드 리뷰, 설계안의 정책·비용 비교에는 자동 적용하지 않는다.
- 해결안 사이의 안전·비용·정책 판단이 핵심이 되면 별도의 숙의가 필요하다고 보고한다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 출력

`DiagnosisReport.v1`과 짧은 사용자 요약을 반환한다. 보고서에는 원 request의 `requestArtifactDigest`를 포함한다. cluster, 관측, 가설, 확정 원인 또는 다음 검사, 중단 조건과 `CAUSE_CONFIRMED | NEXT_TEST | NEEDS_INPUT | NEEDS_APPROVAL | BLOCKED`를 구분한다.
