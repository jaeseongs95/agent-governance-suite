# wake53-shuffle-repeat — 순서 무작위·반복·자원 제한 flaky 탐지

- 대상: `53eff30a2984d41fc749d38dd2062966017684fa` (tree `c030fa4e19411ef511c5d5c89cf588aa6f42c059` 확인, `origin/codex/v2711-codex-empty-wake`)
- 기준: `d5c5932cd5a0d87630f6ed94f8e3721181ab9864` (`origin/main`, v2.7.1)
- 환경: Linux cloud container 4 vCPU, Node v24.21.0(공식 tarball, SHASUMS256 검증), pnpm 11.19.0, vitest 5.0.0. **일회용 실험이며 사용자 PC 운영 상태나 live 증거가 아니다.**
- 러너: `pnpm test` = `node scripts/build.mjs && vitest run` (vitest.config: testTimeout/hookTimeout 30s, 기본 pool forks). 인자 `--sequence.shuffle --sequence.seed=<seed>`로 파일과 테스트 순서를 모두 섞었다. 30회 normal 실행의 파일 순서 30개가 모두 서로 달랐다(셔플 적용 확인).
- 실행 스크립트: `scripts/run.sh`, `scripts/wake-matrix.sh`, `scripts/extra.sh`. run별 seed·조건·명령·시각·EXIT는 `seeds-and-runs-index.txt`, 로그·JSON 전문은 `runs/`.
- wake 부분집합: `tests/session-messaging/`(6파일) + `tests/session-board/` + `tests/mcp/trust-provenance`(tests 안에서 `wake`를 포함하는 파일 전체, `wake-subset.txt`).
- 조건: normal / cpu1 = `taskset -c 0` / stress = nproc(4)개 bash busy-loop 동시 실행 / cpu1stress(추가) = 테스트와 busy-loop 4개를 모두 CPU 0에 고정.

## 실행 행렬

| 트리 | 범위 | 조건 | 회수 | seed | 테스트(총/통과/실패/skip) | 벽시계(s) min–max | 판정 |
|---|---|---|---|---|---|---|---|
| v53 | 전체 | normal | 5 | 1001–1005 | 724/723/0/1 | 62.8–67.9 | PASS |
| v271 | 전체 | normal | 5 | 1001–1005 | 719/718/0/1 | 64.7–68.7 | PASS |
| v53 | wake | normal | 30 | 2001–2030 | 175/174/0/1 | 15.2–22.9 | PASS |
| v53 | wake | cpu1 | 10 | 3001–3010 | 175/174/0/1 | 40.1–41.9 | PASS |
| v53 | wake | stress | 10 | 4001–4010 | 175/174/0/1 | 21.5–31.2 | PASS |
| v53 | wake | cpu1stress | 10 | 5001–5010 | 175/174/0/1 | 123.5–137.6 | PASS |
| v271 | wake | normal | 30 | 2001–2030 | 170/169/0/1 | 13.9–21.0 | PASS |
| v271 | wake | cpu1 | 10 | 3001–3010 | 170/169/0/1 | 38.0–40.3 | PASS |
| v271 | wake | stress | 10 | 4001–4010 | 170/169/0/1 | 19.9–29.5 | PASS |
| v271 | wake | cpu1stress | 10 | 5001–5010 | 170/169/0/1 | 115.0–123.2 | PASS |

총 130회 실행, 모든 run EXIT=0. 테스트별 상태를 모든 run에 걸쳐 모았을 때 상태가 둘 이상 나온 테스트는 **0개**(`20-analysis.log`).

skip 1건은 모든 run에서 같다: `tests/session-messaging/previous-broker.test.ts` › `preserves queued messages when new hooks meet the previous released broker` — `AGS_PREVIOUS_BROKER_PATH`가 없으면 `it.skipIf`로 건너뛴다. 기본 행렬에서는 **NOT_RUN**이다.

## flaky 목록

| 테스트 | 파일 | 조건 | 재현율 | v271 | 판정 |
|---|---|---|---|---|---|
| (없음) | — | — | — | — | 관측된 결과 변동 0건 |

결과가 한 번도 달라지지 않아 4단계(같은 seed·조건 3회 재실행)의 대상이 없었다. 단계 4는 해당 없음이며 NOT_RUN이 아니다. 이 결과는 "이 환경과 이 seed들에서 변동을 관측하지 못했다"는 뜻이다. flaky가 없다는 증명은 아니다.

### 하네스 오류(제품 FAIL 아님, `prelim/`)
처음에 `node_modules/.bin/vitest`를 직접 실행했을 때(seed 1001) `tests/tooling/commands.test.mjs` › `skill maintenance commands forwards pnpm script arguments without a standalone separator`가 `expected undefined to be truthy`(commands.test.mjs:37, `process.env.npm_execpath`)로 실패했다. 이 테스트는 pnpm script로 실행돼야 한다는 전제를 두고 있다. 러너를 `pnpm test <args>`로 바꾼 뒤 모든 run에서 통과했다. 실험 설정 오류로 분류하고 이후 행렬에서 제외했다.

### 추가 탐색: previous-broker 테스트를 v271 broker로 실행 (UNKNOWN, 결정적)
`AGS_PREVIOUS_BROKER_PATH=/tmp/v271/mcp-server/dist/session-message-broker.mjs`, seed 6001/6002/6003, 3/3 동일 실패(`runs/prevbroker-*.log`):
`AssertionError: expected [ 'atomic-wake-claim', …(3) ] to not include 'deferred-boundary'` at `tests/session-messaging/previous-broker.test.ts:26:41`.
v271 broker는 이미 `deferred-boundary` capability를 광고한다(`mcp-server/src/session-message-broker.ts:17`). 이 테스트가 기대하는 "previous released broker"는 그보다 오래된 릴리스이므로 입력이 전제와 맞지 않는다. flaky나 제품 결함이 아니고, 올바른 이전 broker로는 실행하지 못했으므로 **UNKNOWN / 본 테스트는 NOT_RUN**으로 적는다.

## 53에만 있는 테스트 (v271 비교: 해당 없음)
v53에만 있는 6개와 v53에서 사라진 1개(`W05-r2 expired/old-generation hook records only late observation and preserves the current fence`)가 있다. 전체 수는 +5다. v53의 새 테스트는 60회 wake run 모두 통과했다. 조건별 최대 소요 시간은 다음과 같다(`21-new-tests-v53.log`).

| 테스트 | normal | cpu1 | stress | cpu1stress |
|---|---|---|---|---|
| session-message.test.ts › TLS 1.3 broker and vendor-neutral adapter blocks only verified empty Codex wake prompts in the packaged hook | 1555ms | 1452ms | 2492ms | 6160ms |
| wake-lifecycle.test.mjs › Codex post-start claim in another process leaves one marker and a verified empty discard | 244 | 265 | 450 | 1008 |
| wake-lifecycle.test.mjs › Codex running body claim in another process prevents the external queue call before start | 224 | 257 | 456 | 1036 |
| wake-lifecycle.test.mjs › old-generation retirement still rejects wrong target, unknown or mixed nonces and stale provenance | 47 | 48 | 78 | 169 |
| wake-lifecycle.test.mjs › verified expired/old-generation arrival retires only its attempt before a separate current wake | 162 | 142 | 244 | 627 |
| wake-lifecycle.test.mjs › verified old arrival in another process releases only the old attempt and permits one new effect | 793 | 729 | 851 | 2335 |

## 조건별 차이
- 결과 차이는 없다. 모든 조건과 두 트리에서 pass/fail 집합이 같았다.
- 시간: cpu1은 normal 대비 약 2배, stress는 약 1.4배, cpu1stress는 약 6–7배였다. 가장 느린 테스트 하나는 9.9s로 30s timeout의 33%였다(`runtime-smoke` 전체 run). cpu1stress에서 가장 느린 session-message 테스트는 9.2s였다. 가장 가혹한 조건에서도 timeout 여유가 약 3배 남는다.
- v53은 cpu1stress 벽시계가 v271보다 약 7–12% 길다. 새 테스트 5개가 늘어난 만큼으로 보이며 불안정 신호는 관측되지 않았다.

## 불변식 위반
관측 없음. 따라서 최소 재현 스크립트·row dump는 없다.

## 한계
- Windows와 다른 CPU 수에서는 시험하지 않았다(NOT_RUN). CI 기준은 Ubuntu와 Windows다.
- `--sequence.concurrent`(파일 안 테스트 병렬)는 테스트 설계상 전제가 아니어서 사용하지 않았다.
- 각 run 앞에 `pnpm test`의 `node scripts/build.mjs`가 실행됐다. 종료 후 두 worktree의 `git status`는 깨끗했다.
