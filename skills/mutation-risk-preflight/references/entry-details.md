## 불변조건

- 삭제·배포·마이그레이션을 비롯한 mutation 명령이나 외부 도구를 호출하지 않는다.
- 사용자의 요청을 별도 승인으로 바꾸거나, 과거 승인을 현재 대상에 맞는 것으로 추정하지 않는다.
- 광범위한 glob, 해석되지 않은 환경변수, `~`, 홈·filesystem·drive·저장소 루트 전체는 `READY`로 판정하지 않는다.
- 대상, 환경, 범위, 권한, 승인, 현재 상태, 복구 계획, 영향 범위나 행동이 바뀌면 기존 receipt를 무효화한다.
- 사전점검 결과를 변경 후 독립 감사나 릴리스 판정으로 사용하지 않는다.

## 절차

1. `MutationIntent.v1`에서 operation, action, 정확한 target과 현재 fingerprint를 확인한다.
2. [위험 분류](risk-matrix.md)에서 행동별 필수 승인과 복구 조건을 확인한다.
3. [승인·권한 규칙](approval-and-authority.md)에 따라 근거가 같은 operation, action, target, environment를 가리키는지 대조한다.
4. [복구 요건](recovery-requirements.md)에 따라 backup 존재와 restore 검증을 구분한다.
5. `scripts/evaluate-preflight.mjs`로 `MutationPreflightReport.v1`과 action·target digest를 만든다.
6. 실제 변경을 수행할 주체는 직전에 `scripts/verify-preflight-receipt.mjs`로 receipt와 현재 intent가 같은지 확인해야 한다. 검증기는 원 `observedAt`에서 고정 15분 유효기간을 다시 계산하고 보고서 전체를 재생성해 비교한다.
