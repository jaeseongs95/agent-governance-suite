# 입출력 계약

일반 호출에서는 요청된 결과물·코드·설계·검토 결과와 필요한 설명을 제공하라. 다음 JSON은 정식 AGS provider 결과가 필요할 때만 사용한다. 작은 수정에 새 문서나 workflow를 요구하지 마라.

## 입력

`ui-ux-design-request`는 [request schema](../contracts/ui-ux-design-request.v1.schema.json)를 따른다.

| 필드 | 의미 |
| --- | --- |
| requestId / snapshotRef | 기존 요청 ID와 검토할 소스·결과물·설계의 고정 revision. 새 설계에는 실제 요청 snapshot을 사용 |
| mode | design: 사용할 흐름·구성·상태 설계 작성 / review: 기존 흐름·결과물의 문제와 개선안 검토 |
| objective / surface / targets | 사용자가 끝낼 일, 매체(화면: web·desktop·mobile·cross-platform / print·video·physical-space·physical-product·service-process·document / 여러 매체: multi-channel), 요청된 대상 |
| constraints | 이미 정해진 범위·디자인 시스템·언어·권한·검증 환경 등 보존 조건 |
| evidenceRefs | 실제 읽은 결과물·소스·사용자 관찰의 참조. 신규 설계라 기존 결과물이 없으면 빈 배열 허용 |

이 입력은 설계 snapshot이며 실행 권한이 아니다. `targets`에는 결과를 낼 대상을, `evidenceRefs`에는 참고 자료를 넣어라. 검토에 핵심 자료가 없으면 가능한 결과를 보존하고 `NEEDS_INPUT`으로 남겨라. 사용자에게 이미 받은 정보나 승인을 다시 요구하지 마라.

## 출력

`ui-ux-design-report`는 [report schema](../contracts/ui-ux-design-report.v1.schema.json)를 따른다.

| 필드 | 의미 |
| --- | --- |
| status | ANALYZED: 요청 범위 설계·검토 완료 / NOT_APPLICABLE: UI/UX 작업 아님 / NEEDS_INPUT: 핵심 입력·조건 미해결 |
| requestId / snapshotRef / mode | 실제 입력과 동일한 요청·revision·설계 또는 검토 구분 |
| scope | 실제 검토한 대상과 미검토 대상. 요청 targets를 빠짐없이, 겹치지 않게 분배 |
| deliverables | flow·design·prototype·review 결과(시안·구성안·절차안 포함). content에 사용할 본문 또는 결과 요약을 넣고 파일이 있으면 ref로 연결. 별도 파일이 없으면 ref는 null |
| findings | 관찰·추론·가설 구분, 대상과 근거, 사용자 영향, 구체적인 수정안. 단순 취향을 blocking 결함으로 올리지 않음 |
| checks | 검사 종류·범위·환경·결과·근거. 실행하지 않았다면 NOT_RUN, 미적용이면 NOT_APPLICABLE과 구체적인 이유 |
| limitations / handoffs | 실제로 남은 제약과 기존 구현·수용·감사 담당에 전달할 내용 |

`ANALYZED`에는 검토한 대상과 사용할 결과가 있어야 하며 미검토 대상을 숨기지 마라. 결함을 발견한 review도 완료될 수 있다. 이는 제품 통과나 접근성 준수·성능 개선을 뜻하지 않는다. 설계만 요청한 작업의 실행 검사는 `NOT_RUN`으로 둘 수 있으며 이유를 `detail`과 `limitations`에 남긴다. 실제 검증까지 요청받았는데 필요한 환경이 없다면 해당 요청은 `NEEDS_INPUT`으로 부분 결과를 보존하라.

실제로 수행한 검사에만 `PASSED` 또는 `FAILED`를 쓰고 환경과 근거를 연결하라. 대상 사용자에게 통하는지의 점검·관찰은 `audience`, 정적 검사는 `static`, 결과물 관측은 `visual`, 키보드·입력·조작·전이는 `interaction`, 접근성 검사는 `accessibility`, 측정은 `performance`로 구분하라. `audience`의 scope에는 검토자 기준 대조·노출 조건 재현·실제 사용자 관찰 중 무엇인지와 참여 조건을 적어라. 각 상태는 그 항목의 scope만 나타낸다. NOT_RUN·NOT_APPLICABLE 항목의 evidenceRefs는 비워 과거 결과를 새 실행 근거로 섞지 마라. 가상 사례나 schema 검사는 실제 실행·사용자 관찰 근거가 아니다.

## 구조 검사와 실제 검증의 경계

MCP의 정식 provider 결과는 descriptor의 `outputSchema`와 `stateMapping`으로 구조와 단계 상태를 검사한다. 알 수 없는 상태, 승인 필드, 근거·환경 없는 실행 성공 선언은 schema가 거부한다. `ANALYZED`와 `NOT_APPLICABLE`의 provider `passed`는 이 전문 단계의 종료만 뜻한다.

이 스킬은 별도 실행 스크립트나 semantic validator를 추가하지 않는다. request schema와 report schema만으로 두 문서의 ID·revision·대상 목록이 같은지, 참조가 실제로 존재하는지, 결과물이 대상 사용자에게 통하는지 검증되지는 않는다. 호출자와 검토자는 입력·출력의 결속 및 원자료를 직접 대조하라. schema 통과를 검증 완료로 보고하지 마라.

정식 workflow에서는 외부 artifact `task:ui-ux-design-request`를 제공하고 필요한 capability에 `ui-ux-design`을 포함한다. 이 선택형 단계의 설계·리뷰 결과를 기존 변경 점검과 구현·제작 흐름에 전달한다. 독립 감사·수용·배포 권한은 기존 담당에 남는다.
