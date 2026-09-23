# r5 VM producer receipt 직접 ingress 계약 delta

상태: **실행 계획 개정**. V04-b의 기존 `BLOCKED_CONTRACT` 이력을 유지한다. 이 문서는 제품 구현, 운영 pin 배포, live provider 관측 또는 VM conformance PASS가 아니다. 후속 V04-b가 동결 계약·fixture를 만들고, 메인이 그 결과를 검증한 뒤 V05 구현을 시작한다.

## 확인한 현재 경로

- AGS 통합 기준 `027401751abba7df9ac3022edab816f21c04ca93`: V03 `observation-challenge.ts`는 operator pin의 Ed25519 producer receipt와 tool/input·여덟 binding·시각·nonce를 검증하는 leaf다. 다만 그 verifier의 여덟 기대 binding은 등록된 `VmInvocationSource`가 제공해야 하며 현재 제품 MCP entrypoint에는 연결되지 않았다. V04-a `observation-signer.ts`는 검증된 challenge에서 별도 HMAC receipt를 만들지만 제품 MCP entrypoint는 이를 호출하지 않는다. `index.ts`의 운영 host attestation 연결은 Claude Code 전용이다.
- FlowMarshal main `2deb96e9eded9dbb9251dc7e226da5e8dc765171`: `GovernancePlugin.call`은 `_vmProducerReceipt`가 있으면 서명 envelope를 `_hostAttestation`으로 MCP에 직접 전달하며 CLI를 우회한다. receipt가 없는 caller observation fallback만 legacy `host-attestation-cli`를 호출한다. 같은 파일의 `CONSUMED_SURFACE.entry_points`와 preflight는 아직 CLI를 필수로 요구한다.
- V01-a의 동결 소비 계약은 legacy CLI stdin의 `host/tool/input/model/modelClass/reasoningEffort/actorId`를 기록한다. 이 일곱 필드에는 V03 challenge나 신뢰된 invocation source가 없다. 이 역사 계약과 V02-c source pin, Progress append-only 행은 재작성하지 않는다.

## r5 목표 경계

1. **VM producer → MCP:** VM이 완료 provider turn과 그 뒤의 governance invocation을 Core에서 재대조하고, V02-c wire 형식 `{body, signature, keyId}`를 `_hostAttestation`에 싣는다. `turnId`는 완료 turn, `invocationId`는 별도 MCP 호출이다. caller model/effort dict, `source` 문자열, legacy CLI token은 VM host 인증 입력이 아니다.
2. **AGS 현재 호출:** MCP dispatcher가 실제 tool 이름과 수신 인자에서 `_hostAttestation`을 제외한 unsigned input을 확정한다. 첫 `plan_workflow`의 `taskId`는 검증된 caller `taskEnvelope`에서 오며 AGS 저장 상태나 서버 발급 ID가 아니다. AGS는 이를 서명된 VM `taskId`와 비교할 수 있지만 그 일치가 Task 소유권·실행 권한을 발급하지 않는다. bootstrap `runId/attemptId`는 아직 AGS run 및 VM 실행 attempt가 없는 phase의 프로토콜 기대값 `null`이다. `record_stage_result`의 caller `runId`는 조회 키이며, AGS 저장 receipt의 `plan.taskId/runId`와 현재 stage/revision을 재확인한 뒤 signed VM task/run과 비교한다. AGS workflow에는 `attemptId`가 없다. stage attempt는 caller JSON이나 signed receipt 자체에서 기대값을 만들 수 없고, 별도로 등록된 신뢰 VM Core 호출 문맥에서 조회해야 한다. 그 문맥이 없으면 signed attempt가 `null`이어도 unsupported/fail-closed다. caller JSON, CLI argv/environment가 기대 binding·reader·store·clock·pin 경로·host domain을 선택하지 못한다.
3. **서명과 인과:** V03/V05는 server 운영 경로에서 pin된 Ed25519 public key와 `keyId → installationId/hostId`를 사용하고 수신한 canonical bytes의 서명을 확인한다. 서명된 `invocationId/turnId/sessionId/instanceId`는 VM producer의 진술이며 AGS가 별도 현재 세션 원장을 소유한다는 뜻이 아니다. host·task/run/attempt는 위 phase별로 실제 얻은 기대값과 비교하고, 없는 기대값은 서명만으로 채우지 않는다. 실제 tool/unsigned input digest, 완료 terminal→후속 invocation 시각, 60초 TTL·5초 미래 허용·operator pin 폐기·producer nonce와 challenge ID의 단회 claim을 유지한다. 서명이나 digest만으로 독립 OS 사용자 격리·인간 승인·Task authorization·provider 효과 완료를 주장하지 않는다.
4. **native admission:** V05가 확인 가능한 결속값을 검증한 관측만 `TrustedExecutionContextProvider`의 현재 호출에 제공한다. bootstrap taskId 일치는 VM 관측의 출처 검증이며 AGS Task authorization이 아니다. stage attempt의 별도 신뢰 기대값을 확보하지 못한 경로는 signed receipt가 유효해도 unsupported로 남긴다. 다른 task/run/attempt, 다른 tool/input, pin 철회, 만료, 중복·동시 nonce claim은 거부한다. claim 후 downstream 실패를 새 receipt 자동 발급으로 보상하지 않고 효과를 관측한다. V04-a HMAC receipt와 legacy CLI token은 이 직접 경로의 dependency가 아니다.
5. **package와 VM 정렬:** V06은 AGS direct MCP entrypoint·closure·hash·정상/거부 smoke만 확인한다. VM main preflight가 아직 `host-attestation-cli`를 필수로 요구하므로 V06만으로 conformance는 완료되지 않는다. V07은 VM의 필수 CLI 목록과 caller fallback을 제거하거나 fail-closed로 바꾸고, 신뢰된 `AGSObservationProducer` bootstrap이 없으면 unsupported를 반환한다. V10은 V07 이후 manifest/direct receipt/거부 응답을 검증한다. G08의 VM-selected package gate는 direct MCP surface와 그 conformance를 요구하며 legacy CLI를 필수로 되살리지 않는다.

## 거부 행렬과 근거 한계

| 사례 | 요구 결과 |
|---|---|
| pin된 VM receipt와 실제 tool/input, bootstrap caller taskId·`null` run/attempt 또는 stage 저장 task/run·별도 신뢰 attempt 문맥이 모두 일치 | V05에서만 host 관측 admission 후보. bootstrap taskId 일치는 Task authorization이 아니며 V04-b 동결·V06 package smoke는 admission 근거가 아님 |
| 서명은 유효하지만 다른 tool/input·phase별 task/run/attempt·host 또는 다른 invocation/turn/session/instance | 거부. 특히 stage attempt의 별도 신뢰 문맥이 없으면 signed 값이 `null`이어도 unsupported |
| 변조·비정규 bytes·pin 부재/철회·만료·미래 시각·중복 nonce/challenge | 거부. 별도 프로세스·동시 claim도 같은 결론이어야 함 |
| legacy 일곱 필드 CLI self-report 또는 test/fake domain | VM host 신뢰 불가. 기존 caller fallback은 fail-closed |

V04-b의 다음 산출물은 이 delta와 V02-c 동결 계약을 구체적인 직접 ingress 문서·fixture로 확정하는 것이다. 실제 AGS native admission, VM preflight 변경, 설치물 conformance는 각각 V05, V07, V10의 별도 검증을 요구한다.

## r4 → r5 보존 근거와 배분 조건

- r5 첫 편집 전과 이 보정 후에 `JSON.stringify(tasks.map(t => [t.id, t.model, t.reasoning_effort]))`의 UTF-8 SHA-256은 모두 `5298759224c743f9e27333cd9ece36f9e195997d479ceacd6481e920160fbc63`이다. 양쪽 모두 245개 고유 ID이며 순서·모델·reasoning 값은 같다. 원본 r4 `TASKS.json` 전체 파일은 별도 snapshot으로 확보되지 않아 전체 byte diff나 미기록 필드의 불변성까지 주장하지 않는다.
- 의도한 필드 delta는 V04-b의 CLI 구현 → direct ingress 계약 동결, V05의 V04-a dependency 제거·native admission 연결 범위 명시, V06의 direct MCP package smoke, V07의 CLI preflight/fallback 정리, V10/G08의 direct 경로 gate, 그리고 V07의 전용 VM branch/worktree/handoff 배분 규칙이다. V01-a/V02-c 동결 문서와 V04-b `BLOCKED` Progress 행은 다시 쓰지 않았다.
- V07의 계획 branch/worktree는 실제 생성·배정 상태가 아니다. V06 통합 후 VM 저장소의 base SHA·전용 worktree·적용 `AGENTS.md`·단일 작성자를 확인하고 manifest에 적힌 경로와 일치시킨 뒤 배분한다. 확인하지 못하면 V07은 배분하지 않는다. V07 이후 VM conformance 및 VM-selected package gate는 unsupported stage attempt 경로를 성공으로 간주할 수 없다.
