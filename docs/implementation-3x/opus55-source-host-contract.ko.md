# M01 — Claude Opus 5.5 출처·host·호출 계약 동결

## 판정 범위와 고정 ref

이 문서는 AGS 저장소 `dddde8cff6391e467e961a4ae70d573b48678236`의 **변경 전** 파일과 2026-09-23에 확인한 공식 문서·로컬 CLI를 대조한 동결 자료다. 각 소비자의 경로, symbol, 원본 bytes SHA-256과 공통 Git ref는 [fixture](fixtures/opus55-host-contract.json)에 있다. 계획 자료 `거버넌스설계/3.x 구현방향/model/MODEL_UPDATE.json`은 r3, SHA-256 `7cdcfe526c15f5ed53e5791e60059284090f9e80098ecaeab5e2b15295031a67`이다. 계획의 `installed_host_binding: null`과 `scope.product_implemented: false`를 현재 구현·호출 증거로 승격하지 않는다. fixture는 이후 제품 파일을 바꾸는 Task에서도 이 ref의 과거 상태를 가리킨다.

| 구분 | M01 판정 | 근거와 한계 |
|---|---|---|
| document-supported | 예 | 공식 [Opus 5.5 이전 가이드](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide)는 고정 API ID `claude-opus-5-5`를 명시한다. [Claude Code 모델 설정](https://code.claude.com/docs/en/model-config)은 full ID와 최소 CLI 2.1.280을 명시한다. |
| host-supported | unknown | 로컬 `claude --version`은 `2.1.280 (Claude Code)`이고 `claude --help`는 `--model`, `--effort`를 노출한다. 이는 버전 하한·정적 인자 확인이다. 계정/조직 허용 목록, provider 선택, exact ID 선택 가능성은 호출 없이 확인되지 않았다. |
| configured | 아니오 | 고정 ref의 Anthropic catalog shard, v2 `policy.json`, v1 `model-routing-presets.json`에는 exact ID가 없다. `opus` alias가 어떤 버전으로 해석되는지도 host 관측 전에는 별개다. |
| observed | 아니오 | M01은 live 모델 호출을 하지 않았다. Opus 5.5의 실제 model·effort·usage·비용 관측이 없다. |

`claude-opus-5-5`는 **exact API model ID**이고 `anthropic-claude-code`는 AGS의 **host ID**다. 둘을 합친 binding은 현재 `null`이다. `opus` alias, CLI 버전 또는 공식 API 문서만으로 resolved model을 채우지 않는다. 저장소 `node_modules/@anthropic-ai/sdk`는 없고 저장소 소스에서 Messages API `messages.create` 호출도 찾지 못했다. SDK의 계정 권한·실행 호환성은 unknown이다. 설치·로그인 변경과 유료 호출은 이 동결 범위 밖이다.

## 실제 소비자 지도

fixture의 `pins`는 모두 위 Git ref의 경로·symbol·SHA-256을 갖는다. 특히 `index.json`의 Anthropic shard 및 hosts/sources digest는 checkout bytes와 일치한다. 이는 catalog 무결성 확인이며 모델 지원의 관측은 아니다.

| 책임 | 고정 대상과 현재 동작 |
|---|---|
| catalog·출처 | `model-catalog/index.json`, `models/anthropic.json`, `hosts.json`, `sources.json`, `scripts/model-catalog.mjs`. Anthropic shard는 Opus 5까지만 담고 `queryCatalog`의 `liveVerified`는 `false`다. 기존 `sources.json`의 `CLAUDE` 출처는 새 ID의 근거가 아니다. |
| 정책·preset | `model-catalog/policy.json`, `model-routing-presets.json`. v2 순서와 v1 Claude profile은 Opus 5를 가리킨다. M01은 다른 벤더나 role 순위를 바꾸지 않는다. |
| 선택·호출 | `model-routing-core.mjs`, `model-routing.mjs`, `adapters/native-subagents.mjs`, `mcp-server/src/model-routing-service.ts`. Claude adapter는 model을 invocation argument 및 agent definition에, effort를 agent definition에 싣고 충돌을 검사한다. 실제 host 전달 결과는 별도 관측이 필요하다. |
| 관측 | `model-routing-host-hook.ts`, `native-tool-observation.ts`, `host-attestation-hook.ts`. exact tool-use transcript의 `message.model`과 transcript/hook effort를 읽는다. 모르는 모델은 origin `unknown`이고 alias를 exact ID로 승격하지 않는다. runtime mode는 null이다. |
| 비용·평가 | `model-evaluation.mjs`, `model-routing-store.mjs`, `model-evaluation-record.v1.schema.json`. usage는 input/output/reasoning/cacheRead/cacheWrite/toolCalls이며 `actualBilling`, `apiPriceEstimate`, `subscriptionUsage`, `unknown`을 분리한다. 현재 저장소에는 Opus 5.5 가격 계산기가 없다. |

## surface별 강제 계약

| Surface | 소유권·전달·필수 처리 |
|---|---|
| Claude Code / 관리형 agent | Claude Code·Agent SDK가 대화 이력과 thinking 재전송을 관리한다. CLI `--model` 또는 subagent model frontmatter로 모델을, `--effort` 또는 subagent effort frontmatter로 effort를 전달한다. [모델 설정 문서](https://code.claude.com/docs/en/model-config)의 조직 허용 목록·effort cap·fallback 규칙이 적용될 수 있다. AGS는 인자 기록과 transcript/hook의 **실제** model·effort를 구분하고, 발신 메시지와 연결된 관측만 수용한다. 관리형 이력에 아래 직접 API 재작성 규칙을 AGS가 임의 적용하지 않는다. |
| 자체 Messages API 호출 | 호출 애플리케이션이 `system`, `tools`, `messages`, thinking block 이력을 소유한다. `model: "claude-opus-5-5"`와 `output_config.effort`를 명시한다. [이전 가이드](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide)에 따라 `thinking: disabled`와 수동 `budget_tokens`, 강제 `tool_choice: any/tool`을 보내지 않는다. `auto`와 strict tool use 또는 structured outputs를 검토한다. 응답은 content block `type`별로 읽고 tool result와 함께 thinking block을 변조 없이 재전송한다. Opus 5.5에서 다른 모델로 전환할 때 thinking block 수용은 방향·대상 모델에 따라 달라진다. [preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)의 append-only 규칙을 지킨다. Claude API/Google Cloud의 구형 `computer_20251124`는 `computer_toolset_20260801`로 바꾸며 Bedrock은 별도 예외다. 이 저장소의 직접 API 구현은 아직 없다. |
| 가격 추정 | [공식 가격표](https://platform.claude.com/docs/en/about-claude/pricing)와 계획 자료가 일치하는 범위는 Anthropic first-party API, standard speed, global, non-batch의 USD/백만 토큰: 일반 입력 4, 출력 20, cache read 0.20, 5분 write 5, 1시간 write 8이다. `apiPriceEstimate`로만 표기한다. server tool 비용, fast/batch/지역 가격, 실제 청구액과 구독 사용량은 이 표에 포함하지 않는다. [effort 문서](https://platform.claude.com/docs/en/build-with-claude/effort)의 API 기본값은 `medium`이며 AGS가 `high`를 요청하려면 명시적으로 전달해야 한다. 가격표는 품질·절감률·실제 청구의 증거가 아니다. |

## 후속 활성화의 증거 문턱

이 fixture는 mock/계약 검사의 기준으로 사용할 수 있다. 실제 host binding은 대상 설치에서 exact ID와 effort 조합을 허용한다는 증거가 있어야 채운다. AGS 설정을 바꾼 뒤에는 지원 snapshot과 호출 인자를 기록하고, 동일 호출의 transcript/hook에서 resolved model·effort를 확인한다. 이들이 없으면 capability는 `unknown`, 검증 결과는 `LIVE_PENDING` 등 해당 Task 계약의 미관측 상태로 둔다. 자체 Messages API 경로가 추가될 때만 직접 API 요청·응답·thinking 이력 검사를 적용한다. 가격 계산이 추가되더라도 `apiPriceEstimate`와 실제 과금은 별도로 기록한다.
