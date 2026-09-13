# Recovery Selection Protocol

## 전략 작성

`DiagnosisReport.v1.verdict`가 `CAUSE_CONFIRMED`이고 `confirmedCause`가 존재할 때만 전략을 작성한다. 원본 diagnosis request와 외부 동결 digest로 기존 diagnosis validator를 다시 통과해야 하며, 실패 workflow receipt payload도 digest·run metadata·원본 task digest가 모두 일치해야 한다. diagnosis objective는 source task objective와 같아야 하고, `confirmedCause.evidenceBindings`에는 source task digest와 workflow receipt digest가 확정 가설의 supporting evidence로 직접 들어 있어야 한다. 전략은 이름이나 중단 조건만 달리하지 말고 mechanism, actions 또는 write targets가 달라야 한다. 원래 목표와 수용 기준은 복구 편의를 위해 완화하지 않는다.

각 action은 요청의 authorization evidence 하나와 정확히 대응해야 한다. 프로젝트 지침은 행동을 제한할 수 있지만 허용 권한을 새로 만들 수 없다. 승인으로 해소 가능한 행동은 전략에 남길 수 있으나 handoff만으로 승인됐다고 보지 않는다.

## Objective Gate

Gate는 점수가 아니라 필수 조건이다. 다음 전략은 `FAIL`이다.

- 원래 objective 또는 acceptance criteria를 보존하지 않는다.
- 확인된 원인을 해결·격리·우회하지 못한다.
- prohibited action을 포함한다.
- 선행 조건이 `unknown` 또는 `failed`다.
- 검증이 `unavailable`이거나 검증 단계·중단 조건이 없다.
- 기존 실패 시도의 strategy fingerprint를 반복한다.
- 기존 workflow run이나 receipt locator를 action 또는 write target으로 삼는다. 작성자의 `mutatesPriorRun` 자기신고와 관계없이 target에서 판정한다.

나머지 전략 중 승인 또는 scope 확대가 필요한 전략은 `REQUIRES_APPROVAL`, 그렇지 않은 전략은 `PASS`다.

## 복수 전략 비교

생존 전략이 둘 이상이면 모든 생존 전략에 challenge와 response를 하나씩 작성하고 다음 축을 사전식으로 비교한다.

1. `causeFit`: `direct`, `containment`, `workaround`
2. `verificationStrength`: `direct`, `indirect`
3. `reversibility`: `full`, `partial`, `none`
4. `failureImpact`: `low`, `medium`, `high`, `critical`
5. `changeBreadth`: 작은 값 우선
6. Gate: `PASS`, `REQUIRES_APPROVAL`

가중 점수나 숨은 보정치를 사용하지 않는다. 최상위 전략이 하나면 선택하고, 모든 축이 같은 최상위 전략이 둘 이상이면 `NEEDS_INPUT`으로 반환한다. 내부 비교는 독립 감사나 다중 에이전트 검토라고 표현하지 않는다.

## 새 작업 인계

`nextTaskSeed`는 원래 objective와 acceptance criteria를 유지하고 선택 전략의 actions, write targets와 검증 계획만 투영한다. 권한은 새 `TaskContractRequest.v1`의 authority evidence와 그 근거에 정확히 결속된 `TaskContractReport.v1`에서 다시 정한다. 새 task는 원본 task와 다른 ID를 사용하고 handoff digest를 request supplied fact와 core provenance에 기록한다. 원본 prohibited action은 제거하지 않으며, 승인 필요 action은 system·developer·user의 실제 `allow` 근거가 없으면 allowed action으로 옮기지 않는다.
