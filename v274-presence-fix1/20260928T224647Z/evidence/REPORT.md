# AGS 2.7.4 테스트 정리 수정 (fix1)

- 수정 전: `claude/v274-presence` = `7125d7fdffb7f4574f216a3a2867132a13f6e810`
- 새 commit: `0f0c192e3027525d2f12e17620c29e9e2cfd7c43` (tree `e4748a110a75a7a87509a4db14c8ff855c52ad02`). non-force fast-forward push(`7125d7f..0f0c192`)였고, `git ls-remote`로 확인했다.
- 바꾼 파일: `tests/session-messaging/presence-retention.test.ts` 하나(+6/-3, `logs/change.diff`). 제품 코드, 문서, 버전은 바꾸지 않았다.

## 원인과 수정

총괄이 Windows 11에서 보고한 실패다. 큰 DB 시험(`serves board presence from a 342-identity, 1302-row database through a real broker`)은 정리 단계에서 broker에 `SIGTERM`만 보내고, broker가 끝나기를 기다리지 않은 채 곧바로 상태 디렉터리를 지웠다. Windows에서는 아직 살아 있는 broker가 SQLite 파일을 잡고 있어 `rmSync`가 EPERM으로 실패했다. Linux는 열린 파일도 지울 수 있어 드러나지 않았다.

- broker 정리는 저장소 관례(`message-lifecycle.test.ts`, `message-retention.test.ts`)를 따른다. `exitCode`와 `signalCode`가 모두 null이면 `once(child, "exit")`를 잡고 `kill()`한 뒤 종료를 기다린다.
- `afterEach`는 async로 바꿔 정리 작업을 역순으로 하나씩 `await`한다. 등록 순서가 디렉터리, 그다음 store·broker이므로 broker 종료와 store close가 디렉터리 삭제보다 먼저 일어난다.
- 경합 시험(두 자식 process)은 assertion 전에 두 process의 `exit`를 `await`하고, 그 뒤에 여는 store는 정리에서 디렉터리보다 먼저 닫힌다. 같은 문제는 없어 고치지 않았다.
- `previous-broker.test.ts`에 추가한 시험은 이미 `finally`에서 같은 관례로 종료를 기다린 뒤 `rm`한다. 역시 고치지 않았다.

## 검증 (`logs/summary.tsv`)

| 검증 | 결과 |
|---|---|
| `presence-retention.test.ts` 10회 반복 | 10/10 통과, 매회 8/8 (`logs/repeat-01..10.log`) |
| `pnpm test` | 종료 코드 0, 파일 62 통과·1 skip, 테스트 866 통과·3 skip |
| `pnpm lint` | 0 |
| `git diff --check` | 0 |
| previous-broker v2.7.3 (`AGS_PREVIOUS_BROKER_PATH`=v2.7.3 dist broker) | 3/3 통과 |
| 남은 broker process | 0개 (`logs/leftover-brokers.txt`) |
| 남은 임시 디렉터리 `ags-presence-retention-*` | 0개 |

## NOT_RUN

- Windows 재현과 재검증: NOT_RUN. 이 환경은 Linux 컨테이너라 EPERM이 나지 않는다. Linux의 통과는 Windows 통과를 증명하지 않으므로, Windows에서 다시 확인해야 한다.
- 전체 검증 순서의 나머지 명령: 요청 범위(10회 반복, `pnpm test`, lint, `git diff --check`, previous-broker v2.7.3)만 실행했다. 제품 코드와 생성물은 바뀌지 않았다.

## 가림(redaction)

지난번과 같은 규칙(토큰·키·Bearer·이메일·사용자 홈 경로·root 홈 경로·IPv4)으로 evidence의 모든 텍스트 파일을 검사했다. 건수는 `meta.json`에 있다. `SHA256SUMS`는 커밋된 blob 기준으로 만들었다.
