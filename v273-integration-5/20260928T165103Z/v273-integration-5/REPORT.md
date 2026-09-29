# AGS 2.7.3 통합 5단계 보고 (Windows CI 시간 초과 테스트)

지시: 총괄 ca8e3dc4. GitHub CI(run 36452333814, headSha 9a678df4)의 windows-latest에서 `tests/session-messaging/message-retention.test.ts:237` "service reports capacity rejections as definite no-effect with scope and earliest release details"가 30초 제한을 넘었다(35087ms). 원인을 확인하고, 테스트 준비 방식만 고쳤다. 제품 코드는 바꾸지 않았다. CI는 실행하지 않았다(총괄 담당).

## 판정: PASS (fast-forward push 완료)

| 대상 | SHA |
| --- | --- |
| 기준 `claude/v273-integration` | 9a678df479325e14f3f2de48f525b453490bbc56 (fetch 후 일치) |
| **`test: speed up the file-backed receipt capacity service test` (새 HEAD)** | **46859d041841fab208faa1d9b45e813de0f5e864 (tree 9003c47ca72a95db1545ce5f2610e5ba55d568f4)** |

환경: Linux cloud 컨테이너, Node.js v24.21.0, pnpm 11.19.0. Windows에서는 재현하지 않았다.

## 원인 확인

- 이 테스트는 실제 broker를 띄우고, 같은 state 디렉터리의 파일 DB(WAL)를 테스트 자신의 연결(`fixture`)로 연다. 그 연결로 `sendNew`를 약 1000번 호출한다. sender 249 + 1, 전역 750이다.
- `sendNew`는 `prepare`와 `submitPrepared`를 부르고, 둘은 각각 transaction을 commit한다. 그래서 commit이 약 2000번 일어난다.
- `SessionMessageStore`는 WAL만 켜고 `synchronous`를 설정하지 않는다(`mcp-server/src/session-message-store.ts:159-165`). WAL의 기본값 FULL에서는 commit마다 fsync가 일어난다.

측정 1: fsync 호출 수 (`strace -f -c -e trace=fsync,fdatasync`, `logs/probe/strace-*.txt`, `logs/timing/strace-*.txt`)

| 대상 | FULL(수정 전) | NORMAL(수정 후) | OFF |
| --- | --- | --- | --- |
| 채우기 1000건만(임시 probe) | 2052 | 54 | 13 |
| 대상 테스트 하나(`-t`) | 2056 | 56 | — |
| 파일 전체(16 테스트) | 3163 | 161 | — |

측정 2: 채우기 구간 시간 (임시 probe, `logs/probe/fill-timing.log`, 이 컨테이너)

| 모드 | sender 249 | 전역 750 | 합계 |
| --- | --- | --- | --- |
| `:memory:` | 255ms | 1511ms | 1766ms |
| 파일 FULL | 442ms | 1616ms | 2059ms |
| 파일 NORMAL | 293ms | 1223ms | 1516ms |
| 파일 OFF | 254ms | 1254ms | 1508ms |

해석:

- 이 컨테이너에서는 fsync 한 번이 약 30µs(총 0.07초)라 FULL의 추가 비용이 0.5초 정도다. 나머지 약 1.5초는 fsync와 무관한 CPU 비용이다. 호출마다 prune과 용량 검사 조회를 하며, 메모리 DB에서도 1.8초가 든다.
- 그래서 Linux와 총괄 PC(2106ms)에서는 통과한다. 느린 디스크의 Windows CI에서는 commit당 fsync(FlushFileBuffers)가 수 ms에서 십수 ms 걸릴 수 있다. 그러면 2000회 남짓만으로 30초에 닿는다. 예: 15ms × 2056 ≈ 31초.
- Windows CI의 fsync 시간은 이 환경에서 잴 수 없어 **추정**이다. commit당 fsync가 1번이라는 점과 그 횟수는 **직접 확인**했다.
- 따라서 원인은 commit 수 자체보다 commit마다 일어나는 fsync다. 제품 코드의 prune 비용은 원인이 아니며 이번 범위도 아니다.

## 수정 (`logs/fix.diff`)

`tests/session-messaging/message-retention.test.ts`만 바꿨다(+7, -3).

- `:33` 뒤에 `fillFixture(database)`를 추가했다. `fixture`로 연 연결에 `PRAGMA synchronous = NORMAL;`만 적용하며, 이유를 3줄 주석으로 적었다.
- 파일 DB를 대량으로 채우는 세 테스트의 채우기 연결만 `fillFixture`로 바꿨다.
  - `:179` 두 프로세스 sender 한도 경합(249건 채우기, 20초 제한)
  - `:243` 실패한 service 용량 거절 테스트(약 1000건)
  - `:359` earliestReleaseAt가 draft 만료보다 늦은 경우의 service 테스트(250건)
- 점검했지만 그대로 둔 테스트: 파일 DB를 쓰는 `:189`(ACK 경합, commit 1–3회)와 `:210`(v2.7.2 영수증 재개, commit 약 4회)은 대량 채우기가 없다. 나머지는 `:memory:` DB라 fsync가 없다.
- `synchronous`는 연결 단위 설정이다. broker 프로세스와 경합 worker 프로세스는 자기 연결을 따로 열므로 기본값 그대로 시험 대상이 된다.
- 바꾸지 않은 것: 단언, 시험 조건(sender 250, 전역 1000, 실제 broker를 거치는 service 호출), 각 테스트의 제한 시간(30초, 20초). 제한 시간 연장은 쓰지 않았다.

## 전후 시간 (Linux, 대상 테스트 `-t`, 10회, `logs/timing/before.tsv`, `after.tsv`, `*-run*.json`)

| | 10회 결과(ms) | 중앙값 |
| --- | --- | --- |
| 수정 전(9a678df4의 테스트 파일) | 2717, 2714, 2649, 2577, 2532, 2369, 2603, 2644, 2674, 2404 | **2623.5ms** |
| 수정 후 | 1777, 1777, 1751, 1719, 1697, 1675, 1672, 1682, 1701, 1737 | **1710ms** |

10회 모두 통과했다. 파일 전체 10회 반복(`logs/timing/file-10x.tsv`, `file-run*.log`)은 10/10 모두 16/16 통과했고, 소요 시간은 7.51–8.11초다.

## 전체 검증

명령별 stdout, stderr와 종료 코드는 `logs/full/`에 있다.

| # | 명령 | 종료 코드 | 결과 |
| --- | --- | --- | --- |
| 01 | `pnpm install --frozen-lockfile` | 0 | PASS |
| 02 | `pnpm bundle:check` | 0 | PASS |
| 03 | `pnpm claude:drift` | 0 | PASS (`claude-plugin: fresh`) |
| 04 | `pnpm lint` | 0 | PASS |
| 05 | `pnpm build` | 0 | PASS |
| 06 | `pnpm test` | 0 | PASS: 파일 61 통과·1 skip, 테스트 858 통과·2 skip(previous-broker, env 없을 때 skip) |
| 07 | `pnpm runtime:check` | 0 | PASS |
| 08 | `pnpm validate:all` | 0 | PASS |
| 09 | `pnpm validate:official` | 1 | FAIL_UNRELATED(환경): 이 컨테이너에 Codex validator 없음(ENOENT) |
| 10 | `pnpm claude:build` | 0 | PASS |
| 11 | `pnpm claude:check` | 0 | PASS |
| 12 | `git diff --check` | 0 | PASS |
| 13 | `pnpm source:check` | 0 | PASS |
| 14 | `pnpm source:verify` | 1 | NOT_VERIFIABLE: 삭제된 `ponytail` 원격 저장소 clone 인증 실패 1건뿐 |
| 15 | `git status --porcelain` | 0 | 출력 0 byte |

임시 probe(`tests/session-messaging/zz-probe-timing.test.ts`)는 측정 뒤 지웠고 커밋하지 않았다. 사본은 `logs/probe/`에 있다.

## NOT_RUN

- Windows 재현과 수정 후 Windows CI: 이 컨테이너에서는 할 수 없다. CI 실행은 총괄 담당이다.
- Windows CI 디스크의 fsync 한 번당 시간: 잴 수 없어 원인 설명의 이 부분은 추정이다.
- `validate:official`의 실제 검사: 이 컨테이너에 Codex validator가 없다.
- `source:verify`의 `ponytail` 원격 확인: 저장소가 삭제됐다.

## 가린 값

토큰 패턴(`ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `AKIA`, PRIVATE KEY 줄, Authorization Bearer), 이메일 주소와 IPv4 주소는 발견되지 않았다. `env`·`printenv` 출력은 남기지 않았다. 다음을 바꾼 뒤 `SHA256SUMS`를 만들었다.

| 대상 | 치환 | 파일 수 | 횟수 |
| --- | --- | --- | --- |
| 사용자 이름이 들어간 컨테이너 홈 경로 | `[REDACTED-HOME]` | 33 | 33 |
| root 계정 홈 경로 | `[REDACTED-HOME]` | 1 | 2 |
| GitHub 계정 이름(URL 소유자) | `[REDACTED-ACCOUNT]` | 1 | 1 |
