---
name: recovery-strategy-selector
description: 확인된 반복 실패 원인 뒤에 실행 가능한 복구 전략을 비교하고, 새 작업 계약으로 안전하게 넘길 RecoveryHandoff.v1을 만든다. 원인 미확정 진단, 수정 실행, 기존 run 변경에는 사용하지 않는다.
license: MIT
metadata:
  version: "0.1.0"
---

# Recovery Strategy Selector

확인된 실패 원인을 해결할 독립 전략 2~3개를 만들고, 목표·권한·검증 불변조건을 통과한 전략만 비교해 새 작업용 handoff를 반환한다. 전략을 직접 실행하거나 기존 workflow를 수정하지 않는다.

## 입력

`RecoveryStrategySelectionRequest.v1`을 받는다. 입력에는 `CAUSE_CONFIRMED`인 `DiagnosisReport.v1`과 그 원본 diagnosis request·외부 동결 digest, 원본 `TaskEnvelope.v1`, 실패한 `WorkflowReceipt.v1` payload·locator·digest, 기존 시도 fingerprint, 현재 제약과 권한 근거를 포함한다.

전략을 만들기 전에 [선택 프로토콜](references/selection-protocol.md)을 읽는다. 요청을 작성한 뒤 `digest-request.mjs`의 digest를 외부 상태에 동결하고, handoff는 `validate-handoff.mjs`로 검증한다.

```bash
node scripts/digest-request.mjs --input selection-request.json
node scripts/validate-handoff.mjs --input validation-input.json
node scripts/validate-task-binding.mjs --input task-binding-input.json
```

모든 CLI는 stdin도 지원하고 JSON만 stdout으로 반환한다.

## 절차

1. 기존 diagnosis validator로 report와 원본 diagnosis request·외부 동결 digest를 다시 검증한다. 실패 receipt payload의 digest, run metadata와 원본 task digest 결속을 확인하고, 확정 원인의 직접 evidence binding에 source task와 receipt digest가 모두 있는지 대조한다. 원인이 확정되지 않았거나 다른 실패의 diagnosis이거나 evidence가 변조됐으면 전략을 만들지 않는다.
2. 서로 다른 mechanism, action과 write target을 가진 전략 2~3개를 만든다. 각 전략에 선행 조건, 권한 요구, 검증 방법, 중단 조건과 실패 영향을 기록한다.
3. Objective Gate에서 목표·수용 기준 약화, 금지 행동, 미충족 선행 조건, 검증 부재, 기존 실패 반복과 기존 run 변경을 제외한다. 사용자 승인으로만 해소되는 전략은 `REQUIRES_APPROVAL`로 보존한다.
4. 생존 전략이 둘 이상이면 고정 비교축으로 각 전략의 challenge와 response를 기록한다. 가중 점수를 만들지 않으며 동률은 사용자가 결정하도록 남긴다.
5. 선택 결과와 `nextTaskSeed`를 `RecoveryHandoff.v1`로 반환한다. seed는 요청 행동을 기술하지만 권한을 부여하지 않는다.
6. 새 `TaskContractRequest.v1`과 `TaskContractReport.v1`을 만들었으면 `validate-task-binding.mjs`로 기존 task-contract validator를 실행하고 handoff digest, 새 task ID, scope·criteria·work unit과 실제 상위 권한 근거를 대조한다.

## 경계와 실패 처리

- 기존 run, receipt, 실패 판정이나 실행 예산을 수정하거나 되살리지 않는다.
- `NEEDS_APPROVAL` handoff만으로 후속 mutation을 시작하지 않는다. 실제 사용자·시스템·개발자 승인 근거를 새 task contract에 결속한다.
- 생존 전략이 없으면 `NO_VIABLE_STRATEGY`, 동률이면 `NEEDS_INPUT`, 증거 또는 결속이 유효하지 않으면 `BLOCKED`로 끝낸다.
- 새 workflow는 새 `TaskEnvelope.v1`과 새 convergence root를 사용한다. selector는 workflow를 자동 생성하거나 시작하지 않는다.

## 출력

`RecoveryHandoff.v1`과 짧은 사용자 요약을 반환한다. verdict는 `SELECTED | NEEDS_APPROVAL | NEEDS_INPUT | NO_VIABLE_STRATEGY | BLOCKED`다.
