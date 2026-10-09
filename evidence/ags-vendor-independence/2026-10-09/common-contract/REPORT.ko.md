# AGS 벤더 독립: 공통 계약·어댑터 경계 조사 및 설계

작성 시각: 2026-10-09T07:20:33.759482Z. 담당: common-contract. 결과 수준: **SOURCE 조사와 설계**.

이 보고서는 context-continuity, orchestrator와 session 인계 주변 공통 계약에 한정한다. 전체 스킬 목록 감사는 다른 담당 범위다. 제품 코드·생성 배포물·설정·인증을 수정하지 않았고 실제 모델 호출, 설치·실호스트 가동·compaction·유료 평가를 하지 않았다. 유일한 벤더 전용 예외인 codex-token-usage-analyzer는 이번 변경 제안에서 제외한다.

## 조사 기준과 한계

| 구분 | 실제 상태 |
|---|---|
| 실제 checkout | `work`, `56fef8bd189377b80f4020f506e717ab292b260a` |
| checkout tree | `77a36bd8c2f2b6a4fcfc3abb292444bde5e92e0d` |
| 원격 main 조회 | 같은 SHA, 처음 checkout clean |
| 추가 원격 스냅샷 | `codex/skill-classification-2.9.1`, `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6` |
| 추가 스냅샷 tree | `28f2f2ed8a864405320f6d20e7bc5004e8466ad3` |
| 추가 자료 읽기 | `git show`로 고정 commit의 관련 계약·orchestrator·provider adapter만 SOURCE 검사; checkout 전환 없음 |
| 보고된 R17 | `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb`, tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`, parent `61a6f15fcb09d2082f32ab09e82a6247e3449d49` |
| R17 조사 상태 | 로컬 고정 후보라는 전달 정보만 받음. 실제 파일을 읽지 않았고 원격 게시·독립 SOURCE 감사도 확인하지 않음 |
| 실호스트 검증 | **NOT_RUN**. SOURCE 확인을 설치·호스트 실행 완료로 표현하지 않음 |

먼저 [AGENTS.md](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/AGENTS.md#L24-L24)를 읽었다. 공통 스킬·계약·MCP·런타임은 제품 API를 전제로 하지 않고 얇은 adapter/overlay로 호스트 지원을 확장하라는 저장소 원칙을 기준으로 삼았다. 관련 저장소 SKILL.md와 entry/reference 자료를 읽었으며, 게시 범위에는 change-scope-guardian 및 mutation-risk-preflight의 읽기 전용 범위·권한 검증을 적용한다. evidence 브랜치에 AGENTS.md가 없으므로 원본 저장소 지침과 명시된 evidence 게시 지시를 따른다.

`session-handoff/SKILL.md`는 고정 main과 추가 원격 스냅샷의 `skills/`, `.agents/skills` tree에 없었다. 독립 스킬이 존재한다고 가정하지 않았다. 기존 session-board 메시지, coordinator brief, continuity snapshot과 RecoveryHandoff는 역할이 서로 달라 이를 한 종류로 취급하지 않는다. R17에 새 인계 계약이 포함됐을 가능성은 후속 확인 항목이다.

## 핵심 판단

공통 TaskEnvelope, ProviderResult, InputSourceReceipt와 execution observation port는 이미 상당 부분 중립적이다. 특히 출처 관측과 권한을 분리하고 ACK를 승인·완료로 해석하지 않는 현재 규칙은 유지해야 한다. 남은 작업은 공통 스킬의 특정 제품 문구 제거, continuity raw 훅 경계 분리, adapter 구성 확장, 불확실성의 일관된 구조화, 책임 수락의 명시 계약이다. 특정 CLI가 **adapter 구현 안에 있는 것**과 이를 **공통 계약의 필수 인터페이스로 요구하는 것**은 구별했다.

### CC01 · P2 · 공통 continuity 문서에 Codex 이름 잔존

근거: [skills/context-continuity/references/entry-details.md:11-19](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/skills/context-continuity/references/entry-details.md#L11-L19).

판단: L19는 공통 실패 정책을 Codex compaction으로 표현한다. 스킬 본문은 목적과 snapshot을 중립적으로 설명한다.

제안: 작업과 호스트의 context 축약을 막지 않는다고 공통 표현을 쓰고 호스트별 compact 이벤트 지원은 adapter 문서로 이동한다.

검증 조건:

- 공통 context-continuity 본문·참고 자료에 특정 제품명 필수 행동이 없다
- continuity 저장 실패 시 기본 작업은 진행하며 저장/복원 성공은 주장하지 않는다

### CC02 · P1 · Continuity lifecycle이 raw 호스트 훅 형식에 결합

근거: [mcp-server/src/continuity-hook.ts:34-86](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/mcp-server/src/continuity-hook.ts#L34-L86), [contracts/checkpoint-context-request.v1.schema.json:7-15](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/contracts/checkpoint-context-request.v1.schema.json#L7-L15), [skills/context-continuity/references/entry-details.md:11-15](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/skills/context-continuity/references/entry-details.md#L11-L15).

판단: 공유 continuity-hook은 hook_event_name/session_id와 SessionStart·PreCompact·PostCompact·PreToolUse 및 hookSpecificOutput/updatedInput 형식을 직접 요구한다. 공통 snapshot 저장 계약은 중립적이지만 이를 호출하는 정상 binding 경로는 이 훅 관습에 의존한다.

제안: 공통 ContinuityLifecyclePort에 start/resume/clear/before-context-reduction/after-context-reduction/tool-call 의미 이벤트를 전달한다. raw 필드·이벤트·출력 직렬화와 tool prefix는 host adapter가 번역한다. binding 발급·digest·revision 검사는 공유 서비스에 유지한다.

검증 조건:

- 서로 다른 두 raw 이벤트 형식이 같은 normalized 이벤트와 digest 의미를 만든다
- PreToolUse 없는 호스트의 host-owned wrapper도 동일 binding 검사 경로를 사용한다
- 훅과 wrapper가 모두 없는 호스트는 BINDING_REQUIRED이며 caller가 binding을 만들지 못한다
- adapter는 원래 호스트 권한 결정을 덮어써 작업 승인으로 바꾸지 않는다

한계: 실제 훅 가동·설치 캐시·compaction은 실행하지 않았다

### CC03 · P1 · 공유 continuity DB의 session namespace 조건

근거: [mcp-server/src/continuity-service.ts:162-179](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/mcp-server/src/continuity-service.ts#L162-L179), [mcp-server/src/runtime-config.ts:116-124](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/mcp-server/src/runtime-config.ts#L116-L124), [contracts/types.ts:297-314](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/contracts/types.ts#L297-L314).

판단: 현재 continuity correlation은 같은 signing store에서 rawSessionId만 HMAC 입력으로 사용한다. 두 호스트가 같은 DB와 같은 raw ID를 쓰면 같은 taskCorrelation이다. 현재 별도 호스트 DB 기본 배치에서 실제 충돌했다고 주장하지 않는다.

제안: 향후 공용 DB나 다중 호스트 사용 전 (hostId, installation/harness namespace, sessionId, agent scope)를 길이 안전 canonical tuple로 결속한다. 기존 snapshot 키는 묵시 재매핑하지 않고 migration 또는 명시 legacy namespace 정책을 둔다.

검증 조건:

- 동일 raw session ID의 서로 다른 host/namespace가 다른 taskCorrelation을 만든다
- 동일 host/namespace/session 재개는 안정된 correlation을 유지한다
- 기존 별도 DB·직접 snapshot·workflow projection의 revision/digest를 보존한다

한계: 조건부 소스 추론이며 실제 교차 호스트 충돌 재현은 하지 않았다

### CC04 · P1 · 실행 관측 port는 중립적이지만 기본 구성은 두 호스트에 고정

근거: [mcp-server/src/host-attestation.ts:16-35](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/mcp-server/src/host-attestation.ts#L16-L35), [mcp-server/src/runtime-config.ts:187-196](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/mcp-server/src/runtime-config.ts#L187-L196), [mcp-server/src/index.ts:48-61](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/mcp-server/src/index.ts#L48-L61), [skills/orchestrator/references/entry-details.md:34-35](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/skills/orchestrator/references/entry-details.md#L34-L35), [skills/orchestrator/references/entry-details.md:49-56](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/skills/orchestrator/references/entry-details.md#L49-L56).

판단: HostExecutionAdapter.host는 string이고 모델 매핑도 adapter 소유다. 그러나 resolveHostAttestation과 entry composition은 codex/claude-code만 받는다. 새 호스트는 port 구현뿐 아니라 공통 composition 변경도 필요하다. 미지원 시 null과 BINDING_REQUIRED를 유지하는 동작은 정직하다.

제안: trusted installation이 host adapter registry/factory를 주입하도록 composition 경계를 만든다. arbitrary request·문서가 adapter를 등록하거나 신뢰도를 승격할 수 없다. guard binding·만료·한 번 소비는 하나의 공통 검증기로 유지한다.

검증 조건:

- 가상의 세 번째 host adapter를 core 계약 복제 없이 구성할 수 있다
- 미등록/미관측 host는 semantic guarded workflow/stage를 통과하지 못한다
- caller executionContext·모델명 추정·다른 worker 관측으로 하한을 채우지 못한다
- 유효한 observation도 OS 격리나 인간 승인을 증명하지 않는다

### CC05 · P2 · Orchestrator registry 조회의 상대 CLI·경로 전제

근거: [skills/orchestrator/references/entry-details.md:19-23](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/skills/orchestrator/references/entry-details.md#L19-L23), [skills/orchestrator/references/mcp-execution.md:17-20](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/skills/orchestrator/references/mcp-execution.md#L17-L20).

판단: node scripts/query-registry.mjs는 문서의 상대 명령이다. 호출 cwd와 Node/shell이 제공돼야 실행된다. 이는 AGS 런타임 의존성이지 Node 자체가 AI 벤더 종속이라는 뜻은 아니다. outputFile의 절대 경로 역시 로컬 구현 포트이며 모든 원격 호스트의 공통 artifact locator로 강제하면 접근할 수 없다.

제안: 공통 계약은 RegistryQuery(capabilityIds)와 ArtifactRef(locator,digest,targetDigest)를 요구한다. adapter가 설치 root/module-relative CLI 또는 같은 의미 MCP를 해석한다. 로컬 파일 읽기 포트와 원격 참조 materialization을 구별하며 검증되지 않은 ref는 다음 stage로 넘기지 않는다.

검증 조건:

- 다른 cwd·공백 경로·설치 tree에서도 registry 조회가 같은 결과를 만든다
- shell/Node/MCP 미지원은 필요한 기능만 unavailable로 보고한다
- artifact byte 접근·digest 검사가 불가능하면 verified=true를 쓰지 않는다

### CC06 · P1 · session-handoff와 책임 수락을 별도 공통 계약으로 정의할 필요

근거: [skills/session-board/references/entry-details.md:14-18](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/skills/session-board/references/entry-details.md#L14-L18), [skills/orchestrator/references/input-origin.md:11-13](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/skills/orchestrator/references/input-origin.md#L11-L13), [skills/coordinate-subagents/references/entry-details.md:45-60](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/skills/coordinate-subagents/references/entry-details.md#L45-L60), [contracts/types.ts:327-350](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/contracts/types.ts#L327-L350).

판단: 고정 main과 관측한 2.9.1 candidate의 skills 및 .agents/skills tree에 session-handoff/SKILL.md는 없다. 기존 brief·session-message·checkpoint·RecoveryHandoff는 각각 다른 목적이다. ACK는 처리 확인이며 책임 수락 schema/state machine이 아니다.

제안: SessionHandoff와 ResponsibilityAcceptance 초안을 신규 공통 계약으로 검토한다. offerDigest/taskDigest/candidateDigest·정확한 수신자·한 writer 소유권·권한 참조·의무·검증 기준을 묶고 recipient가 원자료 접근과 실행 능력을 확인한 뒤 accepted/rejected/needs-input을 명시한다. accepted도 권한 확대·업무 완료가 아니다.

검증 조건:

- prepare/send/delivered/ACK만으로 responsibility=accepted가 되지 않는다
- 다른 offer/task/candidate digest·다른 recipient·만료·변경된 ownership의 수락은 거절한다
- 재전송은 동일 offerId/operationId를 유지하고 중복 writer를 만들지 않는다
- 수락 지원이 없으면 unconfirmed를 기록하고 조정자가 책임을 유지한다

한계: R17 로컬 후보와 전체 모든 원격 브랜치의 스킬 목록은 감사하지 않았다

### CC07 · P1 · 미지원·미가용·관측 불명과 side effect를 구조화

근거: [contracts/api-result.v1.schema.json:7-22](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/contracts/api-result.v1.schema.json#L7-L22), [contracts/provider-result.v1.schema.json:7-13](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/contracts/provider-result.v1.schema.json#L7-L13), [mcp-server/src/session-message-service.ts:68-78](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/mcp-server/src/session-message-service.ts#L68-L78), [contracts/session-auto-wake-outlook.v1.schema.json:8-12](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/contracts/session-auto-wake-outlook.v1.schema.json#L8-L12), [mcp-server/src/skill-classification/providers.ts:4-11](https://github.com/jaeseongs95/agent-governance-suite/blob/c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6/mcp-server/src/skill-classification/providers.ts#L4-L11), [mcp-server/src/skill-classification/providers.ts:88-99](https://github.com/jaeseongs95/agent-governance-suite/blob/c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6/mcp-server/src/skill-classification/providers.ts#L88-L99).

판단: API/Provider 공통 오류 code는 고정 enum이고 details는 자유 object다. session-message는 확정 capacity 거절과 불명 전송을 같은 MCP_UNAVAILABLE 내 문구로 구분한다. candidate 분류에서는 dispatchState와 unknown usage가 이미 분리돼 있다. 모든 공통 경계에서 동일한 불확실성 의미를 갖는 구조는 아직 없다.

제안: 기존 v1 code를 임의 확장하지 않는다. 버전 있는 ErrorObservation/CapabilityAssessment 계약으로 category(unsupported/unavailable/unobserved/invalid/denied/conflict), dispatchState(not-started/started/unknown), sideEffectObservation(none/possible/confirmed/unknown), affectedCapability, evidence refs와 retry rule을 구조화하고 호스트 raw error는 adapter 안에서 정제한다.

검증 조건:

- unsupported와 temporary unavailable를 구분한다
- timeout/응답 유실은 완료·무실행·무료로 환산되지 않는다
- side effect 불명에는 기존 operation/message ID 조회·대조가 우선이며 새 의도 재생성을 하지 않는다
- 비밀/본문/raw stderr를 공통 오류 details나 로그로 내보내지 않는다

### CC08 · P2 · 공통 결과 envelope의 교차 필드 불변조건

근거: [contracts/api-result.v1.schema.json:5-12](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/contracts/api-result.v1.schema.json#L5-L12), [contracts/provider-result.v1.schema.json:5-13](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/contracts/provider-result.v1.schema.json#L5-L13), [mcp-server/src/schema-validator.ts:323-346](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/mcp-server/src/schema-validator.ts#L323-L346), [skills/orchestrator/references/mcp-execution.md:17-20](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/skills/orchestrator/references/mcp-execution.md#L17-L20).

판단: 공통 schema 자체는 ok=true/error!=null 또는 kind=output/output=null 같은 조합을 교차 필드 조건으로 금지하지 않는다. 전문 result schema와 state mapping 등 추가 런타임 검사는 별도로 있으므로 이 관찰을 실제 guarded 통과 취약점으로 확대하지 않는다.

제안: 새 계약 버전의 oneOf/if-then과 런타임 검사로 success/error 및 output/adapter-error 조합을 명시한다. 통신 성공, 전문 판정, artifact verified, workflow gate 완료를 독립 축으로 보존한다.

검증 조건:

- 모순 envelope를 모든 entry transport에서 거절한다
- passed는 검증된 required artifact·정확한 targetDigest·전문 stateMapping과 일치해야 한다
- partial/uninspected/unresolved는 요약에서도 보존된다

한계: schema를 읽어 확인했으며 이 조사에서 실행 검증은 하지 않았다

### CC09 · P2 · 2.9.1 관측 스냅샷의 native CLI 경계를 유지

근거: [mcp-server/src/skill-classification/runtime.ts:22-53](https://github.com/jaeseongs95/agent-governance-suite/blob/c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6/mcp-server/src/skill-classification/runtime.ts#L22-L53), [mcp-server/src/skill-classification/native-adapters.ts:9-38](https://github.com/jaeseongs95/agent-governance-suite/blob/c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6/mcp-server/src/skill-classification/native-adapters.ts#L9-L38), [mcp-server/src/skill-classification/native-adapters.ts:144-179](https://github.com/jaeseongs95/agent-governance-suite/blob/c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6/mcp-server/src/skill-classification/native-adapters.ts#L144-L179), [skills/orchestrator/references/skill-classification.md:7-15](https://github.com/jaeseongs95/agent-governance-suite/blob/c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6/skills/orchestrator/references/skill-classification.md#L7-L15).

판단: candidate 공통 provider route는 승인된 native/remote port이고 adapter registry도 주입된다. Codex exec/Claude print 옵션과 host union은 native-adapters 구현에 있다. 제품별 CLI 플래그의 존재 자체를 공통 계약 위반으로 분류하지 않는다. 현재 내장 factory의 두 제품 제약은 capability 범위로 명시한다.

제안: built-in adapter definitions와 vendor-neutral registry interface를 분리하고 제3 host가 같은 port를 추가하도록 한다. 고정 profile qualification·approvedRoute·cost/dispatch uncertainty·retry/isolation 근거 요구를 유지한다. CLI help는 실제 실행 capability 증명이 아니다.

검증 조건:

- 세 번째 fake host가 공통 Req/Resp·profile·budget guard를 그대로 쓴다
- 미가용 native route를 API 허가나 무료 호출로 바꾸지 않는다
- fallback은 기존 승인 vendor/route 범위 내에서만 사용한다
- 허용되지 않은 adapter 실행·도구/MCP 재귀·설정/인증 변경을 하지 않는다

한계: c6a8019 스냅샷만 읽었으며 fa1e250 R17 diff나 실 CLI를 검사하지 않았다

### CC10 · P1 · 출처·권한·책임·완료는 다른 사실

근거: [skills/orchestrator/references/input-origin.md:3-13](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/skills/orchestrator/references/input-origin.md#L3-L13), [contracts/input-source-receipt.v1.schema.json:16-29](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/contracts/input-source-receipt.v1.schema.json#L16-L29), [contracts/types.ts:272-286](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/contracts/types.ts#L272-L286), [mcp-server/src/host-attestation.ts:16-22](https://github.com/jaeseongs95/agent-governance-suite/blob/56fef8bd189377b80f4020f506e717ab292b260a/mcp-server/src/host-attestation.ts#L16-L22).

판단: 현재 sourceOriginKind는 주장이고 receipt는 관측이다. authorityCapabilities는 false이며 peer receipt/ACK는 승인을 발급하지 않는다. 이 구분은 벤더 독립 공통 계약의 좋은 기반이다.

제안: source provenance·authorization·responsibility acceptance·execution outcome·verification assurance를 분리하고 각각 evidence binding을 요구한다. capabilities는 boolean 만능 지원 대신 지원 상태/관측 근거/유효기간을 담는다.

검증 조건:

- peer·artifact·summary의 명령이 direct-user 승인으로 승격되지 않는다
- unknown actor를 main 또는 isolated subagent로 추정하지 않는다
- optional unknown은 기존 권한의 독립 작업 전체를 차단하지 않는다
- 필수 인간 승인/독립 감사/guard 관측 미지원은 해당 완료 경계를 통과하지 못한다

## 제안하는 공통 계약

이는 구현된 schema가 아닌 다음 설계 단계의 초안이다. 기계 판독 세부 필드는 findings.json의 proposedCommonContract에 있다. 기존 TaskEnvelope를 복제하거나 현재 v1에 임의 unknown 필드를 넣지 않는다. 버전이 있는 별도 artifact/port로 기능을 도입하고, 현재 schema·stateMapping·서명·revision·digest·유효기간·replay 방지를 유지한다.

| 계약 | 공통 계층의 의미 | 어댑터 책임 |
|---|---|---|
| 요청 | request/operation ID, task 및 candidate ref/digest, 입력 근거, 필요한/선택 capability, 제약과 기존 권한 참조 | 호스트 tool·SDK·CLI wire 인자, 설치 root와 경로 해석 |
| 응답 | 통신·dispatch·업무 결과·검증 수준·책임 상태를 구분; artifact ref·digest·미해결 항목 보존 | raw host 결과를 정규화; 정제된 오류만 반환 |
| 오류·불확실성 | unsupported/unavailable/unobserved/invalid/denied/conflict, dispatch not-started/started/unknown, side-effect 관측 | 실제 호출·취소·응답 관측과 안전한 reason code 제공 |
| 능력 관측 | capability ID, 지원 상태, adapter version, observation assurance, 시각·만료·evidence ref | 선언과 실제 지원을 구별하고 모델·추론·주체를 실제 관측 |
| 권한 | source 주장·관측·authorization을 별도 확인; peer/ACK/수락은 authorityEffect=none | 호스트 입력을 관측해 출처 근거 제공; 새로운 승인 발급 금지 |
| 책임 수락 | offer/task/candidate digest·recipient·의무·write ownership·검증 계획·기한에 대한 명시 수락 | 실제 recipient를 관측하고 동일 원자료 접근·지원 상태를 확인 |
| continuity | replacement snapshot, task/epoch/revision/digest, restore 후보, binding/replay 검사 | raw lifecycle event·hook output·명시 wrapper를 공통 의미로 번역 |

책임 인계 흐름은 `offered → recipient validation → accepted/rejected/needs-input`이다. delivered/ACK는 이 흐름을 대신하지 않는다. accepted도 업무 완료나 실행 승인이 아니다. 수락 후 범위·candidate·recipient·ownership 변경은 새 offer이고, 한 writer 불변조건과 기존 lease를 함께 원자적으로 확인해야 한다. 수락이 관측되지 않으면 `unconfirmed`로 남기고 조정자가 책임을 유지한다. 인계 불명을 이유로 동일 작업을 새 writer에게 자동 중복 배정하지 않는다.

모델/effort 이름·native 플래그·vendor API JSON·hook event·OS 경로·tool prefix는 adapter 자료로 둔다. 공유 계약은 임의 host ID와 capability를 받으며 특정 제품 이름으로 신뢰도나 기능을 추론하지 않는다. 새 adapter는 trust 검사를 우회하는 플러그인이 아니라 동일한 서명·결속·만료·소비 검증기를 이용하는 구현이다. 같은 OS 사용자의 DB 접근을 강한 인간 인증·프로세스 격리로 표현하지 않는다.

## 능력 미지원 시 정직한 동작

| 상황 | 동작 | 완료 보고 |
|---|---|---|
| optional continuity 저장 실패 | 이미 허용된 독립 direct 작업 진행 | 저장·복원 보장 없음 명시 |
| lifecycle injection 없음 | 검증된 host-owned wrapper/명시 artifact 경로가 있으면 활용 | 자동 복원 완료라고 주장하지 않음 |
| 필수 semantic 실행 관측 부재 | BINDING_REQUIRED/BINDING_INVALID와 기존 guard 유지 | 해당 workflow/stage 통과 금지; 별도 direct 결과의 낮은 assurance 보존 |
| Node/shell/MCP 없음 | 독립 수행 가능한 부분 진행; registry나 validator 기능만 unavailable | 필요한 통합 자체가 불가능한 경우 BLOCKED |
| artifact 바이트 접근 불가 | locator/digest 보존, unverified | verified=true 및 의존 stage passed 금지 |
| 메시지 전송/수락 불명 | 기존 ID의 status·영수증을 대조, 책임 유지 | 무전송·무료·accepted·완료로 추정 금지 |
| 주체 격리·독립 감사 미지원 | unsupported/unknown 기록 | 필수 독립성 gate 완료로 표현 금지 |
| native/remote 승인 route·인증 부재 | 설정·키·구독·vendor를 임의 변경하지 않음 | API 호출/유료 평가를 수행했다고 주장하지 않음 |

optional uncertainty는 기존 권한 범위에서 독립적으로 확정된 일을 전역 중단시키지 않는다. 필수 권한·guard·독립 감사의 공백은 영향을 받는 경계에서만 차단하고 공백을 요약에서 삭제하지 않는다. fallback은 원래 승인된 vendor/route/profile 범위 안에서만 가능하다. 벤더 독립 요구는 외부 전송이나 임의 유료 route 사용 승인이 아니다.

## 단계별 후속 검증

1. 실제 읽은 R17 또는 더 새 후보의 commit/tree를 고정하고 이 범위의 diff·라인·hash를 다시 결속한다. 현재 보고서를 R17 감사 PASS로 재사용하지 않는다.
2. 제품명 없는 세 mock adapter로 공통 schema·normalized lifecycle·지원 상태·오류·수락 전이를 SOURCE fixture에서 검증한다. stale/replay·다른 digest·잘못된 actor·미지원·부분 완료와 timeout 불명을 포함한다.
3. Node24 설치 tree에서 외부 npm 의존성 없이 다른 cwd·공백 경로·로컬/원격 artifact 경계·optional 저장 실패를 clean-room으로 검사한다.
4. 지원을 주장할 각 호스트에서 실제 설치 cache/digest, MCP 목록, actor/session 관측, compact/resume 및 wrapper 호출을 직접 검사하고 별도 host evidence로 기록한다. mock PASS, CLI help 또는 SOURCE 리뷰는 이 단계를 대신하지 않는다.
5. 기존 binding·lease·revision·권한·감사와 원본/생성물 분리를 회귀 확인한다. 코드가 없는 이번 조사에서 build나 생성물을 재작성하지 않는다. 향후 구현 변경은 AGENTS.md의 검증 순서를 따르고 최종 대상이 변경되면 영향을 재감사한다.

검증 목록 V01–V08은 findings.json에 있다. 이번 조사에서 제품 regression/clean-room/실호스트 test는 **NOT_RUN**이며 권한·범위·산출물 무결성 확인은 evidence 게시 검증에 한정한다.

## 근거 회수·무결성

게시 대상은 evidence 브랜치의 `evidence/ags-vendor-independence/2026-10-09/common-contract/` 아래 새 파일 네 개뿐이다.

- REPORT.ko.md: 정제된 조사·판단·설계 보고서.
- findings.json: 실제 읽은 SHA/tree, 근거 줄, 판단·제안·한계·검증 조건과 설계 목록.
- source-hashes.json: 인용한 원격 고정 commit 파일의 Git blob ID, 원본 바이트 SHA-256 및 크기. 원본 본문·세션 로그를 포함하지 않는다.
- SHA256SUMS: 앞의 세 보고서/목록 파일 바이트의 SHA-256. 자기 자신의 순환 hash를 담지 않으며 SHA256SUMS 자체 hash는 최종 원격 검증 응답에 별도로 기록한다.

게시 전 다른 작업 경로와 기존 파일을 보존하고, 정상 fast-forward push만 사용한다. 원격 branch가 움직이면 다른 기여를 보존해 재결속하고 범위·사전조건을 재확인한다. 게시가 거절되면 우회하지 않고 차단을 보고한다. 게시 후 commit을 다시 fetch하여 Git object의 실제 바이트를 비교하고 SHA256SUMS를 검사한다. 그 결과는 최종 반환에 게시 commit과 함께 기록한다. 이 문서 작성 시점의 계획을 게시 성공으로 표현하지 않는다.
