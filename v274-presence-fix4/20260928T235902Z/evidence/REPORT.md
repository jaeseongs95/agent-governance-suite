# AGS 2.7.4 시험 타이밍 수정 (fix4: windows-latest CI)

- 기준: `claude/v274-presence` = `0135326a921cccc7b49b0ad8b605e87893631804` (PR #17, run 36499856828 windows-latest 실패)
- 새 commit: `b31da7789b3f48c548c24d6fb5a6f0b7bfa63f2c`, tree `c846c249dd216ae9115bcbd8c10dd6e915ebd6b0`
  - `test: keep board presence fixtures live on slow runners`
- push: non-force fast-forward(`0135326..b31da77`), `git ls-remote`로 확인
- 바뀐 파일: 시험 2개(+15, `logs/change.diff`). 제품 코드, 상수, 시험 timeout, assertion은 바꾸지 않았다. `bundle:check`와 `claude:check`는 fresh였다.

## 원인 판정: 총괄 판단이 맞다

- `largeFixture`는 시작 시각 `now`를 한 번 잡는다. live 행은 `born(..., now - 1000)`으로 등록하고, `PRESENCE_LEASE_MS` 20,000이 적용돼 lease는 `now + 19 s`에 끝난다. relay lease는 직접 넣은 `now + 60 s`다.
- 그 뒤 1302행을 시드하고 실제 broker를 띄워 조회한다. broker는 벽시계(`Date.now()`)로 판정한다. 느린 runner(시험 34 s)에서는 조회 시점에 presence lease가 이미 끝나 있다. 그러면 제품은 `unreachable`/`no-live-relay`/`presence-not-online`을 올바르게 돌려준다.
- 재현(아래)에서 CI와 같은 위치(`presence-retention.test.ts:96:38`)가 같은 값으로 실패했다.

## 바꾼 내용

- `presence-retention.test.ts`에 `keepLive(store, sessionIds)`를 추가했다. 시드가 끝난 직후(broker 기동 직전), 그 시점의 `Date.now()` 기준으로 행을 다시 쓴다. presence는 `heartbeat_at = now`, `lease_until = now + 10분`이고, relay lease는 `updated_at = now`, `lease_until = now + 10분`이다. 파일 안의 기존 직접 UPDATE 방식을 따랐다.
  - 큰 DB 시험: `largeFixture` 끝에서 `live-0`, `live-1`에 적용한다.
  - B1 시험: `valid-0..5`에 적용한다.
- `previous-broker.test.ts`의 새 presence 시험: 시드 직후 `lease_until = now + 10분`으로 다시 쓴다.
- 대안으로 fixture 기준 시각을 뒤로 미는 방법도 있었다. 이 방법은 시드 시간이 길어지면 같은 문제가 남으므로 택하지 않았다. 시드 뒤에 한 번 늘리면 시드와 기동이 얼마나 걸려도 10분 안이면 된다.

## 같은 유형 조사

| 위치 | 판정 |
|---|---|
| presence-retention: 큰 DB 시험 | 해당. 고쳤다 |
| presence-retention: B1 시험 | 해당. `now - 1000` 등록 뒤 broker 기동과 조회에서 online을 기대한다. 고쳤다 |
| presence-retention: 보존 경계, live 보존, 불변, 재등록 | 해당 없음. 모든 판정에 명시적 `nowMs`를 넘긴다(`prune(now)`, `presence(t, now)`, `listPresence(now, …)`). `nowMs` 없이 부르는 `presence()`는 행이 모두 지워진 뒤라 lease와 무관하다 |
| presence-retention: 경합 시험 | 해당 없음. 자식 process도 명시적 시각으로 prune하고, 결과는 행 수로만 본다. `largeFixture`의 새 lease도 이 판정에 영향이 없다 |
| presence-retention: 한도 시험 | 해당 없음. 벽시계로 dispatch하지만 행은 ended이거나, 크기 초과만 본다. online이든 unreachable이든 결과가 같다 |
| presence-retention: 마지막 untargeted 시험 | 벽시계에 기대지만 등록 직후 바로 조회하고 사이에 느린 작업이 없다. 위험이 낮아 그대로 두었다 |
| presence-batches | 해당 없음. stub이고 lease가 없다(경과 시간 비교는 stub 자체 지연 기준) |
| session-board | 해당 없음. presence는 mock service가 준 값을 그대로 쓰고, lease를 판정하지 않는다 |
| previous-broker: 새 presence 시험 | 해당. 이전 broker 기동 뒤 online을 기대한다. 고쳤다 |
| previous-broker: 기존 2개 | 해당 없음. presence 생존을 assertion하지 않는다(메시지와 wake 행만 본다) |

## 느린 runner 재현 (임시 변형, 커밋하지 않음)

`harness/slow-runner-variant.py`와 `harness/run-variant.sh`로 재현했다. live 행을 25~26초 전 시각으로 시드하는 변형이다. 시드와 조회 사이가 느린 runner와 같은 상황이 된다.

| 대상 | 수정 전(0135326 시험) | 수정 후 |
|---|---|---|
| presence-retention 큰 DB, B1 | 2 실패(exit 1). `:96:38`에서 `state: "unreachable"`, `reason: "presence-not-online"`로 CI와 같다. B1은 `:123:93` | 2/2 통과 |
| previous-broker 새 presence 시험(v2.7.3 broker) | 1 실패(exit 1, `:193`) | 1/1 통과 |

로그는 `logs/slow-variant-{before,after}-fix-*.log`에 있다. 변형은 실행 뒤 되돌렸다(`.orig` 없음, 작업 트리 깨끗함).

## 검증 (`logs/summary.tsv`)

| 명령 | 종료 코드 |
|---|---|
| `pnpm install --frozen-lockfile` | 0 |
| `pnpm bundle:check` | 0 |
| `pnpm lint` | 0 |
| `pnpm build` | 0 |
| `pnpm test` | 0 (871 통과·3 skip) |
| `pnpm claude:check` | 0 (fresh) |
| `git diff --check` | 0 |

추가 검증:

- presence-retention과 presence-batches 10회 반복: 10/10 통과, 매회 13/13.
- previous-broker: v2.7.3 3/3, v2.7.2 3/3.
- 남은 임시 디렉터리와 broker process: 0개(`logs/leftover-brokers.txt`).

## NOT_RUN

- windows-latest CI 재실행: push 뒤 CI가 돈다. 이 세션은 결과를 확인하지 않았다.
- 전체 검증 순서 중 `claude:drift`, `runtime:check`, `validate:all`, `validate:official`, `claude:build`, `source:check`: 요청 범위 밖이다. 시험 파일만 바뀌었다.
- 실제 느린 Windows runner: Linux에서 시각을 앞당긴 변형으로 대신했다.

## 가림

같은 규칙으로 가렸다. 건수는 `meta.json`에 있다. `SHA256SUMS`는 커밋된 blob 기준이다.
