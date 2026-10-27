---
name: mutation-risk-preflight
description: 되돌리기 어려운 영구 삭제·덮어쓰기, 운영 데이터 변경·마이그레이션, 배포·게시, 권한·결제·전역 설정 변경 직전에 정확한 대상, 승인, 영향 범위와 복구 조건을 읽기 전용으로 점검한다. 같은 디스크 안 이동, 되돌릴 수 있는 로컬 편집, 시험·작업 브랜치 push, 실제 변경이나 변경 후 감사에는 사용하지 않는다.
license: MIT
metadata:
  version: "1.0.1"
---

# Mutation Risk Preflight

실제 상태 변경 직전에 계획된 행동과 대상을 고정하고, 현재 권한·승인·복구 근거로 시작 가능 여부를 판정한다. 이 스킬의 `READY`는 새 권한이나 승인을 만들지 않으며 실제 변경을 수행하지 않는다.

## 적용 조건

행동 이름이 아니라 규모, 되돌릴 수 있는지, 실데이터·공유 자원·외부 공개에 닿는지로 판단한다.

- 백업·휴지통 없는 영구 삭제나 덮어쓰기, 운영 데이터 대량 변경
- 운영 데이터나 schema migration
- 배포, 공개 게시, tag/release, 기본 브랜치 병합
- 권한 확대, 비밀정보, 결제 또는 전역 설정 변경
- 그 밖에 복구가 어렵거나 다른 사용자·외부 서비스에 영향을 주는 작업
- 사용자가 명시적으로 사전 위험 점검을 요청한 경우

읽기 전용 조사, 같은 디스크 안 이동·이름 변경, 원본이나 백업이 남는 복사, git이나 백업으로 되돌릴 수 있는 로컬 편집, 작업 브랜치 commit·push, 시험·CI 실행, 변경 완료 후 감사, 구체적인 대상이 없는 일반 위험 설명에는 적용하지 않는다. 이런 일은 점검 없이 바로 하고 결과를 직접 확인한다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 판정

- `READY`: 이 스킬이 확인할 사전조건을 충족했다. 실행 권한을 새로 부여하지 않는다.
- `NEEDS_INPUT`: 대상 상태나 필수 근거를 더 확인해야 한다.
- `NEEDS_APPROVAL`: 별도 승인이 필요하거나 현재 승인 범위가 맞지 않는다. 우회 작업을 만들지 말고 대상·영향·실행할 명령·복구 방법을 담아 사용자에게 바로 묻는다.
- `NEEDS_REDESIGN`: 현재 복구 계획이나 영향 범위로는 진행할 수 없다.
- `BLOCKED`: 대상이 안전하게 특정되지 않았거나 입력 자체가 유효하지 않다.

변경 후 완료·병합·릴리스 여부는 고정된 최종 결과를 대상으로 독립 감사자가 별도로 판정한다.
