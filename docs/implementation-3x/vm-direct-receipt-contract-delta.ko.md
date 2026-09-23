# r5 VM producer receipt 직접 ingress 계약 delta

상태: **실행 계획 개정**. V04-b의 기존 `BLOCKED_CONTRACT` 이력을 유지한다. 이 문서는 제품 구현, 운영 pin 배포, live provider 관측 또는 VM conformance PASS가 아니다. 후속 V04-b가 동결 계약·fixture를 만들고, 메인이 그 결과를 검증한 뒤 V05 구현을 시작한다.

## 확인한 현재 경로

- AGS 통합 기준 `027401751abba7df9ac3022edab816f21c04ca93`: V03 `observation-challenge.ts`는 operator pin의 Ed25519 producer receipt와 tool/input·여덟 binding·시각·nonce를 검증한다. V04-a `observation-signer.ts`는 검증된 challenge에서 별도 HMAC receipt를 만들지만 제품 MCP entrypoint는 이를 호출하지 않는다. `index.ts`의 운영 host attestation 연결은 Claude Code 전용이다.
- FlowMarshal main `2deb96e9eded9dbb9251dc7e226da5e8dc765171`: `GovernancePlugin.call`은 `_vmProducerReceipt`가 있으면 서명 envelope를 `_hostAttestation`으로 MCP에 직접 전달하며 CLI를 우회한다. receipt가 없는 caller observation fallback만 legacy `host-attestation-cli`를 호출한다. 같은 파일의 `CONSUMED_SURFACE.entry_points`와 preflight는 아직 CLI를 필수로 요구한다.
- V01-a의 동결 소비 계약은 legacy CLI stdin의 `host/tool/input/model/modelClass/reasoningEffort/actorId`를 기록한다. 이 일곱 필드에는 V03 challenge나 신뢰된 invocation source가 없다. 이 역사 계약과 V02-c source pin, Progress append-only 행은 재작성하지 않는다.

## r5 목표 경계

1. **VM producer → MCP:** VM이 완료 provider turn과 그 뒤의 governance invocation을 Core에서 재대조하고, V02-c wire 형식 `{body, signature, keyId}`를 `_hostAttestation`에 싣는다. `turnId`는 완료 turn, `invocationId`는 별도 MCP 호출이다. caller model/effort dict, `source` 문자열, legacy CLI token은 VM host 인증 입력이 아니다.
2. **AGS 현재 호출:** MCP dispatcher가 실제 tool 이름과 수신 인자에서 `_hostAttestation`을 제외한 unsigned input을 확정한다. task/run/attempt 기대값은 AGS가 소유한 workflow 상태와 현재 operation에서 조회한다. `null`도 정확한 기대값이다. 이 값이 없거나 현재 호출에 묶을 수 없으면 host admission은 fail-closed다. caller JSON, CLI argv/environment가 기대 binding·reader·store·clock·pin 경로·host domain을 선택하지 못한다.
3. **서명과 인과:** V03/V05는 server 운영 경로에서 pin된 Ed25519 public key와 `keyId → installationId/hostId`를 사용하고 수신한 canonical bytes의 서명을 확인한다. VM 서명 `invocationId/turnId/sessionId/instanceId`와 host, task/run/attempt를 현재 서버 기대값과 대조한다. 실제 tool/unsigned input digest, 완료 terminal→후속 invocation 시각, 60초 TTL·5초 미래 허용·operator pin 폐기·producer nonce와 challenge ID의 단회 claim을 유지한다. 서명이나 digest만으로 독립 OS 사용자 격리·인간 승인·provider 효과 완료를 주장하지 않는다.
4. **native admission:** V05가 검증된 관측을 `TrustedExecutionContextProvider`의 현재 호출에만 제공한다. 다른 task/run/attempt, 다른 tool/input, pin 철회, 만료, 중복·동시 nonce claim은 거부한다. claim 후 downstream 실패를 새 receipt 자동 발급으로 보상하지 않고 효과를 관측한다. V04-a HMAC receipt와 legacy CLI token은 이 직접 경로의 dependency가 아니다.
5. **package와 VM 정렬:** V06은 AGS direct MCP entrypoint·closure·hash·정상/거부 smoke만 확인한다. VM main preflight가 아직 `host-attestation-cli`를 필수로 요구하므로 V06만으로 conformance는 완료되지 않는다. V07은 VM의 필수 CLI 목록과 caller fallback을 제거하거나 fail-closed로 바꾸고, 신뢰된 `AGSObservationProducer` bootstrap이 없으면 unsupported를 반환한다. V10은 V07 이후 manifest/direct receipt/거부 응답을 검증한다. G08의 VM-selected package gate는 direct MCP surface와 그 conformance를 요구하며 legacy CLI를 필수로 되살리지 않는다.

## 거부 행렬과 근거 한계

| 사례 | 요구 결과 |
|---|---|
| pin된 VM producer receipt, 현재 tool/unsigned input과 서버 소유 task/run/attempt가 모두 일치 | V05에서만 host 관측 admission 후보. V04-b 계약 동결이나 V06 package smoke는 admission 근거가 아님 |
| 서명은 유효하지만 다른 tool/input·task/run/attempt·host 또는 다른 invocation/turn/session/instance | 거부. 비교할 서버 소유 기대값이 없으면 unknown을 성공으로 대체하지 않음 |
| 변조·비정규 bytes·pin 부재/철회·만료·미래 시각·중복 nonce/challenge | 거부. 별도 프로세스·동시 claim도 같은 결론이어야 함 |
| legacy 일곱 필드 CLI self-report 또는 test/fake domain | VM host 신뢰 불가. 기존 caller fallback은 fail-closed |

V04-b의 다음 산출물은 이 delta와 V02-c 동결 계약을 구체적인 직접 ingress 문서·fixture로 확정하는 것이다. 실제 AGS native admission, VM preflight 변경, 설치물 conformance는 각각 V05, V07, V10의 별도 검증을 요구한다.
