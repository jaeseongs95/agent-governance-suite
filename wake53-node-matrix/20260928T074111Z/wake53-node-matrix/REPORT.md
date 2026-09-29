# wake53-node-matrix: Node 버전·로케일·경로 행렬

- 대상: `53eff30a2984d41fc749d38dd2062966017684fa` (tree `c030fa4e19411ef511c5d5c89cf588aa6f42c059`, `origin/codex/v2711-codex-empty-wake` 끝 커밋과 같음). 확인한 tree 해시는 `11-*-env.log`에 있다.
- 요구 버전: `package.json` `engines.node = ">=24.0.0"`, `packageManager = pnpm@11.19.0`. README·AGENTS도 "Node.js 24.0.0 이상"이다(`02-`, `03-` 로그).
- 환경: Linux cloud 컨테이너 한 곳(x86_64, 4 vCPU)에서 한 번만 돌린 실험이다. 사용자 PC(Windows, `D:\codex\거버전스 3.0\...`)의 운영 상태나 live 증거가 아니다.
- Node 설치: nodejs.org tarball을 받아 `SHASUMS256.txt`로 sha256을 확인했다(`05-*.log`). SHASUMS 파일 자체의 GPG 서명은 확인하지 않았다. Node 26에는 corepack이 들어 있지 않아 `npm i -g corepack`(0.36.0)으로 따로 설치했다(`06-`).
- 소스·테스트·설정은 고치지 않았다. 모든 worktree는 끝날 때 `git status --porcelain`이 0줄이었다.

## 1. 버전 행렬 (버전마다 별도 worktree, 기본 경로 `/tmp/wt/n<ver>`, HOME=/root, LANG/TZ 미설정)

| 단계 | 24.0.0 (engines 하한) | 24.21.0 (최신 24.x) | 26.10.0 (최신 짝수 메이저) |
|---|---|---|---|
| engines 범위 | 범위 안 | 범위 안 | 범위 안 |
| `pnpm install --frozen-lockfile` | PASS | PASS | PASS |
| `bundle:check` (빌드 전) | PASS | PASS | PASS |
| `build` 뒤 worktree clean | PASS (0줄) | PASS (0줄) | PASS (0줄) |
| `bundle:check` (빌드 후) | PASS | PASS | PASS |
| `lint` | PASS | PASS | PASS |
| 전체 `test` (JSON) | **FAIL** 15 fail / 708 pass / 1 skip (2회 모두 15 fail, 실패 목록은 다름) | PASS 723 / 1 skip | PASS 723 / 1 skip |
| `runtime:check` | PASS | PASS | PASS |
| MCP stdio initialize + tools/list | PASS (28 tools) | PASS (28 tools) | PASS (28 tools) |

로그: 24.0.0 `10-`~`19-` (2회차 `49-`), 24.21.0 `20-`~`29-`, 26.10.0 `30-`~`39-`.
1 skip은 모든 실행에서 같은 테스트다: `tests/session-messaging/previous-broker.test.ts > preserves queued messages when new hooks meet the previous released broker`(`skipIf(!previousBroker)`, 이전 릴리스 broker 경로가 없어서 건너뜀). 이 항목은 NOT_RUN이다.

추가로 원인을 좁히려고 전체 test를 더 돌렸다(worktree `n24.21.0`, 같은 커밋).

| Node | 전체 test |
|---|---|
| 24.12.0 | **FAIL** 14 fail / 709 pass (`47-`) |
| 24.13.0 | PASS 723 / 1 skip (`48-`) |

## 2. 조건 행렬 (Node 24.21.0, 한 번에 조건 하나만 바꿈. 마지막 행만 조건 조합)

| 조건 | install | build+clean | 전체 test | MCP | 로그 |
|---|---|---|---|---|---|
| 기준 (`/tmp/wt/n24.21.0`, HOME=/root, LANG·TZ 미설정) | PASS | PASS | PASS 723 | PASS | `2x-` |
| 경로 `/tmp/거버전스 3.0/agent-governance-suite` | PASS | PASS | PASS 723 | PASS | `50-`,`51a-e` |
| `LANG=ko_KR.UTF-8` (localedef로 생성, `52-`) | (기존) | (기존) | PASS 723 | PASS | `53c-e` |
| `LANG=C.UTF-8` | (기존) | (기존) | PASS 723 | PASS | `54c-e` |
| `LANG=C` | (기존) | (기존) | PASS 723 | PASS | `55c-e` |
| `TZ=Asia/Seoul` | (기존) | (기존) | PASS 723 | PASS | `56c-e` |
| `TZ=UTC` | (기존) | (기존) | PASS 723 | PASS | `57c-e` |
| `HOME=/tmp/홈 디렉터리 3.0/user` (corepack·pnpm store도 새로 받음) | PASS | PASS | PASS 723 | PASS | `58a-e` |
| 조합: 한국어 경로 + 한국어 HOME + `LANG=ko_KR.UTF-8` + `TZ=Asia/Seoul` | PASS | PASS | PASS 723 | PASS | `59a-e` |

각 로그 머리에는 `Intl` 기본 locale·timeZone과 `new Date(0).toString()`을 남겨, 조건이 Node에 실제로 적용됐는지 확인할 수 있게 했다.
"(기존)" 표시는 같은 worktree의 기준 설치·빌드 결과를 그대로 썼다는 뜻이다. `pnpm test`는 시작할 때 `scripts/build.mjs`를 다시 실행하므로 조건마다 번들을 다시 만든 셈이다.

## 3. 실패 목록과 좁힌 원인

### F1. [제품 결함] Node 24.0.0~24.12.0에서 packaged session-message broker가 처리되지 않은 TLS 소켓 오류로 죽는다
- 재현: `44-repro-cli-sequence.log`, 스크립트 `scripts/cli-seq.mjs`. 같은 커밋의 `mcp-server/dist/session-message-broker.mjs`를 띄우고 packaged CLI로 prepare→send→claim→acknowledge→status를 보냈다. 바꾼 조건은 Node 버전 하나뿐이다.
  - 24.0.0: 요청 몇 개가 끝난 뒤 broker 프로세스가 종료된다. 그 뒤 요청은 `connect ECONNREFUSED`를 받는다. broker stderr 전문:
    ```
    node:events:485
          throw er; // Unhandled 'error' event
    Error: read ECONNRESET
        at TLSWrap.onStreamRead (node:internal/stream_base_commons:216:20)
    Emitted 'error' event on TLSSocket instance at: ...
      errno: -104, code: 'ECONNRESET', syscall: 'read'
    Node.js v24.0.0
    ```
  - 24.21.0: 다섯 요청이 모두 ok였다.
- 이분 탐색(`45-bisect-node24-broker.log`): 24.0.0·24.11.0·24.11.1·24.12.0은 FAIL, 24.13.0·24.15.0·24.21.0은 PASS였다. 경계인 24.12.0(FAIL)과 24.13.0(PASS)은 3회씩 반복해도 결과가 같았다. 어느 요청에서 죽는지는 매번 달랐다(prepare 직후나 send 중간 등).
- 코드 위치(수정하지 않음): `mcp-server/src/session-message-broker.ts:470`의 `tls.createServer(..., (socket) => {...})` 콜백은 socket에 `data` 리스너와 `setTimeout`만 단다. `connection` 리스너(`:496`)도 `close`만 받는다. 그래서 per-socket `error` 리스너가 없고, 클라이언트 쪽 reset이 Node 24.12 이하에서는 프로세스를 끝내는 예외가 된다. Node 24.13에서 달라진 TLS 동작이 무엇인지는 확인하지 않았다(UNKNOWN).
- 영향: engines는 `>=24.0.0`을 허용하는데, 24.0.0~24.12.0 사용자는 세션 메시징 broker가 요청 중 죽을 수 있다. 전체 test에서는 아래 broker 계열 실패로 나타난다(실행마다 목록이 조금씩 다르다).
  - 24.0.0 1회차(`18-`):
    - `tests/session-messaging/broker-lifecycle.test.ts > retries transient endpoint publication failures and serves the published endpoint`
    - `tests/session-messaging/broker-lifecycle.test.ts > delivers and acknowledges a message using only the packaged CLI and broker`
    - `tests/session-messaging/message-lifecycle.test.ts > packaged TLS cycles use one request instead of three or two without changing pending state`
    - `tests/session-messaging/message-lifecycle.test.ts > a real send reply loss retries the known ID once and survives broker restart`
    - `tests/session-messaging/peer-wait.test.ts > enforces native wait through the public packaged hook and preserves unrelated waits`
    - `tests/session-messaging/peer-wait.test.ts > the public CLI consumes the decision before delay and sends no repeated poll when denied`
    - `tests/session-messaging/peer-wait.test.ts > public native hook suppresses equivalent payloads but permits actual cursor change`
    - `tests/session-messaging/peer-wait.test.ts > public CLI equivalent retransmissions consume one decision each and state change restores a snapshot`
    - `tests/session-messaging/peer-wait.test.ts > CLI unknown resume uses one bounded wait and does not force permanent stopping`
    - `tests/session-messaging/peer-wait.test.ts > broker restart preserves messages but drops resume and repeat-suppression evidence`
    - `tests/session-messaging/session-message.test.ts > TLS 1.3 broker and vendor-neutral adapter > uses one plugin queue profile for packaged presence and relay until the next SessionStart`
    - `tests/session-messaging/session-message.test.ts > TLS 1.3 broker and vendor-neutral adapter > pins the certificate, authenticates requests, survives restart, and supports arbitrary hosts`
  - 24.0.0 2회차(`49-`)에 새로 나온 것:
    - `tests/session-messaging/session-message.test.ts > TLS 1.3 broker and vendor-neutral adapter > converges simultaneous startup requests on one broker`
    - `tests/session-messaging/session-message.test.ts > TLS 1.3 broker and vendor-neutral adapter > blocks only verified empty Codex wake prompts in the packaged hook`
  - 24.12.0(`47-`)에 새로 나온 것:
    - `tests/mcp/trust-provenance.test.ts > trust provenance > records and verifies a claimed peer message before injecting its receipt-bound body`
    - `tests/session-messaging/message-lifecycle.test.ts > packaged CLI discovers prepare/send and rejects old or unknown send with zero queue effect`
    - `tests/session-messaging/session-message.test.ts > TLS 1.3 broker and vendor-neutral adapter > serializes wake reservation and release through the TLS broker`
    - `tests/session-messaging/session-message.test.ts > session message MCP tools > validates bound send, status, and acknowledgement calls`
  - 각 메시지 전문은 `*-test.json`의 `failureMessages`와 `*-test.log`에 있다.
- 단독 실행: `broker-lifecycle.test.ts`만 24.0.0으로 돌리면 `delivers and acknowledges a message using only the packaged CLI and broker` 하나만 실패했다(`42-`). 실패 여부가 요청 수와 타이밍에 달려 있다는 뜻이다.

### F2. [테스트 하네스 / Node 호환] Node 24.0.0~24.11.0에서 `--import tsx`로 띄운 worker_threads가 `.js`→`.ts` 해석을 하지 못한다
- 실패한 테스트(24.0.0 두 번 모두, 24.12.0 이상에서는 없음):
  - `tests/mcp/convergence-guard.test.ts > local MCP convergence guard > allows only one competing lease claim across two SQLite connections`: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/wt/n24.0.0/mcp-server/src/registry.js' imported from /tmp/wt/n24.0.0/tests/mcp/fixtures/concurrent-claim-worker.ts`
  - `tests/mcp/convergence-guard.test.ts > local MCP convergence guard > allows only one trusted observation claim across two SQLite connections`: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/wt/n24.0.0/mcp-server/src/sqlite-workflow-store.js' imported from /tmp/wt/n24.0.0/tests/mcp/fixtures/concurrent-observation-claim-worker.ts`
  - `tests/session-messaging/session-message.test.ts > session message spool > allows one wake claim across two concurrent SQLite connections`: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/wt/n24.0.0/mcp-server/src/session-message-store.js' imported from /tmp/wt/n24.0.0/tests/session-messaging/fixtures/wake-claim-worker.ts`
- 최소 재현(`40-`, `46-`, `scripts/repro1/`): `new Worker(worker.ts, { execArgv: ["--import","tsx"] })` 안에서 `import "./a.js"`(실제 파일은 a.ts)를 했다. tsx 버전은 4.23.13으로 같다.
  - 24.0.0·24.11.0: FAIL
  - 24.11.1·24.12.0·24.13.0·24.15.0·24.21.0·26.10.0: PASS
  - 같은 import를 worker가 아닌 자식 프로세스(`node --import tsx child.ts`)로 실행하면 24.0.0에서도 PASS다.
- 판단: 배포 런타임은 tsx를 쓰지 않으므로 이 항목은 제품 동작이 아니라 테스트 하네스가 Node 24.11.0 이하에서 돌지 않는 문제다. 다만 이 세 테스트가 검증하려던 "두 SQLite 연결 경합"은 24.11.0 이하에서 실행되지 못했으므로 해당 조건은 NOT_RUN(검증 공백)이다.

### O1. [관찰, FAIL 아님] 테스트가 실제 HOME의 상태 디렉터리에 broker를 띄운다
- 새 HOME으로 전체 test를 돌린 뒤 HOME 아래에서 `.agent-governance-suite/session-messaging/{broker.token, broker-key.pem, broker-cert.pem, endpoint.json, session-messages.sqlite3, trust.sqlite3}`가 생겼다(`60-`).
- 파일별로 새 HOME을 주고 테스트 파일을 하나씩 돌려 보니, broker token을 만드는 파일은 `tests/session-messaging/session-message.test.ts` 하나였다(`62-`).
- MCP 서버를 단독 기동하면 HOME에 `trust.sqlite3`와 `~/.local/state/agent-governance-suite/{continuity,workflows}.sqlite3`만 만들고 broker는 띄우지 않는다(`61-`). 이것은 설계상 기대되는 동작이다.
- AGENTS.md는 "사용자 환경 값은 fixture로 격리한다"고 규정한다. 사용자 PC에서 테스트를 돌리면 live 세션 메시징 상태 디렉터리를 건드릴 수 있다. 어느 테스트 케이스가 그러는지는 좁히지 않았다(UNKNOWN).

## 4. 판정 요약
- PASS: Node 24.21.0과 26.10.0의 모든 단계. Node 24.21.0에서는 한국어·공백 경로, 세 가지 LANG, 두 가지 TZ, 한국어·공백 HOME, 이들을 합친 조합도 모두 PASS다. 실패는 하나도 없었다.
- FAIL: Node 24.0.0 전체 test(15건, 2회 재현)와 24.12.0 전체 test(14건). 원인은 F1(제품)과 F2(테스트 하네스)다.
- NOT_RUN:
  - `previous-broker.test.ts`의 1건(`skipIf`).
  - Windows 경로(`D:\...`) 자체. 이번 실험은 Linux라 드라이브 문자와 역슬래시 경로는 검사하지 못했다.
  - 24.0.0~24.11.0에서 F2 세 테스트가 검증하려던 SQLite 경합.
  - SHASUMS256.txt의 GPG 서명 확인.
- 서비스·환경 실패(제품 FAIL과 따로 셈): 1건. 내 스크립트가 24.12.0·24.13.0용 corepack을 켜지 않아 `pnpm: command not found`(EXIT=127)가 났다. `47-`, `48-`의 `*-attempt1-no-pnpm.log`로 보존했고, corepack을 켠 뒤 다시 돌렸다. 네트워크 429/5xx는 없었다.
- 실험 절차에 관한 공지: 26.10.0 행렬이 백그라운드로 도는 동안, F2 재현용 임시 파일(`.repro1/`, `tests/{a,worker,child}.ts`, `tests/main.mjs`)을 `n26.10.0` worktree에 몇 초 동안 복사했다가 지웠다. 26.10.0의 lint(07:19:22~07:19:30)와 겹쳤을 수 있다. 그래도 lint EXIT=0, 빌드 후 clean 0줄(07:19:20), 최종 clean 0줄이었고 test는 그 뒤에 시작했다. 결과에 영향을 준 흔적은 없지만 완전히 배제할 수는 없다.
