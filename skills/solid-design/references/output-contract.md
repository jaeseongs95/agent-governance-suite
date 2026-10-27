# AGS 입출력 계약

직접 호출은 사용자가 요청한 일반 응답 형식을 사용하라. AGS provider의 bootstrap 산출물로 구조화 artifact를 전달할 때만 이 계약을 적용하라. `TaskEnvelope.v1`·공통 provider 결과·권한 체계는 그대로 사용한다.

이 provider는 `plan_workflow` 이전에 수행하는 설계 조언이며, `TaskEnvelope.requiredCapabilities`에 추가할 workflow 단계가 아니다. 기존 orchestrator/실행자가 결과를 읽고 연결한다. 등록만으로 MCP가 이 스킬의 모델 분석이나 CLI를 자동 실행하는 것은 아니다.

## 입력

`solid-design-request`는 `contracts/solid-design-request.v1.schema.json`을 따른다.

- `requestId`, `objective`: 이번 설계 판단의 식별자와 목적.
- `snapshotRef`: commit, patch digest, 또는 고정 설계 revision. 브랜치 이름만 사용하지 마라.
- `targets`: 분석 대상 식별자 목록. 범위 확대 없이 실제 파일·심볼·설계 항목을 지정하라.
- `instructionRefs`, `contractRefs`, `priorFindingRefs`: 실제 읽은 지침·기존 계약·중복 확인할 finding 참조. 없으면 빈 배열을 사용하고 새 계약을 지어내지 마라.

필수 입력 참조가 없으면 `require-external` binding을 충족한 척하지 마라. 가용한 자료에서 먼저 준비하고, 본질적으로 빠진 근거는 `NEEDS_INPUT`으로 남겨라.

## 결과

`solid-design-report`는 `contracts/solid-design-report.v1.schema.json`을 따른다.

- `requestId`, `requestDigest`, `snapshotRef`: 원 입력과 같은 대상에 결속하라. digest는 요청 파일의 실제 bytes 전체에 대한 `sha256:<hex>`다.
- `status`: `ANALYZED`는 기재한 범위의 설계 분석 완료, `NOT_APPLICABLE`은 적용 대상 아님, `NEEDS_INPUT`은 핵심 근거 부족이다.
- `principlesConsidered`: 실제 판단에 사용한 원칙만 기록하라.
- `scope.reviewed`, `scope.notReviewed`: 모든 요청 대상을 둘 중 한 곳에 정확히 한 번 기록하라.
- `findings`: 관찰과 추론을 분리하고 `contract-violation`, `design-recommendation`, `preserve-boundary`를 구분하라. 계약 위반에는 실제 `contractRefs`를 하나 이상 연결하라. 읽지 않은 대상에 finding을 만들지 마라.
- `limitations`, `handoffs`: 누락과 기존 담당에게 넘길 항목을 기록하라. 인계 기록은 스킬 실행·위임 완료가 아니다.

`NOT_APPLICABLE`에는 findings와 principlesConsidered를 비워라. `NEEDS_INPUT`에는 누락 내용을 limitations에 명시하라. `ANALYZED`에서 findings가 비어도 해당 범위의 분석 완료일 뿐 무결함 보장은 아니다. 계약 위반 finding이 있어도 advisory 단계 수행 완료와 구분하며, 기존 수용·실행 경로가 그 위반을 처리하도록 전달하라.

## 결정론적 검사

AGS 루트에서 다음 CLI를 실행하라. Node.js와 AGS의 기존 `runtime/schema-validation.mjs`를 사용하며 새 외부 패키지는 필요 없다.

```sh
node skills/solid-design/scripts/check-report.mjs --request request.json --report report.json
```

검사는 schema, 요청 bytes digest, 후보·ID 일치, 범위 누락·중복, finding의 대상·원칙·계약·이전 finding 참조 결속을 확인한다. 파일을 변경하지 않는다.

`valid: true`의 검증 범위는 **구조와 결속**이다. evidenceRefs가 실제 존재하는지, 원문이 주장을 지지하는지, 사람이 제시한 후보명이 진짜인지, 설계가 올바른지는 이 CLI가 판정하지 않는다. 이를 실행자가 원자료로 확인하고 기존 근거 수용 경로에 전달하라. runtime의 generic output-schema 검사만으로 이 CLI의 교차 artifact 검사까지 실행됐다고 주장하지 마라.

descriptor는 `ANALYZED`·`NOT_APPLICABLE`을 기존 provider 상태 `passed`에, `NEEDS_INPUT`을 `blocked`와 `MISSING_EVIDENCE`에 대응한다. 이는 선택된 advisory 단계의 처리 상태다. 새 approval·release gate·전용 MCP handler는 없다. 아직 검증하지 않은 결과를 자동 승인하지 마라.
