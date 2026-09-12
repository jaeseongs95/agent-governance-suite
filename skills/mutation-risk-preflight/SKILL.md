---
name: mutation-risk-preflight
description: 삭제, 배포, 게시, 마이그레이션, 권한·결제·전역 설정 변경 전에 정확한 대상, 승인, 영향 범위와 복구 조건을 읽기 전용으로 점검한다. 실제 변경이나 변경 후 감사에는 사용하지 않는다.
license: MIT
metadata:
  version: "1.0.0"
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

## 불변조건

- 삭제·배포·마이그레이션을 비롯한 mutation 명령이나 외부 도구를 호출하지 않는다.
- 사용자의 요청을 별도 승인으로 바꾸거나, 과거 승인을 현재 대상에 맞는 것으로 추정하지 않는다.
- 광범위한 glob, 해석되지 않은 환경변수, `~`, 홈·filesystem·drive·저장소 루트 전체는 `READY`로 판정하지 않는다.
- 대상, 환경, 범위, 권한, 승인, 현재 상태, 복구 계획, 영향 범위나 행동이 바뀌면 기존 receipt를 무효화한다.
- 사전점검 결과를 변경 후 독립 감사나 릴리스 판정으로 사용하지 않는다.

## 절차

1. `MutationIntent.v1`에서 operation, action, 정확한 target과 현재 fingerprint를 확인한다.
2. [위험 분류](references/risk-matrix.md)에서 행동별 필수 승인과 복구 조건을 확인한다.
3. [승인·권한 규칙](references/approval-and-authority.md)에 따라 근거가 같은 operation, action, target, environment를 가리키는지 대조한다.
4. [복구 요건](references/recovery-requirements.md)에 따라 backup 존재와 restore 검증을 구분한다.
5. `scripts/evaluate-preflight.mjs`로 `MutationPreflightReport.v1`과 action·target digest를 만든다.
6. 실제 변경을 수행할 주체는 직전에 `scripts/verify-preflight-receipt.mjs`로 receipt와 현재 intent가 같은지 확인해야 한다. 검증기는 원 `observedAt`에서 고정 15분 유효기간을 다시 계산하고 보고서 전체를 재생성해 비교한다.

## 판정

- `READY`: 이 스킬이 확인할 사전조건을 충족했다. 실행 권한을 새로 부여하지 않는다.
- `NEEDS_INPUT`: 대상 상태나 필수 근거를 더 확인해야 한다.
- `NEEDS_APPROVAL`: 별도 승인이 필요하거나 현재 승인 범위가 맞지 않는다.
- `NEEDS_REDESIGN`: 현재 복구 계획이나 영향 범위로는 진행할 수 없다.
- `BLOCKED`: 대상이 안전하게 특정되지 않았거나 입력 자체가 유효하지 않다.

변경 후 완료·병합·릴리스 여부는 고정된 최종 결과를 대상으로 독립 감사자가 별도로 판정한다.
