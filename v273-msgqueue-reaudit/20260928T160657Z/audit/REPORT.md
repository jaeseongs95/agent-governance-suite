# AGS 2.7.3 메시지 영수증 보존 한도(Q) 재감사 보고 — N1~N5 수정분

- 지시: 총괄 ca8e3dc4. 이 세션은 구현 세션과 분리된 독립 감사자다. 읽기 전용으로 감사했고 제품 소스를 고치지 않았다.
- 새 후보: `74395bf698012a8b2e034e58e3b42d51f53b0b68`(tree `a4315674f6a18e058a05699fc9fafb227733cc2d`). 둘 다 `git rev-parse`로 확인했다.
- 이전 감사 대상: `cc5b1e9dc439647fff18ed8aaa58170fc9389369`. 이전 보고서는 `claude/evidence-v273-msgqueue-audit-20260928T152951Z`의 `audit/REPORT.md`다.
- 범위: `cc5b1e9..74395bf6` 사이의 두 commit이다.
  - `544cd6e1`: N5 문구
  - `74395bf6`: N1~N4 테스트
- writer evidence(`claude/evidence-v273-msgqueue-fix-20260928T154535Z`)는 대조용으로만 fetch했다. 판정은 모두 이 감사에서 직접 실행한 결과를 근거로 한다.
- 환경: Linux cloud 컨테이너 1곳, Node v24.21.0, pnpm 11.19.0. 상세는 `meta.json`에 있다.
- 아래 `파일:줄`은 새 후보 기준이다. 통합 절은 예외로, 병합본 기준이다.

## 최종 판정: **ACCEPT_WITH_FINDINGS**

N1~N4는 해결됐다. 지난번 생존한 M03·M05·M11·M20을 포함해 mutant 22개를 모두 후보 테스트가 검출한다. 새 테스트는 고정 시각을 쓰고, 전제 조건을 단언으로 확인한다. 10회 반복에서 흔들림이 없었다.

N5 문구는 세 곳의 뜻이 서로 맞고 멱등성 관점에서도 옳다. "둘 다 하면 한 의도가 두 번 전달된다"는 설명은 재현으로 확인했다(N5-a). 새 blocker와 major는 없다.

남은 finding은 minor 1건(R1)이다. 같은 ID 재시도를 고를 수 있는 조건(draft 만료 전에 용량이 풀림)을 응답이 알려 주지 않는다. 그래서 흔한 경우에는 재시도가 "delivery may be unknown … do not prepare again" 안내로 떨어진다.

## 항목별 결과

| # | 항목 | 결과 | 근거 |
|---|---|---|---|
| 1 | 범위 | PASS | 문구 3곳, 생성물 2개, 테스트 1개만 바뀌었다. store·broker·client·contracts·runtime은 diff가 0이다 |
| 2 | N1~N4, mutant 재실행 | PASS | 22/22 검출(`logs/mutants/mutants.tsv`) |
| 3 | N4 trigger 테스트 | PASS | trigger의 영향 범위와 정리 방식을 확인했다 |
| 4 | N5 문구 | PASS_WITH_FINDINGS | 세 곳이 서로 일치하고 코드와도 맞다. 새 오표시 경로와 벤더명, 인증 표현은 없다. minor R1 |
| 5 | 전체 검증과 생성물 일치 | PASS | 11개 명령 종료 코드 0. validate:official은 FAIL_UNRELATED(환경). git status 빈 출력 |
| 6 | previous-broker 호환 | PASS | v2.7.2, v2.7.1, v2.2.6 |
| 7 | 감사 테스트 | PASS | I1–I6, L1–L5, R1–R4(각 10회), C1–C3 |
| 8 | 통합 충돌 | 참고 | 아래 8절 |

### 1. 범위 — PASS

`git diff --stat cc5b1e9 74395bf6`의 결과는 아래 6개 파일이다.

- `docs/session-message-lifecycle.md`
- `mcp-server/src/server.ts`
- `mcp-server/src/session-message-service.ts`
- `mcp-server/dist/server.mjs`
- `claude-plugin/mcp-server/dist/server.mjs`
- `tests/session-messaging/message-retention.test.ts`

확인한 내용:
- 동작 파일인 `session-message-store.ts`, `session-message-broker.ts`, `session-message-client.ts`와 `contracts`, `runtime`은 diff가 0이다.
- `session-message-service.ts:74`의 변경은 문자열 리터럴 한 줄뿐이고, 분기 조건은 그대로다.
- dist diff도 해당 문자열 두 줄뿐이다.
- 두 dist의 `server.mjs`는 서로 같은 파일이다(`cmp` 동일).

### 2. N1~N4: mutant 22개 재실행 — PASS

이전과 같은 방법을 썼다(`scripts/mutants.py`, `scripts/run-mutants.sh`).
- mutant를 적용하고 `node scripts/build.mjs`로 dist를 다시 만든다.
- 후보 테스트(`tests/session-messaging`, `tests/session-board`)를 돌린 뒤, 감사 테스트(race 5회)를 돌린다.
- 매번 `git checkout -- .`으로 원상 복구했다. 실행 뒤 mutation worktree의 `git status`는 비어 있다.

BASELINE은 후보 267개 중 266개 통과, 1개 skip(previous-broker)이다.

| mutant | 대상 | 이전(cc5b1e9) | 새 후보 | 새 후보에서 실패한 테스트(요약) |
|---|---|---|---|---|
| M01 sender 상한 251 | F1 | 검출 | 검출(6) | |
| M02 sender 검사 제거 | F1 | 검출 | 검출(5) | |
| **M03 전역 검사를 먼저** | F1/D1 | **생존** | **검출(1)** | reports sender scope … when sender and global limits are both full |
| M04 send 검사 제거 | F1 | 검출 | 검출(6) | |
| **M05 용량 검사를 duplicate 앞으로** | F1/멱등 | **생존** | **검출(2)** | a resend of an already sent ID at full sender and global capacity…; service reports capacity rejections… |
| M06 검사를 transaction 밖으로 | F1 | 검출 | 검출(1) | 아래 관찰 참고 |
| M07 ACK changes 검사 제거 | F2 | 검출 | 검출(4) | |
| M08 min() 제거 | F2 | 검출 | 검출(1) | |
| M09 ACK 영수증 갱신 제거 | F2 | 검출 | 검출(6) | |
| M10 ACK+1h 대신 ACK | F2 | 검출 | 검출(7) | |
| **M11 갱신을 COMMIT 뒤로** | F2 | **생존** | **검출(1)** | rolls back the whole ACK when the receipt update fails… |
| M12 prepare 입장 검사 제거 | F3 | 검출 | 검출(6) | |
| M13 입장 검사를 prune 앞으로 | F3 | 검출 | 검출(2) | |
| M14 broker details 누락 | D1 | 검출 | 검출(1) | |
| M15 client details 무시 | D1 | 검출 | 검출(1) | |
| M16 service details null | D1 | 검출 | 검출(1) | |
| M17 earliest에 max | D1 | 검출 | 검출(3) | |
| M18 scope 라벨 교체 | D1 | 검출 | 검출(3) | |
| M19 불확실 안내 사용 | D1 | 검출 | 검출(1) | |
| **M20 byte 거절 details 누락** | D1 | **생존** | **검출(1)** | byte-limit send rejection carries global details… |
| M21 모든 거절을 확정으로 | D1 | 검출 | 검출(1) | |
| M22 sender 개수 전체로 계산 | F1 | 검출 | 검출(6) | |

새 테스트가 과하게 좁거나 우연에 기대는지 검토했다.

- **N1** (`message-retention.test.ts:275-287`, service 사례 `:268-272`)
  - 첫 영수증, 마지막 영수증, 전역까지 찬 뒤의 영수증 세 경우를 본다.
  - `toEqual`로 전체 영수증을 비교하고, 행 수가 그대로인지도 단언한다.
  - 시각은 고정값이다. service 사례는 실제 시각을 쓰지만 영수증 보존 기간이 1시간 이상이라 시각에 의존하지 않는다.
  - M05만 겨냥한 모양이 아니라 "재전송은 duplicate"라는 계약 자체를 고정한다.
- **N2** (`:289-306`)
  - 다른 sender의 영수증을 먼저(1000ms) 만들어, 전역의 가장 이른 시각(1000+2h)과 찬 sender의 가장 이른 시각(3000+2h)이 다르게 한다.
  - 전제를 `expect(earliest(store))`로 확인한다. 그래서 순서가 바뀌면 scope와 시각이 모두 틀려진다.
- **N3** (`:308-335`)
  - byte 여유가 영수증 증가분(144 byte)보다 작다는 전제를 `toBeLessThan(100)`으로 먼저 단언한다.
  - 기록 형식이 바뀌면 이 전제 단언에서 실패하고, 조용히 통과하지 않는다.
  - 해제 시각 1ms 전과 그 시각을 모두 본다. 시각은 고정값이다.
- **N4** (`:337-351`): 아래 3절에서 따로 본다.
- **반복 안정성**: 후보 `message-retention.test.ts`를 10회 반복해 10/10 통과했다(`logs/retention-repeat-10.log`). 전체 검증의 `pnpm test`에서도 통과했다.

관찰(finding 아님): M06은 이번에 `message-lifecycle.test.ts`의 draft 개수 단언 하나로만 검출됐다. 이 mutant는 transaction 밖에서 prune을 먼저 실행하는데, 그 부수효과가 잡힌 것이다. 경합 테스트(R1)는 이번 실행에서 경합 창을 밟지 못했다. 지난번에는 R1도 이 mutant를 검출했다. 감사 테스트는 이번에 2건으로 검출했다. transaction 분리를 결정적으로 검출하는 테스트는 여전히 없지만, 이번 요청 범위(N1~N4) 밖이다.

### 3. N4 trigger 테스트 — PASS

후보 테스트(`message-retention.test.ts:337-351`)는 `BEFORE UPDATE OF expires_at ON prepared_messages` trigger로 ACK 때의 영수증 갱신을 실패시킨다. 그 뒤 세 가지를 확인한다.
- `messages.acknowledged_at`이 `NULL`로 남아 전체가 rollback됐다.
- 영수증 만료가 그대로다.
- status가 `queued`다.

trigger를 지운 뒤 ACK가 정상 동작하는지도 본다.

감사 시험(`tests/reaudit-trigger.test.ts`, `logs/reaudit-trigger.log`)으로 trigger의 영향 범위를 확인했다.

| 경로 | trigger가 있을 때 |
|---|---|
| claim(`messages` UPDATE), status, prepare(INSERT), duplicate send, 모르는 ID의 ACK, prune(DELETE) | 영향 없음 |
| 새 send(`submitPrepared`의 영수증 UPDATE) | 실패함. 다만 후보 테스트는 trigger가 있는 동안 이 경로를 호출하지 않는다 |
| 실제 ACK | 실패하고 전체가 rollback됨 |

정리:
- 테스트는 `DROP TRIGGER`로 trigger를 지운다. 지운 뒤 `sqlite_master`에 남은 trigger는 0개다.
- 단언이 DROP 전에 실패해도 문제가 없다. 이 테스트는 `fixture()`로 만든 `:memory:` DB를 쓰고 `afterEach`가 닫으므로(`:24`, `:31`), 다른 테스트로 새지 않는다.
- trigger는 테스트 DB에만 만든다. 제품 코드에 테스트용 경로는 추가되지 않았다.

### 4. N5 문구 — PASS_WITH_FINDINGS

세 곳의 문구:
- `session-message-service.ts:74`: "The rejected messageId stays prepared until its draft expires; after capacity is released, either retry that same messageId or prepare again, not both."
- `server.ts:536`: "The rejected messageId stays prepared until its draft expires; after earliestReleaseAt either retry that same ID or prepare again, not both."
- `docs/session-message-lifecycle.md:35`: "send에서 거절된 `messageId`는 준비 만료까지 `prepared`로 남는다. 용량이 풀린 뒤에는 같은 ID 재시도와 새 prepare 가운데 하나만 한다. 둘 다 하면 한 의도가 두 메시지로 전달될 수 있다."

판정:
- **세 곳의 뜻이 일치한다.** 각 문장은 코드 동작과 맞는다. 용량 거절 뒤 draft는 rollback으로 남고(`session-message-store.ts:354-356`), status는 `prepared`다. `:35`는 기존 `:33` 문장과도 맞는다.
- **새 오표시 경로가 없다.** 안내 문자열만 바뀌었다. 확정 안내가 붙는 조건(`capacityDetails`가 null이 아님, `session-message-service.ts:19-21`, `:73`)은 그대로다. M21 검출과 감사 I6로, 불확실한 경우에 확정 안내가 붙지 않음을 다시 확인했다.
- **벤더명과 인증 표현이 없다.** 추가된 줄에서 `codex|claude|grok|spark|openai|anthropic|principal|authenticat|인증`은 0건이다.
- **멱등성 관점에서 옳다.** 감사 N5-a(`tests/reaudit-n5.test.ts`)에서 용량이 draft 만료 전에 풀리는 경우를 만들었다. 같은 ID 재시도와 새 prepare를 모두 하면 같은 본문의 메시지가 2개 큐에 들어간다. 같은 ID 재시도만 하면 영수증 규칙에 따라 한 번만 들어간다. 따라서 "not both"는 필요한 안내이고, 어느 한쪽만 하면 중복은 생기지 않는다.
- **minor R1**: 아래 finding 참고.

### 5. 전체 검증 재실행 — PASS

지난번과 같은 순서로 실행했다(`logs/full-validation/`, 종료 코드는 `exit-codes.tsv`).

| 명령 | 종료 코드 | 결과 |
|---|---|---|
| `pnpm install --frozen-lockfile` | 0 | PASS |
| `pnpm bundle:check` | 0 | PASS |
| `pnpm claude:drift` | 0 | PASS |
| `pnpm lint` | 0 | PASS |
| `pnpm build` | 0 | PASS |
| `pnpm test` | 0 | PASS: 826개 통과, 1개 skip(previous-broker, 6절에서 따로 실행) |
| `pnpm runtime:check` | 0 | PASS |
| `pnpm validate:all` | 0 | PASS |
| `pnpm validate:official` | 1 | **FAIL_UNRELATED(환경)**: `/root/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py` ENOENT |
| `pnpm claude:build` | 0 | PASS |
| `pnpm claude:check` | 0 | PASS |
| `git diff --check` | 0 | PASS |

생성물 일치: build 뒤, claude:build 뒤, 마지막 시점의 `git status --porcelain`이 모두 0 byte다(`05b`, `10b`, `12b`).

### 6. previous-broker 호환 — PASS

각 태그의 `git archive` 트리를 `AGS_PREVIOUS_BROKER_PATH`로 지정했다.

| 시험 | v2.7.2 | v2.7.1 | v2.2.6 |
|---|---|---|---|
| `previous-broker.test.ts` | PASS | PASS | PASS |
| C1 새 client + 이전 broker의 용량 거절 | PASS(기존 안내, `details: null`) | PASS | 해당 없음(prepare 없음. `Unknown broker operation.`을 단언) |
| C2 이전 release가 만든 DB를 새 broker로 열기 | PASS(비소급) | PASS | 해당 없음 |
| C3 이전 CLI + 새 broker | PASS | PASS | 해당 없음 |

### 7. 감사 테스트 재실행 — PASS

- `AUDIT_RACE_ROUNDS=10`으로 16개 모두 통과했다(`logs/audit-tests-candidate.log`).
- 관측된 경합 순서:
  - R3: send 먼저 9회, ACK 먼저 1회
  - R4: send 먼저 9회, prepare 먼저 1회
  - 양쪽 분기가 모두 실행됐다.
- C1–C3는 6절에 적었다.

### 8. 통합 충돌 위치(참고, 판정 근거 아님)

`claude/v273-integration` = `e71b121a5481a0a04302a7f1c12ec3f4522df606` 위에 `74395bf6`을 `git merge --no-commit`으로 임시 병합했다. push하지 않았다.
- 로그: `logs/integration-merge.log`
- 해소 스크립트: `scripts/resolve-integration-merge.py`
- 해소 결과 diff: `logs/integration-resolved-vs-integration.diff`

충돌 파일과 위치(병합본 줄 번호, HEAD = integration):

| 파일 | 위치 | 내용 | 기계적 해소 |
|---|---|---|---|
| `mcp-server/src/server.ts` | 536-540 | send 설명: wake의 autoWake 문장과 D1·N5 문장 | wake 문장 뒤에 후보 문장을 이어 붙임 |
| `mcp-server/src/session-message-service.ts` | 2-8 | import: `SessionPresenceView`와 `BrokerRequestRejected` | 둘 다 가져옴 |
| `mcp-server/src/session-message-store.ts` | 327-360 | `retireUnobservedWakes`·`recordActivity`와 `assertReceiptCapacity`가 같은 위치 | 둘 다 유지 |
| 같은 파일 | 411-418 | `submitPrepared` 용량 검사와 wake의 `target` 변수 | `assertReceiptCapacity` + `target` |
| 같은 파일 | 644-653 | `acknowledge`: F2 루프와 wake의 `recordActivity` | F2 루프 뒤에 `recordActivity` |
| `mcp-server/dist/{server,session-message-broker}.mjs`, `claude-plugin/mcp-server/dist/` 같은 두 파일 | 생성물 | | `node scripts/build.mjs`, `node scripts/build-claude-plugin.mjs`로 재생성 |

해소 뒤 `tsc --noEmit`과 build는 통과했다. 이어서 `tests/session-messaging`과 `tests/session-board`를 돌렸다.
- `historical-wake.test.mjs`의 "packaged claude CLI" 6건은 claude 생성물을 다시 만들기 전에만 실패했다. `build-claude-plugin` 뒤에는 65/65 통과했다.
- 남은 실패는 모두 **autoWake 기대값을 맞춰야 하는 위치**다. 병합본의 `tests/session-messaging/message-retention.test.ts` 기준이다.

| 줄 | 단언 | 이유 |
|---|---|---|
| 113 | `submitPrepared(...ackAt + H - 1)).toEqual({ ...sent, duplicate: true })` | 반환값에 호출 시점 `autoWake.checkedAt`이 붙음(지난 감사와 같은 위치) |
| 271 | `service.send(...)).toMatchObject({ ok: true, …, data: { ...firstSent, duplicate: true } })` | N1 service 사례(새로 생김). `firstSent.autoWake.checkedAt`이 재전송 시각과 다름 |
| 279 | `toEqual({ ...sent[0], duplicate: true })` | N1 store 사례(새로 생김) |
| 280 | `toEqual({ ...sent[SENDER_LIMIT - 1], duplicate: true })` | 같음(279가 먼저 실패해 가려졌지만 같은 형태) |
| 285 | `toEqual({ ...sent[1], duplicate: true })` | 같음 |

권장 대응: wake 브랜치가 `message-lifecycle.test.ts`에서 쓴 방식을 따른다. 즉 `autoWake: { ...x.autoWake, checkedAt: iso(호출 시각) }`, service 사례는 `expect.any(String)`로 맞춘다. 새 N2·N3·N4 사례는 `toEqual`로 details나 DB 값만 비교하므로 영향이 없다.

## Findings

| ID | 심각도 | 내용 |
|---|---|---|
| R1 | minor | N5 문구가 같은 ID 재시도를 고를 수 있는 조건을 알려 주지 않는다 |

### R1 (minor) — "같은 ID 재시도" 분기의 조건(draft 만료 전 해제)을 응답이 주지 않는다

- **재현**: `tests/reaudit-n5.test.ts`의 N5-b(`logs/reaudit-n5.log`).
  1. service로 prepare한다. 응답의 `expiresAt`이 draft 만료 시각이다.
  2. sender 상한을 채운 뒤 send하면 용량 거절이 온다. `details`의 키는 `scope`와 `earliestReleaseAt` 두 개뿐이다. 문구에는 draft 만료 시각이 없다. 이 사례에서 `earliestReleaseAt`(첫 영수증 만료, 약 1h 뒤)은 draft 만료(10분 뒤)보다 늦다.
  3. 시간이 지나 draft가 만료되고 용량이 풀린 상태를 DB 시각 조정으로 흉내 낸 뒤, 같은 ID로 재시도한다.
  4. 결과는 `details: null`이다. 문구는 "Issued message ID is unavailable; delivery may be unknown. … do not prepare again for the same uncertain delivery."이고, 메시지는 한 번도 큐에 들어가지 않았다.
- **영향**:
  - 중복 전달은 생기지 않는다.
  - 하지만 안내를 따른 발신자가 확정 거절된 전송을 "불확실"로 다시 분류할 수 있다. 그러면 "다시 prepare하지 말라"는 문구 때문에 의도를 포기할 수 있다.
  - 영수증 만료는 적어도 메시지 만료+1h 또는 ACK+1h다. 그래서 오래된 영수증이 곧 만료되는 경우가 아니면 `earliestReleaseAt`은 대개 draft 10분보다 늦고, 이 경로가 흔하다.
  - 발신자가 prepare 응답의 `expiresAt`을 기억해 비교하면 피할 수 있다. 문서 `:21`의 "unknown ID는 저장한 영수증과 대조" 규칙과도 모순되지 않으므로 minor로 분류했다.
- **권장 수정**(택1):
  - (a) 문구를 조건부로 바꾼다. 예: "retry that same messageId only if earliestReleaseAt is before the draft expiresAt returned by prepare; otherwise prepare again. Never do both." 세 곳을 같은 뜻으로 맞춘다.
  - (b) 용량 거절 `details`에 `draftExpiresAt`을 선택 필드로 추가한다. 새 ErrorCode는 필요 없고, 이전 client는 무시한다.

## 실행하지 못한 것(NOT_RUN)

| 항목 | 이유 |
|---|---|
| Windows | 이 감사는 Linux cloud 컨테이너 한 곳에서만 실행했다 |
| 실제 호스트(Codex, Claude Code 등)의 MCP 호출, 실제 설치와 설치 캐시 | 컨테이너에 실제 호스트 설치가 없다 |
| `pnpm validate:official` | FAIL_UNRELATED(환경): Codex 공식 validator가 없다 |
| 통합 병합본의 전체 `pnpm test`와 감사 테스트 | 8절은 충돌 위치 참고용이다. `tests/session-messaging`과 `tests/session-board`만 실행했다 |
| 프로세스 강제 종료를 주입하는 원자성 시험 | 하네스가 없다. trigger 방식의 rollback은 확인했다(3절) |

## 산출물

- `audit/REPORT.md`(이 파일), `meta.json`, `SHA256SUMS`
- 감사 테스트: `tests/audit-msgqueue.test.ts`, `tests/audit-compat.test.ts`(이전 감사와 같음), `tests/reaudit-n5.test.ts`(N5-a, N5-b), `tests/reaudit-trigger.test.ts`
- 스크립트: `scripts/full-validation.sh`, `scripts/mutants.py`, `scripts/run-mutants.sh`, `scripts/resolve-integration-merge.py`
- 로그: `logs/full-validation/`, `logs/mutants/`, `logs/retention-repeat-10.log`, `logs/audit-tests-candidate.log`, `logs/previous-broker-*.log`, `logs/reaudit-*.log`, `logs/integration-*`

## 비밀값·개인정보 처리

push 전에 다음 패턴으로 모든 산출물을 검사했다.
- 비밀값: `ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `AKIA`, `BEGIN PRIVATE KEY`, `Authorization: Bearer`
- 개인정보: 이메일 주소, IPv4 주소, 계정 이름

결과는 `meta.json`의 `redaction`에 적었다. env·printenv 전체 출력은 남기지 않았다. 로그의 경로는 컨테이너 기본 경로이며 개인 계정 이름이 아니다.
