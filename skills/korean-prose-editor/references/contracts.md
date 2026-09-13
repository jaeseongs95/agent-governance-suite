# 계약 사용법

모든 교환 객체는 `schemaVersion: "1.0.0"`을 사용한다. JSON Schema는 `contracts/`에 있다.

외부 provider receipt와 원문을 담을 수 있는 비공개 work product를 구분한다. `edit-decision-set.v1`, `edit-candidate.v1`, `edit-verification-report.v1`, `final-text-receipt.v1`은 raw-text-free receipt다. 실제 범위와 replacement는 `source-unit-manifest.v1`, `selection-work-product.v1`, `editing-draft.v1`, `editing-work-product.v1`, `verification-work-product.v1`에만 둔다.

`provider-plan`은 selection, editing, verification 순서의 `actorIds` 세 개를 요구한다. 각 값은 격리된 역할 실행에서 새로 만든 canonical lowercase UUID여야 하고 서로 달라야 한다. `providers.finalization.kind`는 `deterministic`이며 `actorId`를 갖지 않는다. 호출 환경에서 서브에이전트를 사용할 수 없으면 계획을 유효한 것으로 축소하지 않는다. UUID 고유성은 협력적 역할 분리를 위한 실행 표식이며 암호학적 신원 증명은 아니다.

`source-unit-manifest`는 원문과 보호 manifest에서 결정적으로 만든다. 빈 줄로 나뉜 문단은 `prose`, Markdown fence는 `fenced-code` unit이 된다. 문단 사이 구분자와 prose 앞뒤 공백은 unit 밖에 남겨 기본 문단 구조를 보호한다. unit은 원문 순서대로 정렬되고 서로 겹치지 않는다. 각 unit에는 `unitId`, UTF-16 반열린 범위 `[start, end)`, 종류, 해당 원문 조각의 digest와 겹치는 `protectedSpanIds`가 들어간다. 닫히지 않은 fence는 여는 줄부터 원문 끝까지 하나의 `fenced-code` unit으로 취급한다.

`selection-work-product`는 모든 unit에 `edit`, `retain`, `defer` 중 하나를 지정한다. `edit`에는 unit 안의 실제 문제를 가리키는 하나 이상의 `issueRanges`와 제한된 결함 코드를 기록하고, 편집자는 이 범위와 겹치는 국소 edit만 만들 수 있다. `retain`과 `defer`의 `issueRanges`는 비워 둔다. `reasonCodes`, `riskFlags`, `additionalProtectedStrings`는 기록할 수 있지만 replacement는 허용하지 않는다. 추가 보호 문자열은 지정한 unit 안에 실제로 있어야 한다.

편집 행위자는 `editing-draft`에 원문 digest와 edit 목록만 기록한다. 각 edit에는 고유한 `id`, 대상 `unitId`, 원문 digest, UTF-16 `[start,end)`, `replacement`와 editing provider의 `actorId`가 들어간다. 호스트 recorder는 범위를 검증한 뒤 해당 사례 selection artifact의 canonical digest와 모든 edit를 적용한 후보 문자열 digest를 계산해 `editing-work-product`로 봉인한다. 범위는 실제 변경 부분으로 최소화하며 서로 겹치지 않아야 한다. 각 edit는 다른 edit 없이 단독 적용해도 문법적으로 완결돼야 하고, 서로 의존하는 변화는 하나의 최소 edit로 묶는다.

`verification-work-product`는 editing artifact digest, 고정 rubric digest, 전체 결정과 edit별 결정을 함께 기록한다. 각 edit에는 원문에서 제거한 구체적 결함인 `sourceDefect`와 수량·양태·권리·주장 강도 등의 변화인 `invariantDelta`를 기록한다. `accept`는 `sourceDefect`가 `NONE`이 아니고 `invariantDelta`가 `NONE`이며 후보가 원문보다 분명히 나을 때만 쓴다. 나머지는 `retain`이며 결정이 빠진 edit도 해당 edit만 `retain`한다.

finalizer는 범위 밖 edit, 선택되지 않은 unit의 edit, fenced-code나 보호 구간을 건드린 edit, 최소화되지 않은 edit와 `retain`·누락 결정을 개별적으로 유지한다. malformed selection, 원문·artifact digest 불일치, 겹치는 edit, 전역 verification fallback과 최종 보호 검사 실패는 전체 fallback 대상이다.

최종 receipt의 허용 최상위 필드는 `schemaVersion`, `actorIds`, `digest`, `length`, `decisions`, `warnings`다. `actorIds`는 선정자·편집자·검증자 세 UUID를 순서대로 기록한다. 원문이나 결과문을 유추할 수 있는 발췌, edit replacement, 자유 서술 경고를 넣지 않는다.

finalization의 `receiptPolicy`는 `actorIdsPointer: "/output/actorIds"`와 `actorIdsMatch: "prior-policy-actors"`를 함께 지정한다. 최종 receipt의 배열은 앞선 역할 receipt에서 정책으로 기록한 세 actor ID와 값·개수·순서가 모두 같아야 한다. 새로운 actor를 만들거나 배열 순서를 바꿀 수 없다.

`warnings`는 각 출력 스키마에 열거한 코드만 허용한다. 선정은 `SELECTION_UNCERTAIN`, `SELECTION_BLOCKED`, `PROTECTED_CONTEXT_MISSING`을 쓴다. 편집은 `EDITING_UNCERTAIN`, `EDITING_BLOCKED`, `EDIT_SCOPE_RETAINED`, `PROTECTED_CONTEXT_MISSING`을 쓴다. 검증은 `MEANING_UNCERTAIN`, `MEANING_CHANGED`, `REGISTER_CHANGED`, `TERMINOLOGY_UNCERTAIN`, `TERMINOLOGY_CHANGED`, `PROTECTED_STRINGS_CHANGED`, `VERIFICATION_BLOCKED`를 쓴다. 뜻이 맞는 코드가 없으면 자유 서술을 receipt에 넣지 말고 별도 artifact에 기록한다. 최종 receipt 스키마의 목록은 finalizer와 결과 검사기가 내보내는 결정적 경고 전체를 포함하며 테스트에서 일치 여부를 확인한다.

보호 구간 추출 입력은 `source`와 선택적인 `protectedStrings` 문자열 배열이다. 이름·식별자·표시 없는 명령어처럼 자동 추출이 어려운 값은 이 배열로 지정한다. 비어 있거나 원문에 없는 값은 오류다. 같은 문자열의 모든 출현을 기록하며 겹친 보호 구간은 합친다. 최종 검사는 각 문자열의 문자, 순서와 출현 횟수를 비교해 삭제·변형·재정렬뿐 아니라 중복도 막는다. 경로는 공백이나 구분 기호에서 끝나므로 공백이 있는 경로는 코드·인용으로 감싸거나 전체 문자열을 명시해야 한다.
