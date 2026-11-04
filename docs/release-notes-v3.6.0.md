# AGS 3.6.0 릴리스 노트

3.6.0은 세션 작업 기록(continuity)을 스킬이 아니라 MCP 도구로 쓰게 하고, 사용자 메시지마다 스킬 선택과 기록을 다시 확인하게 한다. 함께 묶은 결함은 계획에서 자기 할 일 누락, 사용자 할 일과 에이전트 할 일 혼동, 옛 workflow root의 경로 점유, 오프라인 peer 대기, Codex 첫 `start_workflow` 실패다. 사용자 원문은 「컨텍스트 스킬을 그런용도로 만들어놨는데 아예 사용을 못하고있잖아.」「아예 스킬로 두지 말고 MCP 도구로 전환해.」「그리고 그 도구 설명에 이러할때 그런 도구들을 호출해라. 명확히 써놔.」「그리고 턴마다 상황이 바뀌면 스킬도 다시 상황에 맞게 선택하는 기능이 구현되긴한거야?」이고, 범위는 「지금 내가 말한것들 전부 모아서 3.6.0 으로 발행해.」「A~H 다 구현하고 개발해.」로 정했다.

호환성:

- `context-continuity` 스킬이 없어졌다. 같은 일은 MCP 도구와 hook이 맡는다.
- 새 도구 `release_convergence_root`가 생겼다. ROOT_CONFLICT의 `details`에 필드가 늘었다(아래).
- 다른 세션의 root를 frame 변경으로 claim하거나 교체하면 ROOT_NOT_OWNED로 거부된다. 소유자가 없는 root는 지금처럼 동작한다.
- mutation-risk-preflight의 `mutation-intent.v1` schema에서 승인 근거의 `expiresAt`이 필수가 아니게 됐다.
- 메시지 key `hooks.checkpointCue.skills`, `server.workflowChange.stage`·`skills`·`classification`이 늘었고 `hooks.checkpointCue.notice` 문구가 바뀌었다.
- workflow를 바꾸는 도구의 성공 응답에 text content가 하나 더 붙는다(첫 content의 JSON은 그대로다).
- `get_session_message_status`의 `wake`는 이제 그 메시지가 대기 중일 때 시작된 깨우기 시도만 보여 주고, 없으면 `null`이다. 3.5.x까지는 메시지와 무관하게 대상의 최신 시도를 보여 줬다.
- Codex 플러그인 `hooks/hooks.json`에 Stop `session-message-hook`이 늘었다. Windows 입력·도구 뒤·턴 종료 명령은 `--host-pid (Get-CimInstance …)` 대신 `--host-shell-pid $PID`를 넘긴다.
- messaging hook 실패 보고(`peer-hook-failure`)에 멈춘 단계 `step`이 늘었고, 상한에 걸리면 `reason: HOOK_BUDGET_EXPIRED`를 남긴다.

## 세션 작업 기록을 MCP 도구로

### 원인

- 3.5.x에서 작업 기록 저장은 `context-continuity` 스킬이 판단하고 `checkpoint_context`를 부르게 되어 있었다. 실제 세션에서 스킬을 고르지 않아 사용자 교정이 저장되지 않았다(「애초에 저 스킬이 있어도 안쓰는구먼.」).
- workflow root가 묶인 세션에서는 `checkpoint_context`가 SNAPSHOT_CONFLICT(`continuity.checkpoint.disabledAfterRoot`)로 거부됐다. 사용자 교정·남은 일은 workflow 원장에 들어가지 않으므로, workflow를 시작한 뒤에는 저장할 곳이 없었다.

### 바뀐 점

- `context-continuity` 스킬을 없앴다. 저장·복원은 MCP 도구(`checkpoint_context`, `inspect_context`, `load_context`, `suppress_context_restore`, `purge_direct_context`)와 hook이 맡는다.
- 도구 설명에 호출할 때를 적었다. `checkpoint_context`는 (1) 교정·새 결정·승인·금지, (2) 추가 작업·남은 일 변경, (3) 단계 완료·실패, (4) 계획·남은 일 보고 직전에 부른다.
- workflow 진행 중에도 저장할 수 있다. 압축 뒤 복원에는 세션 기록 카드와 workflow 카드를 함께 낸다. 세션의 workflow가 모두 끝나 epoch가 넘어가도 세션 기록은 같은 revision으로 다음 epoch에 이어진다.

## 메시지마다 스킬 선택과 기록 확인

### 원인

공통 접수 기준에 「목표·범위·위험이 달라지면 스킬 선택을 다시 판단한다」는 문장만 있었고, 그 시점을 알려 주는 장치가 없었다.

### 바뀐 점

- 사용자 메시지마다 continuity hook이 짧은 `[AGS 턴 확인]` 안내를 낸다. 메시지가 교정, 새 결정·승인·금지, 추가 작업, 범위 변경이면 (1) 스킬 선택을 다시 판단해 필요한 스킬을 지금 호출하고 (2) `checkpoint_context`로 사용자 원문과 남은 일을 저장하라는 내용이다. 바뀐 것이 없는 메시지에는 아무것도 더하지 말라고 함께 적었다.
- Claude Code·Codex는 UserPromptSubmit에서, agy는 UserPromptSubmit이 없으므로 각 턴 첫 모델 호출(PreInvocation `invocationNum` 0)에서 ephemeral message로 낸다. 호스트 이름 분기는 없다.

### 목적별 스킬 대조

위 안내만으로는 행동이 분명한 스킬만 쓰였다. 코드면 `ponytail`, 병합·태그·릴리스면 `mutation-risk-preflight`·`change-scope-guardian`이었다. 문제의 성격으로 골라야 하는 스킬은 고르지 않았다. 동시성·DB 판단의 `cs-engineering`, 시험 설계의 `test-engineering`, 반복 실패의 `blocker-diagnostician`이 그렇다. 기존 안내는 질문·인사·진행 확인에는 아무것도 더하지 말라고 적었다. 그래서 질문 형태의 요청에서 스킬을 다시 고르라는 근거가 없었다. 앞 턴에서 부른 스킬의 지침은 대화에 남아 다음 턴에도 작용했다(사용자 원문 「왜 적재적소에 써야될 스킬을 못쓰고있어」「두번째턴에서 a라는 스킬의 영향을 받는가?」).

- 매 메시지 안내에 설치된 스킬마다 `classification.json`의 대상을 한 줄씩 싣는다(예: `- cs-engineering: concurrency, database, messaging, algorithms, resource-lifetime, performance`). 목록은 설치된 파일에서 만들므로 설치되지 않은 스킬은 싣지 않고 설치된 스킬은 빠뜨리지 않는다(`mcp-server/src/skill-intake.ts`의 `installedSkillTargets`). 대상이 비어 있는 분류 파일은 조용히 건너뛰지 않고 오류로 낸다.
- 안내 문구가 바뀌었다. 답하거나 다음 도구를 쓰기 전에, 이번 메시지가 요구하는 판단·행동을 각 스킬의 대상과 대조한다. 맞는 스킬은 그 판단·행동 전에 지금 호출한다. 질문·확인 요청도 포함한다. 고르는 기준은 이름·키워드가 아니라 실제로 할 판단이다.
- 앞서 호출한 스킬의 지침은 그때의 판단·행동에만 적용되며, 이번 목적에 맞지 않으면 적용하지 않는다. 서브에이전트에 맡길 때는 고른 스킬을 지시문에 적는다.
- 한계:
  - 스킬 본문은 호스트가 대화에 남기고 압축 뒤에도 다시 넣는다. AGS는 그 본문을 지울 수 없고, 안내 문구로 적용 범위만 제한한다.
  - 안내는 메시지마다 약 1,700자 늘어난다.
  - 이 안내가 실제 에이전트 행동을 바꾸는지는 실호스트 비교 평가로 확인한다(검증 절).

### workflow가 바뀔 때의 스킬 재선택

workflow를 고치는 것은 하려는 일이 바뀌었기 때문이다. 그런데 그 지점에서도 스킬은 다시 골라지지 않았다. 계획의 단계마다 붙은 `skillId`는 그 단계 결과를 어떤 provider 계약으로 기록할지를 정하는 값이다. 응답에는 다음 단계 ID만 나왔고, orchestrator 지침은 이 값을 단계의 「담당 스킬」이라고 불렀다. 그래서 단계마다 스킬 하나만 쓰는 것처럼 작동했다(사용자 원문 「워크플로우를 수정할때 스킬선택이 변경되어야 하지 않을까?」「왜 그 지점에 그 스킬만 선택이 되도록 강요되고있지?」).

- workflow를 바꾸는 도구가 성공하면 응답에 안내를 하나 더 싣는다. 대상 도구는 `plan_workflow`, `start_workflow`, `start_guarded_workflow`, `record_stage_result`, `claim_workflow_attempt`, `resolve_convergence_gate`, `open_convergence_root`, `release_convergence_root`, `finalize_workflow`, `abort_workflow`다.
- 안내에 들어가는 내용:
  - 지금 할 단계와 그 provider. provider는 결과를 기록하는 계약으로만 소개한다.
  - 설치된 스킬 전체의 대상 목록.
  - 다음 판단·행동을 이 목록과 대조해 맞는 스킬을 모두 호출하라는 문장. 맞는 스킬은 0개일 수도, 여럿일 수도 있다.
  - provider가 그 단계에서 쓸 스킬을 제한하지 않고, 다른 스킬을 쓰는 데 계획 수정이 필요 없다는 문장.
  - 앞 단계 스킬의 지침은 그 판단에만 적용된다는 문장.
- 서버에 스킬 분류 지원이 설정돼 있으면 `classify_skills` 조언을 받아 채택·교정·기각하라는 줄을 더한다. 분류 지원은 JEV 계층을 쓰는 한 용도이며, 이 안내가 JEV를 스킬 분류 전용으로 만들지 않는다.
- 거부된 호출과 workflow를 바꾸지 않는 도구에는 안내를 붙이지 않는다.
- orchestrator 지침의 단계 기록 문장을 「결과를 기록하는 provider 계약」으로 고쳤다.
- 시험: `tests/mcp/workflow-skill-reselection.test.ts`.

## 계획 누락과 할 일 구분

- 계획이나 남은 일 목록을 만들거나 보고하기 전에 저장된 작업 기록을 불러 사용자 원문, 승인됐지만 끝나지 않은 일, 이전 판에서 넘어온 일과 대조하고, 대조한 출처와 범위를 함께 보고하게 했다(「자기가 할일 자기가 못챙기는건데.」).
- 사용자만 할 수 있는 일이 남으면 「사용자가 할 일」과 「에이전트가 이어서 할 일」을 나눠 적게 했다. 프로세스·서버·앱을 멈추거나 바꾸기 전에는 이 세션이나 다른 세션이 거기 연결돼 있는지 확인한다.

## 옛 workflow root의 경로 점유

### 원인

끝나지 않은 옛 workflow root가 상위 경로를 쓰기 범위로 잡고 있으면, 그 아래 경로의 새 workflow가 ROOT_CONFLICT로 막혔다. 오류만으로는 그 root가 언제 것인지, 소유 세션이 살아 있는지, 무엇을 해야 하는지 알 수 없었다. root를 놓는 공개 도구도 없었다.

### 바뀐 점

- `start_workflow`·`open_convergence_root`의 ROOT_CONFLICT `details`에 막는 root의 정보를 싣는다. 생성·갱신 시각과 revision(참고값), 최신 run, 소유 세션의 presence, 다음 행동이다.
- 새 도구 `release_convergence_root`로 root를 놓는다.
  - 자기 root는 open·needs-review·needs-user 상태에서 놓을 수 있다.
  - 다른 세션의 root는 호출 시점에 소유 세션이 online이 아니고 `userApprovalRefs`에 사용자 결정이 있을 때만 놓을 수 있다.
  - 놓은 root는 abandoned가 되고, 진행 중인 run은 같은 트랜잭션에서 blocked(root-released)로 닫힌다. 누가·언제·어떤 presence 판독과 승인으로 놓았는지 root에 기록된다.
  - 돌아온 소유자는 ROOT_RELEASED를 받는다.
- 다른 세션의 root를 frame 변경으로 claim하거나 교체하는 길은 ROOT_NOT_OWNED로 막았다. 소유자가 없는 root는 지금처럼 동작한다.
- 상태 정리는 continuity 작업이 묶은 root 중 하나라도 활성이면 그 작업을 보호한다. 전에는 최신 root만 봤다.

## 오프라인 peer와 검증 역할

- `send_session_message` 설명에 수신자가 오프라인일 때의 행동을 적었다. 답을 기다리며 멈추지 않고 답이 필요 없는 일을 계속하며, 답이 필요한 단계 직전에 `get_session_message_status`로 다시 확인한다. 답 없이 진행할 수 없으면 누구의 답을 기다리는지 사용자에게 알린다.
- 서브에이전트 위임 기준에, 검증 에이전트에게는 최종 빌드·패키지 회귀 시험처럼 스스로 판정할 일을 맡기고 빌드 지켜보기 같은 대기 작업은 맡기지 말라고 적었다.

## Codex 첫 `start_workflow` 실패

### 원인

Codex 0.166.0은 stdio MCP 서버에 기본 환경 변수(HOME, PATH 등)와 `env_vars`에 적은 이름만 넘긴다(`codex-rs/rmcp-client/src/utils.rs`). AGS `.mcp.json`에 `env_vars`가 없어 `AGENT_GOVERNANCE_*`·`XDG_STATE_HOME`·`LOCALAPPDATA`가 서버에 가지 않았고, hook과 서버가 서로 다른 상태 DB를 봤다. 그래서 hook이 기록한 작업 폴더를 서버가 몰라 첫 `start_workflow`가 「workspace가 필요하다」로 실패했다.

3.6.0 후보(`4982457`)의 실호스트 A/B에서는 workspace를 생략한 첫 `start_workflow`가 Codex 2회 중 2회, Claude Code 2회 중 1회 같은 오류로 실패했다. 원인은 시험 환경에 있었다. 시험 서버의 전역 Codex 설정에 옛 시험 빌드 AGS 3.0.0-rc.1 두 개가 켜져 있었고, 이 빌드는 옛 현황판 형식(표 `sessions`)을 쓴다. 그래서 현황판 파일 `~/.agent-governance-suite/session-board.sqlite3`에 `board_sessions` 옆에 `sessions`가 다시 생겼다. 3.x는 2.x 형식과 호환하지 않으므로 이 파일을 `BOARD_FOREIGN_DATABASE`로 거부하고, hook은 작업 폴더를 기록하지 못했다(그날 기록 0건, 실호스트 Claude 1회 debug 로그의 `board-hook-failure {"phase":"open"…}`). 거부 자체는 의도한 동작이다. 결함은 서버가 이 읽기 실패를 「호스트가 이 세션의 작업 폴더를 알리지 않았다」로 보고해 실제 원인을 가린 것이다. 3.5.3도 같은 상태였고, 3.5.3 쪽 에이전트는 처음부터 workspace를 직접 넘겨서 이 오류를 만나지 않았다.
<!-- TODO 수정 후보 A/B에서 workspace 생략 시 성공 건수, env_vars 수정 확인 범위 -->


### 바뀐 점

- Codex용 `.mcp.json`(ko·en)에 `env_vars`로 서버가 읽는 `AGENT_GOVERNANCE_*` 전부와 `XDG_STATE_HOME`·`LOCALAPPDATA`를 적었다.
- `tests/tooling/codex-mcp-env.test.mjs`가 서버·session-board 소스에서 읽는 `AGENT_GOVERNANCE_*` 이름을 모아 두 `.mcp.json`에 빠짐없이 있는지 검사한다.
- `AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE`은 넘기지 않는다. 도구 schema profile은 호스트 패키지가 정하므로, 사용자 셸에 남은 값이 Codex의 profile을 바꾸면 안 된다. 시험이 이 이름이 빠져 있는지 확인한다.
- workspace를 생략한 `start_workflow`가 현황판을 읽지 못하면 「작업 폴더 기록(현황판)을 읽지 못했다(원인 코드)」로 보고한다(`details.reason` `SESSION_RECORD_UNREADABLE`, `details.cause`에 원인 코드). 기록이 없을 때만 「호스트가 알리지 않았다」를 쓴다. 현황판 hook의 실패 진단에도 `BOARD_FOREIGN_DATABASE`를 그대로 남긴다.
- `tests/mcp/minimal-workflow-start.test.ts`가 읽을 수 없는 현황판에서 이 오류와 원인 코드를 검사한다.

## 만료일 없는 승인

### 원인

mutation-risk-preflight의 `mutation-intent.v1` schema가 승인 근거마다 `expiresAt`을 요구했다. 사용자가 기한 없이 준 승인(예: 「3.6.0으로 발행해.」)은 `intent/approvalEvidenceRefs/0 must have required property 'expiresAt'`(INVALID_INPUT)로 거부됐다. 이를 피하려면 에이전트가 사용자가 말하지 않은 만료일을 지어내야 했다.

### 바뀐 점

- `expiresAt`은 선택 항목이 됐다. 근거에 만료일이 없는 승인은 만료되지 않는다. 만료일이 적힌 승인은 지금처럼 그 시각부터 만료로 판정한다(`skills/mutation-risk-preflight/scripts/evaluate-preflight.mjs`).
- 시험(`tests/mutation-risk-preflight/d0220-expiry.node-test.mjs`): 만료일 없는 승인은 READY다. 같은 승인이 다른 작업을 가리키면 NEEDS_APPROVAL이다.

## 최종 후보가 바뀐 workflow

실행 중인 run의 `artifactContracts`를 새 후보로 바꾸는 공개 API는 없다. run 계약은 고정이다. `resolve_convergence_gate`의 resume-new-epoch는 frame만 바꾸고 envelope은 그대로 두므로, 다시 claim하면 또 FRAME_REVIEW_REQUIRED가 난다. 시험으로 확인한 경로를 `open_convergence_root` 설명에 적었다.

1. run을 중단한다.
2. 새 taskEnvelope로 claim해 FRAME_REVIEW_REQUIRED로 root를 검토 상태로 만든다.
3. `parentRootId`·새 taskEnvelope·사용자 승인으로 교체 root를 연다.
4. 그 root에서 계획·claim·시작한다.

이전 run의 계약 기록은 바뀌지 않는다(`tests/mcp/candidate-rebind.test.ts`). receipt에 rootId가 없어 run으로 root를 찾는 공개 조회는 아직 없다.

## 훅 시간 초과와 Codex 메시지 전달

### 원인

Codex hook이 가끔 10초 제한에 걸리고, peer 메시지가 약 170초 늦게 전달됐다. 시험 서버에서 AGS 3.5.3으로 측정한 결과(2026-11-04):

- Windows Codex의 입력·도구 뒤 hook은 매번 PowerShell로 `Get-CimInstance Win32_Process`를 돌려 host PID를 구했다. 이 조회가 hook 시간의 75%(한가할 때), 85%(동시 8개), 87%(CPU 포화)였다. host PID는 relay 복구 때만 필요하다.
- SQLite 잠금 대기는 최대 32ms로 원인이 아니었다. 다만 외부에서 7초 동안 잠그면 약 5.5초에 `MESSAGING_BUSY`가 났고, Codex 진입점에는 실행 상한이 없었다.
- 사용자 입력 직후에는 다음 도구 경계 한 번을 유예한다. Codex에는 턴 종료 claim이 없어, 도구를 한 번만 쓰는 턴에서는 유예만 풀리고 본문은 그 턴에 전달되지 않았다(3번 중 3번 재현). 다음 턴까지 기다린 것이 170초 지연이다.
- 메시지 status의 `wake`는 그 메시지가 아니라 대상의 최신 시도를 보여 줘, 다른 메시지의 옛 시도가 보였다.

### 바뀐 점

- **host PID 지연 조회:** Windows hook은 PowerShell 자기 PID만 넘기고, relay 복구가 실제로 필요할 때만 OS 조회로 Codex PID를 읽는다. 복구 때의 신원 비교 규칙은 같다. Windows hook 시간(p50)이 단일 호출 624→403ms, 동시 4개 1695→1179ms, 동시 8개 3228→2389ms로 줄었다. 복구가 필요한 hook은 조회 한 번(약 0.7~0.8초)이 든다.
- **Codex 실행 상한:** `session-message-hook` 진입점은 hooks.json `timeout`(10초)에서 시작 전 몫 3초와 출력 몫 0.5초를 뺀 6.5초를 상한으로 쓴다. 본문 claim은 1초 이상 남았을 때만 시작한다. 상한에 걸리면 멈춘 단계를 실패 보고에 남기고 아무것도 출력하지 않는다(fail-open). 동기 SQLite 대기 자체는 끊을 수 없어 10초 안 종료를 보장하지는 않는다. 시작 전 몫 3초는 측정이 아닌 추정값이다.
- **Codex Stop 턴 종료 claim:** Codex Stop hook이 턴 끝에서 대기 본문을 인수해, 사용자 요청을 끝낸 뒤 이어지는 턴으로 전달한다. 호스트가 이미 한 번 이어 준 턴(`stop_hook_active`)에서는 인수하지 않는다. 이어지는 턴은 사용자 턴마다 최대 한 번이다.
- **메시지 status의 `wake`:** 그 메시지가 대기 중일 때(생성부터 ACK까지) 시작된 시도만 보여 주고, 없으면 `null`이다.

PostgreSQL 전환(3.7.0)은 잠금 문제를 없애지만 위 PowerShell 조회, 유예, `wake` 표시 문제는 고치지 않으므로 이번 판에서 따로 고쳤다.

## 확인한 것: Codex에서 AGS 도구가 안 보이던 실행

3.5.3 실호스트 시험에서 Codex 실행 6회 중 1회는 AGS 도구가 보이지 않았다. 그 실행에는 AGS 플러그인 3개가 설치돼 있었고 시험 하네스는 2개만 껐다. Codex는 MCP 서버 이름이 겹치면 하나를 건너뛴다. 제품 결함이 아니라 하네스 결함으로 보고, 이번 시험부터는 AGS 한 판만 켜고 한 번에 한 실행만 돌린다. 건너뛴 경고 로그는 그 실행에서 남기지 않아 직접 확인하지 못했다.

## 검증

대상 커밋은 `4982457182cfe737d87d46f0b8d681b3afc2f3d4`다.

- **CI:** run 41828340699, `Node 24 / ubuntu-latest`·`Node 24 / windows-latest` 모두 success.
- **정적 검사 10종:** `i18n --check`, Claude·en 패키지 `--check`, `check-skill-context-optimization`, `check-source-lock`, `sync-release-metadata`, `check-bundle`, `validate-repository`, eslint, `tsc --noEmit` 모두 종료 코드 0.
<!-- TODO Linux·Windows 시험 서버, 실호스트 A/B -->

### 이번에 고치지 않은 것

- 서브에이전트에는 스킬 목적 안내가 닿지 않는다. 메시지마다 나가는 안내는 사용자 메시지(UserPromptSubmit)에서만 나가고, AGS는 서브에이전트 시작 이벤트(Claude Code `SubagentStart`)를 등록하지 않는다. 그래서 부모가 지시문에 스킬을 적지 않으면 서브에이전트는 스킬 대조 안내를 받지 못한다. workflow 변경 안내만 서브에이전트가 workflow 도구를 부를 때 닿는다. 다음 판에서 서브에이전트 시작 hook으로 고친다.
- 메인 에이전트에게 서브에이전트 위임을 권하는 안내가 없다. 기본값은 직접 수행이고, 사용자가 요청하지 않으면 순이익 조건을 모두 확인해야 위임한다. 독립적으로 나눌 수 있는 일에서도 위임 검토로 이어지지 않는다. 위 서브에이전트 안내와 함께 다음 판에서 고친다.
- 3.5.3 실호스트 시험에서 agy 실행 1회가 약 7분 동안 응답하지 않았다. 그동안 AGS hook 프로세스는 돌지 않았고, 원인은 확인하지 못했다. <!-- TODO A/B 재발 여부 -->
