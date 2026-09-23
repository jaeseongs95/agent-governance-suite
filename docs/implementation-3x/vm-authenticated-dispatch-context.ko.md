# V03-a — VM 현재 dispatch 인증 문맥 계약

상태: **계약 동결 후보**. 아래 transport 동작은 현재 AGS/VM 제품에 연결되지 않았다. 이 문서와 fixture는 V03-b/V03-c/V03-d의 구현 경계를 정하며 VM direct admission을 허용하지 않는다.

## 확인한 구현 능력과 신뢰 경계

- FlowMarshal main `2deb96e9`: `GovernancePlugin`의 `McpStdioClient`는 AGS Node 서버를 `subprocess.Popen`의 전용 stdin/stdout pipe로 시작한다. `_request`가 JSON-RPC ID를 순번으로 붙인다. `GovernancePlugin.call`은 `_vmProducerReceipt`를 `_hostAttestation` 인자에 복사한다. 현재 receipt의 `invocationId`는 producer가 임의 생성하므로 실제 JSON-RPC 요청 ID가 아니다. Python `subprocess.PIPE`는 Windows/Linux 공통 API이지만 새 인증 경로의 양쪽 OS 종단 간 동작은 아직 관측되지 않았다.
- AGS SDK의 `Server.setRequestHandler` 두 번째 인자에는 실제 JSON-RPC `requestId`가 있다. 현재 설치 SDK를 사용한 `V03-a.test.mjs`는 한 연결의 두 `tools/call`에서 서로 다른 ID와 예약용 문자열 ID가 핸들러까지 전달됨을 관측한다. 같은 API로 `vm/hello` 같은 별도 control method를 등록할 수 있다. `StdioServerTransport`의 `sessionId`는 기대하지 않는다.
- V03 verifier의 `VmInvocationSource.binding`은 공급자가 제공한 기대값이다. 현재 제품 `index.ts`/`server.ts`는 VM source를 등록하지 않는다. receipt 또는 MCP 인자에서 기대값을 만들면 A receipt를 B 동일 입력 호출이 먼저 제출하는 공격을 막지 못한다.
- 신뢰 주체는 operator가 pin한 VM producer key와 그 key를 사용하는 VM Core다. 일반 tool caller는 `_hostAttestation`과 업무 인자를 바꿀 수 있지만 VM Core의 전용 pipe 쓰기, control method 호출, JSON-RPC ID 선택, producer key에는 접근할 수 없다는 경계에서만 이 경로를 지원한다. 해당 경계를 보장할 수 없는 일반 MCP 연결은 VM host 신뢰를 제공하지 않는다. OS 사용자 격리나 인간 승인까지 증명하지 않는다.

## 선택한 mechanism: 전용 stdio + 서버 예약 요청 ID

1. VM Core가 전용 AGS 자식 프로세스를 시작한다. AGS는 프로세스 시작 때 암호학적 난수로 `serverEpoch`를 만들고 `vm/hello` control RPC로 돌려준다. 새 AGS 프로세스는 반드시 다른 epoch를 사용한다. `vm/hello`만으로 권한은 생기지 않는다.
2. Core는 DB의 prepared operation·완료 terminal·현재 task/run/attempt·실제 tool/unsigned input을 재확인하고, receipt와 별개의 **dispatch registration**을 만든다. registration은 domain `ags-vm-dispatch-registration-v1`, epoch, 단회 nonce, terminal event ID/call ID/turn ID/model/effort, session/instance, task/run/attempt, operation key, tool/input digest와 producer key ID를 포함해 VM producer key로 서명한다. 일반 caller observation, CLI argv/environment, receipt body를 registration의 출처로 삼지 않는다.
3. Core는 같은 전용 pipe의 `vm/reserve_dispatch` control RPC로 registration을 전달한다. AGS는 operator pin으로 서명을 검증하고 현재 epoch·nonce·TTL·필드·pin 상태를 확인한 뒤, 서버가 새 **불투명 문자열 JSON-RPC call ID**를 예약해 해당 registration의 기대 binding을 요청별 pending ledger에 보관한다. 중복 registration nonce는 새 예약을 만들지 않는다. control RPC의 원문·서명은 다른 요청에서 재사용 가능한 권한 토큰이 아니다.
4. Core는 예약된 call ID를 receipt의 `binding.invocationId`로 넣어 서명한다. `McpStdioClient`는 이 ID를 실제 `tools/call`의 JSON-RPC `id`로 사용하고 응답도 그 ID로 대조한다. 일반 순번 ID와 예약 문자열 ID는 서로 다른 namespace다. 예약 뒤 다른 요청이 끼어도 ID·pending record는 변하지 않는다. 현재 `_request`의 공유 `sequence` 응답 대기는 이 계약의 경합을 지원하지 않으므로 V03-b에서 요청별 대기로 바꾼다. 현재 V03 wire의 exact-key 검사와 VM producer 발급 순서는 V03-b/V03-c에서 함께 버전 관리한다. 구 wire를 새 인증 문맥으로 자동 승격하지 않는다.
5. AGS의 요청 핸들러는 SDK `extra.requestId`와 현재 서버 epoch로 pending record를 조회한다. record는 signed receipt와 MCP arguments에서 독립된 기대 `invocationId/turnId/sessionId/instanceId/taskId/runId/attemptId`를 제공한다. 실제 tool/unsigned input은 현재 dispatcher 요청에서 확정한다. receipt 서명·pin·terminal→invocation 인과·TTL·digest와 registration의 terminal event/call/turn/model/effort·Core operation·tool/input을 교차 비교하고 phase별 AGS 저장 task/run을 재확인한다. 모든 비교가 끝나기 전에는 producer nonce나 pending reservation을 claim하지 않는다. 정상 경로는 reservation과 producer nonce를 단회·경합 안전하게 claim한 뒤에만 V05 admission 후보로 전달한다. V03 challenge 발급과 확인이 같은 요청 문맥을 두 번 읽으므로 claim 후에도 그 요청에서만 pending binding을 읽을 수 있어야 하며 다른 요청에 재배정할 수 없다.
6. A reservation의 call ID·receipt를 B의 동일 tool/input/task/null 호출에 붙이면 B의 실제 `extra.requestId`는 B 예약 ID이므로 B pending binding과 A receipt가 다르다. B는 claim 전에 거부되고 A의 reservation/nonce는 남는다. B가 A registration만 복사하면 epoch·registration nonce·예약 단회 규칙에서 거부한다. 다른 프로세스의 A sideband/receipt는 새 epoch와 맞지 않는다. Core가 아닌 주체가 pipe 또는 JSON-RPC ID를 직접 조작할 수 있으면 이 보장은 성립하지 않으므로 그 연결은 unsupported다.

## 필드 소유와 실패 처리

| 값 | 독립 기대값의 소유자 | 규칙 |
|---|---|---|
| 실제 call ID | AGS 예약 ledger + SDK `extra.requestId` | receipt의 `invocationId`와 정확히 같아야 한다. client가 임의 고른 ID는 VM 경로에서 거부한다. |
| turn/session/instance | VM Core 서명 registration을 AGS가 현재 epoch의 pending ledger에 저장 | receipt body나 tool arguments에서 역산하지 않는다. 같은 key가 두 주장에 서명해도 서로 다른 채널·시점·call ID 결속을 검사한다. |
| bootstrap task/run/attempt | Core registration 및 AGS 실제 `taskEnvelope.taskId`와 프로토콜 `null` | taskId 일치는 Task 실행 권한이 아니다. |
| stage task/run/attempt | Core registration의 현재 ledger 상태 + AGS 저장 workflow receipt의 task/run | `baseline`은 Worker attempt 생성 전이므로 Core가 `attemptId=null`과 아직 생성되지 않은 ledger 상태를 확인해야 한다. `implementation` 및 그 뒤의 관측 stage는 현재 성공한 Worker attempt ID를 요구한다. 어느 stage든 독립 source 없이 signed `null`만 제시하면 unsupported다. |
| tool/input | AGS 실제 dispatcher 요청 + Core registration digest + VM receipt digest | `_hostAttestation`은 unsigned input에서 제외한다. |
| terminal event/call/turn/model/effort | VM Core가 완료 provider terminal에서 읽어 서명한 registration과 receipt | 두 서명본의 정확한 값이 일치해야 한다. 요청·설정·model catalog만으로 관측값을 채우지 않는다. |
| `modelClass` | AGS/operator 소유 version-pinned exact `(hostId, 검증된 host build, observed model ID) → class` 정책 | pin의 `installationId`에 설치자가 측정한 VM build digest·정책 버전을 결속하고 그 등록값으로만 class 표를 조회한다. runtime/caller가 전한 build 문자열은 근거가 아니다. 설치 변경 후 재측정·재등록이 없거나 exact ID가 없으면 unsupported. 문서상 모델 계급을 live class로 쓰지 않는다. |
| `actorId` | operator pin의 `installationId`에서 AGS가 `vm-producer:<installationId>` 유도 | producer principal이다. Worker나 인간 신원·독립성으로 표현하지 않는다. |

Registration 검증 실패, 미등록/만료/중복 예약, 다른 요청 ID, process restart, 동시 claim, pin 철회, 미확인 host/model mapping, caller/legacy CLI fallback은 모두 fail-closed다. 현재 AGS는 `AGENT_GOVERNANCE_VM_PIN_PATH`를 VM 부모의 상속 환경에서 읽으므로 운영 source로 사용하지 않는다. V03-d는 설치자가 보호한 AGS 설정 위치를 **VM 자식의 환경·argv·cwd와 무관하게** 고정하고 파일 소유자·쓰기 권한·symlink를 검사해야 한다. 그 위치의 pin entry는 `keyId/installationId/hostId/VM build digest/model 정책 버전`을 함께 결속한다. VM executable·producer key 보관소의 설치 측정과 갱신 절차, AGS 정책 파일의 읽기 전용 권한을 운영자가 확인하지 못하면 이 경로는 unsupported다. Crash 뒤 효과가 시작됐는지 불명확하면 새 receipt·registration을 자동 발급해 재시도하지 않고 VM Core의 no-effect/effect 기록을 먼저 확인한다. `V03-a.test.mjs`와 fixture는 **SDK 전달 능력 및 계약 판별 사례**이며 제품 ingress·운영 pin·실제 host 지원을 검증한 결과가 아니다.

## 구현·검증 분할

- V03-b (별도 VM 저장소): Core registration을 prepared operation에서 만들고, 예약 call ID를 receipt 서명과 실제 JSON-RPC 요청에 사용한다. Linux/Windows의 `subprocess.PIPE` 경계, 동시성, crash/restart와 Core-only 호출을 실제 VM 테스트로 입증한다.
- V03-c (AGS): control RPC·epoch·pending ledger·SDK `extra.requestId`를 제품 MCP 진입점에 연결하고 `VmInvocationSource`를 요청별로 구성한다. 동일 연결 A/B 선점, sideband 복제, 재시작·경합·nonce 미소비를 실제 제품 테스트로 입증한다.
- V03-d (AGS): operator 관리 host build/modelClass 정책과 pin actor derivation을 구현하고 미등록/철회·legacy fallback을 검증한다.
- V04-b/V05는 위 결과의 통합·Progress 완료 전 `BLOCKED_CONTRACT`다. V03-a만으로 bootstrap/stage 정상 admission 또는 live host 지원을 주장하지 않는다.
