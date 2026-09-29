# AGS v2.7.4 재감사 (0f0c192e → 240e0ca5, F1·F2 수정분)

- 판정 대상: `claude/v274-presence` = `240e0ca5c22302f689a22c27d3ed34e1151a8ce4` (tree `6e0cb45107e32b57338a215e232ac424b8302136`)
- 이전 감사: `0f0c192e`에 대해 PASS_WITH_FINDINGS. evidence는 `claude/evidence-v274-audit-20260928T230037Z`(`f3ecf02`)에 있다.
- 커밋: `d04fd6be`(F2 수정과 테스트), `240e0ca5`(F1 문서와 F3 알려진 한계)
- writer 근거 `claude/evidence-v274-presence-fix2-20260928T231003Z`는 대조용이다. 판정은 직접 재현한 결과로만 한다.
- 읽기 전용으로 감사했다. mutant는 버리는 worktree에서만 적용하고 되돌렸다.
- 환경: Linux cloud 컨테이너 1대, Node v24.21.0, pnpm 11.19.0.

## 판정: **PASS_WITH_FINDINGS**. 출시를 막지 않는다

F1과 F2는 의도대로 고쳐졌다.

- 정상 상태에서 패턴 밖 식별자나 실패한 묶음은 해당 세션만 unknown/null로 격리된다.
- broker가 없으면 결과가 2.7.3과 같다(전부 unknown/null).
- 공개 도구 출력 형태도 그대로다.

다만 F2 격리가 부작용을 하나 만들었다(F4, major, 비차단). broker 프로세스가 살아 있지만 응답하지 않을 때, 이전에는 첫 묶음 실패에서 멈췄지만 이제는 묶음마다 약 17.5초씩 기다려 전체 시간이 ceil(N/3)배로 늘어난다. 드문 조건이라 출시를 막지는 않는다. 다만 수정 범위가 작으므로 태그 전에 고칠 것을 권장한다.

## 항목별 결과

| # | 항목 | 결과 |
|---|---|---|
| 1 | 범위와 생성물 | PASS |
| 2 | F2 | PASS (부작용 F4) |
| 3 | F1 문서 | PASS |
| 4 | F3 문장 | PASS (F4 보완 필요) |
| 5 | 검증 | PASS |

### 1. 범위 — PASS

`git diff --stat 0f0c192e 240e0ca5`의 14개 파일은 다음뿐이다.

- 소스 4개: service, server의 `withPresence`, protocol의 `isBoundedIdentity`, store의 `boundedIdentity` 위임과 주석
- dist 재생성 4개
- 문서 2개
- 테스트 4개: `presence-batches` 신규, `presence-retention`의 B1, session-board의 unanswered 사례, previous-broker 기대값

`bundle:check`와 `claude:check`가 통과했고, 생성 뒤 `git status`는 0 byte다.

### 2. F2 — PASS

- **패턴 필터**: `session-message-service.ts:109`에서 `isBoundedIdentity`에 맞지 않는 identity는 `asked`에 넣지 않고 `unanswered`로 보낸다.
  - writer 테스트: stub broker가 실제로 요청받은 목록에 패턴 밖 식별자가 없다.
  - 감사 P2(실제 broker): 한 묶음 안에 `has space`가 섞여도 정상 세션은 `online`이고 `unanswered`는 그 하나뿐이다.
- **묶음 격리** (`:110-121`): 실패한 묶음만 `unanswered`로 두고 다음 묶음을 계속 보낸다(writer 테스트: 호출 3회, 실패 묶음 3개만 unanswered).
- **server 구분** (`server.ts:248-253`): unanswered 세션은 `unknownPresence(..., brokerAnswered=false)`로 `autoWake: null`이 된다. 물었지만 행이 없는 세션은 `no-live-relay`/`presence-unknown`이다. session-board 테스트가 두 경우를 모두 단언한다.
- **broker 없음**: 감사 P3. broker를 죽이고 상태 디렉터리를 파일로 막아 재시작도 불가능하게 했다. 결과는 9개 모두 unanswered이고 sessions는 0이다. 즉 전부 unknown/null이며, 2.7.3이나 이전 후보와 같은 화면이다(3 ms).
- **중복**: P2에서 `a`와 `b`를 두 번씩 넣었다. 중복된 것도 각각 답을 받았고 모두 `online`이다. server `Map`은 같은 키에 같은 값을 쓰므로 표시가 일관된다.
- **공개 도구 출력**: 도구는 `apiOk({ sessions: withPresence(...) })`만 반환하고, `unanswered`는 `withPresence` 안에서 판단에만 쓰인다. `listPresence`를 쓰는 곳은 `server.ts:294` 하나뿐이다. 도구 출력 형태와 schema는 그대로이며 `unanswered`는 새지 않는다.
- **`isBoundedIdentity` 이동**: 감사 P1. 옛 store 정규식 두 개와 새 함수를 169개 조합(빈 문자열, 공백, 비ASCII, 길이 경계 64·65·200·201, 줄바꿈 등)에서 비교했고 결과가 같다. store의 거절 문구 "host and sessionId must use bounded identifier characters."도 그대로다.
- **이전 감사 B1 재현**: 이전에는 `mixed.ok=false`였다. 이제는 `good`과 `mixed` 모두 `ok:true`이며 정상 6개가 정상으로 보인다(`logs/b1-r5-r6-rerun.log`).

### 3. F1 — PASS

release notes, lifecycle 문서, store 주석이 이제 다음을 구분한다.

- live 세션: presence, 퇴역 판정, autoWake 상태가 정리 전후로 같다.
- live 행이 없는 세션: 표시되는 instance, 상태, 기준 시각이 바뀌거나 unknown이 될 수 있다.

감사 R5와 R6 재실행 결과(R6: 600건 중 256건에서 live 행이 없는 identity의 보기가 바뀜, online·autoWake 상태·퇴역은 모두 같음)와 맞는다.

reconcile 문장("옛 세대 판정도 가장 최근 presence 행을 쓰므로 드물게 달라질 수 있다, 행이 모두 지워지면 거절된다")은 코드와 맞는다. `reconcileHistoricalWake`의 `isOldGeneration`은 `presence.instanceId !== null`을 요구하므로, 행이 모두 지워지면 reconcile은 `reconciled:false`다.

### 4. F3 문장 — PASS (F4로 보완 필요)

"묶음 3개 고정, ceil(N/3)번 순차, 전체 deadline 없음, 감사 측정 N=300에서 약 0.5초"는 이전 감사의 정상 상태 측정(452~483 ms)과 맞는다. 다만 broker가 응답하지 않을 때의 최악 시간(F4)은 적혀 있지 않다.

### 5. 검증 — PASS

모두 `240e0ca5`에서 실행했다.

| 검증 | 결과 |
|---|---|
| `pnpm install --frozen-lockfile`, `bundle:check`, `claude:drift`, `lint`, `build` | 모두 0 |
| `pnpm test` | 0, 869 통과·3 skip |
| `runtime:check`, `validate:all`, `claude:build`, `claude:check`, `source:check` | 모두 0 |
| `git diff --check` | 0 (작업 트리와 `0f0c192e..240e0ca5` 범위) |
| `validate:official` | 1, FAIL_UNRELATED(환경: Codex validator ENOENT) |
| `presence-retention`과 `presence-batches` 10회 | 10/10 (각 11/11). 남은 임시 디렉터리 0 |
| previous-broker v2.7.3, v2.7.2 (태그 dist 파일 경로) | 3/3, 3/3 |
| mutant (`logs/mutants.tsv`) | **10/10 검출**. 후보 테스트는 presence-retention, presence-batches, session-board |

반복 로그의 "broker procs: 3"은 previous-broker 시험 broker가 종료되던 순간의 값이다. 직후 `ps`로 0개임을 확인했다.

검출된 mutant 10개:

- writer: M1, M5, M7, M9. M7은 새 코드 앵커로 옮겨 적용했다.
- 감사자: A1(가장 오래된 행 보호), A2(끊긴 행도 live로 간주), A3(마지막 부분 묶음 누락). A3은 새 앵커로 옮겨 적용했다.
- F2-isolation-reverted: 첫 실패에서 전부 unanswered
- F2-pattern-filter-removed: 패턴 필터 제거
- F2-server-ignores-unanswered: server가 unanswered를 무시

## Findings

### F4 (major, 비차단, 태그 전 수정 권장) broker가 응답하지 않으면 묶음마다 deadline을 기다려 전체 시간이 세션 수에 비례한다

- 위치: `session-message-service.ts:110-121`. 실패해도 다음 묶음을 계속 보낸다. 묶음마다 `sessionMessageRequest`의 20초 total deadline이 적용된다(시도당 2.5초, 이어서 broker 확인·재시도).
- 재현: 감사 P4(`logs/audit2.log`). 세션 9개(3묶음)를 가진 broker를 SIGSTOP으로 멈춘 뒤 `listPresence`를 호출한다.
  - `240e0ca5`: **52,514 ms**, 묶음당 약 17.5초, 9개 모두 unanswered.
  - 같은 시험을 이전 후보 `0f0c192e`에서 실행: **17,506 ms**. 첫 실패에서 끝난다(`logs/p4-baseline-0f0c192e.log`).
  - 추정치: 현황판 세션 40개면 14묶음이라 약 4분, 100개면 약 10분 동안 `list_session_status` 호출이 끝나지 않는다.
- 조건: broker 프로세스가 살아 있지만 응답하지 않는 경우다(일시정지, 교착, 장시간 잠금 등). broker가 없거나 재시작할 수 있으면 첫 묶음에서 복구되거나 즉시 실패한다(P3: 3 ms). 발생 빈도는 낮다.
- 영향: 표시 결과는 맞다(전부 unknown/null). 그러나 MCP 도구 호출이 몇 분 동안 막힐 수 있다. F3 문장은 정상 상태의 0.5초만 적어 이 최악 경우가 드러나지 않는다.
- 권장(작은 수정):
  - 거절(`BrokerRequestRejected`) 외의 실패(연결, timeout, 응답 한도 초과)가 한 번 나면 남은 묶음을 요청하지 않고 모두 unanswered로 둔다. 거절만 묶음 격리를 적용한다.
  - 또는 전체 deadline(예: 20초)을 두고 남은 시간을 각 묶음에 나눠 준다.
  - 어느 쪽이든 P4 같은 시험을 추가하고, F3 문장에 최악 경우를 적는다.

이전 finding의 상태:

| ID | 상태 |
|---|---|
| F1 | 해소(문서) |
| F2 | 해소(코드와 테스트) |
| F3 | 알려진 한계로 옮김. 정상 상태 수치는 맞으나 F4의 최악 경우를 보완해야 한다 |

## NOT_RUN / NOT_VERIFIABLE

- `pnpm source:verify`: 이번 범위와 무관하고 삭제된 외부 저장소 때문에 NOT_VERIFIABLE이다(이전 감사 참고).
- Windows 실행과 실제 PC 운영 DB: 환경이 없다.
- previous-broker v2.7.1과 v2.2.6: 지시 범위 밖이다.
- F4를 실제 host의 MCP 도구 timeout과 결합한 동작: host가 없어 확인하지 못했다.

## 가림(redaction)

같은 규칙(`redact.py`)을 적용했다. 대상은 이메일, 사용자명 경로, IP, 토큰, URL 안의 계정명이며 건수는 `meta.json`에 있다. `SHA256SUMS`는 커밋된 blob 기준이다.

## 산출물

- `audit/REPORT.md`, `audit/meta.json`, `audit/SHA256SUMS`
- `audit/logs/`: 전체 검증, 10회 반복, previous-broker, mutant, audit2(P1~P4), P4 기준선, B1·R5·R6 재실행
- `audit/tests/v274-audit2.test.ts`
- `audit/harness/`: `run-full.sh`, `mutants.py`, `redact.py`, `make-meta.sh`
