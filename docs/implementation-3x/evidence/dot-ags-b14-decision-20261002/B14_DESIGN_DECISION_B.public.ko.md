# Executive Verdict

**사용자 지정 총괄은 B를 AGS Windows issuer의 개발 설계 방향으로 결정했다.** 이는 사용자가 토론 후 설계 선택을 총괄에게 위임한 데 따른 총괄의 결정이다. 사용자가 직접 “B 승인”이라고 말했다는 기록, 패널 합의, native PASS 또는 source·운영·설치 GO를 뜻하지 않는다.

이 결정문은 이전 `B14_FRESH_DECISION_PACKET.public.ko.md`의 **당시 미결정 상태를 설계 선택에 한해 대체**한다. 이전 snapshot과 그 PROVISIONAL/no_consensus 판정은 보존한다. 설계 선택으로 공식 Task/spec/AREA, 현재 실행 계약 또는 자격 상태가 자동 변경되지 않는다.

# Consensus Proposal

이 절의 내용은 새 패널 합의안이 아니라 **총괄이 선택한 B 설계 방향**이다.

B가 요구하는 보장은 보호 설치 기록의 기대 issuer SID를 명시한 고정 `ncalrpc`/`WINNT` 인증 fast-binding을 완료하고, **그 동일 binding/IfSpec에서 응용 요청·응답을 수행**하는 것이다. expected SID는 caller 입력이나 응답의 자기 보고에서 받지 않는다. 설정 readback이나 binding 구조 생성만으로 인증 완료를 인정하지 않는다.

B는 A의 같은 연결에서 OS가 보고한 actual responder canonical SID, held process의 creationTime 및 응답 전후 생존을 직접 관측하는 보장과 다르다. B의 expected SID 입력을 실제 TokenUser/PID 관측 또는 binary/현재 instance 증명으로 표현하지 않는다. 정확한 native 계정·group matching은 아직 수용 전제다.

# Strong Consensus

아래는 기존 증거로 확인한 유지 요구다. 이번에 새 합의를 실행했다는 뜻이 아니다.

- 보호 주체는 worker/caller와 구분되는 실효 OS principal이어야 하며 primary TokenUser, group, privilege, integrity를 실제 측정한다.
- 보호 설치 기록·서비스 정의·실행물과 loader closure, 부모/열린 handle identity 및 시작·읽기·요청 처리 전후의 실제 주체 관측을 유지한다.
- worker/caller와 자손의 보호 process 제어·memory/handle 복제, 비밀·state·실행물·기록 변조를 실효 접근 시도로 거부한다.
- 공통 authority가 provisioning revision, 실제 runtime instance, current ACTIVE/epoch/revision, expiry/audience/철회와 소비점 인가를 결속한다. caller가 보낸 instance 문자열만으로 현재성을 인정하지 않는다.
- server의 current-call query→TokenUser→checked revert, 하나의 공통 admission과 first-seen 의미를 유지한다. valid first-seen의 공통 인가 거절은 requestId를 소비할 수 있으며, 모든 deny를 모든 상태0 또는 영속 exactly-once로 확대하지 않는다.

# Material Disagreements

총괄의 선택 근거는 위협별 보장 매핑이다. A도 정상 SID·살아 있는 process가 허용 binary인지 또는 최신 등록 instance인지를 스스로 증명하지 못한다. B를 인증 transport로 선택하되 이 공통 공백은 보호 provisioning·실행물 관측·권위 있는 current state로 닫는다. 이는 문서와 정적 source에 따른 **설계 추론**이며 B의 native 충분성을 실측으로 입증했다는 주장이 아니다.

| 반례 | 유지할 방어와 반증 |
| --- | --- |
| worker의 endpoint 선점 / 다른 SID | 명시 인증 완료 전 응용 Handle/core 호출0. endpoint 이름·ACL·설정값만으로 server 인증을 주장하지 않음 |
| 같은 SID의 wrong binary | A/B의 정상 SID만으로 통과시키지 않음. worker의 보호 계정 실행·process 제어 거부 및 보호된 허용 build/loader closure와 실제 provisioning 확인 |
| 같은 SID의 old/new instance 중첩 | 살아 있음만으로 최신 소유권을 인정하지 않음. 공통 권위의 current revision/epoch/instance 결속과 obsolete instance fencing |
| TokenUser가 다르고 expected SID가 group에만 있음 | B가 이를 exclusive issuer account로 수용하면 반증. 실제 OS token oracle로 구분하고 자기 보고 SID로 대체하지 않음 |
| endpoint 교체·restart·PID 재사용 | 완료한 fast-binding의 동일 연결을 유지하고 drop 뒤 새 연결의 응답을 원 요청의 성공으로 채택하지 않음. PID lookup으로 B의 미관측을 보완했다고 하지 않음 |

보호 계정 자체가 장악되면 B가 자동 방어한다고 주장하지 않는다. A의 SID·생존 관측도 그 악성 실행물을 구분하지 못한다. worker가 그 능력을 얻지 못한다는 실효 거부 증거와 허용 binary/현재 instance 검사를 면제하지 않는다.

# Decision by Axis

| 축 | 이번 결정 / 그대로 남는 조건 |
| --- | --- |
| Contract | client의 actual-responder 관측 계약을 authenticated-target 계약으로 명시 변경하는 정식 후보 준비. A와 B를 동등 보장으로 선언하지 않음 |
| Identity | B를 개발 방향으로 선택. fixed native config·실제 bind/call·account-versus-group SID matching은 qualification 조건 |
| Provisioning | 보호 설치·실효 token·코드 closure·처리 전후 identity 관측 유지. B로 이 요구를 제거하지 않음 |
| Lifecycle | 공통 current revision/instance/철회·소비점 인가·경합 선형화 및 UNKNOWN 재관측 유지 |
| Qualification | 실제 producer, 최종 package closure, 승인된 보호 설치와 같은 최종 후보의 Windows qualification 및 별도 final 독립 audit 필요 |

# Evidence

설계 판단의 source 기준은 `a7c049d5de392651b102840cb7e75243e1afe317`이다. 다음 네 파일의 작업 트리 원 bytes와 해당 commit blob bytes의 일치를 읽기 전용으로 확인했다. 이는 문서/정적 source 확인이며 제품 실행 증거가 아니다.

| claim | 고정 source / 확인 범위 |
| --- | --- |
| worker threat model | [사용자 승인 출처 계약](https://github.com/jaeseongs95/agent-governance-suite/blob/a7c049d5de392651b102840cb7e75243e1afe317/docs/implementation-3x/user-approval-channel.ko.md#L5): 같은 사용자 process가 파일·키를 읽고 실행할 수 있다는 가정, PID/이름/조상은 승인 출처가 아님 |
| protected authority | [보호 provisioning 계약](https://github.com/jaeseongs95/agent-governance-suite/blob/a7c049d5de392651b102840cb7e75243e1afe317/docs/implementation-3x/ags-protected-provisioning.ko.md#L44): P3.2·P4.1–4.5·P5.1–5.4·P6.3–6.5의 기록·token·실효 거부·closure·전후 관측 |
| schema만으로 관측 대체 불가 | [설치 기록 schema](https://github.com/jaeseongs95/agent-governance-suite/blob/a7c049d5de392651b102840cb7e75243e1afe317/runtime/issuer/windows/contract/install-record.schema.json#L5): schema 적합이 ACL/token/hash 관측을 대체하지 않음 |
| 현재 client는 A contract | [Windows client](https://github.com/jaeseongs95/agent-governance-suite/blob/a7c049d5de392651b102840cb7e75243e1afe317/mcp-server/src/session-principal-windows.ts#L38): 같은 연결의 실제 server SID를 요구하며 production transport 부재는 UNAVAILABLE. B를 현재 구현된 기능으로 보고하지 않음 |

Microsoft는 SID가 인증 target principal 입력의 대안이라고 설명하지만, generic mutual-auth flag만으로 SSP의 실제 보장을 추정하지 말라는 경고도 둔다. account/group 구별의 native qualification을 남긴다. [RPC_SECURITY_QOS_V3_W](https://learn.microsoft.com/en-us/windows/win32/api/rpcdce/ns-rpcdce-rpc_security_qos_v3_w).

fast-binding은 IfSpec에 결속되고 연결 단절 뒤 투명 재연결하지 않는다. bind 완료 전 free/reset/auth 설정 변경도 금지된다. [RpcBindingBind](https://learn.microsoft.com/en-us/windows/win32/api/rpcasync/nf-rpcasync-rpcbindingbind). `Security=NULL`인 ncalrpc 기본값은 server를 인증하지 않는다. [RPC_BINDING_HANDLE_SECURITY_V1_W](https://learn.microsoft.com/en-us/windows/win32/api/rpcdce/ns-rpcdce-rpc_binding_handle_security_v1_w).

결정 provenance: 사용자가 토론 후 선택을 총괄에게 위임했고, 총괄이 기존 검증 패널 자료와 후속 source 기반 권고를 소비해 B 개발 방향을 선택했다고 전달했다. 이 문서는 그 결정 통보를 기록한다. 원 대화·native 메시지·개인 식별자·private 원장은 공개하지 않는다.

# Required Actions

기존 단독 metadata writer가 Task/spec/AREA 정식화 후보를 준비하고 해당 독립 검토·별도 정확한 권한 절차를 지킨다. 기존 source writer와 publisher의 소유권을 유지한다. 아래 W1–W8은 향후 적법하게 승인된 Windows 실측의 필수 조건이며 이번 작업에서는 **NOT_RUN**이다.

| ID | 구체 반증 / oracle | 실패·미관측 시 조건 |
| --- | --- | --- |
| W1 | final native config→bind 완료→동일 binding/IfSpec 실제 call/reply positive. Security=NULL/Authn NONE/downgrade/wrong SID/endpoint squatter negative에서 응용 Handle/core invocation0. handshake bytes0이라고 하지 않음 | 설정 readback만의 성공, identity 실패 뒤 응용 실행, 우회 fallback이면 중단 |
| W2 | installed issuer primary TokenUser 일치 positive와 TokenUser≠expected SID이면서 group에만 expected SID가 있는 적법한 native negative를 실제 OS token oracle로 구분 | group-only를 exclusive issuer로 수용하면 B 부적격. fixture 실측 불가는 NOT_RUN/BLOCKED 유지 |
| W3 | worker/caller·자손 실제 token으로 보호 계정 실행·memory/control/dup handle·secret/state/record/service/binary/parent/reparse 변경 거부. 같은 설치의 SCM 정의·허용 build/loader closure 측정 | 다른 SID 이름·ACL 열거·자기 보고만, 변경 가능한 module/서비스이면 실패 |
| W4 | 승인된 same-SID wrong-binary/unprovisioned-instance fixture, binary/closure mismatch, query 실패, 시작/읽기/처리 전후 identity 변화를 주입. 정상 SID 인증만으로 허용 credential/등록/권한 효과를 내지 않음 | 살아 있는 같은 SID라는 이유로 성공, protected current state를 fixture 자기 보고로 대체하면 중단 |
| W5 | bind 뒤 restart/drop/endpoint 교체, 같은 SID old/new instance 중첩, provisioning revision 교체. obsolete instance를 fence하고 current valid instance만 소비 가능 | old instance/current revision 불명 credential이 소비 가능하면 실패. caller instance echo·PID lookup으로 미관측을 대체하지 않음 |
| W6 | issue/revoke/use race를 공통 authority의 허용/소비 선형화점으로 검사. late E1 correlated reply와 E2 이후 사용 권한 구분. expired/cross audience/revoked/unknown currentness 거절 | 응답 correlation을 소비 인가로 취급하거나 UNKNOWN을 재발급/자동 retry/환불로 안전하다고 하면 중단 |
| W7 | bind/call timeout/cancel/exception/malformed reply와 cleanup 순서. native query/impersonate/TokenUser/checked revert 실패 Handle0. valid first-seen 공통 deny의 ID 소비 유지. duplicate-ID concurrency 및 응답 유실 재관측 | bind 완료 전 free, revert 실패 뒤 core 도달, 모든 deny state0, native 취소=외부 효과0 추정이면 실패 |
| W8 | actual RPC stub/NDR/SEH/할당 상한·승인 toolchain, final source/build/package closure/no-node_modules, 실제 공급→최종 pull/closure→승인된 보호 설치→같은 candidate의 token/endpoint/P7I5/private consumer qualification→별도 final audit | Cloud 정적 결과·과거 probe·다른 bytes로 Windows PASS, 초기 unqualified producer 공급으로 전체 수용을 주장하면 중단 |

SCM·계정·ACL·key·보호 설치/되돌리기·compiler 설치나 toolchain 변경은 구체 후보와 별도 권한에 따른다. 이번 설계 결정이 이러한 행위, source 구현 GO, metadata APPLY 또는 release를 허가하지 않는다.

# Optional Optimizations

PID/lifetime diagnostic을 얻을 수 있으면 보조 관측으로 남길 수 있다. 이는 B의 필수 관측이 이미 충족됐다는 뜻이 아니며 미관측을 성공으로 처리하지 않는다. client epoch cache ordering은 소비 authority 검증을 대체하지 않는다. 이번 결정으로 벤더별 policy 복제·독자 Windows registry·새 durable global lock을 요구하지 않는다.

# Unresolved

W1–W8, native SID matching, 공통 current-state/producer, ABI/toolchain, 보호 설치와 같은 후보 qualification 및 final audit는 미완료다. 보호 provisioning P6.4의 실제 주체·처리 전후 관측을 유지하는 구현/측정 방법이 성립하지 않으면 B도 BLOCKED다.

필수 반증이 B를 부정하거나 필수 값이 관측되지 않으면 qualification·효과 허용을 보류한다. UNKNOWN을 성공한 취소 또는 안전한 재실행으로 바꾸지 않는다. B만의 결함이면 개발 방향을 재검토하고 마지막 정식 승인 계약의 BLOCKED 경계를 유지한다. 정식 전환 전 이 기준은 A이며, 정식 전환 뒤에도 마지막 승인 revision을 권한 우회나 강제 reset 없이 유지한다. 미구현 A를 자동으로 안전하거나 실행 가능하다고 인정하지 않는다. 양쪽 공통 provisioning/currentness 결함이면 양쪽을 중단한다.

# Method / Run Summary

기존 fresh panel은 blind reviewer4와 별도 fresh Judge1을 완료했다. 요청·spawn 선택은 `gpt-6.1-sol/high`, effective model/effort는 `NOT_OBSERVABLE`, 실제 모델 하한은 `NOT_ESTABLISHED`이며 판정의 `PROVISIONAL/no_consensus` 한계는 유지한다. 생성 인자 준수와 provider 실효 설정 관측을 구별한다. 이번 총괄 결정은 이 판정을 새 consensus/native PASS/final audit로 승격하지 않는다.

이번 문서 작성에서 새 패널·specialist·Judge·재숙고를 시작하지 않았다. 이전 후속 작업에서 절차 확인 전 시작했다 중단한 specialist는 완료·증거 채택으로 계산하지 않는다. 새 결정문은 기존 정제 증거와 source 기반 설계 권고를 소비한 총괄 결정의 기록이다. 이전 보고서·dossier·공개 snapshot은 변경하지 않았다. 제품/source/metadata 변경·새 GO·Windows 실행/설치·push·Library upload는 이번 작업에서 모두0이다.
