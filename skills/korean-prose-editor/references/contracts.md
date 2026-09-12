# 계약 사용법

모든 교환 객체는 `schemaVersion: "1.0.0"`을 사용한다. JSON Schema는 `contracts/`에 있다.

`provider-plan`은 selection, editing, verification 순서의 `actorIds` 세 개를 요구한다. 각 값은 격리된 역할 실행에서 새로 만든 canonical lowercase UUID여야 하고 서로 달라야 한다. `providers.finalization.kind`는 `deterministic`이며 `actorId`를 갖지 않는다. 호출 환경에서 서브에이전트를 사용할 수 없으면 계획을 유효한 것으로 축소하지 않는다. UUID 고유성은 협력적 역할 분리를 위한 실행 표식이며 암호학적 신원 증명은 아니다.

편집안은 UTF-16 코드 단위 기준의 반열린 범위 `[start, end)`를 쓴다. 각 edit에는 고유한 `id`, 원문 digest, `start`, `end`, `replacement`와 editing provider의 `actorId`가 들어간다. 범위가 겹치거나 원문 digest가 다르면 전체 fallback 대상이다.

verification 결과는 edit마다 하나의 결정을 가져야 한다. `accept`는 뜻과 보존 조건을 만족한다고 독립적으로 확인한 경우에만 쓴다. 나머지는 `retain`이다. 결정이 빠진 edit도 `retain`으로 처리한다.

최종 receipt의 허용 최상위 필드는 `schemaVersion`, `actorIds`, `digest`, `length`, `decisions`, `warnings`다. `actorIds`는 선정자·편집자·검증자 세 UUID를 순서대로 기록한다. 원문이나 결과문을 유추할 수 있는 발췌, edit replacement, 자유 서술 경고를 넣지 않는다.

finalization의 `receiptPolicy`는 `actorIdsPointer: "/output/actorIds"`와 `actorIdsMatch: "prior-policy-actors"`를 함께 지정한다. 최종 receipt의 배열은 앞선 역할 receipt에서 정책으로 기록한 세 actor ID와 값·개수·순서가 모두 같아야 한다. 새로운 actor를 만들거나 배열 순서를 바꿀 수 없다.

`warnings`는 각 출력 스키마에 열거한 코드만 허용한다. 선정은 `SELECTION_UNCERTAIN`, `SELECTION_BLOCKED`, `PROTECTED_CONTEXT_MISSING`을 쓴다. 편집은 `EDITING_UNCERTAIN`, `EDITING_BLOCKED`, `EDIT_SCOPE_RETAINED`, `PROTECTED_CONTEXT_MISSING`을 쓴다. 검증은 `MEANING_UNCERTAIN`, `MEANING_CHANGED`, `REGISTER_CHANGED`, `TERMINOLOGY_UNCERTAIN`, `TERMINOLOGY_CHANGED`, `PROTECTED_STRINGS_CHANGED`, `VERIFICATION_BLOCKED`를 쓴다. 뜻이 맞는 코드가 없으면 자유 서술을 receipt에 넣지 말고 별도 artifact에 기록한다. 최종 receipt 스키마의 목록은 finalizer와 결과 검사기가 내보내는 결정적 경고 전체를 포함하며 테스트에서 일치 여부를 확인한다.

보호 구간 추출 입력은 `source`와 선택적인 `protectedStrings` 문자열 배열이다. 이름·식별자·표시 없는 명령어처럼 자동 추출이 어려운 값은 이 배열로 지정한다. 비어 있거나 원문에 없는 값은 오류다. 같은 문자열의 모든 출현을 기록하며 겹친 보호 구간은 합친다. 경로는 공백이나 구분 기호에서 끝나므로 공백이 있는 경로는 코드·인용으로 감싸거나 전체 문자열을 명시해야 한다.
