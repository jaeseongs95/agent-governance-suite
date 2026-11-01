# AGS 3.0 깨우기 재설계: 초인종(doorbell) 모델

- 상태: 설계안 r3.2(2026-11-01). r3 재검토 두 건(상태기계 N1·F1~F4, SOLID B-N1·B-N2·S-N1~S-N3)을 반영했다.
- 이전 상태: 설계안 r3. r2 설계 검토(상태기계·동시성, SOLID·벤더 비종속)의 blocking 4건·should-fix 12건을 반영했다.
- 근거:
  - 토론 판정(HIGH, 「구조 결함」)
  - 사용자 지시 「다 뜯어고쳐」「구조 뜯어고치기전에 설계부터해」
  - 개발가이드 「벤더 비종속 설계와 공통 계층 구현 원칙」
- 결함: AGS-D-0353(상위), D-0354, D-0304, D-0364, D-0329, D-0305, D-0169.
- 줄 번호는 c5343231 기준이다. 파일 약어는 다음과 같다.

| 약어 | 파일 |
|---|---|
| S | `mcp-server/src/session-message-store.ts` |
| P | `…/session-message-wake-port.ts` |
| R | `…/session-message-relay.ts` |
| H | `…/session-message-hook.ts` |
| A | `…/builtin-hook-host-adapters.ts` |
| I | `…/host-input-adapter.ts` |
| B | `…/session-message-broker.ts` |

## 1. 문제

**잘못된 가정.** 호스트에 넘긴 표식을 "소비를 관측할 수 있는 1회성 토큰"으로 보고, 대상당 슬롯 하나(`wake_active_target`, S:354)를 그 관측에 묶었다.

**실제 호스트 대기열.** 수신 확인과 취소가 없다. 호스트마다 성질도 반대다.

| 호스트 | 대기열 동작 | 근거 |
|---|---|---|
| Codex | 영속 저장한다. Running·Interrupted·Shutdown 상태에서는 대기열을 꺼내지 않는다. | Codex 0.165 `ext/queue/src/service.rs` 218-226·476-477·551-552 |
| Claude | 보류한 메시지를 `dialogExpiry`(기본 5분)가 지나면 버린다. | — |
| agy | 표식 관측 hook 경로가 없다. | `antigravity-connector/hooks/antigravity-hook-runner.mjs` 1285-1394 |

**결과.**
- 회수 규칙이 "누적"과 "영구 잠금" 사이를 오갔다. 11-01 하루에만 네 번 뒤집혔다(9aad6393 → bc0d1821 → 4133a861 → c5343231).
- 본문은 이미 nonce 없이 턴 종료와 도구 경계에서 인수된다(S:752-778). 즉 nonce는 본문 권한의 경계가 아니다.
- 미지원, 실패, 미확인이 섞여 있어서 항상 실패하는 경로도 `available`로 보고된다(D-0364).

## 2. 공통 계약 (벤더를 바꿔도 같은 의미)

모든 시각은 store의 기준 시각(authority time)이다. 공유 모드는 `shared.time`, 독립 모드는 broker 단일 프로세스의 `Date.now()`를 쓴다. 상한도 이 시간으로 잰다.

### 2.1 의미
- 깨우기는 "받은함을 보라"는 초인종이다. 전달 보장은 기존 claim/ACK가 맡는다.
- 시도 하나가 행 하나다. 대상당 활성 시도는 최대 하나이고(I5), 이것은 잠금이 아니라 슬롯이다.
- 출생(birth)마다 깨우기 경로 상태를 하나 둔다(2.3).

### 2.2 시도 상태

| 상태 | 의미 | 활성 | 들어오는 경로 |
|---|---|---|---|
| `reserved` | 울리기로 정했고 아직 넘기지 않았다. 외부 효과가 없다. | 예 | reserve |
| `started` | start CAS를 통과했고 어댑터를 호출하는 중이다. | 예 | start |
| `handed-off` | 호스트가 받았다고 응답했다. 소비 여부는 모른다. | 예 | outcome |
| `unknown` | 넘긴 결과를 알 수 없다. | 예 | outcome, 또는 `started` 시간 초과 |
| `observed` | 현재 출생의 hook이 이 표식을 봤다. | 아니오 | 표식 도착 |
| `released` | 관측 없이 끝났다. `release_reason`이 붙는다. | 아니오 | 2.5 |
| `not-delivered` | 확정적으로 넘기지 못했다. 외부 효과가 없다. | 아니오 | outcome |

- **`started` 시간 초과.** `WAKE_START_TIMEOUT_MS`(60초)가 지나도 결과가 없으면 `unknown`으로 바꾼다. 이 값은 어댑터 호출 timeout(P:250·287·301, 5-10초)보다 길고, 가장 짧은 재울림 기준값보다 짧다.
  - relay는 start CAS를 할 때 포트의 `resendBaseMs`를 넘기고, 행에 `resend_base_ms`로 저장한다.
  - 시간 초과로 `unknown`이 될 때는 `outcome_at = now`와 `resend_due_at = now + min(resend_base_ms·2^streak, 24h)`를 함께 쓴다. 이렇게 해서 넘긴 상태의 모든 행이 `outcome_at`과 `resend_due_at`을 갖게 한다(r3 N1).
- **결과 기록.** `started`나 `unknown` 상태이고 attempt_id와 epoch가 같은 행에만 적용한다.
  - 행이 이미 끝난 뒤에 도착한 결과는 행 상태를 되살리지 않는다.
  - 출생 상태(2.3)는 attempt_id와 epoch가 맞으면 갱신한다. 따라서 늦게 온 실패도 재시도 대기와 실패 집계에 반영된다(r2 B1 해소).
- **재시도.** 항상 새 행과 새 nonce로 한다. 같은 행을 `reserved`로 되돌리지 않는다(r2 S5 해소).
- **지우는 것.** `legacy` 상태, broker 연산 `claim-wake`·`release-wake`, `reserve-wake`의 legacy 분기(B:585-593)는 src에 호출처가 없어서 지운다. relay가 쓰는 관리형 `reserve-wake`(R:104, B:580-583)는 남긴다(r3 B-N2). 프로토콜 버전(`session-message-protocol.ts:5`)을 올린다.
- **남기는 것.** `consumeWake`(현황판 hook `session-board-hook.ts:114`가 쓴다, B:612)는 남긴다. 다만 상태와 만료를 따지지 않고 "이 대상의 표식으로 인식되는지"만 확인하도록 바꾼다.

### 2.3 출생별 깨우기 경로 상태
새 표 `wake_paths(host, session_id, instance_id, birth_generation, streak, failures, last_failure_at, retry_not_before, prerequisite_missing, claim_boundary_at, updated_at)`를 둔다. 기본 키는 (host, session_id, instance_id, birth_generation)이다. 2.7의 결합 검사와 같은 단위다(r3 S-N3).

| 열 | 의미 |
|---|---|
| `streak` | 연속 무응답 횟수 |
| `failures` | 연속 확정 실패 횟수 |
| `retry_not_before` | 실패 뒤 backoff가 끝나는 시각 |
| `prerequisite_missing` | 어댑터가 알린 전제조건 결손 사유 코드. 이 출생 동안 유지한다. |
| `claim_boundary_at` | 이 출생에서 본문을 인수할 수 있는 경계를 마지막으로 지난 시각 |

- **`claim_boundary_at`을 쓰는 곳.** `claimTurnEnd`, `claimHostWake`, `claim`, 그리고 건너뛰지 않은 `claimDeferred`다.
- **활동만 기록하는 경로는 경계가 아니다.** `observeNativeInput`, `clearDeferred`, 건너뛴 `claimDeferred`(S:755-757)는 `claim_boundary_at`을 쓰지 않는다.
- **기존 `session_activity` 표**는 다른 소비처가 없으면 지운다.
- **수명.**
  - reserve할 때와 경계를 기록할 때 upsert한다.
  - prune은 최신 live 출생이 아니면서 활성 시도도 없는 행을 지운다.
  - 새 출생은 0에서 시작한다(r3 F2).
- **`claim` 도구 경로.** MCP `claim`은 `assertHookInstance`를 거치지 않는다(S:676-688). 그래서 현재 live 출생이 있을 때만 그 출생의 `claim_boundary_at`을 쓰고, 없으면 쓰지 않는다(r3 F4).

### 2.4 넘긴 결과 분류 (어댑터 → 공통)
어댑터는 다음 셋 중 하나만 돌려준다.

| 결과 | 뜻 | 처리 |
|---|---|---|
| `handed-off` | 호스트가 받았다. 소비는 모른다. | — |
| `unknown` | 받았는지 알 수 없다. 예: spawn 뒤 0이 아닌 종료, timeout | — |
| `not-delivered{kind, reasonCode}` | 확정 실패이고 외부 효과가 없다. | kind별로 아래와 같다. |

`not-delivered`의 kind:
- `handed-off`나 `unknown` 결과를 기록하면 출생 상태의 `failures`를 0으로 되돌린다(r3 F1).
- **`transient`.** 출생 상태의 `failures`를 1 늘리고 `retry_not_before`를 `now + wakeBackoffDelay(failures)`로 잡는다.
  - `failures ≥ WAKE_FAILURE_LIMIT`(5)이면 보고는 `degraded/wake-failing`이 된다.
  - 재시도는 backoff 상한(10분)으로 계속한다. 생존성을 위해서다.
  - 예: Codex `No active session found`. 시작 직후에 잠깐 나는 실패일 수 있다(r2 S3/SOLID 11).
- **`prerequisite-missing`.** 이 출생의 실행 환경에 필수 조건이 없다. 예: 실행 파일 ENOENT, messaging socket·token env 없음, project id·agentapi 없음, 메타데이터 불일치.
  - `prerequisite_missing`을 기록하고 이 출생 동안 다시 울리지 않는다.
  - 보고는 `degraded/wake-prerequisite-missing`이다.
  - 출생이 바뀌면 다시 시도한다.

`unsupported`는 결과 값이 아니다. 능력 선언(`idleWake: none`이거나 `peer-wake` 미지원, S:947)에서만 나온다(SOLID B2: 미지원과 실패를 섞지 않는다). `target-unavailable`은 이 값을 만드는 곳이 없어서 지운다. 기존의 presence 종료 효과(S:1444)도 함께 지운다.

### 2.5 울리기 조건 (reserve, start CAS 안에서 다시 확인)
1. 현재 출생의 presence가 online이고, relay lease가 live이고, `peer-wake`를 지원한다(기존 `wakeBindingCurrent`).
2. 인수할 수 있는 본문이 있다(기존 `wakeClaimable`).
3. 활성 시도가 없다.
4. 출생 상태에 `prerequisite_missing`이 없고 `retry_not_before`가 지났다.
5. **조용함(최적화).** `claim_boundary_at`이 `now − WAKE_QUIET_MS`(60초)보다 이전이다.
   - 예외가 있다. 인수 가능한 본문 중 가장 오래된 것이 `WAKE_QUIET_MAX_MS`(10분)보다 오래 기다렸으면 이 조건을 무시한다(r2 S1 해소).
   - 이 조건은 정확성 조건이 아니다. 바쁜 세션에 표식을 덜 쌓으려는 최적화다.
   - hook이 없는 긴 작업(Codex의 긴 단일 도구 호출)은 이 조건으로 알아낼 수 없다.

### 2.6 넘긴 시도가 끝나는 조건
`handed-off`·`unknown` 상태만 대상이다. `started`는 2.2의 시간 초과로만 `unknown`이 된다(r2 B1 해소). 아래 중 하나라도 참이면 `released`로 바꾼다.

| `release_reason` | 조건 | 의미 |
|---|---|---|
| `claimed-after-handoff` | 출생 상태의 `claim_boundary_at`이 넘긴 시각(`outcome_at`) 이후다. | 세션이 본문 인수 경계를 지났다. 그 경계에서 대기 본문은 인수됐다. 표식 소비의 증거는 아니다. agy처럼 표식을 관측하지 못하는 호스트는 이 조건으로 슬롯을 비운다. |
| `birth-ended` | 시도의 출생이 더 이상 최신 live 출생이 아니다. | — |
| `resend-due` | `resend_due_at <= now`이다. | — |

`resend_due_at`:
- 결과를 기록할 때 `outcome_at + min(base × 2^streak, WAKE_RESEND_MAX_MS)`로 저장한다.
- `base`는 relay가 포트 선언(3.1)에서 읽어 `record-wake-outcome`에 넘긴다. 클라이언트 hook이 보낸 값은 쓰지 않는다(SOLID 3).

**streak 계산(r2 B2 해소).**
- `resend-due`로 끝나면 출생 상태의 `streak`를 1 늘린다.
- 다음 경우에 0으로 되돌린다.
  - `observed`
  - `claimed-after-handoff`
  - 넘긴 시각 이후의 표식 도착 인수(2.7)
- `birth-ended`와 `not-delivered`는 streak를 바꾸지 않는다. 시도 행이 삭제돼도 출생 상태는 남으므로 0으로 돌아가지 않는다.

**`reserved`가 끝나는 경우.**
- `expires_at <= now`이면 무조건 `released`(이유 `expired`)로 바꾼다(r2 S2 해소).
- 기존 규칙(넘기기 전 다른 출생으로 교체, 본문이 다 인수됨 → `not-delivered`)은 유지한다.

### 2.7 표식 도착 처리 (`claimHostWake`)
- **현재 출생의 표식.** 검증된 표식의 행이 현재 presence와 결합이 같으면(instance·birth·transport·online·peer-wake, S:1561-1564와 같은 검사) 대기 본문을 인수한다. 행의 상태와 nonce 만료는 따지지 않는다.
  - 활성 행이면 `observed`로 바꾼다.
  - 이미 끝난 행이면 `late_observed_at`만 기록한다.
  - 출생 상태의 `claim_boundary_at`을 갱신한다.
- **다른 출생의 표식.** 본문을 인수하지 않는다(I2). 도착 증거만 남긴다.
- **보관.** 끝난 행은 `WAKE_RESEND_MAX_MS`(24시간) 동안, 최대 1000행까지 보관한다(S:395-399를 바꾼다). 보관 기간이 지난 뒤 도착한 표식은 인식되지 않고 본문도 인수하지 않는다. 시험으로 고정한다(SOLID 7).
- **중복과 늦은 도착.**
  - 인수한 본문이 없고 행이 모두 끝난 상태면 `retired: true`를 돌려준다(기존과 같다).
  - claim lease가 만료된 뒤 늦게 온 표식은 본문을 다시 받을 수 있다. 이것은 기존 재전달 규칙(lease 만료 → 재인수, S:598-627)과 같다. I6은 receipt와 ACK, 그리고 수신자의 messageId 기준 중복 제거로 지킨다.

### 2.8 상태 보고 (`SessionAutoWakeOutlookV1` → v2)
사실만 보고한다. `latched`는 없앤다.

| state | reason | basisAt | 뜻 |
|---|---|---|---|
| `available` | `relay-live` | relay 갱신 시각 | 울릴 수 있다 |
| `available` | `wake-in-flight` | 넘긴 시각 | 넘긴 뒤 관측창(60초) 안이다 |
| `available` | `wake-unanswered` | `resend_due_at` | 관측창이 지났고 응답 근거가 없다. 호스트가 붙잡았거나 버렸을 수 있다. |
| `available` | `recipient-active` | `claim_boundary_at` | 최근에 본문 인수 경계를 지났다(사실만, 예측 없음) |
| `available` | `retry-backoff` | `retry_not_before` | 일시 실패 뒤 대기 중이다 |
| `degraded` | `wake-failing` | `last_failure_at` | 연속 일시 실패가 상한에 닿았다 |
| `degraded` | `wake-prerequisite-missing` | 판정 시각 | 이 출생에서 깨우기 전제조건이 없다. 경계 인수만 남는다. |
| `unsupported` | `no-idle-wake` | 출생 시각 | 능력 선언상 깨울 수 없다 |
| `no-live-relay` | 기존 사유 | 기존 | 기존과 같다 |

함께 바꿀 소비처:
- `contracts/session-auto-wake-outlook.v1.schema.json`을 v2로, `contracts/types.ts:357-364`, `claude-plugin/contracts/` 미러
- MCP 안내문(`server.ts:383·597·609`): `degraded`일 때 송신자 규칙을 추가한다. 상대가 경계에서 인수하기 전까지 늦을 수 있다고 알린다.
- `docs/session-message-lifecycle.md`
- hook의 relay 복구 생략 조건(H:532). outlook에서 추정하지 않는다. `list-presence`가 내보내는 명시적 `relayLive`를 쓴다(SOLID 8).

## 3. 벤더 구현체 책임

### 3.1 포트 선언 (`WakeDispatchPort`, P:20-25)
기존 `capabilities`, `observesNativeLaunch`, `dispatch` 옆에 하나를 추가한다.
- `resendBaseMs: number`: 관측되지 않은 시도를 다시 울렸을 때 효과가 있을 것으로 보는 기준 시간이다.

`DeliveryCapabilities`(hook → presence로 저장된다)에는 넣지 않는다(SOLID 3).
- broker는 `start-wake`·`record-wake-outcome` 요청의 `resendBaseMs`를 검사한다. 양의 정수이고 `WAKE_RESEND_MAX_MS` 이하여야 하며, 아니면 요청을 거부한다(r3 S-N2). `observesWakeMarker`는 동작에 쓰이지 않는 추측성 필드라서 두지 않는다(SOLID 4).

### 3.2 transport별 연결

| transport | 넘기기 | resendBase | `prerequisite-missing` | 근거 |
|---|---|---|---|---|
| `codex-queue` | `codex queue --thread` | 20분 | ENOENT | 영속 대기열이다. 기본 TTL 60분 안에 두 번 재울림 기회가 있고, 대기열에 붙잡힌 표식은 하루 약 7개 이하다. 실호스트 측정으로 조정한다. |
| `claude-inbox` | messaging socket (`priority:"next"`) | 10분 | socket·token env 없음 | `dialogExpiry` 5분에 여유를 더했다 |
| `antigravity-queue` (구 `gemini-queue`) | `agentapi send-message` | 10분 | project id·agentapi 없음, 메타데이터 불일치 | 공개 계약이 없으므로 유실될 수 있다고 본다 |
| `codex-deferred` | 없음 | — | — | `idleWake: none` → `unsupported`. dispatch에는 도달할 수 없으므로 호출되면 오류를 던진다. |

- **transport 이름 변경 이행(r3 S-N1).**
  - 4장 DB 변환에서 presence·relay_leases·wake_nonces의 `gemini-queue` 값을 `antigravity-queue`로 바꾼다.
  - relay-cli의 허용 목록(`session-message-relay-cli.ts:19`)은 하드코딩하지 않고 조립 모듈 `wake-transports.ts`에서 받는다.
  - 설정 env `AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE`는 antigravity용 `AGENT_GOVERNANCE_ANTIGRAVITY_QUEUE_WAKE`로 옮긴다. 3.0은 옛 이름을 받지 않는다(2.x 비호환).
  - 문서 `docs/session-message-lifecycle.md:133`과 `antigravity-connector` 시험 2곳을 함께 고친다.
- **antigravity와 gemini 분리.** gemini host는 `gemini-deferred`(`idleWake: none`)에 매핑한다. antigravity만 `antigravity-queue`를 쓴다. 설정 키 `"gemini"` 공유(A:362)도 나눈다(SOLID 4).
- **결과 매핑.** `codexWakeOutcome`, `claudeWakeOutcome`, `geminiWakeOutcome`(P:29-37)을 2.4의 세 값과 kind로 다시 쓴다.

### 3.3 파일 경계
| 파일 | 담는 것 |
|---|---|
| `session-message-wake-port.ts` | 공통만: 포트 인터페이스, 결과 타입, backoff, hook 관측 영수증, 공통 진단 |
| `wake-transport-codex.ts`, `wake-transport-claude.ts`, `wake-transport-antigravity.ts` | 각 `ring*`, 결과 매핑, 포트 선언값, 벤더 진단. `ANTIGRAVITY_*` 진단(P:222)도 여기로 옮긴다. |
| `wake-transports.ts`(조립 전용) | 포트 등록표(P:337-348). 공통 파일은 벤더 파일을 import하지 않는다(SOLID 10). |

- relay의 re-export(R:10)는 지운다. A:11과 `tests/session-messaging/session-message.test.ts:35`의 import를 고친다.
- store에는 벤더 이름 분기가 없다. S:418의 Codex 언급 주석은 일반 문장으로 바꾼다.

## 4. DB 변환 (3.0 스키마, user_version 3)
- CHECK(S:43·329)와 DEFAULT `'legacy'`는 제자리에서 바꿀 수 없다. 따라서 `wake_nonces`를 트랜잭션 하나 안에서 다시 만든다.
  - 복사 열 목록에 `retired_at`을 넣는다(S:44에는 빠져 있다).
  - 새 열은 `release_reason`, `resend_due_at`이다.
- **상태 이름 옮기기**(INSERT…SELECT의 CASE):

| 기존 | 새 |
|---|---|
| `submitted` | `handed-off` |
| `not-submitted` | `not-delivered` |
| `expired-unobserved` | `released`(이유 `migrated`) |
| `legacy` | 삭제 |
| `unknown` + `late_observed_at` 있음(옛 DB에만 있다) | `released`(이유 `migrated`) |
| `started` | `unknown` |

- 그 뒤 `wake_active_target`을 새 활성 상태 목록으로 다시 만든다. 기존 인덱스는 DROP한 뒤 CREATE한다.
- 옮긴 활성 행(`handed-off`·`unknown`)에는 `outcome_at = coalesce(outcome_at, started_at)`, `resend_base_ms = 600000`, `resend_due_at = outcome_at + 10분`을 채운다. 변환된 행이 영구히 잠기지 않게 하기 위해서다(r3 N1).
- `wake_paths`를 만든다. 기존 활성 행의 출생마다 streak 0으로 채운다.
- user_version을 3으로 올린다. 2.x broker는 기존 `storedVersion > MESSAGE_SCHEMA_VERSION` 검사(S:193-194)에 걸려 이 DB를 열지 못한다.

## 5. 지우는 것
- `retireUnobservedWakes`의 활동·출생 OR 묶음, 10/70분 CASE, `prior_unobserved` 열
- `reconcileHistoricalWake` 전부
  - store(S:1483-1526)
  - broker 연산과 참조(B:13·370·601-608·685-686·714)
  - CLI(`session-message-cli.ts:9`)
  - `inactive-shared-stores.ts:7·47`
  - historical 전용 영수증 검증 코드(P:381-411 중 이것만 쓰는 부분)
  - 시험 `historical-wake.test.mjs`
  - fixture `managed-wake-process.mjs:79`
- legacy 깨우기 경로: `claimWake`, legacy `reserveWake`, `releaseWake`, broker의 `claim-wake`·`release-wake`, `reserve-wake`의 legacy 분기(B:585-593). `consumeWake`는 2.2에 따라 남긴다.
- `target-unavailable`, autoWake `latched`, `wakeObservationOverdue`, `session_activity`(다른 소비처가 없을 때)
- 영구 잠금을 단정하는 시험

## 6. 불변식 (시험으로 고정)
- **I1** 위조한 nonce나 출처를 세탁한 표식으로 본문을 인수할 수 없다.
- **I2** 이전 출생의 표식은 현재 출생의 본문을 인수할 수 없다.
- **I3** 독립된 두 연결이 동시에 울려도 외부 호출은 한 번이다(start CAS).
- **I4** 결과를 기록한 뒤 응답을 잃어도 바로 다시 울리지 않는다.
- **I5** 대상당 활성 시도는 하나다.
- **I6** 본문의 receipt와 ACK는 한 번이다. 재인수는 lease가 만료됐을 때만 일어나며 기존 규칙과 같다.
- **I7** 조용한 live 세션은 무한정 막히지 않는다. 넘긴 시각 + `min(base·2^streak, 24h)` 안에 다시 울릴 수 있다. 바쁜 세션도 본문이 `WAKE_QUIET_MAX_MS`보다 오래 기다리면 울린다.
- **I8** 응답 없는 출생에 넘긴 시도(`handed-off`·`unknown`) 수는 `⌈log2(경과 시간/base)⌉ + 1` 이하다. 24시간 상한에 닿은 뒤로는 하루 1개다. 일시 실패와 행 삭제가 끼어도 이 상한은 유지된다.
- **I9** 능력 선언상 `unsupported`이거나 `prerequisite-missing`인 출생에는 울리지 않는다. autoWake는 그 사실을 보고한다.
- **I10** 미확인을 성공으로 보고하지 않는다. `handed-off`는 전달이 아니다.
- **I11** 끝난 행은 되살아나지 않는다. 늦게 온 결과 기록과 start 호출은 행을 바꾸지 않는다.

## 7. 검증 계획

### 7.1 단위 시험
Linux 시험 서버에서 vitest로 돌린다. 시계는 주입한다. 한도를 올리거나 재시도해서 통과시키지 않는다.

**기존 실패 31건 분류.** I1~I6을 단정하는 시험은 유지한다. 영구 잠금을 단정하는 시험은 I7·I8 단정으로 바꾼다.

**추가할 사례:**
1. dispatch stub이 멈춘 동안 경계와 시간이 지나도 외부 호출은 한 번이다. 늦게 온 `not-delivered`도 출생 상태에 반영된다.
2. 끝난 행에 결과 기록이 와도 거부되고, 행은 되살아나지 않는다.
2a. relay가 넘기는 도중 죽은 뒤(`started` 시간 초과) 조용한 세션이 `resend_due_at`에 다시 울린다.
2b. DB 변환으로 옮겨진 활성 행이 변환 뒤 10분 안에 해제된다.
2c. 일시 실패 뒤 `handed-off`가 오면 `failures`가 0으로 돌아가고 `degraded`가 풀린다.
3. `not-delivered`와 `resend-due`가 번갈아 나오는 24시간 동안 시도 수가 I8 이하다. 행이 삭제된 뒤에도 마찬가지다.
4. `codex-queue`에서 30초마다 `observeNativeInput`과 `clearDeferred`를 1시간 동안 반복해도 `WAKE_QUIET_MAX_MS` 안에 울린다. 보고값도 사실과 맞는다.
5. backoff 재시도 경로에도 조용함 조건이 적용된다(start CAS에서 판정).
6. `reserved`가 만료되면 무조건 해제된다(relay가 없고, 본문이 만료되고, 세션이 조용한 경우).
7. DB 변환: 옛 상태 전부와 활성 `submitted`를 옮긴다. 활성 행 두 개 INSERT는 거부된다. `retired_at`을 보존한다. 다시 열어도 멱등이다. 공유 모드에서도 같다.
8. 한 프롬프트에 끝난 표식과 활성 표식이 함께 와도 인수는 한 번이다.
9. lease가 만료된 뒤 늦게 온 표식의 재인수 횟수에 상한이 있다.
10. 시계가 뒤로 가거나 앞으로 튀어도 동작한다(독립·공유).
11. 시작 직후 `No active session found`가 와도 깨우기가 영구히 꺼지지 않는다(transient).
12. 독립된 두 연결에서 reserve와 start를 동시에 해도 외부 호출은 한 번이다(실제 별도 연결).
13. 기본 TTL 메시지가 `resend-due` 뒤 전달된다(claude·antigravity base 10분, codex base 20분).
14. 보관 기간이 지난 뒤 도착한 표식은 본문을 인수하지 않는다.
15. `prerequisite-missing` 출생에는 울리지 않고, 출생이 바뀌면 다시 시도한다.
16. 현황판 hook의 `consume-wake`가 회귀하지 않는다.

### 7.2 실호스트 시험
Linux·Windows 시험 서버에서 red=59a580ac와 green=재설계 커밋을 비교한다.

| 호스트 | 시나리오 |
|---|---|
| Codex 0.165 | 유휴, Esc로 중단한 뒤 재개, 종료한 뒤 resume, 작업 중 |
| Claude 2.1.314 | 유휴, 작업 중 |
| agy 1.4.12 | 유휴. 관측 경로가 없으므로 `claimed-after-handoff`로 해제되는지 확인한다. |

- **셀 것:** 본문 전달 지연, 붙잡힌 표식 수, 본문 없는 턴 수, 슬롯 해제 여부, autoWake 보고값
- **합격 기준:**
  - 영구 잠금 0
  - 본문 없는 턴은 메시지당 1 이하. 재개할 때 붙잡혔던 표식은 제외하고 0을 목표로 한다.
  - 시험하지 않은 조합은 통과로 적지 않는다.

## 8. 구현 분업
설계 재검토를 통과한 뒤 다음처럼 나눈다.

| 담당 | 범위 |
|---|---|
| A. 공통 핵심 | store(스키마 변환, `wake_paths`, 규칙, 도착 처리, outlook v2), relay(`resendBaseMs` 전달, `started` 시간 초과) |
| B. 벤더 구현체 | wake-port 분리와 `wake-transport-*`, 조립 모듈, 결과 분류, antigravity와 gemini 분리, 어댑터 설정 키·진단 |
| C. 바깥 계층 | hook(H:532 `relayLive`), broker·client·CLI·protocol 버전, 계약 v2와 미러, MCP 안내문, 문서, 5장 삭제 경로 |
| D. 시험 | 7.1 |
| E. 실호스트 | 7.2 |

통합, 빌드(dist), CI 허용 목록, 커밋은 조정자가 맡는다.

## 9. 남는 위험과 미확인
- Esc로 중단된 Codex 세션은 사용자가 재개할 때까지 어떤 설계로도 깨울 수 없다(Codex의 설계). 상태는 `wake-unanswered`로 정직하게 보인다.
- Codex의 긴 단일 도구 호출 중에는 hook이 없어 조용함 조건이 동작하지 않는다. 그동안 붙잡힌 표식 1개가 턴이 끝날 때 나간다.
- 사용자의 Codex(OpenDIY R30)와 0.165 원본의 대기열 동작이 같은지 확인하지 않았다.
- Claude 소켓의 `priority:"next"`는 공개 문서에 없다. agy의 `agentapi send-message`는 공개 계약이 없다.
- 독립 모드는 시계가 단조가 아니다. 시계가 뒤로 가면 그 폭만큼 상한이 늘어난다.
- hook 출력 형식(H:324-326·467-492)과 client의 `CLAUDE_CODE_MESSAGING_*` 정리(C:140)는 깨우기 의미와 관계없는 벤더 누수다. 이번 범위에서 빼고 따로 추적한다.

## 10. 인터페이스 계약 (구현 담당 공통 기준)
담당끼리는 이 시그니처로만 맞춘다. 바꿔야 하면 조정자에게 먼저 알린다.

```ts
// session-message-wake-port.ts (공통, 담당 B)
export type WakeDispatchOutcome =
  | { result: "handed-off" }
  | { result: "unknown"; reasonCode?: string }
  | { result: "not-delivered"; kind: "transient" | "prerequisite-missing"; reasonCode: string };
export interface WakeDispatchPort {
  capabilities: DeliveryCapabilities;      // 기존 그대로
  observesNativeLaunch?: boolean;          // 기존 그대로
  resendBaseMs: number;                    // 새 필드
  dispatch(target: SessionIdentity, message: string, observe?: WakeLaunchObserver): Promise<WakeDispatchOutcome>;
}
export function wakeBackoffDelay(attempt: number): number; // 기존 그대로
// 공통은 벤더 파일을 import하지 않는다. 등록표는 wake-transports.ts(담당 B):
export function transportWakePort(transport: string): WakeDispatchPort;   // wake-transports.ts로 옮김
export function transportDeliveryCapabilities(transport: string): DeliveryCapabilities; // 같은 곳
export const WAKE_TRANSPORTS: readonly string[];                           // relay-cli 허용 목록용

// session-message-store.ts (담당 A)
export const WAKE_QUIET_MS = 60_000, WAKE_QUIET_MAX_MS = 600_000, WAKE_START_TIMEOUT_MS = 60_000,
  WAKE_RESEND_MAX_MS = 86_400_000, WAKE_FAILURE_LIMIT = 5;
startManagedWake(attempt: WakeAttempt, resendBaseMs: number, atMs?: number): WakeReservation;
recordManagedWakeOutcome(attempt: WakeAttempt, outcome: WakeDispatchOutcome, resendBaseMs: number, nowMs?: number): boolean;
autoWakeOutlook(target, nowMs?): SessionAutoWakeOutlookV2;
// presence 조회 결과와 list-presence 항목에 relayLive: boolean 추가

// broker 연산 (담당 C가 배선, A의 시그니처를 그대로 호출)
// start-wake    { ...WakeAttempt, resendBaseMs }        → WakeReservation
// record-wake-outcome { ...WakeAttempt, outcome: WakeDispatchOutcome, resendBaseMs } → { recorded: boolean }
// 삭제: claim-wake, release-wake, reserve-wake의 legacy 분기, reconcile-wake-observation

// contracts/types.ts (담당 C) — store가 import
export interface SessionAutoWakeOutlookV2 {
  state: "available" | "degraded" | "unsupported" | "no-live-relay";
  reason: "relay-live" | "wake-in-flight" | "wake-unanswered" | "recipient-active" | "retry-backoff"
    | "wake-failing" | "wake-prerequisite-missing" | "no-idle-wake"
    | "presence-unknown" | "presence-not-online" | "relay-lease-missing";
  basisAt: string | null; checkedAt: string; authorityEffect: "none";
}
```
- 상태 이름은 2.2절, 표 이름과 열은 2.3절과 4장을 따른다.
- 시도 행 열: `release_reason`, `resend_base_ms`, `resend_due_at`. `retired_at`은 `released_at`으로 바꾼다.
