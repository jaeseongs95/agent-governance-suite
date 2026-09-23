# r6 VM producer receipt 직접 ingress 계약 delta

상태: **BLOCKED_CONTRACT인 실행 계획 개정**. V04-b의 기존 `BLOCKED` 이력을 유지한다. F4 현재 호출 독립 결속과 F5 strict context 필드 출처를 위한 V03-a~V03-d 네 선행 Task를 계획에 추가했으나 아직 실행·통합되지 않았다. V04-b 정상 계약 동결·fixture, V05 native admission, V06 direct smoke를 READY/COMPLETED로 취급하지 않는다. 이 문서는 제품 구현, 운영 pin 배포, live provider 관측 또는 VM conformance PASS가 아니다.

## 확인한 현재 경로

- AGS 확인 기준 `027401751abba7df9ac3022edab816f21c04ca93`(현재 통합 HEAD `e50400b1736f5d09de94efadd1715b73dd20e851`까지 아래 대상 파일 diff 없음): V03 `observation-challenge.ts`는 operator pin의 Ed25519 producer receipt와 tool/input·여덟 binding·시각·nonce를 검증하는 leaf다. 다만 그 verifier의 여덟 기대 binding은 등록된 `VmInvocationSource`가 제공해야 하며 제품 MCP entrypoint에는 연결되지 않았다. V04-a `observation-signer.ts`는 검증된 challenge에서 별도 HMAC receipt를 만들지만 제품 MCP entrypoint는 이를 호출하지 않는다. `index.ts`의 운영 host attestation 연결은 Claude Code 전용이다.
- FlowMarshal main `2deb96e9eded9dbb9251dc7e226da5e8dc765171`: `GovernancePlugin.call`은 `_vmProducerReceipt`가 있으면 서명 envelope를 `_hostAttestation`으로 MCP에 직접 전달하며 CLI를 우회한다. receipt가 없는 caller observation fallback만 legacy `host-attestation-cli`를 호출한다. 같은 파일의 `CONSUMED_SURFACE.entry_points`와 preflight는 아직 CLI를 필수로 요구한다.
- VM producer의 signed body에는 model/effort와 producer/terminal·invocation 정보가 있지만 `modelClass`와 `actorId`는 없다. VM의 legacy CLI `modelClass`는 caller 설정의 주장이다. AGS strict `ExecutionContextV1`은 `modelClass`로 하한을 판정하고 `actorId`를 요구한다. 현재 제품에는 VM 전용 operator 관리 exact model→class 정책과 pin 기반 actor derivation의 운영 연결이 없다.
- V01-a의 동결 소비 계약은 legacy CLI stdin의 `host/tool/input/model/modelClass/reasoningEffort/actorId`를 기록한다. 이 일곱 필드에는 V03 challenge나 신뢰된 invocation source가 없다. 이 역사 계약과 V02-c source pin, Progress append-only 행은 재작성하지 않는다.

## r6 목표 경계

1. **VM producer → MCP:** VM이 완료 provider turn과 그 뒤의 governance invocation을 Core에서 재대조하고, V02-c wire 형식 `{body, signature, keyId}`를 `_hostAttestation`에 싣는다. `turnId`는 완료 turn, `invocationId`는 별도 MCP 호출이다. caller model/effort dict, `source` 문자열, legacy CLI token은 VM host 인증 입력이 아니다.
2. **AGS 현재 호출:** MCP dispatcher가 실제 tool 이름과 수신 인자에서 `_hostAttestation`을 제외한 unsigned input을 확정한다. 첫 `plan_workflow`의 `taskId`는 검증된 caller `taskEnvelope`에서 오며 AGS 저장 상태나 서버 발급 ID가 아니다. AGS는 이를 서명된 VM `taskId`와 비교할 수 있지만 그 일치가 Task 소유권·실행 권한을 발급하지 않는다. bootstrap `runId/attemptId`는 아직 AGS run 및 VM 실행 attempt가 없는 phase의 프로토콜 기대값 `null`이다. `record_stage_result`의 caller `runId`는 조회 키이며, AGS 저장 receipt의 `plan.taskId/runId`와 현재 stage/revision을 재확인한 뒤 signed VM task/run과 비교한다. AGS workflow에는 `attemptId`가 없다. stage attempt는 caller JSON이나 signed receipt 자체에서 기대값을 만들 수 없고, 별도로 등록된 신뢰 VM Core 호출 문맥에서 조회해야 한다. 그 문맥이 없으면 signed attempt가 `null`이어도 unsupported/fail-closed다. caller JSON, CLI argv/environment가 기대 binding·reader·store·clock·pin 경로·host domain을 선택하지 못한다.
3. **서명과 현재 호출:** V03은 pin된 Ed25519 key, canonical bytes, signed body 내부 일관성, tool/input·기대 binding, 시각·nonce를 검증한다. 그러나 `VmInvocationSource.binding`의 기대 invocation/turn/session/instance를 signed body 또는 MCP arguments에서 복사하면 자기대조다. 현재 MCP 제품 경로에는 receipt와 독립된 *현재 호출*의 해당 문맥을 제공하는 인증 transport·privileged adapter가 없다. 따라서 같은 tool/unsigned input/taskId/null run·attempt에 대한 유효 A receipt를 B 호출에 먼저 전달하면 signature·digest·TTL·첫 nonce claim만으로 B를 구별할 수 없다. A가 나중에 replay로 거부돼도 B의 선점 admission은 막지 못한다. 독립 현재 호출 source가 마련되기 전에는 bootstrap과 stage 모두 unsupported다.
4. **strict context:** `ExecutionContextV1.modelClass`는 AGS/operator가 관리·version pin한 exact observed model ID→class 표의 현재 host 검증값에서만 얻는다. catalog의 문서상 class나 VM caller 설정만으로 live class를 만들지 않으며 미등록/미검증 ID는 unsupported다. `actorId`는 신뢰 결속을 통과한 뒤 pin registry의 `installationId`로 서버가 `vm-producer:<installationId>`를 유도한다. 이는 producer principal이며 개별 Worker·인간 신원이나 독립성 근거가 아니다. 현재 해당 운영 mapping·연결이 없으므로 signed model/effort만으로 strict context를 만들 수 없다.
5. **조건부 native admission:** 인증 VM transport 또는 동일 프로세스 privileged adapter가 signed receipt·MCP arguments와 독립된 현재 invocation/turn/session/instance 및 stage attempt 기대값을 제공하고, AGS가 실제 tool/input·phase별 task/run과 교차 확인한 뒤에만 V05가 `TrustedExecutionContextProvider`에 관측을 제공할 수 있다. B 호출의 A receipt는 nonce 소비 전에 거부하고 A 호출만 평가한다. source·modelClass 정책이 없으면 정상 receipt도 unsupported/BLOCKED_CONTRACT다. V04-a HMAC receipt와 legacy CLI token은 직접 경로의 대체가 아니다.
6. **package와 VM 정렬:** V06 direct MCP smoke는 V05의 독립 호출 결속·strict context 및 A/B 선점 거부가 실제 검증되기 전에는 완료할 수 없다. V07의 기존 CLI preflight/fallback 정리도 누락된 인증 transport를 자동으로 제공하지 않는다. V10 conformance와 G08 VM-selected gate는 F4/F5 결손이나 unsupported 경로를 PASS로 취급하지 않는다.

## 필요한 선행 작업과 dependency

1. **V03-a / AGS 계약 동결:** 현재 VM Core dispatch와 AGS transport를 확인해 실제 구현 가능한 인증 channel을 선택한다. VM Core의 진짜 MCP dispatch call identity가 서명 body와 별도 인증 metadata 모두에 결속되는지, AGS가 signed body/MCP arguments에서 독립 기대값을 재구성하지 않는지, operator exact model→class·pin actor 정책을 정의한다. sideband metadata도 별도 bearer로 재사용할 수 없도록 실제 현재 요청 call ID·연결·수명에 묶고 병렬 요청·재시작 replay를 거부한다. 구현 가능한 mechanism이 없으면 이 Task 자체가 `BLOCKED_CONTRACT`다.
2. **V03-b / VM 구현:** 별도 VM branch/worktree에서 실제 dispatch call identity·stage attempt를 producer 서명과 인증 transport metadata에 결속한다. bearer receipt 복사, client-chosen request ID, caller observation/legacy CLI는 독립 current-call source가 아니다. V03-a의 검증·메인 통합 뒤 착수한다.
3. **V03-c / AGS 현재 호출 source:** V03-b VM 결과가 메인에 통합된 뒤 AGS 제품 MCP 요청별 privileged adapter와 `VmInvocationSource`를 연결한다. A receipt를 B 동일 입력 호출이 먼저 내도 B를 nonce claim 전에 거부하고 A만 평가한다. 동일 연결 다른 call ID, 다른 session/instance, stage attempt, 병렬 요청·재시작을 검증한다.
4. **V03-d / AGS strict profile:** V03-c 뒤 operator version-pinned exact observed model ID/host→class 정책과 pin installation principal의 `actorId` derivation을 구현한다. 미등록 모델·host 미검증·pin 철회·caller/legacy CLI 값은 fail-closed다.
5. 기존 245개 ID의 상대 순서·모델/추론 설정을 유지한 채 위 네 ID를 더해 r6 총 249개다. V04-b는 V03-d dependency를 추가했고 V05는 V04-b 뒤에 남는다. 후순위 V07은 V06 뒤에 있으므로 선행 근거로 돌려 순환시키지 않는다. 각 선행 Task의 로컬 commit·독립 감사, 교차 저장소 통합·Progress 완료와 실제 current-call 근거가 확인되기 전에는 V04-b `BLOCKED_CONTRACT`를 해제하지 않는다.

## 거부 행렬과 근거 한계

| 사례 | 요구 결과 |
|---|---|
| pin된 VM receipt와 실제 tool/input·phase별 task/run, 별도 인증된 현재 invocation/turn/session/instance·stage attempt, operator modelClass 정책이 모두 일치 | 선행 작업 이후 V05에서만 host 관측 admission 후보. 현재는 source·정책 부재로 unsupported |
| 유효한 A receipt를 같은 bootstrap tool/unsigned args/taskId/null run·attempt의 B 호출에서 먼저 사용 | 독립 현재 호출 문맥이 있으면 B를 nonce 소비 전에 거부. 현재는 A/B를 구별할 source가 없으므로 **둘 다 unsupported**; 첫 사용 성공을 주장하지 않음 |
| 서명은 유효하지만 다른 tool/input·phase별 task/run/attempt·host 또는 다른 invocation/turn/session/instance | 독립 기대값과 다르면 거부. 기대값이 없으면 signed `null`까지 포함해 unsupported; signed body를 기대값으로 복사하지 않음 |
| observed model의 exact host-verified class mapping 부재 또는 actorId를 caller/legacy CLI 값에서 가져옴 | strict `ExecutionContextV1` admission 거부. actorId는 결속 통과 뒤 pin installation principal에서만 유도 |
| 변조·비정규 bytes·pin 부재/철회·만료·미래 시각·중복 nonce/challenge | 거부. 별도 프로세스·동시 claim도 같은 결론이어야 함 |
| legacy 일곱 필드 CLI self-report 또는 test/fake domain | VM host 신뢰 불가. 기존 caller fallback은 fail-closed |

V04-b의 다음 산출물은 V03-a~V03-d의 신뢰 source·model 정책이 실제 통합된 뒤 A/B 선점과 strict context를 포함하는 직접 ingress 문서·fixture다. 현재는 `BLOCKED_CONTRACT`이며 V05 native admission, V06 smoke, V07 preflight, V10 conformance, G08 VM-selected gate를 순차 완료로 예약하지 않는다.

## r4 → r6 보존 근거와 배분 조건

- r5 첫 편집 전의 기존 245개와 r6에서 신규 V03-a~V03-d를 제외한 기존 245개에 대해 `JSON.stringify(tasks.map(t => [t.id, t.model, t.reasoning_effort]))`의 UTF-8 SHA-256은 모두 `5298759224c743f9e27333cd9ece36f9e195997d479ceacd6481e920160fbc63`이다. 기존 ID의 상대 순서·모델·reasoning은 유지된다. 신규 네 Task를 포함한 총수는 249개다. 원본 r4 `TASKS.json` 전체 파일은 별도 snapshot으로 확보되지 않아 전체 byte diff나 미기록 필드의 불변성까지 주장하지 않는다.
- 의도한 필드 delta는 V04-b의 CLI 구현 → 조건부 direct ingress 계약 동결·V03-d dependency/F4/F5 차단, V05의 V04-a dependency 제거·native admission 선행 source·정책 조건, V06의 조건부 direct MCP package smoke, V07의 CLI preflight/fallback 정리, V10/G08의 direct 경로 gate, V07의 전용 VM branch/worktree/handoff 배분 규칙, V03-a~V03-d의 신규 분할이다. V01-a/V02-c 동결 문서와 V04-b `BLOCKED` Progress 행은 다시 쓰지 않았다.
- V07의 계획 branch/worktree는 실제 생성·배정 상태가 아니다. V06 통합 후 VM 저장소의 base SHA·전용 worktree·적용 `AGENTS.md`·단일 작성자를 확인하고 manifest에 적힌 경로와 일치시킨 뒤 배분한다. 확인하지 못하면 V07은 배분하지 않는다. V07 이후 VM conformance 및 VM-selected package gate는 unsupported stage attempt 경로를 성공으로 간주할 수 없다.
