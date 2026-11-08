# 아키텍처

이 저장소는 하나의 설치 가능한 플러그인 안에서 여러 전문 스킬을 배포합니다. 소스가 한 저장소에 있어도 전문 스킬의 실행 책임은 분리합니다.

```text
plugin manifest
├── skills/orchestrator/       분류·순서·입출력·결과 통합
├── skills/<specialist>/       전문 판단과 해당 결과 형식
├── contracts/                 여러 스킬이 공유하는 명시적 계약
└── mcp-server/                통합에 필요한 도구 경계
```

오케스트레이터는 스킬 이름을 하드코딩하지 않습니다. 설치 시 노출된 스킬 설명에서 capability 후보를 정하고, `skills/orchestrator/scripts/query-registry.mjs`로 활성 provider의 `skillId`, capability, execution class, phase/order, priority, 선택 조건, precondition과 gate만 조회합니다. 후보를 특정하지 못할 때만 `--all` compact catalog를 사용합니다. 조회기는 매번 원본 `skills/registry.json`에서 결과를 만들고 정렬하므로 별도 catalog 복사본을 두지 않습니다. provider는 `bootstrap`, `workflow`, `recovery`로 나뉩니다. 지침 범위, 저장소 관례와 작업 계약을 만드는 bootstrap provider는 `plan_workflow` 전에 직접 실행합니다. 일반 workflow provider는 artifact 의존성을 먼저 만족시키고 `phaseOrder`를 안정적인 보조 정렬 기준으로 사용합니다. recovery provider는 일반 workflow와 섞지 않고 별도 실행으로 계획합니다. 반복 실패는 `blocker-diagnostician`의 원인 확정 후 `recovery-strategy-selector`가 `RecoveryHandoff.v1`을 만들며, 기존 run은 불변으로 남기고 handoff에 결속된 새 `TaskEnvelope.v1`과 새 workflow에서만 복구를 실행합니다.

같은 capability를 여러 provider가 제공하면 숫자가 큰 priority를 우선합니다. `selectionCriteria`는 사람이 검토할 선택 조건과 이유이며 MCP가 자연어를 해석하지는 않습니다. 조건별 자동 분기가 필요하면 서로 다른 구체적 capability로 등록합니다. 같은 capability에 priority가 겹치거나 선택 조건이 비어 있으면 저장소 검증이 실패합니다.

공용 스킬, JSON Schema, MCP 도구와 런타임은 호스트 중립 계약을 사용합니다. `host`는 Codex나 Claude Code로 닫힌 enum이 아니라 확장 가능한 식별자이고, 제품별 훅 이벤트·inbox·wake transport·실행 관측은 adapter 또는 overlay가 공용 계약으로 변환합니다. 따라서 Grok, Spark나 다른 로컬 AI 런타임도 공용 계층을 고치지 않고 adapter를 추가해 같은 기능을 사용할 수 있습니다. 특정 제품의 로그나 설치 형식처럼 본질적으로 전용인 기능만 예외로 두며, 그 제약은 기능 이름과 문서에 명시합니다.

공개 계약은 `TaskEnvelope.v1`, `SkillDescriptor.v2`, `ProviderResult.v1`, `WorkflowPlan.v1`, `StageResult.v1`, `WorkflowReceipt.v1`, `ApiResult.v1`와 전송 전용 `ResponseModeV1`, `WorkflowStatusSummaryV1`, `ConvergenceRootHandleV1`, `ConvergenceStatusSummaryV1`로 나뉩니다. `SkillDescriptor.v2`는 한 스킬의 여러 provider, 입출력 artifact, 결과 schema, 상태 매핑과 gate를 선언합니다. `plan_workflow`가 레지스트리를 읽어 schema checksum이 포함된 계획을 HMAC으로 서명하고, `start_guarded_workflow`가 같은 MCP 저장소의 서명과 일회용 lease를 확인한 뒤 계획을 동결합니다. 공개 `start_workflow`는 같은 검사로 계획·root·lease·run을 한 transaction에서 만드는 최소 시작이며([단계 확인 설계](../archive/ags30-phase-check-design.md) 7.5), 직접 embedding의 `startWorkflow`만 legacy 호환 경로로 남습니다.

`record_stage_result`는 revision과 실행 순서를 확인한 뒤 provider envelope와 내부 output을 각각 선언된 schema로 검증합니다. 계획에 생산자가 있는 입력 artifact는 해당 선행 단계가 검증된 artifact를 남긴 경우에만 소비할 수 있습니다. bootstrap·task 입력처럼 계획 밖에서 들어오는 artifact의 내용과 출처 확인은 실행한 전문 스킬이 책임지고, MCP는 제출된 locator·digest의 구조를 확인하고, digest가 붙은 로컬 파일은 직접 읽어 `artifactChecks`에 `sha256-matched`로 기록합니다. `verified`는 제공자 선언이며 관문 판정에 쓰지 않습니다. root만 AGS를 호출하므로 감사자·검토자 독립성, fresh context, 사용자 승인은 관측되지 않고 `unverifiedClaims`에 남습니다. descriptor의 선택적 `receiptPolicy`는 계획 stage로 복사되어 HMAC에 결속됩니다. `reference-only` mode는 닫힌 output schema와 opaque reference만 허용하고, 선언된 actor pointer에는 canonical UUID와 run 단위 고유성을 적용합니다. `finalize_workflow`는 모든 필수 단계가 통과하고 미해결 항목이 없으며 각 stage의 receipt policy가 다시 확인된 경우에만 완료 결과를 만듭니다.

### Semantic execution assurance

Strict MCP assurance never trusts `executionContext` supplied in tool arguments. A `TrustedExecutionContextProvider` must supply a fresh observation bound to the exact task, run, stage and revision; observation IDs are atomically claimed in the workflow SQLite database and remain one-use across server restarts and concurrent connections. Expired, mismatched or replayed observations fail closed. The packaged server does not fabricate host attestation. `AGENT_GOVERNANCE_HOST_ATTESTATION` selects an entry in the server's execution-adapter map. Trusted installation code may supply that map through `startMcpServer(..., executionAdapters)`; the bundled default map contains `claude-code`, `codex`, `gemini`, and `antigravity`. An unset value or a host absent from the selected map leaves the server without a trusted execution provider, so orchestrated semantic planning returns `BINDING_REQUIRED` with a `provider-not-configured` diagnostic. Each distribution sets its own value: the Codex `.mcp.json` sets `codex`, the Claude plugin manifest sets `claude-code`, and the Antigravity `mcp_config.json` sets `antigravity`.

The execution observation contract is common to every host. Each host has one caller ingress that the server selects from `AGENT_GOVERNANCE_HOST_ATTESTATION`: Codex and Antigravity read the host-written `tools/call` `_meta`, and Claude Code claims, by `claudecode/toolUseId`, the admission row its PreToolUse governance hook recorded. The core `admitCaller` check returns a `VerifiedCaller` (`host`, `sessionId`, `callId`, `actor` root or child, `parentChain`, `execution`) or rejects; an unobserved caller is never presumed to be a root. Services receive this caller as a separate parameter, and tool arguments that carry `_sessionBinding`, `_continuityBinding`, `_hostAttestation` or `_sessionProof` are rejected. For `plan_workflow`, `record_stage_result`, `classify_skills` and `record_skill_selection`, `HostAttestationProvider` qualifies `caller.execution` (raw model, reasoning effort) through the current trusted adapter; the observation ID is derived from host, session, actor and call ID, and the existing `WorkflowService` task/run/stage/revision binding, freshness, atomic one-use claim and stage-floor checks remain in force. 관측이 없으면 `BINDING_REQUIRED`, 모순·자격·재사용 오류는 `BINDING_INVALID`, 검증된 관측이 실제 단계 하한보다 낮으면 `GATE_FAILED`다. There are no signed tokens; the guarantee is host observation, not isolation from a process running as the same OS user. See [ags30-session-binding-design.md](../archive/ags30-session-binding-design.md) and [execution-attestation.md](execution-attestation.md).

Where each host's observation comes from (the Claude Code PreToolUse governance hook and transcript, the Codex `tools/call` `_meta`, the Antigravity hook runner's PreToolUse rows) and each host's limits are in the table of [execution-attestation.md](execution-attestation.md#배포물의-연결). The 2.x signed-token path (`_hostAttestation`, issued by a PreToolUse hook that rewrote the tool input) no longer exists.

The Gemini adapter maps models by Google Gemini family aliases (`flash-lite` -> `lightweight`, `flash` -> `general`, `pro` -> `deep`, `ultra` -> `frontier`). The Antigravity package registers the MCP server via `mcp_config.json` (server key `ags`) with `AGENT_GOVERNANCE_HOST_ATTESTATION=antigravity`; how its observations are collected is in [execution-attestation.md](execution-attestation.md).

Since v1.19.0 a stage result may carry its provider output by local file reference (`StageResult.outputFile` with an absolute path and SHA-256, `output.output` null); the server reads the file (16 MiB limit), checks the digest, validates the parsed JSON exactly like inline output, and stores only the reference. Claude Code also cannot resolve `$ref` in advertised tool schemas (referenced object fields arrive as strings), so with `AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE=anthropic` the server advertises fully inlined copies of every schema that uses `$ref`; validation keeps using the exact contracts and the default profile is unchanged. Legacy plans and receipts remain readable, but strict MCP claim, guarded start and semantic stage boundaries do not advance assurance-less legacy plans.


MCP의 `plan_workflow` 경계는 `WorkflowService.planWorkflow(..., true)`로 execution assurance를 fail-closed로 강제합니다. 직접 programmatic 호출은 기존 내부 도구와 legacy receipt 호환을 위해 기본적으로 permissive이며, 실제 MCP handler가 strict mode를 선택합니다. ExecutionContext가 결속된 새 plan의 stage-level 검사는 그대로 유지됩니다.


v1.13부터 orchestrated workflow는 의미 판단 단계의 실행 능력을 계획에 결속합니다. `plan_workflow`는 현재 호출에 결속된 호스트 관측을 검증하며 작업과 무관한 성능 하한을 두지 않습니다. 서명되는 초기 접수 요건은 두 성능 하한을 `null`로 두고 `observationRequired: true`를 유지합니다. 계획을 시작할 수 있다는 사실은 개별 stage의 실행 자격을 뜻하지 않습니다. 새 계획의 각 stage에는 `ExecutionRequirement.v1`이 들어갑니다. 고위험(`high`·`critical`) 작업에는 `general/high`를 추천값으로 적습니다. 그 밖의 의미 단계는 두 값을 `null`로 둡니다. 어느 경우든 현재의 신뢰된 관측은 계속 요구합니다. 기본 `general/medium`, capability·provider 별칭이나 감사 의무만으로 만든 `deep/high`는 유효한 요구 근거로 취급하지 않습니다. semantic stage가 `passed`가 되려면 현재 관측을 검증해야 합니다. 관측 정보가 없으면 `BINDING_REQUIRED`로 거절하지만, 검증된 관측의 모델 등급·추론 수준이 추천보다 낮거나 미관측이어도 거절하지 않고 그대로 기록합니다(AGS3-D-0058). 신원·서명·결속 오류는 `BINDING_INVALID`로 구분합니다. `korean-prose-finalization`처럼 완전히 결정적인 단계는 `deterministic`으로 표시해 모델 하한을 요구하지 않습니다.

공통 계약은 특정 제품 모델 이름 목록을 고정하지 않지만, 새 ID를 기본으로 신뢰하지도 않습니다. 모델 이름의 해석과 capability descriptor는 신뢰된 host adapter가 제공하며, 기본 카탈로그 밖의 ID는 descriptor가 없으면 class를 모르는 채로 실행되고 관측에 정책 메모가 남습니다. `lightweight < general < deep < frontier` model class와 `low < medium < high < xhigh < max < ultra` effort 순서는 실행 설정의 추천 순서입니다. 같은 class나 effort가 서로 다른 벤더 모델의 실력 등가를 실측했다는 뜻은 아닙니다. model class는 신뢰된 adapter의 capability 정책에서 얻고, 실제 model ID와 effort는 host runtime 또는 worker spawn 결과에서 관측해야 합니다. caller가 도구 인자로 넣은 `executionContext` JSON은 trusted observation이 아니며 그 자체로는 인증되지 않습니다. 앞에서 설명한 permissive 직접 programmatic 호출은 이런 선언을 인증 없이 받아들입니다. strict MCP 경계는 caller `executionContext`를 관측으로 쓰지 않고, 서버가 검증한 호출자의 호스트 관측(`caller.execution`)만 씁니다. 다만 이 관측은 같은 OS 사용자 권한으로 실행되는 프로세스 사이의 격리를 보장하지 않습니다. 따라서 이 계층은 모델 성능을 새로 만들어 내거나 서로 다른 세션의 산출물 품질을 같게 만드는 장치가 아니라, 어떤 실행 설정으로 semantic stage를 통과했는지 관측해 남기는 실행 거버넌스입니다. 실제 품질 보장은 동결된 corpus·rubric·threshold와 독립 평가 증거를 결속하는 별도 평가 계층이 담당합니다.

[v1.13.0 릴리스 노트](../release-notes/release-notes-v1.13.0.md)는 해당 계약을 도입한 당시의 기록입니다. 현재 adapter 구성과 관측 경계는 이 절의 설명을 따릅니다.

MCP 서버는 플러그인 루트의 `.mcp.json`에 등록됩니다. MCP 응답은 외부 상태를 관측하는 근거일 수 있지만, 호출 수락만으로 성공을 뜻하지 않습니다. MCP가 없을 때도 단독 전문 스킬로 처리할 수 있는 요청은 계속할 수 있습니다.

mutating workflow 도구의 `responseMode`와 status 도구의 `detail`은 서버 경계의 전송 옵션입니다. 생략 시 `full`이며 기존 domain validator와 상태 전이를 그대로 사용합니다. `compact`일 때만 검증·저장이 끝난 domain 결과를 요약 계약으로 투영합니다. 이 옵션은 서버 경계에서 제거되므로 `StageResultV1`, `WorkflowReceiptV1` 같은 저장 계약에는 들어가지 않습니다. MCP 결과는 JSON text content block 하나만 사용하고 같은 데이터를 `structuredContent`에 복제하지 않습니다.

`claim_workflow_attempt`가 task envelope와 frame을 함께 생략하면 서버는 `rootId`의 저장 값을 복원한 뒤 기존 digest와 revision 검사를 수행하고 정규화된 전체 proposal을 저장합니다. `start_guarded_workflow`가 plan을 생략하면 `leaseId`에 결속된 proposal plan을 복원한 뒤 integrity token, root revision, 만료와 일회성 소비를 검사합니다. legacy 호출자가 사본을 전달하면 저장된 root·proposal과의 기존 완전 일치 검사를 유지합니다. lease가 안전한 plan reference이므로 별도 plan ID나 정리 정책은 추가하지 않습니다.

run, revision, run ID sequence, 계획 서명 키, 업데이트 상태, 정리 claim과 trusted execution observation claim은 SQLite schema v6에 저장합니다. 서버를 다시 시작해도 이전 run과 observation의 일회성 소비 상태를 복구하고, 같은 데이터베이스를 공유하는 서버 인스턴스는 optimistic revision 검증과 원자적 observation claim으로 충돌·재사용을 거부합니다. observation claim은 만료 뒤에도 opaque ID tombstone으로 유지해 같은 ID의 재사용을 허용하지 않습니다. compact 전송도 저장 단위를 바꾸지 않으며 전체 `WorkflowReceipt`의 평문 JSON을 유지합니다. 따라서 `StageResult`의 provider output, evidence note, findings, blockers와 error에 원문 코드, 로그, 비밀값이나 개인정보가 들어 있으면 그 내용도 DB에 남습니다. MCP 서버는 필드 내용을 걸러 내거나 자동으로 만료·삭제하지 않으므로 호출자는 민감한 원문을 제출하지 않고 DB 경로의 접근 권한과 보존 기간을 관리해야 합니다.

## 스킬 분류 조언 계층(JEV)

`providerKind: "jev"`는 특정 제품이 아니라 선택을 돕는 조언 계층의 자리입니다. 결정은 AGENT가 하며, TypeSafe는 이 계층의 구현 하나입니다. `noul_*` 점수 종류와 `JEV_*` 이유 코드는 TypeSafe adapter가 내는 값입니다. profile 설정 규칙(reasoning effort, `judgmentPolicy`)은 각 wire adapter의 `validateConfiguration`이 정하고, 인증 헤더는 adapter의 transport 계약이 정합니다(기본값 `authorization: Bearer`). profile·route JSON·요청은 인증 헤더를 정하지 못합니다. `mcp-server/src/skill-classification/service.ts`의 `dispatchAdvisoryAttempt`는 용도에 묶이지 않은 dispatch 엔진으로, 외부 전송 허용, 예산 예약·정산, dispatch fence, usage 검증, helper 실패 증거를 맡습니다. 스킬 분류는 이 엔진을 쓰는 task이며 실패 응답, qualification, stale 판정, 응답 검증을 맡습니다. task는 fence나 helper 실패 증거를 바꾸지 못합니다. 4.0.0부터 JEV 공급자 정의는 `mcp-server/src/skill-classification/jev-provider.ts`에 내장하고, 켜고 끄기·모델·정보 전송 허용·예산·프리셋·대체 평가자·key는 관리자 서명 설정에서 읽습니다. 서버 쪽 예산 상한은 없고, 사용액은 서버 프로세스마다 0부터 셉니다. 자세한 구성은 [관리자 서명 기록과 설정 읽기](admin-log.md#jev-구성)에 있습니다.

## 로컬 task continuity

Continuity는 같은 MCP 서버 프로세스 안의 별도 서비스이며 workflow DB와 분리된 SQLite schema v4를 사용합니다. Direct-task current·history, session epoch, compact marker, HMAC binding, hash-only 관측과 보존 기간 조회 index는 기본적으로 workflow DB 옆의 `continuity.sqlite3`에 저장합니다. Orchestrated 상태의 원장은 계속 `workflows.sqlite3`의 `TaskEnvelope`, `WorkflowReceipt`와 convergence root이고 continuity DB에는 root 결속과 marker만 둡니다.

Direct 메모리는 `continuity_current_memory`와 `continuity_memory_history`로 나눕니다. 현재 본문 `JSON(status/core/evidenceRefs)` 전체에는 UTF-8 2000 byte의 hard 상한이 있으며 채울 목표 분량이 아닙니다. 갱신은 이전 현재 내용을 history에 보관하고 current를 교체하는 같은 transaction으로 처리합니다. 에이전트 API는 history를 노출하지 않지만 같은 OS 사용자의 DB 파일 직접 접근을 차단하는 별도 권한 격리는 없습니다. 본문은 평문 JSON이므로 비밀값, 개인정보, 원시 로그·코드와 chain-of-thought를 제외하고 파일 접근 권한과 보존 기간을 관리합니다. `load_context`는 `schemaVersion`만으로 자기 current와 `stateToken`을 읽으며, 쓰기·삭제는 반환된 토큰을 `expectedStateToken`으로 대조합니다. 명시적 `purge_direct_context`는 current만 지우고 hash tombstone을 남기며 비공개 history, workflow receipt와 convergence root는 삭제하지 않습니다.

Codex lifecycle Hook은 MCP 준비 여부에 의존하지 않고 bundled continuity runtime을 직접 실행합니다. `PreToolUse`는 continuity 도구와 `open_convergence_root` 입력에 task correlation, epoch, 도구 이름, canonical input digest와 만료 시간을 HMAC으로 결속한 stateless token을 추가합니다. Raw session·turn·request ID와 transcript는 저장하지 않습니다.

`SessionStart(resume)`과 direct-task `SessionStart(compact)`는 기존 hook으로 현재 메모리 본문을 주입합니다. 최신성은 원자적 읽기 시점 L의 current를 뜻하며, 호스트 수락 ACK 없이 crash 이후까지 exactly-once 전달이나 모델 첫 행동까지의 최신성을 보장하지 않습니다. Codex·Claude Code의 일반 입력은 본문 없는 짧은 갱신 cue만 받습니다. AGY turn0는 native ephemeral current+cue 경로를 사용해 주입문을 durable 대화 이력에 누적하지 않습니다. Workflow의 revision·digest 검증과 marker에 결속된 bounded 구조 카드 복원은 유지합니다. Startup은 복원하지 않고 clear는 epoch를 회전합니다. Continuity hook 실패는 bounded diagnostic에 원인을 구분해 남기고 exit 0·빈 출력으로 통과하며, MCP 서버도 continuity 초기화 실패 시 workflow를 계속 제공하고 continuity 도구에만 `CONTINUITY_UNAVAILABLE`을 반환합니다.

## 세션 현황판

세션 현황판은 `session-board` 인프라 스킬의 저장소 모듈이 규칙과 SQLite 저장을 모두 맡고, 훅과 MCP 도구(`update_session_status`, `list_session_status`)는 그 모듈을 부르는 인터페이스입니다. 행마다 호스트, 세션 ID, 작업 디렉터리, 한 줄 요약, 요약 시각, 마지막 요청 시각을 두며 요청 원문은 저장하지 않습니다. 세션 ID와 작업 디렉터리는 훅 입력에서 채웁니다. 요청마다 첫 상태 변경 도구 호출(파일 편집, 셸 명령, 서브에이전트 실행. 이 플러그인의 MCP 도구는 제외)을 한 번 거부할지는 저장소 모듈이 판단하고, 훅은 그 결과를 호스트에 전달하며 모든 오류에서 호출을 통과(fail open)시킵니다. 2026-09-19에 Codex 데스크톱에서 실검증해 `exec_command` 거부, `update_session_status`의 입력 수정, `apply_patch` 통과와 `mcp__agent_governance_suite__...` 도구 이름을 확인했습니다. 파일은 모든 호스트(Claude Code·Codex·Antigravity)가 함께 쓰는 `~/.agent-governance-suite/session-board.sqlite3` 하나이며, 목록은 모든 호스트의 행을 `host`와 함께 보여 줍니다. workflow·continuity DB와 달리 호스트별 위치(`${CLAUDE_PLUGIN_DATA}` 등)를 따르지 않습니다. 공용 루트는 절대 `AGENT_GOVERNANCE_SHARED_STATE_DIR`로 바꿀 수 있고, 샌드박스 adapter는 모든 호스트에 같은 값을 제공해야 합니다. 현황판은 세션이 목록을 다시 읽어야 변경을 알 수 있는 pull 방식이며, 실행 중인 다른 세션에 메시지를 push하거나 그 작업을 중단시키는 실시간 통신 채널은 아닙니다.

## 세션 메시지 저장소 (broker 없음)

세션 메시지는 현황판과 같은 공용 루트 아래의 `session-messaging/session-messages.sqlite3`에 저장합니다. MCP 도구, 범용 JSON CLI, 호스트 hook과 relay는 모두 같은 연산 표(`session-message-operations.ts`)를 자기 프로세스 안에서 실행합니다. broker 프로세스, 잠금 디렉터리, TCP 포트, 인증서와 token은 없습니다. 연산 하나는 `BEGIN IMMEDIATE` transaction 하나이고, 만료와 시각 판정은 그 잠금을 얻은 뒤 읽은 시각(DB에 저장한 최댓값 이상)으로 합니다. 파일은 WAL 모드여야 하며, WAL을 쓸 수 없는 파일시스템은 거절합니다. `host`는 열린 문자열 식별자이며 저장소는 제품별 transport나 운영체제를 알지 못합니다. 설계와 근거는 [broker 재설계](../archive/ags30-broker-redesign.md)에 있습니다.

메시지 ID는 prepare에서 공통 연산 표가 발급하며 불변 sender·target·body·TTL을 기존 SQLite의 추가 테이블에 보존합니다. prepare는 전달 효과가 없고, send는 발급 ID만 받아 큐 삽입과 최초 영수증을 같은 transaction으로 확정합니다. 같은 ID는 보존된 최초 결과를 반환하고 미발급·다른 sender·만료·정리된 ID와 변경 내용을 거절합니다. 응답 유실은 같은 알려진 ID로 조정하며 unknown을 무조건 새 prepare로 재전송하지 않습니다. 저장 상한과 복구 제한은 [메시지 ID·재시도 계약](session-messaging.md)을 따릅니다. 수신 훅의 claim은 짧은 lease를 설정하고, ACK가 없으면 TTL까지 지수 backoff로 재전달합니다. 모델이 본문을 처리한 뒤 MCP ACK를 호출한 시점만 `acknowledged`이며, Codex queue 또는 Claude inbox write 성공은 전달 증거로 쓰지 않습니다. 메시지는 발신·수신 host/session, 본문, 생성·만료·claim·ACK 시각과 전달 횟수·최초 전달 시각을 저장하고 개인 키, broker token, inbox token과 socket 경로는 넣지 않습니다. 본문 4096 UTF-8 byte, TTL 30초~24시간, spool 1000개·4 MiB 제한을 적용합니다. claim은 최대 10개를 고르되 JSON escape와 metadata를 포함한 실제 UTF-8 응답이 32 KiB를 넘기 전에 batch를 자릅니다. 2.x의 broker와 client는 요청·응답 한 줄을 받은 byte 그대로 모아 줄바꿈을 포함한 크기가 32 KiB 이하일 때만 받고, 완성된 줄을 한 번에 UTF-8로 풀어 TLS 조각 경계에 걸린 문자도 깨지지 않게 했습니다(3.0부터 broker·TLS 연결은 없습니다). 호출자는 대상 host의 주입 한도에 맞춰 `maxMessages`와 UTF-16 code unit 기준 `maxBodyChars`를 더 낮출 수 있으며, 번들 hook은 한 번에 한 메시지만 claim합니다. 최종 envelope는 8192 UTF-8 byte 이내로 검사하며, JSON 이스케이프로 넘치는 본문은 명시적인 base64-utf8 인코딩으로 무손실 전달합니다. 원문 digest와 BEGIN/END 경계·ACK 안내는 유지합니다. 일반 사용자 입력, wake와 도구 경계의 구분은 [입력 출처와 작업 경계](input-boundaries.md)를 따릅니다.

relay는 `(host, sessionId, transport)` lease 하나를 가집니다. lease의 주인은 grant마다 새로 만드는 무작위 `relay_id`이며, 교체된 relay는 다음 갱신·예약·시작에서 거절됩니다. PID는 권한 판정에 쓰지 않습니다. relay는 호스트 종료를 기한 밖에서 감시합니다(Linux는 `/proc` 출생 tick 비교, Windows는 호스트 handle을 잡은 PowerShell 감시자 하나). 감시자가 호스트 출생을 결속하기 전에는 깨우기를 보내지 않습니다. 본문은 host wake transport를 통과하지 않고, 깨우기는 받은함을 보라는 초인종입니다.

같은 OS 사용자 권한의 악성 프로세스는 상태 디렉터리의 DB를 읽거나 바꿀 수 있으므로 막지 못합니다. 디렉터리는 가능한 플랫폼에서 `0700`으로 제한합니다. peer 메시지는 승인·권한·외부 변경 의사를 대신하지 않습니다.

## 플러그인 업데이트 알림

MCP 서버는 고정된 공개 저장소에서 `vMAJOR.MINOR.PATCH` 형식의 안정 tag만 확인합니다. 성공한 결과는 같은 SQLite DB의 `plugin_update_state`에 24시간 동안 보관하고, 실패하면 마지막 성공 결과를 유지한 채 1시간 뒤 다시 시도합니다. 업데이트 확인 오류는 workflow 상태나 도구 결과를 바꾸지 않습니다.

설치된 버전보다 높은 tag가 있고 아직 안내하지 않은 버전이면 기존 MCP 도구 결과 뒤에 `plugin-update-notice` content block을 붙입니다. 같은 버전의 안내는 DB 전체에서 한 번만 claim합니다. `check_for_updates`에 `force: true`를 전달하면 TTL을 무시하고 다시 확인할 수 있습니다. 서버는 설치 파일이나 마켓플레이스 설정을 수정하지 않으며 `automaticInstall`은 항상 `false`입니다.

고위험 변경의 완료 판정은 오케스트레이터가 내리지 않습니다. 최종 대상과 증거를 확인한 독립 감사 스킬의 결과를 그대로 통합합니다. `mutation-risk-preflight`의 통과는 실행 승인이나 감사 통과를 대신하지 않습니다.

MCP는 적대적인 호출자를 인증하는 보안 경계가 아닙니다. `verified`, locator, auditor ID는 전문 스킬이 직접 확인한 뒤 제출하는 신뢰 입력이며, MCP는 그 선언의 구조와 단계 불변조건을 검사합니다. 실제 신원 인증이나 원자료 무결성이 필요한 배포에서는 인증된 외부 신원·증거 서비스를 추가해야 합니다.

기존에 서명된 미시작 계획은 초기 접수 요건이 달라 새 정규 계획과의 비교에서 `LEASE_CONFLICT`가 날 수 있습니다. 원계획·실행 기록·상태 원장은 보존하고 현재 호출의 새 관측으로 계획을 다시 만듭니다. 이미 시작한 실행의 단계 요건은 저장된 계획을 따르며, 이 변경은 운영 데이터나 복구 기록을 다시 쓰지 않습니다.

## 검사 범위와 한계

MCP 서버는 `SkillDescriptor.v2`의 `capability`, 실행 단계, `artifact` 의존성을 읽어 계획을 만듭니다. 계획에는 스키마 체크섬과 HMAC 서명이 포함되며, 서버는 다음 항목을 검사합니다.

- 계획을 시작한 뒤 내용이 바뀌지 않았는지
- 각 단계가 정해진 순서와 `revision`에 맞게 제출됐는지
- 각 provider의 결과가 선언된 스키마와 상태 매핑을 따르는지
- 다음 단계에 필요한 산출물과 검증 근거가 준비됐는지
- 독립 숙고와 필수 감사의 대상이 현재 결과와 일치하고 정해진 조건을 충족하는지
- 해결되지 않은 차단 사유가 남아 있지 않은지
- 새 orchestrated 실행이 root에 결속된 일회용 lease를 사용하고 epoch당 3회 예산과 frame 불변조건을 지켰는지

Convergence root, epoch, attempt, lease, review와 workflow 연결도 같은 SQLite DB에 append-only 이력으로 저장되므로 MCP 프로세스가 다시 시작돼도 예산과 활성 attempt를 유지합니다. 호스트가 등록한 stdio 서버(Codex `.mcp.json`, Claude Code plugin manifest, Antigravity `mcp_config.json`)가 필요할 때 자동 실행되며, MCP 서버 자체에는 별도 계정이나 상시 데몬이 필요하지 않습니다. 관리자 페이지 포트는 [관리자 서명 기록](admin-log.md#페이지-서버)을 봅니다.

오케스트레이터는 설치 시 노출된 스킬 설명에서 필요한 capability 후보를 고른 뒤 `skills/orchestrator/scripts/query-registry.mjs`로 활성 provider의 실행 메타데이터만 조회합니다. 후보를 정하지 못한 경우에만 `--all` compact catalog를 사용하며, 전체 `skills/registry.json`을 모델 입력으로 전달하지 않습니다.

공개 MCP 도구의 응답 옵션을 생략하면 기존과 같은 전체 결과와 convergence 이력을 반환합니다. 오케스트레이터의 정상 경로는 `responseMode: "compact"`와 `detail: "compact"`를 사용해 plan, 누적 `stageResults`, provider output, task/frame 원문과 전체 이력을 제외한 고정 크기 요약만 받습니다. 오류 원인, 과거 결과 또는 감사 자료가 필요할 때만 해당 상태를 `full`로 다시 조회합니다.

실행 중인 run, 현재 `revision`, run ID sequence, 계획 서명 키와 플러그인 업데이트 확인 상태는 SQLite에 저장되므로 MCP 서버를 다시 시작해도 이어서 처리할 수 있습니다. 업데이트 상태에는 버전·tag·commit, ETag, 확인 시각, 다음 확인 시각, 마지막 안내 버전과 오류 코드만 들어갑니다. descriptor에 `receiptPolicy.mode: reference-only`를 선언한 provider는 저장 전에 닫힌 output schema, digest·artifact reference·고정 토큰만 허용하며 note, locator, findings, blockers와 error의 자유 텍스트도 거부합니다. `actorIdPointer`와 `uniqueness: run`을 함께 선언하면 canonical lowercase UUID actor ID의 run 내 재사용도 서버 재시작 후까지 거부합니다. 기본 생성자를 사용한 `WorkflowService`는 테스트와 임베딩 호환성을 위해 메모리 저장 방식을 유지합니다. 이 정책은 원문 비저장을 위한 구조적 저장 경계일 뿐 신원을 인증하지 않습니다. 인증된 신원, 암호화된 장기 보존이나 적대적 환경에서도 보장되는 증거 무결성이 필요하다면 별도의 신원·증거 저장소를 연결해야 합니다.

## 공통 엔지니어링 지식

`test-engineering`과 `code-review`는 2.8.1에서 소스 패키지 `ags-engineering-practices` 0.1.0으로 편입했습니다. 공통 지식은 `skills/orchestrator/references/engineering-practices/`의 8개 모듈이며, 오케스트레이터나 담당 스킬은 현재 작업에 필요한 모듈만 읽습니다. 공용 실행 코드는 `runtime/engineering-practices/`에 있습니다.

| 모듈 | 담당 |
| --- | --- |
| `test-design`, `test-proof` | `test-engineering` |
| `code-review` | `code-review` |
| `debugging` | `blocker-diagnostician` |
| `implementation` | `minimal-implementation` |
| `dependency` | `software-security-auditor` |
| `verification` | `acceptance-evidence-validator` |
| `agent-instructions` | `orchestrator`와 스킬 작성자 |

닫힌 `engineering-*.v1` JSON Schema 9개(`engineering-test-plan`, `engineering-test-proof`, `engineering-plan-result`, `engineering-test-result`, `engineering-review-request`, `engineering-review-report`, `engineering-review-result`, `engineering-snapshot`, `engineering-run-receipt`)가 입력과 결과를 표현합니다. 결과가 `CONSISTENT`·`NO_BLOCKING_FINDINGS`라는 사실만으로 요구사항 충족, 실제 동작, 근거 진본성, 독립 감사 또는 릴리스 승인을 확정하지 않으며, `NOT_RUN`·누락·무결성 실패를 성공으로 바꾸지 않습니다. 편입 당시의 범위와 상태는 [엔지니어링 실무 통합 기록](../archive/engineering-practices.ko.md)에 있습니다. `cs-engineering`의 설계 기록은 [CS Engineering 설계안](../archive/cs-engineering-design.ko.md)과 [2.8.0 통합 상태](../archive/cs-engineering.md)에 있습니다.

## 저장소 구조

```text
.codex-plugin/plugin.json        Codex 플러그인 매니페스트
.agents/plugins/marketplace.json Codex 마켓플레이스 배포 정보
.claude-plugin/marketplace.json  Claude Code 마켓플레이스 배포 정보
.gemini-plugin/plugin.json       Antigravity 플러그인 매니페스트
.mcp.json                        Codex STDIO MCP 서버 설정
mcp_config.json                  Antigravity MCP 서버 설정(서버 키 ags)
hooks/hooks.json                 Codex hook 등록
hooks.json                       Antigravity hook 등록
antigravity-connector/           Antigravity hook runner와 보조 스크립트
claude-overlay/                  Claude Code 전용 파일과 스킬별 문구 보정(adaptations/)
claude-plugin/, claude-plugin-en/, codex-plugin-en/
                                 생성된 배포물(직접 수정 금지)
skills/                          오케스트레이터와 전문 스킬, registry, source lock
contracts/                       스킬·도구가 공유하는 JSON Schema와 TypeScript 계약
locales/                         메시지 카탈로그
mcp-server/src/, mcp-server/dist/ MCP 서버 소스와 커밋하는 번들
runtime/                         설치물용 공용 런타임과 제3자 고지
release/version.json             플러그인 현재 버전의 단일 소스
scripts/                         검증·빌드·스킬 편입·발행 도구
tests/                           계약·회귀·런타임 시험
docs/                            사용자·기여자 문서, 보관 기록, 릴리스 노트
```

`skills/orchestrator/`는 요청 분류, 실행 순서 결정, 입출력 전달, 결과 통합만 담당합니다. 전문 판단과 감사 결론은 각 전문 스킬이 맡습니다. MCP 서버는 스킬 이름으로 분기하지 않고 `skills/registry.json`에 선언된 provider의 `capability`와 계약을 사용합니다.
