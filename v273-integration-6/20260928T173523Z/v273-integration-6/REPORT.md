# AGS 2.7.3 통합 6단계 보고 (파일 DB 대량 채우기 테스트의 fsync)

지시: 총괄 ca8e3dc4. CI run 36454035194(headSha 46859d04)의 windows-latest에서 `tests/session-messaging/wake-lifecycle.test.mjs` 테스트 4개가 30초 제한을 넘었다. 원인을 직접 확인하고, 2.7.3 wake 변경이 원인인지 판정한 뒤, 테스트 준비 방식만 고쳤다. 제품 코드는 바꾸지 않았다. CI는 실행하지 않았다.

## 판정: PASS (fast-forward push 완료)

| 대상 | SHA |
| --- | --- |
| 기준 `claude/v273-integration` | 46859d041841fab208faa1d9b45e813de0f5e864 (fetch 후 일치) |
| **`test: avoid per-commit fsync in bulk-filled file DB tests` (새 HEAD)** | **e3220a48ce0f1aaea30f90db4bbb597b8fd7ea92 (tree 2934992daa71fa2b24af7f58bd95454ea59d46c2)** |

환경: Linux cloud 컨테이너, Node.js v24.21.0, pnpm 11.19.0. Windows에서는 재현하지 않았다.

## 1. 원인 확인

네 테스트는 모두 `fixture()`가 만든 WAL 파일 DB에 대해 시험 대상 `f.store.database`로 raw `INSERT INTO wake_nonces`를 autocommit으로 1000–1005번 실행한다. 그다음 같은 store의 `prune`이나 `reserveManagedWake`를 시험한다. `SessionMessageStore`는 `synchronous`를 설정하지 않으므로 WAL 기본값 FULL에서 commit마다 fsync가 일어난다.

### v2.7.2(8763cef2) 대 46859d04 비교

테스트 하나씩 `-t`로 실행했다. fsync 수는 `strace -f -c -e trace=fsync,fdatasync`의 calls 열이고, 시간은 10회 중앙값이다. 근거: `logs/compare/`(1회 측정), `logs/timing/summary.tsv`(10회 측정).

| 테스트(줄) | fsync v2.7.2 | fsync 46859d04 | 중앙값 v2.7.2 | 중앙값 46859d04 |
| --- | --- | --- | --- | --- |
| terminal pruning cannot erase an outstanding old-generation backoff (:268) | 1040 | 1040 | 230ms | 238.5ms |
| outstanding terminal backoffs share the active wake budget … (:282) | 1028 | 1028 | 211.5ms | 243.5ms |
| W05-r2 active budget overflow is an explicit rejection … (:507) | 1027 | 1027 | 196.5ms | 208ms |
| W05-r2 terminal observation retention is bounded … (:515) | 1031 | 1031 | 227ms | 240.5ms |

판정:

- **commit(fsync) 수는 v2.7.2와 46859d04에서 완전히 같다.** 이 테스트 파일도 main 이후 바뀌지 않았다. 2.7.3 wake 변경(퇴역 검사, prune 경로)은 이 테스트들의 commit 수를 늘리지 않았다.
- Linux 시간 중앙값은 46859d04가 10–32ms(약 4–15%) 느리다. 호출당 CPU 비용이 조금 늘었을 수 있다. 예를 들어 `prune`에 더해진 퇴역 UPDATE가 있다. 다만 10회 표본의 편차(예: v2.7.2 :268의 한 회가 799ms)와 비슷한 크기라 분리해 확정하지 못했다.
- 어느 쪽이든 30초 초과를 설명하는 크기가 아니다. 제품 성능 회귀로 판단하지 않는다.
- Windows CI에서 v2.7.2도 6–20초가 걸렸고 러너마다 두세 배씩 흔들렸다. commit마다 fsync(FlushFileBuffers)가 1000번 남짓 일어나는 구조가 원인이라고 판단한다. Windows의 fsync 한 번당 시간은 이 환경에서 잴 수 없어 그 부분은 **추정**이다.

## 2. 전수 점검 (`logs/sweep/files.tsv`, `logs/pertest/*.fsync.tsv`)

1. `git ls-files 'tests/**/*.test.*'`의 테스트 파일 전부를 파일 단위로 strace했다(fsync+fdatasync 수).
2. 상위 6개 파일(파일 합계 855회 이상)은 테스트 298개를 하나씩 따로 실행해 셌다. 298개 모두 "1 passed"로 실행됐음을 확인했다.

첫 파일별 pass에서는 `wake-liveness.test.mjs`가 rc=1이었다. 아래 관찰 절에 적었다.

| 파일 | 파일 합계 fsync | 가장 많은 테스트(fsync) | 조치 |
| --- | --- | --- | --- |
| `session-messaging/wake-lifecycle.test.mjs` | 5833 | 대상 4개(1027–1040). 다음은 190 | 대상 4개 수정 |
| `session-messaging/historical-wake.test.mjs` | 2473 | 최대 약 70 | 없음(대량 채우기 없음) |
| `context-continuity/schema-compat.test.ts` | 1399 | 최대 120 | 없음 |
| `mcp/convergence-guard.test.ts` | 1190 | 수십 이하 | 없음 |
| `session-messaging/wake-liveness.test.mjs` | 1168 | 최대 102 | 없음 |
| `session-messaging/session-message.test.ts` | 855 | 215(packaged hook의 빈 wake 차단) | 없음. fsync는 시험 대상인 broker·hook 프로세스가 쓴 것이며 채우기가 아니다 |
| 나머지 파일 | 423 이하 | — | 없음 |

- 대상 4개 외에 commit이 수백 번 이상인 채우기 테스트는 없다.
- 총괄이 준 Windows 시간에서 5초를 넘은 것도 이 4개다(v2.7.2 6.4–17.6초).
- `message-retention.test.ts`는 5단계에서 고쳤으며 파일 합계는 161이다.

"채우기 연결과 시험 대상 연결이 같아 분리할 수 없는" 테스트는 없었다. 대상 4개는 원래 시험 대상 연결로 채웠지만, 행 삽입은 같은 파일을 여는 별도 연결로 옮길 수 있었다.

### 첫 점검의 측정 오류(기록)

첫 테스트별 pass(`logs/pertest/invalid-first-pass/`)는 무효다. 두 가지 오류가 있었다.

- strace 합계 줄에서 calls 대신 `usecs/call` 열을 읽었다.
- describe 이름이 붙은 파일에서 `-t ^전체이름$`가 맞지 않아 테스트가 skip됐다.

두 오류를 고친 스크립트(`logs/pertest.mjs`)로 다시 셌다. 표는 다시 센 값이다.

### 작업 중 사고(기록)

점검 중 `vitest list --json <파일들>`을 실행했다. 이 명령은 `--json` 뒤의 첫 인자(`wake-lifecycle.test.mjs`)를 출력 파일로 받아 그 테스트 파일을 목록 JSON으로 덮어썼다. 커밋되지 않은 다른 변경이 없음을 확인하고 `git checkout`으로 되돌렸다. blob이 HEAD와 같음(`8a0617b2`)을 확인했다. v2.7.2 비교와 파일별 sweep은 덮어쓰기 전에 끝났으므로 결과에 영향이 없다. 커밋에는 들어가지 않았다.

## 3. 수정 (`logs/fix.diff`, `tests/session-messaging/wake-lifecycle.test.mjs`만, +19 −8)

- `:40-50`에 `fillRows(f, sql, count, values)`를 추가했다.
  - 같은 DB 파일에 별도 `DatabaseSync` 채우기 연결을 열고 `PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;`을 적용한다.
  - 그 연결로 행을 넣은 뒤 `finally`에서 닫는다.
  - 이유는 3줄 주석으로 적었다.
- 네 테스트(`:284`, `:295`, `:520`, `:528`)의 `f.store.database.prepare(INSERT…)` + 반복문을 `fillRows(...)`로 바꿨다. SQL, 행 수, 값은 그대로다.
- 시험 대상 `SessionMessageStore` 연결은 설정과 transaction 흐름이 바뀌지 않는다. `synchronous`는 연결 단위이고, 채우기 연결은 store가 행을 읽기 전에 닫힌다. WAL에서 commit된 행은 store의 다음 문장에 보인다.
- 여러 파일에서 쓸 공용 helper가 필요하지 않아 새 파일은 만들지 않았다.
- 단언, 행 수, 시험 조건, 제한 시간, 제품 코드는 바꾸지 않았다.

## 4. 전후 결과 (Linux, 테스트별 10회, `logs/timing/`)

| 테스트 | fsync 전 → 후 | 중앙값 전 → 후 |
| --- | --- | --- |
| :268 terminal pruning … | 1040 → 36 | 238.5 → 71ms |
| :282 outstanding terminal backoffs … | 1028 → 29 | 243.5 → 65ms |
| :507 active budget overflow … | 1027 → 28 | 208 → 69.5ms |
| :515 terminal observation retention … | 1031 → 27 | 240.5 → 58.5ms |

- 40회 모두 통과했다.
- 파일 전체 fsync는 5833에서 1823으로 줄었다.
- 파일 전체 10회 반복(`file-10x.tsv`)은 10/10 모두 51/51 통과했고, 소요 시간은 4.03–4.41초다.

## 5. 전체 검증 (`logs/full/`)

| # | 명령 | 종료 코드 | 결과 |
| --- | --- | --- | --- |
| 01 | `pnpm install --frozen-lockfile` | 0 | PASS |
| 02 | `pnpm bundle:check` | 0 | PASS |
| 03 | `pnpm claude:drift` | 0 | PASS (`claude-plugin: fresh`) |
| 04 | `pnpm lint` | 0 | PASS |
| 05 | `pnpm build` | 0 | PASS |
| 06 | `pnpm test` | 0 | PASS: 파일 61 통과·1 skip, 테스트 858 통과·2 skip(previous-broker) |
| 07 | `pnpm runtime:check` | 0 | PASS |
| 08 | `pnpm validate:all` | 0 | PASS |
| 09 | `pnpm validate:official` | 1 | FAIL_UNRELATED(환경): 이 컨테이너에 Codex validator 없음 |
| 10 | `pnpm claude:build` | 0 | PASS |
| 11 | `pnpm claude:check` | 0 | PASS |
| 12 | `git diff --check` | 0 | PASS |
| 13 | `pnpm source:check` | 0 | PASS |
| 14 | `pnpm source:verify` | 1 | NOT_VERIFIABLE: 삭제된 `ponytail` 원격 저장소 1건뿐 |
| 15 | `git status --porcelain` | 0 | 출력 0 byte |

## 관찰: 이관 경합 테스트의 `database is locked` (제품 코드, 고치지 않음)

- **재현 내용**: 파일별 strace sweep 1회에서 `wake-liveness.test.mjs`의 "G: two independent processes racing the v2.7.2 upgrade both open one migrated schema"가 실패했다(`logs/sweep/tests_session-messaging_wake-liveness.test.mjs.log`). worker가 `mcp-server/src/session-message-store.ts:165`(`PRAGMA journal_mode = WAL`)에서 `Error: database is locked`로 끝났다.
- **재시도 결과**: 같은 테스트를 strace 아래 8회, strace 없이 8회 다시 돌렸고 16/16 통과했다(`logs/lock-observation/`). 전체 `pnpm test`와 파일 10회 반복에서도 재현되지 않았다.
- **의미**: 이 테스트는 2.7.3 wake 후보가 더한 v2.7.2→v1 이관 경합 테스트다. 두 프로세스가 같은 DB를 거의 동시에 처음 열 때 journal mode 전환이 드물게 busy 오류를 낼 수 있다는 뜻이다. SQLite는 journal mode 변경에서 busy handler를 항상 쓰지는 않는 것으로 알려져 있으나, 이 환경에서 따로 확인하지 않았다.
- **판단**: 실제 설치에서 broker와 CLI가 업그레이드 직후 동시에 DB를 여는 경우에도 같은 일이 생길 수 있다. 느린 Windows 러너에서는 빈도가 더 높을 수 있다. 제품 코드이므로 고치지 않았고, 총괄 판단을 위해 기록한다.

## NOT_RUN

- Windows 재현과 수정 후 Windows CI: 이 컨테이너에서는 할 수 없다. CI 실행은 총괄 담당이다.
- Windows의 fsync 한 번당 시간: 잴 수 없어 원인 설명의 이 부분은 추정이다.
- Windows CI 로그 원문: gh를 쓸 수 없어 총괄이 준 숫자만 썼다.
- 상위 6개를 뺀 파일의 테스트별 계수: 파일 합계가 423 이하라 테스트별로 나누지 않았다.
- 이관 경합 `database is locked`의 원인 분석과 수정: 제품 코드라 범위 밖이다.
- `validate:official`의 실제 검사와 `ponytail` 원격 확인: 환경 제약과 삭제된 저장소 때문이다.

## 가린 값

토큰 패턴(`ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `AKIA`, PRIVATE KEY 줄, Authorization Bearer), 이메일 주소와 IPv4 주소는 발견되지 않았다. `env`·`printenv` 출력은 남기지 않았다. 다음을 바꾼 뒤 `SHA256SUMS`를 만들었다.

| 대상 | 치환 | 파일 수 | 횟수 |
| --- | --- | --- | --- |
| 사용자 이름이 들어간 컨테이너 홈 경로 | `[REDACTED-HOME]` | 180 | 183 |
| root 계정 홈 경로 | `[REDACTED-HOME]` | 1 | 2 |
| GitHub 계정 이름(URL 소유자) | `[REDACTED-ACCOUNT]` | 1 | 1 |
| 사용자 이름이 들어간 세션 scratchpad 경로(v2.7.2 worktree 위치) | `[REDACTED-SCRATCH]`, `-[REDACTED]-` | 52 | 52 |
