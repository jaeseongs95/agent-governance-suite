## 입력

- 원래 사용자 요청과 확인된 수용 기준
- 작업 범위, 실패 영향, 도구 사용, 예상 실행 길이와 검증 가능성
- 관측된 경우에만 현재 모델, 추론 수준과 그 출처
- 호스트 adapter가 제공한 지원 모델·추론 수준과 class 대응 근거, 또는 해당 모델 공급자의 현재 공식 자료
- 사용자가 명시한 품질·속도·비용 우선순위

## 관측 규칙

현재 선택의 출처를 다음 중 하나로 기록한다.

- `runtime`: 호스트가 현재 task의 선택값으로 제공한 metadata
- `user`: 사용자가 현재 선택값이라고 명시한 텍스트
- `screenshot`: 이번 요청에 첨부된 현재 화면에서 직접 읽은 값

사용 가능한 모델 목록, 전역 기본값, 다른 task나 하위 에이전트의 설정, 모델 자신의 추정은 현재 선택의 증거가 아니다. 화면 캡처의 값은 그 화면이 첨부된 요청에만 사용하고 이후 task에 유지된다고 추정하지 않는다. 모델과 추론 수준 중 하나라도 확인되지 않으면 관측 상태를 `unobservable`로 둔다.

## 평가 절차

1. 요청 자체를 먼저 분류한다. 짧은 문장이나 파일 수만으로 난도를 정하지 않는다.
2. 아래 작업 강도와 위험 하한으로 필요한 모델 class와 추론 수준 범위를 정한다.
3. 정확한 제품 모델을 권할 때는 호스트 adapter의 현재 지원 정보나 해당 공급자의 공식 자료를 확인한다. 공통 판단 규칙과 공급자별 자료 조회를 분리한다. 다른 공급자의 공식 자료로 현재 모델의 class·추론 조합·지원 여부를 판정하지 않는다. 모델 이름만 보고 class를 만들거나 지원되지 않는 조합을 권하지 않는다.
4. 관측된 현재 선택과 권장 범위를 비교해 `OVER_PROVISIONED`, `ADEQUATE`, `UNDER_PROVISIONED`, `UNOBSERVABLE` 중 하나를 반환한다.
5. 아래 support guard가 반환한 최종 결과가 `OVER_PROVISIONED` 또는 `UNDER_PROVISIONED`일 때만 본 작업 전에 한 문장으로 안내하고 계속 진행한다. 검사 전 초안의 안내를 먼저 출력하지 않는다.

## 공급자 지원 근거 검사

출력 전에 [support guard](../scripts/support-guard.mjs)를 실행한다. 기존 `ModelEffortAdvice.v1` 초안을 `advice`로, 이번 요청의 관측·지원 자료를 `context`로 stdin JSON에 전달한다. 반환 객체의 `advice`가 최종 결과이며 `supportStatus`는 지원 근거 검사 상태다. 직접 호출과 provider를 수행하는 caller가 같은 검사를 사용한다. 현재 registry·MCP 실행 계층이 이 CLI를 자동 호출한다고 가정하지 않는다.

```text
node <SKILL_DIR>/scripts/support-guard.mjs < request.json
```

- `context.explicitFitRequest`: 사용자가 이번 요청에서 현재 설정의 적절성을 직접 물었을 때만 `true`다. 일반 작업에서 값을 추정해 안내를 만들지 않는다.
- `context.currentSelection`: 이번 요청의 `provider`, `source`(`runtime | user | screenshot`), `model`, `reasoningEffort`다. 지원 목록·기본값·다른 task의 선택값으로 채우지 않는다.
- `context.supportEvidence`: adapter가 확인한 `provider`, `kind`(`host-runtime | provider-official`), `locator`, `models`다. 각 model에는 정확한 `id`, 기존 네 class 중 근거가 있는 `modelClass`, 지원되는 `reasoningEfforts`를 둔다. supplier 자료의 version·관측 시점과 현재 적용성은 caller가 locator 원자료에서 확인한다. 이름·가격·다른 공급자 자료로 class를 추정하지 않는다.
- 관측 불완전·자료원 부재·공급자 불일치·미지원 조합이면 `UNOBSERVABLE`로 두고 `exactModel`을 제거한다. 일반 작업에는 질문·안내를 만들지 않고 계속한다. 적절성을 직접 물었을 때만 확인할 수 없는 범위를 짧게 알린다.
- 관측·지원이 확인되면 기존 비교 규칙을 그대로 적용한다. `ADEQUATE`는 조용히 처리하고 정확한 추천 모델도 같은 공급자의 명시 지원 범위 안에 있을 때만 유지한다.

이 검사는 JSON 형태·공급자 일치·명시된 대응 관계를 확인한다. adapter 주장이나 locator의 진실성을 인증하거나 모델 이름을 자동 분류하지 않는다. 원자료를 신뢰할 수 없으면 근거를 제공하지 말고 `UNOBSERVABLE`로 처리한다. 이 CLI는 stdin만 읽으며 네트워크·UI·설정·권한·세션을 변경하지 않는다. 실패 exit 2를 제품·의미 검증 PASS로 바꾸지 않는다.

관측·지원이 확인되어 비교할 때는 초안의 `rationaleCodes`에 실제 요청에서 확인한 작업 판단 근거가 있어야 한다. `CURRENT_SELECTION_NOT_OBSERVED`를 제거한 뒤 근거 code가 하나도 없으면 API는 `MISSING_DEMAND_RATIONALE`로 비교를 거부한다. CLI도 이 고정 code만 stderr에 반환하며 exit 2와 빈 stdout을 유지한다. 다른 parse·schema·알 수 없는 오류는 `INVALID_INPUT`이다. caller는 실제 요청을 다시 대조해 초안을 보완하며 모델·추론 수준이나 작업 근거를 추정해 채우지 않는다.

### 작업 강도

| band | 대표 조건 | 권장 시작점 |
| --- | --- | --- |
| `routine` | 단순 설명, 형식 변환, 좁고 검증 쉬운 조회·수정 | lightweight~general, low~medium |
| `substantial` | 한 영역의 구현·분석, 여러 근거 통합, 보통 수준의 도구 사용 | general~deep, medium~high |
| `complex` | 여러 모듈·단계, 장기 도구 실행, 어려운 설계 판단이나 독립 검토 | deep~frontier, high~xhigh |
| `frontier` | 가장 어려운 종단 간 작업, 높은 불확실성과 실패 비용, 일반 분해로 줄이기 어려운 문제 | frontier, high~max |

위험도가 `high`이면 최소 `general`과 `high`, `critical`이면 최소 `deep`과 `high`를 적용한다. 결과를 쉽게 검증할 수 있거나 작업을 독립 단위로 분해할 수 있다는 이유만으로 위험 하한을 낮추지 않는다.

### 비교 규칙

- 현재 모델 class나 추론 수준이 최소값보다 낮으면 `UNDER_PROVISIONED`다.
- 두 축이 모두 권장 최대값보다 높거나, 한 축이 순서상 두 단계 이상 높으면 `OVER_PROVISIONED`다.
- 그 밖의 관측 가능한 조합은 `ADEQUATE`다. 한 단계 차이만으로 반복 안내하지 않는다.
- 현재 선택을 신뢰할 수 있게 관측하지 못하면 `UNOBSERVABLE`이다.

사용자가 품질·속도·비용 우선순위를 명시하면 권장 범위 안에서 반영한다. 구독 한도, 실제 과금이나 사용량은 직접 관측한 근거 없이 추정하지 않는다.

## 안내 형식

과한 설정:

> 설정 안내: 이 요청은 `<권장 조합>`이면 충분해 현재 `<현재 조합>`은 다소 과합니다. 설정은 자동으로 바꾸지 않고 요청은 계속 진행합니다.

부족한 설정:

> 설정 안내: 이 요청은 `<권장 조합>`을 권장합니다. 현재 `<현재 조합>`으로도 진행할 수 있지만 복잡한 판단이나 검증 품질이 낮아질 수 있습니다.

`ADEQUATE`이면 별도 안내를 만들지 않는다. `UNOBSERVABLE`도 일반 작업에서는 조용히 넘어가고, 사용자가 직접 적절성을 물었을 때만 현재 값을 볼 수 없다는 사실과 권장 범위를 짧게 답한다. 이 스킬은 현재 task의 UI 선택을 변경하거나 새 task를 만들지 않는다.
