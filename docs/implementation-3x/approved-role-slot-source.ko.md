# R16-a — VM 승인 RoleSlot source 계약

상태: **소스 기반 계약 동결**. 이 문서는 R16-b의 VM writer·read-only Port, R16-c의 signed producer, R16-e의 AGS receiver와 R16의 AGS reader를 위한 계약이다. 현재 VM에는 stage RoleSlot 승인이 없으며, 문서의 응답 형태나 R15의 digest는 운영 승인·현재 조회의 실행 증거가 아니다.

## 확인한 원본과 현재 공백

확인 ref는 AGS `463aa63bba5d306a267f6408280bc7fca358af55` (R 전용 worktree)와 VM `e92a246415c21bfa09930677aaf6ce3e0959b249` (`D:/codex/flowmarshal`의 clean `main`)이다.

| 현재 원본 | 확인된 사실 | RoleSlot에 부족한 것 |
|---|---|---|
| VM `src/flowmarshal/engine/domain.py`: `GoalAuthorization`, `PlanContractRevision`, `PlanContractDefinition`, `TaskContract` | Goal 승인은 Goal/root/effect/정책에 결속된다. Plan은 `plan_revision_id`·`revision_no`·`definition_digest`·`activation_digest`를 갖고 Task DAG를 포함한다. `TaskContract.assignment`는 모델 executor/validator 정책이다. | 독립된 stage 역할 슬롯의 `routingRole`·`requirements`·승인 상태·참여 이력. 모델 배정은 슬롯 승인으로 해석할 수 없다. |
| VM `src/flowmarshal/engine/service.py`: `_goal_authorization_target`, `authorize_goal_and_activate_plan`, `_activate_plan_in_transaction`, `reserve_attempt` | 표시 대상은 선택 Plan의 ID/revision/digest를 포함한다. Core는 admissible Plan을 GoalAuthorization 범위와 현재 Goal/Profile/Map에 대조하고, 승인과 activation을 한 transaction에서 기록한다. 재승인된 active Plan은 기존 activation ID를 돌려줄 수 있다. `reserve_attempt`는 thread 생성 **전**에 실행된다. | 해당 Plan에 stage 슬롯을 넣고 검증·기록·철회하는 writer와 현재 슬롯 reader. 이 첫 Attempt 예약에는 아직 실제 session ID가 없다. |
| VM `src/flowmarshal/engine/ledger.py`: `projects.active_plan_revision_id`, `plan_revisions`, `plan_activations`, `goal_authorizations`, `task_contracts` | active Plan은 프로젝트당 하나이고, activation은 Plan revision과 GoalAuthorization을 연결한다. GoalAuthorization은 append-only다. Plan 교체는 이전 revision을 `superseded`로 만든다. | 슬롯 승인 자료와 actor/host/session 참여 사건의 원장 필드·조회 Port. |
| AGS `skills/coordinate-subagents/scripts/orchestration/approved-slot-projection.mjs`와 `contracts/role-slot.v1.schema.json` | R15는 이미 승인된 plan과 전체 참여 이력에서 최대 64개 RoleSlot을 결정적으로 투영한다. `executionAuthorized`는 항상 false다. | 입력의 출처·승인 진위·현재성은 검증하지 않는다. AGS WorkflowStore/T06도 VM의 승인 원장이 아니다. |

## 동결한 승인 소유권

1. **VM Core가 유일한 업무 승인 source owner다.** 설치된 trusted host의 GoalAuthorization과 Core의 admissible Plan activation이 승인 경계다. 별도 slot별 인간 승인 클릭은 요구하지 않지만, 승인 대상 Plan에 슬롯 내용이 들어 있어야 한다. AGS에는 업무 승인 또는 VM DAG의 복제 원장을 만들지 않는다.
2. R16-b는 `PlanContractDefinition`에 Task별 명시적 `role_stages`를 추가한다. 각 stage는 기존 `TaskContract.task_id`를 참조하고 고유 `stageId`와 하나 이상의 assignment를 가진다. assignment는 `assignmentId`, `purpose`, AGS의 네 `routingRole`, `riskLevel`, `highRisk`, `independenceRequired`, `ModelSelectionRequest.v2.requirements` 전체 필드를 명시한다. 이것은 Task 실행 DAG의 새 노드가 아니라 승인 역할 메타데이터다. 기존 Plan의 `ModelAssignmentContract.executor/validator`, `TaskExecutionSpecDefinition.executor/validator`, `required_capabilities`, 모델 이름이나 planner 제출물에서 슬롯을 역산하지 않는다.
3. `role_stages`는 Plan의 `definition_digest`와 `activation_digest`에 포함되고 후보 admissibility·GoalAuthorization target 표시 전에 확정된다. Core가 활성화 때 Task 소속, 중복, R15의 stage/assignment 및 요구사항 규칙, Task 위험도 하향과 Goal/Task 권한 초과를 거부한다. 승인 전 후보의 `approved` 표기는 권위가 아니다. Core는 activation이 성공한 이 명시적 자료만 승인 상태로 기록한다. 구 Plan에 슬롯 필드가 없으면 R16 reader는 **미지원/부재**로 실패한다. 구 Plan의 canonical payload·digest를 읽는 호환성은 유지하고, 없는 필드에 기본 슬롯을 채워 승인하지 않는다.
4. 슬롯 내용 변경·추가·삭제는 같은 Plan row의 수정이 아니라 새 `PlanContractRevision`의 admissible 판정과 activation을 거친다. VM의 기존 supersedes 계보·quiescence 검사로 이전 Plan/slot을 무효화한다. 별도 취소는 VM Core 소유 철회 사건/상태로 기록해 즉시 현재 조회를 닫고, 재개하려면 새 유효 승인 source가 필요하다. 운영자가 파일·MCP 인자에서 보낸 `approved=true`, slot 본문이나 digest는 writer 입력이 아니다.
5. 참여 이력도 VM Core 원장의 소유다. 현재 `runtime.py`는 `reserve_attempt` 후 `create_thread`를 호출하고 그 receipt로 thread ID를 얻은 뒤 `_start_turn`을 호출한다. 첫 예약 transaction에서는 actor/host/session 삼중항을 **기록할 수 없다**. R16-d는 승인·slot 기대값을 **session 없는 pending claim**으로 결속한다. 신뢰된 `create_thread` receipt와 dispatch/role runtime에서 실제 `actorId/host/sessionId`를 확인한 뒤, **첫 `start_turn`/재개 효과 전에** 별도 원자적 admission transaction에서 현재 승인 비교·단조 binding·참여 사건·turn intent를 함께 기록한다. 동일 receipt 재전달은 멱등 처리하고 충돌하는 actor/host/session 결속은 거부한다. 실패·모호한 dispatch, 이전 시도와 교체 Plan의 관련 계보를 포함한다. 생성 효과는 있었으나 receipt/신원이 모호하면 claim을 미해결로 닫고 작업을 시작하거나 독립 감사 이력이 완전하다고 주장하지 않으며 복구/대조 전까지 fail-closed다. caller·모델 보고·단순 thread/turn 문자열을 삼중항의 인증 출처로 쓰지 않는다. 완전성을 입증할 수 없는 과거 계보나 R15의 256개 상한 초과는 fail-closed다. R15가 참여자를 합친 **최종** 감사 슬롯의 `excludedActors`·`excludedSessions`는 각각 `ModelSelectionRequest.v2`의 128개 상한을 다시 검사한다. 기존 제외 값까지 합해 한쪽이라도 초과하면 일부를 버리지 않고 거부한다.

## VM writer → 원장 → read-only Port

R16-b의 writer는 기존 `EngineApplication → EngineService → schema 4 Ledger` 승인 경계 안에서만 동작한다. Plan 활성화 transaction에 현재 슬롯 자료를 Plan revision·activation·당시 GoalAuthorization과 결속하고, 참여·철회 사건의 저장/조회 Port를 제공한다. 실제 runtime의 참여 기록·dispatch admission 호출은 R16-d 소유다. 참여 사건과 철회/교체는 같은 VM 원장에 단조 순서로 남긴다. 별도 AGS 승인 테이블이나 AGS가 수정할 수 있는 동기화 사본은 없다.

VM은 내부 trusted adapter에 **read-only `read_current_approved_role_slot_source(projectId, taskId, expected?)` Port**를 제공한다. `expected`는 plan revision/slot ID 등의 비교 조건일 뿐 선택할 원장 row나 승인 내용을 지정할 수 없다. Port는 한 일관된 원장 read transaction에서 `projects.active_plan_revision_id`로 시작해 Plan row의 `active` 상태, 현재 Task 소속/상태, Plan activation, 가장 최신 GoalAuthorization과 현재 Goal/Profile/정책 적합성, 철회 여부, 전체 참여 이력을 다시 확인한다. `plan_activations.authorization_id`는 당시 승인 근거이고, active Plan의 재승인 시 **최신 유효 GoalAuthorization**도 별도로 확인한다. Plan payload의 저장 당시 `ready` 값만으로 DB의 현재 `active`를 대신하지 않는다.

Port 응답은 하나의 원자적 snapshot이며 다음을 포함한다.

| 필드 묶음 | 계약 |
|---|---|
| 출처·범위 | `owner=flowmarshal-engine`, project/task ID, active `plan_revision_id/plan_id/revision_no/definition_digest/activation_digest`, activation ID와 당시 authorization ID, 현재 authorization ID/revision/digest, 철회 상태. |
| 역할 자료 | 해당 Task의 명시적 stage/assignment 전체를 승인 순서대로 반환한다. `requirements`는 Plan에 저장한 값 그대로이며 caller patch나 executor/validator 추론값이 아니다. |
| 참여 자료 | 현재 Task 및 관련 Plan 계보에 알려진 모든 `actorId/host/sessionId` 삼중항과 완전성·단조 watermark를 반환한다. 누락된 신원, 불완전한 계보, 중복/상한 초과는 거부한다. |
| 현재성 | 승인·철회·Plan 교체·참여 사건마다 바뀌는 단조 source revision/watermark와 snapshot 식별자를 반환한다. 같은 transaction에서 읽은 값만 한 응답에 넣는다. |

`runId`는 VM이 발급한 **승인 범위 식별자**로서 활성화 ID와 현재 GoalAuthorization ID의 조합에 고유해야 한다. 이는 AGS `WorkflowReceipt.runId`나 VM 실행 Attempt ID가 아니다. active Plan을 같은 revision으로 재승인해도 새 승인 범위가 되고 이전 slot ID는 stale이 된다. Port는 이 식별자를 반환하고 R16은 이를 R15의 `approvedPlan.runId`에 넣는다. `approvedPlan.taskId`는 VM Task ID, `revision`은 VM Plan `revision_no`이며 AGS WorkflowReceipt revision이 아니다. 동일 Plan 내 참여 변화는 R15의 참여 digest와 slot ID를 바꾼다.

VM Port를 외부에 연결하는 경로는 **VM Core 부모 프로세스가 시작한 AGS 전용 자식 프로세스의 control pipe**로 고정한다. 이 pipe의 VM dispatch 제어는 이미 있으나 **승인 RoleSlot snapshot 등록 경로는 현재 제품에 없다**. R16-c가 VM Core의 Port 호출, 기존 VM producer key를 사용한 `ags-vm-approved-slot-source-v1` 별도 domain snapshot 서명·control RPC 송신·실제 호출 ID 결속을 구현한다. R16-e가 AGS 서버 소유 control receiver, verifier와 단회 registry를 구현한다. R16의 `approved-slot-reader.ts`는 이 검증된 자료만 소비한다. R16-c와 R16-e의 카드·쓰기 범위·dependency는 메인이 별도로 배정했으며, 두 결과가 통합되기 전 R16을 재개하지 않는다. 어느 쪽도 R16-b의 VM 원장 writer나 R15의 순수 projection에 떠넘기지 않는다.

R16-e의 AGS 수신 측은 운영자가 pin한 해당 VM 설치의 공개키로 서명·canonical bytes·installation/key/host/instance ID를 검증하고, `vm/hello`의 현재 `serverEpoch`, 새 nonce, 짧은 만료, 실제 호출의 invocation ID·project/task/Plan/activation 결속을 대조해 **서버 소유 단회 pending snapshot**으로 보관한다. 일반 MCP `tools/call` 인자, workspace 파일, caller 제공 `owner`·digest·slot 본문, V03 provider 관측 receipt는 이 등록을 대신하지 못한다. 프로세스 재시작·pin 변경·서명/epoch/nonce/호출 결속 실패·전용 pipe 부재에는 fail-closed다. 이 단회 pending 자료는 VM 업무 원장의 복제본이나 장기 승인 저장소가 아니다.

R16은 검증된 pending snapshot만 읽어 R15 형식으로 변환한다. VM의 `sha256_digest`와 R15의 JavaScript `digest`가 전체 입력에서 동일하다고 가정하지 않는다. R16은 VM의 원본 필드를 검증하고 R15 함수를 호출해 projection digest를 계산하며, 투영 후 전체 RoleSlot schema와 감사 제외 목록 한도를 검사한다. R16의 결과는 `RoleSlot[]`와 별도로 VM authority 식별자·activation/Plan digest·source watermark·R15 plan/participation digest를 보존한다. AGS의 조회·제안은 실행 허가가 아니다.

보호된 VM slot dispatch에는 **두 단계**가 필요하다. (1) R16-d의 별도 opt-in 보호 작업에서 `reserve_attempt` 시 R16 결과의 기대 project/task, Plan revision/activation, 최신 authorization ID/digest, source watermark와 전체 slot 결속을 현재 원장과 비교해 Attempt에 **session 없는 pending claim**으로 고정한다. 이때 참여 완료를 만들지 않는다. (2) `create_thread` receipt 뒤 실제 actor/host/session을 인증한 후 첫 `start_turn` 또는 재개 전에 R16-d의 VM writer가 claim과 현재 승인/slot/참여 watermark를 **같은 write transaction**에서 비교하고, 일치할 때만 claim을 단조 결속하고 참여 사건과 turn intent를 함께 기록한다. 상태는 pending→bound/admitted→closed 또는 pending→unknown/closed로만 단조 전이한다. receipt가 모호하면 unknown으로 닫아 대조 전 외부 시작과 독립 slot 재발급을 막는다. 같은 receipt는 멱등 처리하고 다른 신원으로 재결속하지 않는다. 불일치·철회·구 slot·신원 미확인은 turn을 시작하지 않는다. 자기 참여 기록으로 watermark가 증가한 뒤에는 admission token으로 자기 사건을 식별하되, 실제 외부 효과 직전 다른 승인·Plan·참여 변경은 다시 검사하거나 시작을 막는다. 철회·재승인 writer도 진행 중 claim·intent와 이 경계를 조율해야 하며, AGS 재조회나 첫 Attempt 예약만으로 현재성을 주장하지 않는다. R16-d는 O16-a/b가 소유할 실제 AGS allocation 연결을 선행 구현하지 않는다. 기존 `run_once`는 legacy 실행 경로로 남으며 이를 approved-slot 실행이나 위 보호 경계의 검증 증거로 간주하지 않는다.

## 후속 구현 소유와 선행 순서

| 순서 | 소유 Task | 구현·검증 경계 |
|---|---|---|
| 1 | **R16-b (VM)** | 승인 `role_stages`의 Plan/원장 writer, 철회·교체, 참여 사건 저장소와 current read-only Port. fixture에서 저장·재시작·조회까지 검증한다. runtime dispatch와 signed transport를 완료로 주장하지 않는다. |
| 2 | **R16-c (VM)** | VM Core 전용 control pipe의 signed snapshot producer, 별도 domain/key/epoch/nonce/실제 invocation 결속과 송신. R16-b Port를 소비하며 caller body를 신뢰 입력으로 받지 않는다. |
| 3 | **R16-e (AGS)** | signed control receiver, 설치 pin·호출 결속 검증과 서버 소유 단회 snapshot registry. R16-c 송신을 받아 인증하며 R16 reader의 입력을 공급한다. |
| 4 | **R16 (AGS)** | R16-e에서 검증된 단회 snapshot만 읽어 R15 projection을 연결한다. **R16-c와 R16-e의 main 통합 전 재개 금지.** |
| 5 | **R16-d (VM)** | 별도 보호 작업의 `reserve_attempt` pending claim과 `create_thread` receipt 뒤 첫 `start_turn`/재개 전 Core CAS·단조 결속·참여 기록, 효과 직전 재검사·모호한 생성 복구. O16-a/b의 AGS allocation은 구현하지 않으며 legacy `run_once`를 승인 슬롯 실행으로 주장하지 않는다. |

메인은 각 Task의 repository/worktree·쓰기 경로·dependency·테스트 카드를 별도로 배정했다. 위 소유 표는 구현 완료나 기존 카드의 자동 확대가 아니다.

## digest의 뜻

| 값 | 뜻 |
|---|---|
| VM `GoalAuthorization.authorization_digest` | VM 승인 객체의 내용 결속. 원장과 trusted host 경계가 진위의 근거다. |
| VM `PlanContractRevision.definition_digest/activation_digest` | VM Plan 내용·revision 결속. active pointer, activation row와 현재 GoalAuthorization 확인이 별도로 필요하다. |
| R15 `approvedPlan.planDigest/authorizationDigest`, `participation.digest` | AGS projection의 **재계산 가능한 구조적 hash**. VM 원장 승인, 인간 승인, 참여 이력의 진위·완전성·현재성을 스스로 증명하지 않는다. |
| R15 `RoleSlot.slotId` | 위 projection과 참여 digest에 결속된 식별자. 실행 허가가 아니며 `executionAuthorized=false`다. |

## 후속 수용 검사

- R16-b: trusted host 승인→admissible Plan 활성화→VM ledger 저장→Port 현재 조회를 실제 fixture에서 연결한다. 없는 Task/slot·다른 프로젝트·미활성/교체/완료 Plan·철회·구 authorization·요구사항 수정·참여 저장소 누락을 거부한다. 승인 후 같은 Plan 재승인, Plan 교체와 재시작을 검사한다. 실행 명령은 카드의 `tests/test_engine_approved_stage_slots.py`를 따른다.
- R16-c: VM Core의 signed control 송신과 실제 invocation·epoch·nonce 결속, 재시작/서명 오류를 검사한다. 이것은 R16-b 원장 조회와 별도 제품 연결이다.
- R16-e: R16-c의 signed control 송신을 AGS 전용 receiver에서 받아 pin·canonical bytes·epoch·nonce·invocation 결속을 검증하고 단회 registry의 중복 소비·재시작·pin 변경·위조 입력을 거부한다.
- R16: VM Port fixture를 **writer 경유로** 만들고 R16-c→R16-e 경계에서 검증된 snapshot을 소비해 현재 source→R15→RoleSlot을 검증한다. 외부 slot 본문, 잘못된 Task/plan revision, 취소·교체·stale source, requirements 위조와 감사 제외 목록 128개 초과를 거부한다. R16-c/e 통합 전에는 R16을 완료로 판정하지 않는다.
- R16-d: 격리된 opt-in 보호 작업에서 `reserve_attempt` pending claim, 신뢰된 `create_thread` receipt 뒤 단조 binding/CAS·참여 이력, 조회→예약 사이 철회/재승인 경쟁, create_thread 미확인 효과, 충돌 신원, 중복 receipt, 효과 직전 변경 차단을 검사한다. O16-a/b의 실제 AGS allocation 연결은 별도이며 legacy `run_once` 성공을 approved-slot 실행의 증거로 삼지 않는다.

이 문서에서는 VM 제품 코드·원장·Port와 AGS reader를 구현하지 않았다.
