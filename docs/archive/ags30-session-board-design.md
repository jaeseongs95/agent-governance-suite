# AGS 3.0 현황판 재설계

- 상태: 설계안 r1(2026-11-01). 구현 전이다.
- 근거: 사용자 지시 「현황판도 다시 만들자. 처음부터 설계하고, 개발 및 테스트해줘.」「이참에 현황판도 초기화해줄래?」, 사용자 관측 「pc에 떠있는 codex 세션은 없어. 그건 현황판에만 그렇게 나와있을거야」
- 결함: AGS-D-0187(상위), D-0318, D-0282, D-0016, D-0181, D-0184, D-0018. 의존 결함: D-0351.
- 줄 번호는 `4b2dc571`(깨우기 재설계 r3.2 포함) 기준이다. 선행 설계: `docs/ags30-wake-doorbell-design.md`.

## 1. 목표와 비목표

**목표.** 한 컴퓨터에서 어느 세션이든 다음 네 가지를 볼 수 있어야 한다. 병합·push·릴리스·설치가 서로 부딪히지 않게 하는 것이 목적이다.

1. 지금 실제로 실행 중인 다른 세션
2. 그 세션이 일하는 곳(cwd, 저장소, 브랜치)
3. 그 세션이 하는 일(한 줄)
4. 그 세션을 깨울 수 있는지

**비목표.** 현황판은 승인 관문이 아니다. 무엇도 거부하지 않는다. 현황판을 쓸 수 없으면 그 사실만 보고한다.

## 2. 현재 코드의 문제 (직접 확인)

| # | 문제 | 근거 |
|---|---|---|
| P1 | 끝난 세션도 요약만 있으면 24시간 동안 목록에 남는다. 사용자가 본 「떠 있지 않은 Codex 세션」이 이것이다. | `server.ts:328` 필터가 `summary !== null`인 행을 presence와 관계없이 보여 준다. `board-store.mjs:120-124`는 `updated_at` 24시간 창이다. |
| P2 | `stale`은 생존 여부가 아니다. "요약이 마지막 prompt보다 오래됐다"는 뜻일 뿐이다. prompt 기록이 없으면 요약을 한 번 쓴 뒤로 영구히 false다. | `board-store.mjs:109`(view의 `stale`). agy에는 prompt 경로가 없다(`antigravity-hook-runner.mjs:17-24` 이벤트 목록, `:730` PreInvocation을 SessionStart로 매핑). |
| P3 | 같은 세션에 대한 진실이 둘이다. board 행(`sessions`)과 메시징 presence(`session_presence`)가 따로 있고, 서버가 3개씩 묶어 둘을 이어 붙인다. | `server.ts:240-277`(unknownPresence·withPresence), `session-message-service.ts:107-136`, `session-message-protocol.ts:37`(=3) |
| P4 | 현황판 파일에 쓸 수 없으면 현황판 도구가 거부된다. governance hook이 board hook을 fail-closed로 부르기 때문이다. | `governance-hook.ts:105-107`(`failClosed=true`), `:171-176`(deny + exit 2) |
| P5 | 실행 경로가 없는 코드와 일만 하는 hook 등록이 남아 있다. | `board-store.mjs:81-92` `gateDecision`, `:131-141` `isReadOnlyCommand`는 src 호출처가 0이다(D-0282의 잔재). 일반 도구 PreToolUse에 board hook을 등록했지만(`hooks/hooks.json:139-148`, `claude-overlay/hooks/hooks.json:117-125`) hook은 DB만 열고 아무것도 하지 않는다(`session-board-hook.ts:78-79`). agy도 모든 단계에 board stage를 붙인다(`antigravity-hook-runner.mjs:1581·1617-1618`). |
| P6 | 요약은 PreToolUse hook이 쓰고 서버는 다시 읽기만 한다. 신원이 서버 쪽 proof로 이미 검증되므로(`server.ts:625-633`) 이렇게 쓰기와 읽기를 나눌 이유가 없다. 오히려 실패 지점이 둘이 된다. | `session-board-hook.ts:68-76`, `server.ts:303-307`·`332-337` |
| P7 | 「어디서」가 cwd뿐이다. 저장소와 브랜치는 모델이 요약에 직접 쓰기를 기대한다. | `SKILL.md:16`, `board-store.mjs:22-32` |

D-0016·D-0181·D-0184에서 지적한 원인 누락은 현재 board hook에서 해소된 것으로 보인다. consume-wake 원인은 `session-board-hook.ts:119`, host 해석 실패는 `:169`, stdout 오류는 `:157-165`에서 처리한다. 새 hook에도 이 처리를 그대로 남긴다.

## 3. 결정

### D1. 생존 여부의 정본은 메시징 presence 하나다
- 현황판은 생존을 저장하지 않는다. 표시 상태는 presence의 `state`(`session-message-store.ts:1519`)를 이름 그대로 쓴다.
- presence 갱신은 이미 이렇게 동작한다.
  - relay가 5초마다 lease를 갱신한다(`session-message-relay.ts:14·76`). lease는 20초다(`session-message-store.ts:64`).
  - 부모 프로세스가 죽으면 relay가 `presence-end host-process-ended`를 보낸다(`session-message-relay.ts:60·239`).
  - relay까지 죽으면 lease가 끝나 20초 안에 `unreachable`이 된다.

| 표시 | 조건 | 목록 |
|---|---|---|
| `online` | 최신 출생, `ended_at IS NULL`, `lease_until > now` | 보인다 |
| `unreachable` | 최신 출생, `ended_at IS NULL`, `now − 10분 < lease_until ≤ now` | 보이지만 「실행 중」이라고 하지 않는다. `lastSeenAt`을 붙인다. |
| `ended`, 또는 10분 넘은 `unreachable` | — | 다른 세션 목록에는 나오지 않는다 |
| 호출한 세션 자신 | 위 상태 중 무엇이든, 또는 `unknown` | 항상 첫 행이다. 자기 relay 이상을 알 수 있다. |

- `UNREACHABLE_VISIBLE_MS = 10분`. relay만 죽고 host는 살아 있을 수 있다. 그래서 바로 지우지 않고, 24시간 남기지도 않는다(P1).
- 요약이 있어도 presence가 위 조건을 만족하지 못하면 목록에 넣지 않는다. 이것이 P1의 수정이다.

### D2. 현황판 저장소는 「한 줄 요약과 prompt 표식」만 갖는다
새 표 하나만 둔다.

```sql
CREATE TABLE board_sessions (
  host TEXT NOT NULL, session_id TEXT NOT NULL,
  cwd TEXT,               -- hook이 본 작업 디렉터리(최신)
  summary TEXT, summary_at TEXT,
  last_prompt_at TEXT,    -- 사용자 prompt 시각(본문은 저장하지 않음)
  seen_at TEXT NOT NULL,  -- 보관 기한 계산에만 쓴다
  PRIMARY KEY (host, session_id)) STRICT;
```

- 빠지는 열:
  - `started_at`: presence에 있다.
  - `denied_for`: gate를 지운다.
  - `updated_at`: `seen_at`으로 바뀐다.
- 보관: `seen_at`이 7일 지난 행은 prompt hook과 요약 갱신 때 지운다. 표시 여부와는 관계없고, 파일 크기를 묶어 두는 용도일 뿐이다.
- `last_prompt_at`은 남긴다. 분류 gateway가 작업 표식으로 쓰기 때문이다(`index.ts:155-161`, `skill-classification/gateway.ts:164-165·190-192`). 이 함수는 동기라서 broker 소켓으로 대신할 수 없다. 그래서 요약도 로컬 파일에 둔다. presence 표에 붙이지 않는 이유가 이것이다.
- 요약 신선도: `summaryStale = last_prompt_at == null ? null : (summary_at == null || summary_at < last_prompt_at)`.
  - prompt 관측이 없는 host(agy)는 false가 아니라 `null`(모름)로 보고한다(P2).

### D3. 쓰는 곳은 둘이다
1. **prompt hook(`session-board-hook.ts`).** main 세션의 사용자 입력에서만 동작한다.
   - `cwd`, `seen_at`, `last_prompt_at`을 upsert한다.
   - broker가 확인한 깨우기 입력(`consume-wake`, `:105-124`)이면 `last_prompt_at`을 바꾸지 않는다. 깨우기 설계 2.2의 `consumeWake` 소비처다.
   - 실패해도 보고만 하고 통과시킨다(현재 `runSessionBoardHook` 방식).
   - SessionStart와 PreToolUse 분기(`:46-50·55-59·66-79`)는 지운다.
2. **MCP 서버 `update_session_status`.** 서버가 검증한 binding(`server.ts:625-633`)으로 직접 upsert한다.
   - 파일이 없으면 만든다. "도구는 파일을 만들지 않는다"는 규칙(`server.ts:303`)은 지운다.
   - governance hook의 board 분기(`governance-hook.ts:9·17·105-107`)는 지운다. 현황판 도구에는 다른 도구와 같은 root proof만 붙는다.
   - 메인 세션만 쓸 수 있다는 조건은 그대로다. `governance-hook.ts:95-96`(actorAccess 거부)과 `server.ts:626`(호출자가 넣은 `_sessionBinding` 거부)이 지킨다.
   - 결과: 현황판에 쓸 수 없어도 도구가 거부되지 않는다. 서버가 `MCP_UNAVAILABLE {step, cause}`를 돌려준다(P4·P6).

### D4. 읽기는 broker 한 번 + 로컬 파일 한 번이다
- 새 broker 연산 `list-current-presence {self}`를 둔다.
  - D1 조건을 만족하는 최신 출생을 `heartbeat_at` 내림차순으로 돌려준다. `self`는 상태와 관계없이 맨 앞에 둔다.
  - 행 하나는 압축형이다: `host, sessionId, state, startedAt, heartbeatAt, leaseUntil, workspaceId, transport, autoWake{state,reason,basisAt}`.
  - 응답이 28 KiB에 닿을 때까지만 담고 나머지는 `truncated`로 센다. 응답 상한은 32 KiB다(`session-message-protocol.ts:34`). D-0318 재발을 막는다.
- 대상 없는(untargeted) `list-presence`(`session-message-store.ts:1540-1542`)는 src 호출처가 없다. 이 모드를 지우고 `targets`를 필수로 만든다. hook의 targeted 호출(`session-message-hook.ts:529`)은 그대로다.
- `SessionMessageService.listPresence`의 3개 묶음 처리(`session-message-service.ts:104-136`)와 `server.ts:240-277`은 지운다.
- 서버는 받은 행의 (host, sessionId)로 `board_sessions`를 읽어 이어 붙인다.
  - `cwd = board.cwd ?? presence.workspaceId`
  - 저장소와 브랜치는 읽는 시점에 cwd에서 구한다(D5).
- 실패 처리:
  - broker가 응답하지 않으면 `MCP_UNAVAILABLE {step:"presence"}`를 돌려준다. board 행으로 대신하지 않는다. 생존 여부를 모르기 때문이다.
  - board 파일을 읽지 못하면 목록은 그대로 돌려준다. 이때 `summary`는 null이고 `board: {status:"unavailable", step, cause}`를 붙인다.
- broker 프로토콜 버전은 깨우기 재설계와 같은 3.0 변경에서 올린다(`session-message-protocol.ts:1`).

### D5. 「어디서」는 git 파일을 읽어 구한다(프로세스 실행 없음)
- 순서:
  1. cwd에서 위로 올라가며 `.git`을 찾는다(최대 64단계).
  2. `.git`이 디렉터리면 그것이 gitdir이다. 파일이면 `gitdir:` 줄이 가리키는 곳이 gitdir이다.
  3. gitdir의 `HEAD`를 읽는다(최대 1 KiB). `ref: refs/heads/X`이면 `branch=X`, 아니면 `branch=null`이다.
  4. gitdir의 `commondir`이 있으면 그것을 해석해 `repoId`로 쓴다. 없으면 gitdir realpath가 `repoId`다.
- `repoId`가 같으면 같은 저장소다. 다른 worktree도 같다고 판정된다(`SKILL.md:28` 요구).
- 오류가 나면 `repo: null`이다. 경로·브랜치 외의 내용은 읽지도, 내보내지도 않는다.
- 브랜치는 세션 중에 바뀐다. 그래서 저장하지 않고 읽는 시점에 구한다.

### D6. 초기화(사용자 요청)와 DB 변환
3.0은 2.x 현황판 데이터를 옮기지 않는다. 새 현황판은 비어 있는 상태에서 시작한다.

- **단독 파일** `session-board.sqlite3`(`runtime-config.ts:132-141`). 경로는 바뀌지 않는다. `openBoard`가 한 IMMEDIATE 트랜잭션 안에서 다음을 처리한다.

| 파일 상태 | 처리 |
|---|---|
| `user_version = 0`이고 표 목록이 `{}`나 `{sessions}` | `DROP TABLE IF EXISTS sessions` → `board_sessions` 생성 → `user_version = 1` |
| `user_version = 1`이고 표 목록이 `{board_sessions}` | 그대로 연다(멱등) |
| 그 밖의 표가 있거나 `user_version`이 다르다 | `BOARD_FOREIGN_DATABASE`로 거부한다. 파일은 건드리지 않는다. env `AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH`가 다른 DB를 가리킨 경우도 이 경로로 막힌다. |

- **공유(unified, 현재 fixture-only) DB.**
  - board 모듈을 `{version: 1, tables: ["board_sessions"]}`로 올린다(`shared-connection.mjs:14`).
  - 이전 형식을 허용하는 `PREVIOUS_MESSAGING`(`:16-17`, `:107-118`)을 모듈별 `PREVIOUS` 표로 일반화한다. 대상은 messaging v2와 board v0(`["sessions"]`)이다.
  - board initialize에서 `DROP TABLE IF EXISTS sessions` 뒤에 새 표를 만들고 `setSchemaVersion(1)`을 한다.
- **다른 데이터를 건드릴 수 없는 근거.**
  1. 단독 모드에서 workflow·continuity·trust·messaging은 다른 파일이다(`runtime-config.ts:26-34·70-79·83-94·119-125`). 표 목록 검사가 다른 파일에 쓰는 것을 막는다.
  2. 공유 모드에서 `sessions`라는 이름은 board 모듈에만 있다(`shared-connection.mjs:10-14`). DROP은 그 이름 하나로 고정된다.
  3. owner의 initialize는 한 트랜잭션이다. 끝에 `#validate`가 모든 모듈의 `schema_json`과 표 목록을 다시 비교하고, 다르면 rollback한다(`:120-129`, `:111-115`).
  4. borrow는 연결 제어 SQL을 막는다(`:165`).
  5. 시험 U2로 고정한다.

### D7. 지우는 것(현황판에서만)
- `board-store.mjs`: `gateDecision`, `isReadOnlyCommand`, `READ_ONLY_*`, `touchSession`(upsert 하나로 합친다), 24시간 `listSessions`, view의 `stale`·`startedAt`·`updatedAt`
- `session-board-hook.ts`: start·tool-boundary 분기, board 도구 deny(governance hook과 중복)
- hook 등록:
  - `hooks/hooks.json:31-40`(SessionStart board 항목)과 `:139-148`(PreToolUse board)
  - `claude-overlay/hooks/hooks.json:117-125`의 board 항목
  - agy의 board stage 전부(`antigravity-hook-runner.mjs:730` 매핑, `:1467-1480`, `:1581`, `:1617-1618`). agy는 prompt 관측이 없어서 board hook이 할 일이 없다. agy의 cwd는 presence `workspaceId`가 준다.
- `governance-hook.ts`의 board 분기, `server.ts:240-277`·`303-307`, `session-message-service.ts:104-136`, untargeted `list-presence`

## 4. 도구 계약

### 요청(유지, v1)
- `update-session-status-request.v1`: `{schemaVersion:"1.0.0", summary}`. 한 줄, 1–200자이고 `\r\n`이 없어야 한다.
- `list-session-status-request.v1`: `{schemaVersion:"1.0.0"}`
- 두 요청 모두 `_sessionBinding`은 서버가 proof 검증 뒤에만 넣는다. 호출자가 넣은 값은 거부한다(`server.ts:626`).

### 응답(새로 정의, v2)
`contracts/session-board-list.v2.schema.json`과 `contracts/types.ts`를 새로 두고 `claude-plugin/contracts`에 미러한다.

```ts
interface SessionBoardEntryV2 {
  host: string; sessionId: string; current: boolean;
  presence: "online" | "unreachable" | "ended" | "unknown"; // ended·unknown은 current 행에만
  startedAt: string | null; lastSeenAt: string | null;       // presence startedAt·heartbeatAt
  cwd: string | null;
  repo: { root: string; repoId: string; branch: string | null } | null;
  summary: string | null; summaryAt: string | null; summaryStale: boolean | null;
  lastPromptAt: string | null;
  wake: { state: SessionAutoWakeOutlookV2["state"]; reason: SessionAutoWakeOutlookV2["reason"] } | null;
}
interface SessionBoardListV2 {
  sessions: SessionBoardEntryV2[]; truncated: number;
  board: { status: "ok" } | { status: "unavailable"; step: string; cause: unknown };
}
// update_session_status 성공 응답: { summary: string; summaryAt: string }
```

오류 코드:
- `BINDING_REQUIRED`·`BINDING_INVALID`: 현재와 같다.
- `MCP_UNAVAILABLE {step: "open"|"write"|"read"|"presence"|"close", cause}`: cause는 원인 경로를 남기되 비밀은 노출하지 않는 기존 `failureContext` 형식이다.
- 현재의 「다음 gated 호출은 허용된다」 문구(`server.ts:307·337`)는 지운다. gate가 없기 때문이다.

도구 설명(`server.ts:580·586`)과 `SKILL.md`·`references/entry-details.md`를 위 의미로 다시 쓴다. 바뀌는 내용은 다음과 같다.
- 요약에 저장소·브랜치를 적으라는 요구를 뺀다.
- `stale` 설명을 `summaryStale`과 `presence`로 바꾼다.
- "24시간 안에 활동한 세션" 문구를 뺀다.

## 5. 바꿀 파일

| 파일 | 변경 |
|---|---|
| `skills/session-board/scripts/board-store.mjs`(+`.d.mts`) | D2·D6 저장소: `openBoard`(변환), `recordPrompt`, `setSummary`, `readEntries(keys)`, `promptMarker`, `prune(7일)` |
| `mcp-server/src/session-board-hook.ts` | prompt만 처리(D3-1) |
| `mcp-server/src/governance-hook.ts` | board 분기 삭제 |
| `mcp-server/src/server.ts` | `sessionBoardResult` 재작성(D3-2·D4), git 위치 함수(D5), 도구 설명 |
| `mcp-server/src/index.ts:155-161` | `promptMarker`로 교체 |
| `mcp-server/src/session-message-store.ts` | `listCurrentPresence(nowMs, self)` 추가, untargeted 모드 삭제, `:65` 주석을 현황판과 분리 |
| `mcp-server/src/session-message-broker.ts`, `…-client.ts`, `…-protocol.ts`, `…-service.ts` | 연산 `list-current-presence`, 프로토콜 버전, 묶음 처리 삭제 |
| `runtime/unified-state/shared-connection.mjs` | board v1, `PREVIOUS` 일반화 |
| `hooks/hooks.json`, `claude-overlay/hooks/hooks.json`, `antigravity-connector/hooks/antigravity-hook-runner.mjs` | D7 등록·stage 삭제 |
| `contracts/*`, `claude-plugin/contracts/*` | 4장 |
| `skills/session-board/SKILL.md`, `references/entry-details.md` | 4장 |
| `scripts/runtime-smoke.mjs:263-304`, `scripts/check-skill-context-optimization.mjs:66`(d.mts 해시) | 새 표·흐름 |
| `dist`, `claude-plugin` 생성물, `.github/ci/ags30-r11/source-manifest.json` | 다시 생성 |

## 6. 시험 계획

### 6.1 단위 시험(Linux 시험 서버, vitest, 시계 주입)
- **U1 변환.** 옛 `sessions` 행이 있는 파일을 연다. `board_sessions`가 비어 있고 `user_version = 1`이어야 한다. 다시 열어도 같다(멱등). 표가 하나 더 있는 파일과 `user_version = 2`인 파일은 거부되고, 파일 해시가 그대로여야 한다.
- **U2 공유 변환.** board v0 행과 messaging·workflow·continuity·trust 행을 가진 fixture를 initialize한다. board만 비어야 하고, 다른 표의 `inspect().counts`와 `schema_json`은 전후가 같아야 한다. 초기화 도중 실패를 주입하면 전부 rollback돼야 한다.
- **U3 요약 규칙.** 한 줄 200자 경계를 확인한다. `summaryStale`은 prompt가 없을 때 null, prompt 뒤에 true, 요약 갱신 뒤에 false다.
- **U4 보관.** `seen_at`이 7일 지난 행은 지워지고 6일 된 행은 남는다.
- **U5 hook.**
  - main prompt는 cwd와 `last_prompt_at`을 쓴다.
  - 확인된 깨우기 입력은 `last_prompt_at`을 바꾸지 않는다.
  - child(agent_id)는 아무것도 쓰지 않는다(D-0018 회귀 방지).
  - 쓸 수 없는 경로이면 출력이 ""이고 `phase:"open"`이 보고된다.
  - consume-wake 실패는 원인과 함께 보고된다(D-0016).
  - stdout EPIPE가 처리된다(D-0184).
- **U6 `listCurrentPresence`.**
  - online 행은 들어간다.
  - ended 행은 빠진다.
  - lease가 끝난 지 9분 59초인 행은 `unreachable`로 들어가고, 10분 1초인 행은 빠진다.
  - superseded나 이전 출생은 빠지고, 재출생하면 새 `startedAt`이 나온다.
  - `self`는 ended·unknown이어도 맨 앞에 있다.
  - 필드가 최대 길이일 때 응답이 32 KiB 이하이고 `truncated`가 정확하다.
- **U7 list(서버).**
  - 요약이 있는 ended 세션이 목록에 없다. 사용자 관측 회귀 시험이다.
  - broker가 내려가면 `MCP_UNAVAILABLE step:presence`다.
  - board를 읽지 못하면 목록은 나오고 `board.status:"unavailable"`이다.
  - 응답이 v2 스키마를 통과한다.
  - git 위치를 경우별로 확인한다: 일반 저장소, worktree(`.git` 파일 + `commondir`, 같은 `repoId`), detached, 저장소 아님, 읽을 수 없는 HEAD.
- **U8 update(서버).**
  - 검증된 binding으로 쓰고, 파일이 없으면 만든다.
  - 기록하지 못하면 `MCP_UNAVAILABLE` 응답이고, 예외가 나지 않는다. `step`은 실제로 실패한 단계다. 파일을 열지 못하면 `open`, 열었지만 쓰지 못하면 `write`, 닫지 못하면 `close`다.
  - 호출자의 `_sessionBinding`은 거부된다.
- **U9 governance hook.** 현황판 도구 호출에서 `openBoard`가 한 번도 불리지 않는다(spy). board 경로가 쓸 수 없는 상태여도 deny가 0이고 proof가 발급된다. `governance-hook-entry.test.ts:297` F2 사례를 이 단정으로 바꾼다.
- **U10 분류.** prompt 뒤 `observeTask`가 `host-prompt:<actor>:<lastPromptAt>`를 돌려준다. 확인된 깨우기 입력 뒤에는 값이 바뀌지 않는다.
- **고칠 기존 시험:**
  - `tests/session-board/*` 재작성
  - `tests/mcp/ags30-al04-owned-regressions.test.ts:6-8`(gate mock), `d0315-positive-child.test.ts:56-74`, `governance-hook-entry.test.ts:297-`
  - `tests/session-messaging/{claude-native-main,hook-cli-exit-status,hook-host-contract}.test.ts`, `session-message.test.ts:784-820`
  - `tests/unified-state/{inactive-factory,legacy-stores(B2-LEGACY-07 gate 부분),shared-connection(:145·175)}.test.ts`
  - antigravity runner 시험의 board stage 단정

### 6.2 실호스트 시험(Linux·Windows 시험 서버; Codex 0.165, Claude 2.1.314, agy 1.4.12)
각 시나리오에서 다른 host 세션의 `list_session_status` 결과를 기록한다. 대상 커밋, 명령, 종료 코드도 남긴다.

| # | 시나리오 | 합격 기준 |
|---|---|---|
| R1 | 설치 전에 옛 board 파일 두기(초기화) | 설치 뒤 목록에 옛 행이 0이고 `user_version = 1`이다 |
| R2 | 세션 시작 | 다른 세션이 `online`, cwd, `repo.branch`, `wake.state`를 본다 |
| R3 | prompt | Codex·Claude는 `lastPromptAt`이 채워지고 `summaryStale`이 true다. agy는 둘 다 null이다. |
| R4 | `update_session_status` | 다른 host 세션에서 같은 줄이 보이고 `summaryStale`이 false다 |
| R5 | 정상 종료 | 30초 안에 목록에서 빠진다(`ended`) |
| R6 | host 강제 종료(`kill -9`, `taskkill /F`) | 30초 안에 `online`이 아니게 된다. 10분 30초 안에 목록에서 빠진다. |
| R7 | host와 relay 함께 강제 종료(`taskkill /F /T`, 프로세스 그룹 kill) | lease 20초 + 5초 안에 `unreachable`이 되고, 10분 뒤 빠진다 |
| R8 | 재시작(새 세션) / resume(같은 ID) | 새 세션은 새 행이다. resume은 같은 행이고 새 `startedAt`이다. |
| R9 | 쓸 수 없는 board(`chmod 0444`, Windows `icacls /deny`) | update는 `MCP_UNAVAILABLE`이고 `step`은 실제로 실패한 단계다. 열지 못하면 `open`(Windows `icacls /deny` 실측: CANTOPEN), 열었지만 쓰지 못하면 `write`다. list는 presence를 보여 준다. board를 읽을 수 있으면 `board.status:"ok"`이고 요약이 그대로 나온다(Linux `chmod 0444` 실측). 읽지 못할 때만 `board.status:"unavailable"`과 실패 단계다. prompt와 다른 도구 지연·거부는 0이다. hook stderr에 `phase`가 남는다. |
| R10 | Codex·Claude `/clear` | 옛 ID가 `online`으로 남는지 측정만 한다(D-0351). 통과로 적지 않는다. |

## 7. 남는 위험과 의존
- **D-0351(OPEN, 원인 UNKNOWN).** `/clear`처럼 같은 host 프로세스 안에서 세션 ID만 바뀌면, 옛 ID의 relay가 계속 살아 `online`으로 보일 수 있다. Codex 앱처럼 한 프로세스가 여러 thread를 띄우는 host에서도, 끝난 thread가 `online`으로 남을 수 있다. 현황판은 presence를 그대로 보여 주므로 이 결함을 물려받는다. 고치는 곳은 메시징 presence 수명이다. hook 종료 처리(`session-message-hook.ts:452-457`)가 출생을 식별할 수 없다는 점도 함께 다뤄야 한다. 이번 설계에서는 R10으로 측정만 하고 별도로 추적한다.
- relay를 띄우지 못한 세션(`RELAY_HOST_PID_UNRESOLVED` 등, `session-message-hook.ts:415`)은 시작 20초 뒤 `unreachable`이 되고 10분 뒤 사라진다. 실행 중이어도 그렇다. 생존 근거가 없으니 정직한 표시다. R2에서 host별로 presence가 `online`이 되는지 확인한다.
- agy는 prompt 관측이 없어서 `summaryStale`과 분류 작업 표식이 null이다. 현재 동작과 같고, 이번에 숨기지 않고 null로 드러낸다. PreInvocation에 사용자 입력 구분 필드가 있는지는 R3에서 기록한다(본문은 기록하지 않는다).
- `UNREACHABLE_VISIBLE_MS`(10분)와 board 보관 기간(7일)은 이 설계가 정한 값이다. 상수 하나씩이므로 실호스트 측정으로 조정한다.
