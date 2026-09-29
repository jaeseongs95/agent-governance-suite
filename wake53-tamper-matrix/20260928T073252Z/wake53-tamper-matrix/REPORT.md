# J1 — wake 후보 53eff30a: hook 도착·receipt 변조와 DB 실패 행렬 (CASE=wake53-tamper-matrix)

- 대상: `53eff30a2984d41fc749d38dd2062966017684fa` (tree `c030fa4e19411ef511c5d5c89cf588aa6f42c059` 확인, 로그 `01-fetch-worktree.log`)
- 기준: `d5c5932cd5a0d87630f6ed94f8e3721181ab9864` (v2.7.1, origin/main)
- 환경: Linux cloud 컨테이너 한 대, root, Node v24.21.0 (SHASUMS256 검증, `00-node-install.log`), pnpm 11.19.0. 두 worktree 모두 `pnpm install --frozen-lockfile && pnpm build` EXIT=0.
- **이 결과는 일회용 Linux cloud 실험이다. 사용자 PC 운영 상태, 실제 Codex/Claude host 설치, live wake 증거가 아니다.** 소스·테스트·설정은 고치지 않았다. 실험 스크립트는 `scripts/`에 있다.

## 요약

| 항목 | 결과 |
|---|---|
| 변조·경계 행렬 (130 케이스, store/broker 직접 호출) | v53: PASS 128, PASS*(설계상 claim, 주석) 2, **FAIL 0**. v271도 같음 |
| seeded 다중 변조 fuzz (seed 11,12,13 × 300, 불변식 I1–I3) | v53·v271 모두 **위반 0** (`16-fuzz-*.jsonl`, `17-fuzz-coverage.log`) |
| 저장소 실패 주입 (23 케이스 + open-store 잠금 2) | 두 버전 결과 동일. 거절·실패 경로에서 **잘못된 claim·해제·enqueue 0** |
| 빈 Codex wake 차단 hook 경계 (31 입력, 실제 bundled hook + broker) | v53: 31/31 기대대로. 검증된 현재 세대의 빈 wake만 block |
| 기존 회귀 `vitest tests/session-messaging` | v53 148 passed/1 skipped, v271 143 passed/1 skipped (`30-*.log`) |
| **잘못된 unknown/활성 행 해제, 현재 claim·enqueue·dispatch** | **관측 0건**. 서명 검증이 통과하지 않은 입력에서는 행 변화가 0이었다 |

실험 도중 발견해 고친 하네스 결함(모두 제품 결함 아님): 첫 matrix 실행(`10-matrix-v53-firstpass.jsonl`)의 FAIL 5건은 presence lease(20s)가 receipt TTL(30s)과 row TTL(1h)보다 짧아 생긴 설계 오류와, `obs=array` 변조가 실제 배열을 만들지 않은 오류였다. fuzz 첫 두 번(`14-*`, `15-*`)은 하네스의 messageId 길이와 relay lease 누락 때문에 실패했다. 모두 고친 뒤 `12-*`와 `16-*`을 다시 실행했다.

## 1. 검증 항목 (v53 파일:줄)

| 항목 | 위치 | 검사 내용 |
|---|---|---|
| 관측 형식·대상 | `mcp-server/src/session-message-wake-port.ts:80-89` | host/sessionId == target, kind=user-input, wakeOnly===true, actor.observedBy=`<host>:hook-payload`, actor.kind∈{main,unknown}, assurance∈{observed,unknown}, candidates 배열 1–10개, 각 `^[A-Za-z0-9_-]{22,128}$` |
| 관측 digest | `session-message-wake-port.ts:94-98` | sha256(JSON[host, sessionId, kind, wakeOnly, actor.kind, observedBy, assurance, sorted unique candidates]) |
| receipt 발급 (hook) | `session-message-wake-port.ts:100-109`, 호출 `session-message-hook.ts:202` | TrustStore.recordInputSource, originKind=peer, authorityEffect=none, attestation broker-peer-envelope/session-message-wake-hook/1.0.0, **TTL 30s** (`:106`) |
| 서명/MAC | `trust-store.ts:145-152` (HMAC-SHA256 + timingSafeEqual `:150`), key `trust-store.ts:46-47` (trust_metadata `trust-signing-key`, 32B) | canonicalJson(receipt − integrityToken) |
| receipt 검증 | `session-message-wake-port.ts:112-122` | trust DB 없으면 거절 (`:113` existsSync), verify, host/session, originKind, authorityEffect, attestation 3필드, contentDigest, `observedAt ≤ now < expiresAt` (`:121`) |
| nonce 등록·세션 결속 | `session-message-store.ts:826-830` | digest가 같은 target(host, session)의 행으로 모두 존재하고 state∈{legacy, started, submitted, unknown}이어야 한다. 아니면 변경 없이 거절 |
| instance_id / birth_generation / transport / presence / TTL | `session-message-store.ts:831-835` | row.instance_id==presence.instanceId, row.birth_generation==presence.startedAt, row.transport==presence.transport, presence online, peer-wake 지원, row.expires_at>now |
| 옛 세대·만료 도착 종료 (53eff30a 신규) | `session-message-store.ts:836-842` | 위 검사가 실패해도 receipt가 검증되면 managed 행을 `observed`와 `late_observed_at`으로 바꾸고 recognized=false를 반환한다 |
| 현재 세대 claim | `session-message-store.ts:844-854` | claimLocked와 관측 표시를 같은 BEGIN IMMEDIATE transaction(`:823`)에서 처리한다 |
| broker managed 플래그 (신규) | `session-message-broker.ts:271` | managed = binding !== null |
| 빈 Codex wake 차단 (신규) | `session-message-hook.ts:198-209` | host==="codex" && recognized && managed===true && messages.length===0 → `{decision:"block"}` |
| marker 파싱 | `session-message-client.ts:339-356` | `split(/\r?\n/)`, 줄마다 `trim()`, 빈 줄 제거. 모든 줄이 `[agent-governance-suite:wake:<nonce>]`이어야 wakeOnly |

## 2. 변조·경계 행렬 (`12-matrix-<wt>.jsonl`, 하네스 `scripts/matrix.mts`, SEED=20260928)

판정 기준은 다음과 같다. reject-nochange는 recognized=false이고 wake_nonces·messages 행 변화 0, 새 wake 행 0, 새 claim 0이어야 한다(throw여도 행 변화가 0이면 PASS). accept-claim은 정상 claim이다. retire-noclaim은 53eff30a가 문서화한 "검증된 옛·만료 도착 종료"로, 행은 observed(late)가 되지만 claim 0, 새 행 0이어야 한다. throw-nochange는 예외가 나고 행 변화가 0이어야 한다. `post`는 케이스 직후 새 managed wake를 reserve할 수 있는지(=활성 fence가 풀렸는지)를 뜻한다. PASS*는 관측 전용 케이스 2건이다. 둘 다 claim이 발생했지만 제품 결함이 아니다. (a) `legacy:valid legacy marker`는 legacy marker가 설계상 claim한 것이다(managed=false, block 대상 아님). (b) `key:trust DB file read-only (0400)`은 root가 파일 권한을 우회해 의미가 없는 실험이며, nobody로 다시 실행한 결과는 §4에 있다.

| # | 입력(id) | 그룹 | 기대 | v53 관측 (rec/managed/msgs, 행 전→후, 새 claim, 새 wake행, 이후 reserve) | v53 판정 | v271 관측 (행 후, 이후 reserve) | v271 판정 |
|---|---|---|---|---|---|---|---|
| 1 | `control-valid-unknown` | control | accept-claim | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 2 | `control-valid-submitted` | control | accept-claim | true/true/1, submitted→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 3 | `control-valid-started` | control | accept-claim | true/true/1, started→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 4 | `obs:obs.host=claude-code` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 5 | `obs:obs.host missing` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 6 | `obs:obs.host=number` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 7 | `obs:obs.host=''` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 8 | `obs:obs.sessionId other` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 9 | `obs:obs.sessionId missing` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 10 | `obs:obs.sessionId=1MB` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 11 | `obs:obs.sessionId unicode` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 12 | `obs:obs.sessionId ctrl NUL` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 13 | `obs:obs.kind=turn-end` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 14 | `obs:obs.kind missing` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 15 | `obs:obs.wakeOnly=false` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 16 | `obs:obs.wakeOnly='true'` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 17 | `obs:obs.wakeOnly missing` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 18 | `obs:obs.actor.observedBy other host` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 19 | `obs:obs.actor.observedBy ''` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 20 | `obs:obs.actor.kind=subagent` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 21 | `obs:obs.actor.kind=unknown (digest differs)` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 22 | `obs:obs.actor.assurance=unknown (digest differs)` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 23 | `obs:obs.actor.assurance=verified` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 24 | `obs:obs.actor missing` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 25 | `obs:obs.actor=null` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 26 | `obs:obs.wakeCandidates other nonce` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 27 | `obs:obs.wakeCandidates +extra unregistered` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 28 | `obs:obs.wakeCandidates missing` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 29 | `obs:obs.wakeCandidates []` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 30 | `obs:obs.wakeCandidates string` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 31 | `obs:obs.wakeCandidates [number]` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 32 | `obs:obs.wakeCandidates ['']` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 33 | `obs:obs.wakeCandidates len129` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 34 | `obs:obs.wakeCandidates len21` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 35 | `obs:obs.wakeCandidates 11 items` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 36 | `obs:obs.wakeCandidates unicode suffix` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 37 | `obs:obs.wakeCandidates ctrl \n suffix` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 38 | `obs:obs.wakeCandidates case-flipped` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 39 | `obs:obs.wakeCandidates duplicate same nonce (digest set-equal)` | observation | accept-claim | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 40 | `obs:obs extra field ignored (digest subset)` | observation | accept-claim | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 41 | `obs=array [obs]` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 42 | `obs=null` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 43 | `obs=string` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 44 | `reader undefined` | observation | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 45 | `rid:receiptId=''` | receiptId | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 46 | `rid:receiptId other uuid` | receiptId | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 47 | `rid:receiptId flipped last char` | receiptId | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 48 | `rid:receiptId 1MB` | receiptId | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 49 | `rid:receiptId unicode` | receiptId | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 50 | `rid:receiptId ctrl NUL` | receiptId | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 51 | `rid:receiptId SQL-ish` | receiptId | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 52 | `rid:receiptId uppercased` | receiptId | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 53 | `broker:sourceReceiptId number` | receiptId-type | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 54 | `broker:sourceReceiptId null` | receiptId-type | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 55 | `broker:sourceReceiptId object` | receiptId-type | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 56 | `broker:sourceReceiptId array` | receiptId-type | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 57 | `broker:sourceReceiptId missing` | receiptId-type | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 58 | `broker:control valid (real clock)` | control | accept-claim | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 59 | `broker:target.host number` | receiptId-type | throw-nochange | null/null/null, unknown→unknown, claim=0, rows+0, post=false, err=Error: Session identity is invalid. | PASS | unknown, post=false | PASS |
| 60 | `rec-nosign:host` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 61 | `rec-resign:host` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 62 | `rec-nosign:sessionId` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 63 | `rec-resign:sessionId` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 64 | `rec-nosign:contentDigest` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 65 | `rec-resign:contentDigest` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 66 | `rec-nosign:originKind=tool` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 67 | `rec-resign:originKind=tool` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 68 | `rec-nosign:authorityEffect=approve` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 69 | `rec-resign:authorityEffect=approve` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 70 | `rec-nosign:attestation.kind` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 71 | `rec-resign:attestation.kind` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 72 | `rec-nosign:attestation.adapter` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 73 | `rec-resign:attestation.adapter` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 74 | `rec-nosign:attestation.capabilityVersion` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 75 | `rec-resign:attestation.capabilityVersion` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 76 | `rec-nosign:observedAt future+60s` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 77 | `rec-resign:observedAt future+60s` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 78 | `rec-nosign:expiresAt past` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 79 | `rec-resign:expiresAt past` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 80 | `rec-nosign:expiresAt invalid string` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 81 | `rec-resign:expiresAt invalid string` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 82 | `rec-nosign:observedAt invalid string` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 83 | `rec-resign:observedAt invalid string` | receipt-resigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 84 | `rec-resign:expiresAt extended +1h (key holder)` | receipt-resigned-tamper | accept-claim | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 85 | `rec-nosign:receiptId inside json` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 86 | `rec-resign:receiptId inside json (key holder)` | receipt-resigned-tamper | accept-claim | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 87 | `rec-nosign:integrityToken flipped` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 88 | `rec-nosign:integrityToken missing` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 89 | `rec-nosign:integrityToken number` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 90 | `rec-nosign:integrityToken truncated` | receipt-unsigned-tamper | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 91 | `rec:receipt_json corrupt (not JSON)` | receipt-unsigned-tamper | throw-nochange | null/null/null, unknown→unknown, claim=0, rows+0, post=false, err=INVALID_INPUT: Cannot read the input source receipt. | PASS | unknown, post=false | PASS |
| 92 | `ttl:now=observedAt-1ms` | ttl | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 93 | `ttl:now=observedAt exact` | ttl | accept-claim | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 94 | `ttl:now=expiresAt-1ms (presence heartbeated)` | ttl | accept-claim | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 95 | `ttl:now=expiresAt-1ms (presence lease lapsed)` | ttl | retire-noclaim | false/false/0, unknown→observed(late), claim=0, rows+0, post=true | PASS | unknown(late), post=false | PASS |
| 96 | `ttl:now=expiresAt exact (presence heartbeated)` | ttl | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 97 | `ttl:now=expiresAt exact` | ttl | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 98 | `ttl:now=expiresAt+1ms` | ttl | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 99 | `ttl:receipt issued in future (+60s) used now` | ttl | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 100 | `rowttl:row expires_at-1ms` | row-ttl | accept-claim | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 101 | `rowttl:row expires_at exact` | row-ttl | retire-noclaim | false/false/0, unknown→observed(late), claim=0, rows+0, post=true | PASS | unknown(late), post=false | PASS |
| 102 | `rowttl:row expires_at+1ms` | row-ttl | retire-noclaim | false/false/0, unknown→observed(late), claim=0, rows+0, post=true | PASS | unknown(late), post=false | PASS |
| 103 | `replay:same receipt twice` | replay | reject-nochange | false/false/0, observed→observed, claim=0, rows+0, post=false | PASS | observed, post=false | PASS |
| 104 | `replay:receipt of target A with target B obs` | replay | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 105 | `replay:A's nonce + A's receipt presented for target B` | replay | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 106 | `replay:A obs+receipt, target arg B (target/obs mismatch)` | replay | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 107 | `replay:receipt from a different trust DB (other key)` | replay | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 108 | `key:trust DB missing` | key | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 109 | `key:trust signing key row deleted` | key | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 110 | `key:different 32B key` | key | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 111 | `key:corrupt key (16B)` | key | throw-nochange | null/null/null, unknown→unknown, claim=0, rows+0, post=false, err=INVALID_INPUT: Cannot initialize the trust database. | PASS | unknown, post=false | PASS |
| 112 | `key:corrupt key (non-base64 text)` | key | throw-nochange | null/null/null, unknown→unknown, claim=0, rows+0, post=false, err=INVALID_INPUT: Cannot initialize the trust database. | PASS | unknown, post=false | PASS |
| 113 | `key:trust DB file garbage` | key | throw-nochange | null/null/null, unknown→unknown, claim=0, rows+0, post=false, err=INVALID_INPUT: Cannot initialize the trust database. | PASS | unknown, post=false | PASS |
| 114 | `key:trust DB zero-length` | key | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 115 | `key:trust DB newer schema (user_version 999)` | key | throw-nochange | null/null/null, unknown→unknown, claim=0, rows+0, post=false, err=INVALID_INPUT: Trust database schema is newer than this serv | PASS | unknown, post=false | PASS |
| 116 | `key:trust DB file read-only (0400)` | key | reject-any | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS* | observed, post=false | PASS* |
| 117 | `gen:new instance (new generation)` | generation | retire-noclaim | false/false/0, unknown→observed(late), claim=0, rows+0, post=true | PASS | unknown(late), post=false | PASS |
| 118 | `gen:same instance restarted (new birth_generation)` | generation | retire-noclaim | false/false/0, unknown→observed(late), claim=0, rows+0, post=true | PASS | unknown(late), post=false | PASS |
| 119 | `gen:transport differs (codex-deferred)` | generation | retire-noclaim | false/false/0, unknown→observed(late), claim=0, rows+0, post=false | PASS | unknown(late), post=false | PASS |
| 120 | `gen:presence lease lapsed (unreachable, same gen)` | generation | retire-noclaim | false/false/0, unknown→observed(late), claim=0, rows+0, post=true | PASS | unknown(late), post=false | PASS |
| 121 | `gen:presence ended (same gen)` | generation | retire-noclaim | false/false/0, unknown→observed(late), claim=0, rows+0, post=false | PASS | unknown(late), post=false | PASS |
| 122 | `gen:no presence row` | generation | retire-noclaim | false/false/0, unknown→observed(late), claim=0, rows+0, post=false | PASS | unknown(late), post=false | PASS |
| 123 | `mixed:current + unregistered` | mixed | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 124 | `mixed:current + legacy fresh` | mixed | accept-claim | true/true/1, unknown→observed, claim=1, rows+0, post=false | PASS | observed, post=false | PASS |
| 125 | `mixed:current + legacy already consumed` | mixed | reject-any | false/false/0, unknown→observed(late), claim=0, rows+0, post=true | PASS | unknown(late), post=false | PASS |
| 126 | `mixed:current + legacy expired` | mixed | reject-any | false/false/0, unknown→observed(late), claim=0, rows+0, post=true | PASS | unknown(late), post=false | PASS |
| 127 | `mixed:current + already observed row` | mixed | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 128 | `mixed:current + not-submitted row` | mixed | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 129 | `mixed:current + other session's nonce` | mixed | reject-nochange | false/false/0, unknown→unknown, claim=0, rows+0, post=false | PASS | unknown, post=false | PASS |
| 130 | `legacy:valid legacy marker` | legacy | reject-any | true/false/1, legacy→legacy, claim=1, rows+0, post=false | PASS* | legacy, post=false | PASS* |

### 2.1 53eff30a 대비 2.7.1 차이 (`13-matrix-diff-v53-vs-v271.log`)

차이는 의도한 변경뿐이다. receipt가 검증됐지만 현재 세대가 아닌 경우, 2.7.1은 행을 `unknown(late)`로 남기고 fence를 유지했다(post=false). 53eff30a는 `observed(late)`로 종료하고, 새 pending wake를 다시 reserve할 수 있다(post=true; presence가 없거나 끝났거나 transport가 다르면 post=false). broker 응답에는 `managed` 필드가 추가됐다. 서명·대상·digest·TTL·key 변조의 거절 결과는 두 버전이 같다.

### 2.2 주목할 관측 (FAIL은 아니며 문서 범위와 어긋날 수 있는 점)

| ID | 관측 | 재현 | 판정 |
|---|---|---|---|
| N1 | **동반 nonce 때문에 현재 세대 fence가 종료된다.** 현재 세대의 유효한 managed nonce와 이미 소비됐거나 만료된 legacy nonce를 한 prompt에 함께 넣으면(receipt는 그 조합으로 정상 발급), `valid=false`가 된다. 그 결과 현재 세대 행이 claim 없이 `observed(late)`로 종료되고 본문은 pending으로 남으며, 이후 새 wake를 reserve할 수 있다(추가 enqueue 1회 가능). 문서(`docs/session-message-lifecycle.md`)가 종료 근거로 드는 것은 "만료 또는 옛 generation marker"이고, legacy 동반은 명시되지 않았다. 2.7.1에서는 `unknown(late)`로 fence가 유지된다. | `cd /tmp/v53 && WT=/tmp/v53 ONLY="mixed:current + legacy already consumed" SEED=20260928 tsx scripts/matrix.mts` (행 dump는 `12-matrix-v53.jsonl`의 rowDiff) | PASS(claim·enqueue 0) / 문서 불일치 가능. 판단 필요 |
| N2 | **같은 세대인데 presence lease만 만료(20s)되거나 presence가 종료된 상태에서** 검증된 도착이 오면 현재 세대 행도 `observed(late)`로 종료된다. receipt TTL(30s)이 presence lease(20s)보다 길어서 heartbeat가 끊긴 20–30s 구간에 이 경로를 탄다. | `ttl:now=expiresAt-1ms (presence lease lapsed)`, `gen:presence lease lapsed (unreachable, same gen)` | PASS(claim 0) / 문서 범위 밖 종료 사유 |
| N3 | **trust DB 쓰기 (2.7.1부터 있던 동작).** receipt 검증기가 거절 경로에서도 `new TrustStore()`를 열어 `BEGIN IMMEDIATE … PRAGMA user_version … COMMIT`과 chmod를 실행한다. 호출마다 trust DB change counter가 +1 된다. **signing key 행이 없으면 새 key를 만들어 저장한다**(검증 결과는 false). 과제의 "없는 key를 새로 만들지 않음"에 어긋난다. DB 파일이 없을 때는 `existsSync`로 막혀 새로 만들지 않는다. | `scripts/trust-write-probe.mts` → `11-trust-write-probe.log` (v53·v271 동일) | **FAIL(과제 불변식: 없는 key 생성)**, 해제·claim 영향은 없음 |
| N4 | key를 가진 쪽(같은 OS 사용자)은 receipt `expiresAt`을 연장하거나 JSON 안의 receiptId를 바꾼 뒤 재서명해 통과시킬 수 있다. 조회에 쓴 receipt_id와 JSON receiptId를 대조하지 않는다. 문서가 밝힌 한계("같은 OS 사용자가 … source key를 변조할 수 없다는 보장을 만들지 않는다")에 해당한다. | `rec-resign:expiresAt extended +1h (key holder)`, `rec-resign:receiptId inside json (key holder)` | INFO |
| N5 | marker 파싱의 `trim()`이 NBSP, BOM(U+FEFF), U+2028도 지운다. 그래서 이 문자가 붙은 **검증된** marker도 block된다. nonce와 receipt 검증은 여전히 필요하므로 위조 경로는 아니다. ZWSP, NUL, ESC, 단독 CR은 통과(비차단)한다. | §5 hook 표 7–9 | INFO(설계 확인 필요) |

## 3. seeded fuzz (`scripts/fuzz.mts`)

seed 11/12/13에서 각각 300회를 v53과 v271에 실행했다. 회마다 target 두 개(A, B)를 만들고, 17종 변조(관측 필드, 후보 추가·교체·중복, B의 nonce·receipt 재사용, receipt 재발급, 시각 이동, 세대 교체, presence 종료, row 만료) 중 1–3개를 무작위로 적용했다.
- I1: wake 행이 바뀌면 (reader가 검증 통과 ∧ 모든 후보가 target의 활성 행)이어야 한다
- I2: claim이 생기면 (recognized ∧ 현재 세대 결속)이어야 한다
- I3: recognized=false면 claim 0이고 새 wake 행 0이어야 한다
결과: 위반 0/1800. 커버리지는 recognized 43, 검증 통과 146, 거절이면서 행 종료(retire)된 경우 99이다(`17-fuzz-coverage.log`). 두 버전의 집계가 같다. 차이는 retire 결과 상태(observed vs unknown)뿐이다.

## 4. 저장소 실패 주입 (`scripts/storage-driver.sh`, `scripts/storage.mts`, `scripts/lock-open.mts`)

각 케이스는 setup(unknown 상태의 현재 세대 wake + 유효 receipt) → 주입 → 새 프로세스에서 `SessionMessageStore` open + `claimHostWake` → 파일 해시와 행 dump 순서로 진행했다. 두 버전의 claim 결과가 모두 같다(`21-storage-v53.log`, `21-storage-v271.log`, `24-storage-poststate-summary.log`).

| 케이스 | 관측 (v53 = v271) | 행 변화 | 판정 |
|---|---|---|---|
| DB 파일 없음 | store open이 빈 DB를 새로 만든다(broker 기동 동작). claim은 recognized=false | 새 DB라 행 없음. claim·enqueue 0 | PASS(거절) / DB 생성은 store 생성자 동작 |
| 디렉터리 없음 | 위와 같다(디렉터리와 DB 생성). trust DB는 만들지 않음 | 0 | PASS / 같은 주석 |
| 읽기 전용 디렉터리(nobody, 0500/0400) | `Cannot initialize the trust database.` throw | 0, session DB 바이트 불변 | PASS |
| 읽기 전용 session DB 파일(nobody, 0400) | `attempt to write a readonly database` | 0. session 본문 바이트 불변. **trust DB는 바뀜(N3)** | PASS |
| 읽기 전용 trust DB(nobody, 0400) | `Cannot initialize the trust database.` | 0. trust에 -wal/-shm sidecar 생성(읽기 전용 sidecar) | PASS |
| 다른 프로세스 BEGIN EXCLUSIVE — session DB(open 전) | open 단계에서 5s 뒤 `database is locked` | 0 | PASS |
| 다른 프로세스 BEGIN EXCLUSIVE — session DB(store 이미 open) | 5.0s 뒤 `database is locked` | 0 | PASS (`22-lock-open-store.log`) |
| 다른 프로세스 BEGIN EXCLUSIVE — trust DB | 5.0s 뒤 `Cannot initialize the trust database.`. 그동안 session DB의 IMMEDIATE 잠금을 5s 잡고 있음 | 0 | PASS / 성능 주석 |
| SHM 무작위 바이트 | SQLite가 재구성하고 정상 claim | 정상 | PASS(정상 경로) |
| close 뒤 WAL에 쓰레기 8KB | 체크섬 불일치로 무시하고 정상 claim | 정상 | PASS |
| crash(close 없이 exit) 뒤 WAL/SHM 삭제 | 커밋이 WAL에만 있어 **모든 행 소실**(SQLite 내구성 특성). 이어진 store open이 schema를 다시 만들고 claim은 거절 | 새 claim·enqueue 0 | PASS(잘못된 claim 없음) / 데이터 소실은 환경 주입 결과 |
| crash 뒤 WAL 끝 4KB 손상 | 마지막 frame 폐기. 남은 상태로 정상 claim | 정상 | PASS |
| crash 뒤 SHM 손상 | 재구성하고 정상 claim | 정상 | PASS |
| schema: wake_nonces DROP | 생성자가 빈 테이블을 다시 만든다. claim 거절 | 본문 미claim | PASS |
| schema: messages.claim_until 제거 | open 단계에서 `no such column: claim_until` | 0 | PASS |
| schema: wake_nonces UPDATE 시 RAISE(ABORT) | claim 후 wake UPDATE가 실패해 ROLLBACK. `j1 injected update failure` | 0 (messages claim도 rollback) | PASS (원자성) |
| schema: messages UPDATE 시 RAISE(ABORT) | `j1 injected claim failure` | 0 | PASS |
| session DB 쓰레기 바이트 | `file is not a database` | — | PASS |
| trust DB 없음 | recognized=false. trust DB를 만들지 않음 | 0 | PASS |
| 디스크 가득 — session DB만 (384KB tmpfs, trust는 일반 디스크) | **`cannot rollback - no transaction is active`**: 원래 SQLITE_FULL 오류가 catch 안의 ROLLBACK 실패로 가려진다 | 0, 본문 바이트 불변 | PASS(상태) / 오류 코드 가림(주석 N6) |
| 디스크 가득 — 둘 다 | `Cannot initialize the trust database.` | 0 | PASS |

N6: `claimHostWake`의 `catch { ROLLBACK; throw }`(`session-message-store.ts:855`)에서 SQLite가 이미 자동 rollback했으면 ROLLBACK 자체가 throw해 원래 오류(SQLITE_FULL)를 가린다. 상태는 안전하다. 진단 정확도에만 영향이 있고 v271도 같다.

## 5. 빈 Codex wake prompt 차단 hook 경계 (`scripts/hook-boundary.mts`, SEED=7)

bundled `mcp-server/dist/session-message-hook.mjs`를 실제 bundled broker(`dist/session-message-broker.mjs`)와 함께 실행했다. 각 입력마다 새 세션을 준비했고, 기본 상태는 "submitted 현재 세대 wake + 본문은 이미 ACK되어 빈 상태"다.

| # | prompt/입력 | 기대 block | v53 block | v53 행 전→후 | v53 판정 | v271 block | v271 행 후 |
|---|---|---|---|---|---|---|---|
| 1 | exact marker (control) | true | true | submitted→observed | PASS | false | observed |
| 2 | exact marker, unknown state | true | true | unknown→observed | PASS | false | observed |
| 3 | marker + trailing \n | true | true | submitted→observed | PASS | false | observed |
| 4 | marker + CRLF + marker (same) | true | true | submitted→observed | PASS | false | observed |
| 5 | leading/trailing spaces | true | true | submitted→observed | PASS | false | observed |
| 6 | marker + \t | true | true | submitted→observed | PASS | false | observed |
| 7 | marker + NBSP (U+00A0, trimmed by JS) | true | true | submitted→observed | PASS | false | observed |
| 8 | BOM + marker (U+FEFF, trimmed by JS) | true | true | submitted→observed | PASS | false | observed |
| 9 | marker + U+2028 (line sep, trimmed) | true | true | submitted→observed | PASS | false | observed |
| 10 | marker + ZWSP U+200B | false | false | submitted→submitted | PASS | false | submitted |
| 11 | marker + NUL | false | false | submitted→submitted | PASS | false | submitted |
| 12 | marker + ESC[0m | false | false | submitted→submitted | PASS | false | submitted |
| 13 | marker + lone CR + text | false | false | submitted→submitted | PASS | false | submitted |
| 14 | marker + \n + user text (mixed) | false | false | submitted→submitted | PASS | false | submitted |
| 15 | marker with extra ']' | false | false | submitted→submitted | PASS | false | submitted |
| 16 | uppercase prefix | false | false | submitted→submitted | PASS | false | submitted |
| 17 | fullwidth brackets | false | false | submitted→submitted | PASS | false | submitted |
| 18 | lookalike prefix (Cyrillic a) | false | false | submitted→submitted | PASS | false | submitted |
| 19 | unregistered nonce | false | false | submitted→submitted | PASS | false | submitted |
| 20 | other session's registered marker | false | false | submitted→submitted | PASS | false | submitted |
| 21 | empty prompt | false | false | submitted→submitted | PASS | false | submitted |
| 22 | whitespace-only prompt | false | false | submitted→submitted | PASS | false | submitted |
| 23 | prompt number | false | false | submitted→submitted | PASS | false | submitted |
| 24 | prompt missing | false | false | submitted→submitted | PASS | false | submitted |
| 25 | subagent (agent_id set) | false | false | submitted→submitted | PASS | false | submitted |
| 26 | hook_event_name=Stop | false | false | submitted→submitted | PASS | false | submitted |
| 27 | old generation marker (late) | false | false | submitted→observed(late) | PASS | false | unknown(late) |
| 28 | pending body (not empty) -> deliver | false | false | submitted→observed | PASS | false | observed |
| 29 | duplicate: second delivery of same marker | false | false | observed→observed | PASS | false | observed |
| 30 | claude-code host same state | false | false | submitted→observed | PASS | false | observed |
| 31 | malformed stdin JSON | false | false | submitted→submitted | PASS | false | submitted |

v271에는 차단 기능이 없으므로 1–9번이 block되지 않는 것은 결함이 아니라 버전 차이다(표의 v271 열). 비차단 입력 22건은 v53에서 행 상태가 그대로이거나 설계대로 전이했다(옛 세대 → observed(late), 본문 있음 → 전달, 중복 → 무변화). 다른 세션의 등록된 marker를 넣어도 그 세션 행은 바뀌지 않았다.

## 6. 불변식 위반·실패 목록

- 제품 FAIL: **N3** — 없는 trust signing key를 검증 경로(`createWakeHookObservationReader().verifyObservation` → `new TrustStore` → `getOrCreateSecret`, `trust-store.ts:46`, `:204-212`)가 새로 만든다. 거절 경로에서도 trust DB에 쓰기 transaction이 발생한다. 최소 재현은 `scripts/trust-write-probe.mts`, 관측은 `11-trust-write-probe.log`(key 행 삭제 → verify=false → keys-after에 새 key, change counter 4→5). 53eff30a가 새로 만든 문제가 아니라 v2.7.1에도 있다. wake 행 해제나 claim에는 영향이 없다.
- wake 행 잘못 해제 / 현재 claim / enqueue / dispatch: 행렬 130, fuzz 1800, 저장소 25, hook 31에서 **0건**. 단 N1·N2는 문서가 명시한 범위 밖의 종료 사유로 판단이 필요하다(claim 0, 이후 새 wake 1회 enqueue 가능).
- 실패한 기존 테스트: 없음(session-messaging 스위트 기준).

## 7. NOT_RUN / 한계

- 실제 Codex·Claude Code host 설치, `codex queue`, 실제 UserPromptSubmit 흐름: NOT_RUN(컨테이너에 host 없음). hook은 bundled 파일에 합성 payload를 넣어 실행했다.
- `pnpm validate:all`, `validate:official`, `source:verify` 등 전체 검증 순서: NOT_RUN(이 과제 범위 밖. build와 session-messaging vitest만 실행).
- Windows, 다른 파일시스템, 실제 저장장치 fsync 실패: NOT_RUN.
- `ulimit -f`(SIGXFSZ) 경로: NOT_RUN(디스크 가득은 tmpfs로 대신).
- 읽기 전용 실험은 root가 권한을 우회하므로 nobody(uid 65534, `setpriv`)로 실행했다. root 행렬의 0400 케이스(PASS*)는 판정에서 제외했다.
- 시간 경계는 `nowMs`를 직접 넣어 검사했다(broker 경로는 실제 시계).
