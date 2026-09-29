# I2 — wake history reconcile 후보 e9b4c73 경합 fuzz (CASE=e9-race-fuzz)

- 대상: `e9b4c73b2ff4294c68c6490411fbc6118c69c8c8`(branch `codex/wake-history-reconcile`), tree `4316195bbb2cdade6efa1a62150e33358ef60a7c` 확인, parent `53eff30a2984d41fc749d38dd2062966017684fa`
- 대조 기준: `/tmp/v53` = `53eff30a…` (reconcile 없음)
- 환경: Linux cloud 컨테이너 한 곳의 일회용 실험이다(`uname`: Linux 6.18.44-fc-v37 x86_64). Node v24.21.0(nodejs.org tarball, SHASUMS256 검증, `02-node24.log`), pnpm 11.19.0(corepack). Windows와 사용자 PC 운영 상태, live 설치 캐시는 다루지 않았다. 사용자 PC의 운영·live 증거가 아니다.
- 소스·테스트·설정은 고치지 않았다. 실험 스크립트는 모두 `/tmp/ev/scripts/`에 있다.

## 요약

| 항목 | 결과 |
|---|---|
| fuzz 실행 | 4모드 × seed 1..200 × 프로세스 {2,4,8} = **2,400회**, 연산 약 21.6만 개 |
| 불변식 (a)–(j) 위반 | **0건**. e9와 v53 모두 없음 |
| harness 판별력(mutant) | verify 우회 mutant는 (g)를 2/3 seed에서 검출했고, effect 중복 mutant는 (e)를 3/3 seed에서 검출했다 |
| 기존 테스트 `historical-wake.test.mjs`(e9) | 45/45 PASS |
| F1(알려진 P2) | 독립 재현했다. 브로커 wake reader는 `R/trust.sqlite3`를 쓰지만, reconcile은 기본 경로 `~/.agent-governance-suite/session-messaging/trust.sqlite3`를 읽어 `reconciled:false`를 낸다. 같은 DB를 기본 경로에 복사하면 `true`가 된다 |
| 새 관찰 O1(기존 결함, v53에도 있음) | 옛 세대 dispatcher의 늦은 `definite-failure` outcome이 fence된 `unknown`(late 없음) 행을 옛 binding의 `reserved`로 되돌린다. 이 행은 어떤 경로로도 풀리지 않아 해당 target의 wake가 영구히 막힌다. reconcile과 무관하며 reconcile로도 풀 수 없다 |
| 서비스·환경 실패 | 없음(429/5xx 0회, 네트워크 실패 0회) |

## 1. 단계별 결과

| 단계 | 결과 | 근거 |
|---|---|---|
| 1 fetch·worktree·install·build | PASS(e9·v53 모두 `pnpm install --frozen-lockfile && pnpm build` EXIT=0) | `01`,`03`,`04`,`05` |
| 2 diff 읽기와 규칙 정리 | 완료(§2) | `06-diffstat.log`, `07-src-diff.log` |
| 3 N=2·4·8 seed 기반 교차 실행 | 완료 | `11`–`15`, `scripts/` |
| 4 불변식 판정 | 위반 0(§3) | `*/summary.jsonl`, `30-aggregate.json` |
| 5 seed ≥200 × N 3종, v53 대조 | 완료. 최소화할 위반이 없었다 | `14-v53-mixed` |
| 추가 결정적 probe | F1 재현, O1 발견, 경합과 세대 교체 직렬화 확인 | `20`–`23` |

## 2. reconcile의 근거·변경 대상·규칙 (e9 파일:줄)

- **입력**: `mcp-server/src/session-message-broker.ts:405-413`. `target{host,sessionId}`, `attemptId`, `sourceReceiptId` 외의 키는 거부한다. 시각은 서버의 `Date.now()`만 쓴다. CLI는 `session-message-cli.ts:9`에서 operation을 허용하고 전달만 한다.
- **형식 검사**: `session-message-store.ts:822-823`(attemptId, `source-…` 패턴).
- **lock**: `session-message-store.ts:830`의 메시지 DB `BEGIN IMMEDIATE` 안에서 선택, 검증, 재검사, CAS를 모두 수행한다. trust 검증(`:839`)도 이 쓰기 lock을 쥔 채 실행된다.
- **대상 행 선택**: `:832-834`. 같은 target과 attemptId에서 `state='unknown' AND late_observed_at IS NOT NULL AND consumed_at IS NULL AND observed_at IS NULL`인 행이다. `:835-838`은 nonce·binding 필드 타입, `nonce_digest = sha256(nonce)`, `dispatch_epoch ≥ 1`, 옛 세대 여부를 확인한다.
- **세대 규칙**: `:825-829`의 `isOldGeneration`. 현재 presence(`presence()`, `started_at DESC`의 최신 행이며 online·ended를 가리지 않음)가 있어야 하고, 행의 `instance_id` 또는 `birth_generation`이 그와 달라야 한다. 검증 뒤 `:840`에서 다시 검사한다.
- **역사 근거**: `session-message-wake-port.ts:111-133`.
  - `TrustStore.readVerifiedInputSource`(`trust-store.ts:159-171`)가 `readOnly:true`와 `query_only`로 연 DB에서, 한 read transaction 안의 키와 영수증 HMAC을 함께 검증한다.
  - 영수증 필드(host/session, `peer`, authority `none`, adapter `session-message-wake-hook`, capability `1.0.0`)를 확인한다.
  - 시각 관계 `started ≤ observed ≤ late < expires ≤ now`를 요구한다(`:122`).
  - 단일 nonce로 actor 4조합의 digest를 재구성해 정확히 1개가 일치해야 한다(`:126-131`).
  - **검증 DB 경로의 기본값은 `resolveTrustDatabasePath()`다(`:113`). 브로커는 이 인자를 넘기지 않는다(`broker.ts:411-412`와 `:476-477`을 비교하면 알 수 있다). 이것이 F1이다.**
- **변경**: `:842-848`의 단일 CAS UPDATE는 PK(`nonce_digest`)와 원본 binding·epoch·`started_at`·`late_observed_at`·`state='unknown'`이 모두 일치할 때만 실행된다. 결과는 `state='observed'`, `observed_at` = 원본 영수증 시각, `consumed_at` = 적용 시각이다. late와 outcome은 보존한다. `changes !== 1`이면 거부한다(`:850`).
- **멱등성**: 두 번째 호출은 `:832`의 조건(`observed_at IS NULL` 등)에서 행을 찾지 못해 `{reconciled:false}`를 내고, COMMIT만 하며 쓰지 않는다.
- **주변 규칙**:
  - active target UNIQUE index: `store.ts:240-241`
  - 늦은 outcome은 `late_observed_at IS NULL`인 행만 받는다: `store.ts:786-789`
  - 옛 세대에서 증명된 도착은 late 경로로 `observed` 종료된다: `store.ts:878-887`
  - 새 세대의 reserve는 옛 `started`를 `unknown`으로 fence한다: `store.ts:725-728`
  - 관측 종료 행의 보관은 `coalesce(consumed_at, …)`를 기준으로 한다: `store.ts:259-263`

## 3. 불변식별 결과

판정은 fuzz 2,400회(모드별 600)와 결정적 probe를 종합했다. "근거"에는 실제로 관측된 횟수를 적었다. 관측하지 못한 부분은 PASS로 적지 않고 제한란에 적었다.

| 불변식 | e9 | v53 대조 | 근거(관측량) | 제한 |
|---|---|---|---|---|
| (a) target마다 활성 행 ≤1 | PASS | PASS | 감사 trigger의 전 이벤트(seq 순)를 재생해 매 시점 활성 행 수를 셌다. e9 mixed 시작 1,318회, v53 721회에서 위반 0 | UNIQUE index가 구조적으로 보장한다 |
| (b) 종료 행이 활성으로 돌아가지 않음 | PASS | PASS | terminal(`observed`/`not-submitted`)→활성 UPDATE 0건. 표본 60 run에서 늦은 outcome 952회, hook-old 242회 | — |
| (c) 검증된 옛 도착은 그 attempt만 종료 | PASS | PASS(late 경로만) | reconcile 성공 로그 수와 감사의 reconcile형 전이(`unknown→observed`, `observed_at≠consumed_at`) 수가 매 run 일치했다. `evidence.oldBinding`은 요청한 attempt·session과 같고, late·outcome·epoch·generation은 보존됐다. `observed_at ≤ late`. late 경로의 `observed` 전이는 모두 실제 hook nonce에 귀속됐다 | 같은 transaction 안의 다른 행 변경은 trigger로 txn을 구분할 수 없다. 대신 PK 단일 UPDATE이고 `changes===1`이라는 코드 근거로 보완했다 |
| (d) 세대 교체·reconcile 뒤 새 effect ≤1 | PASS | PASS | effect마다 커밋된 `reserved→started` 전이(같은 attempt·epoch)가 있었다. (attempt, epoch)별 start 전이 ≤1. e9 mixed effect 1,318개. 표본에서 reconcile 뒤 같은 target의 새 start 83회 | 재시도 backoff가 최소 30초(`wake-port.ts:15-16`)라 epoch ≥2 재시도는 fuzz 시간 안에 거의 없었다 |
| (e) 같은 nonce·attempt effect 중복 없음 | PASS | PASS | (attempt, epoch)별 effect 1개, nonce→attempt 1:1. mutant(effect 이중 기록)에서는 FAIL로 검출해 판별력을 확인했다 | — |
| (f) 늦은 outcome이 종료·late 행을 바꾸지 않음 | PASS | PASS | seed된 late 행에 대한 늦은 outcome 425/425가 `false`를 반환했다. terminal 행 필드 변경 0, late 행 outcome 변경 0 | 종료도 late도 아닌 fence된 `unknown` 행은 옛 outcome으로 바뀐다(표본 7회). 불변식 범위 밖이며 O1로 기록했다 |
| (g) 검증 가능한 역사 근거 없는 unknown은 풀리지 않음 | PASS | 해당 없음 | 무효 변형 6종(no-late, no-receipt, wrong-digest, multi-nonce, not-expired, before-start)에서 reconcile 성공 0회. 표본 무효 시도 622회. 다른 target·attempt·receipt 교차 payload로도 성공 0회. mutant(verify 우회)에서는 FAIL로 검출했다 | 무효 행이 fresh hook 재도착(late 경로)으로 종료되는 것은 실제 도착이므로 정상으로 판정했다 |
| (h) reconcile 두 번째 실행은 무변화 | PASS | 해당 없음 | 매 run 뒤 controller가 1차(늦은 세대 교체로 새로 적격이 된 행은 성공할 수 있음), 이어 2차를 실행했다. 2차는 1,800 run 모두 `false`였고 msg DB dump(wake·messages·presence·relays·observations·audit 수)가 같았다 | — |
| (i) 읽기 전용 경로는 receipt·key·schema 무변화, 새 WAL frame 없음 | PASS | 해당 없음 | readonly 모드 600 run(그중 300은 checkpoint되지 않은 frame을 가진 외부 writer 연결 유지): trust 본 DB·`-wal` 바이트가 동일했다. mixed에서 receipt는 seed와 hook이 만든 것뿐이었다. metadata·schema는 무변화 | 아래 사이드카 기록 참고 |
| (j) 없는 DB·key는 만들지 않고 실패 | PASS | 해당 없음 | missing 모드 600 run(missing-db·missing-key·bad-key·missing-table 각 150): 성공 0회. missing-db는 trust 파일·사이드카를 만들지 않았고 키도 생성되지 않았다. F1 probe run1에서도 기본 경로 디렉터리가 생기지 않았다 | 메시지 DB는 브로커와 store가 설계상 생성한다(`store.ts:129-132`). (j)는 trust DB·키에 한정해 판정했다 |

**읽기 전용 sidecar 기록**(`23-probe-midgen.log`): `-wal`과 `-shm`이 없는 trust DB에 reconcile 검증을 한 번 실행했다. 그 뒤 `trust.sqlite3-shm`(32,768B)과 `trust.sqlite3-wal`(0B, frame 없음)이 새로 생겼고, 본 DB의 sha는 같았다. 문서(`docs/session-message-lifecycle.md` 과거 late 관측 절)가 허용한 조정 파일에 해당한다. readonly 모드 summary의 `sidecarsCreated`는 controller가 사전 스냅샷에서 연 read-only 연결이 먼저 sidecar를 만들기 때문에 0으로 나온다. 따라서 이 값은 근거로 쓰지 않았다.

### 기대값 조정(코드 근거)

- "읽기 전용(dry-run) 경로": e9에 reconcile dry-run 모드는 없다. 그래서 읽기 전용 경로를 `verifyHistoricalWakeObservation`, `TrustStore.readVerifiedInputSource`(`trust-store.ts:159`)와 `wake-status`(`store.ts:799`)로 보고 실험했다. reconcile 자체의 trust 접근도 읽기 전용이다.
- 재조정 대상 형태(`unknown` + `late_observed_at`)는 현재 코드가 만들지 않는다. 현재 late 도착은 곧바로 `observed`로 종료된다(`store.ts:880-887`). 그래서 기존 테스트 fixture와 같이 SQL로 `late_observed_at`을 주입해 v2.7.1 형태를 만들었다(`scripts/fuzz.mjs` `seedTarget`).

## 4. 위반·결함 목록

### 불변식 위반: 없음

2,400 run과 mutant가 아닌 모든 실행에서 (a)–(j) 위반이 0건이었다. 최소화할 seed는 없다.

### F1 재확인(알려진 P2, 수정 예정 항목)

- 재현: `node --import tsx scripts/probe-f1.mjs`(cwd `/tmp/e9`), `20-probe-f1.log`.
- 브로커를 `--state-directory R`로 띄우고 `AGENT_GOVERNANCE_TRUST_DB_PATH`를 설정하지 않았다. `HOME=H`다.
- 유효한 영수증이 `R/trust.sqlite3`에만 있으면 `reconciled:false`가 나온다. 같은 파일을 `H/.agent-governance-suite/session-messaging/trust.sqlite3`로 복사하면 `reconciled:true`가 나온다.
- 원인: `session-message-wake-port.ts:113`의 기본 인자와, `session-message-broker.ts:411-412`가 브로커의 결속 경로(`:476-477`)를 전달하지 않는 점.

### O1 — 옛 세대의 늦은 `definite-failure`가 target wake를 영구히 막음(기존 결함, v53에도 있음)

- 재현: `node --import tsx scripts/probe-late-outcome.mjs /tmp/<e9|v53> definite-failure`, `21-probe-late-outcome.log`. 결정적이며 seed가 필요 없다.
- 관측(e9와 v53이 같음):
  1. inst-1에서 attempt를 `started`까지 진행했다.
  2. inst-2(새 세대)의 reserve가 이를 `unknown`으로 fence했다(`store.ts:725-728`).
  3. 옛 dispatcher의 `recordManagedWakeOutcome(old,'definite-failure')`가 `true`를 반환했고, 행은 `state=reserved, instance_id=inst-1, retry_not_before=+30s`가 됐다.
  4. +17초, +20분, +2시간 모두에서 현재 세대의 reserve와 `resume:true`가 `dispatch=false`, 옛 attempt의 start도 `false`였다. 행은 그대로 `reserved`로 남았고, 메시지 만료 뒤에도(pending=0) 남았다.
  5. reconcile은 `unknown` 행만 다루므로 `false`를 반환했다.
- 원인 추정:
  - `recordManagedWakeOutcome`(`store.ts:786-797`)은 `state IN ('started','unknown')`이고 binding이 일치하면 세대가 현재인지 보지 않고 `unknown→reserved`로 전이한다.
  - `reserved` 행을 푸는 경로는 두 가지뿐이다. 같은 instance·세대의 resume(`:729-736`), 그리고 binding이 현재일 때 startManagedWake의 만료 처리(`:766-773`)다. 옛 세대 행은 어느 쪽도 통과하지 못한다. prune(`:257-263`)도 `reserved`를 지우지 않는다.
- 영향과 범위:
  - (a)–(j) 위반은 아니다. 종료 행도 late 행도 아니고, 새 effect는 0이다.
  - liveness 결함이다. 해당 target은 이후 managed wake를 받지 못한다.
  - 옛 attempt의 늦은 outcome이 재시도를 재개방(`unknown→reserved`)하는 효과도 있다. 문서가 "옛 attempt의 늦은 outcome은 재개방 근거가 아니다"라고 적은 것은 reconcile된 행에 대한 것이다. 이 경로는 그 문장이 다루지 않는다.
  - `submitted`나 `accepted-or-unknown`이면 행이 활성으로 남아 hook 도착 전까지 막힌다. 외부 효과가 불확실하므로 설계상 latch로 볼 수 있다. `definite-failure`는 외부 효과가 없다고 확정된 상태인데도 영구히 막히므로 결함으로 분류했다.
  - fuzz 표본에서도 늦은 outcome이 no-late 행에 7회 적용됐다.

### 그 밖의 확인(위반 없음)

- **trust 쓰기 경합 중 reconcile**(`22-probe-contention.log`): 300 target × {R2/W2, R4/W4, R8/W8, R8/W2}, 총 1,200회. 1차에서 모두 성공했고 거짓 거부는 0이었다. reconcile 지연은 p50 약 2.2–2.9ms, p99 최대 약 342ms, 최대 약 0.74s였다(메시지 DB lock 대기). 예외는 0이었다.
- **reconcile 도중 세대 교체**(`23-probe-midgen.log`): 다른 프로세스의 `startPresence`(새 instance, 또는 같은 instance의 재시작)는 신호 후 1ms 안에 시작됐다. 그러나 reconcile의 `BEGIN IMMEDIATE`가 COMMIT할 때까지(약 1.5s) 막혔다가 그 뒤에 적용됐다. 판단 snapshot은 일관됐고, 두 번째 reconcile은 `false`였다.

## 5. 실험 설계와 재현

- `scripts/worker.mjs`는 상주 worker pool이다. 각 worker는 독립된 `SessionMessageStore` 연결을 가진 **별도 프로세스**이며, 공통 go 신호로 동시에 출발한다. PRNG는 `mulberry32(seed*1009 + w*7919 + n*131)`이고, 연산 사이에 무작위로 0–2ms sleep이나 setImmediate를 둔다.
- `scripts/fuzz.mjs`(controller)는 run마다 target 3개를 seed한다. 유효 1개, 유효·current-gen·actor-main 중 1개, 무효 6종 중 1개다. 메시지 DB에는 `zz_audit` trigger(INSERT/UPDATE/DELETE old→new)를 추가해 직렬화된 전 이력을 남겼다(실험 계측이며 제품 schema 변경이 아니다). 실행 뒤에는 (h) 2단계 검사와 trust 스냅샷 비교를 하고 판정한다.
- 모드별 연산:
  - `mixed`: reconcile, 교차 payload reconcile, 세대 교체, presence 종료, relay 주기(reserve·start·effect, 즉시 또는 지연 outcome), 현재 hook 도착, 옛 nonce 재도착, 옛·자기 attempt의 늦은 outcome, send, 읽기 전용 검증
  - `readonly`: reconcile·읽기 전용 위주. 홀수 seed에서는 checkpoint되지 않은 frame을 가진 외부 writer를 유지한다
  - `missing`: `seed%4`에 따라 missing-db, missing-key, bad-key, missing-table
  - v53: 같은 seed로 실행하고 reconcile 연산만 skip한다
- 재현: `cd /tmp/<e9|v53> && node --import tsx /tmp/ev/scripts/fuzz.mjs <e9|v53> <mixed|readonly|missing> <seedFrom> <seedTo> 2,4,8 <outDir> [keep]`. 전체 실행 스크립트는 `scripts/run-all.sh`, seed 목록은 `seeds.txt`(1..200)다. OS 스케줄링 때문에 interleaving은 seed만으로 완전히 결정되지 않는다. seed는 연산 선택과 payload를 고정한다.
- harness 개발 중 두 가지를 고쳤다. 제품 결함이 아니다.
  1. readonly 사후 스냅샷을 외부 writer 연결을 닫기 **전**에 찍도록 옮겼다. 닫힐 때의 checkpoint가 파일 변화로 오탐됐다.
  2. (h)를 2단계로 바꿨다. 늦은 세대 교체로 새로 적격이 된 행의 첫 성공이 "두 번째 실행"으로 오판됐다.
  
  수정 전 smoke 결과는 덮어썼다. `smoke-*`는 최종 harness 직전 버전의 smoke다.

## 6. NOT_RUN과 이유

| 항목 | 이유 |
|---|---|
| Windows·macOS | Linux 컨테이너 한 곳만 사용했다 |
| trust 디렉터리 쓰기 금지 상태의 read-only 열기(sidecar 생성 불가) | 컨테이너가 root로 실행돼 chmod로 쓰기를 막을 수 없다 |
| fuzz의 TLS 브로커 경유 동시 실행 | fuzz는 `dispatchSessionMessageBrokerOperation`을 프로세스 안에서 직접 호출했다. 브로커 경유는 F1 probe에서 순차로만 확인했다 |
| epoch ≥2 재시도 경합 | backoff 최소 30초 때문에 실행 시간 안에 거의 발생하지 않았다. 시계는 조작하지 않았다 |
| 전체 저장소 검증(`pnpm lint`/`test`/`validate:*`) | 이 작업 범위(경합 fuzz) 밖이다. `historical-wake.test.mjs`만 실행했다(45/45) |
| 삭제된 스킬 저장소 `source:verify` | 실행하지 않았다(범위 밖). 해당 검사는 NOT_VERIFIABLE 대상이다 |

## 7. 파일

- `01`–`07`: fetch, Node, worktree, install·build, diff
- `10-mutant-*`: harness 판별력 확인
- `11`–`15`: fuzz 로그와 run별 summary. `15`는 op 수준 전체 로그 표본
- `20`–`24`: probe와 기존 테스트
- `30-aggregate.json`: 집계
- `scripts/`: 모든 실험 코드
