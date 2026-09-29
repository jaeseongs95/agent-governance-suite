# CASE=e9-271-recovery — 2.7.1 운영 상태를 reconcile 후보 e9b4c73로 복구하는 탐색 실험

- 대상: e9b4c73b2ff4294c68c6490411fbc6118c69c8c8, tree 4316195bbb2cdade6efa1a62150e33358ef60a7c (/tmp/e9, tree 일치 확인, `04-worktrees.log`)
- 기준(2.7.1): d5c5932cd5a0d87630f6ed94f8e3721181ab9864 (/tmp/v271)
- 이전 증거: `origin/claude/evidence-wake-271-state-upgrade-20260928T065638Z`의 `wake-271-state-upgrade/`에 있는 스크립트를 그대로 사용했다(`scripts/lib.mjs`, `scripts/build-271-state.mjs`).
- 환경: Linux cloud 컨테이너 1개. Node v24.21.0(SHASUMS256으로 검증한 tarball), pnpm 11.19.0.
- **이 환경에는 사용자 운영 DB가 없다. /tmp 아래 일회용 상태만 썼다.** `/root/.agent-governance-suite/session-messaging/trust.sqlite3*`는 이 세션이 시작된 07:15:46에 컨테이너의 플러그인이 만든 파일이다. 실험이 시작되기 전에 생겼고 실험 중에 바뀌지 않았다(`40-*.log`). 모든 broker는 가짜 HOME(`/tmp/fakehome-*`)으로 실행했다.
- 수정 전 탐색 실험이다. 독립 감사 F1(trust DB 경로 결속 불일치)은 아직 수정하지 않았다. 소스·테스트·설정은 바꾸지 않았다(`40-*.log`에서 두 worktree 모두 clean).

## 공개 진입점 (코드 근거, `06-diff-53-e9.patch`)
- 진입점은 CLI `mcp-server/dist/session-message-cli.mjs`의 `reconcile-wake-observation` 연산 하나다. CLI가 TLS broker로 요청을 보내고, broker의 `dispatchSessionMessageBrokerOperation`이 `store.reconcileHistoricalWake(target, attemptId, sourceReceiptId, Date.now())`를 호출한다. payload는 `{target:{host,sessionId}, attemptId, sourceReceiptId}`만 받는다. MCP 도구와 자동 startup 복구는 없다.
- **dry-run이나 읽기 전용 모드는 없다.** 그래서 3(a)는 NOT_RUN이다. 대신 broker의 `wake-status`와 `presence` 조회만 먼저 실행해 변화를 기록했다.
- 대상 행 조건: `state='unknown' AND late_observed_at IS NOT NULL AND consumed_at IS NULL AND observed_at IS NULL`, `dispatch_epoch ≥ 1`, 행의 (instance_id, birth_generation)이 현재(최신) presence와 달라야 한다(`isOldGeneration`). presence가 online인지는 보지 않는다.
- 증거 조건: `verifyHistoricalWakeObservation`이 `resolveTrustDatabasePath()`(env `AGENT_GOVERNANCE_TRUST_DB_PATH`, 없으면 env state dir 또는 `$HOME/.agent-governance-suite/session-messaging/trust.sqlite3`)의 trust DB를 `readOnly`와 `query_only`로 연다. 이어 receipt 서명, adapter, target과 `started ≤ observed ≤ late < expires ≤ now`를 확인한다.
- broker의 hook reader는 `AGENT_GOVERNANCE_TRUST_DB_PATH`가 없으면 `<--state-directory>/trust.sqlite3`를 쓴다. 두 경로가 서로 다르게 정해지는 것이 F1 조건이다.
- `wake_nonces`에는 원본 `sourceReceiptId`가 저장되지 않는다. 그래서 운영자는 trust DB에서 host·sessionId·adapter로 receipt를 직접 찾아야 한다. 이 실험에서는 일회용 복사본(`/tmp/state-lookup`)을 읽어서 찾았다(`12-lookup-receipts.log`). T3과 T6에만 receipt가 있다. T1, T2, T4, T5에는 hook 도착 receipt가 아예 없다.

## 단계별 결과

| 단계 | 내용 | 판정 | 근거 |
|---|---|---|---|
| 1 | fetch 4개 ref, 이전 증거 추출, worktree 2개(e9 tree 확인), install·build | PASS (모두 EXIT=0) | 01, 04, 05-* |
| 2 | E의 스크립트로 /tmp/state-271 재생성. 결과가 E와 같음: T1–T6 새 wake 모두 false, T4 늦은 outcome 수락, T0 dispatch true | PASS | 10 |
| 2 | live snapshot의 DB·WAL·SHM sha256 기록 후 /tmp/state-e9 등으로 복사 | PASS (모두 hash 동일) | 11 (첫 시도는 `head` SIGPIPE로 복사가 중간에 멈춰 다시 했다: 11-*-attempt1) |
| 3(a) | 읽기 전용·dry-run 진입점 | **NOT_RUN** (코드에 없음) | CLI OPERATIONS, broker case |
| 3(a′) | 대체 관측: broker 시작, `wake-status`·`presence` 조회 | 논리 내용·main·WAL 불변. broker를 열 때 SHM만 바뀜(e37ad3…→1f9b85…) | 20 snap 00/01/02 |
| 3(b) | 1차 적용(현재 presence 그대로) | PASS: T3만 reconciled:true. T6은 같은 세대라 false. 나머지는 false | 20, 41 |
| 3(b) | 1차 적용 때 trust 권위 데이터 | PASS: trust main 881a3c… 불변, receipt 2개, key digest와 schema 불변. **sidecar가 생김**: state dir에 `trust.sqlite3-shm`(32768), `trust.sqlite3-wal`(0 bytes) | 20 snap 03 |
| 3(c) | 2차 적용 | PASS: 모두 false. 메시지 DB 논리 digest(e14b29…), WAL sha(ec8a48…), SHM 모두 03과 같음(새 WAL frame 없음) | 20 snap 04 |
| 4 | reconcile된 T3의 옛 attempt에 늦은 `submitted` outcome | PASS: `recorded:false`(재개방 없음) | 20 |
| 4 | T1–T6에 새 presence 세대(inst-3/relay-3) 뒤 재적용 | T6이 reconciled:true로 바뀜(이제 옛 세대). 나머지는 false. 다시 적용하면 모두 false | 20 snap 05/06 |
| 4 | 새 세대 wake admission과 effect 횟수 | T3·T6 PASS: reserve true → start → submitted → hook 도착 claim이 본문 1건. 활성 중 두 번째 reserve false, 같은 receipt 재생은 recognized false·0건, claim 뒤 reserve false. T1, T2, T4, T5는 reserve false(막힘 유지) | 20 `admission-summary` |
| 4 | 대조 T0 불변 | PASS: wake 행 전체 열이 00과 07에서 같음 | 21 |
| 4 | reconcile 대상이 아닌 행 보존 | PASS: T1, T2, T4, T5 행 전체 열이 00과 07에서 같음 | 21 |
| 4 | 메시지 DB schema | 불변(schema_sha256 1c293f… 모든 snap 동일) | rows/*.json |
| 5 | F1 조건(아래 표) | **FAIL (결속 불일치 재현)** | 31–33 |

## 행별 전·후 (main, /tmp/state-e9)

| target | 2.7.1 최종 상태 | late_observed_at | hook receipt | 1차 적용 | 2차 적용 | 새 세대 뒤 적용 | 최종 옛 행 | 새 세대 wake |
|---|---|---|---|---|---|---|---|---|
| T0-control | submitted(inst-1, 만료, 관측 없음) | 없음 | 없음 | false | false | (새 세대 안 만듦) | **불변** submitted | NOT_RUN(대조로 두어 새 presence를 만들지 않음) |
| T1-gen-unknown | unknown, 옛 세대 | 없음 | 없음 | false | false | false | unknown(불변) | **막힘** (reserve false, observation-overdue) |
| T2-gen-submitted | submitted, 옛 세대 | 없음 | 없음 | false | false | false | submitted(불변) | **막힘** |
| T3-late-unknown | unknown, 옛 세대(같은 instance, 새 generation) | 05:19:52.001 | 있음 | **true** | false | false | observed, observed_at=05:19:52.000(원본), consumed_at=07:21:16.581(적용 시각), late 보존 | **가능**, effect 1회 |
| T4-started-crash | submitted(started→unknown→늦은 outcome 수락) | 없음 | 없음 | false | false | false | submitted(불변) | **막힘** |
| T5-ttl-unknown | unknown, 같은 세대, 만료 | 없음 | 없음 | false | false | false | unknown(불변) | **막힘** |
| T6-ttl-late | unknown, **같은 세대**, TTL 뒤 도착 | 05:19:52.001 | 있음 | **false**(현재 presence가 같은 세대) | false | **true** | observed, observed_at=05:19:52.000, consumed_at=07:21:17.784 | **가능**(새 세대 뒤), effect 1회 |

reconcile 출력 원문(true인 경우)은 `41-reconcile-true-outputs.txt`에 있다. false는 모두 `{"protocolVersion":"1.0.0","ok":true,"data":{"reconciled":false,"evidence":null}}`이며 거절 사유는 나오지 않는다. T3의 1차 출력은 다음과 같다.
```
{"protocolVersion":"1.0.0","ok":true,"data":{"reconciled":true,"evidence":{"sourceReceiptId":"source-bdb10222-5e8d-427e-aad6-b508bc5c2f02","contentDigest":"sha256:ad43ea9b85e968c58766714e022a4d3c09069e02003192af126cb175bf87367e","observedAt":"2026-09-28T05:19:52.000Z","receiptExpiresAt":"2026-09-28T05:20:22.000Z","oldBinding":{"host":"codex","sessionId":"exp-T3-late-unknown","instanceId":"inst-1","generation":"2026-09-28T05:15:00.000Z","transport":"codex-queue","relayId":"relay-1","attemptId":"898c46ad-8001-4c36-ac49-bd4cd4052403","dispatchEpoch":1},"lateObservedAt":"2026-09-28T05:19:52.001Z","reconciledAt":"2026-09-28T07:21:16.581Z"}}}
```

## 남는 행 유형과 이유

| 유형 | 실험 target | e9에서 남는 이유 |
|---|---|---|
| 옛 세대 unknown, 도착 기록 없음 | T1 | `late_observed_at`이 없어 대상 조건 밖이다. 도착 증거도 없다(설계상 보존: 근거 없는 unknown을 풀지 않음) |
| 옛 세대 submitted, 도착 기록 없음 | T2 | 대상은 `state='unknown'`만이다. submitted 행은 절대 대상이 되지 않는다 |
| crash 뒤 2.7.1이 늦은 outcome을 수락해 submitted가 된 행 | T4 | 2.7.1이 unknown을 submitted로 바꿨고 late 기록도 receipt도 없다. e9 reconcile 경로로는 풀 수 없다 |
| 같은 세대 만료 unknown, 도착 없음 | T5 | late와 receipt가 없다 |
| 2.7.1이 만든 대조 행(submitted, 만료, 관측 없음) | T0 | T2와 같은 유형이다. 이 target에 새 세대가 생기면 T0도 막힌다(이번 실험에서는 대조로 두어 확인하지 않음) |
| 같은 세대 late-unknown | T6(새 세대 전) | `isOldGeneration`은 최신 presence가 다른 세대여야 true다. 세션이 같은 세대에 머무는 동안에는 풀 수 없다. 새 presence 세대가 생긴 뒤에만 풀린다 |

즉 e9는 **2.7.1이 검증된 도착을 `late_observed_at`으로 남긴 행(T3, T6)만** 해제한다. 도착 증거가 없는 T1, T2, T4, T5와 T0 유형은 그대로 남아 해당 target의 새 wake admission을 계속 막는다. 이 동작은 문서의 불변 조건("실제 도착이 없는 unknown은 해제하지 않음")과 맞는다. 다만 2.7.1 운영 상태를 완전히 복구하지는 못한다.

## F1 조건: `--state-directory`와 기본 trust 경로가 다를 때 (같은 live snapshot의 별도 복사본)

broker를 `--state-directory /tmp/state-e9-f1X`로 직접 실행했다. env에는 `AGENT_GOVERNANCE_TRUST_DB_PATH`와 `AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR`가 없고 HOME은 `/tmp/fakehome-f1X`다. broker의 hook reader는 `/tmp/state-e9-f1X/trust.sqlite3`를 쓰고, reconcile은 `$HOME/.agent-governance-suite/session-messaging/trust.sqlite3`를 읽는다. 대상은 T3(main에서 true였던 행)이다.

| 변형 | 기본 경로 trust | 1차 | 2차 | 부수 효과 |
|---|---|---|---|---|
| f1a | 없음 | false | false | 기본 경로에 파일·디렉터리가 생기지 않음. state dir trust 불변. T3 unknown 유지(fail-closed) |
| f1b | 다른 키, receipt 없는 trust DB | false | false | **잘못된 기본 경로에 sidecar 생성**(`-shm` 32768, `-wal` 0). 그 DB main은 불변. T3 unknown 유지 |
| f1c | 올바른 trust의 복사본 | **true** | false | broker의 state dir trust는 한 번도 열리지 않았다(sidecar 없음). **broker의 hook reader와 결속되지 않은 DB를 근거로 reconcile이 성공했다** |

main(CLI가 broker를 띄우는 형태: env state dir = broker state dir)에서는 두 경로가 같아서 차이가 드러나지 않는다. F1이 재현됐다. reconcile 증거 출처는 broker 상태 디렉터리에 결속되지 않고 프로세스 env나 HOME에서 정해진다. 그래서 같은 복사본이 경로 구성에 따라 거절되기도 하고(f1a, f1b) 다른 DB를 근거로 수락되기도 한다(f1c).

## 기타 관측
- reconcile의 read-only trust open은 WAL 모드 trust DB 옆에 `-shm`과 빈 `-wal`을 만들고 그대로 남긴다. main 파일, receipt, key, schema는 바뀌지 않는다. 이는 문서에 적힌 "SQLite 조정 파일은 별도 관측" 대상에 해당한다.
- main 실험의 trust는 admission 단계(07)에서 receipt가 2개에서 4개로 늘었다. 이는 hook 도착을 합성한 `recordWakeHookObservation` 때문이며 reconcile이 만든 것이 아니다(03–06에서는 receipt 2개, main 파일 bytes 불변).
- 메시지 DB WAL은 1000 frame이 찬 상태였다. 첫 쓰기 때 WAL이 재시작돼 크기는 같고 hash만 바뀌었다. broker를 멈추면 checkpoint 뒤 WAL과 SHM이 지워진다(08).
- hook 도착은 `adaptHostInput`와 `recordWakeHookObservation`으로 합성했다. 실제 Codex·Claude host, relay 프로세스, 설치 캐시는 실행하지 않았다. relay lease의 pid에는 드라이버 자신의 pid를 썼다.

## NOT_RUN과 한계
- 3(a) dry-run·읽기 전용 reconcile: 진입점이 없어서 NOT_RUN.
- T0의 새 세대 admission: 대조로 두려고 새 presence를 만들지 않았다(NOT_RUN).
- 실제 host wake, 설치 캐시, 사용자 PC 운영 DB: 범위 밖이다. 이 결과는 Linux cloud 한 환경에서 합성한 이력으로 한 일회용 실험이다. 사용자 PC 운영 상태나 live 증거가 아니다.
- 스크립트 오류로 다시 실행한 경우: `20-e9-main-attempt1-script-column-error.log`(snap SQL에 없는 열 `outcome` 사용. broker 시작 전에 멈췄고 상태 파일 hash가 그대로임을 확인한 뒤 다시 실행), `11-*-attempt1-sigpipe.log`.
- 증거에서 뺀 파일: trust.sqlite3(실험용 HMAC 서명 키 포함), broker-key.pem, broker.token. trust는 sha256만 `db/TRUST-HASHES-not-included.txt`에 남겼다.
- 네트워크·서비스 실패: 없음.

## 재현
```
export PATH=<node24>/bin:$PATH
cd /tmp/v271 && AGENT_GOVERNANCE_TRUST_DB_PATH=/tmp/state-271/trust.sqlite3 node_modules/.bin/tsx scripts/build-271-state.mjs /tmp/v271 /tmp/state-271
cp -a /tmp/state-271-live-snapshot /tmp/state-e9   # (+ state-lookup, state-e9-f1a/b/c)
cd /tmp/e9 && env -u AGENT_GOVERNANCE_TRUST_DB_PATH -u AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR node_modules/.bin/tsx scripts/run-e9.mjs /tmp/e9 /tmp/state-e9 main /tmp/fakehome-main
# F1: run-e9.mjs ... /tmp/state-e9-f1X f1X /tmp/fakehome-f1X  (f1b: make-foreign-trust.mjs, f1c: 기본 경로에 trust 복사)
```
