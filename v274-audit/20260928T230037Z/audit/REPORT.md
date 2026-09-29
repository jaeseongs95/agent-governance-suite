# AGS v2.7.4 핫픽스 독립 사전 감사 (presence 보존·현황판 묶음 조회)

- 최종 후보: `claude/v274-presence` = `0f0c192e3027525d2f12e17620c29e9e2cfd7c43` (tree `e4748a110a75a7a87509a4db14c8ff855c52ad02`)
  - 감사 본체는 `7125d7fd`(tree `5ace3e6b…`)에서 수행했다.
  - 도중에 추가된 테스트 전용 커밋 `0f0c192e`는 별도로 판정하고, 전체 검증을 그 커밋에서 다시 실행했다.
- 기준: `main` = tag `v2.7.3` = `65bdd257b749e894b3099a882996feb463ccb96d`
- 커밋: `9b0927f1`(fix), `3e4e0596`(test), `056d148b`(release), `7125d7fd`(docs), `0f0c192e`(test cleanup)
- writer 근거 `claude/evidence-v274-presence-20260928T223840Z`와 `…-fix1-20260928T224647Z`는 mutant 정의 확인과 대조용으로만 읽었다. 판정은 직접 재현한 결과로만 한다.
- 감사자는 구현에 참여하지 않았다. 읽기 전용으로 감사했으며, mutant는 버리는 worktree에서만 적용하고 되돌렸다.
- 환경: Linux cloud 컨테이너 1대, Node v24.21.0, pnpm 11.19.0.

## 판정: **PASS_WITH_FINDINGS**. 출시를 막지 않는다

결함은 고쳐졌다. 보존 정리는 live 행을 지우지 않는다. 퇴역 판정과 autoWake 상태도 정리 전후로 같다. 3개 묶음은 최악 입력에서도 32 KiB 안이다. 메시지·영수증·wake 행은 보존된다.

finding은 모두 minor 3건(F1~F3)이고 어느 것도 출시를 막지 않는다. F1과 F2는 문서 정정만으로도 충분하다.

## 항목별 결과

| # | 항목 | 결과 |
|---|---|---|
| 1 | 범위와 생성물 일치 | PASS |
| 2 | 정리 SQL | PASS (F1 문서 정확성) |
| 3 | 응답 한도 보장 | PASS |
| 4 | 비용 | PASS (F2·F3, 수용 가능) |
| 5 | 혼합 버전 표와 문서 | PASS_WITH_FINDINGS (F1, F2 문구) |
| 6 | 벤더 비종속 | PASS |
| 7 | 검증 실행 | PASS (`validate:official`은 FAIL_UNRELATED, `source:verify`는 NOT_VERIFIABLE) |
| 8 | 0f0c192e | PASS |

### 1. 범위 — PASS

`65bdd257..7125d7fd`의 22개 파일은 다음으로 나뉜다.

- 결함 수정 소스 5개: store, broker, service, protocol, server의 호출 한 줄
- 해당 dist 번들
- 버전 파일 11곳: 모두 `2.7.3`을 `2.7.4`로 바꾼 한 줄 치환이며, v2.7.3 때와 같은 파일 집합이다.
- 문서 2개와 테스트 2개

`7125d7fd..0f0c192e`는 `presence-retention.test.ts`만 바뀌었다.

`bundle:check`와 `claude:check`가 통과했다. build와 claude:build 뒤 `git status --porcelain`은 두 커밋 모두에서 0 byte였다.

### 2. 정리 SQL (`session-message-store.ts:327-334`) — PASS

직접 시험했다(`tests/v274-audit.test.ts`, `logs/audit-v274.log`, 13/13 통과).

| 시험 | 조건 | 결과 |
|---|---|---|
| R1 | 30일 전에 태어났지만 lease를 계속 갱신 중인 live 행 | 지워지지 않고 `online`이다 |
| R2 | ISO 경계 | `lease_until == now−24h`는 지워지고, 1 ms 뒤 값은 남는다. 모든 시각이 24자 고정 ISO 형식이라 문자열 비교가 안전하다 |
| R3 | 같은 `started_at`의 두 instance(하나는 종료, 하나는 live) | live 행만 남고 presence()는 같다 |
| R4 | 가장 최근 행은 끝났고 더 이른 행이 live | 최근 행과 live 행이 남는다(보호절 동작). presence()는 같다 |
| R5 | live 행 없이, 가장 최근 행이 먼저 끝나고 더 이른 행이 더 늦게 끊긴 경우 | 최근 행이 지워지면 presence()가 바뀐다: (`y-short`, `ended`) → (`x-long`, `unreachable`). autoWake 상태와 reason은 `no-live-relay`/`presence-not-online`으로 같다. F1 |
| R6 | 무작위 40회 × 15 identity | live 행은 한 번도 지워지지 않았다. online이던 presence는 600건 모두 같다(instance와 birth까지). autoWake 상태는 600/600 같다. 옛 세대 wake 행의 퇴역 결과는 정리를 막은 참조 DB(delete를 무시하는 trigger)와 600/600 같다. 반면 live 행이 없는 identity의 presence 보기는 250/600건이 바뀌었다(F1) |
| R7 | 세대 fence | 행이 모두 지워진 뒤 같은 instance가 재등록되면 새 birth > 옛 wake의 `birth_generation`이다. 옛 marker를 검증된 receipt로 보내도 `recognized:false`이고 claim은 0이며 pending이 유지된다 |
| R8 | 퇴역 | 세대 행이 지워진 옛 wake는 새 live 세대가 뜨면 정상적으로 `expired-unobserved`가 된다 |

- 늦은 marker 대조: `claimHostWake`의 valid 조건은 instance와 birth가 현재 presence와 같아야 한다. 지워진 세대는 새 birth와 같을 수 없으므로 현재 세대로 인정되지 않는다(R7). 문서가 적은 대로 시계가 24시간 넘게 되돌아가는 경우만 예외다.
- 정리 SQL은 wake 행을 건드리지 않는다. 그래서 끝난 세션의 활성 wake 행이 남는다. 알려진 한계로 문서에 있다.

### 3. 응답 한도 — PASS

**계산**: 제한 없는 문자 필드는 instanceId 128, transport 64, collaborationId 200, workspaceId 500, role 100, endReason 100으로 합계 1092자다. 제어 문자는 JSON에서 `\u0001` 같은 6 byte가 된다. 따라서 세션 하나의 상한은 대략 6552 byte에 고정 필드와 autoWake를 더한 값이다. host와 sessionId는 ASCII 패턴이라 최대 264 byte다.

**실측** (S1): 세 세션 모두 최대 길이 제어문자 필드, ended 상태, supportedInjection 5종, autoWake 포함 조건이다.

| 항목 | 값 |
|---|---|
| 세션 하나 | 7,470 B |
| 응답 전체(`{"ok":true,"data":…}\n`) | 22,447 B |
| 한도 32,768 B 대비 여유 | 10,321 B |
| 같은 조건에서 들어가는 최대 개수 | 4 |

**broker 검사** (S2): 다음 입력은 모두 명시적으로 거절된다.

- `targets`가 `[]`, 4개, 문자열, 객체일 때
- 패턴을 벗어난 identity일 때
- targets 없는 요청이 한도를 넘을 때

크기 검사는 실제 전송 envelope(`socket.end(JSON.stringify({ok:true,data}) + "\n")`)과 같은 식으로 계산한다. targets 경로와 무 targets 경로 모두 같은 검사를 통과해야 응답이 나간다.

### 4. 비용 — PASS (F2, F3)

**지연** (C1): 실제 broker, presence 행 약 1300개 DB, 3회 측정.

| 현황판 세션 N | 요청 수 | 지연(ms) |
|---|---|---|
| 40 | 14 | 93, 69, 78 |
| 100 | 34 | 188, 168, 176 |
| 300 | 100 | 452, 469, 483 |

**prune 비용** (C2): send의 `BEGIN IMMEDIATE` 안에서 잰 값이다.

| 조건 | prune 1회 | submitPrepared 1회 |
|---|---|---|
| 1300행(24h 안에 끊긴 행, live 행, 지울 행 각각) | 0.2~0.5 ms | 0.5~1.2 ms |
| 13,000행, 24h 안에 끊긴 행(지우지 않음) | 약 1 ms | 약 2 ms |
| 13,000행을 처음 지울 때 | 41 ms, 1회 | — |

잠금 시간이 늘어나는 정도는 무시할 수 있다.

**deadline**: `sessionMessageRequest`는 묶음마다 20초 total deadline을 따로 건다. 시도당 2.5초이고, 실패하면 broker를 확인한 뒤 1회 재시도한다. 여러 묶음을 합친 전체 deadline은 없다. 첫 실패에서 즉시 전체 실패를 반환하므로 오래 막히는 경우는 "각 요청이 느리지만 성공하는" 경우뿐이다.

**판정**: 지금 수치(N=300에서 0.5초)는 받아들일 만하다. 다만 묶음을 크기로 채우면 요청 수를 크게 줄일 수 있다(F3).

### 5. 혼합 버전 표와 문서 — PASS_WITH_FINDINGS

**설치 뒤 첫 정리** (`logs/install-first-prune.txt`): v2.7.3 코드로 운영 DB와 비슷한 DB(presence 1459행, 메시지 15, 영수증 15, 옛 세대 wake 5)를 만들었다. 같은 시각에 v2.7.3 prune과 v2.7.4 prune을 각각 사본에 실행했다. 두 결과의 차이는 `session_presence` 하나뿐이다(1459행 → 0행). messages, prepared_messages, wake_nonces, session_activity 등의 digest와 `integrity_check`는 같다. "메시지·영수증·wake 행은 보존" 문장이 맞다.

**2.7.4 service + 이전 broker**: previous-broker v2.7.3(`b30977b5…`)과 v2.7.2(`fbb808e0…`)가 3/3 통과했다. 작은 DB에서는 정상이고, 한도를 넘으면 `exceeded its limit`로 unknown이 된다. 문서 표와 맞다.

**2.7.3 이하 service + 2.7.4 broker**: targets 없는 요청이 한도를 넘으면 명시적으로 거절된다(S2). 이전 service가 그 실패를 전부 unknown으로 채우는 것은 2.7.3 코드 동작 그대로다. 표와 맞다.

**문서 불일치**:
- F1: "presence 조회 … 정리 전후 결과가 같다"는 과장이다.
- F2: 묶음 실패의 영구적인 경우가 적혀 있지 않다.

### 6. 벤더 비종속 — PASS

`git diff -U0`의 추가 줄에서 store, broker, service, protocol, server에 codex, claude, openai, anthropic 문자열은 0건이다.

### 7. 검증 실행 — PASS

전체 순서를 `7125d7fd`(`logs/full-*`)와 `0f0c192e`(`logs0f/full-*`)에서 실행했다. 결과는 두 번 모두 같다.

| 명령 | 종료 코드 |
|---|---|
| `pnpm install --frozen-lockfile` | 0 |
| `pnpm bundle:check` | 0 |
| `pnpm claude:drift` | 0 |
| `pnpm lint` | 0 |
| `pnpm build` | 0 |
| `pnpm test` | 0 (866 통과·3 skip) |
| `pnpm runtime:check` | 0 |
| `pnpm validate:all` | 0 |
| `pnpm validate:official` | 1, FAIL_UNRELATED(환경: Codex validator ENOENT) |
| `pnpm claude:build` | 0 |
| `pnpm claude:check` | 0 |
| `git diff --check` | 0 (작업 트리와 커밋 범위 모두) |
| `pnpm source:check` | 0 |
| `pnpm source:verify` | 1, **NOT_VERIFIABLE**: 삭제된 외부 스킬 저장소(ponytail) clone 실패. 차단 사유가 아니다 |

추가 검증:

- `presence-retention.test.ts` 10회 반복: `7125d7fd`와 `0f0c192e` 모두 10/10 통과(각 8/8).
- mutant (`logs/mutants-7125d7f.tsv`, `logs0f/mutants.tsv`, 후보 테스트는 presence-retention과 session-board). 두 커밋 모두 **8/8 검출**이다.
  - writer mutant: M1, M2, M5, M7, M9는 writer 스크립트와 같은 치환이다.
  - 감사자 mutant 3개:
    - A1: 최신 행 대신 가장 오래된 행을 보호
    - A2: 끊긴 행도 live로 간주
    - A3: 마지막 부분 묶음을 누락
- previous-broker는 v2.7.3과 v2.7.2 태그 dist의 파일 경로로 실행했다. 두 커밋 모두 3/3 통과했다.

### 8. 0f0c192e (테스트 cleanup) — PASS

- 범위: `presence-retention.test.ts` +6 −3뿐이다.
  - afterEach를 async로 바꾸고 cleanup을 역순으로 await한다.
  - 반증 시험의 broker cleanup을 `exitCode`와 `signalCode` 확인 뒤 `once(child, "exit")`까지 기다리도록 바꿨다.
  - 단언, fixture, 시험 순서는 바뀌지 않았다.
  - 역순 실행이므로 broker가 끝나고 store가 닫힌 뒤에 디렉터리가 지워진다.
- 같은 파일의 다른 자식 프로세스: `:231`의 경합 시험 두 프로세스는 본문에서 이미 `once(child, "exit")`를 await한다(`:233`). 남은 문제는 없다.
- 반복 10회 뒤 남은 `ags-presence-retention-*` 임시 디렉터리는 0개이고, 남은 broker 프로세스도 0개다(`ps`로 확인). 로그의 "orphan brokers: 1"은 pgrep이 자기 셸을 센 값이라 정정해 기록했다.

## Findings

### F1 (minor, 문서 정확성, 비차단) "정리 전후 presence 조회 결과가 같다"는 live 행이 없는 세션에는 성립하지 않는다

- 위치:
  - `docs/release-notes-v2.7.4.md` 둘째 문단의 "presence 조회, 미관측 알림 퇴역 규칙과 `autoWake` 판정은 정리 전후에 같습니다"
  - `docs/session-message-lifecycle.md` presence 보존 절의 "모두 이 가장 최근 행만 읽으므로 정리 전후 결과가 같다"
  - `session-message-store.ts:327-328`의 주석
- 재현:
  - R5: 최근 행(짧게 살고 먼저 끝남)이 지워지면 더 이른 행(오래 살다 나중에 끊김)이 최신이 된다. presence가 `ended`/`y-short`에서 `unreachable`/`x-long`으로 바뀌고 autoWake의 basisAt도 바뀐다.
  - R6: 무작위 600건 중 250건에서 live 행이 없는 identity의 presence 보기가 바뀌었다.
- 영향:
  - online 세션, autoWake **상태**, 퇴역 결과는 바뀌지 않는다(R6에서 모두 같음).
  - 현황판에 보이는 instance, 상태(ended/unreachable), 기준 시각은 바뀔 수 있다.
  - 수동 `reconcile-wake-observation`의 옛 세대 판정(`isOldGeneration`)은 presence 최신 행을 기준으로 하므로 드물게 결과가 달라질 수 있다.
- 권장: 문구를 "live 세션의 presence, 퇴역 판정과 autoWake 상태는 같다. live 행이 없는 세션은 표시되는 instance·상태·기준 시각이 바뀌거나 unknown이 될 수 있다"로 고친다. 코드를 바꿀 필요는 없다.

### F2 (minor, 견고성, 비차단) 묶음 하나의 실패가 현황판 전체를 unknown으로 만든다. 식별자가 패턴 밖이면 영구적이다

- 위치: `session-message-service.ts:102-117`의 루프 전체가 한 try이고, 한 번 실패하면 `failure`로 끝난다.
- 재현: B1. 정상 세션 6개만 요청하면 `ok:true`다. 여기에 `sessionId: "has space"` 하나를 더하면 `ok:false`이고 오류는 "host and sessionId must use bounded identifier characters."다.
  - 현황판(`board-store.mjs`)은 hook의 `session_id`를 검증 없이 저장한다. broker는 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$`만 받는다.
  - 그런 세션이 현황판에 하나라도 있는 동안에는 모든 presence가 unknown이다.
  - 2.7.3에서는 그런 세션이 broker 목록에 없을 뿐, 다른 세션 표시를 막지 않았다.
- 영향: 실제 host의 session id는 UUID 형태라 발생 가능성은 낮다. release notes는 "요청 하나라도 실패하면 … unknown"이라고 일반적으로만 적었고, 영구적인 경우는 적지 않았다.
- 권장(후속 패치로 가능): service에서 broker 패턴에 맞지 않는 identity는 요청하지 않고 unknown으로 둔다. 묶음별로 실패를 격리해 그 묶음만 unknown으로 채운다.

### F3 (minor, 비용, 비차단) 고정 3개 묶음과 전체 deadline 부재

- 요청 수는 ceil(N/3)이고, 요청마다 TLS 연결과 prune이 돈다. N=300에서 100회, 약 0.47초다(로컬).
- 여러 묶음에 걸친 전체 deadline이 없다. broker가 요청마다 느리게라도 성공하면 MCP 호출이 N/3배로 길어진다.
- 최악 크기에서도 4개까지는 들어간다(S1). 보통 세션은 약 0.6 KB라 크기로 채우면 요청 수를 10배 이상 줄일 수 있다.
- 권장(후속): 응답 크기 예산으로 묶음을 채우거나 broker가 잘라서 돌려주게 하고, 전체 deadline을 둔다. 지금 수치로는 출시를 막을 이유가 없다.

## NOT_RUN / NOT_VERIFIABLE

- `pnpm source:verify`: NOT_VERIFIABLE. 삭제된 외부 스킬 저장소 때문이다.
- `pnpm validate:official`: FAIL_UNRELATED(환경).
- Windows 실행: 이 환경에 없다. 총괄 보고와 writer fix1 근거는 확인하지 않았고 대조만 했다.
- 실제 PC 운영 DB 사본(214 KB 응답) 재현: 운영 DB가 없다. 비슷한 합성 DB(1300~1459행)로 대신했다.
- previous-broker v2.7.1과 v2.2.6: 지시 범위가 v2.7.3과 v2.7.2라 실행하지 않았다. 이전 감사에서 통과한 기록이 있다.
- 실제 host의 현황판 표시와 설치 캐시: 환경이 없다.

## 가림(redaction)

이전 감사와 같은 `redact.py` 규칙을 적용했고 건수는 `meta.json`에 있다. 대상은 이메일, 사용자명 경로, IP, 토큰이다. 계정명이 든 URL은 로그에 옮기지 않았다. `source-verify` 로그에 들어 있던 외부 저장소 URL의 계정명도 가렸다. `SHA256SUMS`는 커밋된 blob 기준으로 만들었고, push 전에 `git archive`로 검증했다.

## 산출물

- `audit/REPORT.md`, `audit/meta.json`, `audit/SHA256SUMS`
- `audit/logs/` (`7125d7fd`): 전체 검증, 감사 테스트, mutant, previous-broker, 반복, 설치 첫 정리
- `audit/logs0f/` (`0f0c192e`): 전체 검증, 반복, mutant, previous-broker
- `audit/tests/v274-audit.test.ts`
- `audit/harness/`: `run-full.sh`, `run-full-0f.sh`, `mutants.py`, `make-v273-db.ts`, `prune.ts`, `snap.mjs`, `redact.py`, `make-meta.sh`
