# AGS 3.0 호출자 신원·세션 결속 재설계

상태: 설계, 실호스트 채집 반영(2026-11-01, 1.5절), 행위자 정책 변경 반영(2026-11-01, 2.0절). 기준 소스는 `feat/ags30-session-binding`의 `4b2dc571`이다. 이 문서의 `file:line`은 별도 표시가 없으면 이 commit 기준이다.

## 0. 범위

MCP 도구 호출을 호출한 세션과 행위자(root/child)에 묶는 방식 전체를 다룬다.

- hook이 인자에 넣는 네 필드: `_sessionProof`, `_sessionBinding`, `_continuityBinding`, `_hostAttestation`
- 실행 관측(model·effort) 전달
- 호출 행위자(root·child)와 부모 사슬 판정

현황판 쓰기 규칙, broker, 오류 분류표, 실행 하한 정책 자체는 병렬 설계가 맡는다(8장).

## 1. 판정

### 1.1 결속이 실제로 지키는 것

서버는 `_sessionProof`를 검증한 뒤 다음 소비자에게 `{host, sessionId, actor}`를 넘긴다(`server.ts:627-640`).

| 소비자 | 신원이 필요한 이유 | 근거 |
| --- | --- | --- |
| 세션 메시지 prepare·send·ack·status | 발신자 위장, 남의 수신함 확인 처리를 막는다 | `session-message-service.ts:47,69,82,94` |
| 현황판 update·list | 자기 행만 쓰고, 목록에서 자기 행을 표시한다 | `server.ts:286-300` |
| `validate_collaboration_decision` | 영수증이 호출자에게 묶였는지 판정한다 | `trust-service.ts:46,54,77-78` |
| continuity·workflow 시작 | 세션→작업 상관관계, fork 부모 결정 | `server.ts:762`, `continuity-service.ts:255-272` |
| 행위자 기록 | 누가(root·child와 부모 사슬) 호출했는지 남기고, 관문이 「감사자 ≠ 구현자」 같은 독립성 비교에 쓴다. 옛 root 전용 정책(`docs/ags30-d0019-root-only-design.md:3-5`)은 2.0에서 버린다 | `input-observation.ts:39-50`, gates 설계 2장 |
| 실행 하한(4개 workflow 도구) | 실제로 실행 중인 model·effort를 확인한다 | `host-attestation.ts:24`, `docs/host-execution-attestation.md` |

위협 모형은 같은 OS 사용자 아래에서 실수하거나 지시에 오염될 수 있는 협력 에이전트다. 모델이 인자에 다른 세션의 ID를 써도 그 세션으로 행동하면 안 된다. 같은 사용자의 악성 프로세스는 막지 않는다. 현재 문서도 이를 인정한다(`session-actor-proof.ts:52`, `docs/ags30-d0019-root-only-design.md:87-90`).

결속은 실제로 필요하다. 그래서 지우지 않는다. 바꿀 것은 **신원이 서버에 도착하는 경로**다.

### 1.2 호스트별로 관측 가능한 사실

| 사실 | Codex 0.164–0.166 | Claude Code 2.1.316 | agy 1.4.12 |
| --- | --- | --- | --- |
| hook stdin의 세션 ID | `session_id` = `sess.session_id()` (hook_runtime.rs:207) | `session_id` | `conversationId` |
| hook의 호출 ID | `tool_use_id` | `tool_use_id` | 없음 (공식 hooks 문서의 `toolCall`은 `name`·`args`만, D-0317) |
| hook의 child 표식 | `agent_id`. **ThreadSpawn subagent에만** 붙는다. Review·Compact·MemoryConsolidation·Other는 표식이 없다 (hook_runtime.rs:1083-1093) | `agent_id`·`agent_type` (공식 hooks 문서) | 없음 |
| 인자 재작성 조건 | `updatedInput`은 `permissionDecision:"allow"`와 함께만 적용된다. 여러 hook이 재작성하면 **마지막에 끝난 hook**이 이긴다 (pre_tool_use.rs:133-137,157-170) | `updatedInput` (allow/ask와 조합) | `overwrite`. 얕은 병합이라 키를 지울 수 없다. 바뀐 키 이름이 결과 앞에 붙는다 |
| hook 실패 시 | 시간 초과·exit 0/2 외 코드·잘못된 JSON은 Failed로 끝나고 **fail-open**이다. exit 2는 stderr에 사유가 있을 때만 차단한다 (pre_tool_use.rs:211-296) | 기본 fail-open. `onFailure:"block"`이면 차단한다 (2.1.295+, 현재 설정 `claude-overlay/hooks/hooks.json:112`) | 문서에 없다. 커넥터 자체는 fail-closed다 |
| **MCP `tools/call`의 `_meta`** (호스트가 쓰고 모델은 못 씀) | `callId`, `threadId`, `sessionId`, `x-codex-turn-metadata{session_id, thread_id, turn_id, parent_thread_id, subagent_kind, thread_source, model, reasoning_effort, codex_version…}` (mcp_tool_call.rs:543-555,1331-1355,1431-1463; turn_metadata.rs:275-313; responses_metadata.rs:420-470,557-597). 0.164·0.165에도 같은 상수와 필드가 있다 | `claudecode/toolUseId` (모든 MCP 서버). `claudecode/agentId`는 내부 서버 하나에만 보낸다 (설치 바이너리 sha256 `e896a9d8…2d52`의 문자열 확인) | `antigravity.google/conversation_id`, `antigravity.google/root_conversation_id`, subagent에는 `antigravity.google/parent_conversation_id`. 호출 ID와 model은 없다 (1.5 채집) |
| MCP 서버 기동 환경 | 세션 정보 없음 | `CLAUDE_CODE_SESSION_ID`는 기동 시점 값이다. `/clear`에 바뀌는데 서버는 그대로 남는다. subagent는 같은 서버 프로세스를 쓴다. plugin 서버 전달은 2.1.152 실측에서 없었다 (anthropics/claude-code#61752) | 미확인 |

Codex 소스는 `rust-v0.166.0` raw 파일로 확인했다. sha256: `mcp_tool_call.rs` 0bc2f419…, `turn_metadata.rs` 2fac79a2…, `responses_metadata.rs` 44c343d4…, `hook_runtime.rs` d89eec06…, `hooks/src/events/pre_tool_use.rs` 98fe5567….

### 1.3 원인 판정: 「hook이 인자를 고쳐 신원을 실어 나르는 구조」

**결론: 원인이 맞다.** D-0021·D-0076·D-0302와 D-0020·D-0180·D-0315·D-0019(Codex)는 이 구조에서 나온다.

1. **D-0302 (간헐 `BINDING_REQUIRED`).** 서버는 `_sessionProof`가 없으면 `ROOT_HOOK_PROOF_REQUIRED`로 거부한다(`session-actor-proof.ts:80-82`). Codex에서 proof가 빠지는 경로는 셋이다. 모두 소스로 확인했다.
   - (a) governance hook이 10초(`hooks/hooks.json:116-124`)를 넘기거나, exit 2가 아닌 코드로 끝나거나, 잘못된 JSON을 내면 Codex는 fail-open으로 호출을 그대로 보낸다. 이 hook은 호출마다 node를 띄우고 SQLite 2–3개를 연다. Codex 실행 관측은 rollout의 앞 256 KiB와 끝 8 MiB도 읽는다.
   - (b) AGS 도구에 `updatedInput`을 내는 다른 hook이 있으면 「마지막에 끝난 hook」이 이긴다. 순서는 경합으로 정해지므로 간헐적이고, 재시도하면 성공한다.
   - (c) 승인 대기가 5분을 넘으면 `ROOT_PROOF_SCOPE_OR_TIME_INVALID`(expired)가 난다. 이것은 `BINDING_INVALID`다.

   episode가 (a)·(b) 중 어느 것인지는 호출별 기록이 없어 단정하지 않는다(ledger root_cause UNKNOWN). 재설계는 (a)·(b)·(c)를 모두 없앤다. Codex 신원이 hook에 의존하지 않기 때문이다.

   `functions.exec`(code mode)의 중첩 MCP 호출도 같은 `mcp_tool_call` 경로로 `_meta`를 싣는다(mcp_tool_call.rs:550-555 `originating_call`). 그래서 hook이 중첩 호출에 걸리는지(openai/codex#23411, #28365)와 상관없어진다.
2. **D-0021 (namespace 결속이 느슨함).** proof는 도구 *이름*이 맞으면 어느 서버의 인자에든 들어간다(`builtin-hook-host-adapters.ts:249-256`). 현재는 접두사 3개를 정확히 비교하지만 이름 기반이라는 점은 그대로다. 인자 주입을 없애면 해소된다. 다른 서버가 받는 것이 없기 때문이다.
3. **D-0076 (`_sessionBinding`을 인자 값 그대로 신뢰).** 현재 서버는 호출자의 `_sessionBinding`을 거부한다(`server.ts:627`). 그다음 검증한 값을 **다시 인자에 넣어** 서비스로 넘긴다(`server.ts:636-639`). 서비스와 계약 schema는 지금도 인자의 `_sessionBinding`을 읽는다(`server.ts:292`, `contracts/types.ts:270,320-353`). 막는 장치가 서버 진입부의 한 줄뿐이다. 신원을 인자에서 빼면 구조적으로 닫힌다.
4. **D-0020·D-0180 (hook allow가 호스트 승인을 대신함).** Codex는 재작성하려면 `allow`가 필요하다(`builtin-hook-host-adapters.ts:372-373`, `governance-hook.ts:156-158`). 재작성이 없어지면 allow도 없어진다.
5. **D-0315·D-0019 (Codex 행위자 판정).** hook에는 ThreadSpawn 표식만 있다. 그래서 다른 subagent 종류는 root로 추론된다(`builtin-hook-host-adapters.ts:80-104`). `_meta`의 `parent_thread_id`·`subagent_kind`는 모든 `SessionSource::SubAgent`를 덮는다(responses_metadata.rs:492-503). 관측된 root/child 판정과 부모 사슬 기록이 가능해진다.

부수 결함도 있다. 현황판 hook은 서버가 proof를 검증하기 **전에** 요약을 쓴다(`session-board-hook.ts:73`). 서버가 거부해도 쓰기는 남는다. 현황판 설계가 이미 서버 쓰기로 옮긴다(8장).

### 1.4 대안 평가

| 대안 | 판정 | 이유 |
| --- | --- | --- |
| A. 결속 삭제 | 기각 | 1.1의 메시지·현황판·root 관문이 실제 소비자다 |
| B. MCP 서버 기동 환경의 신원(세션별 프로세스) | 기각 | Claude: `/clear`에서 세션 ID가 바뀌어도 서버가 남고, subagent가 프로세스를 공유하며, plugin 서버 전달이 확인되지 않았다. Codex·agy: 기동 환경에 세션이 없다. |
| C. 호스트가 쓰는 `_meta`에서 직접 신원 확인 | **Codex 채택** | 호스트가 매 호출마다 쓰고 모델은 쓸 수 없다. stdio pipe라 같은 사용자 프로세스도 끼어들기 어렵다. 지금의 디스크 HMAC 키보다 강하다. hook·SQLite·시간 초과가 경로에서 빠진다. |
| D. hook이 호출 ID를 키로 별도 저장소에 기록(admission), 서버가 `_meta`의 같은 ID로 회수 | **Claude 채택** | Claude `_meta`에는 `toolUseId`만 있고 세션·agent가 없다. hook은 이 셋을 모두 본다. 인자는 건드리지 않는다. hook이 돌지 않으면 행이 없으므로 거부된다(fail-closed). |
| E. 인자로 나르는 서명 proof(현행 v3) | **삭제** (채집 뒤 변경) | 설계 당시에는 agy에만 남기려 했다. 채집에서 agy `_meta`에 호스트가 쓰는 대화 ID와 부모 대화 ID가 확인되어(1.5) agy도 C로 옮긴다 |

### 1.5 실호스트 채집 결과 (2026-11-01)

장치: `tests/real-host/binding-capture/`(commit `083a5aba`, `64b82666`). 기록 전용 stdio MCP 서버와 PreToolUse hook이 키 이름과 salt hash의 동치만 남긴다. 값·본문은 남기지 않는다. Linux 테스트 서버(`/home/mcpops/binding-5970-r01`)와 Windows 시험 서버(`C:\Users\Administrator\binding-5970-r01`)에서 돌렸다. agy Windows를 뺀 모든 실행의 종료 코드는 0이다.

| 호스트(버전, OS) | 호출 | `_meta` 키 | 판정에 쓰는 동치 | hook 대조 |
| --- | --- | --- | --- | --- |
| Codex 0.166.0 (Linux·Windows) | 메인 1, 병렬 2 | `callId, itemId, progressToken, sessionId, threadId, windowId, x-codex-turn-metadata`(객체) | turn `session_id`=`sessionId`, turn `thread_id`=`threadId`, `threadId`=`sessionId`. `parent_thread_id`·`subagent_kind` 없음. `thread_source`=`user`. model·effort·turn_id 있음 | `tool_use_id`=`callId`, `session_id`=`sessionId`, `turn_id` 같음, `agent_id` 없음 |
| 〃 | ThreadSpawn subagent 1 | 같음 | `threadId`≠`sessionId`. `parent_thread_id`·`forked_from_thread_id` 있음. `subagent_kind`=`thread_spawn`, `thread_source`=`subagent` | `tool_use_id`=`callId`, `session_id`=부모 `sessionId`, `agent_id` 있음(`agent_type` `default`) |
| 〃 | `exec resume` 뒤 1 | 같음 | 메인과 같은 `sessionId`. root 조건 모두 성립 | 같음 |
| 〃 | `exec fork` 뒤 1 | 같음 | **새** `sessionId`(=`threadId`). `forked_from_thread_id` 있음, `parent_thread_id` 없음 → root | 같음 |
| Claude Code 2.1.314 (Linux), 2.1.316 (Windows), `-p` stream-json | 메인 1, 병렬 2, Agent subagent 1 | `claudecode/toolUseId, progressToken` | 해당 없음 | 4건 모두 `tool_use_id`=`claudecode/toolUseId`. subagent hook에만 `agent_id`(`agent_type` `general-purpose`). hook `session_id`=서버 기동 env `CLAUDE_CODE_SESSION_ID`(`--mcp-config` 서버). hook 키에 `model`은 없고 `effort`는 있다 |
| agy 1.4.12 (Linux) | 메인 1, 병렬 2 | `antigravity.google/artifacts_dir, antigravity.google/conversation_id, antigravity.google/root_conversation_id, progressToken` | `conversation_id`=`root_conversation_id`, 부모 키 없음 | hook `conversationId`=`conversation_id`. hook에 호출 ID 없음(`toolCall`은 `name`·`args`). 도구 이름은 `call_mcp_tool` |
| 〃 | subagent(`invoke_subagent`) 1 | 위 키에 `antigravity.google/parent_conversation_id` 추가 | `conversation_id`는 새 값, `root_conversation_id`=부모 | hook `conversationId`=subagent 대화. child 표식 없음 |
| Codex 0.166.0 (Linux·Windows) | 2단 중첩(root → A → B) | 같음 | 세 호출 모두 `sessionId`=root. A: `threadId`=A, `parent_thread_id`=root. B: `threadId`=B, `parent_thread_id`=A. `forked_from_thread_id`=직속 부모 | hook `agent_id`=그 호출의 `threadId`. `session_id`=root |
| Claude Code 2.1.314 (Linux), 2.1.316 (Windows) | 2단 중첩(root → A → B) | `claudecode/toolUseId, progressToken` | 해당 없음 | 세 호출 모두 `tool_use_id`=`toolUseId`, `session_id`=root. A·B hook에 서로 다른 `agent_id`, 둘 다 `agent_type` `general-purpose`. `transcript_path`는 셋 다 root transcript다. **부모 agent를 가리키는 필드는 없다** |
| agy 1.4.12 (Linux) | 2단 중첩(root → A → B) | 위와 같음 | A: `conversation_id`=A, `parent_conversation_id`=root. B: `conversation_id`=B, `parent_conversation_id`=A. 셋 다 `root_conversation_id`=root | hook `conversationId`=그 호출의 대화 |
| agy 1.4.12 (Windows) | 미실행 | | | 시험 서버의 agy가 Google 로그인 전이다(`Authentication required`). 사용자 로그인이 필요하다 |

채집으로 바뀐 결정:

1. Codex: 2.2 판정 규칙을 그대로 쓴다. fork는 새 root 세션이고 resume은 같은 세션이다. `thread_id === session_id` 가정은 두 경우 모두 성립했다.
2. Claude: admission(D)을 그대로 쓴다. `toolUseId`가 없거나 다를 때 `updatedInput`을 유지한다는 조건은 해당하지 않는다. hook 입력에 model이 없으므로 model은 2.2대로 transcript 발신 항목이나 세션 model 기록에서 온다.
3. agy: arg proof(E)를 지우고 `_meta` ingress(`antigravity-meta`)로 옮긴다. 호출 ID가 없으므로 one-use 회수가 없고, 실행 관측은 `unavailable`이다. 현행에도 agy에는 실행 관측 token 발급 경로가 없다.
4. 중첩: Codex·agy는 호출마다 root와 **직속 부모**를 준다. Claude는 root와 agent 자신만 주고 부모 agent는 주지 않는다. 그래서 사슬은 「호스트가 준 만큼」 기록하고 완전성을 따로 표시한다(2.1). 요청 버전 Codex 0.165는 두 서버 모두 0.166.0만 설치되어 있어 0.166.0으로 채집했다. Windows Claude는 2.1.316이다.

## 2. 설계

### 2.0 행위자 정책 (2026-11-01 사용자 결정으로 변경)

사용자 원문: 「근데 서브에이전트에서 또 서브에이전트를 호출할수있는구조면 내가 서브에이전트에서 mcp 호출막겠다고 하는게 맞나싶기도하네」, 조정자 제안(관측되는 호스트에서는 child 호출을 허용하고, actor는 child 자신과 부모 사슬로 기록하고, 관측이 안 되는 호스트에서만 막는다)에 「그렇게 해줄래? 그리고 그건 다른 벤더사들도 그럴거같으니 그런부분도 고려해서 설계해줘.」

- 「AGS 도구는 root만 호출한다」(`docs/ags30-d0019-root-only-design.md`)를 버린다. governance hook의 child deny도 지운다.
- 호스트가 child 신원을 모델이 고칠 수 없는 값으로 주면 child 호출을 허용한다. `caller.actor`는 child 자신이고 `caller.parentChain`은 root부터 직속 부모까지다.
- 관측값이 없는 호출은 받지 않는다. root로 추정하지 않는다. 거부 사유는 `CALLER_PROVENANCE_UNAVAILABLE`이고 `details.ingressReason`에 호스트별 원인을 남긴다.
- core·관문·서비스는 아래 계약 하나만 안다. 벤더를 더할 때는 ingress adapter 하나와 설치 manifest의 `AGENT_GOVERNANCE_HOST_ATTESTATION` 값만 더한다.

### 2.1 공통 계약

```ts
// mcp-server/src/caller-identity.ts
export interface CallerActor {
  id: string;                 // hostActorId(host, rootSessionId, agentKey|null). root는 agentKey=null
  role: "root" | "child";
}
export interface VerifiedCaller {
  host: string;
  sessionId: string;          // root 세션 ID. 메시지·현황판·continuity의 주소 단위
  callId: string | null;      // 호스트 호출 ID. 없는 호스트(agy)는 null
  actor: CallerActor;         // 호출한 agent 자신
  parentChain: string[];      // actor id, root → 직속 부모. root면 []
  parentChainComplete: boolean; // 호스트가 직속 부모까지 이어 주었는지
  provenance: "host-observed";  // 서비스에 도달한 caller는 항상 관측값이다
  execution: { model: string; effort: string; turnId: string | null; provenance: string }
           | { unavailable: string };  // 실행 하한 도구만 소비한다
}
export type IngressResult =
  | { provenance: "host-observed"; caller: Omit<VerifiedCaller, "provenance"> }
  | { provenance: "unavailable"; reason: string };   // 호스트별 원인, 예: CODEX_CALL_META_MISSING
/** 호스트 adapter 하나가 구현한다. 모순(형식 오류·도구 불일치·이미 소비됨)은 WorkflowContractError로 던진다. */
export type CallerIngress = (tool: string, meta: Record<string, unknown> | undefined) => IngressResult;
```

- core의 `admitCaller(ingressResult)`가 불변식을 검사한다. 위반은 `BINDING_INVALID`다.
  - `provenance` 가 `unavailable`이면 `BINDING_REQUIRED` + `CALLER_PROVENANCE_UNAVAILABLE`.
  - root ⇔ `parentChain` 비어 있음, `parentChainComplete`는 root면 true (`CALLER_CHAIN_INCONSISTENT`).
  - child의 `parentChain[0]`은 `hostActorId(host, sessionId)`다 (`CALLER_CHAIN_INCONSISTENT`).
  - 깊이: `parentChain.length ≤ 16` (`CALLER_CHAIN_TOO_DEEP`).
  - 순환·재사용: 사슬 안에 같은 id가 두 번 없고, `actor.id`가 사슬에 없다 (`CALLER_CHAIN_CYCLE`). actor id는 root 세션을 포함하므로 다른 root 아래의 같은 agent 키와 섞이지 않는다.
- 서버는 기동 환경 `AGENT_GOVERNANCE_HOST_ATTESTATION`(설치 manifest가 정함)으로 ingress를 **하나** 고른다. 고르는 곳은 `index.ts`의 composition 한 곳이다. core에는 제품 분기가 없다.
- AGS 도구 호출 경로에서는 `actorAccess`(root 전용 판정)를 쓰지 않는다. 수명주기 hook(continuity·메시지)이 root 세션 사건만 처리하는 판정에는 그대로 남는다.
- 서비스는 `caller`를 **별도 매개변수**로 받는다. 인자 객체에 신원을 넣지 않는다. 호출자가 예약 키(`_sessionBinding`·`_continuityBinding`·`_hostAttestation`·`_sessionProof`)를 보내면 `INVALID_INPUT`으로 거부한다. schema에서 빠지므로 `additionalProperties:false`가 거부한다.
- child의 도메인 의미: 메시지·현황판·continuity는 `caller.sessionId`(root 세션)를 주소로 쓴다. child는 자기 root 세션의 이름으로 행동하고, 누가 했는지는 `caller.actor`로 기록된다. workflow·관문은 기록자 actor로 `caller.actor.id`를 쓴다.

### 2.2 호스트 ingress

**Codex (`codex-meta`).** hook이 없다.

- `meta.sessionId`, `meta.threadId`, `meta.callId`, `meta["x-codex-turn-metadata"]`를 읽는다.
- turn metadata의 `session_id`·`thread_id`가 `meta`의 값과 같아야 한다. 아니면 `CODEX_CALL_META_INVALID`.
- root: `parent_thread_id`·`subagent_kind`가 없고 `thread_id === session_id`다.
- child: `parent_thread_id`가 있고 `thread_id ≠ session_id`다. actor 키는 `thread_id`(hook `agent_id`와 같은 값, 1.5)다. 사슬은 `[root]`에 `parent_thread_id ≠ session_id`이면 부모 actor를 더한다. `parentChainComplete`는 `parent_thread_id === session_id`일 때만 true다(중간 조상은 이 호출의 `_meta`에 없다).
- 그 밖(필드 누락, `subagent_kind`만 있음, `thread_id === session_id`인데 부모 표식 있음)은 `unavailable`이다. 사유는 `CODEX_CALL_META_MISSING`·`CODEX_CALL_META_INVALID`·`CODEX_ROOT_THREAD_MISMATCH`로 나눈다.
- `execution`은 같은 객체의 `model`·`reasoning_effort`·`turn_id`에서 온다. 없으면 `{unavailable:"CODEX_EFFORT_ABSENT"}` 같은 값이 된다.
- 판정 규칙은 0.164–0.166 소스에서 나왔다. 실호스트 채집(6.2)이 fork·resume에서 `thread_id === session_id` 가정이 깨진다고 보이면 그 조건만 adapter에서 조정한다.

**Claude Code (`claude-admission`).**

- PreToolUse governance hook은 인자를 고치지 않는다.
  - root·child 모두 출력 없이 exit 0으로 끝낸다. 호스트의 정상 승인 흐름을 탄다.
  - `agent_id`가 있는데 비어 있거나 문자열이 아니면 행을 쓰지 않는다. 서버는 `CALL_ADMISSION_MISSING`으로 거부한다.
  - 실패하면 exit 2로 끝낸다(`onFailure:"block"` 유지).
- hook은 workflow DB의 `call_admissions(host, call_id, tool, session_id, agent_id, execution_json, transcript_path, created_at)`에 한 행을 쓴다. 키는 `(host, call_id)`다.
- 서버는 `agent_id`가 없으면 root, 있으면 child로 본다. Claude hook은 부모 agent를 주지 않으므로(1.5) child의 사슬은 `[root]`, `parentChainComplete=false`다.
- 서버는 `meta["claudecode/toolUseId"]`로 `DELETE … RETURNING`을 실행해 그 행을 한 번만 회수한다. 도구 이름이 다르면 거부한다.
- 행이 없으면 `CALL_ADMISSION_MISSING`이다. hook이 돌지 않았거나, matcher 밖 namespace이거나, 이미 소비된 경우다.
- 서명·TTL·입력 digest는 지운다.
  - 키가 같은 DB에 있으므로 서명은 이 위협 모형에서 더하는 것이 없다.
  - TTL 5분은 승인 대기를 실패로 만들었다(1.3 c). 이제 행은 24시간 지나면 정리 대상일 뿐이다.
  - digest가 막던 「같은 증명을 다른 인자에 쓰기」는 호출 ID가 유일하므로 생기지 않는다.
- execution은 다음 순서로 정한다.
  - effort: hook 입력의 `effort.level`(공식 공통 필드)
  - model: 발신 transcript 항목의 `model`, 없으면 SessionStart·PostModelSwitch가 기록한 세션 model
  - 둘 다 없으면 `unavailable`
  - transcript-latest 추정(`host-attestation-hook.ts:517-528`)은 지운다. subagent 후보(`agentId`) transcript 경로는 child 실행 관측에 쓰므로 남긴다.

**Antigravity (`antigravity-meta`, 채집 뒤 변경).** hook이 없다.

- `meta["antigravity.google/conversation_id"]`가 세션 ID다. hook의 `conversationId`와 같은 값이다(1.5).
- root: `root_conversation_id`가 `conversation_id`와 같고 `parent_conversation_id`가 없다. `sessionId`는 `root_conversation_id`다.
- child: `parent_conversation_id`가 있고 `conversation_id ≠ root_conversation_id`다. actor 키는 `conversation_id`다. 사슬은 Codex와 같은 규칙(`[root]` + 부모가 root가 아니면 부모)이다.
- 그 밖은 `unavailable`이다. 사유는 `ANTIGRAVITY_CALL_META_MISSING`·`ANTIGRAVITY_CALL_META_INVALID`·`ANTIGRAVITY_ROOT_CONVERSATION_MISMATCH`다.
- 호출 ID가 없으므로 `callId`는 null이고 `execution`은 `{unavailable:"ANTIGRAVITY_EXECUTION_UNOBSERVED"}`다.
- `SessionActorProofs` v3, `_sessionProof`, 커넥터의 AGS 도구 proof 발급 경로를 지운다. 커넥터의 예약 키 거부는 schema가 대신한다.
- `mcp_config.json`의 `AGENT_GOVERNANCE_HOST_ATTESTATION`을 `gemini`에서 `antigravity`로 바꾼다.

**Gemini CLI.** 3.0 미지원 그대로다. ingress가 없으면 모든 도구가 `HOST_INGRESS_UNAVAILABLE`로 거부된다.

### 2.3 도메인 변경

| 영역 | 변경 |
| --- | --- |
| 메시지 | `SessionMessageService.prepare/send/ack/status(args, caller)`. hook의 `_sessionBinding` 주입(`session-message-hook.ts:476-493`)과 governance hook의 MESSAGE 분기를 지운다 |
| 현황판 | 현황판 설계의 서버 쓰기를 그대로 쓴다. `binding` 대신 `caller`를 받는다 |
| collaboration | `validateCollaborationDecision(input, caller)`. `actorKind`는 `caller.actor.role`(root→`main`, child→`subagent`)에서 온다. child가 `user-turn` 출처를 주장하면 거부하는 `subagent` 분기(`trust-service.ts:54`)는 그대로 쓴다 |
| continuity | `_continuityBinding`(hook 발급 `continuity-hook.ts:121-133`, 검증 `continuity-service.ts:880-888`)을 지운다. 서버가 `continuity.bindCall(caller, tool, lineageReader?)`로 같은 payload(c·e·anchors·fork parent)를 계산한다. Claude의 lineage는 admission의 `transcript_path`로 서버가 `readClaudeLineage`를 부른다. 경계 시점의 host-process fork pin(`readDeferredForkHostParent`·`pinForkParent`)은 기록 부작용이므로 Claude hook에 남긴다. `open_convergence_root`의 root 결속은 `prepareWorkflowStart`와 같은 caller 경로를 쓴다. 실패 보고 형식은 오류 모형 설계를 따른다(D-0056) |
| 실행 관측 | `_hostAttestation` token(`aghs2`), Codex rollout 해석(`codex-host-observation.ts`), Codex attestation strategy, hook attestation strategy registry(`host-attestation-hook.ts:583-660`)를 지운다. `HostAttestationProvider`는 `caller.execution`과 `callId`로 기존 one-use claim과 실행 하한 검사를 한다 |
| governance hook | Codex 등록을 삭제한다. Claude는 「admission 기록 → continuity 경계 pin」만 하는 짧은 함수가 된다. child deny는 없다. agy 커넥터의 AGS 도구 proof 발급을 지운다 |

### 2.4 오류 코드

- 신원을 확인하지 못함(필드 없음, 행 없음, ingress 없음): `BINDING_REQUIRED`
- 신원 사실이 모순됨(형식 오류, 도구 불일치, 이미 소비됨, 사슬 불변식 위반): `BINDING_INVALID`
- `details.reasonCode`는 위 사유 문자열로 원인별로 나눈다. 예: `CALLER_PROVENANCE_UNAVAILABLE`(+`ingressReason`: `CALL_ADMISSION_MISSING`, `CODEX_CALL_META_MISSING` 등), `CALL_ADMISSION_TOOL_MISMATCH`, `CALLER_CHAIN_TOO_DEEP`, `CALLER_CHAIN_CYCLE`, `CALLER_CHAIN_INCONSISTENT`
- hook 실패와 서버 거부가 같은 문구로 뭉치지 않는다. 분류표 공용화는 오류 모형 설계의 `failureReason`을 쓴다.

### 2.5 보안 성질

| 성질 | 현행 | 재설계 |
| --- | --- | --- |
| 모델이 신원을 고를 수 있나 | 진입부 한 줄로 막는다 | 신원이 인자에 없다 |
| 같은 사용자 셸에서 위조 | 키를 읽어 proof를 위조할 수 있다 | Codex: stdio `_meta` 위조 불가(서버를 직접 띄우는 경우는 비목표). Claude: 아직 발급되지 않은 `toolu_` ID를 맞혀야 한다. agy: 현행과 같다 |
| hook 누락·실패 | Codex는 fail-open 후 서버 거부(D-0302) | Codex는 hook이 없다. Claude·agy는 hook이 없으면 거부한다 |
| 호스트 승인 | Codex allow가 승인을 건너뛸 수 있다(D-0180) | 재작성이 없으므로 결정 출력도 없다 |
| child 위장 | child가 root처럼 보일 수 있다(Codex 추론 root, D-0315) | 부모 표식은 호스트가 쓴다. 표식이 빠진 호출은 root로 추정하지 않고 거부한다 |

OS 격리가 아니라는 기존 문구(`docs/ags30-d0019-root-only-design.md:87-90`)는 이 문서로 옮겨 유지한다.

## 3. 계약 변경 (2.x 호환 없음)

- `contracts/*-request.v1.schema.json` 7개에서 `_sessionBinding`을 지운다: acknowledge, get-status, list-status, prepare, send, update-status, validate-collaboration. 5개에서 `_continuityBinding`을 지운다: checkpoint, inspect, load, purge, suppress. `contracts/types.ts:270,320-353`의 해당 필드도 지운다. `SessionBindingV1`·`CollaborationSessionBindingV1`은 서버 내부 `VerifiedCaller`로 바꾼다.
- 공개 도구 schema에서 `_sessionProof` 광고(`server.ts:417-419`)를 지운다.
- 새 SQLite 표 `call_admissions`를 workflow DB에 추가한다. 기존 행은 이관하지 않는다.
- 폐기: HMAC 키 이름 `governance-root-call-key-v3`, continuity tool-binding payload v1, `aghs2`.

## 4. 파일

- **삭제:** `codex-host-observation.ts`, Codex attestation strategy와 strategy registry(`host-attestation-hook.ts` 해당 부분), `hooks/hooks.json`의 Codex governance PreToolUse 항목(`:115-125`), `session-message-hook.ts`·`session-board-hook.ts`·`continuity-hook.ts`의 AGS 도구 `updatedInput` 분기, `HookHostAdapter.rewriteDecision`·`hookRewriteDecision`, `withHookHostAdapter`의 domain 중첩용 canonical 재사용(`host-input-adapter.ts:74-82`, 단일 진입만 남기면 필요 없음).
- **새 파일:** `caller-identity.ts`(공통 계약과 불변식 `admitCaller`), adapter 3개(Codex·agy `_meta`, Claude admission)는 `builtin-hook-host-adapters.ts` 옆의 `builtin-caller-ingress.ts` 하나에 둔다. `session-actor-proof.ts`는 삭제한다.
- **변경:** `server.ts`(진입부 627-640 교체, 서비스 호출부), `index.ts`(ingress 선택), `governance-hook.ts`(Claude 축소, agy 유지), `session-message-service.ts`, `trust-service.ts`, `continuity-service.ts`, `host-attestation.ts`, `sqlite-workflow-store.ts`(admission 표·회수), `claude-overlay/hooks/governance-hook.mjs`(빈 출력 허용), `mcp_config.json`, `diagnostics.ts:130`, `scripts/runtime-smoke.mjs`, `docs/ags30-d0019-root-only-design.md`(삭제, 행위자 계약은 이 문서 2.0·2.1이 대체), `docs/host-execution-attestation.md`, `docs/session-message-lifecycle.md`, `skills/session-board/references/entry-details.md`, dist·`claude-plugin` 재생성.

## 5. 이행 순서

1. `VerifiedCaller` 매개변수화. 서비스 시그니처만 바꾸고, 진입부는 현행 proof에서 caller를 만든다. 계약에서 `_sessionBinding`을 지운다. 동작은 같다.
2. Codex ingress와 Codex hook 삭제, Codex 실행 관측의 `_meta` 전환
3. Claude admission과 Claude hook 축소, transcript-latest 삭제
4. continuity 서버 계산, `_continuityBinding` 삭제
5. 문서, 번들, 설치물 재생성

단계마다 CI를 통과시킨다. 현황판 설계가 먼저 반영되면 1단계에서 현황판 호출부도 함께 바꾼다.

## 6. 시험 계획

### 6.1 단위·통합(Actions Ubuntu/Windows)

- **Codex ingress 표.**
  - root(같은 ID, 표식 없음)는 통과한다. 1단 child는 `[root]`·완전, 2단 child는 `[root, 부모]`·불완전으로 통과한다.
  - `subagent_kind`만 있음, `thread_id===session_id`인데 부모 있음, `_meta` 없음, 형식 오류는 각각 다른 `ingressReason`으로 거부된다.
  - 인자에 `_meta`처럼 생긴 키를 넣어도 신원이 바뀌지 않는다.
  - model·effort가 없으면 `execution.unavailable`이 되고, 실행 하한 도구만 거부된다.
- **Claude admission.**
  - hook→서버 정상 경로를 확인한다.
  - 행 없음, 도구 불일치, 두 번째 회수, 병렬 호출 20개(서로 다른 ID), 승인 대기 10분 뒤 회수 성공, child 행(`agent_id`) 통과, `agent_id` 형식 오류는 행 없음을 확인한다.
  - hook 출력에 `updatedInput`·`permissionDecision:"allow"`가 없어야 한다(정적·동적 단정).
- **core 불변식.** `admitCaller`가 깊이 17, 사슬 중복, actor가 사슬에 있음, root인데 사슬 있음, 사슬 첫 항목이 root가 아님을 각각 다른 reasonCode로 거부한다. 같은 표가 Codex·Claude·agy adapter 출력에 공통으로 돈다.
- **계약.** 예약 키를 보내면 7+5개 도구가 `INVALID_INPUT`이다. `tools/list`에 `_sessionProof`가 없다(Codex·Claude 프로필).
- **stdio.** MCP SDK client로 `callTool({name, arguments, _meta})`를 보내는 f1·host-composition 시험을 새 경로로 바꾼다. `_sessionProof`·`_sessionBinding`을 쓰는 시험 파일 약 33개를 고쳐 쓰거나 지운다. 집계는 grep 기준으로 `_sessionProof` 15개, `_sessionBinding` 18개이며 겹치는 파일이 있다.
- **변이 확인.**
  - Codex 판정에서 `parent_thread_id` 검사를 지우면 child 시험이 실패해야 한다.
  - `admitCaller`에서 순환 검사를 지우면 순환 시험이 실패해야 한다.
  - admission 회수에서 DELETE를 SELECT로 바꾸면 재회수 시험이 실패해야 한다.

### 6.2 실호스트(Linux 테스트 서버, Windows 시험 서버)

공통 채집 장치는 서버의 `binding_check` 진단 이벤트에 `_meta`의 **키 이름과 판정 결과만** 남긴다. 값과 본문은 남기지 않는다.

| 호스트 | 확인 | 합격 기준 |
| --- | --- | --- |
| Codex 0.166(및 설치 버전) | 메인 직접 호출, `functions.exec` 중첩 호출, ThreadSpawn·review subagent 호출, fork·resume 뒤 호출, 병렬 호출 10개, 승인 대기 6분 | 메인은 전부 성공한다(BINDING_REQUIRED 0건). subagent·2단 subagent는 성공하고 진단에 child·사슬 길이가 남는다. Codex 승인 프롬프트가 정책대로 뜬다(D-0180) |
| Claude Code 2.1.316 | 메인 호출, Agent subagent 호출, `/clear` 뒤 호출, 병렬 호출, 다른 plugin의 PreToolUse가 있는 상태 | 메인·subagent 모두 성공한다. `/clear` 뒤에는 새 세션 ID로 기록된다. admission 행이 남지 않는다 |
| agy 1.4.12 | 메인 호출, subagent·2단 subagent 호출 | 모두 `_meta` 대화 ID로 성공하고 child·사슬이 기록된다 |

각 실행은 대상 commit, 명령, 종료 코드, 진단 줄 수를 남긴다. 실패하면 같은 시험을 되풀이하지 않고 채집한 키 목록과 판정 사유로 원인을 좁힌다.

## 7. 결함 처분

| 결함 | 처분 | 근거 |
| --- | --- | --- |
| D-0019 | 정책 변경으로 재정의 후 해소 | root 전용을 버렸다(2.0). child는 관측되면 허용하고 기록한다. 관측이 없으면 거부한다. Codex·agy는 `_meta` 부모 표식, Claude는 `agent_id` |
| D-0020 | 해소 | 어떤 호스트에도 allow 출력이 없다 |
| D-0021 | 해소 | 인자 주입이 없다. admission은 AGS 서버만 회수한다 |
| D-0033 | 해소(삭제) | transcript-latest 경로 삭제 |
| D-0034 | 해소 | 오류 모형 설계는 현행에서 해소로 판정했다. 이 설계는 해당 경로(Codex 해석)를 지우고 Claude 사유를 나눈다 |
| D-0055 | 해소 | continuity 발급 hook 삭제. 오류 모형 설계는 현행 해소로 판정했다 |
| D-0056 | 해소 | token 없는 caller 결속. 실패 보고는 오류 모형 설계를 따른다 |
| D-0076 | 해소 | 계약·서비스에서 `_sessionBinding` 삭제 |
| D-0179 | 해소(삭제) | fallback 서명 경로 삭제. 발신 줄이 없거나 손상되면 세션 기록을 쓰고, 그것도 없으면 `unavailable`이다 |
| D-0180 | Codex 해소 | Codex hook 삭제. 실호스트 승인 프롬프트 확인이 종결 조건이다 |
| D-0302 | 기전 제거. 종결은 실호스트 근거로 | 6.2 Codex 행 |
| D-0315 | 해소 | Codex root·child가 모두 `_meta` 관측값이다 |
| D-0317 | 해소 | agy 신원이 hook을 거치지 않는다. 호출 ID는 여전히 없지만 결속에 쓰지 않는다 |
| D-0296 | 실행 관측 token 부분은 삭제로 해소 | 메시지 영수증의 옛 형식 경로는 broker 설계 범위다 |
| D-0352 | 무관 | 접수·스킬 지침 결함이며 결속과 원인이 다르다 |

## 8. 병렬 설계와 겹침

- **현황판(`ags-5970-board`, `docs/ags30-session-board-design.md`).** 이미 작업 사본에서 `governance-hook.ts`의 board 분기와 `hooks/hooks.json`의 board hook을 지우고 `server.ts` `sessionBoardResult`를 다시 쓰고 있다(미커밋 diff 확인). 그 설계는 「서버가 검증한 binding」을 전제한다. 이 설계는 그 binding의 출처만 `caller`로 바꾸므로 충돌하지 않는다. `server.ts`·`governance-hook.ts`·`hooks/hooks.json`·`contracts/types.ts`는 같은 파일이므로 먼저 들어간 쪽에 맞춰 다시 적용한다.
- **오류 모형(`ags-5970-errors`, `docs/ags30-error-model.md`).** D-0034·D-0055를 현행 해소로, D-0056을 `bindOpenedRoot` 사유 반환으로 처리한다. 이 설계는 `bindOpenedRoot`의 입력을 token에서 caller로 바꾸고 사유 체계는 그대로 쓴다. `failureReason`을 hook 사유 분류에 재사용한다.
- **broker(`ags-5970-broker`, `docs/ags30-broker-redesign.md`).** `session-message-hook.ts`와 `session-message-service.ts`를 크게 바꾼다. 이 설계의 메시지 변경은 `_sessionBinding` 주입 삭제와 `caller` 매개변수뿐이다. agy runner도 두 설계가 함께 건드린다.
- **gates(`ags-5970-gates`, `docs/ags30-gates-design.md`).** 실행 하한은 남는다(그 문서 2장 #4). 그래서 `execution`을 유지한다. 관문의 lease actor와 기록자 actor는 이 문서의 `caller.actor.id` 하나를 쓴다. `provenance`가 `host-observed`이면 「감사자 ≠ 구현자」 비교를 검증된 판정으로 다룬다. `caller` 계약의 정본은 이 문서 2.1이다.

## 9. 남은 제약

- Codex 판정은 0.164–0.166 소스에 근거한다. 실호스트 채집 전에는 「채집 확인」으로 보고하지 않는다. 다른 버전에서 `_meta` 형식이 바뀌면 거부되고 사유가 남는다. 감시 작업은 두지 않는다.
- Claude `claudecode/toolUseId`는 공식 문서가 아니라 설치 바이너리 문자열로 확인했다. 바뀌면 `CALL_ADMISSION_MISSING`으로 거부된다.
- agy는 호출 ID가 없어 실행 관측이 없다. agy Windows 채집은 시험 서버 로그인 전이라 하지 못했다(Linux 1.4.12만 확인).
