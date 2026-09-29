# AGS v2.7.5 반영분 재감사(audit2): T-2·I-2 반영

- **판정: PASS_WITH_FINDINGS, 출시 차단 아님**
- 판정 대상: `claude/v275-wake-retire` = `44235fb5c0fc7efab69c989df4d8eff3975af26f` (tree `790a117efbf2fb41317c1b23e4abcbad58d95373`)
- 직전 감사 대상: `3501e7c5` (audit1, `claude/evidence-v275-audit-20260929T012510Z`)
- 기준(main, v2.7.4): `0c8b52d97d1ccdda1768c18422d073d674e2c785`
- writer evidence(대조용): `claude/evidence-v275-wake-retire-fix1-20260929T013606Z` @ `7e49707b`. 판정은 직접 재현한 결과로만 했다.
- 읽기 전용이다. 제품 소스는 바꾸지 않았다. mutant는 버리는 worktree(`44235fb5`)에서만 적용하고 되돌렸다(되돌린 뒤 `git status` 0줄).

## 결론

T-2는 해소됐다. 새 사례 `live-birth-behind-ended`가 audit1의 반례를 그대로 고정하고, 살아남았던 A6(가장 이른 행)을 잡는다. 같이 추가된 `same-ms-other-instance`는 A4를, `lease-ends-at-retirement`는 A2를 잡는다. 세 사례 모두 기준 `0c8b52d9` store에서 퇴역 단언(`:184`)으로 실패한다. I-2 문장과 I-1 예외 문장은 코드와 audit1의 O1·E 재현에 맞다.

남은 것은 시험 정밀도에 관한 작은 지적 하나(T-3)와 문구 정보 하나(I-3)다. 둘 다 제품 동작과 무관하며 출시를 막지 않는다.

## 항목별 결과

| # | 항목 | 결과 |
|---|---|---|
| 1 | 범위 | PASS |
| 2 | T-2 반영 | PASS (T-3) |
| 3 | 시험 품질 | PASS |
| 4 | I-2·I-1 문구, 외부 링크 | PASS (I-3) |
| 5 | 검증 | PASS (`validate:official`만 FAIL_UNRELATED) |

### 1. 범위 (`logs/commits.txt`, `logs/change.diff`)

- `3501e7c5`는 `44235fb5`의 조상이다(fast-forward).
- 커밋 2개: `ba07468a` test, `44235fb5` docs.
- 바뀐 파일은 `tests/session-messaging/wake-liveness.test.mjs`(+25)와 `docs/release-notes-v2.7.5.md`(2줄 수정)뿐이다.
- `mcp-server`, `claude-plugin`, `runtime`, `skills`, `release`, 매니페스트, `package.json` 변경 0건(`logs/product-paths-changed.txt`). 제품 코드·버전·dist는 그대로다.
- `bundle:check` 0, `claude:build` 뒤 `claude:check` 0(fresh), 검증 뒤 작업 트리 변경 0 byte.

### 2. T-2: 새 사례가 반례를 고정하는가

**`live-birth-behind-ended`** (`wake-liveness.test.mjs:150-156`, 추가 단언 `:188-193`)

- 구성: wake는 instance-1(birth A, `f.now`)에서 받는다. instance-2(B)가 `f.now+20`에 태어나 `f.now+30`에 끝난다. `keep`이 A의 lease를 DB에서 직접 늘려 A를 살려 둔다. 최신 행은 끝난 B다.
- audit1의 반례(A live, 더 늦은 B가 태어났다가 끝남)와 같은 모양이다. 차이는 host가 portable이라는 점뿐이며, 퇴역 SQL은 host를 보지 않는다.
- 기준 `0c8b52d9` store: 퇴역 단언에서 실패한다(`submitted`가 남음, `logs/base-0c8b52d9-new-wake-liveness.log`).
- 추가 단언 세 개를 직접 probe로 확인했다(`harness/behind-ended-probe.mts`, `logs/behind-ended-probe-*.log`).

| 변형 | 옛 wake | presence | live relay | A로 reserve | autoWake |
|---|---|---|---|---|---|
| 시험 그대로 | expired-unobserved | ended (instance-2) | 없음 | false | no-live-relay / presence-not-online |
| relay-1을 `retireAt`에 다시 잡음 | expired-unobserved | ended (instance-2) | relay-1 | false | no-live-relay / presence-not-online |
| 대조: B 없음 | submitted | online (instance-1) | relay-1 | false (latch) | latched / wake-unobserved |

  - `presence ended`와 `presence-not-online`은 최신 행 때문이며, relay가 살아 있어도 그대로다. 제품 동작과 맞는다.
  - `reserveManagedWake` `dispatch:false`도 제품 동작과 맞다. relay-1이 살아 있어도 false다.
  - 기준 store에서도 세 변형의 reserve와 autoWake 결과는 같다. 기준과 달라지는 것은 옛 wake의 퇴역뿐이다.
  - 다만 시험 그대로의 구성에서는 `retireAt`에 live relay가 하나도 없다. 그래서 reserve 단언은 presence가 online이었더라도 relay가 없어서 통과한다. 주석("ended later birth가 최신 행인 동안 새 wake를 받을 수 없다")을 스스로 증명하지 않는다(T-3).

**mutant** (`logs/mutants/mutants.tsv`, 대상: wake-liveness, presence-retention, session-message 시험)

| mutant | audit1 (3501e7c5) | audit2 (44235fb5) | 잡은 시험 |
|---|---|---|---|
| N1–N6 (writer) | KILLED | KILLED | 여러 개 |
| A1 no-row-keeps-latch | KILLED | KILLED | purged, G |
| A2 lease-boundary `>=` | SURVIVED | **KILLED** | lease-ends-at-retirement |
| A3 instance-only | KILLED | KILLED | generation-missing 외 1 |
| A4 generation-only | SURVIVED | **KILLED** | same-ms-other-instance |
| A5 ended-ignored | SURVIVED | SURVIVED | 없음(동치) |
| A6 oldest-row | SURVIVED | **KILLED** | live-birth-behind-ended |

- A5는 계속 살아남는다. `endPresence`가 `lease_until`을 끝난 시각으로 바꾸므로, 끝난 행은 `lease_until > now`가 거짓이다. `ended_at` 검사를 빼도 결과가 같아 잡을 수 없는 mutant다.
- writer의 mutant 결과(`mutants.tsv`)와 판정이 모두 같다.

**`same-ms-other-instance`** (`:157-163`): instance-2가 `f.now`에 같은 ms로 태어나 rowid로 최신 행이 된다. `keep`은 instance-2를 살려 둔다. A4(generation만 비교)는 이 행을 wake의 birth로 보고 latch를 유지하므로 잡힌다. 기준 store에서도 실패한다. audit1의 probe E(`0c8b52d9`는 영구 latch, 후보는 퇴역)와 맞다.

**`lease-ends-at-retirement`** (`:164-168`): instance-1의 `lease_until`을 `retireAt`과 같게 둔다. `retireAt-1`에는 퇴역하지 않고 `retireAt`에 퇴역한다. A2(`>=`)는 이 ms를 live로 보므로 잡힌다. audit1의 probe B(같은 ms에서 퇴역, heartbeat 거절, unreachable이 일치)와 맞다.

### 3. 시험 품질

- 세 사례 모두 시각을 인자로 넘기고 lease를 DB에 직접 쓴다. `keep(at)`은 `lease_until = at + 60s`로 쓰므로, 벽시계 lease 만료에 기대지 않는다. `fixture()`의 `Date.now()`는 기준 시각을 한 번 잡을 때만 쓴다(기존과 같음).
- diff는 추가뿐이다. 기존 사례, 공통 단언, timeout, 제품 상수는 바뀌지 않았다.
- wake-liveness, presence-retention, presence-batches 10회 반복: 10/10 모두 49/49 통과했다(audit1의 46에 새 사례 3개가 더해짐). 남은 임시 디렉터리와 broker process는 0이다(`logs/repeat10.txt`; 파일 안의 `broker-processes=2`는 pgrep이 자기 셸 명령줄을 센 값이며, 같은 파일 끝에 `ps`로 0임을 적었다).

### 4. 문구와 링크

- **I-2** (동작 변화 절): "그 사이 다른 세션의 요청이 prune을 불러 알림이 이미 퇴역했다면, 2.7.4에서는 빈 모델 턴, 2.7.5에서는 hook이 모델 요청 전에 막고 본문은 새 wake로 전달"은 audit1의 O1 재현(기준 `{}`와 `observed`, 후보 `block`과 `expired-unobserved`, 두 버전 모두 새 wake가 본문을 전달)과 맞다. 조건을 "prune이 먼저 불린 경우"로 한정했으므로, O2(prune 없이 marker 먼저, 두 버전 같음)와도 어긋나지 않는다.
- **I-1** (본문): 알림의 birth와 같은 ms에 태어난 다른 instance가 최신 행으로 살아 있으면, 2.7.5는 퇴역시키고 그 instance에 새 wake를 보낼 수 있다. 이 설명은 퇴역 SQL(`session-message-store.ts:348-351`)과 probe E, 새 시험 `same-ms-other-instance`와 맞다.
- "영구히 latch"는 조금 넓은 표현이다(I-3). 기준에서도 만료 뒤 활동이 기록되거나 더 늦은 birth가 살아나면 퇴역한다.
- 새로 추가된 URL은 0건이다. 두 문서(`release-notes-v2.7.5.md`, `session-message-lifecycle.md`)에는 외부 링크가 없고, 외부 스킬 저장소 링크도 없다. 퇴역 1시간 뒤의 미등록 nonce 한계 문장(`:19`)은 그대로 남아 있다.

### 5. 검증 (`44235fb5`, Node 24.21.0, pnpm 11.19.0, `logs/full-summary.tsv`)

| 명령 | 결과 |
|---|---|
| `pnpm install --frozen-lockfile` | 0 |
| `pnpm bundle:check` (빌드 전) | 0 |
| `pnpm claude:drift` | 0 |
| `pnpm lint` | 0 |
| `pnpm build` | 0 |
| `pnpm test` | 0. 880 통과, 4 skip (audit1의 877에 새 사례 3개가 더해짐) |
| `pnpm runtime:check` | 0 |
| `pnpm validate:all` | 0 |
| `pnpm validate:official` | 1, FAIL_UNRELATED(환경): Codex validator `validate_plugin.py` 없음(ENOENT) |
| `pnpm claude:build`, `pnpm claude:check` | 0, 0 |
| `git diff --check` (작업 트리, `3501e7c5..44235fb5`, `0c8b52d9..44235fb5`) | 0, 0, 0 |
| `pnpm source:check` | 0 |
| 빌드 뒤 `git status --porcelain` | 0 byte |
| wake-liveness 외 2개 10회 반복 | 10/10 (각 49/49) |
| previous-broker, v2.7.4 태그 dist broker | 4/4 (`logs/previous-broker-v2.7.4.log`, 시험 이름은 verbose 재실행에 있음) |
| writer evidence 체크섬 | 32/32 일치 |

## Findings

- **T-3 (minor, 시험 정밀도, 비차단):** `live-birth-behind-ended`의 `reserveManagedWake(...).dispatch === false` 단언은 원인을 가려내지 못한다. `retireAt`에 live relay가 없어서(relay-1은 `f.now`에 잡힌 뒤 갱신되지 않음) presence와 상관없이 false가 된다.
  - 제품 동작은 맞다. relay-1을 `retireAt`에 다시 잡아도 최신 행이 끝난 B이므로 false다(probe).
  - 같은 블록의 `presence ended`와 `presence-not-online` 단언은 최신 행 때문에 성립하므로, 반례 고정(T-2)은 이 두 단언과 퇴역 단언으로 충분하다.
  - 권장(선택): 단언 전에 `f.store.acquireRelay({... relayId: 'relay-1'}, f.retireAt)`로 relay를 살려 두면, 주석대로 presence 때문에 false임을 고정한다.
- **I-3 (정보):** release notes의 I-1 예외 문장 "2.7.4는 영구히 latch로 두었지만"은 활동이 없고 그 행이 최신으로 살아 있는 동안에 한한다. 기준에서도 만료 뒤 활동이나 더 늦은 live birth가 생기면 퇴역한다. 사용자 판단에 영향은 없다.
- audit1의 T-2는 해소, I-1과 I-2는 반영됐다.

## NOT_RUN

- Windows 실행, 그리고 `44235fb5`의 CI 결과 조회.
- previous-broker v2.7.3, v2.7.2, v2.7.1, v2.2.6: 요청 범위(v2.7.4)만 돌렸다. 제품 코드가 바뀌지 않았으므로 audit1 결과(각 4/4)가 그대로 적용된다고 보지만, 이번에 재실행하지는 않았다.
- 시계 +25초 흉내, 운영 DB 모양 fixture, 잠자기 복귀 probe(O1–O3), 두 process 경합: 제품 코드가 같아 audit1 결과를 인용했고, 다시 돌리지 않았다.
- `source:verify`: 이번에 실행하지 않았다(audit1에서 NOT_VERIFIABLE).

## 산출물

- `audit/REPORT.md` (이 파일), `audit/meta.json`, `audit/SHA256SUMS` (커밋된 blob 기준)
- `audit/harness/`: `run-full.sh`, `mutants.py`(audit1과 같은 12종), `behind-ended-probe.mts`, `redact.py`, `make-meta.sh`
- `audit/logs/`: 전체 검증(`full-*`), `mutants/`, `repeat*.log`와 `repeat10.txt`, `previous-broker-v2.7.4.log`, `behind-ended-probe-*.log`, `base-0c8b52d9-new-wake-liveness.log`, `change.diff`, `commits.txt`, `writer-sha256-check.txt`

가림 규칙과 결과는 `meta.json`의 `redaction`에 있다.
