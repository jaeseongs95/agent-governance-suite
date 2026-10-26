# 복구 요건

backup이 존재한다는 사실과 실제 restore 가능성을 구분한다. data loss나 schema 변경 가능성이 있는 작업은 복구 수단, 복구 절차와 검증 근거가 필요하다.

복구가 본질적으로 불가능한 작업은 그 사실과 영향 범위가 명시적으로 수용된 경우에만 다음 판단으로 넘길 수 있다. `recoveryPlan.available: false`와 `irreversibilityAccepted: true`가 이 경우를 나타내며, 존재하지 않는 backup·복구 절차·restore 검증을 요구하지 않는다. 이 수용은 scope·authorization·필요한 승인·현재 fingerprint·영향 범위 검사를 대신하지 않는다. `available: true`인 복구 계획에는 기존 복구 수단·backup·복구 절차 요건을 계속 적용한다. 사전점검은 backup이나 rollback 명령을 실행하지 않고 evidence reference의 대상 일치 여부만 확인한다.

복구 절차가 현재 변경보다 더 넓거나 위험하면 `NEEDS_REDESIGN`으로 판정한다.

## 새 자원의 중단·보존

기존 상태의 복원과 새 자원의 부분 생성 후 containment를 구분한다. `permission-change`, `deploy`, `other` 중 실제로 새 자원만 추가하고 기존 데이터·권한·외부 서비스에 영향을 주지 않는 작업은 `recoveryPlan.freshResourceContainment`로 표현할 수 있다. 기존 작업의 승인·범위·권위·현재 fingerprint 검사는 그대로 적용하며, 환경·벤더·대상 이름이나 `available`·`method` 문구만으로 이 경로를 선택하지 않는다.

- 모든 대상의 기존 `currentStateEvidenceRefs`에 `existence: "absent"`를 기록한다. 같은 대상의 관측이 누락되거나 present/unknown 또는 다른 fingerprint와 충돌하면 사용할 수 없다. 자식 자원의 부재를 부모 부재로 입증한다면 그 종속 관계까지 증거에서 확인해야 한다.
- `commandDigest`는 `plannedCommandOrTool` 전체의 canonical JSON SHA256, `targetDigest`는 evaluator의 정확한 대상 digest다. `guardEvidenceRef`는 검증한 source/command와 실제 권위·대상 경계를 식별하며, 첫 mutation 직전에 같은 실행 안에서 신원·부재를 재검사하고 충돌 시 mutation 전에 중단한다는 근거를 고정한다. 과거 부재 snapshot만으로 실행 시 guard를 대신하지 않는다.
- `partialFailure: "stop-preserve"`와 기존 `restoreProcedureRef`는 어느 단계에서 실패해도 중단하고, 새 자원·실제 종료 코드·단계·잔존 상태를 보존하는 절차를 뜻한다. 자동 재시도·자동 삭제·권한 확대를 하지 않는다. 후속 정리나 복구는 실제 잔존 상태와 해당 작업의 별도 고정 범위·원권한을 따르며, 여기서 새 승인을 만들지 않는다.

이 경로는 `backupRef`, `restoreTestEvidenceRef`, 비가역적 데이터 손실 수용을 만들지 않는다. 보고서는 `conditional`, `restoreTested: false`를 유지하며 복원 완료로 표현하지 않는다. data loss, 기존 운영 권한·전역 설정·결제 변경 또는 외부 영향에는 기존 backup·복구 검증 조건을 유지한다. 점검기는 참조된 원자료나 원격 자원의 진위를 새로 관측하지 않으므로 제출자는 부재·권위·guard·절차의 실제 근거를 확인해야 한다. digest는 입력 결속이며 권한이나 신뢰를 발급하는 서명이 아니다.
