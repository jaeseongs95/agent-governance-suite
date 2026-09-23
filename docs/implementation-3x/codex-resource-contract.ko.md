# H01-a — Codex 자원 관측 계약 동결

## 근거와 상태

동결 기준은 `mcp-server/src/native-adapters/codex/resource-compatibility.json`이다. 2026-09-23 UTC에 Codex CLI `0.155.1`의 `app-server generate-json-schema` 결과와 [OpenAI Codex 공식 스키마](https://github.com/openai/codex/tree/a69d757cd8ef8310001186865911b69e4b4175e5/codex-rs/app-server-protocol/schema/json/v2)를 대조했다. `GetAccountRateLimitsResponse.json`과 `AccountRateLimitsUpdatedNotification.json`은 각각 SHA-256 `76bc9175…f107d6b28c`, `8252ed2a…a3b078`로 양쪽 파일의 바이트가 일치했다. 설치 실행 파일·생성 스키마·실제 읽기 응답의 전체 해시는 fixture에 있다.

| 표면 | 공식 문서 | 설치 스키마 | 현재 실행 관측 |
| --- | --- | --- | --- |
| `account/rateLimits/read` | 지원 | 지원 | 성공 응답 1회 |
| `account/rateLimits/updated` | 지원 | 지원 | 미관측 |

읽기 응답의 원본 JSON은 계정 식별자와 사용량을 포함할 수 있어 저장하지 않았다. fixture에는 결과 객체를 `JSON.stringify`한 SHA-256과 필드명·존재 여부만 보존한다. 이 해시는 당시 응답의 식별 근거이며 이후 사용량 재현을 뜻하지 않는다. 읽기에서 `rateLimitsByLimitId` 버킷 1개와 `primary` 창 1개가 확인됐고, 그 버킷의 `secondary`는 `null`이었다. 현재 관측의 개수와 값은 일반 지원 범위를 증명하지 않는다.

## 읽기·알림 형태

- `account/rateLimits/read`의 `rateLimits`는 필수인 기존 단일 버킷 표시다. `rateLimitsByLimitId`는 버킷 ID별 다중 표시이며 `null`일 수 있다. 두 표시를 별도 자원으로 더하지 않는다.
- 각 `RateLimitSnapshot`의 `primary`·`secondary`는 각각 `RateLimitWindow` 또는 `null`이다. 창에는 `usedPercent`가 필수이고 `resetsAt`·`windowDurationMins`는 선택적 `null` 값이다. `limitId`·`limitName`과 다른 버킷 메타데이터 역시 `null` 가능성을 유지한다.
- `account/rateLimits/updated`는 [공식 프로토콜 정의](https://github.com/openai/codex/blob/a69d757cd8ef8310001186865911b69e4b4175e5/codex-rs/app-server-protocol/src/protocol/v2/account.rs)에 따른 희소 갱신이다. 최근 읽기 결과에 제공된 값만 합치거나 재조회해야 한다. nullable 계정 메타데이터가 갱신에 없다는 사실만으로 이전 값을 지우지 않는다. 설치 스키마의 지원은 실제 알림 수신 증거가 아니다.

## ResourceCollector 경계

`ResourceCollectorPortV1`은 등록된 collector의 `source`, `accountScope`, `resourcePoolId`, 단조 `sequence`, 각 창의 `coverage`와 출처를 요구한다. Codex 읽기/알림 스키마는 그 계약을 직접 제공하지 않는다.

| 항목 | 현재 확인된 입력 | 미확인 상태 |
| --- | --- | --- |
| bucket | `rateLimitsByLimitId` 키와 snapshot의 `limitId`; 기존 `rateLimits` 표시 | 모델별 bucket 연결, 단일 표시와 다중 표시의 중복 해소 범위 |
| window | `primary`·`secondary`와 `usedPercent`, nullable reset 정보 | 절대 한도·잔량, 두 창의 고정 길이·존재 보장 |
| source | 설치 app-server 읽기 응답 | 신뢰된 collector 등록, 계정 scope 결속, provider 관측 승인 |
| sequence | 프로토콜에 없음 | collector 단조 sequence·delta base 부여 방식 |
| coverage | 프로토콜에 없음 | 자원 풀 전체 및 창별 완전성 |

따라서 fixture의 `sequence`와 `coverage`는 `null`이고 `collectorResponseAdmitted`는 `false`다. `usedPercent`로 절대 잔량이나 요청 수를 만들지 않는다. 실제 사용량 수치, 계정 ID, 계획상의 모델·버킷 연결을 신뢰된 `ResourceStateSnapshotV1`으로 승격하지 않는다. 구현 단계에서는 별도의 출처 검증과 scope 결속, 순서·완전성 계약이 필요하다.
