# wake53-msgqueue-idem — peer 메시지 큐 멱등성·다중 프로세스 실험 보고

- 대상: `53eff30a2984d41fc749d38dd2062966017684fa` (tree `c030fa4e19411ef511c5d5c89cf588aa6f42c059`, 일치 확인 `02-setup.log`)
- 기준: `d5c5932cd5a0d87630f6ed94f8e3721181ab9864` (v2.7.1, main)
- 환경: Linux cloud 컨테이너 1대, Node v24.21.0 (SHASUMS256 검증, `01-node-install.log`), pnpm 11.19.0
- **범위 한정**: 이 결과는 일회용 Linux cloud 환경의 실험이다. 사용자 PC의 운영 상태, 설치 캐시, 실제 Codex/Claude Code 호스트의 live 증거가 아니다.
- 소스·테스트·설정은 고치지 않았다. 실험 스크립트는 `scripts/`, 원시 결과는 `e*.json`, 명령 로그는 `NN-*.log`.

## 요약 판정

| 불변식 | v53 | v271 | 근거 |
|---|---|---|---|
| 수락된 메시지 유실 0 | PASS | PASS | E1 5회(7,500 send), E2 400건, E8 2400 send+18회 broker kill, 36 lock 사례 |
| ACK 전 재전달은 같은 ID | PASS | PASS | E3 lease 경계(시도 2~6), E5 hook fail-open 뒤 재전달 |
| 같은 ID가 두 번 이상 '새 메시지'로 안 보임 | PASS | PASS | E2 동시 k=2..8 280건, kill/재시도 120건, E8 |
| 다른 세션이 남의 메시지를 ACK·claim 못함 | PASS (hook 바인딩 경계) / 관측 O6 | 동일 | E3/E4 (c)(d)(e) |
| 거절은 상태 무변화 | PASS | PASS | E1 거절 2,500건, E5 거절 전 사례, E8 |

**불변식 위반: 0건 (v53, v271 모두).** 따라서 신규/기존 구분이 필요한 위반은 없다. 아래 관측(O1~O10)은 위반이 아니라 설계 경계·가용성 특성이며 모두 v271에서도 같은 결과(`31-v53-vs-v271-diff.log`: E3/E5/E7 항목 diff 0)다. 즉 모두 기존 동작이다.

참고: v53의 기존 테스트 `vitest run tests/session-messaging` → 6 files passed, 1 skipped / 148 passed, 1 skipped (`32-...log`).

## 1. 코드 규칙 정리 (파일:줄, 대상 53eff30 기준)

| 규칙 | 위치 |
|---|---|
| ID는 prepare에서 `randomUUID()`로 시스템 발급, 내용 기반 dedup 없음 | `mcp-server/src/session-message-store.ts:275` |
| 본문 1–4096 UTF-8 bytes, NUL 금지, 공백만 금지; TTL 정수 30–86400 | store `:272-274`, `:337-343`; service `session-message-service.ts:37`; schema `contracts/prepare-session-message-request.v1.schema.json` (`maxLength` 4096 code points) |
| draft TTL 10분, 전역 draft 1000·sender당 100·바이트 4MiB | store `:15-19`, `:280-283` |
| send 멱등 키 = `(message_id, sender)`의 prepared 행; 첫 send가 queue insert + receipt 기록을 한 트랜잭션(`BEGIN IMMEDIATE`)에서 수행, 이후 send는 receipt로 `duplicate:true` | store `:296-325` (`:301` 소유·만료 검사, `:304-307` duplicate, `:309-310` receipt 1000 상한, `:313` receipt 만료 = message 만료 + 1h) |
| 내부 `send()`의 동일 ID 비교(sender/target/body/TTL) | store `:347-356`; spool 상한 1000건·4MiB `:358-359` |
| claim: `expires_at > now AND (claim_until IS NULL OR claim_until <= now)` 선택 후 행 단위 CAS UPDATE | store `:382-389`, `:410` |
| lease = min(30분, 120s × 2^min(attempts,4)) → 120/240/480/960/1800/1800s | store `:21-22`, `:408` |
| claim 1회 상한 10건, 응답 32KiB, maxBodyChars는 UTF-16 길이 | store `:26`, `:373-405` |
| ACK: `target_host/target_session_id`와 `acknowledged_at IS NULL` 조건만 (claim 여부·만료 미확인), 배열은 Set으로 중복 제거 | store `:511-528` |
| 만료 prune: `expires_at <= now` 삭제, ACK 1h 뒤 삭제 | store `:253-265` |
| status: messages 행이 없으면 prepared receipt로 `submitted / deliveryState unknown` | store `:530-556` |
| broker는 token만 인증, 세션 신원은 payload 값을 그대로 사용 | `session-message-broker.ts:31-36`, `:486`, send `:210-213`, claim `:214-221`, ack `:298` |
| MCP 계층 신원 = `_sessionBinding` 인자 (hook이 PreToolUse에서 덮어씀) | service `:18-24`; hook `session-message-hook.ts:175-191` |
| client: 시도당 2.5s, 실패 시 broker 확인·기동 후 1회 재요청(총 20s) | `session-message-client.ts:28-29`, `:145`, `:311-331` |
| capacity/업무 거절도 service에서 `MCP_UNAVAILABLE` + "같은 ID만 재시도" 안내로 매핑 | service `:59-60` |
| hook 전달: claim(최대 1건) → trust store receipt 기록 → envelope(8KiB, 초과 시 base64); 모든 오류 fail-open | hook `:195-225`, `:78-114`, `:229-236` |
| 재전달 시 trust receipt는 `(host, session, eventId=messageId)`로 멱등(같은 digest면 기존 receipt 반환) | `trust-store.ts:89-99` |
| peer-wait `queryRevision`: broker는 불투명 문자열로 fingerprint에 포함; Codex adapter가 target 정렬·중복 제거·cursor 정렬 후 sha256 | broker `:303-323`; `host-input-adapter.ts:130-150`; `peer-wait-policy.ts:19-22` |
| (53eff30 신규) Codex에서 검증된 managed wake인데 claim 0건이면 UserPromptSubmit block | hook `:204-208`; broker `:271`; store `:836-843` |
| Stop: Claude(`claude-inbox`)는 turn-end claim, Codex 기본(`codex-deferred`)은 clear-deferred만; PostToolUse는 deferred claim | hook `:214-222`; `session-message-wake-port.ts:62-66` |

## 2. 실험별 결과

공개 경로: MCP stdio 서버(`mcp-server/dist/server.mjs`) 여러 프로세스, 패키지 CLI(`dist/session-message-cli.mjs`), 패키지 hook(`dist/session-message-hook.mjs`, `claude-plugin/hooks/session-message-hook.mjs`), broker TLS 프로토콜(E7 presence/relay/wake 설정용). 시간 경계는 broker 프로세스에만 `NODE_OPTIONS=--import scripts/fakeclock.mjs`로 `Date.now` fixture를 주입했다. 상태는 실험마다 격리된 `HOME`/state 디렉터리.

| # | 실험 | 버전 | 횟수 | 위반 | 판정 | 비고 |
|---|---|---|---|---|---|---|
| E1 | 8 MCP 프로세스 × 200 prepare→send, 같은 target (distinct 101/404, drain 202/505, same-sender 303) | v53 | 5회, send 7,500 | 0 | PASS | 매 회 수락 1000, 나머지는 receipt 상한 거절(600/100). 거절 행 상태 불변. drain 2개 수신자 claim 739/722건 중복 0 |
| E1 | distinct 101, drain 202 | v271 | 2회 | 0 | PASS | 동일 수치 |
| E2a | 같은 ID를 k=2..8 MCP 프로세스가 동시 send (seed 11,12 × 20 rounds) | v53 | 280 | 0 | PASS | 매 사례 `duplicate:false` 정확히 1, 저장 1행, createdAt 1종 |
| E2b | CLI send를 0–119ms 뒤 SIGKILL → 같은 ID를 MCP로 재시도 2회 | v53 | 120 | 0 | PASS | kill 전 저장 0행 53건→재시도 `false`, 1행 67건→재시도 `true`; 최종 1행 |
| E2 | seed 11 | v271 | 140+60 | 0 | PASS | 동일 |
| E3a | 수신 2 프로세스 동시 claim (CLI / Claude Stop hook / Codex PostToolUse hook), 12건 × 6 rounds × seed 31,32 | v53 | 144 claim | 0 | PASS | 중복 0, 누락 0 |
| E3b | lease 경계: lease−1ms에 2 프로세스 동시 claim → 0건, 정확히 lease에 → 1건, 같은 ID, attempt 2..6, firstDeliveredAt 불변, 최종 lease 1800s | v53 | 10 경계×2 seed | 0 | PASS | |
| E4 | ACK: 다른 세션 ID, sender가 ACK, 모르는 ID, MCP 중복 배열, 두 번째 ACK, broker 중복 배열, ACK 뒤 재전달, ACK-before-claim, forged binding | v53 | 11×2 | 0 | PASS | 모두 0건/상태 불변; MCP 중복 배열은 INVALID_INPUT; broker 중복 배열은 1 |
| E3/E4 | seed 31 | v271 | 동일 | 0 | PASS | 항목 diff 0 |
| E5 | TTL 인자 29/30/86400/86401/30.5/0/−1 | v53 | 7 | 0 | PASS | 30·86400만 수락, 거절 상태 불변 |
| E5 | 만료 E−1 / E / E+1ms: pending 2/0/0, claim 1/0, E+1 status=`submitted/unknown`, E+1 재send `duplicate:true` 무변화 | v53 | 1 | 0 | PASS | O4 참고 |
| E5 | receipt 만료 RE−1 `duplicate:true`, RE 거절·무변화; draft 만료 P+600000−1 수락, 정확히 P+600000 거절 | v53 | 4 | 0 | PASS | |
| E5 | 본문 경계 17종 (ASCII 4096/4097, `가`×1365+a=4096B, +ab=4097B, `가`×1366=4098B, a×4093+가=4096B, a×4094+가=4097B, 😀×1024=4096B, +a, a×4093+😀=4097B, a×4092+😀=4096B, 제어문자 4096, `"\` 4096, 공백만, NUL, lone surrogate, NFD 한글) → Stop hook 전달·digest 확인 | v53 | 17 | 0 | PASS | 4096B 수락·4097B 거절 일관; 제어문자/따옴표는 base64 envelope(6457B ≤ 8192) |
| E5 | hook fail-open(trust DB 쓰기 불가) 뒤 재전달 | v53 | 1 | 0 | PASS | 120s 비가시 후 같은 ID attempt 2 |
| E5 | 전체 | v271 | 30 | 0 | PASS | 항목 diff 0 |
| E7a | 키 순서·공백만 다른 raw JSON-RPC prepare 2건 | v53 | 1 | 0 | PASS(설계) | ID 2개, 메시지 2건 (O9) |
| E7b | Codex PreToolUse `wait_threads`: 순서 뒤섞기/객체 키 순서/`hostId:"local"`/중복 target → 두 번째 호출 `deny unchanged`; cursor 변경 → snapshot | v53 | 8 | 0 | PASS | adapter 정규화 확인 |
| E7c | broker `peer-wait`에 키 순서만 다른 JSON 문자열 `queryRevision` | v53 | 3 | 0 | 관측 | 둘 다 snapshot = 다른 revision 취급 (O7) |
| E7 | 전체 | v271 | 11 | 0 | PASS | 항목 diff 0 |
| E8a | DB `BEGIN IMMEDIATE` 1000/3000/7000ms 보유 중 4 프로세스 send → 해제 후 재시도 | v53 | 3 seed × 12 | 0 | PASS | 모두 최종 1행, `false` ≤1회; 3000·7000ms에서 첫 가시 응답이 `duplicate:true`인 사례 다수 (O3) |
| E8b | 4 MCP × 200 send 중 진행률 기반 broker SIGKILL/SIGTERM 6회 (seed 82,83,84) | v53 | 2400 send, kill 18 | 0 | PASS | 1차 실패 0 (client 재시도가 흡수), `firstVisibleDuplicate` 1 (seed 84) |
| E8 | seed 82 | v271 | 800 send, kill 6, lock 12 | 0 | PASS | 동일 |

실패·재실행 기록:
- E3 첫 실행(seed 31, v53)은 lease 누적(120+240+480+960+1800s)=기본 TTL 3600s라 시도 6 경계에서 메시지가 만료·삭제되어 스크립트가 행을 찾지 못해 종료했다. 제품 동작은 설계대로(O4); fixture를 TTL 86400으로 바꿔 재실행.
- E8 첫 실행(seed 81)은 하네스 버그(lock 프로세스 `close` listener를 종료 뒤에 등록)로 멈춰 ~605s 뒤 수동 종료(`18-e8-81-hung-run.*`). 수정 후 `19-e8-81.log`.
- E8 seed 82/83 시간 기반 kill 실행(`20-e8-kill.log`)은 burst가 kill 전에 끝나 kill 1회만 유효했다. 진행률 기반으로 바꿔 `21-...log`로 재실행했고, 같은 파일명의 `e8-8[23]-v53.json`은 재실행 결과로 덮였다(시간 기반 결과는 로그 요약만 남음).
- 일부 초기 로그(`10`–`17`, `30`)는 `tee`만 사용해 `EXIT=` 줄이 없다. 각 스크립트가 끝까지 실행돼 요약 JSON을 출력한 것으로 완료를 판단했다.

## 3. 관측 (위반 아님, 모두 v271에도 존재 = 기존)

- **O1 전역 receipt 상한이 가용성 병목**: receipt는 ACK와 무관하게 `message 만료 + 1h`까지 남고(store `:20`, `:313`) 전역 1000건 상한(`:18`, `:309-310`)이다. 기본 TTL에서 전역 약 1000 send / 2h, TTL 86400이면 한 sender가 최대 25h 동안 모든 sender의 send를 막을 수 있다(E1: 8 sender 합산 1000 뒤 전부 거절). 이 거절은 service `:59-60`에서 `MCP_UNAVAILABLE` + "같은 ID만 재시도, 다시 prepare 금지"로 안내되지만 draft는 10분 뒤 만료되므로 용량이 풀리기 전에 그 intent는 보낼 수 없게 된다. 유실은 아니다(거절 상태 불변, sender에 오류 반환).
- **O2 sender draft 상한 연쇄**: 거절된 send의 draft가 남아(E1 same: 100건) sender당 100 한도에 닿으면 그 sender의 prepare가 전부 실패(500건).
- **O3 첫 가시 응답이 `duplicate:true`**: client 시도당 2.5s(client `:29`)보다 broker 처리가 길면(DB lock 3s·7s, 또는 commit 뒤 응답 유실) 첫 요청이 insert하고 재요청이 `true`를 받는다. sender 한정 ID라 중복 전달은 아니지만 `duplicate`만으로 "내 호출이 처음 넣었는지"는 판별할 수 없다.
- **O4 만료가 전달 증거를 지움**: E−1에 claim된 메시지를 E에 ACK하면 `acknowledged:0`(행 prune, store `:256`), 이후 status는 `submitted/deliveryState unknown`(`:537-542`). 또한 lease 누적이 TTL에 닿으면 ACK 없이 삭제된다(기본 TTL에서 시도 6 경계 = 정확히 3600s).
- **O5 claim 전 ACK 허용**: 수신자는 한 번도 전달되지 않은(`delivery_attempts=0`) 메시지도 ACK 가능(store `:516-517`).
- **O6 신원은 호출자 주장**: MCP 서버·CLI·broker는 `_sessionBinding`/payload 신원을 그대로 쓴다(service `:18-24`, broker `:31-36`). PreToolUse hook은 도구 입력의 위조 binding을 자기 세션으로 덮어썼다(E4 d). hook 없이 MCP를 직접 호출하거나 token을 가진 같은 사용자 프로세스는 임의 세션의 메시지를 claim·ACK할 수 있다(E4 e, 1건 ACK 성공). 신뢰 경계가 "같은 사용자 로컬 프로세스 + host hook"임을 뜻한다.
- **O7 `queryRevision`은 broker에서 불투명 문자열**: 키 순서만 다른 JSON을 그대로 보내면 변경으로 취급된다(broker `:309`, `:322`). 현재 Codex adapter는 정렬·중복 제거·sha256으로 정규화해 문제없음(E7b). 새 host adapter가 같은 정규화를 하지 않으면 2.6.0 계열 결함이 재발할 수 있다. 또 `afterCursor: null`은 adapter가 wait로 인식하지 않아(`host-input-adapter.ts:143`) peer-wait 정책이 적용되지 않는다.
- **O8 lone surrogate**: `a\uD800b`는 저장 시 U+FFFD로 바뀌어 전달 본문이 송신 문자열과 다르다(`body_bytes` 5, digest는 UTF-8 인코딩 기준으로 일치).
- **O9 내용 기반 멱등 없음**: 같은 내용을 두 번 prepare하면 ID 2개·메시지 2건(설계: 새 prepare = 새 의도).
- **O10 hook fail-open 뒤 lease 동안 비가시**: claim 후 receipt 기록 실패 시 hook은 빈 출력, 메시지는 lease(120s~) 동안 보이지 않다가 같은 ID로 재전달(E5).

## 4. 최소 재현

불변식 위반이 없어 위반 재현 스크립트는 없다. 관측 재현:
- O1/O2: `TARGET_ROOT=/tmp/v53 node scripts/e1-burst.mjs 101 distinct` (same-sender는 `303 same`).
- O3: `E8_N=200 node scripts/e8-lock-restart.mjs 81` → lockLog hold 3000.
- O4/O8/O10: `node scripts/e5-boundaries.mjs`.
- O5/O6: `node scripts/e3-claim-ack.mjs 31` → ackLog.
- O7: `node scripts/e7-normalization.mjs` → `broker-opaque-queryRevision`.
행 dump: `rows-e1-drain-202-v53-*.json`, `rows-e3-31-v53-messages.json`, schema `schema-session-messages.sql`, DB `db/*.sqlite3`.

## 5. NOT_RUN / UNKNOWN

| 항목 | 판정 | 이유 |
|---|---|---|
| Codex managed wake(`claim-host-wake`)와 53eff30의 빈 wake block 경로의 다중 프로세스 경합 | NOT_RUN | 실제 relay·host 프로세스 신원과 trust DB wake 관측이 필요해 이번 큐 멱등성 범위에서 제외 |
| 실제 Codex/Claude Code 호스트, Windows | NOT_RUN | 단일 Linux 컨테이너 |
| 실시간 lease 만료 | NOT_RUN | 시간 fixture로 대체(E3b) |
| broker commit 직전·직후를 정확히 겨냥한 kill | UNKNOWN | 진행률 기반 무작위 kill 18회만 수행 |
| 저장소 전체 검증 순서(lint/bundle:check/validate 등) | NOT_RUN | 실험 과제; install+build와 session-messaging 테스트만 실행 |
| 서비스 429/5xx·네트워크 실패 | 해당 없음 | Node tarball·git fetch·pnpm 모두 1회 성공 |
