# 복구 요건

backup이 존재한다는 사실과 실제 restore 가능성을 구분한다. data loss나 schema 변경 가능성이 있는 작업은 복구 수단, 복구 절차와 검증 근거가 필요하다.

복구가 본질적으로 불가능한 작업은 그 사실과 영향 범위가 명시적으로 수용된 경우에만 다음 판단으로 넘길 수 있다. `recoveryPlan.available: false`와 `irreversibilityAccepted: true`가 이 경우를 나타내며, 존재하지 않는 backup·복구 절차·restore 검증을 요구하지 않는다. 이 수용은 scope·authorization·필요한 승인·현재 fingerprint·영향 범위 검사를 대신하지 않는다. `available: true`인 복구 계획에는 기존 복구 수단·backup·복구 절차 요건을 계속 적용한다. 사전점검은 backup이나 rollback 명령을 실행하지 않고 evidence reference의 대상 일치 여부만 확인한다.

복구 절차가 현재 변경보다 더 넓거나 위험하면 `NEEDS_REDESIGN`으로 판정한다.
