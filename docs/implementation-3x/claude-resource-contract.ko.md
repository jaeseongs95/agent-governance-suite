# H06-a — Claude usage·coverage 계약 동결

## 근거와 관측 범위

동결 fixture는 `mcp-server/src/native-adapters/claude/resource-compatibility.json`이다. 설치된 Claude Code CLI `2.1.280`의 실행 파일 SHA-256, `--output-format json|stream-json` 옵션과 로컬 transcript의 Opus 5.5 사건 한 건의 해시·필드 형태를 기록했다. 사건 원문, 계정 정보와 사용량 수치는 저장하지 않았다. 이 Task는 새 모델/API 호출을 실행하지 않았다. 저장소의 TypeScript Agent SDK·Messages SDK와 로컬 Python의 대응 SDK는 설치돼 있지 않다.

| 표면 | 공식 문서 | 설치 확인 | 현재 관측 |
| --- | --- | --- | --- |
| Messages API 응답 `usage` | [필드 정의](https://platform.claude.com/docs/en/api/messages/create) 있음 | 이 저장소의 SDK 없음 | 직접 호출 없음 |
| Agent SDK 결과 `usage`·`modelUsage` | [범위·계산 설명](https://code.claude.com/docs/en/agent-sdk/cost-tracking) 있음 | 이 저장소의 SDK 없음 | 결과 메시지 미관측 |
| Agent SDK `rate_limit_event` | [SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript#sdkratelimitevent)에 선택적 `resetsAt`·`utilization`; 배포 타입 `0.3.185`에 선택적 `rateLimitType` | SDK 미설치 | 사건 미관측 |
| Agent SDK 실험적 `get_usage` | [공식 배포 타입 `0.3.185`](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.185/sdk.d.ts)는 plan 창 조회를 선언 | 이 저장소의 SDK 없음 | 호출·응답 미관측 |
| Claude Code transcript의 메시지별 `usage` | [단계별 관측 설명](https://code.claude.com/docs/en/agent-sdk/cost-tracking) 있음 | CLI `2.1.280` | exact `claude-opus-5-5` 사건 한 건의 필드 형태 확인 |
| 완전한 구독 잔여 quota 창 | 안정된 bucket·coverage 계약 미확인 | SDK·계정 binding 미확인 | 현재 검사 host에서 unavailable |

로컬 사건에는 `message.model: claude-opus-5-5`와 `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`, `cache_creation.ephemeral_1h_input_tokens`가 있었다. 네 최상위 token 필드는 숫자였고 그 사건의 cache-creation 요약은 TTL 상세 합과 같았다. `service_tier`·`inference_geo`도 있었지만 `speed`와 quota 창은 없었다. 이 사건은 CLI host의 과거 응답 관측이며 AGS의 모델 설정, 특정 계정의 지속 지원, SDK 실행 또는 동일 호출의 최종 청구 증거가 아니다.

공식 SDK reference의 `rate_limit_event`는 `status`와 선택적 `resetsAt`·`utilization`을 정의한다. 배포 타입 `@anthropic-ai/claude-agent-sdk@0.3.185`에는 선택적 `rateLimitType`도 있다. reference의 Claude Code `2.1.181` 하한은 이벤트 전체가 아니라 `credits_required` 관련 세 필드에만 적용된다. 같은 배포 타입은 별도의 **실험적** `get_usage` control 응답에 `rate_limits_available`과 선택적 5시간·7일·모델별 창의 `utilization`·`resets_at`을 선언한다(SHA-256 `af9d048d…c38b62e`). API key·제3자 provider 등의 세션은 `rate_limits_available: false`와 `rate_limits: null`일 수 있고, 이 실험적 형식은 변경될 수 있다. 현재 CLI 버전만으로 설치 SDK나 계정의 이 조회 지원을 확정할 수 없으며 두 표면 모두 수신하지 않았다. 선택적 값 부재·이벤트 미수신을 0% 사용량 또는 quota 회복으로 해석하지 않는다. 이후 공식 SDK 조회가 가능해져도 반환 창의 계정 결속·coverage·순서 계약을 확인하기 전에는 ResourceCollector 창으로 승인하지 않는다. 비공개 endpoint를 직접 추정하지 않는다.

## 사용량 해석

- [Anthropic prompt caching 문서](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)는 `cache_creation_input_tokens`를 TTL별 `cache_creation` 값의 합으로 설명한다. 따라서 요약과 상세를 더해 별도 사용량으로 세지 않는다. 둘 다 있으면 일치 여부를 검사하고, 상세가 빠지면 미관측 TTL을 5분으로 채우지 않는다. `cache_read_input_tokens`는 별도 읽기 수치다.
- [Agent SDK 비용·사용량 문서](https://code.claude.com/docs/en/agent-sdk/cost-tracking)는 여러 assistant 메시지가 같은 message ID와 사용량을 공유할 수 있어 단계 집계 시 ID 중복 제거가 필요하다고 설명한다. 메시지별 `output_tokens`는 응답 시작 시점의 임시값이므로 최종 출력량으로 쓰지 않는다. 결과 메시지의 `usage` 또는 모델별 `modelUsage`에서 완료된 출력량을 읽어야 한다.
- 같은 문서에서 결과 `usage`는 기본 agent loop 범위이고, `modelUsage`와 `total_cost_usd`는 subagent를 포함한 누적 범위다. resume·streaming·reset에서는 누적 경계가 달라지므로 중복 합산하지 않는다. 이 Task는 결과 메시지를 실제 관측하지 않았으므로 위 규칙은 문서상 지원이다.
- `message.model`은 이 사건의 exact 모델 관측이다. `service_tier`는 `speed`를 대체하지 않는다. `speed` 필드 부재를 `standard`로 추정하지 않는다.

## ResourceCollector·가격 경계

`ResourceCollectorPortV1`의 등록된 `accountScope`·`resourcePoolId`, 단조 `sequence`, 창별 `coverage`와 출처 승인은 위 token 사용량 사건만으로 만들 수 없다. 구독의 남은 비율, 한도, reset 창도 이 사건에 없다. fixture는 이들을 `null` 또는 `unavailable`로 남기고 collector 승인을 `false`로 고정한다. input/cache token에서 구독 잔여 %를 환산하거나 비공개 endpoint를 추정하지 않는다.

`MODEL_UPDATE.json` r3와 [공식 가격표](https://platform.claude.com/docs/en/about-claude/pricing)는 first-party API 가격 계획 근거다. 가격 추정은 `apiPriceEstimate`이며 구독 차감량·실제 청구액이 아니다. 현재 `model-cost-estimate.mjs`도 TTL 상세 미확인과 요약 불일치에서 추정을 보류한다. 이 계약 동결은 제품 collector 또는 가격 계산기를 활성화하지 않는다.
