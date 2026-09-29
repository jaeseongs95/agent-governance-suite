# I1: 53eff30a wake 수명주기 다중 프로세스 경합 fuzz (CASE=wake53-race-fuzz)

- 대상: `53eff30a2984d41fc749d38dd2062966017684fa`(tree `c030fa4e19411ef511c5d5c89cf588aa6f42c059` 일치 확인, `01-fetch-worktree.log`). 대조: v2.7.1 `d5c5932cd5a0d87630f6ed94f8e3721181ab9864`.
- 환경: Linux cloud 컨테이너 한 곳(4 vCPU), Node v24.21.0(SHASUMS256 검증, `00-node.log`), pnpm 11.19.0. 두 worktree 모두 `pnpm install --frozen-lockfile`와 `pnpm build`가 EXIT 0이었다(`02-build-*.log`).
- **범위 제한:** 이 결과는 일회용 실험이다. 사용자 PC의 운영 상태, 실제 Codex/Claude host의 wake 관측, 설치 캐시에 대한 live 증거가 아니다.
- 소스·테스트·설정은 수정하지 않았다. 실험 코드는 모두 `scripts/`에 있다.

## 1. 방법

- **Harness** (`scripts/orchestrator.mjs`, `worker.mjs`, `checker.mjs`)
  - 일회용 state 디렉터리 하나를 N개(2, 4, 8)의 독립 `node --import tsx` 프로세스가 공유한다. 저장소 fixture와 같은 공개 경로를 쓴다: `mcp-server/src/session-message-store.ts`, `session-message-wake-port.ts`(recordWakeHookObservation, wakeHookObservationReader), `host-input-adapter.ts`.
  - 명시적 `nowMs`는 DB의 공유 논리 시계에 op마다 0–300ms 지터를 더한 값이다.
- **연산:**
  - send, claim(+즉시 ACK), ACK, acquireRelay, heartbeat(lease를 잃으면 같은/새 instance로 재birth)
  - tick(0.1s부터 61분, 3601s까지)과 prune
  - presenceSwitch: new-instance, restart-same, end-only, start-same
  - reserve(현재 또는 오래된 instanceId), start(중복 start 포함), dispatch(effect 기록 후 submitted, unknown, definite-failure, throw, 또는 outcome 연기)
  - lateOutcome(연기된 outcome이나 다른 프로세스의 attempt에 대한 중복·늦은 outcome)
  - hook: effect된 nonce, 2개 batch, 미등록 nonce 혼합, reserved 전용, 미등록. receipt는 fresh, 31s 만료, 위조 중 하나다.
  - hookReplay(같은 observation과 receipt 재사용), legacy reserveWake, status, relayCycle(dispatchManagedWake와 같은 순서로 abandon-after-start/effect 분기 포함)
  - orchestrator는 seed에 따라 worker를 SIGKILL하고 대체 프로세스를 띄운다.
- **관측:** 각 worker 연결에 TEMP trigger를 설치해 `wake_nonces`, `session_presence`, `messages`의 모든 행 변경을 op id·op 이름·nowMs와 함께 `h_audit`에 원자적으로 기록한다. 다른 프로세스와의 교차 순서는 이 audit seq로 재구성한다. effect는 `h_effects`에 기록한다.
- **프로필:** seed%3에 따라 chaos, steady, gencross를 쓴다. seed가 홀수면 GATE를 켜서 reserved 행이 있는 동안 세대 교체와 긴 tick을 억제한다(아래 H 결함이 탐색을 막지 않도록 하기 위함). seed당 worker마다 250 op를 실행하고 SIGKILL 확률은 worker당 0.5다.
- **재현성:** seed, 프로세스 수, kill 계획이 결과 JSON(`results-*/<ver>-n<N>-s<seed>.json`)에 남는다. op 선택과 nonce는 seed로 결정되지만 프로세스 사이 interleaving은 OS 스케줄링에 따르므로 같은 seed가 같은 교차를 보장하지는 않는다. 그래서 위반 후보는 결정적 단일 프로세스 repro(`scripts/repro-scenarios.mjs`)로 최소화했다.
- **실행 규모:** seed 1–200 × N∈{2,4,8}를 두 버전에서 모두 돌렸다. 53eff30a는 600 run, 627,740 op, effect 2,830회, SIGKILL 1,119회이고, op 오류와 worker 비정상 종료는 0이다(`10-matrix-*.log`, `30/31-aggregate-*.json`).

## 2. 불변식별 결과 (53eff30a)

checks는 해당 불변식을 실제로 평가한 횟수다. a, b와 transition은 audit에 기록된 wake 행 쓰기 수, c는 hook op와 observed 전이 수, d는 연속 effect 쌍 수, e는 effect 수, f는 outcome 경로의 행 쓰기 수, g는 unknown에서 벗어나는 전이 수다.

| 불변식 | N=2 checks/위반 | N=4 | N=8 | 판정 |
|---|---|---|---|---|
| (a) target당 활성 행 ≤1 (audit replay + 매 op 뒤 직접 조회) | 4505/0 | 5084/0 | 5233/0 | PASS |
| (b) 종료(observed/not-submitted) 행이 다른 상태로 바뀌지 않음 | 3718/0 | 4317/0 | 4354/0 | PASS |
| (c) 옛 세대 검증 도착은 후보 행만 종료, 현재 세대 claim/binding 없음, 거절된 hook은 본문 claim 없음, expired/bogus receipt는 행을 바꾸지 않음 | 16062/0 | 30363/0 | 58335/0 | PASS (단, 동일 ms 재birth 경계는 C2 참조) |
| (d) 새 effect 전에 직전 effect의 attempt가 종료되었거나 definite-failure로 reserved 상태 | 565/0 | 601/0 | 611/0 | PASS |
| (e) nonce·epoch당 effect ≤1, 모든 effect에 앞서 커밋된 reserved→started 전이가 있음 | 914/0 | 960/0 | 956/0 | PASS |
| (f) outcome 경로가 종료 행이나 late 행을 쓰지 않음 | 1915/0 | 2092/0 | 2112/0 | PASS |
| (g) unknown에서 벗어나는 경로는 검증된 hook(→observed) 또는 그 attempt 자신의 outcome뿐이고, 활성 행이 삭제되지 않음 | 387/0 | 416/0 | 453/0 | PASS |
| 전이표(허용 전이 외 없음) | 4505/0 | 5084/0 | 5233/0 | PASS |
| (추가 H) 세대가 바뀐 뒤 `reserved` 행이 영구히 남아 target의 새 wake를 막음 | 138건/96 seed | 166/110 | 189/124 | **FAIL(liveness, 기존 동작)** |

**실제로 실행된 시나리오 수 (53eff30a, 세 N 합계):**
- 옛 세대·만료 검증 도착 종료: 1,001회
- 현재 세대 관측: 1,310회
- unknown 생성: 1,342회
- unknown→observed: 907회
- presence birth와 세대 교체: 18,673회
- 같은 ms 재birth(C2 조건): 5회. 이 5회가 옛 attempt와 겹쳤는지는 관측하지 못했다(UNKNOWN).
- effect 시점 행이 이미 started가 아님(다른 relay의 fence 등): 286회. 불변식 위반이 아닌 정보 항목이다.

**(f) 노출:** 보존된 DB 표본(H가 발생한 seed)에서 늦은 `lateOutcome` 호출이 10,779회 거절되었다(`32-late-outcome-sample.log`). 전체 run에서 거절된 호출 수는 저장하지 않았다.

**기대값 조정(코드 근거):**
- (g) 원래 기대는 "근거 없이 unknown이 풀리지 않는다"였다. 코드상 unknown→submitted/reserved는 같은 attempt와 epoch의 outcome이 허용한다(`session-message-store.ts:782-797`, `state IN ('started','unknown') AND late_observed_at IS NULL`). 그래서 이 경로는 근거 있는 해제로 분류했다. 관측된 해제 경로는 lateOutcome:reserved 142, lateOutcome:submitted 149, dispatch:submitted 41, dispatch:reserved 15, relayCycle 2다.
- (d) 원래 기대는 "세대 교체 한 번당 새 effect ≤1"이었다. 같은 세대 안에서도 attempt가 종료되면 새 wake가 정상이므로(`session-message-store.ts:721-755`), 기대값을 "새 effect는 직전 attempt가 종료되거나 definite-failure된 뒤에만 가능"으로 고쳤다. 이는 unique index `wake_active_target`(:240)가 구조적으로 보장한다.

## 3. 위반과 경계 사례 (최소 재현)

재현 명령: `cd /tmp/<ver> && node --import tsx scripts/repro-scenarios.mjs /tmp/<ver> out.json`. 모든 시나리오는 단일 프로세스에서 명시 nowMs로 실행한다. 출력은 `20-repro-v53.json`, `20-repro-v271.json`에 있다.

### H1. start 전에 세대가 바뀌면 `reserved` 행이 영구히 남는다 (FAIL, liveness, v2.7.1에도 있음)
- **순서:** send → reserve(inst-1, G0) → endPresence → startPresence(inst-2, G1) → relay-2 획득 → 옛 attempt의 start → 현재 relay의 reserve를 +16s, +61min, +25h에 시도.
- **관측:** start=false이고, 모든 reserve=false다. pending은 2–3이고, status는 `reserved / observation-overdue`다. 행 dump: `[a789f3, reserved, inst-1, gen 00:00:00.000, epoch 0]`는 25시간 뒤에도 그대로다.
- **원인 추정:**
  - `reserveManagedWake`(`session-message-store.ts:721-737`)는 활성 행이 있으면 새 행을 만들지 않는다. resume은 `wakeBindingCurrent(input, active.birth_generation)`를 요구하므로 새 세대에서는 항상 거짓이다(:729-731).
  - `startManagedWake`는 binding이 현재가 아니면 만료 검사(:770) 전에 먼저 반환한다(:766-768). 그래서 WAKE_TTL이 지나도 not-submitted로 종료되지 않는다.
  - prune(:259-263)은 observed와 not-submitted만 지운다.
  - `claimHostWake`는 reserved 행을 거절한다(:829).
- **영향:** 이 target의 wake 기반 idle 전달이 멈춘다. 본문은 claim, deferred, turn-end 경계에서는 여전히 전달될 수 있다. 문서(`docs/session-message-lifecycle.md`)의 "이후 새 pending의 wake는 … 별도로 reserve/start한다"는 reserved 행이 남아 있으면 성립하지 않는다.

### H2. definite-failure backoff 중 세대가 바뀌면 같은 영구 차단이 생긴다 (FAIL, v2.7.1에도 있음)
- **순서:** reserve → start → outcome(definite-failure). 행은 reserved 상태이고 retry_not_before가 설정된다. 이어 presence lease가 끊기고 같은 instance가 재birth(00:00:26)한 뒤, backoff가 지난 시점에 resume reserve와 옛 attempt의 start를 시도한다.
- **관측:** 둘 다 false다. 행 dump: `[42ea18, reserved, inst-1, gen 00:00:00.000, epoch 1]`.
- **fuzz 대응:** v53 n2 seed 12에서 같은 패턴이 나왔다: start(seq 178) → lateOutcome definite-failure(seq 193, started→reserved) → 61분 tick과 새 birth → 영구 reserved. DB 표본은 `db-samples/v53-n2-s12.sqlite3.gz`에 있다.

### H3. fence된 unknown이 옛 dispatcher의 늦은 definite-failure로 reserved가 되면 도착으로도 풀 수 없다 (FAIL, v2.7.1에도 있음)
- **순서:** start → presence가 inst-2로 교체되고 relay-2가 reserve한다. 이 reserve가 started 행을 unknown으로 fence한다(:726-728). 이어 옛 dispatcher의 outcome(definite-failure)=true가 들어와 행이 reserved가 된다(:786-795, binding 현재성 검사 없음). 이후 backoff가 지나도 reserve=false다.
- **의미:** unknown 상태라면 실제 옛 marker 도착으로 종료할 수 있다(53eff30a 개선). reserved로 바뀌면 hook이 행을 거절하므로 영구 차단이 된다. 이 unknown→reserved 전이는 (g) 기준으로는 근거 있는 해제라서 위반으로 세지 않았다.

### C2. 같은 ms 재birth는 세대 문자열이 같다 (경계, v2.7.1에도 있음, 실제 발생 가능성은 UNKNOWN)
- **순서:** reserve, start, submitted를 BASE에 실행한다. 이어 같은 instance의 endPresence와 startPresence를 **원래 birth와 같은 ms(BASE)**에 실행한다.
- **관측:** 새 birth의 `startedAt`이 원래와 같다(`equal: true`). 이전 birth의 nonce 도착이 `recognized: true`로 처리되어 현재 세대 binding과 본문 claim을 얻는다.
- **원인:** 세대가 `started_at` ISO 문자열(ms 해상도)이다(`startPresence` :886-887의 `started_at = CASE …`, 비교는 :832-835).
- **판단:** 3ms만 떨어져도 정상 구분된다(repro의 `after3ms`). 실제 host에서 이 간격이 생기는지는 관측하지 못했다.

### C1/G1. 53eff30a가 의도한 개선 확인 (PASS)
- **C1:** outcome 전 started 상태에서 옛 세대 도착 → observed와 late를 기록한다. 이후 늦은 outcome(submitted)=false이고, 현재 reserve와 start=true다. 옛 replay는 거절되고 현재 hook이 본문을 전달한다. v2.7.1에서는 unknown이 유지되어 reserve=false로 막힌다.
- **G1:** unknown은 ACK, 61분 TTL, 세대 교체, prune 뒤에도 유지된다(reserve=false). 검증된 옛 도착 뒤에는 늦은 definite-failure가 false이고 새 reserve는 true다. v2.7.1은 계속 막힌다.

## 4. v2.7.1 대조 (같은 harness, 같은 seed와 N)

| 항목 | 53eff30a | v2.7.1 | 구분 |
|---|---|---|---|
| a,b,c,d,e,f,g 위반 | 0 / 0 / 0 / 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 / 0 / 0 / 0 | 차이 없음 |
| 전이표 외 전이 | 0 | 17,026건(435 seed) | v2.7.1의 문서화된 동작: 옛/만료 hook이 started/submitted/unknown을 `unknown`+late로 바꾼다. checker의 전이표는 53eff30a 기준이므로 v2.7.1에서는 위반이 아니다. |
| 옛 세대 검증 도착 종료 | 1,001 | 2 | 의도된 변경(53eff30a `session-message-store.ts:836-842`) |
| unknown→observed | 907 | 323 | 의도된 변경 |
| effect 수 | 2,830 | 1,881 | 새 버전은 옛 unknown이 해소되어 wake가 더 진행된다 |
| H(영구 reserved) | 493건/330 seed | 308건/253 seed | **기존 동작**(repro H1–H3가 두 버전에서 같게 나온다). v53에서 더 많이 보이는 이유는 wake가 더 진행되어 노출이 늘었기 때문으로 추정한다. |
| C2 같은 ms 세대 충돌 | 재현됨 | 재현됨 | 기존 동작 |

**결론:** 53eff30a에서 신규 회귀는 관측되지 않았다. 요청한 불변식 (a)–(g)는 600 run에서 모두 위반 0이다. 별도로, 두 버전에 공통인 liveness 결함 H(reserved 행이 세대 교체 뒤 영구히 남음)와 ms 해상도 세대 충돌 경계 C2를 보고한다.

## 5. 기존 테스트 커버리지

`coverage.md`에 파일:줄 표, 누락 조합과 v2.7.1 대비 새 테스트 목록이 있다. 핵심 누락은 reserved 상태에서의 세대 교체(H1–H3)로, 어떤 기존 테스트도 다루지 않는다.

## 6. NOT_RUN / 한계

- **broker(TLS) 경유 Date.now() 경로:** NOT_RUN. 불변식 판단은 store 계층에서 명시 nowMs로 했다. broker는 같은 store 메서드를 Date.now()로 호출한다(`session-message-broker.ts:381-405`).
- **실제 Codex/Claude host의 hook, 번들 hook(`dist/session-message-hook.mjs`)과 `decision: block` 경로:** NOT_RUN. 기존 S:1172가 부분적으로 다룬다.
- **relay loop 전체(`runSessionMessageRelay`, relayTick, process identity):** NOT_RUN. relayCycle이 `dispatchManagedWake`의 단계를 store 호출로 모사한다.
- **interleaving 재현성:** 프로세스 사이 교차 순서는 비결정적이다. 위반 후보는 결정적 repro로 옮겼다.
- **DB 보존:** 위반이나 H가 발생한 seed의 DB 869개(총 약 170MB)를 만들었지만 크기 제한 때문에 3개만 gzip으로 보존했다(`db-samples/`). 전체 목록은 `db-kept-before-trim.txt`, seed별 요약은 `results-*/`에 있다.
- **(f)의 거절된 늦은 outcome 호출 수:** 전체 run에서는 집계하지 않았다. 보존된 DB 표본에서만 집계했다.
