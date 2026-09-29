# AGS v2.7.4 재감사 3차 (240e0ca5 → 0135326a, F4 수정분)

- 판정 대상: `claude/v274-presence` = `0135326a921cccc7b49b0ad8b605e87893631804` (tree `7a76ffc9967ea14e0ec490b52d5414bb06277a54`)
- 이전 감사: `240e0ca5`에 대해 PASS_WITH_FINDINGS(F4 major). evidence는 `claude/evidence-v274-audit2-20260928T231921Z`(`a7fa764`)에 있다.
- 커밋: `4461abc2`(F4 수정과 테스트), `0135326a`(문서)
- writer 근거 `claude/evidence-v274-presence-fix3-20260928T232650Z`는 대조용이다. 판정은 직접 재현한 결과로만 한다.
- 읽기 전용으로 감사했다. mutant는 버리는 worktree에서만 적용하고 되돌렸다.
- 환경: Linux cloud 컨테이너 1대, Node v24.21.0, pnpm 11.19.0.

## 판정: **PASS**. 출시를 막지 않는다

F4가 해소됐다. broker가 응답하지 않으면 묶음 하나의 deadline 뒤에 멈춘다. 측정 결과 52.5초가 17.5초로 줄었다. F2의 거절 격리, 패턴 필터, broker 부재 시 전부 unknown/null 동작은 유지된다. 새 finding은 없다. 문구 하나(I-1)는 정보로만 적는다.

## 항목별 결과

| # | 항목 | 결과 |
|---|---|---|
| 1 | 범위와 생성물 | PASS |
| 2 | F4 | PASS |
| 3 | 문서 | PASS (I-1 정보) |
| 4 | 검증 | PASS |

### 1. 범위 — PASS

`git diff --stat 240e0ca5 0135326a`의 6개 파일은 다음뿐이다.

- `session-message-service.ts`: catch 분기 +3줄과 주석
- `presence-batches.test.ts`
- release notes와 lifecycle 문서
- dist `server.mjs` 2개

`bundle:check`와 `claude:check`가 통과했고, 생성 뒤 `git status`는 0 byte다.

### 2. F4 — PASS

**코드** (`session-message-service.ts:119-123`)

- `BrokerRequestRejected`이면 그 묶음만 `unanswered`로 두고 계속한다.
- 그 밖의 오류이면 `asked.slice(index)`(그 묶음과 남은 묶음)를 `unanswered`로 두고 `break`한다.

client에서 `BrokerRequestRejected`가 나오는 경로는 하나뿐이다. broker가 완결된 `{"ok":false,…}` 한 줄을 보낸 경우다(`session-message-client.ts:200`). 나머지는 모두 일반 Error다:

- 연결 오류
- 인증서 pin 불일치
- client 응답 한도 초과(`:195`)
- 잘못된 JSON
- deadline 초과

client에는 `end`/`close` 처리기가 없다. 그래서 broker가 응답 도중 끊기면 완결된 줄이 없는 상태로 deadline까지 기다린 뒤 일반 Error가 되고, 전송 실패로 분류되어 멈춘다. 거절과 전송 실패의 경계는 "완결된 거절 응답 줄이 있는가"로 일관된다.

**측정** (`logs/audit3-probes.log`, `logs/audit3-p7.log`)

| 시험 | 조건 | 240e0ca5 | 0135326a |
|---|---|---|---|
| P4 | broker SIGSTOP, 세션 9개(3묶음) | 52,514 ms | **17,503 ms**, 9개 모두 unanswered |
| P3 | broker 없음, 재시작 불가 | 3 ms, 전부 unanswered | 1 ms, 전부 unanswered |
| P5 | 다른 연결이 쓰기 잠금을 쥔 상태, 3묶음 | — | 7,614 ms, 전부 unanswered |
| P7 | 같은 잠금 상태, 30세션(10묶음) | — | **5,021 ms**, 전부 unanswered |
| P6 | 첫 조회 성공 뒤 endpoint를 연결을 끊는 TCP 서버로 바꾸고 broker는 멈춤, 6세션 | — | 15,007 ms, 0 sessions, 6 unanswered |

- P5와 P7: 잠금 상태의 단일 요청은 "The session message broker timed out."(일반 Error)였다. 그래서 전송 실패로 분류되어 첫 묶음 뒤 멈추고, 세션 수에 비례하지 않는다.
- P6: 연결 끊김은 전송 실패로 분류되어 멈춘다.

**F2 유지**

- 패턴 밖 식별자는 요청하지 않는다(writer 테스트, 감사 P2).
- 한 묶음 안에 패턴 밖 식별자가 섞여도 나머지는 `online`이다(P2).
- 거절된 묶음만 unknown이 된다. writer 테스트 "keeps successful batches when the broker refuses one batch"와 새 혼합 시험(`hang` 이전 묶음은 유지, `fail` 묶음은 거절 격리가 아니라 남은 묶음으로 unanswered)으로 확인했다.
- broker가 없으면 전부 unknown/null이다(P3).

**혼합 버전 표와의 일치**

이전 broker가 전체 목록을 돌려줘 응답 한도를 넘으면 client에서 "The broker response exceeded its limit."(일반 Error)가 난다. 그러면 첫 묶음 뒤 멈추고 전부 unanswered가 된다. previous-broker 시험(v2.7.3, v2.7.2)의 `{ sessions: [], unanswered: [target] }` 기대와 맞고, 표의 결과(전부 unknown, autoWake null)와도 같다. 표 문구는 I-1 참고.

### 3. 문서 — PASS

- **release notes**: "명시적 거절은 그 묶음만, 연결 실패·응답 없음·응답 한도 초과는 남은 묶음을 요청하지 않음"과 "최악은 첫 묶음 client deadline(측정 약 17.5초) 뒤 멈춤, 세션 수에 비례하지 않음"이 코드와 P4·P7 측정에 맞는다. 17.5초 수치는 이 감사의 P4 측정값과 같다.
- **lifecycle 문서**: "거절이 아닌 실패(연결 실패, client deadline 초과, 응답 한도 초과)가 한 번 나면 남은 묶음은 요청하지 않는다, 전체 시간은 묶음 하나의 client deadline을 넘지 않는다"가 맞다. 정확히는 앞서 성공한 묶음들의 시간(각 수 ms)이 더해진다.

### 4. 검증 — PASS

모두 `0135326a`에서 실행했다.

| 검증 | 결과 |
|---|---|
| `pnpm install --frozen-lockfile`, `bundle:check`, `claude:drift`, `lint`, `build` | 모두 0 |
| `pnpm test` | 0, 871 통과·3 skip |
| `runtime:check`, `validate:all`, `claude:build`, `claude:check`, `source:check` | 모두 0 |
| `git diff --check` | 0 (작업 트리와 `240e0ca5..0135326a` 범위) |
| `validate:official` | 1, FAIL_UNRELATED(환경: Codex validator ENOENT) |
| presence-retention과 presence-batches 10회 | 10/10 (각 13/13). 남은 임시 디렉터리 0 |
| previous-broker v2.7.3, v2.7.2 (태그 dist 파일 경로) | 3/3, 3/3 |
| mutant (`logs/mutants.tsv`) | **12/12 검출** |

로그의 "broker procs after: 3"은 세는 파이프라인이 자기 자신을 센 값이다. 직후 `ps -eo`로 0개임을 확인했다.

검출된 mutant 12개(후보 테스트 presence-retention, presence-batches, session-board 기준):

- writer: M1, M5, M7, M9
- 감사자: A1, A2, A3
- F2: F2-isolation-reverted, F2-pattern-filter-removed, F2-server-ignores-unanswered
- F4-continue-after-transport-failure: 전송 실패 뒤 계속 보냄. 2개 실패로 검출
- F4-stop-on-refusal-too: 거절에도 전체 중단. 1개 실패로 검출

## 정보

### I-1 (정보, 비차단) 혼합 버전 표의 "모든 묶음이 실패해" 문구

- 위치: release notes와 lifecycle 문서의 혼합 버전 표에서 "2.7.4 service + 이전 broker" 행.
- 이제는 첫 묶음이 응답 한도 초과로 실패하면 남은 묶음을 요청하지 않는다. 결과(모든 presence unknown, autoWake null)는 같으므로 틀린 안내는 아니다.
- 선택 사항: 다음 문서 정리 때 "첫 묶음이 실패하면 나머지는 요청하지 않아"로 맞출 수 있다.

## NOT_RUN / NOT_VERIFIABLE

- `pnpm source:verify`: 이번 범위와 무관하고 삭제된 외부 저장소 때문에 NOT_VERIFIABLE이다.
- Windows(`0135326a`)와 실제 host의 MCP 도구 timeout과의 결합: 환경이 없다. 총괄의 Windows 재검증은 진행 중이라고 들었고, 이 감사에서는 확인하지 않았다.
- previous-broker v2.7.1과 v2.2.6: 지시 범위 밖이다.

## 가림(redaction)

같은 규칙(`redact.py`)을 적용했다. 대상은 이메일, 사용자명 경로, IP, 토큰, URL 안의 계정명이며 건수는 `meta.json`에 있다. `SHA256SUMS`는 커밋된 blob 기준이다.

## 산출물

- `audit/REPORT.md`, `audit/meta.json`, `audit/SHA256SUMS`
- `audit/logs/`: 전체 검증, 10회 반복, previous-broker, mutant, P1~P7 probe
- `audit/tests/v274-audit2.test.ts`
- `audit/harness/`: `run-full.sh`, `mutants.py`, `redact.py`, `make-meta.sh`
