# Model routing v2: 사용법, 경계와 마이그레이션

`coordinate-subagents`의 모델 선택을 확장한다. 새 orchestrator나 일반 shell MCP 도구를 만들지 않는다. 모델 개발사, 공급 경로, 요청 이름, resolved ID, host/session/instance, native reasoning, runtime mode를 서로 분리한다. 모델이 읽는 계약은 [versioned model assignment](../skills/coordinate-subagents/references/model-routing-v2.md)에 있다.

## 호환성

무버전 `resolve`/`record` 입력은 기존 v1 엔진이 그대로 처리한다. v1 함수와 preset은 바꾸지 않았고 Haiku를 포함한 기존 v1 결과도 같다. `schemaVersion: "2.0.0"`인 입력만 새 계약을 쓴다. CLI v2는 `{schemaVersion, request, capabilities, now}`를 받고, record에는 `application`을 더한다. CLI에 넣은 capability와 관측은 진단용이며 신뢰 관측이 아니다.

`ExecutionContextV1`, 기존 위험 하한, Claude host attestation token v1, 기존 stage schema, root/frame/receipt/ACK의 의미는 바꾸지 않는다. v2 routing 증거는 추가 artifact이며 `trustedGateSatisfied`는 항상 `false`다.

## 데이터와 결정

카탈로그는 `skills/coordinate-subagents/references/model-catalog/`의 검토된 오프라인 snapshot이다. 원산지 allowlist는 OpenAI, Anthropic, Google, xAI, Mistral, Amazon, Cohere, Meta로 제한한다. 알 수 없는 실제 모델, 금지된 origin, 검증되지 않은 alias와 proxy fallback은 새 자동 배정에서 제외한다. 안정 ID를 다시 확인하지 못한 모델은 `seed`로 두며 기본 정책에서 쓰지 않는다. modelClass와 role/trait 순서는 검토용 배치 seed이며 실측 성능 순위가 아니다. 카탈로그 snapshot은 `policy.json`의 `maxCatalogAgeDays`(30일)가 지나면 `CATALOG_STALE`로 신규 배정을 막으므로 유지보수에서 갱신한다.

제품별 규칙은 공용 엔진이 아니라 `policy.json`에 둔다. `modelMinimums`는 모델별 native enum 하한(현재 Luna는 high 이상), `highRiskNativeFloor`는 고위험 하한을 보일 수 있는 호스트와 그 조건, `fullHistoryInheritanceHosts`는 full-history에서 v1 상속만 허용하는 호스트다. 목록에 없는 호스트는 고위험 하한을 만족하지 못한다.

`user.strength`가 `required`이면 불가능한 모델을 조용히 대체하지 않는다. `preferred`이면 적격 후보를 고르고 이유를 기록한다. 네 역할과 profile은 그대로이며 trait는 권한, agent 수, batch를 바꾸지 않는다. 입력·후보·catalog·policy·capability digest를 결정에 고정한다. 실제 dispatch 직전에 세션 instance, presence lease, snapshot 만료와 최신 정책을 다시 확인해야 하며, `revalidateDispatch`는 실행 승인을 발급하지 않는다.

## MCP 도구

- `query_model_catalog`: 카탈로그 일부를 읽는다. 카탈로그에 있다고 호스트 접근이나 실행이 검증된 것은 아니다.
- `resolve_model_assignment`: 입력은 `ModelSelectionRequest.v2` 자체다. catalog, policy, capability는 서비스가 저장소에서 읽으며 도구 입력으로 대체할 수 없다.
- `record_model_application`: `{application, observationToken?}`를 받는다. admitted observation token 없이 낸 관측은 `unverified`로 남는다.

세 도구는 skill 소유 엔진 하나를 부르는 façade다. 번들 서버는 catalog를 `mcp-server/dist` 기준이 아니라 skill 옆에서 찾는다. Anthropic profile에서는 `resolve_model_assignment` schema의 최상위 `allOf`를 빼서 광고하고, 서버는 원래 계약 전체로 검증한다.

## 호스트 관측과 기록

`RoutingObservationSigner`와 `ModelRoutingStore`는 호스트 adapter가 직접 쓴다. 일반 모델에게 capability 발행이나 서명 발급 MCP 도구를 주지 않는다. 로컬 HMAC 서명은 데이터 무결성과 일회용 admission을 위한 것이며, 사람의 승인이나 같은 OS 사용자에 대한 격리를 증명하지 않는다.

관측은 assignment, task, run, stage, revision, attempt, input, candidate와 대상 actor, session, instance, 결정 digest에 묶인다. 모델만 관측되면 reasoning과 runtime mode는 여전히 `unverified`다. 실제 모델이나 effort가 다르면 요청값으로 덮지 않고 `mismatch`로 저장한다. `StageResult.v1`에 v2 객체를 직접 넣지 않고, 저장된 record의 artifact URI를 기존 output·evidence에 연결한 뒤 `checkApplicationArtifactBinding`으로 대상을 확인한다.

## 호스트별 adapter

Codex와 Claude의 native 인자 변환은 제한된 컨텍스트에서만 override를 만든다. Haiku의 budget을 high로 바꾸지 않는다. Gemini CLI와 Grok Build의 headless adapter는 명시적으로 켠 구성에서만 동작한다. 승인된 절대 실행 파일과 entrypoint SHA-256, 검토된 host version, 인증 준비, 허용 cwd, 환경 변수 allowlist를 요구하고 shell 없이 argv 배열로 실행하며 시간과 출력 한도를 둔다. Gemini는 init 이벤트만으로 전체 실행 모델을 확정하지 않고 terminal의 모델별 usage를 읽는다. Grok은 ACP JSON-RPC 단계만 처리하며 client tool과 권한 요청을 자동 승인하지 않는다. Spark는 `gemini-spark` runtime descriptor이며 Meta `muse-spark` 모델과 다르고 `autoDispatch: false`다.

## 저장 구조

MCP 서버는 workflow DB에 `ags_model_*` 테이블을 추가한다. 기존 테이블, digest, `PRAGMA user_version`은 바꾸지 않는다. 미확인 write dispatch가 남아 있으면 모델이나 attempt를 바꿔도 같은 작업을 새로 시작할 수 없고, terminal 상태에는 별도 증거 참조가 필요하다. 여러 외부 호스트 사이의 exactly-once는 보장하지 않는다. 저장소를 열지 못해도 나머지 MCP 서버는 그대로 동작하며, 이때 카탈로그 조회만 가능하다.

## 검사

- `scripts/check-skill-context-optimization.mjs`: v2.3→v2.4 최적화 증명이다. 후보를 작업 트리가 아니라 고정 revision `b3c232f`에서 `git show`로 읽으므로 이후 스킬 변경과 무관하게 같은 결과를 내고 worktree를 만들지 않는다.
- `scripts/check-skill-loading-contract.mjs`: 현재 트리의 SKILL.md가 `release/skill-loading-baseline.json`의 byte 상한, 검토된 frontmatter, 조건부 navigation을 지키고 카탈로그 데이터를 초기 컨텍스트에 넣지 않는지 확인한다. frontmatter를 바꿀 때는 기준 파일도 같은 변경에서 검토해 갱신한다.

## 아직 연결하지 않은 것

실제 호스트 hook의 capability 발행과 관측 admission, 감사 참여 이력 provider, broker 기능 협상을 통한 peer assignment 전달은 연결하지 않았다. 그 전까지 MCP resolve는 `blocked`, record는 `unverified`다. Gemini CLI, Grok Build, Spark의 실제 계정·호스트 실행과 벤더 호출은 검증하지 않았다.

## Rollback

신규 dispatch를 멈추고 진행 중인 쓰기 작업의 실제 상태를 확인한 뒤 이전 설치물로 되돌린다. 이전 버전은 추가된 `ags_model_*` 테이블을 읽지 않고 기존 기록을 그대로 쓴다. 기록 DB, 관측 기록, 키는 삭제하지 않는다.
