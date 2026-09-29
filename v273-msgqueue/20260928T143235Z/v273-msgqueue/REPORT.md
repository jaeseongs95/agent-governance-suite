# AGS 2.7.3 메시지 영수증 보존 한도(Q) 구현 보고

- 지시: 총괄 ca8e3dc4. 이 Task의 단독 writer.
- 기준: `claude/v273-msgqueue` `8763cef2b11f2635d6c9af7861b5bffd496e2a30`(= `main`, v2.7.2). 작업 전 HEAD 일치 확인.
- 후보: commit `cc5b1e9dc439647fff18ed8aaa58170fc9389369`, tree `14282b51539b70fe605c12c9a5b2baa9ac40030f`. `claude/v273-msgqueue`에 fast-forward push, `git ls-remote`로 확인.
- 설계 입력: `claude/v273-msgqueue-retention-analysis-vmzcqs`(`cbb7cb80`)의 `DESIGN.md`, `prototype/retention.test.ts` 전체를 읽음. 시제품의 transaction 분리 구조는 따르지 않았다.
- 환경: Linux cloud 컨테이너, Node v24.21.0, pnpm 11.19.0. 시작 2026-09-28T14:20:03Z, 종료는 `meta.json`.

## 1. 구현 요약

| 항목 | 위치(후보 기준) | 내용 |
|---|---|---|
| F1 | `mcp-server/src/session-message-store.ts:20`, `:288-298`, `:343` | `MESSAGE_SENDER_RECEIPT_LIMIT = 250`. 전역 1000 유지. `submitPrepared`의 같은 `BEGIN IMMEDIATE` 안, `prune` 뒤에 sender 상한 → 전역 상한 순서로 검사. 문구 `The bounded message receipt store is full for this sender.` |
| F2 | `session-message-store.ts:552-560` | `acknowledge` 같은 transaction에서 `changes === 1`인 ID만 `expires_at = min(expires_at, ACK+1h)`. |
| F3 | `session-message-store.ts:313` | `prepare`의 draft 검사와 같은 transaction에서 영수증 용량을 먼저 확인. 문구 `...receipt store is full[ for this sender]; no draft was created.` send 검사는 권위 검사로 유지. |
| D1 | store `:122-136`(`MessageCapacityError`), `:349`(byte 한도), broker `session-message-broker.ts:506-508`, client `session-message-client.ts:26-37`, `:199-200`, service `session-message-service.ts:14-27`, `:60-61`, `:73-74` | 용량 거절에 `details: { scope: "sender" \| "global", earliestReleaseAt }`. broker 응답의 선택 필드로 전달. 새 ErrorCode 없음(`MCP_UNAVAILABLE` 유지). |
| 도구 설명 | `mcp-server/src/server.ts:530`, `:536` | prepare·send 설명에 상한과 details 의미 추가. |
| 문서 | `docs/session-message-lifecycle.md` 보존 표와 뒤 세 문단 | sender 상한(공정성 장치, 인증 아님), prepare 입장 검사, 확정 무효과 거절과 details, ACK 만료 규칙과 비소급. |
| 생성물 | `mcp-server/dist/*.mjs` 6개, `claude-plugin/mcp-server/dist/*.mjs` 6개 | `pnpm build`, `pnpm claude:build`. |

설계 판단:

- `earliestReleaseAt`은 해당 범위(sender 또는 전역) 영수증 가운데 가장 이른 `expires_at`이다. `prune`이 `expires_at <= now`를 지우므로 이 시각부터 한 자리가 풀린다. sender와 전역이 모두 찼으면 sender를 보고한다. sender 영수증 하나가 풀리면 전역 자리도 하나 풀리기 때문이다.
- byte 한도(4 MiB) 거절도 확정 무효과이므로 같은 오류 형태(`scope: "global"`)를 쓴다. 이때 시각은 byte 합에 들어가는 기록(draft 포함) 가운데 가장 이른 만료다. 그래서 service 안내는 "earliest retained record"라고 쓴다.
- 전역 send 거절 문구는 기존과 같은 `The bounded message receipt store is full.`이다. 모든 새 문구는 `/receipt store is full/`에 맞는다.
- service send 안내: 용량 거절이면 "This definite rejection had no effect: the message was not queued and no receipt was issued." 뒤에 해제 시각과 "after that a new prepare_session_message may succeed"만 붙인다. 다른 sender가 먼저 용량을 쓸 수 있으므로 "may"로 썼다. details가 없는 거절(응답 유실, unknown ID, 이전 broker)은 기존 같은 ID 재시도 안내를 그대로 쓴다.
- F2의 prepared 행 갱신은 `message_id`만으로 찾는다. 공개 경로의 ID는 broker가 발급한 UUID이고 `submitPrepared`가 같은 ID로 두 테이블을 채운다. 대상 확인은 기존 ACK 조건(`target_host`, `target_session_id`, `acknowledged_at IS NULL`)이 맡는다.
- contracts와 schema는 바꾸지 않았다. `contracts/api-result.v1.schema.json`의 `error.details`는 이미 `object | null`, `additionalProperties: true`이다.
- 범위 밖으로 남긴 것: D2, D3, D4, O6. `prune`의 wake 부분, `reserveManagedWake`, `claimHostWake` 등 wake 코드는 건드리지 않았다.

## 2. 먼저 실패한 테스트 (수정 전 코드)

로그: `logs/01-pre-fix-failing-tests.log`. 테스트만 바꾼 상태에서 `vitest run tests/session-messaging/message-retention.test.ts tests/session-messaging/message-lifecycle.test.ts` → 11 failed, 14 passed.

| # | 테스트 | 설계 §5 | 수정 전 실패 이유 |
|---|---|---|---|
| 1 | exports the sender receipt limit next to the unchanged global limit | F1 | `MESSAGE_SENDER_RECEIPT_LIMIT` undefined |
| 2 | caps one sender at the sender limit (limit-1, limit, limit+1) without blocking other senders | 1, 2, D1 | 상한+1 send가 수락됨 |
| 3 | rejects prepare and send with global scope when the global receipt pool is full | F3, D1 | 전역이 찬 뒤 prepare가 draft 생성 |
| 4 | bounds an acknowledged receipt to ACK+1h; the same ID is never re-inserted | 3 | 영수증 만료가 E+1h로 남음 |
| 5 | drained senders regain capacity at ACK+1h instead of message expiry+1h | 3 | ACK 뒤에도 용량 미해제 |
| 6 | second ACK, another session's ACK and unknown-ID ACK leave receipt expiry unchanged | 4 | 첫 ACK도 만료를 줄이지 않음 |
| 7 | two processes sending for one sender at limit-1 never exceed the sender limit | 6 | 두 send 모두 수락(합계 251) |
| 8 | concurrent send and ACK keep one row and only shorten receipt expiry | 7 | ACK 후 만료 미단축 |
| 9 | opens a v2.7.2 receipt without migration and applies ACK+1h only to new ACKs | 8 | 새 ACK에도 만료 미단축 |
| 10 | service reports capacity rejections as definite no-effect with scope and earliest release details | D1 | 거절이 없고 details도 없음 |
| 11 | message-lifecycle: applies global draft, receipt and byte backpressure without evicting valid records | F3 | 전역이 찬 뒤 prepare가 거절되지 않음 |

수정 전에도 통과한 사례: "unacknowledged receipts keep message expiry + 1h"(§5-5). 기존 계약을 지키는지 보는 회귀 방지 사례라 수정 전 통과가 기대값이다.

6번(§5-6)과 7번(§5-7)은 기존 child-process 경합 하네스(`tests/session-messaging/fixtures/issued-send-worker.ts`)로 두 프로세스·두 SQLite 연결을 쓴다. worker에 `acknowledge` 동작 하나를 추가했다. 8번(§5-8)의 v2.7.2 ACK는 v2.7.2 `acknowledge`와 같은 SQL(`UPDATE messages SET acknowledged_at = ?, claim_until = NULL`)로 재현했다. v2.7.2 소스를 직접 실행한 것은 아니다.

### 기존 사례 변경 (`tests/session-messaging/message-lifecycle.test.ts:131`)

기존 사례는 영수증 1000개가 찬 뒤 `prepare(store, 602_001)`가 성공한다는 전제였다. F3에서는 이 prepare가 거절된다. 기대값을 약하게 바꾸지 않고 두 단계를 따로 검증하도록 강화했다.

- 영수증 999개에서 draft를 준비하고, 1000번째 영수증을 채운다.
- prepare 거절: 정확한 문구 `The bounded message receipt store is full; no draft was created.`, `details = { scope: "global", earliestReleaseAt: ACK+1h }`, `prepared_messages` 행 수 불변.
- send 단계 거절: 정확한 문구 `The bounded message receipt store is full.`, 같은 details, `messages` 행 수 불변, status `prepared`.
- 1000 발신자 루프는 발신자마다 1건이라 sender 상한에 걸리지 않는다. 해제 시각 기대값에는 F2(ACK+1h)가 반영돼 있다.

## 3. 검증 결과 (최종 후보)

`logs/summary.txt`와 `logs/10`~`20`. 순서는 AGENTS.md와 지시를 따랐다.

| 명령 | 결과 | 로그 |
|---|---|---|
| `pnpm install --frozen-lockfile` | PASS | `10-install---frozen-lockfile.log` |
| `pnpm bundle:check` | PASS | `11-bundle-check.log` |
| `pnpm claude:drift` | PASS (`claude-plugin: fresh`) | `12-claude-drift.log` |
| `pnpm lint` | PASS | `13-lint.log` |
| `pnpm build` | PASS | `14-build.log` |
| `pnpm test` | PASS: 60 files passed, 1 skipped; 822 tests passed, 1 skipped | `15-test.log` |
| `pnpm runtime:check` | PASS | `16-runtime-check.log` |
| `pnpm validate:all` | PASS | `17-validate-all.log` |
| `pnpm validate:official` | NOT_RUN(환경): `/root/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py` 없음(ENOENT) | `18-validate-official.log` |
| `pnpm claude:check` | PASS | `19-claude-check.log` |
| `git diff --check` | PASS | `20-git-diff-check.log` |

skip 1건은 `tests/session-messaging/previous-broker.test.ts`다. `AGS_PREVIOUS_BROKER_PATH`가 없을 때 skip하도록 설계돼 있고, 아래 4절에서 따로 실행했다.

검증을 두 번 돌렸다. 1회차(`logs/round1/`)는 결과가 같았다(validate:official만 NOT_RUN). 1회차 뒤 자체 diff 검토에서 service 안내 문구가 byte 한도 거절(draft 포함)에 "earliest receipt"라고 쓰는 부정확함을 찾았다. "earliest retained record"로 고친 뒤 생성물을 다시 만들고 전체 검증을 다시 실행했다. 두 회차 모두 단발 실패나 재실행 통과는 없었다.

## 4. 이전 broker 호환

git 태그의 `mcp-server/dist/session-message-broker.mjs`를 꺼내 `AGS_PREVIOUS_BROKER_PATH`로 `tests/session-messaging/previous-broker.test.ts`를 실행했다. 세 파일 모두 `node:` 내장 모듈만 import하는 단독 번들이다.

| 태그 | broker sha256 | 결과 | 로그 |
|---|---|---|---|
| v2.7.2 | `fbb808e0fd8d52df17db7e7a8eeac84ed675f83a3abca9039f79740f2536f682` | PASS (1 passed) | `30-previous-broker-v2.7.2.log` |
| v2.7.1 | `d4b667d417c6c8a8beaf749a2209ab1a8d1548a26d1f819dfcc6238a6711ab80` | PASS (1 passed) | `30-previous-broker-v2.7.1.log` |
| v2.2.6 | `14f9345d3b18611fe0d5799ae56d65e3e80708ee288bbd771aafa5611a1a1cc3` | PASS (1 passed) | `30-previous-broker-v2.2.6.log` |

wire 호환:

- 새 broker → 이전 client: 응답에 선택 필드 `details`만 추가된다. 이전 client는 `error` 문자열만 읽는다.
- 이전 broker → 새 client: `details`가 없으므로 `BrokerRequestRejected.details = null`이 되고 service는 기존 안내를 쓴다.
- 이전 broker에서 오는 용량 거절에는 새 안내와 details가 붙지 않는다. 이 조합을 따로 시험하지는 않았다.

## 5. 관찰 가능한 동작 변화 (계약)

1. 한 sender의 동시 보존 영수증이 1000에서 250으로 줄었다. 251번째 send는 `...full for this sender.`로 거절된다. 이때 큐 삽입은 없고 draft는 남는다. 공개 경로의 미ACK 메시지는 모두 영수증을 가지므로, 한 sender의 미ACK spool 점유도 250 이하가 된다.
2. 영수증이 sender 상한이나 전역 상한에 닿아 있으면 prepare가 draft 없이 거절한다(`; no draft was created.`). 전에는 draft를 만든 뒤 send에서 거절했다.
3. ACK된 메시지의 영수증은 `min(메시지 만료+1h, 최초 ACK+1h)`에 사라진다. 그 뒤 같은 ID의 send는 `duplicate: true`가 아니라 `Issued message ID is unavailable...`로 거절되고, status는 `null`이다. 미ACK 영수증은 기존대로 메시지 만료+1h까지 `submitted/deliveryState: unknown`이다.
4. 용량 거절 응답의 `error.details`가 `null`에서 `{ scope, earliestReleaseAt }`로 바뀌었다. code는 `MCP_UNAVAILABLE` 그대로다. send 용량 거절의 안내에서 "do not prepare again" 문구가 빠지고, 확정 무효과라는 사실과 해제 시각이 들어간다.
5. broker wire 응답에 선택 필드 `details`가 생겼다. protocol 버전은 바꾸지 않았다.
6. schema, 테이블, 이관은 바뀌지 않았다. 이전 버전이 ACK한 영수증의 만료는 소급해 바꾸지 않는다.

## 6. wake 브랜치와 겹칠 것으로 예상되는 곳

`claude/v273-wake-liveness`(`e7390909`)와 `main`의 diff를 조회만 했다. `main` 기준 줄 번호다.

| 파일 | 이 브랜치가 바꾼 곳 | wake 브랜치가 바꾼 곳 | 예상 |
|---|---|---|---|
| `mcp-server/src/session-message-store.ts` | `:18` 뒤 상수 추가 | `:24` 뒤 상수 추가 | 근접, 문맥 충돌 가능성 낮음 |
| 같은 파일 | `:118-119` 사이 `MessageCapacityError` 추가 | `:118` `ManagedWakeState` 변경 | 인접 hunk, 문맥 충돌 가능 |
| 같은 파일 | `:268`(prune 뒤) `assertReceiptCapacity` 추가 | `:268` 뒤 23줄 추가 | 같은 삽입 지점, 충돌 가능성 높음 |
| 같은 파일 | `:311-312`(용량 검사 교체), `:317-318`(byte 거절) | `:298`(반환 타입), `:305`, `:307`, `:309`, `:313`, `:320`, `:322`(`autoWake` 추가) | `submitPrepared` 안에서 교차. 충돌 가능성 높음. 의미상 두 변경은 독립 |
| 같은 파일 | `:518-524` `acknowledge` 루프 | `:523` 뒤 1줄 추가 | 같은 영역, 충돌 가능성 높음 |
| `mcp-server/src/session-message-service.ts` | `:2`, `:14-16`, `:48-50`, `:59-60` | `:3`, `:7`, `:91` | 인접 import 줄, 문맥 충돌 가능 |
| `mcp-server/src/session-message-broker.ts` | `:10`(import), `:506` | `:272` | 떨어져 있음 |
| `mcp-server/src/server.ts` | `:530`, `:536` | `:536`, `:548` 등 | `:536` send 설명이 같은 줄. 충돌 확실 |
| `docs/session-message-lifecycle.md` | `:28`, `:31` 뒤 문단 | `:60`, `:74`, `:83`, `:93`, `:119` | 떨어져 있음 |
| `tests/session-messaging/message-lifecycle.test.ts` | `:131-147` 사례 | `:100`, `:109`, `:209`, `:251` | 떨어져 있음 |
| `mcp-server/dist/*`, `claude-plugin/**/dist/*` | 재생성 | 재생성 | 통합 뒤 `pnpm build`·`pnpm claude:build`로 다시 만들어야 함 |

통합 때 의미상 확인할 점: wake 브랜치는 `submitPrepared` 반환값에 `autoWake`를 추가한다. 이 브랜치의 `tests/session-messaging/message-retention.test.ts` "bounds an acknowledged receipt to ACK+1h" 사례에 있는 `toEqual({ ...sent, duplicate: true })`는 `autoWake.checkedAt`이 호출마다 달라져 실패할 수 있다. wake 브랜치가 기존 lifecycle 테스트를 고친 방식대로 맞춰야 한다.

## 7. 릴리스 노트 초안 문단 (총괄 통합용, 저장소에는 넣지 않음)

> 세션 메시지 영수증 보존 한도를 발신자별로 나눴습니다. 한 발신자는 동시에 제출 영수증을 250개까지 보존하며 전역 상한 1000개는 그대로입니다. 수신자가 ACK한 메시지의 영수증은 메시지 만료 후 1시간이 아니라 ACK 후 1시간에 정리되므로, 수신자가 처리를 마치면 용량이 더 빨리 돌아옵니다. 영수증 용량이 이미 가득 차 있으면 `prepare_session_message`가 draft를 만들지 않고 거절합니다. 용량 거절은 효과가 없었음이 확정된 거절이며, 응답의 `error.details`에 `scope`(`sender`/`global`)와 가장 이른 해제 예상 시각 `earliestReleaseAt`이 들어 있습니다. 그 시각 뒤에는 새 prepare가 성공할 수 있습니다. 응답을 받지 못한 불확실한 전송은 기존처럼 같은 ID로 status를 조회하거나 다시 send합니다.
>
> 알려진 한계: 발신자별 영수증 상한은 협력하는 세션 사이의 공정성 장치이며 신원 인증이 아닙니다. ACK되지 않은 긴 TTL 메시지는 여전히 메시지 만료 후 1시간까지 발신자 상한을 차지합니다. 여러 발신자가 응답하지 않는 대상에 보내면 전역 수신 큐가 찰 수 있습니다. ACK 후 1시간이 지난 ID는 status에서 확인되지 않습니다(unknown). 이전 버전이 ACK한 영수증에는 새 만료 규칙을 소급 적용하지 않습니다.

## 8. NOT_RUN과 제약

- `pnpm validate:official`: NOT_RUN(환경). 컨테이너에 Codex 공식 validator(`/root/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py`)가 없다.
- Windows CI 조합, 실제 Codex·Claude Code 호스트 설치 캐시와 MCP 동작: 실행하지 않음. 이 Task의 요구 범위 밖이다.
- 새 client와 이전 broker 조합에서의 용량 거절 안내: 코드 경로(details 없음 → 기존 안내)만 확인했고, 따로 시험하지는 않았다.

## 9. 가린 값

- 로그 13개 파일에서 컨테이너 홈 경로(`/home/<계정>`)의 계정 이름 부분을 `/home/[REDACTED]`로 바꿨다. 컨테이너 기본 계정이지만 지시의 "사용자 이름이 들어간 홈 경로"에 해당하므로 가렸다.
- `/root/.codex/...`(validate:official 오류)는 시스템 계정 경로라 그대로 두었다.
- 다음 패턴은 로그에서 발견되지 않았다: `ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `AKIA`, `BEGIN ... PRIVATE KEY`, `Authorization: Bearer`, 이메일 주소, IPv4 주소.
- `uname -a`의 호스트 이름은 `vm`(일반값)이라 그대로 두었다.
- env·printenv 출력은 남기지 않았다.
