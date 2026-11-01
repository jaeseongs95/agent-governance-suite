# AGS 3.0 관문 재설계: 호출자 자기 신고를 검증으로 내세우지 않기

대상 작업 사본: `D:/codex/build/ags-5970-gates`, branch `feat/ags30-gates`, 기준 commit `4b2dc571`.
이 문서는 분석과 설계만 담는다. 구현·시험 결과는 이 문서에 적지 않는다.
개정 1(2026-11-01): 사용자 정책 변경(신원이 관측되는 호스트에서는 child 호출 허용)을 §1.2·§3.3·§3.5·§3.8에 반영했다.
줄 번호는 모두 기준 commit `4b2dc571` 기준이다.

## 1. 구조 판정

### 1.1 AGS가 스스로 관측하는 사실

AGS 서버가 호출자 문자열 없이 스스로 확인할 수 있는 것은 다음 여섯 가지뿐이다.

| 번호 | 사실 | 근거 |
| --- | --- | --- |
| F1 | 서명된 계획(HMAC)과 task envelope·registry에서 다시 만든 계획의 일치, 동결된 단계 순서·필수 산출물·감사 phase | `workflow-service.ts:268-281`(claim 때 재구성 대조), `:1662-1693`, `:930-932`(requiredAuditPhase 동결) |
| F2 | 서버가 순서를 매기는 상태: run revision, lease 1회 소비, epoch당 시도 수, outcome, 기록 순서 | `workflow-service.ts:283-338`, `:428-482`, `:1913-1942` |
| F3 | strict 모드의 호스트 관측: `plan_workflow`·`record_stage_result` 호출자의 model·effort·actorId, 1회 소비 | `host-attestation.ts:24`(관측 대상 도구 4개), `workflow-service.ts:676-713`, `:1447-1511` |
| F4 | 모든 도구 호출의 root 세션 증명(host, sessionId) | `server.ts:627-640`, `session-actor-proof.ts:53-123` |
| F5 | 서버가 직접 읽은 로컬 파일 바이트와 sha256 | `stage-output-file.ts:21-60`, `cs-engineering-validator.ts:15-38`, `engineering-practices-validator.ts:13-35` |
| F6 | registry·schema 파일 digest | `registry.ts:38-60` |

### 1.2 결정적인 제약: 기준 commit에서 AGS가 보는 actor는 root 하나다

- `actorAccess`는 `role === "root"`만 허용한다(`input-observation.ts:49`). 3.0 계약상 AGS 도구는 root만 호출할 수 있다(`docs/ags30-d0019-root-only-design.md:3-5`).
- 그래서 감사자·검토자·평가 실행자 같은 하위 에이전트는 `record_stage_result`·`resolve_convergence_gate`를 직접 부를 수 없다. 모든 단계 결과는 root가 기록하고, F3·F4로 관측되는 actor도 항상 root다.
- Codex·Antigravity에서는 표식 없는 child가 root로 추정되어 통과할 수 있다(`ags30-d0019-root-only-design.md:21-35`). 관측된 "root"가 실제로 child일 수도 있다는 뜻이다.
- 사용자 승인은 관측하지 못한다. trust store는 `user-turn`과 `host-direct-user-event` 기록을 거부한다(`trust-store.ts:101-103`). `directUserInputAttestation: false`는 `trust-service.ts:31`에 있다.

따라서 기준 commit에서는 감사자≠구현자, 검토자 독립성, fresh context, 재위임 금지, 패널 검토자 수, 사용자 승인, 실행 후 상태 확인 같은 주장을 **AGS가 어떤 방식으로도 검증할 수 없다**. 지금 관문들은 root가 써 넣은 문자열끼리 비교한 뒤, 오류 문구와 `passed` 상태로 검증된 것처럼 내보낸다. 예를 들어 오류 문구 "Mandatory audit auditor must be independent from implementation actors"(`workflow-service.ts:1353-1359`)와 `passed` 상태(`:813`)가 그렇다. 문서는 일부 정직하다. 예: `skills/orchestrator/references/specialist-handoffs.md:23` 「MCP의 구조적 필드 검사는 감사 사실이나 신원을 인증하지 않으므로」. 그러나 기계가 읽는 결과(receipt·status·도구 설명)에는 이 한계가 없다.

개정 1: 사용자 정책이 바뀌어, 호스트가 위조할 수 없는 child 신원을 주면 child가 AGS 도구를 직접 부를 수 있다. 결속 브랜치(`ags-5970-binding`)가 `caller = {actor, parentChain[], provenance: "host-observed" | "unavailable", execution}`을 정의한다. 그때부터 감사자≠구현자, 검토자≠구현자, 재위임 금지는 provenance가 `host-observed`인 기록끼리 서버가 직접 비교할 수 있다(§3.8). fresh context와 사용자 승인은 호스트가 관측값을 주지 않으므로 계속 검증할 수 없다.

### 1.3 결과를 실제로 소비하는 곳

| 소비자 | 위치 | 영향 |
| --- | --- | --- |
| `finalize_workflow` → receipt `passed` | `workflow-service.ts:765-819` | 사용자·에이전트에게 보이는 완료 상태 |
| convergence root `completed` | `workflow-service.ts:1874-1880` | lineage 종료·작업 영역 해제 |
| 상태 요약 | `response-projections.ts:28-40` | compact 상태 표시 |
| continuity 복원 카드 | `continuity-service.ts:824-860`(`verified: item.verified` :859) | 압축 뒤 복원된 "검증됨" 표시 |
| 한국어 산문 평가 readiness | `scripts/korean-prose-readiness.ts:377-381, 455-456, 494, 524, 538`, `scripts/verify-korean-prose-receipt.ts:81-144`, `package.json:34-36` | 평가·릴리스 근거로 사용하는 수동 스크립트 |
| 스킬 지침 | `skills/independent-audit-gate/SKILL.md` 완료 불변조건, `specialist-handoffs.md:13-23` | 에이전트가 PASS를 근거로 다음 고위험 행동을 한다 |

CI(`.github/workflows/ci.yml:46-215`)와 release 스크립트는 workflow receipt를 소비하지 않는다(step 목록으로 확인). 즉 거짓 "검증됨"은 merge·release 자동화가 아니라 사용자와 에이전트의 판단, 그리고 수동 평가 근거를 오염시킨다.

### 1.4 판정 원칙(모든 관문 공통)

- **U1 일관성**: root의 선언이 그 자신이나 서명된 계획과 모순되면 거부한다. 예: 선언 `freshContext:false`인데 PASS. 이것은 실제로 저장되는 기록에 대한 검사라 유지한다.
- **U2 정직한 기록**: AGS가 관측하지 못한 성질에 기대는 PASS는 그 성질을 서버가 계산한 `unverifiedClaims`에 적는다. 선언을 검증으로 승격하지 않는다.
- **U3 관측 우선**: 서버가 직접 볼 수 있는 사실(파일 바이트, 자신이 기록한 digest·순서, 관측된 root actor)은 직접 확인한다. 그 자리에 호출자 boolean을 받지 않는다. 예: `verified`.
- **U4 자격 주장 금지**: 출력 자체가 관측 불가능한 사실에 근거한 품질·릴리스 자격을 주장하면 PASS로 완료하지 않는다. 현행 D-0336 차단(`workflow-service.ts:1293-1311`)을 유지한다.

## 2. 관문별 판정표

| # | 관문(위치) | 주장 | AGS가 실제로 확인하는 것 | 소비자 | 결정 |
| --- | --- | --- | --- | --- | --- |
| 1 | 계획 무결성(`:1662-1693`, `:268-281`) | 계획 변조 없음 | F1 | claim·start | **유지** |
| 2 | 시도 예산·lease(`:283-338`, `:428-482`) | 3회/epoch, 1회 소비 | F2 | claim | **유지** |
| 3 | 재시도 새 근거(`:352-397`, 신규 판정 `:380`) | 새 근거가 있다 | 문자열이 처음 보인 것인지만 확인 | claim | **검증으로 전환**: 파일을 읽어 digest로 판정(§3.1) |
| 4 | 실행 하한(`:1540-1612`) | 단계가 하한 이상으로 실행됨 | strict: **기록한 root 호출**의 관측값, non-strict: 호출자 JSON | record·finalize | **유지 + 표기**: 계약에 "기록자 실행 profile"로 명시, non-strict 호출자 값은 `execution-profile` 미검증 |
| 5 | 증거·산출물 `verified`(`:1099-1106`, `:1172-1198`, `:1200-1226`) | 근거가 검증됨 | 호출자 boolean, 생산자 없는 입력은 건너뜀(`:1206`) | finalize·continuity·readiness | **검증으로 전환**: 서버 hash, `verified` 입력 삭제(§3.2) |
| 6 | 필수 감사(`:1313-1360`) | 독립·fresh·재위임 없음·대상 일치·실행 후 확인 | phase 동결(F1)만 실제 확인. 나머지는 root 문자열 비교 | finalize·root 완료 | **분할**: 대상 digest·stale·기록자 모순은 검증, 독립성 등은 기록, `currentTarget` 삭제(§3.3) |
| 7 | 숙의(`:1228-1291`, `decision-record-validator.ts`) | 독립 패널·strict·조건 확인 | 기록 문서의 내부 일관성 | finalize | **기록으로 강등** + TS/Python 검증기 불일치 수정(§3.4) |
| 8 | 평가 유효성(`:1293-1311`) | 작업자 분리된 평가 PASS | 없음(PASS 차단 중) | readiness | **현행 차단 유지**(U4) |
| 9 | receipt policy actor(`receipt-policy.ts:183-228`) | 단계별 actor가 서로 다름 | 선언 UUID 형식·중복 | korean-prose readiness | **기록으로 강등**: 일관성 검사 유지, `actor-independence` 미검증 |
| 10 | 수렴 검토(`:526-592`, 비교 `:545-555`) | fresh·독립 검토 | lease의 선언 actorId(`:412`)와 검토 선언 비교 | 새 epoch·예산 재설정 | **기록으로 강등** + `implementationActorIds` 삭제, lease actor는 관측값(§3.5) |
| 11 | root 교체 승인(`:203-205`) | 사용자 승인 | 참조 개수 ≥1 | 예산 재설정·영역 해제 | **기록으로 강등**: `user-approval` 미검증(§3.5) |
| 12 | `validate_collaboration_decision`(`trust-service.ts:41-88`) | 출처 관측 보고 | 서명 receipt·호출 세션 | 호출자 | **유지**(이미 정직: authority 3종 false) |
| 13 | 범위 baseline(현재 서버 규칙 없음) | 원래 baseline 유지 | 없음 | change-scope PASS | **검증 추가**: lineage 고정(§3.6) |
| 14 | cs·engineering bundle(`cs-engineering-validator.ts`, `engineering-practices-validator.ts`) | bundle 검증 | F5(파일 digest·하위 검증기) | record·finalize | **유지**: `verified` 대신 서버 `check` 사용 |
| 15 | iteration-frame 요청 검증(`skills/iteration-frame-auditor/scripts/core.mjs:51-111`) | 계약·frame 결속 | 문서 내부 digest | skill | **국소 수정**(D-0166) |
| 16 | acceptance 기준 ID(`skills/acceptance-evidence-validator/scripts/core.mjs:108-110,127`) | 기준별 판정 | 배열 순서 | skill | **국소 수정**(D-0037) |
| 17 | 하위 에이전트 context 기록(`skills/coordinate-subagents/scripts/model-routing.mjs:158-176`) | 감사자 fresh | 호출자가 복사한 spawn 인자 | skill | **유지**: 8abee6a7 수정 포함, 문서가 이미 "does not authenticate evidence"라고 밝힘 |

## 3. 설계

### 3.1 재시도 새 근거(D-0039)

- `AttemptProposal.priorFailure.evidenceRefs: string[]`의 각 항목은 절대 로컬 일반 파일 경로여야 한다. 서버가 `readLocalStageOutputFile`(16 MiB, UNC 금지)로 읽어 sha256을 계산한다. 읽을 수 없으면 `MISSING_EVIDENCE`로 거부한다.
- 서버가 계산한 digest는 `AttemptLease.priorEvidenceDigests: string[]`(신규, 서버 필드)에 저장한다.
- 이전 근거 집합은 root의 모든 lease `priorEvidenceDigests`, outcome `evidenceRefs` 중 sha256 키, `retryRejections[].evidenceRefs`(신규 항목은 digest를 저장)를 합친 것이다. 새 근거는 계산한 digest가 이 집합에 없는 경우뿐이다. 같은 내용을 다른 경로에 다시 내도 새 근거가 아니다.
- 검증하는 범위는 "새 바이트가 존재한다"까지다. 그 근거가 원인을 판별하는지는 확인하지 않는다. lease 응답에 이 한계를 `unverifiedClaims: [{claim:"evidence-relevance"}]`로 적는다.

### 3.2 증거·산출물(D-0048)

- `stage-result.v1`의 `providerArtifact.verified`와 `evidence.verified`를 삭제한다. `evidence`에는 선택 필드 `digest`(`^sha256:[a-f0-9]{64}$`)를 추가한다. 입력에 `verified`·`check`가 있으면 schema가 거부한다(`additionalProperties:false`).
- `record_stage_result`에서 서버가 산출물·증거마다 `check`를 계산해 저장본에 붙인다.
  - locator가 절대 로컬 일반 파일이고 digest가 있으면 읽어서 비교한다. 일치하면 `sha256-matched`, 불일치면 `BINDING_INVALID`로 거부한다.
  - 그 밖의 경우(commit·URL·식별자·디렉터리)는 `not-checked`다.
- 통과 조건: 증거가 1개 이상 있고 required artifact가 유일하며 digest와 계획 결속(`:1184-1197`, 현행 유지)을 만족해야 한다. `verified` 조건은 삭제한다.
- 생산자 없는 required input(`:1206`의 `continue`)은 통과 단계에서 같은 `artifactId`의 evidence가 있어야 한다. 없으면 `MISSING_EVIDENCE`다. `receipt-policy.ts:169-181`의 외부 입력 검사와 같은 규칙을 모든 단계에 적용한다.
- `not-checked` 필수 산출물·외부 입력은 `unverifiedClaims`에 `{stageId, claim:"evidence-content", artifactId}`로 남긴다.
- 소비처 교체: `workflow-service.ts:1101,1184,1213`, `receipt-policy.ts:174`, `provider-semantics.ts:45`, `cs-engineering-validator.ts:18,38`, `engineering-practices-validator.ts:16,35`, `continuity-service.ts:859`, `scripts/korean-prose-readiness.ts:524,538`, `scripts/verify-korean-prose-receipt.ts:137,144`. 모두 `verified` 대신 `check === "sha256-matched"`를 쓴다. cs·engineering bundle은 원래 파일 digest를 확인하는 경로라 동작은 같다.

### 3.3 필수 감사(D-0040, D-0097, D-0165 일부)

`assertMandatoryAuditGate`를 다음처럼 바꾼다.

- **검증(F1·F2·F3·F5)**
  - `phase === requiredAuditPhase`: c3d628fa에서 이미 동결했고 유지한다.
  - `output.auditTarget`은 같은 단계의 `audit-target` 산출물 `targetDigest`(서명된 계획의 `artifactContract`에 결속)와 같아야 한다. 호출자 문자열끼리 비교하던 `currentTarget !== auditTarget`(`:1333`)과 `currentTarget` 필드는 삭제한다.
  - strict 모드에서 선언 `auditorId`가 관측된 기록자 actor(`result.executionContext.actorId`)나 계획 bootstrap actor(`plan.bootstrapExecution.context.actorId`)와 같으면 `GATE_FAILED`(cause `AUDITOR_IS_OBSERVED_ROOT`)다. root가 자신을 감사자로 적은 모순이다.
  - `finalize_workflow`는 감사 단계의 `sha256-matched` 산출물 파일을 다시 hash한다. 바뀌었으면 `GATE_FAILED`(cause `AUDIT_TARGET_CHANGED`)다. `stale:false` 선언 대신 서버가 실제로 확인하는 stale 검사다.
- **기록(U1 일관성 유지, U2 표기)**: `freshContext===true`, `delegationAllowed===false`, `blockingFindings` 비어 있음, `stale===false`, post 계열의 `postExecutionVerified===true`, `auditorId ∉ implementationActorIds`는 모순 검사로 남긴다. 통과하면 `unverifiedClaims`에 `actor-independence`, `fresh-context`, `no-redelegation`, `worker-execution-profile`, post 계열이면 `post-execution-state`를 적는다.
- Codex·Antigravity의 추정 root, 하위 에이전트 미관측은 이 표기로 드러난다. D-0097의 기대 「한계가 계약에 명시」를 충족한다.
- 개정 1: 감사 단계 기록자와 구현 단계 기록자가 모두 `host-observed`이면 §3.8의 비교 결과가 판정이 된다. 위반이면 `GATE_FAILED`(reason `AUDITOR_NOT_INDEPENDENT`), 통과면 `actor-independence`·`no-redelegation`을 `unverifiedClaims`에 적지 않는다. `fresh-context`·`worker-execution-profile`·`post-execution-state`는 그대로 적는다.

### 3.4 숙의(D-0049, D-0141)

- `assertDeliberationGate`의 schema·의미 검사(strict 인원 수 포함)는 유지한다. 통과하면 `panel-independence`, `worker-execution-profile`을 적는다. `conditional_consensus`이면 `conditions-verified`도 적는다. `conditionsVerified`(`:1286`)와 `run.strict`(`:1280`)는 선언이다.
- D-0141: `decision-record-validator.ts:368-377`은 coverage reviewer 중 하나라도 followup이 있으면 통과한다. origin reviewer의 followup만 있어도 통과한다. Python 검증기는 고쳐졌다(`validate_decision_record.py:393-400`). TS 쪽을 같은 규칙으로 고친다. coverage의 모든 (reviewer,item) 쌍에 matching followup이 있어야 하고, followup의 reviewer는 그 item의 coverage에 있어야 하며, item마다 origin이 아닌 reviewer의 followup이 1개 이상 있어야 한다.
- 두 검증기의 재분기(D-0049의 근본 원인과 같은 형태)를 막으려고 공통 fixture corpus `tests/independent-deliberation-panel/fixtures/decision-record-parity/*.json`(기대 판정 포함)을 두 검증기 모두에 돌리는 시험을 추가한다. 서버가 Python을 실행하게 해서 TS 사본을 지우는 안은 서버 실행 의존성(Python 필수)이 생겨 채택하지 않았다.

### 3.5 수렴 root·검토(D-0047, D-0165)

- `attempt-proposal.v1`에서 `actorId`를 삭제한다. `claimWorkflowAttempt`는 server.ts가 검증한 세션 증명으로 `lease.actorId = hostActorId(host, sessionId)`를 만든다(`server.ts:627-640`의 `verified`를 인자로 전달). `retryRejections[].actorId`도 같은 값을 쓴다.
- `convergence-review.v1`에서 `implementationActorIds`를 삭제한다. 서버는 consumed lease에서 actor를 직접 구한다(`:545`). `reviewerActorId`는 선언으로 남고, 관측된 root actor와 같으면 모순으로 거부한다. 선언 `freshContext`도 남긴다.
- `open_convergence_root`의 `userApprovalRefs` 개수 검사(`:203`)는 유지하되 승인으로 취급하지 않는다.
- `ConvergenceStatusV1`에 서버 계산 `unverifiedClaims`를 추가한다. `parentRootId`가 있으면 `user-approval`, 검토마다 `reviewer-independence`, `fresh-context`를 적는다.
- 도구 설명을 바꾼다(`server.ts:484, 502, 526`과 `open_convergence_root`). 예: `resolve_convergence_gate` → "Record a frame review declared by the root. AGS does not observe reviewer identity, independence or context; see unverifiedClaims." `finalize_workflow`에는 "passed means every planned stage recorded PASS and AGS-checkable bindings hold; unverifiedClaims lists what AGS did not observe."를 쓴다.
- 실제 승인 검증은 직접 사용자 입력 관측(`directUserInputAttestation`)이 필요하다. 3.0 범위가 아니다.
- 개정 1: `resolve_convergence_gate` 호출자와 그 root의 구현 단계 기록자가 모두 `host-observed`이면 §3.8로 판정한다. 위반이면 `GATE_FAILED`(reason `REVIEWER_NOT_INDEPENDENT`), 통과면 그 검토에 대해 `reviewer-independence`를 적지 않는다. `fresh-context`는 계속 적는다.

### 3.6 변경 범위 baseline 고정(D-0339)

- 서버는 convergence root lineage(현재 root와 `parentRootId` 체인)의 run들에서 첫 번째로 통과한 `change-scope-baseline-capture` 단계의 `output.manifestSha256`을 baseline 고정값으로 **계산**한다. 저장 필드를 새로 만들지 않고 기존 snapshot·receipt에서 계산한다.
- 이후 같은 lineage에서 baseline 단계가 다른 `manifestSha256`을 기록하거나, `change-scope-assurance`의 `output.baselineDigest`가 고정값과 다르면 `BINDING_INVALID`(cause `BASELINE_REBOUND`)다. 스킬의 원래 baseline 재결속 경로(`lib.mjs:208-235`의 `baseline`·`baselineArtifactDigest`)는 같은 manifest를 내므로 통과한다.
- 범위 변경은 claim에서 `FRAME_REVIEW_REQUIRED`가 되고 교체 root(`parentRootId`)로 이어진다. 활성 부모가 작업 영역을 잡고 있으면 무관한 새 root는 `ROOT_CONFLICT`다. 그래서 lineage 범위면 D-0339 경로를 덮는다. MCP 밖에서 스킬을 직접 쓰는 경우는 문서 절차(77b36931, da8cef25)에 남는다.

### 3.7 `unverifiedClaims`

- 형식: `Array<{stageId: string|null, claim: enum, artifactId?: string}>`. claim enum은 `actor-independence`, `fresh-context`, `no-redelegation`, `post-execution-state`, `panel-independence`, `conditions-verified`, `worker-execution-profile`, `execution-profile`, `evidence-content`, `evidence-relevance`, `user-approval`, `reviewer-independence`다.
- `mcp-server/src/unverified-claims.ts`(신규, 순수 함수 2개)가 receipt·convergence snapshot에서 계산한다. 규칙은 단계의 기존 판별 키를 그대로 쓴다: `riskGate`+`gate-verdict`, `decision-record`, `iteration-frame-audit`, receiptPolicy actor pointer, non-strict 호출자 executionContext, `not-checked`.
- 저장 시(`change()`)와 읽기 시(`requireRun`)에 다시 계산한다. 저장값은 표시용이고 정본은 계산 함수다.
- 요약 projection에 `unverifiedClaimCount`를 추가한다. readiness 스크립트는 이 목록을 보고서에 그대로 옮기고, 비어 있지 않으면 "선언 기반"으로 표시한다.

### 3.8 관측된 호출자와 독립성 비교(개정 1)

- 서비스는 호출자를 `ObservedCallerV1 = {actor, parentChain: string[], provenance: "host-observed" | "unavailable"}` 하나로 받는다. lease actor·단계 기록자·검토자 모두 이 값에서만 나온다. 현재 출처는 server.ts가 검증한 세션 증명이고 `{actor: hostActorId(host, sessionId), parentChain: [], provenance: "unavailable"}`로 채운다. 결속 브랜치를 합치면 출처만 `caller`로 바뀐다.
- 서버가 저장본에 붙이는 필드: `StageResultV1.recordedBy`(단계 기록자), `ConvergenceReviewV1.observedReviewer`(검토 호출자와 판정). 호출자가 이 필드를 보내면 `INVALID_INPUT`(reason `SERVER_OWNED_FIELD`)이다.
- 비교 대상(구현자)은 같은 run(감사) 또는 같은 root의 run들(검토)에서 통과한 단계 중 필수 감사·iteration-frame-audit가 아닌 단계의 `recordedBy`다. lease를 claim한 actor는 구현자로 보지 않는다. root가 claim하고 child가 구현하는 구성을 막지 않기 위해서다.
- 판정 함수 `independence(checked, implementers)`는 provenance 값만 본다. 벤더 이름으로 분기하지 않으므로 새 호스트가 생겨도 이 코드는 바뀌지 않는다.
  - 위반: `checked`가 `host-observed`이고, `host-observed`인 구현자 중 하나가 `checked.actor`와 같거나 `checked.parentChain`에 있다(구현자가 감사·검토를 재위임함).
  - 검증: `checked`와 모든 구현자가 `host-observed`이고(구현자 1명 이상) 위반이 없다.
  - 미관측: 그 밖의 경우. 지금처럼 `unverifiedClaims`로 남긴다. root가 대신 기록한 경우(`unavailable`)가 여기에 든다.
- 숙의 패널 검토자, receipt policy의 단계 actor는 한 호출자가 문서로 기록하므로 계속 미검증이다.

## 4. 계약·파일 변경

| 파일 | 변경 |
| --- | --- |
| `contracts/stage-result.v1.schema.json` | artifact·evidence `verified` 삭제, evidence `digest?` 추가 |
| `contracts/workflow-receipt.v1.schema.json` | 저장 stageResult 산출물·증거에 `check` 추가, `unverifiedClaims` 추가 |
| `contracts/attempt-proposal.v1.schema.json` | `actorId` 삭제, `evidenceRefs` 설명(절대 파일 경로) |
| `contracts/attempt-lease.v1.schema.json` | `priorEvidenceDigests` 추가, `actorId`는 서버 관측값으로 설명 |
| `contracts/convergence-review.v1.schema.json` | `implementationActorIds` 삭제 |
| `contracts/convergence-status.v1.schema.json`, `*-summary.v1.schema.json` | `unverifiedClaims` / `unverifiedClaimCount` |
| `contracts/types.ts` | 위 형식 반영 |
| `mcp-server/src/workflow-service.ts` | §3.1-3.6. 삭제: `currentTarget` 비교, review actor 비교, `verified` 조건 |
| `mcp-server/src/unverified-claims.ts` | 신규(순수 함수) |
| `mcp-server/src/caller-actor.ts` | 신규(개정 1): 검증된 세션 → `ObservedCallerV1` 변환 하나, `independence()` 판정 하나 |
| `contracts/stage-result.v1.schema.json`, `contracts/convergence-review.v1.schema.json` | 개정 1: 서버 필드 `recordedBy`, `observedReviewer` |
| `mcp-server/src/stage-output-file.ts` | `localFileDigest(locator)` export(기존 reader 재사용) |
| `mcp-server/src/server.ts` | claim·resolve에 검증된 세션 actor 전달, 도구 설명 4개 |
| `mcp-server/src/sqlite-workflow-store.ts` | schema v6 migration(§5) |
| `mcp-server/src/receipt-policy.ts`, `provider-semantics.ts`, `cs-engineering-validator.ts`, `engineering-practices-validator.ts`, `continuity-service.ts`, `response-projections.ts` | `check` 사용, count |
| `mcp-server/src/decision-record-validator.ts` | D-0141 |
| `skills/iteration-frame-auditor/scripts/core.mjs` | D-0166: root·proposal 각각 `contract.targetLocations` 집합 = `frame.targetArtifacts[].locator` 집합 |
| `skills/acceptance-evidence-validator/scripts/core.mjs` + report schema·references | D-0037: `AC-` + sha256(기준 문장 UTF-8) 앞 12 hex, 보고서에 id↔문장 표 |
| `skills/orchestrator/references/specialist-handoffs.md`, `skills/independent-audit-gate/references/orchestrator-integration.md`, `docs/architecture.md:20`, `docs/host-execution-attestation.md` | `currentTarget` 삭제, 선언·관측 구분, executionContext = 기록자 profile |
| `scripts/korean-prose-readiness.ts`, `scripts/verify-korean-prose-receipt.ts`, `scripts/record-korean-prose-run.ts` | `check`·`unverifiedClaims` 반영 |
| `mcp-server/dist`, `claude-plugin` | `pnpm build`, `pnpm claude:build` 재생성 |
| `tests/**` | `verified: true` 74곳(39개 파일, grep으로 셈), proposal `actorId`, review `implementationActorIds` 기계적 제거 |

새 도구, 새 DB, 새 키, 새 registry 필드는 없다.

## 5. 저장 데이터 이전(workflow DB v5 → v6)

`sqlite-workflow-store.ts:101`의 `SCHEMA_VERSION`을 6으로 올린다. 기존 `initializeSchema` 쓰기 트랜잭션(`:743-880`) 안에서 한 번만 실행한다. 삭제는 없고 JSON 재작성과 상태 전이만 한다.

1. `workflow_runs.receipt_json`: 산출물·증거의 `verified`를 지우고 `check:"not-checked"`를 넣는다. 예전 값은 서버가 확인한 적이 없다. 그다음 `unverifiedClaims`를 계산한다. `plan`은 건드리지 않아 HMAC이 유지된다.
2. 끝나지 않은 run(`running`, `needs-*`)은 `blocked`로 바꾸고 blocker `pre-3.0-gate-contract`를 단다. 선언=검증 의미로 시작한 run을 새 규칙과 섞지 않는다. convergence attempt도 기존 `convergenceOutcome` 경로와 같이 `failed`로 닫고 시도 1회를 소비한 것으로 둔다.
3. `convergence_leases.proposal_json`에서 `actorId`를 지우고 `lease_json.proposalDigest`를 다시 계산한다. `lease_json`에는 `priorEvidenceDigests: []`를 넣는다. 예전 문자열 근거는 확인한 적이 없으므로 새 근거 판정의 이전 집합에 넣지 않는다.
4. `convergence_reviews.review_json`에서 `implementationActorIds`를 지운다.
5. root 상태는 바꾸지 않는다. 그래야 작업 영역 점유와 lineage baseline 고정이 유지된다.

migration 실패는 트랜잭션 rollback으로 v5를 보존하고 원래 오류 코드를 반환한다. 오류를 숨기지 않는다.

## 6. 시험 계획

새 파일은 `tests/mcp/ags30-gates.test.ts`다. skill 시험은 해당 디렉터리에 둔다. 각 사례는 기준 commit `4b2dc571`에서 실패해야 하고 수정 후 통과해야 한다.

| 결함 | 입력 | 현재 | 기대 |
| --- | --- | --- | --- |
| D-0039 | 2회차 claim, 같은 target, `evidenceRefs:["evidence-2"]`(파일 아님) | lease 발급 | `MISSING_EVIDENCE` |
| D-0039 | 1회차 근거 파일과 같은 바이트를 다른 경로로 제출 | lease 발급 | `NEW_EVIDENCE_REQUIRED` |
| D-0048 | 통과 단계, 실제 임시 파일과 다른 digest | passed | `BINDING_INVALID` |
| D-0048 | 생산자 없는 required input에 evidence 없음 | passed | `MISSING_EVIDENCE` |
| D-0048 | 입력에 `verified:true` | 수용 | `INVALID_INPUT` |
| D-0097 | strict 감사 PASS, `auditorId` = 관측 root actor, `implementationActorIds:["x"]` | passed | `GATE_FAILED`/`AUDITOR_IS_OBSERVED_ROOT` |
| D-0097(개정 1) | `host-observed` 구현자 I, 감사자 A의 `parentChain`에 I | passed | `GATE_FAILED`/`AUDITOR_NOT_INDEPENDENT`. 사슬에 I가 없으면 `actor-independence`·`no-redelegation` 없음, `unavailable`이면 있음 |
| D-0165(개정 1) | `host-observed` 구현자 I가 직접 검토 | 수용 | `GATE_FAILED`/`REVIEWER_NOT_INDEPENDENT`. 다른 관측 actor면 `reviewer-independence` 없음 |
| D-0097·D-0040 | 정상 post-execution 감사 PASS 후 finalize | `unverifiedClaims` 없음 | `actor-independence`, `fresh-context`, `no-redelegation`, `post-execution-state` 포함 |
| 감사 stale | 감사 산출물 파일을 기록 후 수정하고 finalize | passed | `GATE_FAILED`/`AUDIT_TARGET_CHANGED` |
| 감사 대상 | `auditTarget` ≠ 계획의 `audit-target` targetDigest | passed(currentTarget만 같으면) | `GATE_FAILED` |
| D-0047 | `parentRootId`와 승인 ref 1개로 교체 root를 연 뒤 status | 표기 없음 | `unverifiedClaims` 안에 `user-approval` |
| D-0165 | review에 `implementationActorIds` 포함 | 수용 | `INVALID_INPUT`. 정상 review 뒤 status에 `reviewer-independence`, `fresh-context` |
| D-0165 | 도구 목록의 `resolve_convergence_gate` 설명 | "fresh independent" 포함 | 미포함 |
| lease actor | proposal에 `actorId` 포함 | 수용 | `INVALID_INPUT`. lease.actorId = 세션 증명 actor |
| D-0049 | HIGH strict 숙의 PASS | 표기 없음 | `panel-independence` 포함 |
| D-0141 | coverage `[A(origin),B]`, followups `[A→T1]`, TS 검증기 | 통과 | 오류. parity corpus는 Python·TS 동일 판정 |
| D-0339 | 부모 root run baseline M1, 교체 root run baseline M2 | passed | `BINDING_INVALID`/`BASELINE_REBOUND`. 원래 baseline 재결속은 통과 |
| D-0166 | proposal frame target locator ≠ contract `targetLocations` | 수용 | `InputError` |
| D-0037 | 기준 2개 순서를 바꾼 같은 evidence 입력 | 판정 기준 바뀜 | 기준별 판정 불변, 옛 index ID는 거부 |
| migration | v5 DB fixture(running run, legacy proposal/review) 열기 | — | v6, `check:not-checked`, run `blocked`, proposalDigest 재계산, root 상태 불변 |

실행 위치는 테스트 서버 또는 GitHub Actions다. 이 PC에서는 제품 시험을 하지 않는다. 표적 vitest를 실행하고, 그다음 `pnpm test`, `pnpm validate:all`, `pnpm claude:drift`, CI를 실행한다. 대상 commit, 명령, 종료 코드를 남긴다.

## 7. 결함 처리

| 결함 | 같은 형태인가 | 이 설계 후 |
| --- | --- | --- |
| D-0039 | 예 | 해소(§3.1). 근거의 관련성은 `evidence-relevance`로 표기 |
| D-0040 | 예 | phase 동결은 c3d628fa에 있음. 남은 `postExecutionVerified` 선언은 표기로 해소 |
| D-0047 | 예 | 정직한 기록으로 해소. 실제 승인 검증은 3.0 불가(§3.5) |
| D-0048 | 예 | 해소(§3.2) |
| D-0049 | 예 | 인원 검사는 088e4cf7·66d0279a에 있음. 독립성은 표기로 해소 |
| D-0097 | 예(근본) | 한계를 계약에 명시하고 기록자 모순 검사를 추가해 해소. 실제 작업자 관측은 child 신원 설계(binding 쪽, 3.0 이후)에 남음 |
| D-0141 | 국소(TS 사본 불일치) | 해소(§3.4) |
| D-0165 | 예 | 해소(§3.5) |
| D-0166 | 국소 | 해소(§4) |
| D-0336 | 예 | ae323a0b·35018e28의 차단 유지. 변경 없음 |
| D-0337 | 예(선언 spawn 인자) | 8abee6a7 포함. 감사 단계의 `fresh-context` 표기가 남은 한계를 덮음 |
| D-0339 | 예 | MCP 경로 해소(§3.6). 직접 실행은 문서 절차 |
| D-0037 | 국소(식별 결속) | 해소(§4) |
| D-0043 | 아님(registry 메타데이터) | 42f9ab31에 수정. 이 설계 범위 밖 |
| D-0098 | 아님(정의 중복) | 615a0fcc 이후 두 값 모두 `general/high`로 같아 현재는 재현되지 않음. 중복 감시 시험(presets ↔ `stageExecutionRequirement`)만 제안. 이 시험은 현재 코드에서도 통과함 |
| D-0148, D-0150 | 아님(실행 전 검사, TOCTOU) | 6848edc9. 범위 밖 |
| D-0125 | 아님(hash framing) | ffeaf184·47e8f2b6. 장부상 C3 남음. 범위 밖 |
| D-0129 | 아님(저장 전 검증) | 7d767ab6. 범위 밖 |
| D-0133 | 아님(hash 후 후보 변경) | 388557f1. 범위 밖 |
| D-0146 | 아님(schema `$id` 선택) | 5a73bdc1(`schema-validator.ts:407-413`). 범위 밖 |
| D-0149 | 아님(index 형태 검사) | `shared-connection.mjs:105`에 index 포함. 범위 밖 |
| D-0220 | 아님(형식 검사기) | 232d41c2(`addFormats`). 범위 밖 |

"범위 밖" 항목의 수정 commit은 git log·코드 grep으로 존재만 확인했다. 해당 시험은 실행하지 않았다.

## 8. 병행 재설계와 겹치는 곳

`ags-5970-board`, `ags-5970-broker`, `ags-5970-errors`, `ags-5970-binding`은 모두 같은 commit `4b2dc571`이다. 이 작업 전용 설계 문서는 아직 없다(`docs/` 목록으로 확인).

- **binding**: lease actor와 기록자 actor는 binding 쪽이 정하는 "검증된 호출자 actor" 하나만 쓴다. 지금은 `hostActorId(host, sessionId)`다. binding이 형식을 바꾸거나 child 신원을 관측하게 되면 `unverifiedClaims` 규칙에서 해당 claim을 빼는 것으로 연결한다. 미리 추상화를 만들지 않는다.
- **errors**: 새 경우는 기존 코드(`BINDING_INVALID`, `MISSING_EVIDENCE`, `GATE_FAILED`, `INVALID_INPUT`)에 `details.cause` 값을 붙인다: `AUDITOR_IS_OBSERVED_ROOT`, `AUDIT_TARGET_CHANGED`, `BASELINE_REBOUND`. 오류 모델이 cause 체계를 바꾸면 그 이름을 따른다.
- **board, broker**: 직접 겹치는 곳은 없다. continuity 카드의 `verified` → `check`만 바뀐다.

## 9. 사용자 결정이 필요한 것

없다. 다음은 설계에서 정한 선택이며 coordinator가 뒤집을 수 있다.

- 필수 감사 PASS는 막지 않고 `unverifiedClaims`로 기록한다. D-0336처럼 막으면 3.0에서 high·critical orchestrated workflow가 하나도 끝나지 않는다. 고위험 작업은 감사가 자동 추가되기 때문이다(`workflow-service.ts:997-1004`). 평가 유효성은 출력이 릴리스 자격을 스스로 주장하므로(U4) 막는 상태를 유지한다.
