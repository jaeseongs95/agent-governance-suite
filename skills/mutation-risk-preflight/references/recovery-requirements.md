# 복구 요건

backup이 존재한다는 사실과 실제 restore 가능성을 구분한다. data loss나 schema 변경 가능성이 있는 작업은 복구 수단, 복구 절차와 검증 근거가 필요하다.

복구가 본질적으로 불가능한 작업은 그 사실과 영향 범위가 명시적으로 수용된 경우에만 다음 판단으로 넘길 수 있다. `recoveryPlan.available: false`와 `irreversibilityAccepted: true`가 이 경우를 나타내며, 존재하지 않는 backup·복구 절차·restore 검증을 요구하지 않는다. 이 수용은 scope·authorization·필요한 승인·현재 fingerprint·영향 범위 검사를 대신하지 않는다. `available: true`인 복구 계획에는 기존 복구 수단·backup·복구 절차 요건을 계속 적용한다. 사전점검은 backup이나 rollback 명령을 실행하지 않고 evidence reference의 대상 일치 여부만 확인한다.

복구 절차가 현재 변경보다 더 넓거나 위험하면 `NEEDS_REDESIGN`으로 판정한다.

## 새 자원의 중단·보존

기존 상태의 복원과 새 자원의 부분 생성 후 containment를 구분한다. `permission-change`, `deploy`, `other` 중 실제로 새 자원만 추가하고 기존 데이터·권한·외부 서비스에 영향을 주지 않는 작업은 `recoveryPlan.freshResourceContainment`로 표현할 수 있다. 제한된 비공개 외부 준비에는 아래 추가 계약이 필요하다. 기존 작업의 승인·범위·권위·현재 fingerprint 검사는 그대로 적용하며, 환경·벤더·대상 이름이나 `available`·`method` 문구만으로 이 경로를 선택하지 않는다.

- 모든 대상의 기존 `currentStateEvidenceRefs`에 `existence: "absent"`를 기록한다. 같은 대상의 관측이 누락되거나 present/unknown 또는 다른 fingerprint와 충돌하면 사용할 수 없다. 자식 자원의 부재를 부모 부재로 입증한다면 그 종속 관계까지 증거에서 확인해야 한다.
- `commandDigest`는 실제 실행할 명령·옵션을 담은 `plannedCommandOrTool` 전체의 canonical JSON SHA256, `targetDigest`는 evaluator의 정확한 대상 digest다. `guardEvidenceRef`는 검증한 source/command와 실제 계정·project·endpoint 및 대상 경계를 식별한다. 같은 실행 안의 신원·부재 재검사에 더해, 각 쓰기 자체가 create-if-absent 또는 동등한 조건부 생성으로 충돌 시 기존 객체를 변경하기 전에 중단함을 확인한다. GET 후 무조건 create/upsert하거나 과거 부재 snapshot만 사용하는 방식은 충분하지 않다. 실제 실행 권위와 대상을 중간에 바꾸지 않는다.
- `partialFailure: "stop-preserve"`와 기존 `restoreProcedureRef`는 어느 단계에서 실패해도 중단하고, 새 자원·실제 종료 코드·단계·잔존 상태를 보존하는 절차를 뜻한다. 자동 재시도·자동 삭제·권한 확대를 하지 않는다. 후속 정리나 복구는 실제 잔존 상태와 해당 작업의 별도 고정 범위·원권한을 따르며, 여기서 새 승인을 만들지 않는다.

이 경로는 `backupRef`, `restoreTestEvidenceRef`, 비가역적 데이터 손실 수용을 만들지 않는다. 보고서는 `conditional`, `restoreTested: false`를 유지하며 복원 완료로 표현하지 않는다. data loss, 기존 운영 권한·전역 설정·결제 변경과 아래 조건을 벗어난 외부 영향에는 기존 backup·복구 검증 조건을 유지한다.

### 제한된 비공개 외부 준비

외부 호출이라는 사실과 실제 공개·기존 상태 변경을 구분한다. `deploy`·`other`의 신규 비공개 준비에만 `freshResourceContainment.externalPreparation`를 추가할 수 있다. 기존 `externalImpact: true`와 승인 요구는 유지한다. production/prod/shared 환경, `publish`, 권한 변경·삭제·덮어쓰기·이전·마이그레이션·결제·전역 설정 변경에는 적용하지 않는다.

- `exposure: "private-unpublished"`, `existingState: "preserved"`, `effectsEvidenceRef: { locator, digest }`와 아래 두 `sideEffects` 중 실제 효과에 맞는 하나를 제공한다. 이 선언만으로 효과를 입증한 것으로 보지 않는다.
- `scoped-resources-only`는 기존 엄격한 모드다. 생성물·승인된 종속 자원 외의 이벤트 전달과 독립 효과가 없다는 근거가 필요하다. 이 모드에 `platformEvents`를 붙이거나 표준 이벤트 예외를 숨겨 넣지 않는다.
- `scoped-resources-plus-platform-events`는 승인된 자원의 생성에 따라 공급자가 기존 통합으로 보내는 표준 이벤트를 별도로 기록하는 모드다. 아래 추가 계약을 모두 만족해야 한다.
- 효과 근거는 검토한 공급자 계약 버전(예: source/API 계약 버전)과 실제 대상 조건을 가리켜야 한다. 생성물·의도된 종속 자원을 모두 target/scope에 포함하고 비공개성을 확인한다. 공개 tag·공개 URL·새 webhook·별도 알림/dispatch·자동 배포·과금·비밀 추가·기존 권한/트래픽/설정 변경 같은 구체적 독립 효과가 있거나 필수 효과 근거가 불명확하면 이 경로를 선택하지 않는다. `draft`라는 이름만으로 비공개·무영향을 추정하지 않는다.
- 결과 유실·timeout은 미실행 증거가 아니다. 쓰기 결과가 불명확해도 자동 재시도·삭제 없이 실제 단계·종료 결과와 잔존 상태를 보존한다. 그 후의 공개·기존 객체 수정은 실제 상태와 기존 승인에 맞는 별도 intent로 다시 점검한다. 일반적인 파일 회차마다 별도 승인을 붙이지 않는다.
- 이 외부 준비 모드에는 복원용 `backupRef`·`restoreTestEvidenceRef`를 섞지 않고 `irreversibilityAccepted: false`를 유지한다. 모드 조건이 실패하면 복원 경로로 자동 fallback하지 않는다. 기존 로컬 containment도 외부 준비 선언을 무시해 통과시키지 않는다.

### 기존 통합으로의 공급자 표준 이벤트

`scoped-resources-plus-platform-events`는 다음 `platformEvents` 객체를 필수로 제출한다. JSON Schema는 필수 필드·값·빈 고위험 목록을 강제하고 evaluator는 원래 승인·권한·부재·조건부 생성·중단 및 보존 검사를 그대로 적용한다.

```json
{
  "providerStandardEvents": "possible",
  "integrationChanges": 0,
  "recipientChanges": 0,
  "permissionChanges": 0,
  "separateDispatches": 0,
  "payloadScope": "approved-targets-only",
  "recipientInventory": "not-observable",
  "knownHighRiskFollowUpEffects": [],
  "approvalConditions": "compatible",
  "requiredTargetQueries": "succeeded"
}
```

- `providerStandardEvents: "possible"`은 기존 통합에 이벤트가 갈 수 있음을 긍정 기록한다. 이벤트 종류·발생 조건·승인 대상 payload·확인한 기존 통합과 후속 효과를 `effectsEvidenceRef` 원자료에 남긴다. 이벤트 수신이나 후속 처리 완료를 증명한다는 뜻은 아니다.
- `recipientInventory`는 확인한 범위에서 전체 수신자 목록을 관측했으면 `observed`, 조회 수단(예: API)·권한 한계로 전체 목록을 관측할 수 없으면 `not-observable`이다. 목록 미관측만으로 거부하지 않지만 `none`으로 바꾸지 않는다. hooks/workflows 0건은 모든 앱 부재의 증거가 아니며, 목록 조회 거부(예: 목록 API의 403)도 앱 부재를 증명하지 않는다.
- 기존 통합·수신자·권한을 바꾸지 않고 새 hook·토큰·앱 설치나 별도 dispatch를 만들지 않아야 한다. payload는 승인 대상만 포함하고 비밀이나 추가 대상을 넣지 않는다. 알려진 자동 배포·과금·비밀 추가 등 고위험 후속 효과는 빈 목록으로 숨기지 말고 진행을 거부한다. 모든 수신자의 무해함을 증명하라는 요구와 구체적으로 알려진 위험을 무시하는 것은 모두 이 계약과 다르다.
- 원 사용자 승인의 무알림 조건이나 특정 수신자 제한과 충돌하면 `approvalConditions: "compatible"`로 기록할 수 없다. 정확한 대상·권한·조건부 생성·비공개성 판정에 필요한 조회가 실패하면 `requiredTargetQueries: "succeeded"`로 기록할 수 없다. 전체 수신자 목록 조회의 관측 한계는 이 필수 대상 조회와 구분한다.
- 실제 원자료가 필드를 지지할 때만 위 값을 제출한다. schema-valid 선언이나 403을 성공으로 해석하지 않는다. 표준 이벤트의 일반적 가능성만으로 기존 승인을 폐기하거나, 이 모드를 실제 공개·운영 변경의 승인으로 확대하지 않는다.

### 근거 참조와 실제 검증의 구분

점검기는 참조된 원자료나 원격 자원의 진위를 새로 관측하지 않는다. 제출자는 부재·권위·조건부 생성·효과·절차의 실제 근거를 확인해야 한다. 기존 복원 모드의 호환 필드 `restoreTested`는 시험 근거 참조의 제출 여부이며, 점검기가 그 시험을 실행하거나 대상·범위·결과를 자동 검증했다는 뜻이 아니다. 다른 대상의 시험을 동일 객체의 실제 복원으로 확대하지 않는다. 근거가 부족하면 그 범위만 명확히 남기며, 참조 문자열·위험 수용을 만들어 채우지 않는다. digest는 입력 결속이며 권한이나 신뢰를 발급하는 서명이 아니다.
