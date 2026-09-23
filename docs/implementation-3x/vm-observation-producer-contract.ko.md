# V02-c — VM 완료 provider turn과 후속 AGS 호출의 출처 계약

상태: **소스 기반 계약 동결**. 이 문서는 VM producer와 AGS host verifier의 구현 입력이다. 현재 AGS의 production host challenge는 fail-closed이고, 이 문서와 fixture는 host 지원·실제 서명·live 적합성의 증거가 아니다.

## 고정 근거

- AGS 통합 ref: `f52f37b0492f3572d1859b6fe8f8fefb7a33c953` (`codex/v260-semantic-decision-layer`). V 영역 작업 브랜치는 이 ref로 fast-forward한 뒤 계약 파일을 작성했다.
- VM 소비자 ref: `ffe3dfa7afc8037adb7199527b6befb56f5d9744` (`D:\codex\flowmarshal`, `main`). 아래 ref의 `git show` bytes와 해당 checkout bytes가 같았다.
- 아래 SHA-256은 파일 bytes의 digest이다. 계획의 ref나 hash는 런타임 producer 관측·host 지원을 뜻하지 않는다.

| 저장소 | pin ref의 경로 | SHA-256 | 확인한 경계 |
|---|---|---|---|
| AGS | `mcp-server/src/host-integration/observation-challenge.ts` | `6fb509fcb6fe5dbca75d6eb4416b8cd6f67c35dfdd2ae2fc1673c5e0c94f69ba` | 여덟 binding 필드, test challenge와 닫힌 host 경로 |
| AGS | `mcp-server/src/workflow-store.ts` | `ac4df9f07b3f4a0bfaded413b7468353b435e696a98d1a29ef29ec76502a10cd` | 관측 ID 단회 claim Port |
| AGS | `mcp-server/src/convergence-logic.ts` | `d27d6edd0767a333cdf818552bd6d41a01f173ae6a16317fa8ec47526ad6074a` | AGS 정규 JSON과 SHA-256 계산 |
| AGS | `mcp-server/src/host-attestation.ts` | `34255700dd13eee27c068143b02b668393bec552f9b2098670ba5a5c4881c49d` | 기존 Claude Code 전용 attestation |
| AGS | `mcp-server/src/runtime-config.ts` | `4d0a08a848d718d87d4e82536a77632544548c1e0513303ae78728bf34dedb46` | VM host provider는 현재 선택되지 않음 |
| VM | `src/flowmarshal/engine/governance_gate.py` | `cc5fca4ebb467865018e1064c736df55c10f10730cbc58d143aaa368a794d0bf` | steward 반환 뒤 `_mcp`→`GovernancePlugin.call`; signer CLI의 caller JSON |
| VM | `src/flowmarshal/engine/roles.py` | `a333f2c79cb0afb5aa0fda7ef8daaed4ad91b65b0fdb0b131b2e2e5f47944994` | turn terminal 관측·role receipt·model provenance |
| VM | `src/flowmarshal/engine/runtime.py` | `48cccdc21440f40ec24a112f998846957fc81d642eecec21c962c516042a53d1` | Worker terminal observer와 원장 기록 |
| VM | `src/flowmarshal/engine/model_observation.py` | `b7156c76701ccc57fe9907de3e09b40d7886a965b41f00122460d9b3165ca378` | requested와 observed model/effort 분리 |
| VM | `src/flowmarshal/engine/claude_runtime.py` | `435a92aa7709568d928d68c58c7c3a09c8c71b772ea6155532a93073031b8640` | 해당 turn의 session 기록에 model·effort 한 쌍이 있을 때만 관측 |
| VM | `src/flowmarshal/canonical.py` | `64b74f58b66f513bdcd124d49c8cc9da64eb1df28182225d502cdede10f09282` | VM 현재 정규 JSON. AGS 구현과 전체 JSON에서 동등하다고 가정하지 않음 |

VM `governance_gate.py`의 `RoleSteward.review`는 role runner가 끝나고 `RoleCallReceipt`를 검증한 뒤 관측 model/effort를 투영한다. `_review`가 그 결과를 받은 다음 `_mcp`가 별도의 AGS tool call을 실행한다. Worker는 `runtime.py`의 completion observer가 terminal을 원장에 기록한 뒤, gate `_finish`가 Worker 관측을 읽어 AGS에 전달한다. 따라서 `turnId`는 **이미 완료된 provider turn**, `invocationId`는 **그 뒤의 governance 호출**이다. 둘을 같은 현재 turn이라고 해석하면 안 된다.

현재 `GovernancePlugin.call`은 `observation` dict를 signer CLI stdin의 `model/modelClass/reasoningEffort/actorId`로 보낸다. 이 dict, `source` 문자열, Claude Code hook 또는 VM 모델 클래스 표는 VM privileged producer의 출처 증명이 아니다. 현재 AGS `registerHostObservationReader`와 host `ObservationChallengeAuthority`는 이를 막기 위해 거부한다. test-domain challenge의 성공도 host 성공이 아니다.

## 권위와 위협 경계

이 계약은 모델·MCP 호출자가 JSON 인자, tool 이름, `source`, signer CLI stdin, workspace 파일을 조작할 수 있다고 본다. VM Engine의 provider adapter와 Core 원장, producer 전용 서명 기능은 별도 신뢰 경계다. VM 프로세스 자체나 AGS 서버, pin된 키 등록 저장소가 침해된 경우까지 방어했다고 주장하지 않는다. private key를 모델 작업 공간·MCP 인자·일반 signer CLI 환경 변수에 두면 이 경계는 성립하지 않으므로 production host는 활성화하지 않는다.

1. VM Engine은 provider terminal을 자신의 adapter에서 직접 관측하고, terminal event ID·digest·시각·상태, provider call/thread/turn ID, model/effort 및 provenance를 변경 불가 원장 사건으로 기록한다. steward는 role receipt와 그 terminal 근거를, Worker는 정확한 attempt의 runtime terminal 사건을 가리킨다. 현재 `ledger_worker_observation`처럼 thread ID의 최신 usage만 고르는 투영은 단독 신뢰 근거가 아니다.
2. VM gate는 후속 MCP tool call 직전에 Core 원장의 현재 task/goal revision/run/attempt/stage와 위 terminal 사건을 재대조한다. 완료되지 않았거나, 다른 attempt·stage의 사건이거나, 더 새 turn/attempt/revision이 선행 사건을 대체했으면 발급하지 않는다. terminal 시각은 보존한다. invocation 시각을 terminal 시각으로 바꿔 신선하게 만들지 않는다.
3. VM gate가 caller에게 맡기지 않고 고유 `invocationId`를 발급한다. tool 이름과 `_hostAttestation`을 제외한 실제 tool input의 `inputDigest`를 확정하고, terminal→invocation 인과 edge를 해당 gate operation key에 저장한다. 동일 terminal에서 여러 AGS 호출을 허용할 때도 각 호출의 invocation ID·nonce·input digest는 별개다. 효과 불명 호출을 새 receipt로 자동 재실행하지 않고 기존 operation을 관측한다.
4. VM producer만 Ed25519 private key로 아래 envelope의 정규 bytes를 서명한다. private key는 VM control-plane 전용 메모리 또는 접근이 동등하게 격리된 저장소에 보관하고 caller가 접근 가능한 파일·CLI·environment로 내보내지 않는다. AGS 서버는 MCP 인자/manifest/VM caller가 아닌 운영자 신뢰 경로에서 pin한 public key와 `keyId → installationId/hostId` 매핑으로 검증한다. pin이 없거나 키 출처·비밀 격리를 입증하지 못하면 VM host 경로는 disabled다. keyId는 선택 힌트일 뿐 신뢰 등록이 아니다.
5. AGS는 서명 검증 뒤에도 자신의 기대 host와 key 매핑, 현재 MCP tool과 input digest, 여덟 결속값, domain/version, issued/expires 시간, nonce 단회 claim을 확인한다. 다른 host의 **유효하게 서명된** receipt/handle도 기대 `hostId`와 다르면 거부한다. 출처 서명만으로 인간 승인, 요청 model/effort 적용, provider 효과 완료를 주장하지 않는다.

## ProducerReceiptV1 wire 계약

서명 대상 bytes는 AGS pin의 `mcp-server/src/convergence-logic.ts` `canonicalJson(body)`를 UTF-8(BOM 없음)로 인코딩한 결과로 **고정**한다. 객체 키는 JavaScript 정렬 순서로 정렬하고, 배열 순서는 유지하며, 문자열 escape는 `JSON.stringify`와 같다. body의 수는 안전한 범위의 정수만 허용하고 float·NaN·Infinity·중복 JSON 키·미정의값·추가 필드는 거부한다. VM 구현은 Python의 현재 `canonical_json`이 항상 같다고 가정하지 말고 이 bytes를 구현해 fixture의 두 body golden vector와 일치시킨다. fixture-only `id/kind/invocation.input`은 서명 body에 넣지 않는다.

body는 정확히 `version/domain/producer/binding/terminal/core/invocation/nonce/issuedAt/expiresAt`를 가지며 `invocation`에는 `tool/inputDigest/observedAt`만 들어간다. 전송은 `{body: base64url(bytes), signature: base64url(Ed25519(bytes)), keyId}`로 하고 padding 없는 canonical base64url만 허용한다. outer `keyId`는 서명 body의 `producer.keyId`와 같아야 한다. AGS는 **수신한 bytes 자체**에 대한 Ed25519 서명을 검증하고 JSON 파싱 후 `canonicalJson` 재생성 bytes와 불일치하면 거부한다. fixture의 `bodyGolden`은 정확한 정규 문자열·UTF-8 SHA-256·base64url을 고정하지만 실제 키·서명은 싣지 않는다.

| 필드 | 의미·권위 출처 |
|---|---|
| `version: 1`, `domain: "vm-provider-terminal-to-governance"` | test/Claude/human 승인과 구별하는 고정 domain |
| `producer.installationId/keyId/hostId/instanceId` | VM producer와 AGS pin registry의 동일 매핑; `hostId`는 `flowmarshal-engine` |
| `binding.invocationId/turnId/taskId/runId/attemptId/hostId/sessionId/instanceId` | V03의 여덟 결속값. `runId`·`attemptId`의 `null`도 값으로 정확히 비교한다. `turnId`는 terminal, `invocationId`는 후속 AGS 호출이다. `binding.hostId/instanceId`는 producer 값과 같아야 한다. |
| `terminal.eventId/callId/threadId/turnId/status/observedAt/digest` | VM provider adapter·Core에서 보존한 완료 사건. `terminal.turnId = binding.turnId`; digest는 원장의 원자료를 가리킨다. |
| `terminal.model/effort/provenance` | provider raw response 또는 **같은 turn** Claude session 기록에서 model·effort 한 쌍이 함께 관측됐을 때만 채운다. requested/configured/model-reported/부분 관측이면 발급 거부. |
| `core.goalRevision/taskRevision/attemptOrdinal/gateOperationKey/stage` | VM Core가 발급 시 재조회한 상태와 terminal→invocation 연결. AGS는 서명된 주장으로 받되 VM Core에 대한 독립 직접 관측이라고 표기하지 않는다. |
| `invocation.tool/inputDigest/observedAt` | producer가 실제 MCP 호출 직전에 정한 tool·input와 시각. `inputDigest`는 `_hostAttestation` 제외 입력의 AGS `canonicalJson` UTF-8 SHA-256(`sha256:<64 hex>`)이다. VM 구현은 동일 bytes를 만들고 golden fixture와 대조한다. 두 언어의 기존 canonical 함수가 모든 숫자·Unicode에서 같다고 추정하지 않는다. 불일치·비직렬화 입력은 거부한다. |
| `nonce/issuedAt/expiresAt` | invocation마다 새 난수 nonce. `expiresAt = issuedAt + 60초`, 허용 미래 skew 5초. AGS 확인 시 만료 전이어야 한다. terminal 원시 시각은 별도 보존하고 현재 Core 인과 상태 재조회로 stale 여부를 판정한다. |

AGS의 pin registry는 key rotation 시 신뢰된 운영 경로에서만 갱신한다. 폐기 key는 즉시 거부하며 이전 key의 미만료 receipt를 계속 허용하려면 명시적 pin 기간을 등록해야 한다. AGS의 공유 영속 store는 `keyId+nonce`를 원자적으로 claim해 재시작·별도 프로세스에도 단회 사용을 유지한다. V03의 challenge ID claim과 producer nonce claim은 별개이며 둘 다 필요하다. trust 설정·원장·영속 claim이 unavailable이면 fail-closed다.

## V03 수용·거부 순서와 책임

1. V02-d VM producer: 정확한 terminal/Core 기록 조회, 관측 model/effort 판단, 후속 invocation 생성·서명, caller signer 우회 차단. VM 전용 저장소·branch에서 구현한다.
2. V03 AGS host verifier: pin된 공개키로 signed body와 canonicality를 검사하고, `domain/keyId/producer/hostId`를 서버 기대값과 대조한다. 이어 `tool/inputDigest`, 여덟 binding 값(`invocationId/turnId/taskId/runId/attemptId/hostId/sessionId/instanceId`), terminal과 invocation의 순서·만료를 대조하고 producer nonce를 영속 단회 claim한다. 같은 VM terminal의 후속 호출이라도 다른 invocation/tool/input 또는 다른 host는 거부한다. 검증된 body만 host `HostInvocationObservationV1`로 투영한다. `binding = body.binding`, `observedAt = body.invocation.observedAt`, `model = body.terminal.model`, `reasoningEffort = body.terminal.effort`다. `observationId`는 caller 필드가 아니라 **`vm-producer-v1:` + SHA-256(canonical signed body bytes)의 64자리 lowercase hex**로 유도한다. 재읽기에도 동일 body의 동일 ID만 나와야 하며 다른 invocation은 다른 ID다. body 안에 `observationId`를 넣어 순환 계산하지 않는다.
3. V04-a/b는 검증된 host observation의 signer·bounded CLI, V05는 최종 receipt verifier·single-use 저장을 맡는다. V03 challenge와 VM producer receipt는 인간 승인 토큰이 아니다. V03이 host reader를 다시 열어도 공개 callback이나 형식상 유효한 caller JSON을 등록할 수 없어야 한다.

서명·키 등록·Core 근거·model provenance·영속 store 중 하나가 없거나 V02-d에서 정확한 provider terminal과 후속 호출 연결을 만들 수 없으면 `BLOCKED_CONTRACT` 또는 host unsupported로 남긴다. V03은 현재 Progress의 `BLOCKED` 기록을 덮어쓰지 않고 실제 producer·별도 프로세스 검증 뒤 새 이력으로만 복구한다. 실제 VM host 지원, 설치물, 별도 프로세스 SQLite claim과 live 요청은 이 계약 동결에서 **NOT_RUN**이다.

## Fixture와 검증 경계

`fixtures/vm-observation-producer-contract.json`은 비밀·서명 없는 **계약 예시**다. steward와 Worker의 완료 turn→후속 호출 정상 예, 두 signed body golden bytes·`observationId`, 여덟 결속값 각각의 교차 변경(특히 signature-valid 조건의 다른 host), tool/input, requested-only model, self-report, key·시간·재사용 오류를 나열한다. `tests/coordinate-subagents/v3x/V02-c.test.mjs`는 fixture 구조·정규 digest·body bytes·투영·거부 목록과 이 문서의 source pin 일치를 확인한다. 이 검사는 생산 서명 검증이나 VM live 관측의 대체물이 아니다.
