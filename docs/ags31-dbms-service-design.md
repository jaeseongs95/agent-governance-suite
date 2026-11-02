# AGS 3.1 상태 서비스와 DBMS 전환 설계

기준 commit: `d39d90c5`(v3.0.2), 작업 브랜치 `feat/dbms-service-20261102`. 줄 번호는 모두 이 commit 기준이다. 이 문서는 설계만 담는다. 구현과 시험 결과는 적지 않는다. 확인하지 못한 내용은 (추정)으로 표시한다.

## 1. 목적

사용자 원문:

- 「난 그래서 mcp서버의 sqlite 방식을 dbms 방식으로 변경할거야. 근데 일반적인 사용자들이 로컬에 dbms를 깔수있을지 의문이라 손쉽게 설치하는 패키지를 제공할까 싶어.」
- 「근데 dbms도 외부서버에서(mcp랑 다른서버) 돌수있다는점은 염두해둬.」
- 「나중에 mcp 서버가 외부 서버에서 돌수있다는걸 감안해줘.」
- 「커넥션풀을 도입해야하지 않을까?」
- 「웹서버 커넥션풀 방식으로 peer를 관리하고 히카리풀 방식으로 db커넥션을 관리하는거지.」
- 「어떻게 할지는 토론으로 결정해줄래?」
- 「위 토론 결과를 기반으로 개발하고 반영해.」 「설계문서부터 작성해.」

기존 제약: MCP 서버는 로컬 설치와 원격 설치를 모두 지원한다. 벤더 독립(Claude Code·Codex·Antigravity), Windows·Linux·macOS. 불필요한 추상화를 만들지 않는다. 오류를 숨기지 않는다. 비밀값을 여러 곳에 퍼뜨리지 않는다.

### 1.1 확정 결정(토론 결론 conditional_consensus, 11-02)

| 축 | 결정 |
| --- | --- |
| A1 DBMS | PostgreSQL 방언 하나. 로컬은 서비스 프로세스 안의 PGlite, 원격은 `pg.Pool`. SQLite+PG 이중 백엔드는 기각. embedded-postgres는 기각하되 PGlite 측정이 실패하면 대안이다. |
| A2 프로세스 | 사용자·PC당 상주 서비스 하나가 DB의 유일한 소유자다. 세션의 stdio 진입점은 얇은 shim이다. IPC는 Unix socket/named pipe다. 깨우기·pid 감시·ppid 신원 추적은 호스트 쪽에 남는다. |
| A3 연결 관리 | 풀은 서비스 한 곳에 둔다. 작은 고정 크기, 획득 timeout 필수(풀 획득 < IPC < hook 5·10초). 트랜잭션은 client 하나에 고정하고 `SET LOCAL`만 쓴다. PgBouncer는 측정 후 판단한다. |
| A4 hook | hook은 DB를 직접 열지 않는다. 단계 확인은 막지 않고 「상태 확인 불가」를 한 번 알린다. fail-closed는 receipt·호스트 증명 발급에만 적용한다. 관측은 원인을 기록하고 통과한다. |
| A5 보안 | 자격 증명은 서비스 한 곳에 둔다. 원격 DB는 TLS verify-full. 원격 공유 시 PC별 Ed25519 키(개인키 로컬, 공개키 DB). 권위 시간은 DB 시계. 원격 provenance는 등급을 낮춘다(`mcp-server/src/caller-actor.ts:25-32`). 인증 없는 원격 기동은 거부한다. |
| A6 스키마 | 로컬은 자동 적용. 원격은 expand만 소유자 역할일 때 자동, contract는 명시 명령. 상위 버전이면 거부한다. |
| A7 순서 | 1단계: SQLite를 유지한 채 프로세스 구조를 바꾼다. 2단계: store를 비동기 PG로 교체한다. 이관은 일회성이다. |

사용자가 제시한 「웹서버 커넥션풀 방식 peer」는 서비스의 연결 상한·요청 기한·대기열 상한이다(4.3). Node에는 요청 스레드 풀이 없으므로 구현할 풀이 아니라 설정이다. 「히카리풀 방식 DB 커넥션」은 서비스 안 풀 하나다(5.9).

### 1.2 배치 조합

같은 서비스 코드가 모든 조합을 맡는다. 바뀌는 것은 IPC 대상과 store 어댑터 두 가지뿐이다.

| 번호 | 호스트 PC(CLI·shim·hook·relay) | AGS 서비스 | DBMS | 이번 범위 | 비고 |
| --- | --- | --- | --- | --- | --- |
| P1 | 로컬 | 같은 PC | 서비스 안 PGlite | 2단계 | 기본값. 설치 단계 0. |
| P2 | 로컬 | 같은 PC | 원격 PG(다른 서버) | 2단계 | 사용자 지시 「dbms도 외부서버에서」. TLS verify-full, Ed25519. |
| P3 | 로컬 여러 대 | 각 PC | 같은 원격 PG 공유 | 2단계 | P2와 같은 코드. 권위 시간 DB 시계, PC별 키. |
| P4 | 로컬 | 원격 서버 | 서비스와 같은 서버의 PG | 미룸 | Streamable HTTP, 인증 필수(4.7). |
| P5 | 로컬 | 원격 서버 A | 원격 서버 B의 PG | 미룸 | P4와 같고 DB만 P2 방식. |
| P0 | 로컬 | 같은 PC | SQLite 파일(현행) | 1단계만 | 2단계 완료 뒤 상태 저장에서 제거. |

## 2. 현재 구조와 공백

### 2.1 프로세스 종류

| 프로세스 | 기동 주체 | 수명 | 여는 저장소 | 근거 |
| --- | --- | --- | --- | --- |
| `server.mjs`(MCP) | 호스트가 세션마다 자식으로 실행. stdio 전송뿐 | 세션 동안 | workflow, trust, continuity(선택), board(조회마다 열고 닫음), messaging(프로세스 안 연결 재사용) | `mcp-server/src/index.ts:5`, `:83-90`, `:104-115`, `:157`, `:177`; `session-message-client.ts:40-61` |
| `continuity-hook.mjs` | 호스트 hook(SessionStart·UserPromptSubmit·PreCompact·PostCompact·PreToolUse·Stop) | 이벤트 한 번 | continuity, 필요 시 workflow | `continuity-hook.ts:196`, `:197-211`; `hooks/hooks.json:23`, `:48`, `:83`, `:96`, `:120`, `:145` |
| `governance-hook.mjs` | Claude PreToolUse(AGS 도구) | 이벤트 한 번 | workflow(`recordCallAdmission`) | `governance-hook.ts:57-59`; `claude-plugin/hooks/hooks.json:105-110` |
| `host-attestation-hook.mjs` | Claude SessionStart·PostModelSwitch | 이벤트 한 번 | DB를 열지 않는다. workflow DB 옆 `host-models/`에 JSON 파일을 쓴다 | `host-attestation-hook.ts:351-363`, `:442-444`, `:446-466` |
| `session-board-hook.mjs` | UserPromptSubmit(timeout 5초) | 이벤트 한 번 | board(`busyTimeoutMs: 500`), messaging | `session-board-hook.ts:78`, `:9`; `hooks/hooks.json:70-72` |
| `session-message-hook.mjs` | SessionStart·SessionEnd·UserPromptSubmit·PreToolUse·PostToolUse | 이벤트 한 번, relay를 띄움 | messaging, trust(`recordInputSource`) | `session-message-hook.ts:299`, `:440`; `hooks/hooks.json:10`, `:37`, `:59`, `:109`, `:132` |
| `skill-trigger-hook.mjs` | Claude SessionStart | 이벤트 한 번 | 없음 | `claude-overlay/hooks/skill-trigger-hook.mjs:1-19` |
| `session-message-relay.mjs`(+`relay-guard`) | session-message-hook이 detached로 실행. Windows Codex는 `Start-Process` 경유 | 호스트가 끝날 때까지. 5초마다 tick | messaging(`sessionMessageRequest` 주입) | `session-message-hook.ts:235-290`, `:192-212`; `session-message-relay.ts:9`, `:97-166`; `session-message-relay-guard.ts:6-9` |
| `session-message-cli.mjs` | 범용 호스트·사용자 | 명령 한 번 | messaging | `session-message-cli.ts:12-32` |
| `diagnostics-worker.mjs` | MCP 서버가 `fork` | 서버 동안 | 로그 파일만 | `diagnostics.ts:71`, `:91` |
| agy hook runner | agy hook | 이벤트 한 번. dist hook을 같은 프로세스에서 `import` | 위 hook과 같다 | `antigravity-connector/hooks/antigravity-hook-runner.mjs:1304`, `:1378`, `:1450`; 예산 `:90-97` |

Claude 설치는 workflow·continuity DB를 `CLAUDE_PLUGIN_DATA` 아래에 따로 둔다(`claude-plugin/.claude-plugin/plugin.json` `mcpServers.env`, `claude-overlay/hooks/continuity-hook.mjs:3-4`, `:41-42`). Codex·agy는 사용자 상태 폴더를 쓴다(`runtime-config.ts:26-53`). board·messaging·trust는 모든 호스트가 `~/.agent-governance-suite` 아래를 공유한다(`runtime-config.ts:55-96`, `:132-142`). 같은 PC 안에 workflow 저장소가 둘 이상 있다.

설치마다 데이터가 다르다. 실행 코드는 같지만(`mcp-server/dist/server.mjs`와 `claude-plugin/mcp-server/dist/server.mjs`가 같은 바이트) `skills/registry.json`은 다르다(`cmp` 결과 DIFF). registry는 서버 모듈 위치 기준으로 찾는다(`runtime-config.ts:12-19`).

### 2.2 저장소

| 모듈 | 파일 | 테이블 | 쓰기 트랜잭션 | 스키마 버전 | 근거 |
| --- | --- | --- | --- | --- | --- |
| workflow | `workflows.sqlite3` | 13 | `transaction()` 하나(`BEGIN IMMEDIATE`, 중첩은 SAVEPOINT), 호출 19곳. 스냅샷 읽기는 `BEGIN;` | `user_version` 6, 상위면 거부 | `sqlite-workflow-store.ts:108`, `:347`, `:776-781`, `:794-917`, `:1100-1116` |
| continuity | `continuity.sqlite3` | 6 | `BEGIN IMMEDIATE` 하나, 호출 12곳 | 2(호환 상한 3) | `continuity-store.ts:67-69`, `:777-790`, `:839-903` |
| trust | `session-messaging/trust.sqlite3` | 2 | `BEGIN IMMEDIATE`, 호출 3곳. 검증 읽기는 `query_only`+`BEGIN` | 1 | `trust-store.ts:21`, `:193`, `:222-251`, `:268-277` |
| messaging | `session-messaging/session-messages.sqlite3` | 11(재작성 2 포함) | 연산 하나가 트랜잭션 하나(`atomically`), 바깥 `BEGIN IMMEDIATE`, 안쪽 SAVEPOINT. 호출 51곳 | 4 | `session-message-store.ts:47`, `:277-433`, `:1614-1640`; `session-message-operations.ts:180-183` |
| board | `session-board.sqlite3` | 1 | 열 때 형식 확인만 `BEGIN IMMEDIATE`. 쓰기는 단일 upsert 자동 commit | 1 | `skills/session-board/scripts/board-store.mjs:13-22`, `:48-69`, `:85-107` |
| 용어집(상태 아님) | 스킬에 동봉된 읽기 전용 파일 | - | 빌드 때만 씀 | - | `korean-prose-glossary.ts:167-170`, `:215` |
| unified-state(비활성) | fixture 전용 | - | `BEGIN IMMEDIATE` 4곳 | - | `runtime/unified-state/README.md:1-5`, `shared-connection.mjs:42`, `:85`, `:119`, `authority.mjs:127` |

모든 파일은 WAL, `synchronous = FULL`, `busy_timeout`을 쓴다(`sqlite-workflow-store.ts:139-141`, `continuity-store.ts:183-186`, `trust-store.ts:74-76`, `session-message-store.ts:259-264`). busy는 SQLite errcode 5·6으로 판정한다(`session-message-client.ts:69-72`, `session-message-hook.ts:96`, `runtime/failure-diagnostics.mjs:51`).

여러 파일에 걸친 트랜잭션이 한 곳 있다. continuity의 epoch 회전은 workflow 쓰기 잠금을 잡은 채 continuity 트랜잭션을 연다(`continuity-service.ts:217-221`). 잠금 순서는 workflow → continuity다.

서명 키는 DB 안에 있다. workflow `plan-signing-key`(`workflow-store.ts:22`, `sqlite-workflow-store.ts:169-179`, `workflow-service.ts:167`, `:1844`), continuity `signing-secret`(`continuity-store.ts:200-208`, `continuity-service.ts:188`, `:928-943`), cleanup(`state-cleanup-service.ts:70-72`, `:264-274`), trust(`trust-store.ts:31`, `:215`, `:255-264`). 모두 HMAC-SHA256이다.

권위 시간: messaging은 잠금 뒤 `Date.now()`를 한 번 읽고 저장된 high-water로 올린다(`session-message-store.ts:1591-1606`). workflow는 SQLite 시계(`unixepoch('subsec')`)를 읽는다(`sqlite-workflow-store.ts:155-166`).

### 2.3 동기 API 의존

| 파일 | 줄 수 | `async` | `await` |
| --- | --- | --- | --- |
| `workflow-service.ts` | 2151 | 0 | 0 |
| `continuity-service.ts` | 973 | 0 | 0 |
| `trust-service.ts` | 96 | 0 | 0 |
| `state-cleanup-service.ts` | 322 | 0 | 0 |
| `sqlite-workflow-store.ts`·`continuity-store.ts`·`trust-store.ts`·`session-message-store.ts` | 1157·905·301·1643 | 0 | 0 |
| `session-message-service.ts` | 109 | 5 | 4 |

(`grep -c` 결과.) 트랜잭션 callback은 동기여야 한다는 규칙이 코드로 강제된다(`sqlite-workflow-store.ts:357`, `workflow-store.ts:228`, `workflow-service.ts:472`, `runtime/unified-state/shared-connection.mjs:26`). 반대로 MCP 요청 처리기는 이미 async다(`server.ts:617`). messaging 진입점 `sessionMessageRequest`도 이미 Promise를 돌려준다(`session-message-client.ts:116-140`). relay는 이 함수를 주입받는다(`session-message-relay.ts:41`, `:99`).

### 2.4 호출자 신원

| 호스트 | 출처 | 근거 |
| --- | --- | --- |
| Codex | `tools/call`의 `_meta`(`sessionId`, `threadId`, `x-codex-turn-metadata`) | `builtin-caller-ingress.ts:39-59` |
| agy | `_meta`의 `antigravity.google/*` | `builtin-caller-ingress.ts:61-78` |
| Claude | `_meta`에는 tool-use ID만. PreToolUse hook이 workflow DB에 쓴 행을 서버가 한 번 claim | `builtin-caller-ingress.ts:80-94`, `governance-hook.ts:57-59`, `sqlite-workflow-store.ts:203-206` |
| fork 부모 | hook이 프로세스 트리를 거슬러 Claude 실행 파일을 확인 | `claude-fork-host.ts:283-326` |

`_meta`는 MCP 서버가 받는 메시지 안에 있다(`server.ts:631-632`). 프로세스 트리는 hook 프로세스에서만 읽는다. provenance가 `host-observed`가 아니면 독립성 판정에서 `unobserved`가 된다(`caller-actor.ts:13-16`, `:25-32`).

### 2.5 3.0이 broker를 없앤 이유

3.0은 SQLite 앞의 TLS broker 프로세스를 없앴다(`docs/ags30-broker-redesign.md` 1장). broker 잠금은 죽은 소유자를 회수하려고 PID를 믿어야 했다. 그 결과 PID 재사용(D-0004), 판정·삭제 경합(D-0005), 빈 디렉터리 점유(D-0212), 오류 소실(D-0214), 기동 기한 안 PowerShell 조회(D-0330·D-0331), idle 판정(D-0008), 네트워크 재전송(D-0006)이 생겼다(같은 문서 1.2, 2장). 새 서비스는 이 결함을 다시 만들면 안 된다.

- 단일 인스턴스를 PID로 판정하지 않는다. OS가 프로세스 종료 때 풀어 주는 잠금만 쓴다(4.2).
- 유휴 종료는 열린 연결 수로만 판정한다. 다른 프로세스의 PID를 보지 않는다.
- 쓰기 요청은 결과가 불확실하면 자동 재전송하지 않는다(4.3).
- 서비스 기동 경로에 동기 OS 신원 조회를 넣지 않는다.

이번에 다시 서비스를 두는 이유는 3.0 문서에 없던 두 요구다. 연결 수가 세션 수에 비례한다(관측 37개, case brief F1). DB가 다른 서버에 있을 수 있다(사용자 원문).

### 2.6 공백

| 번호 | 공백 | 근거 |
| --- | --- | --- |
| G1 | 세션마다 MCP 서버가 저장소를 따로 연다. 37세션이면 37×5 연결이다. 원격 DB에서는 그대로 원격 연결 수가 된다. | 2.1 표, case brief F1 |
| G2 | hook 5종 중 4종이 저장소를 직접 연다. DB가 원격이면 hook마다 TLS 연결을 새로 맺어야 한다. | 2.1 표 |
| G3 | 저장 코드가 동기 `DatabaseSync`에 묶여 있다. PG 드라이버는 비동기다. | 2.3 표 |
| G4 | 서명 키가 DB 안에 있다. DB가 원격이면 DB에 접근하는 누구나 receipt를 위조할 수 있다. | 2.2 서명 키 |
| G5 | 권위 시간이 프로세스 시계다. 여러 PC가 공유하면 시계가 앞선 PC가 공용 시간을 끌어올린다. | `session-message-store.ts:1599-1603` |
| G6 | 스키마 버전이 파일별 `user_version`이다. 여러 PC·버전이 DB 하나를 공유하는 경우의 규칙이 없다. | 2.2 표 |
| G7 | 같은 PC에 workflow 저장소가 둘 이상이고 설치마다 registry가 다르다. PC당 서비스 하나는 이 둘을 구분해야 한다. | 2.1 마지막 두 문단 |
| G8 | CI가 macOS를 돌리지 않는다. | `.github/workflows/ci.yml:25-27` |

## 3. 결론과 다른 점

토론 결론과 이번 작업 지시를 그대로 따르면 코드와 맞지 않는 곳이 있다. 아래처럼 바꾼다.

| 번호 | 결론·지시 | 바꾸는 내용 | 근거 |
| --- | --- | --- | --- |
| D1 | case brief F3 「host-attestation-hook이 workflow DB를 연다」 | 이 hook은 DB를 열지 않는다. workflow DB 경로 옆 `host-models/` 폴더에 JSON 파일을 쓰고 governance-hook이 읽는다. 둘 다 호스트 쪽이라 서비스로 옮기지 않는다. | `host-attestation-hook.ts:351-363`, `:442-444`; `governance-hook.ts:53-56` |
| D2 | 지시 「소켓/파이프 바인딩을 잠금으로」 | Unix socket 파일은 프로세스가 죽어도 남는다. 남은 파일을 지우고 다시 바인딩하는 순간 두 기동자가 서로의 소켓을 지울 수 있다. 그래서 OS가 프로세스 종료 때 풀어 주는 파일 잠금(소유자 잠금)을 먼저 잡고, 잠금을 가진 쪽만 소켓을 지우고 바인딩한다. Windows도 같은 잠금을 쓴다. | Node 문서: 소켓은 "will persist until unlinked", 크래시 뒤에도 남음(https://nodejs.org/api/net.html#identifying-paths-for-ipc-connections) |
| D3 | 지시 「버전 digest가 다르면 교체(relay 교체 규칙 재사용)」 | relay 규칙은 「다른 코드면 grace마다 한 번 교체」다(`session-message-store.ts:1005-1033`). relay는 세션 하나와 설치 하나에 묶인다. 서비스는 여러 벤더 설치가 함께 쓰므로 버전이 다른 두 설치가 번갈아 교체를 요구하면 계속 교체된다. 교체는 「더 높은 버전만 낮은 버전을 교체한다」로 바꾼다. 같은 버전·다른 digest는 교체하지 않고 기록만 한다. | `session-message-store.ts:1021-1023`, 4.2 |
| D4 | A5 「권위 시간은 DB `now()`」 | PG `now()`는 트랜잭션 시작 시각이다. 잠금을 기다린 트랜잭션은 먼저 commit한 트랜잭션보다 이른 시각을 쓰게 된다. 현행은 잠금 뒤에 시각을 읽는다. 그래서 잠금 뒤 `clock_timestamp()`를 읽고 저장된 high-water와 비교해 큰 값을 쓴다. | `session-message-store.ts:1592-1593`; PG 문서 "now() … returns the start time of the current transaction"(https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT) |
| D5 | A5 「원격 공유 시 PC별 Ed25519」 | 서비스는 원격 PG가 다른 PC와 공유되는지 알 수 없다. DB에 HMAC 키를 두면 DB 관리자도 위조할 수 있다. 그래서 pg 백엔드는 공유 여부와 관계없이 Ed25519를 쓴다. PGlite는 현행 HMAC에 key_id만 붙인다. | G4, 5.6 |
| D6 | A1 「PostgreSQL 방언 하나」 | 한국어 용어집은 스킬에 동봉된 읽기 전용 데이터다. 상태가 아니므로 `node:sqlite` 읽기 전용을 유지한다. 서비스의 소유자 잠금 파일도 `node:sqlite`를 쓴다(D2). 상태 저장에는 SQLite가 남지 않는다. | `korean-prose-glossary.ts:215`, `runtime-config.ts:21-23` |
| D7 | 지시 「relay 기동 방식(Windows ShellExecute) 재사용」 | handle을 물려받지 않는 점은 재사용한다. 그러나 이 경로는 부모의 job을 그대로 물려받는다(코드 주석). relay는 자기 호스트와 수명이 같아 문제가 없지만, 여러 호스트가 함께 쓰는 서비스는 처음 띄운 호스트의 job이 닫힐 때 함께 끝날 수 있다(추정). 측정 2에서 확인하고 실패하면 job 밖 기동 경로로 바꾼다. | `session-message-hook.ts:192-193`, `:52-55` |

## 4. 목표 구조

### 4.1 전체

```text
호스트 PC                                              서비스(같은 PC, 1단계·2단계)
┌────────────────────────────────────────┐           ┌──────────────────────────────────┐
│ 호스트 CLI ─stdio─ shim(server.mjs) ────┼── IPC ────┤ ags-service.mjs                  │
│            └ hook(이벤트마다) ──────────┼── IPC ────┤  - 연결마다 MCP Server 또는 RPC   │
│            └ relay(세션마다, 깨우기) ───┼── IPC ────┤  - profile별 store·registry       │
│ session-message-cli ───────────────────┼── IPC ────┤  - 작업 대기열, 풀 하나            │
│ 프로세스 트리·pid 감시·CLI 실행은 여기   │           │  - 1단계 SQLite / 2단계 PGlite·pg │
└────────────────────────────────────────┘           └──────────────┬───────────────────┘
                                                                    │ (P2·P3) TLS verify-full
                                                                    ▼
                                                              원격 PostgreSQL
```

### 4.2 상주 서비스 `ags-service`

**기동.** 서비스는 따로 설치하지 않는다. 클라이언트 라이브러리의 `ensureService()`가 연결을 시도한다. 연결이 `ENOENT`·`ECONNREFUSED`이면 자기 설치의 `mcp-server/dist/ags-service.mjs`를 분리 실행하고 짧은 간격(50·100·200ms…)으로 다시 연결한다. 남은 기한을 넘기지 않는다.

| 호출자 | 서비스를 띄우는가 | 이유 |
| --- | --- | --- |
| shim | 띄운다 | 세션 시작이고 기한이 없다. |
| SessionStart·UserPromptSubmit hook | 띄운다. 기다리는 시간은 남은 예산 안 | shim보다 먼저 실행될 수 있다. |
| 그 밖의 hook | 띄우지 않는다. 미도달 동작(4.5)으로 간다 | 서비스가 죽은 채 반복 기동하면 모든 도구 호출마다 PowerShell이 뜬다(Windows). |
| relay·cli | 띄운다 | relay는 기한이 없다. cli는 사용자 명령이다. |

**OS별 분리 실행.**

- Linux·macOS: `spawn(process.execPath, [service], {detached: true, stdio: "ignore"})` 뒤 `unref()`. relay와 같다(`session-message-hook.ts:268-289`). `detached`는 새 프로세스 그룹을 만들어 Claude가 hook 그룹에 보내는 SIGTERM(`session-message-relay.ts:83-88`)을 받지 않는다.
- Windows: CIM `Win32_Process.Create`로 띄운다(8.1 M2). 이 경로는 handle도 job도 물려받지 않는다. 호스트 pipe handle을 물려받으면 호스트가 hook 종료를 기다리고(`session-message-hook.ts:52-55`), 호스트 job을 물려받으면 KILL_ON_JOB_CLOSE job이 닫힐 때 함께 죽는다(측정 확인). 환경 변수도 물려받지 않으므로 상태 폴더는 명령줄 인자로 넘긴다. relay의 `launchWithoutInheritedHandles`(`:192-212`)는 relay에 그대로 둔다.
- 첫 초기화(빈 dataDir)는 서비스가 짧은 자식 프로세스로 initdb만 하고 끝낸 뒤 연다(8.1 M1, 상주 메모리 차이).

**단일 인스턴스.** 다음 순서로 판정한다. PID는 보지 않는다.

1. 상태 폴더의 `service/owner.lock`을 `node:sqlite`로 열고 `PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;`을 busy_timeout 0으로 실행한다. 실패하면 다른 서비스가 살아 있다. 종료 코드 0, 사유 `SERVICE_ALREADY_RUNNING`으로 끝낸다.
2. 잠금을 가진 쪽만 남은 socket 파일을 지우고 바인딩한다. Windows pipe는 소유 프로세스가 끝나면 OS가 지운다(Node 문서 같은 절).
3. OS 잠금은 프로세스가 죽으면 풀린다(POSIX `fcntl`, Windows `LockFileEx`). Windows는 풀리는 시점이 즉시라고 보장되지 않는다(추정, 측정 2).

**유휴 종료.** 열린 연결이 0인 상태가 10분 이어지면 store를 닫고 종료한다. shim과 relay는 연결을 계속 유지하므로 세션이 하나라도 살아 있으면 서비스도 산다. 10분은 시작값이다. 측정 4의 hook 간격 분포로 정한다.

**버전 교체(D3).** 핸드셰이크에서 클라이언트가 자기 `PLUGIN_INFO.version`(`plugin-info.ts:1-6`)과 빌드 digest, 프로토콜 번호를 보낸다.

| 비교 | 동작 |
| --- | --- |
| 클라이언트 버전 > 서비스 버전 | 클라이언트가 `service.handover`를 보낸다. 서비스는 listener를 닫고 진행 중 요청을 최대 2초 마치고 store를 닫고 잠금을 풀고 끝난다. 클라이언트가 자기 서비스를 띄운다. |
| 같은 버전, 다른 digest | 교체하지 않는다. `SERVICE_BUILD_DIFFERS`를 진단에 남긴다. |
| 클라이언트 버전 < 서비스 버전 | 교체하지 않는다. 클라이언트 프로토콜이 `minClientProtocol` 이상이면 그대로 서비스한다. 아니면 `SERVICE_PROTOCOL_UNSUPPORTED`로 거부한다. |

교체 때 끊긴 다른 shim은 다시 연결한다(4.4). 교체는 위로만 가므로 두 설치가 번갈아 교체하지 않는다.

**profile(G7).** 한 서비스가 여러 설치를 받는다. 연결마다 클라이언트가 profile을 보낸다.

| 필드 | 현재 출처 |
| --- | --- |
| `installRoot` | shim·hook 자기 위치. registry·용어집·분류 설정을 여기서 읽는다(`runtime-config.ts:12-23`, `index.ts:118-119`). |
| `hostAttestation` | `AGENT_GOVERNANCE_HOST_ATTESTATION`(`index.ts:176`, `runtime-config.ts:192-201`) |
| `toolSchemaProfile` | `AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE`(`runtime-config.ts:183-190`) |
| `workflowNamespace`, `continuityNamespace` | `AGENT_GOVERNANCE_DB_PATH`·`..._CONTINUITY_DB_PATH`를 정규화한 경로(`runtime-config.ts:26-35`, `:119-127`, `:144-164`) |
| `logConfig`, `classificationConfig` | `index.ts:61`, `:119` |

서비스는 profile 키마다 registry 한 벌과 store 한 벌을 연다. board·messaging·trust는 profile과 관계없이 하나다. 신뢰 경계는 지금과 같이 「같은 OS 사용자」다. 지금도 같은 사용자는 환경 변수로 아무 경로나 고를 수 있다.

### 4.3 IPC 프로토콜

**위치와 권한.**

| OS | 주소 | 권한 |
| --- | --- | --- |
| Linux | `$XDG_RUNTIME_DIR/agent-governance-suite/service.sock`, 없으면 `~/.agent-governance-suite/run/service.sock` | 폴더 0700, 기존 상태 폴더와 같은 방식(`session-message-client.ts:51-52`) |
| macOS | `~/.agent-governance-suite/run/service.sock` | 폴더 0700 |
| Windows | `\\.\pipe\agent-governance-suite-<기동마다 새 무작위 32자>` | 기본 DACL은 Everyone에 읽기를 준다. 이름은 접속 정보 파일로만 알린다(아래 「접속 정보와 상호 확인」, 8.1 M3). |

경로가 `sun_path` 한도(Linux 107B, macOS 103B)를 넘으면 `SERVICE_SOCKET_PATH_TOO_LONG`으로 바로 실패한다(Node 문서 같은 절). 줄여서 다른 곳에 만들지 않는다.

Windows 기본 보안 설명자는 LocalSystem·administrators·creator owner에 전체 권한을, Everyone과 anonymous에 읽기를 준다(https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights). Node `listen`의 `readableAll`·`writableAll`은 기본 false지만 Windows에서 DACL을 어떻게 만드는지 문서에 없다(https://nodejs.org/api/net.html#serverlistenoptions-callback). 측정 3에서 다른 사용자가 같은 이름을 먼저 만들어 서비스를 사칭할 수 있음을 확인했다(8.1).

**접속 정보와 상호 확인(M3 반영, 세 OS 같은 코드).** 서비스는 잠금을 잡고 listen에 성공한 뒤 상태 폴더의 `service/endpoint.json`(사용자 전용, 임시 파일 뒤 rename)에 `{address, key, pid, version, startedAt}`을 쓴다. `key`는 기동마다 새 32바이트 난수다. Windows는 pipe 이름도 기동마다 새로 정한다. 그래서 다른 사용자가 이름을 미리 만들어 서비스 기동을 막을 수 없다. 클라이언트는 이 파일에서 주소와 key를 읽는다. 파일이 없거나 연결이 거부되면 4.2의 기동 경로로 간다.

hello 전에 한 번 확인한다. 클라이언트가 `{"ags":"challenge","nonce":<32바이트>}`를 보내면, 서비스가 `HMAC-SHA256(key, "service" ‖ nonce ‖ serviceNonce)`와 `serviceNonce`를 답한다. 클라이언트는 맞으면 `HMAC-SHA256(key, "client" ‖ serviceNonce)`를 실어 hello를 보낸다. 서비스 확인이 틀리면 클라이언트는 profile을 보내지 않고 닫는다. 사유는 `SERVICE_IDENTITY_MISMATCH`이며 다시 띄우지 않는다. 클라이언트 확인이 틀리면 서비스는 `refuse`를 보낸다. Unix socket은 폴더 0700만으로 막히지만, OS마다 다른 경로를 두지 않으려고 같은 확인을 쓴다. 신뢰 경계는 여전히 「같은 OS 사용자」다. 접속 정보 파일을 읽을 수 있는 사용자는 서비스를 쓸 수 있다.

잠금은 잡았는데 listen이 `EADDRINUSE`이면 「이미 실행 중」이 아니다. 사유 `SERVICE_ENDPOINT_IN_USE`로 끝내고 진단에 남긴다. Windows는 새 이름으로 한 번 더 시도한다.

**형식.** MCP stdio와 같은 줄 단위 UTF-8 JSON이다. 한 줄 상한 16 MiB(추정 시작값). 연결의 첫 줄은 핸드셰이크다.

```json
{"ags":"hello","protocol":1,"role":"mcp","client":{"kind":"shim","version":"3.1.0","build":"sha256:…"},"profile":{…}}
{"ags":"welcome","protocol":1,"service":{"version":"3.1.0","build":"sha256:…","minClientProtocol":1},"schema":{"workflow":6,"continuity":2,"trust":1,"messaging":4,"board":1}}
```

거부는 `{"ags":"refuse","reason":"SERVICE_PROTOCOL_UNSUPPORTED"}`를 보내고 닫는다. hello가 1초 안에 오지 않으면 닫는다. 읽기 권한만 있는 연결이 자리를 차지하지 못하게 하기 위해서다.

`role`은 둘이다. 판단: MCP를 그대로 중계하는 쪽이 shim에는 더 단순하고, hook에는 JSON-RPC가 더 단순하다.

- `mcp`(shim): welcome 뒤에는 MCP 메시지를 그대로 흘린다. 서비스는 그 socket에 `new StdioServerTransport(socket, socket)`를 붙인다. SDK 1.30.0의 이 클래스는 입출력 stream을 인자로 받는다(`node_modules/.../@modelcontextprotocol/sdk/dist/esm/server/stdio.js:9`). shim은 바이트를 바꾸지 않으므로 `_meta`가 그대로 서비스에 간다(2.4). 다시 인코딩하는 코드가 없다.
- `rpc`(hook·relay·cli): JSON-RPC 2.0 요청·응답이다. MCP initialize를 hook마다 하면 왕복이 늘기 때문이다. 메서드는 기존 연산 이름을 그대로 쓴다. messaging은 이미 문자열 연산 dispatcher가 있다(`session-message-operations.ts:180-292`).

```json
{"jsonrpc":"2.0","id":1,"method":"messaging","params":{"operation":"relay-tick","payload":{…},"deadlineMs":4200}}
{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"…","data":{"reason":"SERVICE_BUSY","retryable":true,"effect":"none"}}}
```

**요청 기한.** 클라이언트는 남은 시간(ms)을 보낸다. 프로세스마다 monotonic 시계가 다르므로 절대 시각은 보내지 않는다. 서비스는 받은 순간부터 그 시간 안에 대기열·풀 획득·실행을 끝낸다. 지난 기한의 요청은 실행하지 않는다. 현행 `sessionMessageRequest`의 기한 규칙(`session-message-client.ts:129-137`)을 IPC로 옮긴 것이다.

**결과가 불확실할 때.** 응답 전에 연결이 끊기면 클라이언트는 `SERVICE_RESULT_UNKNOWN`을 낸다. 쓰기 연산은 다시 보내지 않는다(D-0006). 읽기 연산(`status`, `pending`, `presence`, `list-current-presence`, `wake-status`, board 조회)만 한 번 다시 보낸다. 메서드 표에 `idempotent` 표시를 둔다.

**backpressure.**

| 항목 | 값(시작값) | 동작 |
| --- | --- | --- |
| 동시 연결 상한 | 256 | `server.maxConnections`. 넘으면 Node가 연결을 닫는다(https://nodejs.org/api/net.html#servermaxconnections). 클라이언트는 `SERVICE_CONNECTIONS_FULL`로 보고한다. 관측 37세션 × (shim+relay) = 74에 hook 순간 연결을 더한 값이다. |
| `rpc` 연결당 동시 요청 | 1 | hook은 순차다. 두 번째 요청은 앞 요청 응답 뒤에 처리한다. |
| DB 작업 대기열 길이 | 64 | 넘으면 즉시 `SERVICE_BUSY`, `effect: "none"`. |
| 대기열 대기 | 기한 안, 상한 1초 | 넘으면 `SERVICE_BUSY`. |

값은 측정 4의 p99로 다시 정한다.

### 4.4 shim

`mcp-server/dist/server.mjs`의 이름과 위치를 그대로 둔다. 호스트 설정(`.mcp.json`, `claude-plugin/.claude-plugin/plugin.json`, `mcp_config.json`)을 바꾸지 않기 위해서다. 내용은 shim이 된다.

1. 환경 변수와 자기 위치로 profile을 만든다(4.2 표).
2. `ensureService()`로 연결하고 `role: "mcp"` hello를 보낸다.
3. welcome을 받으면 `stdin → socket`, `socket → stdout`을 `pipe`로 잇는다. Node stream이 backpressure를 맡는다.
4. 호스트가 보낸 `initialize` 요청과 `notifications/initialized`를 기억한다.
5. 서비스 연결이 끊기면 진행 중인 요청 ID마다 JSON-RPC 오류(`SERVICE_RESULT_UNKNOWN`)를 stdout에 쓴다. 다음 메시지가 오면 다시 연결하고 기억한 `initialize`를 다시 보낸 뒤 그 응답은 버린다.
6. stdin이 닫히면 socket을 닫고 끝난다.

shim은 저장소·pino·registry를 불러오지 않는다. 진단은 실패 한 줄만 stderr에 쓴다(`hook-error-diagnostics.ts`의 기존 방식).

**호출자 신원 전달.** shim은 신원을 새로 만들지 않는다.

- Codex·agy: `_meta`가 MCP 메시지 안에 있으므로 서비스의 ingress가 지금처럼 읽는다(`builtin-caller-ingress.ts:40-78`).
- Claude: governance-hook이 서비스에 `workflow.recordCallAdmission`을 보내고, MCP 호출이 오면 서비스가 같은 namespace에서 claim한다(`builtin-caller-ingress.ts:81-94`). hook이 끝난 뒤 도구 호출이 오므로 순서는 지금과 같다.
- ppid·fork 부모: 지금도 hook 프로세스가 읽는다(`claude-fork-host.ts:283-326`). hook이 읽은 결과를 요청에 담아 보낸다. 서비스는 다른 프로세스의 트리를 읽지 않는다.
- Claude transcript 계보(`readLineage`, `builtin-caller-ingress.ts:90-91`): 로컬 서비스는 같은 사용자라 파일을 직접 읽을 수 있다. 원격 서비스(4.8)에서는 읽을 수 없다. 그때 hook이 읽어 보내는 방식으로 바꾼다.

### 4.5 hook

hook 프로세스는 「호스트 사실 수집 → 서비스 요청 → 호스트 쪽 효과 → 출력」만 한다. 저장소 코드는 서비스 bundle로만 간다.

| hook | 호스트 쪽에 남는 일 | 서비스 요청 | 미도달 시 | 분류 |
| --- | --- | --- | --- | --- |
| governance-hook | 입력 파싱, session model 파일 읽기(`governance-hook.ts:53-56`), fork 부모 읽기 | `workflow.recordCallAdmission` | 지금처럼 거부(`governance-hook.ts:67-73`). 신원 행이 없으면 AGS 도구 호출이 어차피 실패한다. | 증명 발급, fail-closed |
| continuity-hook | 입력 정규화, fork 부모 읽기 | `continuity.hook`(정규화 입력 전체). 처리 로직(`continuity-hook.ts:108-145`)은 서비스에서 실행 | Stop: 「[AGS 단계 확인] 상태 확인 불가(원인 코드)」를 한 번 알린다. 입력의 `stop_hook_active`가 true이면 알리지 않는다(이어 가기 반복 방지). 그 밖의 이벤트: 출력 0, 원인 한 줄 stderr | 단계 확인, 막지 않음 |
| session-board-hook | 입력 파싱 | `board.recordInput`, messaging 깨우기 확인 | 원인 기록 후 통과 | 관측 |
| session-message-hook | 호스트 pid 해석, relay 실행(`session-message-hook.ts:235-290`) | messaging 연산, `trust.recordPeerSources`(`:294-330`의 receipt 발급) | messaging 조회: 원인 기록 후 통과. peer 메시지 receipt: 발급하지 않고 메시지를 주입하지 않는다(현행은 receipt 실패를 throw해 메시지 묶음을 만들지 않음, `:325-336`, `:662`). relay grant: 받지 못하면 relay를 띄우지 않는다. | receipt 발급은 fail-closed, 나머지 관측 |
| host-attestation-hook | 전부(파일 쓰기) | 없음 | 해당 없음 | D1 |
| agy runner | 위 hook을 같은 프로세스에서 부름 | 같다 | 같다 | - |

`stop_hook_active`는 Claude Code Stop 입력의 필드다. 문서: "The `stop_hook_active` field is `true` when Claude Code is already continuing as a result of a stop hook."(https://code.claude.com/docs/en/hooks, Stop input). `additionalContext`도 같은 반복 보호와 연속 8회 상한을 따른다(같은 절). Codex와 agy가 같은 필드를 주는지는 확인하지 못했다(추정). 없으면 실호스트 시험에서 이어 가기가 반복되는지 보고, 반복되면 해당 호스트는 미도달 알림을 `decision: "block"` 없이 낸다.

`runContinuityHook`은 지금 동기 함수이고 governance-hook이 직접 부른다(`continuity-hook.ts:180`, `governance-hook.ts:52`). 1단계에서 async로 바꾼다.

**시간 예산.** 바깥 층의 기한이 안쪽 층의 합보다 항상 크다.

| 경로 | 호스트 timeout | 클라이언트 IPC 기한 | 서비스 대기열 | 풀 획득 | 문장 실행 |
| --- | --- | --- | --- | --- | --- |
| hook 10초(대부분) | 10,000ms(`hooks/hooks.json:12` 등) | 남은 예산 − 출력 예비 800ms, 상한 8,000ms(현행 `HOST_MESSAGE_REQUEST_TIMEOUT_MS`, `session-message-hook.ts:30`) | ≤ min(1,000, 기한) | ≤ min(1,000, 남은 기한 − 300) | `SET LOCAL statement_timeout` ≤ min(2,000, 남은 기한), `lock_timeout` ≤ 1,000 |
| hook 5초(board, Claude SessionEnd) | 5,000ms(`hooks/hooks.json:72`, `claude-plugin/hooks/hooks.json:60`) | 1,500ms | ≤ 500 | ≤ 500 | ≤ 700 |
| agy runner | 단계 2,000ms, 전체 9,200ms(`antigravity-hook-runner.mjs:90`, `:93-95`) | 단계 남은 예산 − 300 | 같은 규칙 | 같은 규칙 | 같은 규칙 |
| MCP 도구(shim) | 호스트 도구 timeout(확인 못 함) | 없음. 서비스 기본 30,000ms | ≤ 1,000 | ≤ 1,000 | ≤ 10,000 |
| relay tick | 없음 | 4,000ms(5초 주기 안, `session-message-relay.ts:9`) | ≤ 1,000 | ≤ 1,000 | ≤ 2,000 |

1단계(SQLite)에서는 「풀 획득」 자리에 `busy_timeout`이 온다. 현행 상한 5,000ms(`session-message-client.ts:36-37`)를 같은 규칙으로 줄인다.

### 4.6 relay·깨우기·pid 감시의 경계

| 일 | 위치 | 이유 |
| --- | --- | --- |
| relay 시작 허가(lease·fencing) | 서비스 | DB 행 CAS다(`session-message-store.ts:1008-1033`). |
| relay 프로세스 실행 | 호스트(hook) | 호스트 pid를 아는 곳이고, 원격 서비스는 호스트 PC에 프로세스를 만들 수 없다. |
| 호스트 생존 감시 | 호스트(relay) | `/proc/<pid>/stat`·Windows 조회(`host-process-watch.ts:62-85`)는 그 PC에서만 된다. |
| 깨우기 실행(`codex queue` 등) | 호스트(relay) | 호스트 CLI를 직접 실행한다(`wake-transport-codex.ts:77`). |
| 깨우기 예약·결과 기록 | 서비스 | `reserve-wake`·`start-wake`·`record-wake-outcome`(`session-message-relay.ts:65-78`). |
| relay의 DB 접근 | 없어짐 | relay는 서비스에 연결 하나를 유지하고 같은 연산을 보낸다. relay 코드는 `request` 주입만 바꾸면 된다(`session-message-relay.ts:41`, `:99`). |

relay는 세션마다 하나로 남는다. DB 연결이 없어지므로 G1의 원인은 아니다.

### 4.7 원격 서비스 모드(P4·P5)

이번 범위에서 구현하지 않는다. 지금 정해 두는 규칙만 적는다.

| 항목 | 규칙 | 이번에 하는 일 |
| --- | --- | --- |
| 전송 | MCP Streamable HTTP. 단일 endpoint에 POST·GET, `Origin` 검증, `MCP-Session-Id`, `MCP-Protocol-Version`(https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) | 없음. 서비스에 TCP listen 코드를 넣지 않는다. |
| 인증 | 인증 설정이 없으면 TCP listen을 거부하고 종료한다. 방식은 미정(10장). MCP 인증 규격 후보: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization | 없음 |
| provenance | 원격 서버는 호스트 프로세스 트리를 볼 수 없다. 원격 경로 호출자는 `host-observed`보다 낮은 등급(예: `remote-asserted`)이다. `independence()`는 `host-observed`만 verified로 센다(`caller-actor.ts:29-32`). 새 등급은 자동으로 `unobserved`가 된다. | 없음. 기존 코드가 이미 이렇게 동작한다. |
| hook·relay | 호스트 PC에 남는다. 원격 서비스에 HTTP로 요청한다. transcript·session model 파일은 hook이 읽어 보낸다(4.4). | 없음 |

IPC 클라이언트(`service-client.ts`)는 「hello·요청·응답」을 전송과 분리해 둔다. 원격 모드를 만들 때 전송만 더한다.

## 5. 저장 계층(2단계)

### 5.1 store 포트

```ts
interface SqlStore {
  query<R>(sql: string, params?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number }>;
  transaction<T>(options: { lockKeys: readonly LockKey[]; readOnly?: boolean; deadlineMs: number },
    body: (tx: SqlTransaction) => Promise<T>): Promise<T>;
}
interface SqlTransaction { query: SqlStore["query"] }
```

- 메서드는 두 개뿐이다. 모듈 store(workflow·continuity·trust·messaging·board)는 이 포트만 쓴다.
- `transaction`은 client 하나를 잡고 `BEGIN` → `SET LOCAL search_path`·`statement_timeout`·`lock_timeout` → `lockKeys` 순서대로 advisory lock → `body` → `COMMIT`. 실패하면 `ROLLBACK`하고 client를 돌려준다. 세션 수준 `SET`은 쓰지 않는다(PgBouncer transaction 모드 호환, https://www.postgresql.org/docs/current/sql-set.html).
- `body`는 `tx.query`만 await한다. 파일·네트워크·자식 프로세스 await를 넣지 않는다. 강제는 두 겹이다. `tx`에는 `query`만 있다. `statement_timeout`과 `idle_in_transaction_session_timeout`(SET LOCAL 가능 여부는 확인 못 함, 추정)이 넘친 트랜잭션을 끊는다.
- 중첩 트랜잭션은 SAVEPOINT다. 현행 의미(안쪽 도메인 거절은 자기 쓰기만 되돌림, `session-message-store.ts:1614-1627`)를 지킨다.

### 5.2 어댑터

| | PGlite(P1) | pg.Pool(P2·P3) |
| --- | --- | --- |
| 연결 | 프로세스 안 하나. "PGlite only has a single exclusive connection"(https://pglite.dev/docs/pglite-socket) | 풀(5.9) |
| 트랜잭션 직렬화 | 서비스 안 FIFO 대기열 하나. 현행 `BEGIN IMMEDIATE` 직렬화와 같은 순서다. | advisory lock(5.3) |
| 데이터 위치 | `dataDir: file://<상태 폴더>/service/pgdata`(https://pglite.dev/docs/api) | 원격 |
| wasm 적재 | `pgliteWasmModule`·`initdbWasmModule`·`fsBundle` 옵션으로 dist 옆 파일을 직접 넘긴다(https://pglite.dev/docs/api). bundle 안 상대 경로 해석에 기대지 않는다. | 해당 없음 |
| 내구성 | `relaxedDurability`를 켜지 않는다. 문서상 켜면 flush를 기다리지 않는다. 기본값은 문서에 없다(측정 1). | PG 기본 |

`memory://` PGlite는 시험에서 `InMemoryWorkflowStore`(`workflow-store.ts:100`)를 대신할 수 있다. 실제 SQL을 거치는 구현이 하나 줄어든다. 2단계 마지막 커밋에서 판단한다.

### 5.3 `BEGIN IMMEDIATE` 대응

기본 원칙: SQLite의 「모듈 파일당 쓰기 하나」를 PG에서 「모듈 namespace당 `pg_advisory_xact_lock` 하나」로 옮긴다. 의미가 같으므로 경합 결함이 새로 생기지 않는다. 더 잘게 나누는 것은 측정 4에서 대기가 보일 때만 한다. 트랜잭션 수준 advisory lock은 commit·rollback 때 풀린다(https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS).

| 위치 | 현재 의미 | PG 대응 |
| --- | --- | --- |
| workflow `transaction()`(`sqlite-workflow-store.ts:1100-1116`), 19곳 | 파일 쓰기 잠금 | `READ COMMITTED` + `pg_advisory_xact_lock(workflow, ns)` |
| workflow 스냅샷 읽기 `BEGIN;`(`:347`) | 한 시점 읽기 | `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, 잠금 없음 |
| workflow `withWorkflowTransaction`(`:350-365`) + continuity 회전(`continuity-service.ts:217-221`) | workflow 잠금 안에서 continuity 트랜잭션 | 같은 DB라 트랜잭션 하나. `lockKeys = [workflow, continuity]` 순서 고정. 두 파일이 따로 commit하던 틈이 없어진다. |
| continuity `transaction`(`continuity-store.ts:777-790`), 12곳 | 파일 쓰기 잠금 | `pg_advisory_xact_lock(continuity, ns)` |
| trust `transaction`(`trust-store.ts:268-277`), 3곳 | 파일 쓰기 잠금 | `pg_advisory_xact_lock(trust)` |
| trust 검증 읽기(`trust-store.ts:190-200`) | `query_only` 읽기 | `READ ONLY` 트랜잭션, 잠금 없음 |
| messaging 연산(`session-message-store.ts:1614-1640`, `session-message-operations.ts:180-183`), 51곳 | 연산 하나가 쓰기 잠금 하나, 잠금 뒤 시각 | `pg_advisory_xact_lock(messaging)` 뒤 시각 읽기(5.5) |
| messaging 용량 확인 후 삽입(`session-message-store.ts:570-580`, `:637`) | 같은 잠금 안이라 안전 | 모듈 잠금이 그대로 지킨다. 잠금을 잘게 나누면 이 곳이 먼저 깨진다(READ COMMITTED에서 count 뒤 insert 경합). |
| messaging 행 CAS(`:503-505`, `:1304-1310`, `changes === 1`) | 상태 조건 UPDATE | 그대로. PG `UPDATE … WHERE state='reserved'`는 행 잠금 뒤 조건을 다시 본다. `rowCount`로 판정. |
| workflow claim(`sqlite-workflow-store.ts:203-206`, `DELETE … RETURNING`) | 한 번 claim | 그대로 |
| 비밀값 생성(`sqlite-workflow-store.ts:169-179` SELECT 후 INSERT, `continuity-store.ts:200-208` `INSERT OR IGNORE` 후 재조회, `trust-store.ts:255-264`) | 잠금 안 생성 | `INSERT … ON CONFLICT (key) DO NOTHING` 뒤 `SELECT`. 세 곳을 같은 방식으로 맞춘다. |
| board 형식 확인(`board-store.mjs:51`) | 열 때 한 번 | 마이그레이션 단계로 옮긴다(5.7). |
| board upsert(`board-store.mjs:85-107`) | 단일 문장 자동 commit | 그대로. `ON CONFLICT`는 PG와 문법이 같다. |
| 용어집(`korean-prose-glossary.ts:170`), unified-state(2.2) | 빌드 전용, 비활성 fixture | 옮기지 않는다(D6). unified-state는 이관 아이디어(source digest·intent 결속)만 참고하고 코드는 쓰지 않는다. |

SERIALIZABLE+재시도는 쓰지 않는다. 재시도하려면 트랜잭션 body가 몇 번 돌아도 같은 결과여야 하는데, 현행 body는 `randomUUID()`·`randomBytes()`를 부른다(`session-message-store.ts:1025`, `trust-store.ts:259`). 모듈 잠금이 더 단순하다.

advisory lock 키는 두 int4 형식 `(모듈 번호, namespace 해시)`다. 다른 애플리케이션의 키와 섞이지 않게 모듈 번호에 고정 접두를 둔다(추정 값: `0x41470000 + n`).

### 5.4 SQL 방언 차이

store 파일에서 센 값(workflow·continuity·trust·messaging·board 순).

| 구문 | 개수 | PG 대응 |
| --- | --- | --- |
| `STRICT` | 13·0·2·9·1 | 지운다. PG 열 타입이 이미 엄격하다. |
| `INSERT OR IGNORE` | 2·1·0·2·0 | `ON CONFLICT DO NOTHING` |
| `INSERT OR REPLACE` | 1·0·0·0·0 | `ON CONFLICT (…) DO UPDATE` |
| `rowid` | 0·0·0·8·0 | 명시 `bigint GENERATED ALWAYS AS IDENTITY` 열 |
| `AUTOINCREMENT` | 0·1·0·0·0 | 같다 |
| `.changes` | 10·4·0·8·0 | `rowCount` |
| `json_` 함수 | 1·1·0·0·0 | `jsonb` 함수로 바꾼다. 개별 확인 필요. |
| `strftime`·`julianday` | 0·0·0·2·0 | `extract(epoch …)` |
| `unixepoch('subsec')`(`sqlite-workflow-store.ts:160`) | 1 | `(extract(epoch from clock_timestamp()) * 1000)::int8` |
| `PRAGMA user_version` | 모두 | `ags_meta.module_schema`(5.7) |

- **문자열 비교 순서.** 시각을 ISO 문자열로 저장하고 `<`로 비교한다(예: `board-store.mjs:114`). PG 기본 collation은 바이트 순서가 아닐 수 있다. 텍스트 키·비교 열은 `COLLATE "C"`로 만든다.
- **int8.** `node:sqlite`는 정수를 number로 준다. node-postgres는 파서가 없는 타입을 문자열로 준다(https://node-postgres.com/features/types). int8을 number로 받는 파서를 서비스 한 곳에서 등록하고 `Number.isSafeInteger`로 확인한다. PGlite의 int8 반환 형식은 확인하지 못했다(추정, 시험으로 고정).
- **시각 타입.** 지금처럼 ISO 문자열 `text`와 ms `int8`을 유지한다. `timestamptz`로 바꾸면 node-postgres가 `Date`로 바꾸고 마이크로초를 버린다(같은 문서). 바꾸는 이득이 없다.

### 5.5 권위 시간

| 배치 | 규칙 |
| --- | --- |
| 1단계, P0 | 현행 그대로(`session-message-store.ts:1595-1606`). |
| P1(PGlite) | 같은 프로세스·같은 시계라 현행과 같다. 잠금 뒤 `Date.now()`와 high-water 중 큰 값. |
| P2·P3(pg) | 잠금 뒤 `SELECT (extract(epoch from clock_timestamp())*1000)::int8`와 high-water 중 큰 값(D4). 여러 PC가 DB 시계 하나를 쓴다. |

workflow의 시계 읽기(`sqlite-workflow-store.ts:155-166`)도 같은 함수를 쓴다. high-water 행 `authority_time`은 messaging만 갖는다. workflow는 high-water 없이 DB 시계를 쓰는 현행 동작을 유지한다.

### 5.6 서명 키

| 배치 | 알고리즘 | 키 위치 | 이번 범위 |
| --- | --- | --- | --- |
| P0·P1 | HMAC-SHA256(현행) | 현행 위치(DB 안 metadata). PGlite 파일은 사용자 상태 폴더 안이다. | 2단계. 서명 봉투에 `keyId`를 더한다. |
| P2·P3 | Ed25519 | 개인키: `<상태 폴더>/service/keys/<keyId>.pem`(0600, `open(…, "wx")`로 만든 뒤 다시 읽음). 공개키: `ags_meta.signing_keys(key_id, public_key, label, created_at, revoked_at)` | 2단계. pg 백엔드를 켜기 위한 선행 조건이다(D5). |

- 판단 근거: P2를 이번 범위에 넣는 한 Ed25519도 넣어야 한다. 넣지 않으면 원격 DB 접근자 누구나 receipt·plan 서명을 만들 수 있다(G4). PC가 하나인 P2와 여러 대인 P3을 서비스가 구분할 수 없다.
- `keyId` = 공개키 DER의 SHA-256 앞 16자. 공개키 등록은 `INSERT … ON CONFLICT (key_id) DO NOTHING`. PC마다 키가 달라 PC 사이 경합은 없다. 같은 PC는 소유자 잠금(4.2)이 서비스 하나만 허용한다.
- 서명 대상: plan(`workflow-service.ts:1844`), continuity 토큰(`continuity-service.ts:928-943`), cleanup 토큰(`state-cleanup-service.ts:264-274`), trust receipt(`trust-store.ts:31`, `:215`). 서명·검증 함수 두 개(`sign(bytes) → {keyId, signature}`, `verify(keyId, bytes, signature)`)로 모은다.
- P1에서 P2로 옮기는 PC: 이관된 HMAC 키는 DB에 넣지 않고 그 PC의 `keys/hmac-legacy-<module>.key`에만 둔다. 예전 receipt는 그 PC에서만 검증된다. 다른 PC에서는 미검증으로 처리한다.
- 한계: DB 쓰기 권한자는 행을 지우거나 공개키를 바꿀 수 있다(토론 I5).
- Node API: `crypto.generateKeyPairSync("ed25519")`, `crypto.sign(null, data, key)`(https://nodejs.org/api/crypto.html#cryptosignalgorithm-data-key-callback).

### 5.7 스키마와 마이그레이션

- 모듈마다 PG schema 하나: `ags_board`, `ags_messaging`, `ags_trust`, workflow·continuity는 namespace마다 `ags_workflow_<ns>`·`ags_continuity_<ns>`. `ns`는 정규화 경로(`runtime-config.ts:144-164`)의 SHA-256 앞 12자다. 트랜잭션 시작에 `SET LOCAL search_path = <모듈 schema>, ags_meta`를 두면 store SQL은 schema 이름 없이 그대로 쓸 수 있다.
- `ags_meta.module_schema(module, ns, version, min_client_version, applied_at, applied_by)`. PG 첫 버전 번호는 현재 SQLite 최신과 같게 시작한다(workflow 6, continuity 2, trust 1, messaging 4, board 1). 이관기가 원본 `user_version`과 바로 비교할 수 있다.
- 마이그레이션은 `mcp-server/src/store/migrations/<module>.ts`에 `{version, kind: "expand" | "contract", sql}` 배열로 둔다. bundle에 문자열로 들어간다.
- 기동 순서:

| 조건 | P1(PGlite) | P2·P3(pg) |
| --- | --- | --- |
| DB 버전 > 코드 버전 | 거부 `SCHEMA_NEWER`(현행 오류와 같은 이름, `trust-store.ts:223-229`) | 같다 |
| 코드 `version` < DB `min_client_version` | 거부 `CLIENT_SCHEMA_TOO_OLD` | 같다 |
| DB 버전 < 코드 버전, 남은 것이 모두 expand | 자동 적용 | 현재 역할이 schema 소유자이면 `pg_advisory_xact_lock(migration)` 안에서 자동 적용. 아니면 거부 `MIGRATION_REQUIRED`(「운영자가 `ags-service migrate`를 실행해야 함」). |
| contract가 남음 | 자동 적용 | 자동 적용하지 않는다. `ags-service migrate --contract`만 적용한다. 이 명령은 `ags_meta.instances`의 최근 heartbeat 중 `min_client_version`보다 낮은 클라이언트가 있으면 거부한다. |

런타임 역할에는 DDL 권한을 주지 않는다. 소유자 역할 판정은 `has_schema_privilege(current_user, 'ags_meta', 'CREATE')`로 한다(https://www.postgresql.org/docs/current/functions-info.html).

### 5.8 오류 코드

| 원인 | SQLite(현행) | PG SQLSTATE | AGS 사유 | 재시도 |
| --- | --- | --- | --- | --- |
| 쓰기 잠금 대기 초과 | errcode 5·6(`runtime/failure-diagnostics.mjs:51`) | `55P03` lock_not_available(`lock_timeout`) | `STORE_BUSY` | 하지 않음, `effect: none` |
| 직렬화 실패 | 해당 없음 | `40001` | `STORE_CONFLICT` | 하지 않음(5.3에서 SERIALIZABLE을 쓰지 않으므로 나오면 결함) |
| 교착 | 해당 없음 | `40P01` | `STORE_DEADLOCK` | 하지 않음, 결함으로 기록(잠금 순서 고정이므로) |
| 고유 키 충돌 | `SQLITE_CONSTRAINT_UNIQUE` | `23505` | 모듈의 기존 도메인 오류(예: `REQUEST_CONFLICT`) | 해당 없음 |
| 문장 시간 초과 | 해당 없음 | `57014` query_canceled | `STORE_TIMEOUT` | 하지 않음, 결과 불확실 아님(rollback됨) |
| 연결 실패·끊김 | 해당 없음 | `08xxx`, 소켓 오류 | `STORE_UNREACHABLE` | commit 응답 전이면 `STORE_RESULT_UNKNOWN`, 하지 않음 |
| 풀 획득 초과 | 해당 없음 | (드라이버 timeout) | `STORE_POOL_EXHAUSTED`, 진단에 `waitingCount` | 하지 않음, `effect: none` |
| 스키마 상위 | `SCHEMA_NEWER` | 같은 판정 | `SCHEMA_NEWER` | 해당 없음 |

SQLSTATE 목록: https://www.postgresql.org/docs/current/errcodes-appendix.html. 사유는 기존 `tagProducerFailure` 체계(`session-message-client.ts:6`)로 붙인다. 원문 메시지는 밖으로 내지 않는다(`session-message-service.ts:16-26`의 기존 규칙).

### 5.9 풀 설정과 진단

| HikariCP | 의미 | pg.Pool | 값(시작값) |
| --- | --- | --- | --- |
| `maximumPoolSize` | 최대 연결 | `max`(기본 10) | 4 |
| `minimumIdle` | 최소 유휴 | `min`(기본 0) | 0 |
| `connectionTimeout` | 획득 대기 | `connectionTimeoutMillis`(기본 0 = 무한) | 1,000. 요청별로는 4.5 표의 더 짧은 기한을 서비스 래퍼가 적용하고, 늦게 온 client는 바로 돌려준다. |
| `idleTimeout` | 유휴 연결 정리 | `idleTimeoutMillis`(기본 10,000) | 30,000 |
| `maxLifetime` | 연결 최대 수명 | `maxLifetimeSeconds`(기본 0 = 끔) | 1,800 |
| `keepaliveTime` | TCP keepalive | client `keepAlive` | true |
| `leakDetectionThreshold` | 반환 지연 경고 | 없음 | 서비스가 client 보유 시간이 `statement_timeout`의 2배를 넘으면 경고 |
| `connectionTestQuery` | 검사 쿼리 | 없음 | 두지 않는다. 유휴 client 오류는 `pool.on("error")`로 받아 기록한다. |

기본값 출처: https://node-postgres.com/apis/pool. 트랜잭션에는 `pool.query`를 쓰지 않는다. 같은 문서가 "Do not use pool.query if you are using a transaction"이라고 적는다. 여러 PC가 같은 PG를 쓰면 전체 연결 수는 PC 수 × 4다. 측정 4 결과로 PgBouncer(transaction 모드) 필요를 판단한다. 그때를 위해 세션 수준 상태(`SET`, 세션 advisory lock, prepared statement 이름)를 쓰지 않는다.

PGlite는 연결이 하나라 「풀」 자리에 대기열(4.3)이 온다. 획득 timeout 규칙은 같다.

**진단 노출.** 서비스는 다음을 `service.status` RPC와 `node ags-service.mjs status` 명령으로 돌려준다. 같은 값을 기존 진단 로그(`diagnostics.ts`)의 lifecycle 범주에도 남긴다.

- `pool.totalCount`, `pool.idleCount`, `pool.waitingCount`(위 문서)
- 대기열 길이, 대기 p50·p99, `SERVICE_BUSY` 거부 수
- 연결 수(role별), 서비스 버전·build·uptime, 모듈별 스키마 버전, 백엔드 종류

`STORE_POOL_EXHAUSTED`·`SERVICE_BUSY` 오류 응답의 `details`에도 그 순간의 `waitingCount`·대기열 길이를 넣는다. 막힌 원인이 도구 결과에 바로 보인다.

## 6. 이관(SQLite → PG, 일회성)

- **시점.** 2단계 서비스가 namespace를 처음 볼 때, PG의 그 schema가 비어 있고 원본 SQLite 파일이 있으면 한 번 실행한다. 사용자 명령 `ags-service import --dry-run`으로 미리 볼 수 있다.
- **dual-write 없음.** 이관 뒤 쓰기는 PG로만 간다.
- **원본 보존과 옛 버전 차단.** 행은 지우지 않는다. 복사와 검증이 끝나면 원본 파일의 `user_version`을 1000으로 올린다. 옛 버전(3.0.x, 1단계 3.1)이 이 파일을 열면 기존 「상위 스키마 거부」 규칙으로 실패한다(`sqlite-workflow-store.ts:776-781`, `trust-store.ts:222-229`, `continuity-store.ts:67-69`, `session-message-store.ts:260`, `board-store.mjs:53-64`). 다른 벤더 설치가 아직 옛 버전이어도 조용히 갈라진 기록을 만들지 않고 오류로 드러난다. 되돌리기는 `ags-service import --revert`가 `user_version`을 원래 값으로 돌린다.
- **복사 단위.** 모듈 하나를 PG 트랜잭션 하나로 복사한다. 원본은 `node:sqlite` 읽기 전용으로 연다(`trust-store.ts:192`과 같은 방식). 이관기 코드는 서비스 bundle 안에만 있다. 이것이 2단계 뒤 상태 경로에 남는 유일한 `node:sqlite` 쓰기 아닌 사용이다.

**옮기지 않고 초기화하는 일시 상태.**

| 테이블 | 이유 |
| --- | --- |
| `relay_leases`, `session_presence` | 살아 있는 relay·세션 세대다. 새 서비스 기동 뒤 hook이 다시 만든다. |
| `wake_nonces`, `wake_paths` | 진행 중 깨우기다. 메시지 자체는 `messages`에 남는다. |
| `peer_wait_snapshots` | 대기 판정 캐시다. |
| `call_admissions` | 한 번 claim하는 짧은 행이다. 하루 지나면 지운다(`sqlite-workflow-store.ts:196`). |
| `input_observations` | 깨우기 확인용 관측이다(추정: 용도 재확인 필요). |

`authority_time`은 옮긴다. 시간이 뒤로 가지 않게 하는 high-water이기 때문이다. `execution_observation_claims`·`state_cleanup_claims`는 옮긴다. 재사용 방지 기록이라 지우면 같은 관측을 다시 쓸 수 있게 된다. 나머지 테이블(workflow 대부분, continuity 6개, trust receipt, `messages`, `prepared_messages`, board)은 옮긴다.

**검증.** 테이블마다 원본과 대상의 행 수와 digest를 비교한다. digest는 기본 키 순으로 정렬한 행을 정규 JSON으로 만든 뒤 SHA-256이다. 정수는 10진 문자열로, 문자열은 그대로 정규화한다(5.4 int8). 하나라도 다르면 그 모듈 트랜잭션을 rollback하고 원본 `user_version`을 바꾸지 않는다. 결과(테이블, 원본 수, 대상 수, 두 digest, 원본 파일 digest)를 `ags_meta.imports`에 남긴다. source digest와 intent를 먼저 결속하는 방식은 unified-state의 아이디어를 따른다(`runtime/unified-state/README.md` 마지막 문단).

## 7. 단계와 커밋 단위

### 7.1 1단계: SQLite 유지, 프로세스 구조 변경

| 커밋 | 내용 | 소유 파일 | 선행 |
| --- | --- | --- | --- |
| 1-1 | IPC 주소·권한·줄 framing·hello/welcome/refuse, 클라이언트(`ensureService`, 기한, 결과 불확실 처리). 분리 실행 함수를 공용 모듈로 옮김 | 새 `mcp-server/src/service/ipc-endpoint.ts`, `ipc-framing.ts`, `service-client.ts`, `detached-launch.ts`; `session-message-hook.ts:186-233`(이동만) | 측정 2·3 |
| 1-2 | 서비스 프로세스: 소유자 잠금, listen, 연결 상한, 대기열, 유휴 종료, 버전 교체, `service.status` | 새 `mcp-server/src/service/ags-service.ts`, `service-main.ts` | 1-1 |
| 1-3 | 구성 분리: `index.ts`의 store·service 조립을 profile별 함수로 옮김. 서비스가 `role: "mcp"` 연결마다 `createMcpServer`를 붙임 | `index.ts`, 새 `service/compose.ts`, `server.ts`(인자만) | 1-2 |
| 1-4 | shim: `server.mjs` entry를 shim으로 바꿈. 재연결·initialize 재전송 | 새 `mcp-server/src/mcp-shim.ts`, `scripts/runtime-bundles.mjs` | 1-3 |
| 1-5 | messaging을 서비스로: `sessionMessageRequest`가 IPC를 쓰게 함. relay·cli·board-hook·session-message-hook이 자동으로 따라옴 | `session-message-client.ts`, `session-message-service.ts` | 1-2 |
| 1-6a | governance-hook → `workflow.recordCallAdmission` | `governance-hook.ts` | 1-3 |
| 1-6b | continuity-hook → `continuity.hook`, async 전환, 미도달 Stop 알림 | `continuity-hook.ts`, `continuity-service.ts`(호출부만) | 1-3 |
| 1-6c | session-board-hook → `board.*` | `session-board-hook.ts` | 1-5 |
| 1-6d | session-message-hook의 trust receipt → `trust.recordPeerSources` | `session-message-hook.ts:294-330` | 1-5 |
| 1-7 | agy runner·Claude launcher의 예산 연결과 시험 | `antigravity-connector/hooks/antigravity-hook-runner.mjs`, `claude-overlay/hooks/*.mjs` | 1-6a~d |
| 1-8 | bundle·생성물·문서. bundle 검사에 「hook·shim·relay·cli의 metafile에 store 파일이 없다」 추가 | `scripts/runtime-bundles.mjs`, `scripts/check-bundle.mjs`, `scripts/build-claude-plugin.mjs`(목록), `docs/architecture.md`, `docs/operations.md` | 1-7 |

1-6a~d는 파일 소유가 겹치지 않아 서브에이전트에 나눠 줄 수 있다. 1-5와 1-6d는 같은 hook 파일의 다른 부분이므로 같은 담당에게 준다.

**1단계 완료 조건.**

- `node:sqlite`를 불러오는 bundle이 `ags-service.mjs`뿐이다(용어집 제외). 1-8의 검사로 확인한다.
- 기존 시험이 모두 통과하고 9장의 1단계 시험이 추가되어 통과한다(ubuntu·windows·macOS).
- 실호스트 3종에서 단계 확인·현황판·peer 메시지 송신·깨우기가 서비스를 거쳐 동작한다.
- 세션 N개일 때 프로세스가 서비스 1 + shim N + relay N이다. 서비스가 연 SQLite 연결 수가 N과 무관하다.
- 서비스를 강제 종료하면 다음 이벤트에서 다시 뜨고, 그 사이 hook은 4.5 표대로 동작한다.

### 7.2 2단계: PG store

| 커밋 | 내용 | 소유 파일 | 선행 |
| --- | --- | --- | --- |
| 2-1 | store 포트, PGlite 어댑터, pg 어댑터, 오류 매핑, int8 파서, 대기열·풀 진단 | 새 `mcp-server/src/store/sql-store.ts`, `pglite-store.ts`, `pg-store.ts`, `store-errors.ts` | 측정 1·5 |
| 2-2 | 마이그레이션 실행기와 `ags_meta` | 새 `store/migrations/index.ts`, `store/migrations/meta.ts` | 2-1 |
| 2-3 | board store PG 전환(가장 작음) | `skills/session-board/scripts/board-store.mjs`(→ 새 `store/board-store.ts`로 이동), `store/migrations/board.ts` | 2-2 |
| 2-4 | trust store·service async | `trust-store.ts`, `trust-service.ts`, `store/migrations/trust.ts` | 2-2 |
| 2-5 | continuity store·service async | `continuity-store.ts`, `continuity-service.ts`, `store/migrations/continuity.ts` | 2-2 |
| 2-6 | workflow store·service async(가장 큼, 2151줄 서비스) | `sqlite-workflow-store.ts`(→ `store/workflow-store-pg.ts`), `workflow-store.ts`, `workflow-service.ts`, `state-cleanup-service.ts`, `plugin-update-store.ts`, `store/migrations/workflow.ts` | 2-2, 2-5(교차 트랜잭션) |
| 2-7 | messaging store async, 권위 시간 함수 | `session-message-store.ts`, `session-message-operations.ts`, `session-message-wake-port.ts`, `store/migrations/messaging.ts` | 2-4(wake reader가 trust를 읽음) |
| 2-8 | 서명 `keyId`, Ed25519, 키 파일 | 새 `mcp-server/src/signing.ts`, 2.2의 서명 4곳 | 2-4~2-7 |
| 2-9 | 이관기 | 새 `store/import-sqlite.ts` | 2-3~2-7 |
| 2-10 | pg 백엔드 설정(연결 설정 파일, TLS verify-full), `migrate` 명령 | `service/compose.ts`, 새 `service/backend-config.ts` | 2-8 |
| 2-11 | `node:sqlite` 상태 경로 제거, `InMemoryWorkflowStore` 대체 판단, inactive-shared-stores 정리 | `inactive-shared-stores.ts`, `runtime/unified-state/*`, `workflow-store.ts` | 2-9 |

2-3·2-4·2-5는 서로 겹치지 않아 병렬로 줄 수 있다. 2-6은 2-5의 교차 트랜잭션(`continuity-service.ts:217-221`)과 맞물려 2-5 뒤에 한다. 각 커밋은 그 모듈 시험을 PGlite와 실제 PG 양쪽에서 통과해야 끝난다.

**2단계 완료 조건.**

- 상태 경로에 `node:sqlite` 쓰기가 없다(용어집·소유자 잠금·이관기 읽기만 남음).
- 같은 store 시험 묶음이 PGlite(3 OS)와 실제 PG(Linux) 양쪽에서 통과한다.
- 실사용 상태 폴더 사본으로 이관해 행 수·digest가 모두 같고, 옛 버전이 원본을 열면 `SCHEMA_NEWER`로 실패한다.
- 서비스 두 개(PC 두 대 흉내)가 같은 PG를 쓸 때 서로의 receipt를 공개키로 검증하고, DB만 바꿔서는 서명을 만들 수 없다.
- 풀 고갈·잠금 대기·DB 끊김이 각각 다른 사유로 도구 결과와 `service.status`에 보인다.

## 8. 착수 전 측정

측정은 시험 서버(Linux)와 GitHub Actions(windows·macOS)에서 한다. 이 PC에서 제품 시험을 돌리지 않는다. 측정 코드는 `tests/measure/` 아래 일회성 스크립트로 두고 결과만 문서에 남긴다.

| 번호 | 측정 | 방법 | 결과에 따른 분기 |
| --- | --- | --- | --- |
| M1 | PGlite: 강제 종료 내구성, 3 OS wasm 적재, 메모리, 첫 초기화 시간 | 쓰기 반복 중 `SIGKILL`·`taskkill /F` 100회 → 다시 열고 행 수·무결성 확인. esbuild bundle + dist 옆 wasm로 3 OS 적재. RSS. 빈 `dataDir` 첫 `initdb` 시간 | 커밋된 행 손실·손상 1회라도 → A1 재판정(embedded-postgres 측정으로 전환). 적재 실패 OS가 있으면 그 OS만의 우회는 두지 않고 A1 재판정. 첫 초기화 > 5초 → 첫 기동을 SessionStart에서 기다리지 않고 미도달 동작으로 처리(4.2). |
| M2 | shim 메모리, IPC 왕복, 서비스 첫 기동 시간, Windows job 생존 | shim RSS(현행 서버 약 72MB와 비교). hello 포함 왕복 p50·p99. `ensureService` 냉기동 시간(Windows는 `Start-Process` 포함). Codex·Claude hook에서 띄운 서비스가 그 호스트 종료 뒤에도 사는지 | 왕복 p99 > 50ms → hook 예산표(4.5)를 다시 계산. 냉기동이 hook 예산을 넘으면 SessionStart도 기다리지 않음. job과 함께 죽으면 Windows 기동을 job 밖 경로(예: `Win32_Process.Create`, 추정)로 바꾸고 다시 측정. |
| M3 | Windows named pipe 기본 DACL, Node에서 제한 방법 | 다른 로컬 사용자로 연결·쓰기·같은 이름 선점 시도. libuv가 첫 인스턴스 플래그를 쓰는지, 원격(SMB) 클라이언트를 거부하는지 | 다른 사용자가 쓰기 가능하거나 선점 가능 → 사용자 전용 폴더(0600)의 무작위 키로 hello에 challenge-response를 더한다. 읽기만 가능 → hello 1초 제한(4.3)으로 충분. |
| M4 | 동시 세션 수, hook 빈도, 대기열 p99 | 실사용 PC 하루치 hook 실행 횟수(진단 로그 집계). 37세션 재현 부하로 대기열 대기 p99, PGlite 단일 연결 처리량 | p99 > 대기열 상한(1초) → 모듈 잠금을 행 단위로 나누는 검토(5.3 주의 사항 포함). PC당 연결 4가 부족하면 `max` 조정. 여러 PC 합이 PG 한도에 가까우면 PgBouncer. |
| M5 | 벤더 3곳 dist 크기 증가, 설치, 버전 엇갈림 | PGlite 포함 dist로 Claude 마켓플레이스·Codex 로컬 마켓플레이스·`agy plugin install` 설치. git 저장소 크기 증가(dist가 커밋되고 Claude 사본이 하나 더 있음, `scripts/build-claude-plugin.mjs:44`). 3.1과 3.0.2를 섞어 설치하고 교체 규칙(4.2) 확인 | 설치가 wasm 파일을 빠뜨리거나 크기 제한에 걸리면 → 그 벤더 배포 방식 조사 후 A1 재판정. 버전 섞임에서 교체 반복이 보이면 4.2 규칙 수정. |

M1·M5 결과가 나오기 전에는 2단계 커밋을 시작하지 않는다. M2·M3 결과가 나오기 전에는 1-1을 끝내지 않는다.

### 8.1 측정 결과(11-02)와 설계 반영

Linux 시험 서버(vCPU 2, 7.8G, Node 24.22.1)와 Windows 시험 서버(Server 2022 20348, Node 24.22.2, Defender 실시간 검사 켬)에서 PGlite 0.5.14로 쟀다. 스크립트는 `tests/measure/linux/`, `tests/measure/windows/`, 결과 원본은 각 서버의 `measure-dbms-20261102/logs/`, `C:\ags-measure-dbms\results\`다. macOS와 M5는 아직 재지 않았다.

| 항목 | 결과 | 분기 판정과 설계 반영 |
| --- | --- | --- |
| M1 강제 종료 | Linux SIGKILL 100회(쓰기 중 76): 열기 실패·손실·손상 0. Windows `taskkill /F` 100회(쓰기 중 92): 0·0·0, 최종 146,437행 연속, `bt_index_check`·`verify_heapam` 통과. 첫 initdb 중 kill 20회도 20/20 다시 열림 | A1 유지. 전원 차단·OS 비정상 종료는 재지 않았다(페이지 캐시가 남음). |
| M1 동시 열기 | 같은 dataDir를 두 프로세스가 열면 오류가 없다. A가 B 이후 보고한 커밋(1,141·1,231·1,221건)이 다시 열면 모두 사라졌다. 3/3 재현, 무결성 검사는 통과 | PGlite에는 잠금이 없다. 서비스는 `owner.lock`(4.2)을 잡은 뒤에만 PGlite를 연다. 이관기·`migrate` 명령도 같은 잠금을 잡는다. 시험: 잠금 없이 두 번째 열기를 시도하는 경로가 코드에 없음을 bundle 검사로, 두 번째 서비스가 `SERVICE_ALREADY_RUNNING`으로 끝남을 통합 시험으로 확인한다. |
| M1 첫 초기화 | Linux 4.0~4.2초, Windows 6.3~6.4초. 다시 열기 Linux 0.25초, Windows p50 0.9초 | Windows가 5초를 넘는다. 첫 초기화는 SessionStart에서 기다리지 않는다(4.2 분기). initdb는 서비스가 아닌 짧은 자식 프로세스에서 하고 끝낸다. initdb를 한 프로세스는 RSS가 568MB로 남았고, 다시 연 프로세스는 314MB였다. |
| M1 메모리 | 기본 `shared_buffers=128MB`: 다시 연 뒤 RSS 314~360MB. `postgresqlconf`로 `shared_buffers=16MB, work_mem=1MB, maintenance_work_mem=8MB, wal_buffers=1MB`: 186~241MB. 2천 건 쓰는 동안 최대치(VmHWM)는 두 설정 모두 700~850MB로 올랐다(원인 미확인). `initialMemory`는 128MB 미만이면 LinkError | 위 저메모리 설정을 기본으로 둔다. 이 설정은 dataDir의 `postgresql.conf`에 남는다(설정 없이 다시 열어도 16MB). 상주 약 0.2GB와 일시 최대 약 0.7GB는 현행(세션당 72MB)보다 세션이 적을 때 크다. 11장 미해결에 둔다. |
| M1 적재 | esbuild 단일 `.mjs`(641~658KB) 옆에 `pglite.wasm` 9.1MB, `pglite.data` 6.2MB, `initdb.wasm` 0.3MB. 두 OS 모두 적재 성공. `contrib/amcheck`는 `../amcheck.tar.gz`를 찾는다 | dist에 세 파일을 둔다. amcheck는 제품에 넣지 않는다(시험 전용). |
| M1 int8 | 안전 정수 안이면 `number`, 넘으면 `bigint`. 한 열에 섞여 나온다 | 5.4대로 int8 파서를 하나 두어 한 타입으로 고정한다. |
| M2 왕복 | Linux 연결+hello+요청 p50 0.34ms, p99 1.27ms. 연결 유지 p99 0.20ms. Windows pipe p50 0.40ms, p99 1.43ms. 연결 유지 p99 0.21ms | 50ms보다 훨씬 작다. 4.5 예산표 유지. |
| M2 냉기동 | Linux detached spawn → 첫 응답 p50 56ms, PGlite 기존 dataDir 포함 p50 768ms·p99 1.57초, initdb 포함 4.77초. Windows ShellExecute 중앙값 1.31초(최대 3.23초), CIM 0.75초(최대 3.02초) | 5초 hook(IPC 1.5초)은 서비스를 띄우지 않는다는 4.2 표 유지. |
| M2 job 생존(D7) | KILL_ON_JOB_CLOSE job 안의 호스트가 ShellExecute로 띄운 서비스는 job이 닫히면 죽었다. CIM `Win32_Process.Create`로 띄운 서비스는 job 밖에서 살았다. 실제 sshd 세션 job(flags `0x2800`)에서도 같았다. CIM으로 띄운 프로세스는 호출자 환경 변수를 물려받지 않는다(부모 WmiPrvSE) | D7 확정. Windows 서비스 기동은 CIM `Win32_Process.Create`로 한다. 서비스에 필요한 값(상태 폴더 등)은 명령줄 인자로, 연결별 값은 hello profile로 보낸다. 서비스는 `AGENT_GOVERNANCE_*` 환경 변수를 읽지 않는다. 호스트별 실제 job flag는 재지 않았다(흉내만). |
| M2 shim | Linux 최소 shim RSS 47.5MB(빈 node 42.7MB) | 세션당 약 25MB 줄어든다. |
| D2 잠금 | Windows 소유자 `taskkill /F` 50회: 50/50 첫 시도에 잠금 획득, p50 90ms. 살아 있는 동안 50/50 `database is locked` | D2 유지. |
| M3 pipe | 기본 SDDL `D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;BA)(A;;FR;;;WD)(A;;FR;;;AN)`. 다른 사용자는 읽기 전용 연결만 되고 쓰기·새 인스턴스는 err=5. 그러나 서비스보다 먼저 같은 이름을 만들 수 있었다. 그러면 서비스는 `EADDRINUSE`로 끝나고, 클라이언트는 선점자에 연결되어 hello·profile을 그대로 보냈다. libuv는 첫 인스턴스에만 `FILE_FLAG_FIRST_PIPE_INSTANCE`를 쓰고 `PIPE_REJECT_REMOTE_CLIENTS`는 쓰지 않는다(https://raw.githubusercontent.com/libuv/libuv/v1.52.1/src/win/pipe.c) | 클라이언트가 서비스를 확인해야 한다. 4.3 「접속 정보와 상호 확인」으로 반영한다. |
| M4 부하 | 37연결, PGlite 연결 하나 앞 FIFO, 요청 하나 = 삽입 3 + 갱신 1. 800rps까지 손실·`SERVICE_BUSY` 0, 서비스 측 대기 p99 0.98ms, 클라이언트 왕복 p99 66.7ms. 1600rps에서 처리량 967/s, 클라이언트 왕복 p50 1.6초, `SERVICE_BUSY` 32.6%. 서비스 측 대기열 길이는 최대 1이었다 | 실사용 부하(hook 이벤트당 1회)보다 여유가 크다. 행 단위 잠금 검토 조건에 해당하지 않는다. PGlite가 같은 스레드에서 돌아 이벤트 루프가 막히는 동안 요청이 소켓 버퍼에서 기다려 서비스 측 대기열 지표에 보이지 않았다(추정). 진단에 `perf_hooks.monitorEventLoopDelay`의 p99·최대를 더하고, 대기열 대기가 아니라 「요청 수신부터」 시간을 잰다(5.9). 부하 발생기가 같은 서버에서 돌아 절대값에 영향이 섞였다. |

## 9. 시험

모든 시험은 고치기 전 코드에서 실패하는 것을 먼저 확인한다(red-green).

**1단계.**

- IPC: 경로 길이 초과, hello 시간 초과, 프로토콜 거부, 16 MiB 초과 줄, 연결 상한, 대기열 상한 `SERVICE_BUSY`, 기한 지난 요청 미실행.
- 단일 인스턴스: 두 서비스 동시 기동 → 하나만 남음. 서비스 `SIGKILL` 뒤 남은 socket 파일이 있어도 새 서비스가 뜸. 소유자 잠금 없이 socket을 지우는 경로가 없음.
- 교체: 높은 버전 클라이언트 → handover. 낮은 버전 → 교체 없음. 같은 버전·다른 digest → 교체 없음. 두 버전 번갈아 연결 → 교체 1회.
- shim: 서비스 재시작 중 진행 요청은 `SERVICE_RESULT_UNKNOWN`, 다음 요청에서 initialize 재전송 뒤 정상. `_meta`가 바뀌지 않고 서비스에 도착.
- hook 미도달: governance-hook 거부, Stop 알림 1회와 `stop_hook_active` 억제, board 통과, peer receipt 미발급·메시지 미주입, relay 미기동.
- 결과 불확실: 쓰기 요청 응답 전 끊김 → 재전송 없음. 읽기 요청 → 한 번 재전송.
- profile: Claude namespace와 Codex namespace가 서로의 workflow 행을 보지 않음. 설치마다 다른 registry를 씀.

**2단계.**

- 같은 store 시험 묶음을 백엔드 인자로 두 번 돈다. PGlite는 ubuntu·windows·macOS 행렬, 실제 PG는 ubuntu 작업의 PostgreSQL 서비스 컨테이너(GitHub Actions)와 시험 서버의 원격 PG(TLS verify-full)다. CI 행렬에 `macos-latest`를 더한다(G8).
- 경합: 같은 모듈에 동시 쓰기 2~16개, 용량 경계(`session-message-store.ts:570-580`)에서 한도 초과가 없음. 교차 트랜잭션 잠금 순서에서 교착 0.
- 시간: 잠금을 기다린 트랜잭션의 시각이 앞 트랜잭션보다 작지 않음(D4). 시계를 뒤로 돌린 PC 흉내에서 high-water 유지.
- 오류: `lock_timeout`·`statement_timeout`·풀 고갈·연결 끊김을 각각 일으켜 5.8 사유가 나옴.
- 마이그레이션: 상위 버전 거부, `min_client_version` 거부, 비소유자 역할 `MIGRATION_REQUIRED`, contract 자동 적용 안 함, 동시 기동 두 서비스가 expand를 한 번만 적용.
- 서명: PGlite HMAC `keyId` 왕복, Ed25519 두 서비스 상호 검증, 키 파일 동시 생성 경합, 공개키만 바꾼 행으로는 기존 서명 검증 실패.
- 이관: 실사용 사본 이관 → 행 수·digest 일치, 일시 상태 초기화, 원본 `user_version` 1000, 3.0.2 bundle이 원본을 열면 실패, `--revert` 뒤 다시 열림. 중간 실패 시 원본 미변경.
- int8·`COLLATE "C"`: 2^53 경계 값 거부, ISO 시각 문자열 정렬이 바이트 순서와 같음.

**실호스트.** Claude Code(Windows·Linux), Codex(Windows), agy(Linux)에서 개발가이드 「테스트 서버 시험 방법」대로 1단계·2단계 각각 다음을 본다. 단계 확인 출력, 현황판, peer 메시지 송신과 유휴 깨우기, 서비스 강제 종료 후 복구, 두 벤더 설치 버전 섞임. 대상 commit·명령·종료 코드를 기록한다.

## 10. 바꾸는 파일과 의존성

### 10.1 파일

- 새 파일: `mcp-server/src/service/`(`ipc-endpoint.ts`, `ipc-framing.ts`, `service-client.ts`, `detached-launch.ts`, `ags-service.ts`, `service-main.ts`, `compose.ts`, `backend-config.ts`), `mcp-server/src/mcp-shim.ts`, `mcp-server/src/store/`(`sql-store.ts`, `pglite-store.ts`, `pg-store.ts`, `store-errors.ts`, `import-sqlite.ts`, `board-store.ts`, `migrations/*.ts`), `mcp-server/src/signing.ts`.
- 바꾸는 파일: `index.ts`, `server.ts`(인자), `session-message-client.ts`, `session-message-service.ts`, `session-message-hook.ts`, `session-board-hook.ts`, `governance-hook.ts`, `continuity-hook.ts`, 4개 store와 그 service, `state-cleanup-service.ts`, `plugin-update-store.ts`, `session-message-operations.ts`, `session-message-wake-port.ts`, `inactive-shared-stores.ts`, `antigravity-connector/hooks/antigravity-hook-runner.mjs`, `claude-overlay/hooks/*.mjs`(필요한 곳만), `skills/session-board/scripts/board-store.mjs`(이동), `scripts/runtime-bundles.mjs`, `scripts/check-bundle.mjs`, `scripts/build-claude-plugin.mjs`, `.github/workflows/ci.yml`, `package.json`, `docs/architecture.md`, `docs/operations.md`.
- 바꾸지 않는 파일: 호스트 설정(`.mcp.json`, `claude-plugin/.claude-plugin/plugin.json`, `mcp_config.json`, `hooks/hooks.json`, `claude-plugin/hooks/hooks.json`). entry 경로가 그대로이기 때문이다.
- 생성물: `npm run build`, `npm run claude:build`.

### 10.2 의존성과 bundle

현재 bundle은 esbuild가 entry마다 `bundle: true, platform: "node", format: "esm", target: "node24"`로 만들고(`scripts/runtime-bundles.mjs:164-186`), metafile에 든 패키지의 라이선스로 `runtime/THIRD_PARTY_NOTICES.md`를 만든다(`:127-162`). dist는 git에 커밋되고(`git ls-files` 10개, 약 2.5MB) Claude 사본이 하나 더 있다(`scripts/build-claude-plugin.mjs:44`). 설치에 postinstall 단계가 없다.

| 패키지 | 단계 | bundle 방식 |
| --- | --- | --- |
| 없음 | 1단계 | 새 entry 하나(`ags-service.mjs`, `RUNTIME_BUNDLES`에 추가). `server.mjs` entry를 `mcp-shim.ts`로 바꾼다. 의존성 추가 없음. |
| `@electric-sql/pglite`(0.5.14, unpacked 26,362,217B, 의존성 0, postinstall 없음 — dossier V2) | 2단계 | JS는 `ags-service.mjs`에 bundle한다. wasm·data 파일은 bundle할 수 없으므로 `mcp-server/dist/pglite/`로 복사하고 `pgliteWasmModule`·`initdbWasmModule`·`fsBundle`로 넘긴다(5.2). 복사할 파일 이름은 0.5.14 패키지에서 확인한다(추정: `pglite.wasm`, `initdb.wasm`, `pglite.data`). `RUNTIME_ARTIFACTS`에 넣어 `check-bundle.mjs`가 같은지 검사하게 한다. wasm은 metafile에 없으므로 notice 생성기가 PGlite 패키지를 JS 입력으로 잡는지 확인한다. |
| `pg`(node-postgres) | 2단계 | 순수 JS라 `ags-service.mjs`에 bundle한다. 선택 의존 `pg-native`는 `external`로 둔다(추정: 그 밖의 선택 import도 확인). |

hook·shim·relay·cli bundle에는 두 패키지가 들어가지 않는다. 1-8의 검사가 막는다. 1단계 뒤 hook bundle은 store 코드가 빠져 지금(약 140~170KB)보다 작아진다(추정).

## 11. 관측하지 못하는 것과 미해결

**관측하지 못하는 것.**

- 서비스는 다른 프로세스의 OS 사용자를 확인하지 못한다. Node `net`에 상대 자격 증명 API가 없다(Node 문서에서 찾지 못함). 신뢰 경계는 「같은 OS 사용자」이고 폴더 권한·pipe DACL로만 막는다.
- MCP 호스트의 도구 timeout. 서비스 기본 30초가 그보다 긴지 모른다.
- PGlite는 같은 `dataDir`를 두 프로세스가 여는 것을 막지 않고, 이때 커밋이 조용히 사라진다(8.1 M1에서 확인). 소유자 잠금(4.2)만이 이를 막는다.
- 전원 차단·OS 비정상 종료 뒤 PGlite 내구성. 측정은 프로세스 강제 종료만 했다.
- 호스트(Claude Code·Codex)가 실제로 쓰는 Windows job flag. 측정은 흉내였다.
- Codex·agy Stop 입력에 `stop_hook_active`가 있는지(4.5).

**미해결.**

- 원격 MCP 인증 방식(4.7). OAuth 기반 MCP 인증, 정적 토큰, mTLS 중 무엇을 쓸지 정하지 않았다. 원격 서비스 모드를 만들 때 정한다.
- 서비스 수명 세부. 유휴 10분은 시작값이다. Linux logind `KillUserProcesses=yes` 환경에서 로그아웃 때 서비스가 끝나는지, macOS에서 터미널 종료와 무관한지 확인하지 않았다(추정: detached면 남음).
- 서비스가 실행 중인 설치가 업데이트·삭제될 때. 다음 shim이 높은 버전이면 교체되지만, 같은 버전 재설치는 교체하지 않는다(4.2).
- 낮은 버전 shim을 높은 버전 서비스가 받을 때 도구 목록은 서비스 코드 기준이다. registry는 클라이언트 설치 것이다. 두 버전 사이에 도구 계약이 바뀌면 `minClientProtocol`을 올려 거부해야 한다. 어떤 변경을 프로토콜 변경으로 볼지 규칙이 아직 없다.
- `input_observations`를 일시 상태로 볼지(6장).
- PgBouncer 도입 기준(M4).
- 로컬 PGlite 메모리(8.1 M1). 저메모리 설정으로 상주 약 0.2GB, 쓰기 중 일시 최대 약 0.7GB다. 세션이 1~3개인 사용자는 현행보다 메모리를 더 쓴다. 일시 최대의 원인을 찾지 못했다. 2단계 착수 전에 macOS 측정과 함께 다시 판정한다. 대안은 embedded-postgres(첫 기동 다운로드·포트·고아 프로세스 대책 필요)다.
- 원격 PG 연결 설정 파일의 비밀번호 보관 방식(설정 파일 0600 참조 경로 또는 `PGPASSFILE`). 서비스 한 곳에만 둔다는 원칙만 정했다. node-postgres TLS 설정: https://node-postgres.com/features/ssl, libpq `verify-full` 의미: https://www.postgresql.org/docs/current/libpq-ssl.html.
