---
name: mutation-risk-preflight
description: rm·삭제, 배포·게시, DB 마이그레이션, 권한·결제·전역 설정 변경, 되돌릴 수 없는 명령을 실행하기 직전에 쓴다. 정확한 대상·승인 여부·영향 범위·복구 조건을 읽기 전용으로 점검한다. 실제 변경 실행과 변경 후 감사는 하지 않는다.
license: MIT
metadata:
  version: "1.0.1"
---

# Mutation Risk Preflight

실제 상태 변경 직전에 계획된 행동과 대상을 고정하고, 현재 권한·승인·복구 근거로 시작 가능 여부를 판정한다. 이 스킬의 `READY`는 새 권한이나 승인을 만들지 않으며 실제 변경을 수행하지 않는다.

## 적용 조건

- 삭제, 덮어쓰기, 대량 이동, 배포, 공개 게시 또는 릴리스
- 데이터나 schema migration
- 권한, 비밀정보, 결제 또는 전역 설정 변경
- 복구가 어렵거나 외부 사용자에게 영향을 주는 작업
- 사용자가 명시적으로 사전 위험 점검을 요청한 경우

읽기 전용 조사, 쉽게 되돌릴 수 있는 일반 로컬 편집, 변경 완료 후 감사, 구체적인 대상이 없는 일반 위험 설명에는 자동 적용하지 않는다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 판정

- `READY`: 이 스킬이 확인할 사전조건을 충족했다. 실행 권한을 새로 부여하지 않는다.
- `NEEDS_INPUT`: 대상 상태나 필수 근거를 더 확인해야 한다.
- `NEEDS_APPROVAL`: 별도 승인이 필요하거나 현재 승인 범위가 맞지 않는다.
- `NEEDS_REDESIGN`: 현재 복구 계획이나 영향 범위로는 진행할 수 없다.
- `BLOCKED`: 대상이 안전하게 특정되지 않았거나 입력 자체가 유효하지 않다.

변경 후 완료·병합·릴리스 여부는 고정된 최종 결과를 대상으로 독립 감사자가 별도로 판정한다.
