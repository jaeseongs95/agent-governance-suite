# J01 TypeSafe Jev API 계약 동결

판정: **CONTRACT_CONFIRMED** (2026-09-23). TypeSafe가 직접 제공한 OpenAPI와 API·Choice·Models 문서의 원문을 저장했다. 이 판정은 공개 계약의 확보를 뜻하며 계정별 모델 사용 가능성이나 실제 API 응답의 관측을 뜻하지 않는다.

## 원문과 재현

| 공식 원문 | 저장한 bytes | SHA-256 | HTTP Date (UTC) |
| --- | ---: | --- | --- |
| [OpenAPI](https://api.typesafe.ai/openapi.json) | [14,158](evidence/jev-upstream/openapi.json) | `a191f8a7df6bd6fedced8120dd0fd106f88575d1d1c8360d08900a6c7c0360d5` | 2026-09-23 12:31:19 |
| [API reference](https://docs.typesafe.ai/api.md) | [11,772](evidence/jev-upstream/api.md) | `7ea1c82d9d16bd06e3d38885a5292548293f91e6d1ade4682c27398ced51a9e5` | 2026-09-23 12:31:19 |
| [Choice](https://docs.typesafe.ai/primitives/choice.md) | [26,794](evidence/jev-upstream/choice.md) | `4c55085131f8f2d7ae1faefdec52b1c7b379d40657d701cd2c786021cfe9dac9` | 2026-09-23 12:32:17 |
| [Models](https://docs.typesafe.ai/models.md) | [7,245](evidence/jev-upstream/models.md) | `9d20bb3c90a0147532d0b20ddc4c64579391be7842e965543b27bad684eeb4d6` | 2026-09-23 12:31:20 |

동일 디렉터리의 `*.headers.txt`에 각 응답 헤더를 보존했다. 기계 판독 요약은 [upstream-contract.json](../../mcp-server/src/semantic/providers/jev/upstream-contract.json)이다. OpenAPI 자체의 버전은 `3.1.0`, `info.version`은 `0.2.0`이며 Jev 모델 버전과는 다르다.

## 동결된 표면

- Endpoint: `POST https://api.typesafe.ai/v1/systemone`, Bearer 인증, JSON. OpenAPI `/paths/~1v1~1systemone/post`; API reference의 `Evaluation endpoint`.
- Request: `SystemOneRequest`의 필수 필드는 `model`, `questions`, `state`. `state`는 string/object/array, `questions`는 이름 붙인 질문 map으로 OpenAPI의 최소 항목 수가 1이다. Choice 질문은 `type: "choice"`, `criteria` 옵션 ID별 설명 map, `instructions`를 사용한다. 근거: OpenAPI `#/components/schemas/SystemOneRequest`, `ChoiceQuestion`; API reference `Request body`, `Choice`.
- Response: `SystemOneResponse`는 `model`, `answers`, `usage`를 요구한다. 질문 ID에 대응한 Choice answer는 `type: "choice"`, **단일** `choice` 문자열, `confidence` 숫자, 옵션별 숫자 `probabilities` map을 요구한다. `usage`의 필수 필드는 `input_tokens`, `output_tokens`. 근거: OpenAPI `SystemOneResponse`, `ChoiceAnswer`, `Usage`; API reference `Choice answer`. 복수 `selectedOptionIds` 형태가 아니다.
- Cardinality: 공식 API reference의 Choice `criteria`와 Choice 안내문은 **최대 255개**라고 명시한다. 이전 255/256 차이는 이 문서상 255로 해소했다. 다만 OpenAPI `ChoiceQuestion.criteria`에는 `maxProperties`가 없으므로 schema 자체가 경계를 강제한다고 쓰지 않는다. 실제 256개 요청의 서버 거부는 실측하지 않았다.
- Model: 공식 Models 문서는 현재 버전 ID `jev-1.13.0`과 캡처 시점의 `jev-latest`, `jev-preview` alias를 제시한다. 재현성이 필요한 후속 요청은 버전 ID를 기준으로 삼아야 하며, alias는 이동할 수 있다. `GET /v1/models`는 인증된 계정의 목록이므로 이번 작업에서 계정별 사용 가능성을 확인하지 않았다.

## 차이와 미확인 사항

API reference는 Choice의 `instructions`를 필수로 적지만 OpenAPI `ChoiceQuestion.required`에는 `criteria`, `type`만 있고 `instructions`는 `null`도 허용한다. 후속 mapper는 설명 문서의 필수 조건을 충족하도록 `instructions`를 보내야 한다. Choice 옵션의 최소 개수, 문서상 최대 255개의 서버 강제, 확률 합계 허용 오차, 동일 최고 확률일 때의 선택 방식은 이번 원문에서 확정되지 않았다. OpenAPI는 `confidence`와 개별 확률의 숫자 범위를 제약하지 않으며, 문서가 0~1과 분포 합계를 설명한다. 실제 응답 검증과 계정별 모델 가용성은 미관측이다.

J02/J03은 이 동결된 표면과 미확인 항목을 구분해 구현해야 한다. 근거 없는 필드를 채우거나 실제 응답을 관측했다고 취급하지 않는다.
