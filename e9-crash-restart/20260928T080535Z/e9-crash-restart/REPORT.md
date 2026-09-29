# 작업 K 보고서: 중단·재시작 전후 receipt 재부착과 근거 없는 unknown 보존 (CASE=e9-crash-restart)

- 대상 reconcile 후보: e9b4c73b2ff4294c68c6490411fbc6118c69c8c8 (tree 4316195bbb2cdade6efa1a62150e33358ef60a7c, 확인함)
- 대상 wake 후보: 53eff30a2984d41fc749d38dd2062966017684fa (tree c030fa4e19411ef511c5d5c89cf588aa6f42c059, 확인함). e9는 53 바로 위의 커밋 하나입니다.
- 과거 상태 생성용 동결 버전: main d5c5932 (v2.7.1)
- 환경: Linux cloud 컨테이너 한 대(4 vCPU), Node v24.21.0(nodejs.org tarball을 SHASUMS256으로 검증), pnpm 11.19.0. 이것은 일회용 실험 결과입니다. 사용자 PC의 운영 상태나 live 증거가 아닙니다.
- 제품 소스·테스트·설정은 수정하지 않았습니다. 두 worktree 모두 `pnpm install --frozen-lockfile`, `pnpm bundle:check`, `pnpm build`가 EXIT=0이었고, 빌드 뒤에도 `git status`가 깨끗했습니다(`04-install-build-*.log`).

## 결론 요약

| 불변식 | e9 (614개 kill 지점) | 53 (537개 kill 지점) |
|---|---|---|
| (a) `PRAGMA integrity_check` (최종 DB, trust DB, 각 crash image) | PASS 614 | PASS 537 |
| (b) 재시작 뒤 도착한 실제 receipt가 올바른 attempt에 붙고 effect 중복 없음 | PASS 611 / **FAIL 3** | PASS 535 / **FAIL 2** |
| (c) receipt 없는 unknown이 unknown으로 남음 (성공으로 바뀌지 않음) | PASS 614 | PASS 537 |
| (d) 반쯤 적용된 reconcile 재실행 시 수렴(멱등) | PASS 614 (reconcile 적용 도중 kill 59개 포함) | NA: 53에는 `reconcile-wake-observation`이 없음(op 거절) |
| (e) 새 세대 wake effect ≤ 1 | PASS 614 | PASS 537 |
| (f) WAL 복구 뒤 schema·user_version·journal_mode 불변 | PASS 614 | PASS 537 |

- 계획한 kill 지점은 모두 실제 SIGKILL로 이어졌습니다(NOT_TRIGGERED 0). kill 지점 수는 e9 614개, 53 537개로 버전당 요구치 100개를 넘었습니다.
- 위반은 한 종류뿐입니다. broker가 hook claim 도중 죽고 **receipt TTL 30초보다 오래** 멈춰 있으면, 같은 receipt로 다시 보낸 claim이 거절됩니다. 그러면 실제 effect가 일어났는데도 해당 attempt가 `submitted`/`unknown`에 남습니다. 같은 kill 지점에서 53도 똑같이 실패하므로 e9의 회귀는 아닙니다. 안전성(중복 effect, 근거 없는 성공)은 깨지지 않았고, 대상 세션의 pending 본문이 전달되지 않는 liveness 문제입니다. 자세한 내용은 아래 「위반 재현」에 있습니다.
- 53 대비 e9의 차이: 안전 불변식 결과에는 차이가 없습니다. e9는 reconcile로 v2.7.1이 남긴 `unknown+late` 행을 해제해 과거 본문을 전달합니다(e9 A 본문 미전달 28/614, 53은 537/537 전부 미전달). reconcile 적용 도중 kill 59개와 이중 kill 모두에서 원자성과 멱등성을 유지했습니다.

## 방법

### 공개 경로
- **broker**: 커밋된 번들 `mcp-server/dist/session-message-broker.mjs`를 별도 프로세스로 실행했습니다. TLS 1.3, 토큰 인증, 인증서 pin을 쓰는 실제 경로입니다.
- **relay**: 별도 프로세스에서 `dispatchManagedWake`(소스) 한 주기를 돕니다. 순서는 `acquire-relay` → `relay-tick` → reserve/start/effect/outcome입니다. effect는 파일에 fsync append로 남기고, 그 직전에 해당 행이 `started`로 커밋됐는지 확인합니다.
- **hook**: 별도 프로세스에서 `adaptHostInput` → `recordWakeHookObservation`(trust DB receipt) → `claim-host-wake`를 실행합니다. 실제 hook과 같은 `maxMessages 1`, `maxBodyChars 4096`을 씁니다. broker 오류가 나면 같은 payload와 같은 receipt로 한 번 재시도합니다(`sessionMessageRequest`와 같은 동작).
- **reconcile·presence·prepare/send·ACK**: 오케스트레이터가 broker에 직접 요청합니다(CLI와 같은 broker op).

### 과거 상태
각 trial은 v2.7.1 코드로 새 DB를 만들어 시작합니다(`scripts/baseline271.mjs`).
- A: 이전 세대 hook 도착이 `unknown`+`late_observed_at`로 남은 행입니다. receipt는 이미 만료됐습니다.
- B: `accepted-or-unknown` 이후 세대가 바뀌었고 hook 도착도 receipt도 없는 `unknown` 행입니다.

### 시나리오
S00 broker 시작
→ S01/S02 A·B 새 세대 presence
→ S03 relay A (latched라 dispatch 없음이 기대값)
→ S04 reconcile A
→ S05 재실행
→ S06 B에 A의 receipt로 reconcile
→ S07 B에 가짜 ID로 reconcile
→ S08 relay A
→ S09 hook 도착
→ S10 ACK
→ S11–S13 D presence, prepare, send
→ S14 relay D(1세대)
→ S15 D 2세대 presence
→ S16 hook(1세대 late 도착)
→ S17 relay D(2세대)
→ S18 hook
→ S19 ACK
→ S20 추가 relay(dispatch 없음이 기대값)
→ S21 reconcile 재실행과 B 재시도, wake-status

### kill 주입
`scripts/inject.mjs`를 `--import` preload로 넣었습니다. 제품 코드는 바꾸지 않았고, `node:sqlite`의 `exec`와 `StatementSync.run/get/all/iterate` 호출 전후를 사건으로 셉니다. 계획한 사건 번호에 도달하면 자기 프로세스에 SIGKILL을 보냅니다.
- 주입 대상 프로세스: broker, relay, hook
- no-kill trace가 두 번 실행에서 같았으므로(`ref/trace-e9.tsv`와 `trace-e9-repeat.tsv`의 diff가 비어 있음), 사건 번호로 kill 지점을 재현할 수 있습니다.
- **boundary** 방식: 모든 BEGIN/COMMIT/ROLLBACK과 wake·messages·trust 쓰기 문장의 직전·직후, reconcile step의 모든 사건, relay·hook의 이름 지점(`relay:after-reserve/start/effect/outcome`, `hook:after-receipt/claim`), 시작(이관) 사건 일부. 나머지는 seed 무작위 추출로 채웠습니다.
- **timing** 방식(버전당 30개): seed로 고른 사건에서 helper thread를 무장하고 0–600µs 뒤 비동기 SIGKILL을 보냅니다. 문장 경계가 아닌 SQLite 내부 실행 중에 kill이 떨어지도록 한 것입니다.
- **double** 방식(버전당 30개): 1차 kill 뒤 재시작한 broker의 1–60번째 사건에서 다시 kill합니다. 여기에는 WAL 복구, 이관, 재시도 op 도중이 포함됩니다.
- **outage** 방식: hook claim의 BEGIN 직후 kill 뒤 broker를 10/25/35초 동안 내려 둡니다.
- seed: `plan.mjs`의 기본 seed는 e9 20260930, 53 20260931이고, `plan-extra.mjs`의 seed는 e9 779, 53 780입니다(`ref/plan-*.json`에 기록). 각 trial의 kill 사건 번호와 레이블은 `trials/<id>.json`의 `spec`, `kill`, `kill2`에 있습니다.

### crash image와 검사
- broker가 죽으면 다른 연결이 열기 전에 DB, `-wal`, `-shm`을 복사해 crash image로 보존합니다. 그 뒤 broker를 kill 없이 자동 재시작하고, 각 클라이언트가 실제 제품의 재시도 규칙으로 이어서 진행합니다.
- 검사 결과는 `trials/*.json`의 `checks`에 있습니다(각 불변식의 판정 근거와 행 dump 포함).

### 판정 정의
- (b): 모든 effect의 nonce당 effect는 정확히 1개이고, attempt당 effect는 1개 이하이며, effect 전에 `started`가 커밋되어 있어야 합니다. claim 응답을 받은 hook 도착은 해당 nonce 행의 `attempt_id`가 effect의 attempt와 같고 `state=observed`, `observed_at`이 있어야 합니다. 어떤 메시지도 사라지면 안 됩니다. hook 프로세스가 claim 전에 죽은 경우에는 부착을 요구하지 않습니다.
- (c): B 행이 `unknown`이고 late·observed·consumed가 모두 NULL이며 epoch와 outcome이 원래 값 그대로여야 합니다. B에 대한 reconcile 시도는 모두 `reconciled:false`여야 합니다. `observed`/`submitted` 행에는 각각 receipt, reconcile 증거(원본 receipt의 `observedAt`), 실제 effect 중 하나가 있어야 합니다. 53에서는 A 행이 원래대로 남아야 합니다.
- (d): crash image의 A 행은 원래 그대로이거나 완전히 적용된 모양 중 하나여야 합니다(부분 적용 금지). 최종 A 행은 `observed_at`=원본 `observedAt`, `consumed_at`=적용 시각이어야 하고, late·outcome·epoch·binding은 보존돼야 합니다. `reconciled:true`는 1회 이하이고, S21 재실행은 `false`를 돌려주며 행이 바뀌지 않아야 합니다.
- (e): `(session, birth_generation)`마다 effect는 1개 이하이고, target마다 active 행은 1개 이하여야 합니다.
- (f): 최종 DB, trust DB, crash image가 no-kill 참조(`ref/schema-*.json`)나 v2.7.1 원본 schema와 같아야 하고, `user_version`(메시지 DB 0, trust DB 참조값)과 `journal_mode=wal`이 유지돼야 합니다.

## 2단계: 쓰기 지점과 transaction 경계
`WRITE-POINTS.md`에 파일:줄로 정리했습니다. 요점은 다음과 같습니다.
- `claimHostWake`는 메시지 DB의 BEGIN IMMEDIATE 안에서 receipt를 검증합니다. 이때 trust DB를 쓰기 모드로 열어 별도 tx(schema init, secret)를 엽니다.
- `reconcileHistoricalWake`는 메시지 DB 쓰기 잠금을 잡은 채 trust DB를 `readOnly`+`query_only`로 읽고, 원래 binding 전체를 조건으로 CAS UPDATE합니다.
- 외부 effect(`port.dispatch`)는 커밋된 start 뒤, 모든 tx 밖에서 일어납니다.

## kill 지점별 결과
- step별 요약은 아래 표에 있습니다. 지점별 전체 표는 `killpoints-e9.md`, `killpoints-53.md`에 있고, 행마다 id, 방식, 프로세스, step, 사건 레이블·번호, kill 여부, 재시작 수, a–f 판정이 있습니다.
- 원시 결과는 `results-*.jsonl`에 있습니다. `results-rerun-*`는 harness 버그로 무효가 된 trial을 다시 돌린 결과입니다(아래 참고).

(아래 표는 모든 방식을 합친 수치입니다)

#### e9
| step | 프로세스 | kill 지점 | 그중 BEGIN/COMMIT 직전·직후 | 위반 |
|---|---|---|---|---|
| S00 broker-start | broker | 4 | 2 | 0 |
| S01 presence-A3 | broker | 2 | 0 | 0 |
| S02 presence-B3 | broker | 2 | 0 | 0 |
| S03 relay-A-latched | broker | 52 | 9 | 0 |
| S03 relay-A-latched | relay | 3 | 0 | 0 |
| S04 reconcile-A | broker | 27 | 13 | 0 |
| S05 reconcile-A-again | broker | 6 | 4 | 0 |
| S06 reconcile-B-foreign | broker | 4 | 4 | 0 |
| S07 reconcile-B-bogus | broker | 4 | 4 | 0 |
| S08 relay-A | broker | 70 | 19 | 0 |
| S08 relay-A | relay | 6 | 0 | 0 |
| S09 hooks | broker | 23 | 19 | 1 |
| S09 hooks | hook | 16 | 10 | 0 |
| S10 ack-A | broker | 6 | 4 | 0 |
| S11 presence-D1 | broker | 3 | 0 | 0 |
| S12 prepare-D | broker | 21 | 4 | 0 |
| S13 send-D | broker | 36 | 4 | 0 |
| S14 relay-D1 | broker | 74 | 25 | 0 |
| S14 relay-D1 | relay | 6 | 0 | 0 |
| S15 presence-D2 | broker | 2 | 0 | 0 |
| S16 hooks | broker | 16 | 14 | 1 |
| S16 hooks | hook | 16 | 10 | 0 |
| S17 relay-D2 | broker | 74 | 19 | 0 |
| S17 relay-D2 | relay | 6 | 0 | 0 |
| S18 hooks | broker | 19 | 13 | 1 |
| S18 hooks | hook | 16 | 10 | 0 |
| S19 ack-D | broker | 6 | 4 | 0 |
| S20 relay-final | broker | 72 | 8 | 0 |
| S20 relay-final | relay | 4 | 0 | 0 |
| S21 reconcile-final | broker | 18 | 8 | 0 |
#### 53
| step | 프로세스 | kill 지점 | 그중 BEGIN/COMMIT 직전·직후 | 위반 |
|---|---|---|---|---|
| S00 broker-start | broker | 10 | 3 | 0 |
| S01 presence-A3 | broker | 2 | 0 | 0 |
| S02 presence-B3 | broker | 2 | 0 | 0 |
| S03 relay-A-latched | broker | 56 | 9 | 0 |
| S03 relay-A-latched | relay | 3 | 0 | 0 |
| S08 relay-A | broker | 56 | 10 | 0 |
| S08 relay-A | relay | 3 | 0 | 0 |
| S11 presence-D1 | broker | 2 | 0 | 0 |
| S12 prepare-D | broker | 19 | 4 | 0 |
| S13 send-D | broker | 35 | 4 | 0 |
| S14 relay-D1 | broker | 75 | 24 | 0 |
| S14 relay-D1 | relay | 6 | 0 | 0 |
| S15 presence-D2 | broker | 2 | 0 | 0 |
| S16 hooks | broker | 25 | 20 | 1 |
| S16 hooks | hook | 16 | 10 | 0 |
| S17 relay-D2 | broker | 73 | 21 | 0 |
| S17 relay-D2 | relay | 6 | 0 | 0 |
| S18 hooks | broker | 20 | 12 | 1 |
| S18 hooks | hook | 16 | 10 | 0 |
| S19 ack-D | broker | 7 | 4 | 0 |
| S20 relay-final | broker | 91 | 12 | 0 |
| S20 relay-final | relay | 5 | 0 | 0 |
| S21 reconcile-final | broker | 7 | 0 | 0 |


방식별 kill 수:

| 버전 | boundary | timing | double | outage 10s | outage 25s | outage 35s | 합계 |
|---|---|---|---|---|---|---|---|
| e9 | 547 | 30 | 30 | 2 | 2 | 3 | 614 |
| 53 | 473 | 30 | 30 | 1 | 1 | 2 | 537 |

### 추가로 판별력을 높인 실험 (모두 PASS)
- **trust DB hot WAL** (`11-hotwal.log`): A의 receipt를 checkpoint하지 않은 WAL에만 남기고 writer를 SIGKILL했습니다. 이어 `-shm`이 있는 경우와 지운 경우에 e9 reconcile을 실행했습니다. 두 경우 모두 read-only 연결이 receipt를 읽어 `reconciled:true`를 한 번만 돌려줬고, 재실행은 `false`였습니다. 53에서는 A가 그대로 `unknown`으로 남았습니다.
- **이중 kill** (버전당 30개): 두 번째 kill은 재시작 broker의 `PRAGMA journal_mode=WAL`, `CREATE TABLE IF NOT EXISTS`, 이관 BEGIN/COMMIT, 재시도 op 도중에 떨어집니다. 모두 a–f를 통과했습니다(e9의 (d) 포함).
- **시작 지점 kill**: 이관 tx 직전·직후 포함 e9 4개, 53 10개. 모두 통과했습니다.

## 위반 재현

### 위반: broker 중단 시간이 receipt TTL(30초)을 넘으면 재시작 뒤 hook claim 재시도가 부착되지 않음 (불변식 b)

**재현 방법**
- 스크립트: `repro/outage-ttl-repro.sh [downMs]` (기본 35000)
- kill 지점: e9는 `broker#1` 사건 464, 53은 사건 350입니다. 둘 다 S16의 `claimHostWake` `exec:post|BEGIN IMMEDIATE`로 같은 코드 지점입니다.
- 결정적 사건 번호라 seed가 필요 없습니다. 원래 계획의 seed는 e9 779, 53 780입니다.

**관측된 순서**
1. relay가 effect를 보냅니다.
2. hook이 receipt를 기록하고 `claim-host-wake`를 보냅니다.
3. broker가 claim tx 안에서 SIGKILL됩니다. tx는 롤백되고 crash image는 무결합니다.
4. broker가 35초 뒤 재시작합니다.
5. hook이 같은 `sourceReceiptId`로 재시도하면 `{"recognized":false,"messages":[],"managed":false}`를 받습니다. receipt `expiresAt`이 `observedAt`+30초이기 때문입니다.
6. 해당 attempt 행은 `state=submitted`(e9-down-0, v53-down-1) 또는 `unknown`(e9-down-1 D 1세대, v53-down-0)에 남고 `observed_at`·`late_observed_at`은 NULL입니다. 본문은 claim되지 않습니다.

**행 dump 예시** (e9-down-0, `repro/e9-down-0/result.json`):
`wake-A instance-3 attempt 446b8a5f… state=submitted started_at=07:57:34.284Z outcome_at=07:57:34.294Z observed_at=NULL late_observed_at=NULL`. hook은 `retried=true`, `recognized=false`였고 `hist-body-wake-A`는 미전달입니다.

**e9 reconcile로 회복되는가** (`20-reconcile-stranded.log`): 같은 receipt로 호출하면 `{"reconciled":false,"evidence":null}`을 돌려주고, 행은 `unknown`에 남습니다. `late_observed_at IS NOT NULL`인 v2.7.1 모양만 대상으로 하기 때문입니다.

**대조군** (`14-outage-controls.log`)
- 10초 중단: e9와 53 모두 PASS입니다(정상 부착).
- 25초 중단: 부착은 PASS입니다. 다만 presence lease 20초가 먼저 끝나 현재 세대 도착이 `late`+`observed`로 은퇴하고 본문은 claim되지 않습니다(e9-downctl-25s, v53-downctl-25s). 이것도 liveness 관측이며 두 버전이 같습니다.

**53 대조**
- 같은 S16 지점: v53-down-0 FAIL, e9-down-1 FAIL.
- S18: v53-down-1 FAIL, e9-down-2 FAIL.
- e9의 S09 지점(e9-down-0)은 53에 없습니다. 53에서는 A가 latched라 S09에 hook 도착이 없기 때문입니다.
- 결론: **53과 e9가 같은 조건에서 같게 실패합니다. e9가 새로 만든 문제가 아닙니다.**

**영향 평가**
- 안전성: 중복 effect, 근거 없는 성공, 무결성 손상은 없습니다. (c)와 (e)는 유지됩니다.
- liveness: active 행이 target UNIQUE를 차지하므로 같은 세대에서는 새 wake를 예약할 수 없습니다. 실제 hook도 `HOST_MESSAGE_REQUEST_TIMEOUT_MS=8000`(session-message-hook.ts:23)을 넘기면 재시도하지 않습니다. 따라서 실제 운영에서는 30초 이상 중단이 아니라 8초를 넘는 중단부터 같은 결과가 날 수 있습니다. 이것은 추론이며 측정하지 않았습니다.
- 판정: 이 과제의 (b) 정의 기준으로 FAIL입니다. 수정은 과제 범위 밖이라 하지 않았습니다.

### harness 문제 (제품 FAIL 아님, 별도 집계)
1. 시작 kill 14건(e9 4, 53 10): broker가 준비 전에 죽으면 오케스트레이터가 재시작 broker를 기다리지 않고 시나리오를 중단했습니다. S00을 고친 뒤 같은 kill 지점을 다시 돌려 모두 PASS했습니다(`15-startup-rerun.log`, `results-rerun-*`).
2. 이중 kill 20건(e9 12, 53 8): 재시작 broker가 시작 중 다시 죽으면 처리되지 않은 promise rejection으로 오케스트레이터가 종료됐습니다. 고친 뒤 다시 돌려 모두 PASS했습니다(`18-dk-rerun.log`).

처음 무효였던 결과는 `results-*.jsonl`에 그대로 남아 있습니다. `aggregate.json`의 `supersededHarnessRuns`에 목록이 있습니다. campaign 도중 오케스트레이터에 추가한 기능(event2, downMs, readySafe, hot WAL 옵션)은 기존 kill 방식의 동작을 바꾸지 않습니다. 최종 스크립트는 `scripts/`에 있고, 첫 버전은 `scripts/orchestrator.v1.mjs`입니다.

## liveness 관측 (판정 대상 아님, `17-liveness.log`)

| 버전 | trial | A 과거 본문 미전달 | D 본문 미전달 | 종료 시 latched 행이 남은 trial | 본문 중복 전달 |
|---|---|---|---|---|---|
| e9 | 614 | 28 | 46 | 62 (unknown 38, submitted 20, started 3, reserved 1) | 0 |
| 53 | 537 | 537 (reconcile 없음) | 49 | 537 (A `unknown+late` 전부, 그 밖 unknown 30, submitted 11, started 1, reserved 1) | 0 |

미전달은 relay가 start 뒤 죽거나 start 응답을 잃어 `started`/`unknown`으로 latch된 경우, 그리고 hook이 claim 전에 죽은 경우입니다. 이는 설계("커밋된 start는 불확실한 응답 뒤 재시도하지 않음")대로의 보수적 동작입니다.

## NOT_RUN과 한계
- 53의 (d): reconcile 기능이 없어 NA입니다. 53에서 op를 보내면 `Unknown broker operation.`으로 거절되고 A 행은 바뀌지 않습니다(판정 PASS 쪽 근거로 (c)에 기록).
- `definite-failure` outcome 뒤 backoff 재시도(30초 이상)의 effect 수: 시나리오 시간 안에 재시도가 오지 않아 판별력이 없습니다. NOT_RUN입니다.
- 8초 hook 타임아웃을 적용한 실제 hook 경로의 중단 시간 경계: harness의 hook 재시도 대기가 60초라 실제 8초 제한은 재현하지 않았습니다. NOT_RUN입니다.
- Windows와 다른 파일시스템, 전원 차단(OS 수준 fsync 손실)은 NOT_RUN입니다. 프로세스 SIGKILL만 다뤘습니다.
- 스킬 독립 저장소 검증(`source:verify`)은 이번 과제 단계에 없어 실행하지 않았습니다.
- 서비스(GitHub, npm, nodejs.org) 오류: 0건입니다.
