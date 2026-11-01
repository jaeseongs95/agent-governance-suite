# AGS 3.0 오류 모델: 원인 전달 공통 규칙

기준: `feat/ags30-error-model` @ `4b2dc571`. 아래 file:line은 이 커밋에서 직접 확인했다. 결함 행동·원인은 장부 `ags_defects.defect`(읽기 전용 조회)에서 읽었다.

## 1. 판정

**공통 규칙이 근본 수정이다. 다만 새 틀은 필요 없다.** 진단 helper는 이미 있다(`runtime/failure-diagnostics.mjs`: `failureContext`·`tagProducerFailure`·`retainFailureCause`·`retainFailureSecondary`). 지금까지는 결함마다 그 자리에서 고쳐 왔다. 그래서 같은 결정을 곳마다 따로 구현했고, 공개 경계에서 쓸 규칙은 아예 없다.

근거는 다음과 같다.

- 대상 35건(EXC 34 + TST D-0070) 가운데 21건은 현재 코드에서 이미 해소됐다. 10건은 일부만 해소되고 잔여가 있다. 미해소는 3건, 이 패턴이 아닌 것은 1건이다(§5). 장부는 35건 모두 `OPEN`이라 코드와 맞지 않는다.
- 남은 잔여는 결함마다 따로 생긴 버그가 아니다. 아래 다섯 결정이 모듈마다 다르게 내려진 결과다.
  - **P1. 공개 경계에서 계약 밖 예외를 `INVALID_INPUT`으로 바꾼다.** 이런 fallback이 세 개 있다. `server.ts:225-229` `failureResult`, `workflow-service.ts:1966-1973` `toErrorBody`, `state-cleanup-service.ts:55-59` `apiError`다. 셋 다 원문 `error.message`를 공개 응답에 싣는다. 이 밖에 다음 코드도 시스템 실패를 `INVALID_INPUT`으로 낸다.
    - `server.ts:688-695`: 분류 API가 모든 `WorkflowContractError`를 `INVALID_INPUT`으로 바꾼다.
    - `server.ts:807,848`: 정리 저장소가 초기화되지 않았을 때.
    - `stage-validator-process.ts:43`: validator가 JSON을 내지 않았을 때.
    - 저장 상태 손상: `sqlite-workflow-store.ts:189,193,219,748`, `trust-store.ts:224`, `workflow-service.ts:149`, `host-attestation.ts:318`.
  - **P2. 「없다」와 「못 읽었다」를 섞는다.** `=== "ENOENT"`를 직접 비교하는 파일이 31개다. 의미도 서로 다르다. 어떤 곳은 다시 던지고, 어떤 곳은 `cannot access`로 기록하고, 어떤 곳은 ENOTDIR도 부재로 본다. 잔여는 세 곳이다. `codex-token-usage-analyzer/scripts/core.mjs:943-945`(D-0223)는 realpath 실패를 미정규화 경로로 대체한다. 그리고 check-repository의 JSON 루프 두 곳(D-0120)이다.
  - **P3. 정리 오류를 붙이는 방식이 세 가지다.** WeakMap 방식(`retainFailureSecondary`)이 있다. 같은 일을 하는 `retainCleanupFailure`는 엉뚱한 위치(`runtime/unified-state/shared-connection.mjs:26`)에 있다. 세 번째는 `AggregateError`(run-tests, broker-process-lock, skill-import-transaction, glossary-build)다. 2차 오류를 조용히 버리는 곳도 남아 있다: `continuity-store.ts:775`, `sqlite-workflow-store.ts:977-981`.
  - **P4. 원인을 사유로 분류하는 코드가 복제돼 있다.** OS·SQLite 분류표는 `session-message-hook.ts:84-104`에만 있다. 그래서 board·relay·continuity hook에서는 같은 EACCES가 `UNEXPECTED_FAILURE`가 된다. 코드 추출 helper도 여섯 벌이다: `session-message-wake-port.ts:51` `errorCode`, `broker-process-lock.ts:19` `code`, `session-message-broker.ts:36` `brokerFailureCode`, `build-claude-plugin.mjs:434`, `scripts/validate-skill.mjs:10`, `mutation-risk-preflight/scripts/validate-skill.mjs:11`.
  - **P5. 원인을 boolean으로 줄인다.** `continuity-service.ts:689-699` `bindOpenedRoot`가 `catch → false`로 원인을 지운다. `server.ts:751-753`은 원인 없는 이벤트만 남긴다(D-0056).
  - **P6. 호스트 adapter의 단계 실패에 원인이 없다.** `antigravity-hook-runner.mjs:1593-1600,1635-1637,1649-1651,1694-1697,1788,1800`이 그렇다. Claude launcher(`claude-overlay/hooks/*.mjs` `reportLauncherFailure`)는 이미 단계와 코드를 남긴다.

빈 `catch {}`는 지금 문제가 아니다. ESLint `no-empty`가 켜져 있다(`eslint.config.js`에서 끈 파일은 하나뿐이다). 문제는 주석만 있는 catch, `return false`, `continue`처럼 원인을 버리는 catch다.

## 2. 계약 (저장소 전체, 규칙 6개)

**R1. 코드.** 공개 실패는 `WorkflowContractError(code ∈ ERROR_CODE, message, details)`다(`contracts/types.ts:16-38,1035`). 입력을 거절하는 생산자는 직접 `WorkflowContractError("INVALID_INPUT", …)`를 던진다. 일반 `Error`를 던져 놓고 경계의 fallback에 기대지 않는다. 경계에 도달한 그 밖의 모든 예외는 시스템 실패다.

**R2. 공개 경계 매핑.** fallback 세 개를 `contractFailure(error)` 하나로 바꾼다.
- `WorkflowContractError`면 그 code와 details를 그대로 쓴다.
- 그 밖에는 `MCP_UNAVAILABLE`과 고정 문구 "The server could not complete the request."를 쓴다. details는 `{ reason: failureReason(error).reason ?? "INTERNAL_FAILURE", cause: failureContext(error) }`다.
- 원 오류는 `retainFailureCause`로 연결한다.
- 저장 상태 손상(키·sequence·receipt 메타 불일치)은 `INTEGRITY_FAILED`다. 저장소나 설정을 쓸 수 없는 경우(스키마가 더 새것, sequence 소진, 저장소 미초기화)는 `MCP_UNAVAILABLE`이고 사유를 `reason`에 담는다.
- **새 공개 코드는 추가하지 않는다.** `ERROR_CODE`와 `api-result.v1`의 enum은 바뀌지 않는다.

**R3. 부재와 읽기 실패.** ENOENT만 「없음」(null·false·`missing <rel>`)이다. 그 밖의 fs 오류는 둘 중 하나로 처리한다. 다시 던지면서 생산자 사유를 붙이거나(`tagProducerFailure(e, "X_READ_FAILED")`), CLI 보고면 `cannot <op> <rel> (<CODE>)`로 적는다. JSON은 `readFile`과 `JSON.parse`를 다른 try에 둔다. `SyntaxError`만 문법 오류다. 비교 자체는 한 줄이라 helper로 만들지 않는다. 경로 일부가 파일이어서 그 경로가 존재할 수 없는 경우(ENOTDIR)를 부재로 보는 곳은 instruction resolver 한 곳이다. 이것은 그 호출부의 명시적 예외로 둔다.

**R4. 정리 오류.** 주 오류의 정체성(클래스, code, details)은 바꾸지 않는다. 정리 실패는 `retainCleanupFailure(primary, REASON, cleanup)`로 붙이고 `failureContext(...).secondary`로 보이게 한다. 정리 실패가 호출자가 직접 처리할 결과물(남은 임시 폴더 등)인 공개 함수만 `AggregateError([primary, …], msg, { cause: primary })`로 반환 계약에 싣는다. 출력만 하고 끝내는 분기는 두지 않는다.

**R5. 분류와 비노출.** 사유는 다음 순서로 정한다: 생산자 사유 → 허용 목록에 있는 OS code → SQLite 분류 → `SyntaxError`면 `INVALID_JSON` → 없으면 null. 공개 응답과 stderr 진단에 들어갈 수 있는 것은 고정 사유, 허용 목록 code, `failureContext`, 저장소 기준 상대 경로뿐이다. 원문 message, stack, 절대 경로, SQL, stderr 원문, 입력·비밀은 넣지 않는다.

**R6. fail-open hook·adapter.** 동작은 fail-open을 유지한다. 대신 실패한 모든 단계는 `{stage, code}`를 stderr에 한 줄 남긴다. boolean이나 `{}` 반환으로 원인을 지우지 않는다.

## 3. helper (파일 3개, 표준 라이브러리만 사용)

`runtime/failure-diagnostics.mjs`에 다음을 추가한다(skills 스크립트도 `../../../runtime/`로 import한다).
- `failureCode(error) → string | null`: 자체 data property `code`가 `/^[A-Z][A-Z0-9_]{0,63}$/`에 맞을 때만 돌려준다. Proxy와 accessor는 null이다. 복제된 helper 여섯 벌을 대체한다.
- `failureReason(error) → { reason: string | null, basis: "unverified-observation" | "producer" | "unknown" }`: `session-message-hook.ts:84-104`의 분류표와 우선순위를 그대로 옮긴다.
- `retainCleanupFailure`: `shared-connection.mjs:26`에서 옮긴다. 기존 import가 깨지지 않도록 그쪽에서 re-export한다.

`mcp-server/src/failure-diagnostics.ts`에 `contractFailure(error): WorkflowContractError`를 추가한다(R2). contracts가 runtime에 의존하지 않게 하려고 서버 쪽에 둔다.

생략한 것:
- 오류 클래스 계층과 Result 타입. 현재 호출부가 없다.
- 「원인을 버리는 catch」 lint 규칙. 정적으로 구분할 수 없다. 패턴별 시험으로 막는다.
- launcher 다섯 벌의 `reportLauncherFailure` 통합. launcher는 import 실패 자체를 보고해야 하므로 공용 모듈을 import하지 않는다. 의도적인 복제로 둔다.

## 4. 공개 계약 변경 (schema 파일 변경 없음)

`contracts/*.json`과 `ERROR_CODE`는 바뀌지 않는다. `details`는 원래 열린 object다. 바뀌는 것은 응답 값이다.
1. `failureResult`·`toErrorBody`·state-cleanup `apiError`를 거치는 모든 도구의 계약 밖 예외: `INVALID_INPUT`과 원문 message → `MCP_UNAVAILABLE`과 고정 message, `details {reason, cause}`.
2. `classify_skills`·`record_skill_selection`의 host-observation 오류는 자기 code를 그대로 낸다(`BINDING_INVALID`·`MCP_UNAVAILABLE` 등). `details.category`·`reasonCode`·`observationReasonCode`는 유지한다. request-state 거절(`CLASSIFICATION_REQUEST_REJECTIONS`)은 `INVALID_INPUT`으로 남는다.
3. 워크플로·trust DB의 스키마가 더 새것일 때 → `MCP_UNAVAILABLE`(`reason: "SCHEMA_NEWER"`). 저장 키·run sequence·receipt 메타 불일치 → `INTEGRITY_FAILED`. sequence 소진 → `MCP_UNAVAILABLE`.
4. 워크플로 저장소 오류 details에서 `databasePath`와 원문 `cause` 문자열을 지운다. 대신 trust-store와 같은 형태인 `{reason, cause: failureContext}`를 쓴다. `sqliteErrcode`는 continuity hook이 읽으므로(`continuity-hook.ts:151`) 남긴다.
5. `prepare_state_cleanup`·`execute_state_cleanup`이 미초기화 상태일 때: `INVALID_INPUT` → `MCP_UNAVAILABLE`.
6. stage validator의 spawn 실패·signal 종료·status 0인데 JSON이 아님: `GATE_FAILED`/`INVALID_INPUT` → `MCP_UNAVAILABLE`(`reason` 각각 `VALIDATOR_SPAWN_FAILED`·`VALIDATOR_TERMINATED`·`VALIDATOR_OUTPUT_INVALID`). 공개 details에서 `stderr` 원문을 지운다(`childCode`는 유지). 허용되지 않은 status에서 child가 보고한 code를 보존하는 동작은 그대로다.
7. `lookup_korean_prose_terms`의 sourceDigest 불일치는 계속 `INVALID_INPUT`이다. 생산자(`korean-prose-glossary.ts:64`)가 직접 계약 오류를 던지도록 바꾸기 때문이다.

## 5. 결함 → 패턴 → 수정

상태: 해소 = 현재 코드에서 기대 동작 확인. 잔여 = 일부 해소. 미해소. 비해당.

| 결함 | 상태 | 근거(현재 코드) | 패턴 | 수정(파일·함수) |
|---|---|---|---|---|
| D-0012 | 해소 | `claude-overlay/hooks/*.mjs` 단계별 `reportLauncherFailure` | P6 | 없음. `skill-trigger-hook.mjs:14`만 같은 한 줄 진단 추가 |
| D-0016 | 해소 | `session-board-hook.ts:116-120`, `server.ts:342` | P6 | 없음(현황판 재설계가 유지) |
| D-0024 | 잔여 | 생산자 태깅은 됨(`session-message-client.ts:62-272`). `:172` endpoint invalid 미태깅, 분류표가 한 hook에만 있음 | P4 | `failureReason` 이전, `session-message-hook.ts` `reportHookFailure`가 호출. `:172` `BROKER_ENDPOINT_INVALID` 태깅 (broker 겹침) |
| D-0034 | 해소 | `host-attestation-hook.ts:420-433` | P2 | 없음 |
| D-0051 | 해소 | `workflow-service.ts:1243-1255` causeCode·causeDetails | — | 없음 |
| D-0055 | 해소 | `continuity-hook.ts:144-215` | P6 | `reportContinuityFailure`가 `failureReason` 사용(EACCES 등이 `UNEXPECTED_FAILURE`가 되지 않게) |
| D-0056 | 미해소 | `continuity-service.ts:689-699`, `server.ts:751-753` | P5 | `bindOpenedRoot`는 `true` 또는 `{reason, error?}`를 반환(토큰 없음 `BINDING_REQUIRED`, CAS 불일치 `ROOT_BIND_CONFLICT`, 예외는 `failureReason`). server 이벤트에 `reason`·`cause: failureContext` 추가. 루트는 이미 커밋됐고 continuity는 선택 기능이므로 공개 응답은 바꾸지 않음 |
| D-0062 | 잔여 | code는 `MCP_UNAVAILABLE`로 고쳐짐(`sqlite-workflow-store.ts:1015-1023`). details에 `databasePath`·원문 message | P1 | `storageError`를 trust-store 형태로. `:189,193,219,748` 코드 교정(§4-3) |
| D-0063 | 해소 | `trust-store.ts:290-297`, `server.ts:742` | — | `:224` 스키마 newer만 §4-3 |
| D-0064 | 해소 | `inactive-shared-stores.ts:48-51` | P3 | import 경로만 runtime으로 |
| D-0065 | 해소 | `session-message-store.ts:1560-1563` | P3 | `retainCleanupFailure` 한 줄로 교체(선택) |
| D-0068 | 해소 | `runtime.ts:91-97`, `server.ts:699-702` | — | 없음 |
| D-0069 | 잔여 | `server.ts:688-695` 계약 오류 전부 `INVALID_INPUT` | P1 | 자기 code 유지(§4-2). 마지막 else(`:703-705`)에 `reason`·`cause` 추가 |
| D-0070 | 미해소 | `jev-cause-api-regressions.test.ts:159`, `skill-classification-gateway.test.ts:329-331,337-338`, `ags30-al09-owned-regressions.test.ts:86`. 같은 고정: `workflow-store-storage-errors.test.ts:96-99`, `workflow-service.test.ts:464-469`, `stage-validator-failure.test.ts:70-86` | P1(시험) | 기대값을 §4의 code·reason으로 바꾼다. 원인 보존을 검사한다 |
| D-0071 | 해소 | `native-adapters.ts:209-217` | — | 없음 |
| D-0072 | 잔여 | 단계 구분은 됨(`native-adapters.ts:221-223`). 준비 실패 원인 소실 | P4 | 그 catch에서 `retainFailureCause(new ClassificationProviderError(...), error)` |
| D-0104 | 잔여 | `evaluate-preflight.mjs:247-262` 거짓 input-validity는 없어짐. 진단에 code 없음 | P4 | stderr 진단에 `code: failureCode(error)` |
| D-0109 | 해소 | `import-skill.mjs:39-47`, `source-lock.mjs:38-43` | P2 | 없음 |
| D-0112 | 해소 | `build-claude-plugin.mjs:434-503` | P2 | `describeFileFailure` 안의 정규식을 `failureCode`로 |
| D-0113 | 해소 | 두 `validate-skill.mjs` 모두 ENOENT만 missing. 단 하나는 다시 던지고 하나는 기록 | P2 | `workspace-convention-profiler/scripts/validate-skill.mjs:9,16-18`을 R3 보고형으로 통일 |
| D-0114 | 해소 | `scripts/validate-skill.mjs:18-56` | P2 | `failureCode`로 교체 |
| D-0116 | 해소 | `validate-repository.mjs:33-46` | P2 | 없음 |
| D-0117 | 잔여 | `iteration-frame-auditor/scripts/core.mjs:141-146` details 보존. `InputError`가 아닌 내부 예외도 검증 오류 문자열이 됨 | P1 | `InputError`가 아니면 다시 던진다 |
| D-0119 | 해소 | `korean-prose-evaluation-preflight.ts:445-456` | P2 | 없음 |
| D-0120 | 잔여 | access 루프는 해소. JSON 루프 `blocker-diagnostician/scripts/check-repository.mjs:19-21`, `acceptance-evidence-validator/scripts/check-repository.mjs:22-24`는 read 실패도 `invalid JSON` | P2 | read와 parse를 다른 try로 분리(R3) |
| D-0121 | 해소 | `run-python-validations.mjs:10-15` | P2 | 없음 |
| D-0122 | 잔여 | 상태를 먼저 판정함(`stage-validator-process.ts:24-43`). `:43` parse → `INVALID_INPUT`, `:26` spawn → `GATE_FAILED`, `:41` stderr 공개 | P1 | §4-6 |
| D-0124 | 해소 | `stage-validator-process.ts:37-41` childCode 보존 | — | 없음 |
| D-0137 | 해소 | `resolve-instruction-files.mjs:32-40` | P2 | 없음 |
| D-0181 | 잔여 | src hook은 해소(`session-message-hook.ts:159-160,402-404`, `session-board-hook.ts:167-170`). 같은 패턴이 agy runner에 남음 | P6 | `antigravity-hook-runner.mjs`에 `reportStageFailure(stage, cause)` 하나를 두고 §1 P6의 6곳에서 호출. fail-open/deny 판정은 그대로 (현황판 겹침) |
| D-0184 | 해소 | `session-message-hook.ts:660-671`, `session-board-hook.ts:157-166`, Claude launcher | P6 | 없음 |
| D-0210 | 잔여 | WeakMap 제거, `AggregateError`(`run-tests.mjs:91-95`). child nonzero이면서 정리 실패인 갈래(`:96-100`)는 출력만 함 | P3 | 그 갈래도 `Error(code RUNNER_CLEANUP_FAILED, cause, childExitCode)`를 throw. 갈래 2개(dual·정리 단독). `main`이 `childExitCode`를 읽음 |
| D-0214 | 해소 | `broker-process-lock.ts:231-250`, `session-message-broker.ts:605-615` | P2 | `:611` 임시 파일 `/* Best effort */`는 broker 재설계에 넘김 |
| D-0223 | 미해소 | `codex-token-usage-analyzer/scripts/core.mjs:943-945` realpath 실패 → `path.resolve`. `:873-888` 격리 검사 입력 | P2 | `canonicalExistingPath`는 ENOENT일 때만 대체값(없는 root 아래에는 아무것도 없음). 그 밖은 다시 던져 검사 실패로 |
| D-0302 | 비해당 | 운영 episode, 장부 root_cause `UNKNOWN` | — | 이 설계 범위 밖. P4·R6 진단이 원인 분리에 쓰일 뿐 |

장부에 없는 같은 패턴 사이트도 함께 고친다(P1·P3). `server.ts:807,848`, `workflow-service.ts:149`, `host-attestation.ts:318`, `trust-store.ts:224`, `continuity-store.ts:775`, `sqlite-workflow-store.ts:977-981`(`retainCleanupFailure`), `korean-prose-glossary.ts:64`(계약 오류로), `server.ts:643`(`cause` 추가)이다.

## 6. 시험 계획 (Linux 시험 서버에서 실행, 이 PC에서는 실행하지 않음)

패턴마다 하나씩이다. 모두 현재 코드에서 실패해야 한다.
- **P1** `tests/mcp/error-contract-boundary.test.ts`
  - 서비스가 `new Error("/private/path token=SECRET")`를 던질 때 → `MCP_UNAVAILABLE`, `reason: "INTERNAL_FAILURE"`, 응답 직렬화에 경로와 비밀이 없어야 한다. `failureResult`·`attempt`·state-cleanup 세 경계를 표로 돈다.
  - 분류 host-observation이 `MCP_UNAVAILABLE`을 던질 때 → 그 code가 그대로 나와야 한다.
  - `user_version=99` DB → `MCP_UNAVAILABLE`/`SCHEMA_NEWER`. details에 `databasePath`가 없어야 한다.
  - validator timeout → `MCP_UNAVAILABLE`/`VALIDATOR_SPAWN_FAILED`.
  - 회귀 확인: glossary sourceDigest 불일치는 계속 `INVALID_INPUT`이다.
- **P2** `tests/tooling/fs-absence-vs-read-failure.test.mjs`. 실행 계정이 root여도 결정적이도록 권한 대신 EISDIR(필수 JSON 경로에 디렉터리)과 ELOOP(심볼릭 링크 순환)를 쓴다.
  - check-repository 두 개 → `invalid JSON`이 아니라 `cannot read … (EISDIR)`여야 한다.
  - D-0223: sessionsRoot가 링크 순환일 때 저장이 거부돼야 한다.
- **P3** `tests/mcp/cleanup-secondary.test.ts`
  - 워크플로·continuity 트랜잭션에서 operation이 A, ROLLBACK이 B를 던질 때 → A가 throw되고 `failureContext(A).secondary`에 B가 있어야 한다.
  - `runTests`: child exit 1이고 rmSync가 실패할 때 → reject, `code RUNNER_CLEANUP_FAILED`, `childExitCode 1`.
- **P4** `tests/runtime/failure-diagnostics-reason.test.mjs`
  - `failureReason`: EACCES → `EACCES`, SQLite errcode 5 → `STORE_BUSY`, 생산자 사유 → `producer`.
  - `failureCode`: Proxy·accessor·소문자 → null.
  - 회귀 확인: continuity hook이 EACCES 원인을 `EACCES`로 보고한다.
- **P5** `bindOpenedRoot`의 store가 throw할 때 → server stderr 이벤트에 `reason`·`cause`가 있어야 한다.
- **P6** agy runner에서 stage가 throw할 때 → stderr에 `{stage, code}` 한 줄이 남고, 기존 fail-open/deny 결과는 같아야 한다.
- **D-0070** §5 표에 적힌 시험 파일의 기대값을 갱신한다.
- 해소 21건은 기존 회귀 시험을 그대로 돌려 녹색이면 근거로 쓴다.
- 전체 순서는 AGENTS.md를 따른다. `bundle:check` → `claude:drift` → `lint` → `build` → `test` → `runtime:check` → `validate:all` → `validate:official`. runtime·server를 바꾸므로 `mcp-server/dist`를 다시 생성한다.

## 7. 작업 단위 (커밋 단위)

1. runtime helper 3개와 `contractFailure`, P4 시험.
2. P1 경계: 세 매퍼, 분류 분기, `server.ts:807,848`, glossary 생산자, D-0070 시험 갱신.
3. P1 생산자: 저장 상태 code 교정, 워크플로 저장소 details 비노출, stage validator.
4. P3: rollback 두 곳, run-tests.
5. P2: check-repository JSON 루프, D-0223, validate-skill 통일, preflight·iteration 잔여.
6. P5·P6과 겹치는 부분: `bindOpenedRoot`, native 준비 실패 원인, `session-message-hook` 분류표 이전, client `:172`, agy runner, `skill-trigger-hook`.

## 8. 병렬 재설계와 겹치는 곳 (그 사본은 수정하지 않음)

- **현황판(`ags-5970-board`, `docs/ags30-session-board-design.md`)**: `server.ts` `sessionBoardResult`를 다시 쓰고 `session-board-hook.ts`·`governance-hook.ts` board 분기를 정리한다. agy runner `:1581,1617-1618`도 건드린다.
  - 이 설계는 `sessionBoardResult`와 `session-board-hook.ts`를 고치지 않는다. 공용 함수 `failureResult`만 바꾸므로 board 쪽은 R2를 그대로 물려받는다. board 문서가 정한 `MCP_UNAVAILABLE {step, cause}`도 R2와 맞는다.
  - agy runner 단계 루프(`:1590-1640`)는 글자 단위로 겹칠 수 있다. 6단계를 board 병합 뒤에 rebase한다.
- **broker(`ags-5970-broker`, 설계 문서 아직 없음)**: `session-message-client.ts:172`, `session-message-hook.ts` 분류표 이전, `session-message-broker.ts:611`이 겹친다.
  - R2와 반대 방향의 오표기도 있다. `session-message-service.ts:61-101`이 broker의 입력 거절(`BrokerRequestRejected`)까지 `MCP_UNAVAILABLE`로 내고 broker message 원문을 공개한다. 이것은 broker 프로토콜에 거절 code가 있어야 고칠 수 있다. 그래서 broker 재설계에 넘기고, R1·R2를 그쪽 계약에 적용하도록 요청한다.

## 9. 사용자 결정이 필요한 것

없다. 다만 §4의 1·2·3·5·6은 공개 응답의 code를 바꾼다. 클라이언트가 `INVALID_INPUT`·`GATE_FAILED`를 보고 분기하고 있다면 3.0 릴리스 노트에 적어야 한다. 3.0은 2.x 호환 대상이 아니다.
