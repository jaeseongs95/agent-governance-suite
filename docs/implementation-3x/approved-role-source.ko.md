# R17 — 공통 승인 RoleSlot source·효과 권한 Port 동결

상태: **계약 동결**. `contracts/approved-role-source.v1.schema.json`와 `R17.test.mjs`는 R18(AGS producer)·R19(AGS reservation/효과 gate)의 입력이다. 이 문서는 AGS 승인 원장, VM 원장, runtime start를 구현하지 않고 기존 VM 보호 검사를 없애지 않는다.

판정 경계: `APPROVED_ROLE_SOURCE_PORT_FROZEN`은 **자격을 갖춘 행**에 대해 공통 schema/port 계약이 동결됐다는 뜻이다. 소유자별 runtime 경로 전체의 자격은 뜻하지 않는다(`runtimeQualification=NOT_CLAIMED`). 자격을 갖춘 행은 AGS source(R18/R19) 행과, FM main 또는 AGS 통합 브랜치에 반영된 VM source 행이다. 나머지 VM 행은 `UNQUALIFIED_PENDING`이다.

## 확인한 원본

| 원본 | ref / SHA | 확인한 사실 |
|---|---|---|
| AGS 통합 브랜치 | `codex/v260-semantic-decision-layer` `b6b87a8ca8fba3c8b26473128806df74b399376e` | R15 `3549ce7ab9f64d7a29c9672e5d6b97328f3a57c0`, T06 `918dc3521fa9b047f2f822c0f8c6a01e2851d980`, R16-a `9e0bfced0577edfdd65e9c59f16393b9825000b5`, R16-e `8532544cc44449fc54cd6f928811791be9c5c87f`, R16 `0f22be626a6d1a0f9e48af480c56dc37c3e1b3fc`가 모두 조상이다. 처음 확인한 base는 `0e88cb6039e143e79dd8c68c7aecc3e45da41d43`이었고 `b6b87a8`에서 다시 확인했다. |
| FM `main` | `fed976f4b100a13920c5e8e1f5e533ac41116a77` (인용 기준), `3ce4293a4a755705e14028d1edf6140994a9ce57` (재확인) | 두 SHA 모두에서 R16-b `9d697ea4eb7b359c586da3953ddd7f54617a720f`, R16-c `e7721cbb7e370b77d200b000a1a6c4c87d72b020`가 조상이다. R16-d `83675ad…`와 R16-f `381ce6d…`는 조상이 아니고, Progress에서 둘 다 BLOCKED다. |

**AGS에는 authoritative 승인 source가 아직 없다.** `mcp-server/src/model-routing-workflow.ts:83-89`와 `mcp-server/src/routing-v3/workflow-binding.ts:117-118`은 "native approval adapter"가 없으니 Task별 승인을 추정하지 말라고 막는다. `workflow-service.ts:205-232`의 `userApprovalRefs`는 convergence root 교체에 필요한 증거 참조일 뿐이다. `needs-approval` stage 상태(`sqlite-workflow-store.ts:706`)는 대기 표시이며 역할 승인 기록이 아니다. T06 current binding(`workflow-binding.ts:25`)도 승인이나 실행 권한을 주지 않는다. 따라서 AGS source는 아래 **최소 producer 계약**만 동결하고, 원장과 reader 구현은 R18, reservation과 효과 gate는 R19에 남긴다.

## 소유권

1. authoritative producer는 서로 다른 둘이다. **AGS workflow**(R18)는 AGS 자체 workflow의 역할 승인을 소유한다. **VM Core**(`flowmarshal-engine`, R16-b 원장)는 VM 업무 승인과 Plan/Task DAG를 소유한다. 한쪽이 다른 쪽의 승인을 대신하거나 복제하지 않는다. VM Plan/Task DAG는 AGS에 복제하지 않는다.
2. 두 source는 같은 `ApprovedRoleSourceSnapshot.v1` 모양으로 읽히며, `producer.owner`와 `approval.origin`이 짝을 이뤄야 한다(`ags-workflow`↔`ags-workflow-approval-record`, `flowmarshal-engine`↔`vm-core-goal-authorization`).
3. AGS core 경로의 자격은 VM runtime 자격과 무관하다(`agsCoreIndependentOfVmRuntime=true`). VM 행이 PENDING이어도 AGS 행 동결은 막히지 않는다. 반대로 AGS 행이 VM 실행을 해제하지도 않는다.

## 공통 Port

| Port | 입력 | 출력·규칙 |
|---|---|---|
| `readCurrentApprovedRoleSource(scope, expected?)` | 서버가 가진 scope. `expected`는 비교 조건일 뿐 row나 승인 내용을 고르지 못한다. | 한 read transaction에서 얻은 snapshot. `currentness.state=current`, `revocation.state=not-revoked`, `inputProvenance=server-owned-current-read`, `grants.executionAuthorized=false`, `grants.effectAuthorized=false`. 조회는 권한이 아니다. |
| `reserveApprovedRole(snapshotDigest, sourceRevision, slotId)` | 방금 읽은 snapshot 식별자 | `pending` reservation. 이 시점에는 session 신원이 없다(`identity=null`). |
| `bindReservation(reservationId, verifiedIdentity)` | 서버가 검증한 actor/host/session | `pending→bound`. 신원의 출처는 `ags-server-session-binding` 또는 `vm-trusted-create-thread-receipt`만 인정한다. 같은 receipt는 멱등이고, 다른 신원으로 다시 결속할 수 없다. |
| `admitReservation(reservationId)` | — | `bound→admitted`. 현재 source revision·철회 상태를 다시 비교해 일치할 때만 넘어간다. |
| `beginEffect(reservationId)` | — | `EffectStartDecision`. 효과 intent와 **같은 write transaction**에서 현재 revision·철회·slot 소속을 다시 확인한다. `start`에는 `admitted` 상태와 현재 revision 일치가 둘 다 필요하다. `EffectStartDecision`과 reservation은 모두 `slotId`를 가진다. `start`이면 `invokeCount=1`, `deny`이면 `invokeCount=0`이다. `unknown`은 invoke 여부를 단정하지 않으므로 `invokeCount`를 적지 않는다. |
| `revokeApprovedRole(scope, reason)` | source owner의 철회 사건 | 현재 조회를 즉시 닫는다. 효과 전의 reservation은 `closed(revoked-before-effect)`로 닫고 invoke를 하지 않는다. 효과가 시작됐을 수 있으면 취소 성공을 거짓으로 보고하지 않고 `unknown`으로 둔다. |

상태는 한쪽 방향으로만 바뀐다(schema `$defs.reservationTransitions`): `pending→bound|closed|unknown`, `bound→admitted|closed|unknown`, `admitted→closed|unknown`, `unknown→closed`(대조를 마친 뒤 `reconciled-unknown`만 가능). reservation 인스턴스 하나로는 이전 상태를 알 수 없으므로, 이 `closeReason` 제한과 전이 순서는 R19 Port가 강제한다. `closed`에서는 더 이동하지 않는다. crash나 응답 유실로 효과가 시작됐는지 알 수 없으면 `unknown`을 유지한다. `unknown`은 성공으로도 취소로도 바꾸지 않고, 그 slot을 새로 발급하지 않는다.

## 모든 source에서 권한이 되지 않는 입력

| 입력 | 거부 지점 | `denyReason` |
|---|---|---|
| 승인 기록 없는 caller JSON, MCP 인자, workspace 파일, caller가 보낸 `approved=true`·slot 본문·digest | 어떤 Port도 snapshot을 입력으로 받지 않고, 서버가 직접 읽은 것만 쓴다. `inputProvenance`는 스스로 선언하는 값이므로 schema 적합만으로 출처가 증명되지 않는다. R19는 올바른 const 값을 갖춘 caller 제공 snapshot도 거부하는 반증 테스트를 둔다. VM은 서명된 단회 registry(`vm-approved-slot-source.ts:102-126`)만 받는다. | `caller-supplied-source` |
| 현재 snapshot에 없는 임의 slot | `beginEffect`가 slot 소속을 확인한다. VM reader는 `approved-slot-reader.ts:62-71`에서 막는다. | `unknown-slot` |
| stale revision(재승인, Plan 교체, 참여 변경, 이전 snapshot) | `currentness.state=current`여야 하고, admit·효과 시점에 다시 비교한다. VM은 `vm-approved-slot-source.ts:119,146-149`에서 막는다. | `stale-revision` |
| revoked revision | snapshot은 `not-revoked`만 허용하고, 효과 시점에 다시 확인한다. | `revoked` |
| `admitted`가 아닌 reservation, 검증되지 않은 신원 | `beginEffect` | `reservation-not-admitted`, `identity-unverified` |
| 같은 사용자 A2 서명(`flowmarshal-same-user-v1`) | `principalClaim`에서 A2와 `ags-local-server`는 `protectedPrincipal=false`로 고정된다. VM producer의 principal은 `vm-protected-v1`만 허용한다. | `same-user-not-protected` |
| UNQUALIFIED_PENDING 행에 기댄 source | 대응표의 `usableAs=[]` | `source-unqualified` |

A2 서명은 선택한 FM producer가 그 내용을 냈다는 same-user 주장이다(`flowmarshal-same-user-profile.ko.md`). 이를 보호 principal·독립 actor·VM 승인 증거로 승격하지 않는다.

## AGS 최소 producer 계약 (R18/R19에서 구현)

- R18은 AGS 서버가 소유한 저장소에 역할 승인 기록을 남긴다. 기록 키는 workflow `runId`, `taskId`, stage/assignment, 승인 revision, 승인 digest다. 승인 입력은 사용자 승인 이벤트가 서버에 기록된 뒤에만 받는다. caller JSON, 모델 자기 보고, `needs-approval` 상태, `userApprovalRefs` 문자열만으로는 기록을 만들지 않는다.
- 조회는 `readCurrentApprovedRoleSource`이며, 같은 transaction에서 승인·철회·source revision·slot 목록을 읽는다. `producer.owner=ags-workflow`, `producerTask=R18`, `verification=ags-server-store-same-transaction-read`, `principal.profileId=ags-local-server`(`protectedPrincipal=false`)다.
- R19는 reservation, bind, admit, `beginEffect`, 철회 경합을 구현한다. 위 상태 전이, 효과 시점 재검사, 효과 전 철회 시 `invokeCount=0`, unknown 보존이 R19의 반증 테스트 대상이다.
- R15의 `projectApprovedRoleSlotsV1`는 순수 projection이며 `executionAuthorized=false`다. R18은 이것을 호출할 수 있지만 projection digest를 승인 진위의 근거로 쓰지 않는다.

## 상태·reservation·unknown 대응표

`구현`은 계약 행의 구현 상태이며, runtime 자격은 모든 행에서 주장하지 않는다.

| 행 | 자격 | 통합 SHA | 구현 | 제공 상태 | reservation 보장 | unknown 보장 | enforcement 지점 |
|---|---|---|---|---|---|---|---|
| `ags-r18-producer` (R18) | QUALIFIED | — | NOT_IMPLEMENTED | current/not-revoked snapshot, source revision | 없음(R19 소유) | 없음(R19 소유) | R18 `mcp-server/src/orchestration/ags-approved-role-source.ts`(예정) |
| `ags-r19-effect-gate` (R19) | QUALIFIED | — | NOT_IMPLEMENTED | pending/bound/admitted/closed/unknown | 효과 시점 같은 transaction 재검사, 철회 선행이면 invoke 0 | crash·응답 유실은 unknown 유지, 거짓 취소 금지 | R19 `mcp-server/src/orchestration/ags-approved-effect-gate.ts`(예정) |
| `vm-r16a-contract` (R16-a) | QUALIFIED | AGS `9e0bfced0577edfdd65e9c59f16393b9825000b5` | IMPLEMENTED_INTEGRATED | 계약 문서 | 없음 | 없음 | `docs/implementation-3x/approved-role-slot-source.ko.md` |
| `vm-r16b-ledger-port` (R16-b) | QUALIFIED | FM main `9d697ea4eb7b359c586da3953ddd7f54617a720f` | IMPLEMENTED_INTEGRATED | active Plan·activation·최신 GoalAuthorization·철회·참여 watermark의 current read | 없음 | 없음 | FM `src/flowmarshal/engine/service.py` `read_current_approved_role_slot_source`, `revoke_approved_role_slots` |
| `vm-r16c-signed-producer` (R16-c) | QUALIFIED | FM main `e7721cbb7e370b77d200b000a1a6c4c87d72b020` | IMPLEMENTED_INTEGRATED | 서명된 snapshot(`ags-vm-approved-slot-source-v1`) | 없음 | 없음 | FM `src/flowmarshal/engine/ags_approved_slot_producer.py` |
| `vm-r16e-receiver` (R16-e) | QUALIFIED | AGS `8532544cc44449fc54cd6f928811791be9c5c87f` | IMPLEMENTED_INTEGRATED | 서명·epoch·nonce·invocation 결속 단회 pending | 단회 소비만 보장, 효과 reservation은 아님 | 없음 | `mcp-server/src/host-integration/vm-approved-slot-source.ts:102-149`, `server.ts:473` |
| `vm-r16-reader` (R16) | QUALIFIED | AGS `0f22be626a6d1a0f9e48af480c56dc37c3e1b3fc` | IMPLEMENTED_INTEGRATED | R15 RoleSlot 투영, `executionAuthorized=false` | 없음 | 없음 | `mcp-server/src/orchestration/approved-slot-reader.ts:51-71` |
| `vm-r16d-dispatch-claim` (R16-d) | **UNQUALIFIED_PENDING** | — | BLOCKED | 미확정 | 미확정 | 미확정 | 미확정 |
| `vm-r16f-revocation-race` (R16-f) | **UNQUALIFIED_PENDING** | — | BLOCKED | 미확정 | 미확정 | 미확정 | 미확정 |
| `vm-r16g` (R16-g) | **UNQUALIFIED_PENDING** | — | NOT_STARTED | 미확정 | 미확정 | 미확정 | 미확정 |
| `vm-r16f-leaves` (R16-f-contract, R16-f-a/b/c) | **UNQUALIFIED_PENDING** | — | NOT_STARTED | 미확정 | 미확정 | 미확정 | 미확정 |

자격을 갖춘 VM 행들은 **조회와 단회 소비까지만** 보장한다. VM 경로의 reservation·효과 시점 CAS·unknown 보장은 모두 PENDING 행(R16-d/R16-f 계열)에 있으므로, 이 계약은 VM approved-slot 효과 시작을 **해제하지 않는다**. `UNQUALIFIED_PENDING` 행은 수용 source, dependency·evidence 충족, VM 실행 해제의 근거로 쓰지 않는다(`usableAs=[]`). 미통합 후보 브랜치(`codex/v3x-r16-approved-slots`, R_VM worktree)의 내용은 이 계약의 입력이 아니다. FM main `fed976f4b100a13920c5e8e1f5e533ac41116a77`의 `src/flowmarshal/engine/governance_gate.py:910-916`에 따르면 approved slot의 `vm-protected-v1` signer 검증은 아직 후속 과제이고 A2 producer는 거부된다. VM 응답을 이 공통 snapshot 모양으로 바꾸는 adapter의 소유 Task도 아직 정해지지 않았다. 둘 다 이 계약의 runtime 자격 밖이다.

## 재검증

R16-d 또는 R16-f가 FM main에 통합되고 Progress가 COMPLETED가 되면, 해당 행의 호환성을 다시 검증해야 한다. 이 항목은 `PLAN_CHANGESET.json`의 `open_plan_items`에 `R17-R16-REVALIDATION`(O09-b 착수 전 부총괄 확인)으로 이미 올라가 있다. 그 전까지 이 문서의 PENDING 행은 바뀌지 않는다.

## 산출 판정과 Progress

| 판정 | 조건 | Progress |
|---|---|---|
| `APPROVED_ROLE_SOURCE_PORT_FROZEN` | 계약이 QUALIFIED와 UNQUALIFIED_PENDING을 표현하고, 어떤 미해결 행도 승인·동결된 runtime 증거로 기술하지 않음 | COMPLETED 요청 가능 |
| `CONTRACT_FAILED` | 위 조건 불충족 | BLOCKED로 보고 |
| `NOT_RUN` | 검사 미실행 | 미실행으로 보고 |

`R17.test.mjs`는 schema가 위 거부 조건과 상태 전이를 표현하는지, 대응표가 이 문서와 일치하는지, row ID가 겹치지 않는지를 검사한다. 이는 계약 fixture PASS이며 AGS/VM 원장, runtime, 운영 설치, live host의 PASS가 아니다.
