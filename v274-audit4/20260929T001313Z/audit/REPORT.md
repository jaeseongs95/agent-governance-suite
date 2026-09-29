# AGS v2.7.4 재감사 4차 (0135326a → b31da778, windows-latest CI 시험 수정분)

- 판정 대상: `claude/v274-presence` = `b31da7789b3f48c548c24d6fb5a6f0b7bfa63f2c` (tree `c846c249dd216ae9115bcbd8c10dd6e915ebd6b0`)
- 이전 감사: `0135326a`에 대해 PASS. evidence는 `claude/evidence-v274-audit3-20260928T233533Z`(`5c758fe`)에 있다.
- 커밋: `b31da778` test: keep board presence fixtures live on slow runners
- 실패한 CI: run 36499856828, job `Node 24 / windows-latest`(id 109187863303), head `0135326a`. 같은 run의 ubuntu-latest job은 success였다. GitHub MCP로 읽기 전용으로 조회했다(`logs/ci-windows.txt`, 테스트 출력 마지막 400줄, 색 코드 제거).
- writer 근거 `claude/evidence-v274-presence-fix4-20260928T235902Z`(`cb0a9df`)는 대조용이다. 체크섬 32/32 일치. 판정은 직접 재현한 결과로만 한다.
- 읽기 전용으로 감사했다. 시험 변형과 mutant는 버리는 worktree에서만 적용하고 되돌렸다.
- 환경: Linux cloud 컨테이너 1대(ext4), Node v24.21.0, pnpm 11.19.0.

## 판정: **PASS_WITH_FINDINGS**. 출시를 막지 않는다

- 총괄 판단이 맞다. 실패는 시험 fixture의 벽시계 lease(20초)가 느린 runner에서 끝난 것이다. 제품은 끝난 lease에 올바르게 `unreachable`을 돌려줬다.
- `b31da778`은 시험 두 파일만 바꿨다. 느린 runner를 흉내 내면 `0135326a`는 CI와 같은 assertion으로 실패하고, `b31da778`은 통과한다.
- finding은 minor 1건(T-1)이다. 같은 유형의 벽시계 의존이 확인 요청 범위 밖의 `session-message.test.ts` 시험 하나에 남아 있다. 발생 창이 좁아 출시를 막지 않는다.

## 항목별 결과

| # | 항목 | 결과 |
|---|---|---|
| 1 | 범위 | PASS |
| 2 | 원인 판정 | PASS. 제품 결함 근거 없음 |
| 3 | 수정 | PASS_WITH_FINDINGS (T-1) |
| 4 | 재현 | PASS |
| 5 | 검증 | PASS |

### 1. 범위 — PASS

`git diff --stat 0135326a b31da778`에는 두 파일, +15줄뿐이다.

- `tests/session-messaging/presence-retention.test.ts` +12
- `tests/session-messaging/previous-broker.test.ts` +3

바뀐 것은 추가된 줄뿐이고 지운 줄은 없다.

- 제품 코드, dist, 상수(`PRESENCE_LEASE_MS` 등), 시험 timeout(60,000·30,000·20,000), assertion 기대값은 그대로다.
- `bundle:check`와 `claude:check`는 fresh였다.
- 생성 뒤 `git status --porcelain`은 0 byte다.

### 2. 원인 판정 — PASS

**lease 판정 코드는 맞다**

- `store.presence`는 `ended_at`이 있으면 `ended`, `Date.parse(lease_until) > nowMs`이면 `online`, 그 밖이면 `unreachable`이다(`session-message-store.ts:1192`).
- broker의 `list-presence`는 요청 시점의 `Date.now()`를 넘긴다(`session-message-broker.ts:390`). 시각은 모두 `toISOString()`(UTC)이라 시간대 문제가 없다.
- `autoWakeOutlook`은 presence가 online이 아니면 `no-live-relay`/`presence-not-online`을 돌려준다(`:720`). CI의 Received 값(`unreachable`, `no-live-relay`, `presence-not-online`)과 같다.

**fixture 시각**

- `0135326a`에서 live 행은 `born(..., now - 1000)`이라 lease가 `now + 19s`에 끝난다. relay lease는 직접 넣은 `now + 60s`였다.
- `now`는 시험 시작에 한 번 잡힌다. 시드, broker 기동, 조회가 합쳐서 19초를 넘으면 조회 시점에 lease가 이미 끝나 있다.

**CI와 Linux 시간 비교**

Windows는 CI 로그 값이고, Linux는 `0135326a`에서 verbose로 한 번 실행한 값이다(`logs/linux-timing-0135326a.txt`).

| 시험 | DB | Windows CI | Linux | 배율 |
|---|---|---|---|---|
| 342-identity 큰 DB | 파일, 쓰기 약 2,000회 | 34,336 ms | 1,141 ms | 30배 |
| 두 process 경합 prune | 파일 | 20,739 ms | 972 ms | 21배 |
| retirement·autoWake 불변 | 파일 | 1,349 ms | 56 ms | 24배 |
| 재등록 세대 | 파일 | 958 ms | 32 ms | 30배 |
| live 행 보존 | `:memory:` | 57 ms | 31 ms | 1.8배 |
| B1 (6행 시드, broker 기동, 조회) | 파일, 쓰기 6회 | 693 ms | 241 ms | 2.9배 |

- 20~30배 느린 시험은 파일 DB에 쓰기를 많이 하는 시험뿐이다.
- 같은 runner, 같은 파일에서 실제 broker를 `tsx`로 띄워 조회까지 한 B1은 693 ms에 끝났다. 그러므로 broker 기동과 조회는 34초의 원인이 아니다.

**Linux 단계별 측정** (`logs/phase-timing.log`, 두 commit 각 3회)

| 단계 | 측정 |
|---|---|
| 시드 | 706~802 ms |
| broker ready까지 | +227~242 ms |
| listPresence | +79~86 ms |

- `logs/prune-cost.log`: 같은 fixture의 시드는 쓰기 호출 2,002회(각 autocommit)다. 첫 prune(1302→42행)은 3.2~4.4 ms, 두 번째는 0.2~0.3 ms다.
- `startPresence`와 `endPresence`는 prune하지 않는다. 그래서 시드 비용은 행 수에 선형이다.

**결론**

- 34초의 대부분은 시험 process가 2,002번 commit하는 시드로 보인다. broker와 prune은 비정상적으로 느리지 않다.
- 추론: Windows runner의 commit 비용이 약 15~17 ms/commit이면 설명된다. Windows에서 직접 재지는 않았다.
- 제품이 끝난 lease를 `unreachable`로 보인 것은 올바른 동작이다.

### 3. 수정 — PASS_WITH_FINDINGS

**keepLive** (`presence-retention.test.ts:48-56`)

- 시드가 끝난 직후, broker 기동 전에 그때의 `Date.now()` 기준으로 대상 세션의 presence(`heartbeat_at`, `lease_until = now + 10분`)와 relay lease(`updated_at`, `lease_until = now + 10분`)를 다시 쓴다.
- `largeFixture` 끝에서 `live-0`과 `live-1`에, B1에서 `valid-0..5`에 쓴다. 대상 세션은 모두 행이 하나다.
- `store.database`로 직접 UPDATE하므로 prune을 부르지 않는다. broker는 여전히 1302행 전체를 처음 만나고, 행 수 assertion(`rows: 1302`)도 그대로다.
- ended·old 행에는 손대지 않는다.
  - `old-*`: 10일 전 lease라 24시간 보존을 넘어 지워진다. `old-0`은 unknown/presence-unknown, 남는 행은 42개다.
  - `recent-*`: 1시간 전 ended라 보존된다.
  - 두 판정 모두 그대로다.
- 판별력: 이전 감사의 mutant 12개와 새 L1(lease를 무시하고 ended가 아니면 online)을 `b31da778`의 후보 시험(presence-retention, presence-batches, session-board)에 적용했다. **13/13을 검출**했고, 앞의 12개는 실패 수까지 3차 감사와 같다(`logs/mutants.tsv`). keepLive가 live 보호나 lease 판정 결함을 가리지 않는다.

**previous-broker** (`:185-187`)

- 새 presence 시험의 대상 행 `lease_until`을 `now + 10분`으로 다시 쓴다.
- 이 시험은 small 조회에서 `online`만 본다. 이어지는 many 조회는 응답 한도 초과로 `unanswered`가 되는 것만 본다. 의도가 그대로다.

**같은 유형 조사**

`tests/` 안에서 실제 broker를 쓰는 시험은 `tests/session-messaging/`에만 있다. `session-board`는 mock service를 쓴다. 그래서 broker만 시계를 25초 앞당기는 preload(`harness/clockshift.mjs`)로 `tests/session-messaging`과 `tests/session-board` 전체, previous-broker v2.7.3·v2.7.2를 두 commit에서 돌렸다(`logs/clockshift-sweep.log`).

| 대상 | 0135326a | b31da778 |
|---|---|---|
| presence-retention 큰 DB, B1 | 2 실패 (`:96:38`, `:123:93`) | 통과 |
| presence-batches | 통과(stub, lease 없음) | 통과 |
| session-board | 통과(mock) | 통과 |
| previous-broker 새 presence 시험 (v2.7.3, v2.7.2) | 각 1 실패 | 각 3/3 |
| `session-message.test.ts` "blocks only verified empty Codex wake prompts in the packaged hook" | 실패 | **실패** (T-1) |

presence-retention의 나머지 시험(untargeted 목록 포함)은 25초 이동에서도 통과한다. writer의 같은 유형 표와 맞는다.

### 4. 재현 — PASS

**broker 시계 +25초** (`logs/repro-clockshift.log`)

| commit | 이동 없음 | +25초 |
|---|---|---|
| 0135326a | 13/13 | 2 실패, 11 통과 |
| b31da778 | 13/13 | 13/13 |

`0135326a`의 +25초 실패는 CI와 같은 위치, 같은 값이다: `presence-retention.test.ts:96:38`, Received `state: "unreachable"`, `autoWake.state: "no-live-relay"`, `reason: "presence-not-online"`. B1도 `:123:93`에서 실패한다. CI에서 B1은 693 ms에 끝나 20초 창 안이었기 때문에 통과했다.

**시계 조작 없는 실제 20초 대기** (`logs/repro-realwait.log`)

시드 직후에 20초를 기다리는 임시 사본으로 돌렸다.

- `0135326a`: 21,317 ms 뒤 CI와 같은 assertion으로 실패
- `b31da778`: 통과

### 5. 검증 — PASS

모두 `b31da778`에서 실행했다(`logs/full-summary.tsv`).

| 검증 | 결과 |
|---|---|
| `pnpm install --frozen-lockfile`, `bundle:check`, `claude:drift`, `lint`, `build` | 모두 0 |
| `pnpm test` | 0, 871 통과·3 skip |
| `runtime:check`, `validate:all`, `claude:build`, `claude:check`, `source:check` | 모두 0 |
| `git diff --check` | 0 (작업 트리와 `0135326a..b31da778` 범위) |
| `validate:official` | 1, FAIL_UNRELATED(환경: Codex validator ENOENT) |
| presence-retention과 presence-batches 10회 | 10/10 (각 13/13). 남은 임시 디렉터리 0 (`logs/repeat10.txt`) |
| previous-broker v2.7.3, v2.7.2 (태그 dist 파일 경로, 시계 이동 없음) | 3/3, 3/3 (`logs/previous-broker.log`) |
| mutant | 13/13 검출 (`logs/mutants.tsv`) |

- 검증 뒤 broker process는 0개였다.
- mutant 표에는 후보 시험 결과만 적었다. 이 worktree에는 감사 시험(`v274-audit*.test.ts`)이 없으므로 넣지 않았다.

## Findings

### T-1 (minor, 시험 견고성, 비차단) `session-message.test.ts`의 packaged hook 시험도 20초 presence lease에 기댄다

- 위치: `tests/session-messaging/session-message.test.ts:1157` "blocks only verified empty Codex wake prompts in the packaged hook". 시나리오마다 `startPresence(..., now)`로 등록하고 곧바로 packaged hook(`spawnSync`)을 부른다. hook은 실제 source broker에 묻는다.
- 재현:
  - broker 시계 이동: 19,000 ms까지는 통과하고 21,000 ms에서 실패한다(`logs/hook-threshold.log`).
  - 실제 대기: `submitted` 시나리오의 invoke 앞에서 18초를 기다리면 통과하고, 21초를 기다리면 `:1205`(임시 줄 1개 추가로 원래 `:1204`)에서 실패한다(`logs/hook-realwait.log`). Expected `{ decision: "block" }`, Received `{}`.
- 창: 시나리오마다 그 시나리오의 시드(쓰기 약 10회)와 hook process 한 번 사이에 20초가 지나야 한다. 1302행 시드 뒤에 기동과 조회가 이어지는 큰 DB 시험보다 창이 훨씬 좁다.
  - Windows CI run 36499856828에서도 이 파일은 통과했다.
  - 요청한 확인 범위(presence-retention, presence-batches, session-board, previous-broker) 밖이다.
- 영향: 제품에는 영향이 없다. 매우 느린 runner에서 드물게 CI를 빨갛게 만들 수 있다.
- 권장(선택): 다음 시험 정리 때 같은 keepLive 방식(등록 뒤 lease 연장)을 적용한다.

## 정보

- I-1(3차 감사의 혼합 버전 표 문구)은 이번 변경과 무관하다. 그대로 남아 있다.
- writer evidence의 원인 판정, 같은 유형 표, 재현 결과는 이 감사의 결과와 맞는다. 다만 T-1은 writer가 조사한 범위 밖이라 표에 없다.

## NOT_RUN / NOT_VERIFIABLE

- Windows 실행과 `b31da778`의 windows-latest CI: 환경이 없다. 총괄의 Windows 11 검증은 진행 중이라고 들었고, 이 감사에서는 확인하지 않았다. Windows commit 비용은 추론이며 직접 재지 않았다.
- `pnpm source:verify`: 이번 범위와 무관하고, 삭제된 외부 저장소 때문에 NOT_VERIFIABLE이다.
- previous-broker v2.7.1과 v2.2.6: 지시 범위 밖이다.

## 가림(redaction)

`harness/redact.py`를 적용했다.

- 기존 규칙: 토큰 패턴, 이메일, 사용자명 경로, `/[REDACTED-HOME]`, IP
- 새 규칙: URL 안의 GitHub 계정명, 계정명 문자열, Windows 사용자 홈 경로(Users 폴더 아래 이름)

건수는 `meta.json`에 있다. CI 로그는 원문 전체가 아니라 마지막 400줄(테스트 출력)을 색 코드만 지워 넣었다. `SHA256SUMS`는 커밋된 blob 기준이다.

## 산출물

- `audit/REPORT.md`, `audit/meta.json`, `audit/SHA256SUMS`
- `audit/logs/`: 전체 검증, 10회 반복, previous-broker, mutant, 재현(시계 이동, 실제 대기), 단계 시간, prune 비용, Linux 시험 시간, 시계 이동 sweep, T-1 임계값, CI windows 로그 발췌
- `audit/harness/`: `run-full.sh`, `mutants.py`, `clockshift.mjs`, `repro.sh`(인라인으로 실행한 재현 절차), `redact.py`, `make-meta.sh`
