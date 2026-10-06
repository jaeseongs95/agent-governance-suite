# 7단계 `pnpm test` FAIL/SKIP 목록

- 실행: 1회, seq 07, 2026-10-06T03:40:13.090Z → 03:41:33.707Z, exit 0
- argv: `pnpm test --reporter=verbose --reporter=json --outputFile.json=<E>/07-vitest-results.json`
  - reporter 인수는 실패·SKIP 전체 이름을 재실행 없이 남기려고 붙였다. 검사 대상·설정은 바꾸지 않았다.
  - `test` script는 `node scripts/build.mjs && vitest run`이므로 build도 다시 실행됐다. 실행 뒤 dirty 0.
- 원시 자료: `07-pnpm-test.log`, `07-vitest-results.json`

## 총계(vitest 관측값)

| 항목 | 값 |
| --- | --- |
| Test Files | 67 passed / 1 skipped (68) |
| Tests | **914 PASS / 0 FAIL / 5 SKIP** (919) |
| Suites (JSON) | 144 total / 144 passed |
| verbose `✓` 줄 수 | 914 |

기존 Linux 결과 911 PASS / 3 FAIL / 5 SKIP과 비교한 사실만 적는다. 이번 Cloud 실행은 PASS가 3건 많고 FAIL이 0건이다(919 = 919). 기존 3 FAIL의 테스트 이름이 이 세션에 전달되지 않아 어떤 3건이 통과로 바뀌었는지는 대조할 수 없다(unknown). 원인도 확인하지 않았으므로 해결됐다고 판단하지 않는다. 이번 환경과 다른 점은 Node v24.21.0, Python 3.13.16, Cloud Linux 컨테이너, 격리된 XDG/TMP/shared-state 경로, 그리고 `CLAUDE_CODE_MESSAGING_SOCKET/TOKEN` 제거다(`environment.json` 참고).

## FAIL

없음(0건).

## SKIP (5건, 전체 이름)

같은 파일 `tests/session-messaging/previous-broker.test.ts`에 있는 5건이다. vitest JSON의 `location`은 null이어서 원본 소스의 줄 번호를 대신 적었다. 모두 `it.skipIf(!previousBroker)`로 건너뛰었고, `previousBroker = process.env.AGS_PREVIOUS_BROKER_PATH`(16행)는 이번 실행에서 설정하지 않았다. 건너뛴 테스트라 메시지 첫 줄은 없다.

| # | 위치 | 전체 이름 |
| --- | --- | --- |
| 1 | `tests/session-messaging/previous-broker.test.ts:27` | preserves queued messages when new hooks meet the previous released broker |
| 2 | `tests/session-messaging/previous-broker.test.ts:110` | lets the previous released broker serve a schema 1 database with a retired wake |
| 3 | `tests/session-messaging/previous-broker.test.ts:187` | gives the new batched presence request a defined result from a previous broker |
| 4 | `tests/session-messaging/previous-broker.test.ts:237` | leaves a previous broker's latch of an ended birth for the new broker to retire, or finds it retired |
| 5 | `tests/session-messaging/previous-broker.test.ts:303` | reads a previous broker's Korean claim answer at the response limit whole, and meets its own request reader |

로그 위치: `07-pnpm-test.log` 514~518행(`↓` 표시).
