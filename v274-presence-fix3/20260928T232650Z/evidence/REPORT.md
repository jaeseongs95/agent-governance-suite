# AGS 2.7.4 재감사 후속 수정 (fix3: F4)

- 기준: `claude/v274-presence` = `240e0ca5c22302f689a22c27d3ed34e1151a8ce4`
- 재감사: `claude/evidence-v274-audit2-20260928T231921Z` `audit/REPORT.md`의 F4 절과 P4를 읽고 반영했다.
- 새 commit: `0135326a921cccc7b49b0ad8b605e87893631804`, tree `7a76ffc9967ea14e0ec490b52d5414bb06277a54`
  - `4461abc` fix: stop board presence batches after a transport failure
  - `0135326` docs: describe the unresponsive-broker worst case for board presence
- push: non-force fast-forward(`240e0ca..0135326`). `git ls-remote`로 확인했다.
- 최종 tree는 전체 검증을 돌린 작업 트리의 tree와 같다. 중간 fix commit에서도 `check-bundle`과 `claude:check`가 fresh였다(`logs/fix-commit-freshness.log`).
- 버전은 바꾸지 않았다. Skill `agent-governance-suite:ponytail`은 이 세션에 등록되어 있지 않다. 앞서 읽은 `skills/ponytail/SKILL.md`의 지침을 따랐다.

## 설계

`session-message-service.ts:118-124`: 묶음 실패가 `BrokerRequestRejected`(broker의 명시적 거절)이면 지금처럼 그 묶음만 `unanswered`로 두고 계속한다. 그 밖의 실패(연결 실패, client deadline 초과, 응답 한도 초과)는 broker가 답하지 않는다는 뜻이다. 이때는 그 묶음과 남은 묶음을 모두 `unanswered`로 두고 멈춘다.

- 최악 시간은 묶음 하나의 기존 client deadline이다. 0f0c192e의 동작(17.5초)과 같고, 세션 수에 비례하지 않는다.
- 전체 deadline 방식을 택하지 않은 이유: 남은 시간을 묶음마다 나눠 `sessionMessageRequest`에 넘기는 코드가 필요하다. 그래도 응답 없는 broker에는 결국 같은 시간을 쓴다. 한 줄 분기가 더 단순하고 결과가 같다.
- 바뀌지 않은 것: broker가 없을 때의 결과(전부 `unknown`/`null`), 패턴 밖 식별자와 거절된 묶음만 `unknown`인 F2 동작, 공개 도구 schema.
- 이전 broker와 큰 DB 조합은 첫 묶음의 응답 한도 초과(전송 실패)에서 멈춘다. 결과는 전과 같이 전부 `unknown`/`null`이고 더 빨리 끝난다.

## 수정 전 실패 (`logs/before-fix-240e0ca.log`, exit 1)

`presence-batches.test.ts`에 추가한 시험 두 개가 240e0ca 코드에서 실패했다.

- "stops after a transport failure …": 응답하지 않는 stub(묶음마다 stub deadline 400 ms 뒤 전송 오류)에서 요청 1회를 기대했으나 3회였다. 전체 1208 ms로, stub deadline의 3배였다.
- "keeps earlier answers … after a transport failure": 요청 2회를 기대했으나 3회였다.

수정 뒤에는 둘 다 통과했다. 거절 격리 시험은 유지하고, stub이 `BrokerRequestRejected`를 던지게 맞췄다.

P4 같은 시험은 stub으로 했다. 제품 deadline은 바꾸지 않았다. stub이 client의 deadline 뒤 전송 오류를 흉내 낸다. SIGSTOP은 쓰지 않았고 자식 process도 없다. 그래서 Windows에서도 돈다.

## mutant (`logs/mutants.tsv`)

시험 대상: presence-retention, presence-batches, session-board.

| mutant | 결과 | 잡은 시험 |
|---|---|---|
| BASELINE | PASS | |
| F4a 전송 실패 뒤에도 계속 요청 | KILLED | 전송 실패 멈춤 시험 2개 |
| F4b 거절도 전체 중단 | KILLED | 거절 격리 시험 |
| M1, M5, M7, M9 | KILLED | |
| A1, A2, A3 | KILLED | |
| F2-isolation-reverted, F2-pattern-filter-removed, F2-server-ignores-unanswered | KILLED | |

감사 mutant 10종과 새 mutant 2종, 모두 12/12가 잡혔다. 치환식은 새 코드 위치에 맞췄다.

## 검증

| 명령 | 종료 코드 |
|---|---|
| install, bundle:check, claude:drift(fresh), lint, build | 모두 0 |
| test | 0 (871 통과·3 skip) |
| runtime:check, validate:all | 0 |
| validate:official | 1, FAIL_UNRELATED(환경: Codex validator ENOENT) |
| claude:build, claude:check(fresh), source:check, git diff --check | 0 |
| source:verify | 1, NOT_VERIFIABLE(삭제된 외부 저장소 `ponytail`) |

추가 검증:

- presence-retention과 presence-batches 10회 반복: 10/10 통과, 매회 13/13. 끝난 뒤 남은 임시 디렉터리 0개, broker process 0개.
- previous-broker: v2.7.3 3/3, v2.7.2 3/3.

## 문서

바꾼 문구 전문은 `logs/wording.diff`에 있다.

- release notes 셋째 문단: 거절된 묶음만 격리한다. 거절이 아닌 실패에서는 남은 묶음을 요청하지 않는다.
- release notes 알려진 한계: 최악의 경우를 적었다. 살아 있지만 응답하지 않는 broker에서는 첫 묶음의 client deadline(측정 약 17.5초) 뒤에 멈추고, 세션 수에 비례하지 않는다.
- lifecycle 문서 조회 절: 같은 규칙을 적었다.

## NOT_RUN

- 실제로 멈춘 broker(P4 원형) 재현: SIGSTOP은 Windows에 없어 stub으로 대신했다. 실제 client deadline(약 17.5초) 경로는 재감사 P4 기준선(0f0c192e, 17,506 ms)과 같은 구조다.
- Windows 재검증: 이 환경은 Linux다.
- 실제 host의 MCP 도구 timeout과 결합한 동작, 설치 캐시: 환경이 없다.

## 가림

같은 규칙으로 가렸다. 건수는 `meta.json`에 있다. `SHA256SUMS`는 커밋된 blob 기준이다.
