# AGS v2.7.6 후보 독립 감사

- **판정: PASS_WITH_FINDINGS, 출시 차단 아님**
- 판정 대상: `claude/v276-presence-deadline` = `93a7e4bc69f556859bc929af1df871dfc74eae68` (tree `90ec390cc6dffdcf34e52960103f71e883833907`)
- 기준: main `3706167d4646c53c8b47510eebda58931cbd1cfe` (tag v2.7.5)
- writer evidence(대조용): `evidence` 브랜치 `v276-presence/20260929T030842Z` (@ `4a0bf82a`). 판정은 직접 재현한 결과로만 했다.
- 읽기 전용이다. 제품 소스는 바꾸지 않았다. mutant, 감사용 시험과 probe는 버리는 worktree에서만 돌리고 지웠다(끝난 뒤 세 worktree 모두 `git status` 0줄).

## 결론

L2는 의도대로 동작한다.
- deadline은 조회마다 한 번 잡는다.
- 남은 시간이 없거나 client deadline에 걸리면 기존 "거절이 아닌 실패 → 멈춤" 경로를 탄다. 앞선 결과는 유지되고, 늦은 응답은 결과를 바꾸지 못한다.
- 실제 느린 broker(묶음마다 1초, 90개 세션)에서 조회는 기준 30.2초에서 후보 20.0초로 줄었다. deadline 초과량은 0–3ms였다.

T-4의 원인 판정(fixture의 개별 commit)도 재현했다. fsync마다 20ms를 더하면 기준은 342-identity 시험이 46.4초, 두 process 경합 시험이 30초 시간 초과로 실패한다. 후보는 같은 조건에서 1.5초와 2.0초다.

finding은 모두 minor이고 출시를 막지 않는다.
- **L2-1:** service의 deadline이 벽시계(`Date.now`)를 쓴다.
- **T-5:** previous-broker 완화가 버전에 묶여 있지 않다.

## 항목별 결과

| # | 항목 | 결과 |
|---|---|---|
| 1 | 범위와 신선도 | PASS |
| 2 | L2 정확성 | PASS (L2-1) |
| 3 | 반증과 mutant | PASS |
| 4 | 시험 안정성 | PASS (위험 낮음, I-6) |
| 5 | previous-broker 변경 | PASS_WITH_FINDINGS (T-5) |
| 6 | 문서 | PASS |
| 7 | 검증 | PASS (`validate:official`만 FAIL_UNRELATED) |

### 1. 범위와 신선도 (`logs/commits.txt`, `logs/change.diff`, `logs/version-bump-set.txt`)

- **커밋과 파일:** `3706167d`는 `93a7e4bc`의 조상이다. 커밋 5개, 파일 19개다.
- **제품 소스 변경:**
  - `session-message-service.ts`(+9/−3): `listPresence`의 전체 deadline.
  - `session-message-client.ts`: `SESSION_MESSAGE_REQUEST_TIMEOUT_MS`에 `export`만 추가.
  - `plugin-info.ts`: 버전.
  - dist 2개(`mcp-server/dist/server.mjs`, `claude-plugin/mcp-server/dist/server.mjs`)가 이 소스를 반영한다.
  - broker·store·schema·계약 변경은 없다.
- **버전 올림:** `10cfd37`의 11개 파일은 v2.7.5 release commit `3501e7c5`와 같은 집합이다.
- **나머지:** 시험 4개(`presence-deadline.test.ts` 신규, `fixtures/slow-list-presence.mjs` 신규, `presence-retention.test.ts`, `previous-broker.test.ts`), 문서 2개(`release-notes-v2.7.6.md` 신규, `session-message-lifecycle.md`).
- **신선도:** `bundle:check` 0(빌드 전), `claude:build` 뒤 `claude:check` 0, 검증 뒤 작업 트리 변경 0 byte.

### 2. L2 정확성

코드: `session-message-service.ts:106-133`, `session-message-client.ts:85-120`(`withDeadline`), `:150-211`(`requestSessionMessageOnce`), `:267-340`(`ensureSessionMessageBroker`, `sessionMessageRequest`).

- **deadline을 한 번 잡는가:** `deadline`은 반복문 밖에서 한 번 계산하고(`:111`), 묶음마다 `remaining = deadline - Date.now()`만 넘긴다. 이를 반복문 안으로 옮기거나 고정값으로 바꾼 mutant(A1, A2, D3)는 모두 잡힌다.
- **남은 시간이 0 이하일 때:** 일반 `Error`를 던진다. `BrokerRequestRejected`가 아니므로 catch(`:128`)에서 `asked.slice(index)`를 unanswered로 두고 멈춘다. 앞선 `sessions`는 유지된다.
  - 가드를 빼도(A3), 0 이하 `totalTimeoutMs`는 `withDeadline`이 즉시 deadline 오류로 던져 같은 경로를 탄다(0<remaining<1도 같다). 가드는 명시용이고, A3이 살아남는 것은 결과가 같아 잡을 수 없는 경우라서다.
- **client deadline을 넘을 때:** `withDeadline`이 abort로 `Promise.race`를 reject한다. 이 오류도 거절이 아니므로 같은 경로를 탄다.
- **늦은 응답:**
  - `withDeadline`의 race가 한 번 결정되면 끝난다. `requestSessionMessageOnce`의 `finish`는 `settled` 플래그로 한 번만 실행되고, abort 때 socket을 `destroy`한다.
  - service는 이미 반환한 `sessions` 배열을 다시 건드리지 않는다.
  - fake 시험 "does not let an answer that arrives after the deadline change the result"와 실제 느린 broker(끊긴 묶음의 broker 쪽 처리가 끝나도 결과 불변)로 확인했다.
- **broker 기동과 겹칠 때** (`logs/cold-start.jsonl`, `harness/cold-start-probe.mts`): broker가 없는 상태에서 첫 조회가 dist broker를 띄운다. 기동 지연은 broker process에만 preload로 주입했다.

  | 기동 지연 | 세션 | 걸린 시간 | 답 | unanswered |
  |---|---|---|---|---|
  | 0 | 90 | 0.27초 | 90 | 0 |
  | 12초 | 90 | 12.3초 | 90 | 0 |
  | 17초 | 90 | 15.0초 | 0 | 90 |
  | 0 | 300 | 0.57–0.64초 | 300 | 0 |

  - 기동 대기는 `min(15초, 남은 예산)`으로 잘리고, 끝나면 남은 예산이 첫 묶음에 넘어간다.
  - 15초를 넘는 기동은 첫 묶음 실패로 끝나서 모두 unknown이 된다. 20초 안에서 끝난다.
- **호스트 제한:** Codex 공식 config reference(learn.chatgpt.com)에서 "default 60s per-tool timeout"을 확인했다. 20초는 이보다 짧다.
  - 현황판 도구는 이 조회 외에 현황판 SQLite 읽기만 한다(`server.ts:286-294`).
  - Claude Code의 MCP 도구 제한은 이번에 확인하지 않았다.
- **동시성 기각 근거:** broker의 요청 처리 `dispatchSessionMessageBrokerOperation`(`session-message-broker.ts:197`)은 동기 함수다. `list-presence`(`:382`)는 `node:sqlite` 동기 호출이고, broker 파일의 `await`는 기동·자격 증명 부분에만 있다. 그래서 동시에 보내도 broker 쪽 처리는 직렬이다. 코드와 맞다.
- **L2-1 (벽시계):** service는 `Date.now`, client는 `performance.now`(단조 시계)로 잰다. fake timer probe에서 조회 5초째에 시스템 시계를 60초 되돌렸다(`logs/clock-step.jsonl`, `harness/clock-step.audit.test.ts`).
  - 요청이 11번에서 43번으로 늘고, 답도 30개에서 126개로 늘었다.
  - 즉 조회가 되돌린 만큼(약 60초) 길어져, Codex 도구 제한 60초를 넘을 수 있다.
  - 시계가 앞으로 뛰면 일찍 끝나서 unknown이 늘 뿐이다.
- **정보(I-4, 기존 동작):** 묶음 하나가 2.5초(시도당 상한)를 넘게 걸리는 broker에서는, 한 번 재시도한 뒤 5.5초에 멈추고 90개 모두 unknown이다. 기준 `3706167d`도 같다(`logs/timing-base-3706167d.jsonl`). 이번 변경과 무관하다.

### 3. 반증과 mutant

**기준 `3706167d`에 새 시험을 넣어 실행** (`logs/base-3706167d-new-tests.log`)
- presence-deadline 4개 중 2개 실패: "slow but answering", "answer after the deadline".
- "unresponsive broker"와 "normal broker"는 기준에서도 통과한다(기존 동작 고정).
- 실제 느린 broker 시험은 30.4초로 실패하고, 후보에서는 통과한다.

**mutant** (`logs/mutants/mutants.tsv`; 대상: presence-deadline, presence-batches, presence-retention, session-board)

| mutant | 내용 | 결과 | 잡은 시험 |
|---|---|---|---|
| D1 | 가드와 예산 제거 | KILLED | 3 |
| D2 | 예산을 넘기지 않음 | KILLED | 2 |
| D3 | 묶음마다 20초 | KILLED | 3 |
| D4 | 실패 뒤에도 계속 | KILLED | 2 |
| A1 | deadline을 고정값(20000)으로, `remaining = deadline` | KILLED | 3 |
| A2 | deadline을 반복문 안에서 계산 | KILLED | 3 |
| A3 | 가드만 제거(예산은 넘김) | SURVIVED | 결과가 같아 잡을 수 없음(위 2절) |
| A4 | 예산 +5초 | KILLED | 3 |
| A5 | 예산 +1.5초 | KILLED | 3(fake 시험만; 실제 느린 broker 시험은 통과) |
| A6 | 전체 deadline 40초 | KILLED | 4 |
| A7 | 예산을 시도당 2.5초로 제한 | KILLED | 3(fake 시험의 예산 단언) |
| A8 | deadline 도달을 거절로 처리 | SURVIVED | 결과가 같아 잡을 수 없음: 이후 묶음도 모두 즉시 거절되어 같은 unanswered 순서가 됨 |

- writer의 D1–D4 판정과 같다.
- A5에서 보듯 실제 느린 broker 시험은 2초 안쪽의 초과를 잡지 못한다. 정확한 상한은 fake 시험이 고정한다.
- A7이 실제로 깨뜨리는 것은 기동과 겹친 첫 조회다(15초 기동이 2.5초 예산에 들어가지 않음). 이를 고정하는 시험은 fake 예산 단언뿐이고, 실제 기동과 겹친 조회 시험은 없다.

### 4. 시험 안정성

**실제 느린 broker 조회 시간** (`logs/timing.jsonl`; 감사용 사본이 `listPresence` 경과 시간을 기록)

| 조건 | 횟수 | 경과(ms) | deadline 초과(ms) | 답 |
|---|---|---|---|---|
| 보통, 1000ms | 10 | 20001–20003 | 1–3 | 57/90 |
| 보통, 1900ms | 1 | 20000 | 0 | 30/90 |
| CPU 포화(코어마다 busy loop), 1000ms | 5 | 20002–20003 | 2–3 | 57/90 |
| fsync마다 20ms + ptrace(strace -f), 1000ms | 3 | 20001–20002 | 1–2 | 57/90 |
| 기준 `3706167d`, 1000ms | 1 | 30193 | — | 90/90 |

- 원래 시험 파일(`presence-retention.test.ts`) 전체도 돌렸다. CPU 포화에서 3/3 통과했고 느린 broker 시험은 20.5초였다. fsync+ptrace에서도 통과했고 20.96초였다.
- **판단: 흔들릴 위험은 낮다.**
  - `22_000` 상한까지 여유는 2초이고, 관측된 초과는 최대 3ms다.
  - 초과가 생기는 경로는 시험 worker의 timer 지연뿐이다. deadline 뒤에는 새 요청이 없고, client가 socket을 끊는다.
  - broker 쪽 느림(요청당 비용, fsync, 기동)은 deadline 안에서만 비용을 쓰고, 답의 수만 줄인다. 단언은 `answered.length > 0`이라 첫 묶음 하나(약 1초)만 있으면 된다.
- **남는 위험과 권장(I-6, 선택):**
  - 상한을 `SESSION_MESSAGE_REQUEST_TIMEOUT_MS + 2_000`처럼 상수에 묶으면, 상수를 바꿀 때 시험이 따라간다.
  - 이 시험은 CI마다 20초 넘게 걸린다. vitest timeout 60초는 충분하다.
  - broker 기동 대기 5초(`waitForSessionMessageBrokerReady(state, child, 5000)`)는 이 파일의 다른 시험과 같은 기존 값이다. tsx와 preload를 쓰는 느린 Windows runner에서 가장 먼저 걸릴 곳은 22초 상한이 아니라 이 기동 대기다. 관측값은 0.23–0.66초였다.
- **fixture 한 transaction:**
  - `BEGIN`/`COMMIT`이 seeding 전체와 `keepLive`를 감싼다. 같은 연결이 자기 쓰기를 읽으므로 store 호출 순서와 결과는 같다.
  - `rows 1302, identities 342` 단언, broker가 첫 요청에서 전체 DB를 prune하는 순서(relay lease 직접 삽입), prune 뒤 42행 단언은 그대로다.
  - store 안의 `BEGIN IMMEDIATE`와 겹쳤다면 시험이 실패했을 것이고, 통과한다.
- **fsync 흉내** (`logs/fsync20ms-presence-retention*.log`)

  | 시험 | 기준 `3706167d` | 후보 |
  |---|---|---|
  | 342-identity | 46.4초 통과 | 1.5초 |
  | 두 process 경합 | 30초 시간 초과로 실패(Windows 증상과 같음) | 2.0초 |

  writer의 판정(개별 commit이 원인)과 맞다.
- **벽시계 lease:**
  - 새 느린 broker 시험은 presence 행이 없어 lease와 무관하다.
  - `keepLive`는 seeding 끝에 벽시계 기준 10분 lease를 쓴다. 기존 방식이고, seeding이 빨라져 여유가 오히려 늘었다.
  - fake 시험은 fake timer만 쓴다.
- **10회 반복:** presence-deadline, presence-retention, presence-batches 10/10 통과했다(각 18/18, 22.1–22.5초, `logs/repeat10.txt`). 남은 broker process는 0이다. 파일의 `leftover-broker-processes=1`은 grep이 자기 셸 명령줄을 센 값이고, `ps`로 0을 따로 확인했다.

### 5. previous-broker 변경 (`93a7e4bc`)

- `previous-broker-summary.txt`:

  | 이전 broker | 후보 시험 | 기준 `3706167d`의 엄격한 시험 |
  |---|---|---|
  | v2.7.5 | 4/4 | 3/4 (ended-birth 시험 실패) |
  | v2.7.4 | 4/4 | 4/4 |
  | v2.7.3 | 4/4 | 4/4 |

- v2.7.5 broker는 이미 퇴역시키므로 완화가 필요하다. v2.7.4와 v2.7.3은 여전히 latch를 유지한다. 두 버전에서 엄격한 단언이 통과하므로, 실제 실행에서 그 버전들의 결과는 약해지지 않았다.
- **T-5:** 분기가 버전이 아니라 관찰된 상태(`kept?.state === "expired-unobserved"`)로 정해진다.
  - 그래서 v2.7.4나 v2.7.3 broker로 돌려도 "이전 broker는 latch를 남긴다"를 더 이상 요구하지 않는다.
  - 그 경우 뒤의 "새 broker가 퇴역시킨다" 단언(`current.prune()`)도 이미 퇴역한 행을 보므로 비어 있게 된다.
  - 태그 dist broker는 바뀌지 않으므로 지금 드러나는 결함은 없다. 다만 시험이 주석("2.7.4 and 2.7.3 keep the latch")을 강제하지 않는다.
  - ping 응답에는 버전이 없다(`capabilities`만 있음).
  - 권장: `AGS_PREVIOUS_BROKER_VERSION` 같은 명시적 입력으로 2.7.5 이상에서만 퇴역을 허용하고, 그 미만에서는 `expect(kept).toEqual(before)`를 유지한다.
- 감사 중 v2.7.5 첫 실행은 로컬 태그가 없어 빈 broker 파일로 돌았다(감사 harness 오류). 로그는 `*-harness-error-empty-broker.log`로 남겼고, 태그를 fetch한 뒤 다시 돌린 결과가 위 표다.

### 6. 문서

- `release-notes-v2.7.6.md`와 `session-message-lifecycle.md:190-192`가 코드·재현과 맞는지 확인했다.

  | 문서 주장 | 재현 |
  |---|---|
  | 90개 약 30초 → 약 20초 | 30.2초 → 20.0초 |
  | 300개 100묶음 1.9초면 190초 | fake 시험의 전제와 계산 |
  | 기동 대기 최대 15초가 20초 안에 끝날 수 있음 | 12초 기동에서 12.3초에 90개 모두 답 |
  | Codex 기본 60초 | 공식 문서로 확인 |
  | 정상 broker에서 300개 약 0.5초 | 0.57–0.64초(broker 기동 포함) |
  | 44개 세션(15개 묶음) | 40+2+2 = 44 |
  | 48.6초·47.3초 → 1.7초·2.5초 | 46.4초·30초 시간 초과 → 1.5초·2.0초 (같은 방향과 규모) |
  | 거절된 묶음, 거절이 아닌 실패, 형식 밖 identity, 묶음 크기 3 규칙은 그대로 | 코드 확인 |

- 2.7.5까지 "여러 묶음을 합친 전체 deadline은 없다"던 문장을 새 절로 바꾼 것이 맞다.
- `docs/release-notes-v*` 중 바뀐 것은 새 `v2.7.6.md`뿐이다. 공개된 v2.7.5 이하 notes는 그대로다.
- 추가된 줄에 URL은 없다. 문서의 링크는 저장소 안 상대 링크(`../README.md#설치`, lifecycle 앵커 `#### presence 보존과 현황판 조회`)뿐이고, 둘 다 존재한다. 외부 스킬 저장소 링크는 없다.

### 7. 검증 (`93a7e4bc`, Node 24.21.0, pnpm 11.19.0, `logs/full-summary.tsv`)

| 명령 | 결과 |
|---|---|
| `pnpm install --frozen-lockfile` | 0 |
| `pnpm bundle:check` (빌드 전) | 0 |
| `pnpm claude:drift` | 0 |
| `pnpm lint` | 0 |
| `pnpm build` | 0 |
| `pnpm test` | 0. 885 통과, 4 skip |
| `pnpm runtime:check` | 0 |
| `pnpm validate:all` | 0 |
| `pnpm validate:official` | 1, FAIL_UNRELATED(환경): Codex validator `validate_plugin.py` 없음(ENOENT) |
| `pnpm claude:build`, `pnpm claude:check` | 0, 0 |
| `git diff --check` (작업 트리, `3706167d..93a7e4bc`) | 0, 0 |
| `pnpm source:check` | 0 |
| 빌드 뒤 `git status --porcelain` | 0 byte |
| presence 3종 10회 반복 | 10/10 |
| previous-broker v2.7.5, v2.7.4 (+v2.7.3) | 각 4/4 |
| writer evidence 체크섬(`4a0bf82a`) | 49/49 일치 |

## Findings

- **L2-1 (minor, 비차단):** `listPresence`의 deadline이 벽시계(`Date.now`, `session-message-service.ts:111,114`)로 계산된다.
  - 조회 중 시계가 뒤로 가면, 되돌린 만큼 조회가 길어진다. probe에서 60초를 되돌리자 요청이 11번에서 43번으로 늘었다.
  - client는 이미 `performance.now`를 쓴다. 권장: `const deadline = performance.now() + SESSION_MESSAGE_REQUEST_TIMEOUT_MS`와 `deadline - performance.now()`로 바꾼다.
  - 드문 조건(느린 broker와 조회 중 시계 보정이 겹쳐야 함)이라 출시를 막지 않는다.
- **T-5 (minor, 시험, 비차단):** `previous-broker.test.ts:274-278`의 "퇴역했으면 binding만 비교" 분기가 버전에 묶여 있지 않다(5절). 권장: 이전 broker 버전을 입력받아 2.7.5 이상에서만 이 분기를 허용한다.
- **I-4 (정보, 기존 동작):** 묶음 하나가 2.5초를 넘는 broker에서는 기준과 후보 모두 5.5초에 멈추고 전부 unknown이다. notes의 "요청 하나의 한도 안에서"와 맞는다.
- **I-6 (정보):** 실제 느린 broker 시험의 22초 상한은 관측 초과(≤3ms) 대비 여유가 크다. 상수에 묶는 것은 선택이다. Windows에서 먼저 흔들릴 곳은 기존 5초 broker 기동 대기다.
- **I-7 (정보, writer evidence):** writer evidence의 첫 커밋 `298ac88`의 `logs/change.diff`에 계정명이 8번 들어 있었다. 다음 커밋 `4a0bf82`에서 가려졌지만 `evidence` 브랜치 이력에는 남아 있다. 저장소 URL로 이미 공개된 이름이지만, 이번에 정한 "첫 커밋부터 가림" 규칙에는 어긋난다. 이력 수정은 force push가 필요하므로 이 감사에서는 하지 않았다.

## NOT_RUN

- Windows 실행과 실제 Windows runner의 시간, 그리고 `93a7e4bc`의 CI 결과 조회.
- 실제 PC의 현황판, 설치 캐시, MCP 호출 흐름.
- Claude Code 호스트의 MCP 도구 제한 확인(Codex만 공식 문서로 확인).
- previous-broker v2.7.2, v2.7.1, v2.2.6.
- `source:verify` (지난 감사에서 NOT_VERIFIABLE).

## 산출물

- `REPORT.md`, `meta.json`, `SHA256SUMS`: 커밋된 blob 기준이며, 이 폴더 안의 상대 경로를 쓴다.
- `harness/`: `run-full.sh`, `mutants.py`(D1–D4, A1–A8), `timing.sh`, `slow-timing.audit.test.ts`, `cold-start-probe.mts`, `startup-delay.mjs`, `clock-step.audit.test.ts`, `repeat-prev.sh`, `redact.py`, `make-meta.sh`
- `logs/`: 전체 검증, 기준 반증, mutant, timing, cold start, clock step, fsync 비교, 10회 반복, previous-broker, 범위, writer 체크섬.

가림 결과는 `meta.json`의 `redaction`에 있다.
