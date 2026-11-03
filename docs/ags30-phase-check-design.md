# 단계 누락 확인 설계

기준 commit: `689a95c2`(v3.0.1). 줄 번호는 모두 이 commit 기준이다. 이 문서는 설계만 담는다. 구현과 시험 결과는 적지 않는다.

## 1. 목적

사용자 원문:

- 「agent가 예를들어 개발이란걸 한다 했을때 설계 -> 분석 -> 개발 -> 테스트 -> 배포... 뭐 이런단계들을 거치잖아? 빼먹고 할까봐 그랬어.」
- 「결국 단계가 누락되면 … 에이전트만 알아도 돼」
- 「대신 효율적으로 동작하는 방법을 찾아줄래?」
- 「대신 에이전트가 "아 제가 이 단계를 빼먹었네요. 이 단계를 다시 진행하겠습니다." 같은 피드백이 보였으면 좋겠어.」

사용자 확정 결정:

- 스킬과 단계는 AGENT가 고른다. AGS는 상기하고 관측만 한다.
- 단계가 이어지는 변경 작업은 workflow(`plan_workflow`)로 시작하는 것을 기본으로 한다.
- 단계가 빠지면 작업을 마치기 전에 에이전트가 알아차리게 한다. 차단하지 않는다. 사용자 화면에 따로 띄우지 않는다.

## 2. 현재 구조와 공백

| 번호 | 사실 | 근거 |
| --- | --- | --- |
| G1 | 완료 관문은 계획된 stage가 모두 passed일 때만 통과한다. workflow에 진입해야만 동작한다. | `mcp-server/src/workflow-service.ts:858-865` |
| G2 | 접수 기준이 직접 처리를 권해서 workflow에 거의 들어가지 않는다. | `skills/orchestrator/SKILL.md:25`, `:27` |
| G3 | stage는 요청한 capability로만 만든다. 처음부터 시험을 빼고 계획해도 완료 관문을 통과한다. 자동으로 붙는 것은 감사 하나다. | `workflow-service.ts:1077-1083` |
| G4 | 파일 편집 도구 호출은 이미 continuity hook의 tool-boundary(before)를 지나지만 아무 일도 하지 않는다. | `mcp-server/src/continuity-hook.ts:114-123`, `claude-plugin/hooks/hooks.json:117` |
| G5 | Stop은 continuity hook에서 `turn-end`로 정규화되지만 처리하지 않는다. | `mcp-server/src/builtin-hook-host-adapters.ts:46`, `continuity-hook.ts:128` |
| G6 | 관측 기록 테이블이 이미 있다. 스키마를 바꾸지 않고 이벤트 행을 추가할 수 있다. | `mcp-server/src/continuity-store.ts:541-548`, `:874-882` |

## 3. 설계

### 3.1 접수 기준 문구

`skills/orchestrator/SKILL.md`의 `:25`와 `:27`을 고쳐 쓴다. 문장을 덧붙이면 기존 문구와 충돌한다.

- 설계·구현·시험·반영처럼 단계가 이어지는 변경 작업은 `plan_workflow`로 시작한다. 필요한 단계는 AGENT가 capability로 고른다.
- 질문 답변, 설명, 한 줄 수정, 전문 스킬 하나로 끝나는 작업은 지금처럼 직접 처리한다. workflow run을 만들지 않는다.

이 문구는 MCP 서버 instructions(`mcp-server/src/server.ts:377`)와 Claude 플러그인 사본(`scripts/build-claude-plugin.mjs:172`)으로 전달된다.

### 3.2 관측: 편집 기록

continuity hook의 tool-boundary(before)에서 도구가 파일 편집 도구이면 그 세션의 현재 task에 `phase-edit` 관측을 남긴다.

- 편집 도구: Claude `Edit`·`Write`·`MultiEdit`·`NotebookEdit`, Codex `apply_patch`, agy `write_to_file`·`replace_file_content`·`multi_replace_file_content`(runner에서 `Write`·`Edit`·`MultiEdit`로 매핑).
- 셸(`Bash`·`PowerShell`·`run_command`)과 위임(`Agent`·`Task`)은 세지 않는다. 읽기만 하는 turn이 걸리는 오탐이 생기기 때문이다. 셸을 통한 변경과 배포는 관측하지 못한다(5장).
- 행이 쌓이지 않게 한다. 마지막 `phase-edit`이 마지막 `phase-check`보다 뒤에 있으면 새 행을 남기지 않는다.
- root actor만 기록한다(`input-observation.ts:49`의 기존 `actorAccess`). child의 편집은 관측하지 못한다(5장).

### 3.3 확인: Stop 1회

Stop(`turn-end`, lifecycle `none`)에서 다음 순서로 판단한다. SessionEnd(lifecycle `end`)는 대상이 아니다.

1. 마지막 `phase-edit`이 없거나, 마지막 `phase-check`보다 앞이면 출력 0으로 끝난다.
2. 빠진 단계를 저장된 상태에서 결정적으로 산출한다. LLM을 부르지 않는다.
   - task에 workflow root가 없으면: 「workflow 없이 변경함」.
   - root가 있고 convergence가 끝났으면: 빠진 단계 없음.
   - root가 있으면 최신 run에서 passed가 아닌 stage의 `stageId`(`requiredCapability`)를 모은다.
   - workflow 저장소를 열 수 없으면: 「단계 상태 확인 불가」. 빠뜨리지 않고 드러낸다.
3. `phase-check` 관측을 남긴다. `success`는 빠진 단계가 없을 때 1이다.
4. 빠진 단계가 있으면 아래 문구를 호스트 형식으로 낸다. 없으면 출력 0.

문구(고정 문자열에 빠진 단계 이름만 넣는다):

```text
[AGS 단계 확인] 이번 작업에서 파일 변경이 관측됐고 다음이 확인되지 않았다: <빠진 단계>.
먼저 어떤 단계를 빠뜨렸는지 사용자에게 밝혀라. 그 단계가 이번 작업에 필요하면 지금 진행하라. 필요 없으면 이유를 한 줄로 밝히고 끝내라.
```

같은 내용을 다시 내지 않는다. 확인 뒤 새 편집이 없으면 1번에서 끝난다. 확인 뒤 다시 편집하면 다음 Stop에서 한 번 더 확인한다. 이유는 따로 저장하지 않는다. 에이전트의 답변 본문이 이유다. `record_skill_selection`은 분류 기록이 서버 메모리에만 있어서 hook이 쓸 수 없다(`skill-classification/gateway.ts:64-66`).

### 3.4 호스트별 출력과 등록

| 호스트 | 편집 관측 등록 | Stop 등록 | Stop 출력 |
| --- | --- | --- | --- |
| Claude | 있음(`claude-plugin/hooks/hooks.json:117`의 continuity PreToolUse) | Stop에 continuity hook 추가 | `hookSpecificOutput: {hookEventName: "Stop", additionalContext}`. 공식 문서상 오류 표시 없이 대화를 이어 간다. `decision: "block"`은 hook 오류로 표시되므로 쓰지 않는다. |
| Codex | PreToolUse `^apply_patch$`에 continuity hook 추가 | Stop에 continuity hook 추가 | `{decision: "block", reason}`. 공식 문서상 `reason`이 새 이어 가기 프롬프트가 된다. Stop은 JSON만 허용한다. |
| agy | 있음(PreToolUse 단계 목록에 continuity, `antigravity-hook-runner.mjs:1548-1550`). `TOOL_NAME_MAP`(`:60-65`)에 편집 도구 3개 추가 | Stop 단계에 continuity 추가(`:1617-1627`), session-message 결과와 합친다 | canonical `additionalContext`를 runner가 `{decision: "continue", reason}`으로 바꾼다(`:795-799`). 두 단계의 문구는 한 `reason`으로 합친다. |

Codex 출력 형식은 continuity hook이 host 인자로 정한다(`resolveHookHost`, 기본값 `codex`).

### 3.5 바꾸는 파일

- `skills/orchestrator/SKILL.md`: 3.1.
- `mcp-server/src/continuity-store.ts`: 이벤트의 마지막 `observation_id`를 읽는 메서드 1개.
- `mcp-server/src/continuity-service.ts`: `recordEditForSession`, `phaseCheckForSession`.
- `mcp-server/src/continuity-hook.ts`: 편집 도구 판정과 기록, `turn-end` 처리, 호스트별 Stop 출력, Stop에서 workflow 저장소 열기(`needsWorkflowState`).
- `claude-plugin/hooks/hooks.json`, `hooks/hooks.json`: 3.4 등록.
- `antigravity-connector/hooks/antigravity-hook-runner.mjs`: 3.4.
- 생성물: `npm run build`, `npm run claude:build`.

새 MCP 도구, 새 테이블, 새 hook 프로세스 종류, LLM 호출은 없다. 평소 turn의 추가 출력은 0이다.

## 4. 시험

- 저장소: 편집 → 확인 → 편집 순서에서 마지막 id 비교가 맞는지.
- 서비스:
  - 편집이 없으면 null
  - workflow가 없으면 「workflow 없이 변경함」
  - 미통과 stage가 있으면 그 이름
  - 모두 통과했으면 null이고 `phase-check`가 남음
  - 같은 확인을 두 번 내지 않음
  - 확인 뒤 편집하면 다시 확인
- hook:
  - Claude Stop 출력이 `hookSpecificOutput.additionalContext`
  - Codex Stop 출력이 `decision: "block"`
  - `Bash`·`Agent`는 편집으로 세지 않음
  - SessionEnd는 확인하지 않음
- agy runner:
  - 편집 도구 매핑
  - Stop에서 session-message와 continuity 문구가 한 `reason`으로 합쳐짐
  - 예산이 부족하면 기존처럼 primary만 실행
- 고치기 전 코드에서는 위 시험이 실패해야 한다.

## 5. 관측하지 못하는 것

- 셸을 통한 파일 변경과 배포.
- subagent(child)의 편집.
- Codex hosted tool의 편집(공식 문서상 로컬 hook 경로를 쓰지 않는다).
- 에이전트가 댄 이유의 진위.
- Codex의 이어 가기 프롬프트가 UserPromptSubmit hook을 다시 실행하는지(이어 가기 동작은 6장에서 확인했지만, UserPromptSubmit 재실행 여부는 출력으로 구분하지 못했다).

## 6. 실제 호스트 확인(2026-11-02, 커밋 `6d54ef40`)

임시 프로젝트의 `notes.txt` 한 줄을 고치게 하고 Stop 뒤의 답변을 봤다. 방법은 개발가이드 「테스트 서버 시험 방법」 6장에 적었다.

| 호스트 | 환경 | 결과 |
| --- | --- | --- |
| Claude Code 2.1.316 | Windows, `--plugin-dir` | 첫 답변 뒤 이어서 「I skipped the governance workflow (plan_workflow) for this change. It isn't needed here because …」(turns=3) |
| Codex 0.166.0 | Windows, 로컬 마켓플레이스 | hook 신뢰 전에는 plugin hook이 실행되지 않아 첫 답변에서 끝남. `--dangerously-bypass-hook-trust`로 실행하면 이어서 「별도 workflow 단계는 생략했으며, 명확한 단일 파일 문구 변경이라 필요하지 않았습니다.」 |
| agy 1.4.12 | Linux, `agy plugin install` | 「이번 작업에서 AGS workflow 시작 단계를 빠뜨렸으나, … 생략하고 마칩니다.」 Stop hook이 실행됨 |

- Codex 사용자는 AGS plugin hook을 `/hooks`에서 신뢰해야 이 기능이 동작한다. 기존 AGS hook(UserPromptSubmit 등)도 같은 조건이다.
- Windows agy는 SSH 세션에서 구독 로그인을 다시 요구해 시험하지 못했다.

## 7. 강제(3.1.0)

기준 commit: `d39d90c5`(v3.0.2). 사용자 원문: 「걍 강제시켜야겠다.」 「워크플로우 만드는 작업.」 「근데 내가 강제하기 싫었던이유가 가벼운작업도 워크플로우 만드는거때문에 절차가 복잡해질까봐였는데, 너가 지금 하고있는 작업자체가 복잡한데도 넌 워크플로우를 안만들었잖아. …」 「AGS는 클로드만 쓰는게 아니라니까?」 이 절은 1장의 「차단하지 않는다」를 바꾼다. 단계 선택은 그대로 AGENT가 한다.

### 7.1 판단

3.3의 「필요 없으면 이유를 한 줄로 밝히고 끝내라」는 자기 선언 면제였고, 다단계 작업이 이 문구로 workflow 없이 끝났다. 판정을 에이전트 선언이 아니라 hook 관측으로 정한다. Stop 반복은 강제 수단이 아니다(Codex는 이어 가기 상한이 없고 Claude는 8회 뒤 무력화된다). 세 호스트가 모두 지원하는 편집 도구 PreToolUse 거부(deny)로 강제한다.

### 7.2 편집 관측과 판정

- 대상 경로: 호스트 adapter가 도구 입력에서 읽는다. Claude `Edit`·`Write`·`MultiEdit`의 `file_path`, `NotebookEdit`의 `notebook_path`. Codex `apply_patch`의 `tool_input.command`에서 `*** Add/Update/Delete File:`와 `*** Move to:` 경로. agy는 runner가 `Write`·`Edit`·`MultiEdit`로 바꾼 도구의 `Path`(agy 1.4.12 CLI의 `write_file`·`edit_file`, 시험 서버 hook 입력에서 관측) 또는 `TargetFile`(`write_to_file`·`replace_file_content`·`multi_replace_file_content`, agy hooks 문서). 상대 경로는 hook 입력의 `cwd`로 푼다. 경로를 읽지 못한 편집 도구는 호출마다 파일 하나(「경로 미확인」)로 센다.
- 정규화: `path.resolve`, Windows는 구분자를 `\`로 맞추고 대소문자를 무시한다.
- 구간: 마지막 `phase-check`와 마지막 workflow 시작(`phase-workflow-start`) 중 나중 것 이후.
- 활성 workflow: task의 현재 epoch에 결속된 root(3.3.0부터 여러 개) 중 `completed`·`abandoned`가 아니고, 최신 run이 있고, 그 run이 `passed`·`failed`·`blocked`가 아닌 것. abandoned root와 끝난 run은 workflow 없음이다.
- 편집 대상마다 차례로 본다(3.3.0). ① 어느 세션이든 판정을 기다리는 root(`needs-review`·`needs-user`)의 쓰기 범위 안이면 거부한다. 같은 물리 경로이거나, 같은 저장소(commonDir)의 다른 checkout에서 checkout 기준 상대 경로가 같으면 안이다. 시작 실패의 통과(7.6)도 이 거부를 풀지 않는다. ② 이 세션의 활성 workflow 쓰기 범위 안(물리 경로)이면 세지 않고 허용한다. ③ 나머지는 구간에 센다.
- ③의 새 파일을 더해 구간의 서로 다른 제품 파일이 `WORKFLOW_FILE_LIMIT`(3, 시작값) 이상이 될 때 그 호출을 거부하고 `phase-deny`를 남긴다. 이미 센 파일만 다시 고치는 호출은 허용한다. workflow 범위 안 편집은 세지 않으므로 workflow가 끝난 뒤 편집은 새로 센다.
- 잠금: 마지막 workflow 시작 뒤에 `phase-deny`가 있으면 그 뒤 제품 파일 편집을 모두 거부한다. phase-check로 풀리지 않고 workflow 시작으로만 풀린다.
- 서브에이전트: Claude·Codex는 child 편집의 `session_id`가 부모 세션이다. child(`agent_id` 관측) 편집은 같은 구간에 더하고 같은 판정을 받는다. 편집 집계 밖에서는 지금처럼 child를 다루지 않는다(pin·바인딩 없음).
- 거부 문구(호스트 공통 `hookSpecificOutput.permissionDecision: "deny"`, agy runner가 `{decision: "deny", reason}`으로 바꾼다):

```text
[AGS] workflow 없이 제품 파일 3개째 변경: <이번 호출의 경로> (앞서 바꾼 제품 파일 N개 포함). 먼저 workflow를 시작하라(최소 시작 호출 예: start_workflow {"goal":"<목표>","stages":["minimal-implementation"],"acceptanceCriteria":["<수용 기준>"],"writeTargets":["<바꿀 경로>"]}).
```

### 7.3 면제

제품 파일은 버전 관리 아래에 있는 파일이다(3.2.0). 편집 대상에서 위로 올라가며 `.git`(디렉터리, 또는 worktree·submodule의 `.git` 파일), `.hg`, `.svn`, `.jj` 중 하나를 찾는다. 아직 없는 새 파일은 없는 상위 폴더를 지나쳐 올라간다. 끝까지 없으면 세지 않는다. 다만 아래 면제 경로가 아니면 7.2 ①(판정 대기 root의 쓰기 범위)은 본다(3.4.0). 3.3.0까지는 버전 관리 밖 경로를 판정 전에 빼서, 쓰기 범위가 저장소 밖인 판정 대기 root의 파일을 편집 도구로 바꿀 수 있었다. 이런 편집은 구간에 세지 않고 편집 기록도 남기지 않는다. 상위 폴더를 읽다 오류가 나면(권한 등) 센다. 3.1.0은 아래 면제만 빼고 모든 경로를 세서, 저장소 밖 질의 문서(Google Drive 폴더)를 쓰던 Codex 세션이 3개째에서 거부됐다.

세지 않는 경로: OS 임시 폴더(`os.tmpdir()`, Claude scratchpad 포함), 호스트의 에이전트 메모 폴더, 사용자 설정 `AGENT_GOVERNANCE_PHASE_EXEMPT_PATHS`(플랫폼 경로 구분자로 나눈 절대 경로). 호스트 메모 폴더는 adapter가 정한다.

| 호스트 | 폴더 | 근거 |
| --- | --- | --- |
| Claude | `<CLAUDE_CONFIG_DIR 또는 ~/.claude>/projects/*/memory` | 사용자 지시(메모리 폴더) |
| Codex | 없음 | Codex 0.166의 메모리는 `~/.codex/memories_1.sqlite`(시험 서버 관측)로, 편집 도구가 쓰는 파일이 아니다 |
| agy | `~/.gemini/antigravity-cli/brain`, `~/.gemini/antigravity/brain` | CLI 경로는 시험 서버(agy 1.4.12)에서 관측. 편집기 경로는 관측하지 않았다 |

cwd는 기준으로 쓰지 않는다. 설정은 hook 프로세스의 환경에서만 읽으며 도구 입력으로는 바꿀 수 없다.

### 7.4 Stop

- 활성 run에 passed가 아닌 stage가 있을 때만 「[AGS 단계 확인] 진행 중인 workflow에 아직 passed가 아닌 단계가 있다: <stage>. workflow 목표: <TaskEnvelope objective, 공백을 한 칸으로 줄이고 300자까지>. 이 목표가 아직 이뤄지지 않았으면 멈추지 말고 남은 작업을 이어서 하라. 방금 받은 요청을 끝냈어도 목표가 남았으면 이어서 한다. 단계 결과는 그 단계의 작업과 검증을 실제로 마친 뒤에만 기록하고, 기록만 하고 끝내지 마라. 사용자의 답이나 승인이 있어야 진행할 수 있으면 무엇을 기다리는지 한 줄로 쓰고 끝내라. 필요 없는 단계는 계획을 고쳐 뺀다.」를 낸다.
- 3.2.0에서 문구를 바꿨다. Codex는 이 문구를 `reason`으로 받아 turn을 이어 가며, 그 turn에서는 이 문구가 유일한 지시다. 3.1.0의 「빠진 단계를 지금 진행하거나, 필요 없으면 계획을 고쳐 그 단계를 빼라.」를 받은 Codex는 단계 상태를 조회하고 `record_stage_result`(blocked)만 한 뒤 멈췄다. 두 번째 Stop은 `stop_hook_active`로 출력이 없어서 그대로 끝났다. 목표 없이 「사용자가 맡긴 작업이 남았으면 이어서 하라」고만 한 후보 문구로는, Codex가 마지막 요청(두 파일 중 하나)을 맡은 일 전체로 보고 멈췄다(실호스트 1회). 그래서 workflow 목표를 문구에 넣는다. agy runner도 Stop 문맥을 `continue`로 바꿔 같은 방식으로 이어 간다. 기준 미만이거나 workflow 없는 구간은 출력 0이다. 「workflow 없이 변경함」과 「이유를 한 줄로」 문구는 없앴다.
- 7.6의 인프라 실패가 구간에 있으면 원인 코드를 한 번 낸다.
- 출력 형식은 3.4 그대로다. Codex Stop 입력의 `stop_hook_active`가 true면(이미 Stop으로 이어 간 turn) phase-check만 남기고 출력 0이다.

### 7.5 최소 시작 `start_workflow`

거부 전용이던 `start_workflow`를 최소 시작으로 바꾼다. 새 도구를 늘리지 않는다.

- 입력: `goal`, `stages`(AGENT가 고른 capability, 1개 이상), `acceptanceCriteria`(1개 이상), `writeTargets`(3.3.0부터 필수. 기본값 workspace 전체는 모든 시작을 서로 겹치게 했다). 선택: `workspace`(절대 경로), `rootId`·`priorFailure`(아래 이어 가기). `workspace`를 생략하면 그 세션의 hook이 호스트 입력의 `cwd`로 세션 현황판에 남긴 작업 폴더를 쓴다. 서버 프로세스의 cwd는 쓰지 않는다(Codex는 MCP 서버를 plugin 폴더에서 띄워, Codex 0.166 실제 호스트에서 다른 시험의 root와 `ROOT_CONFLICT`가 났다). 현황판에 작업 폴더가 없으면 `INVALID_INPUT`(`field: workspace`)이다.
- 서버가 한 workflow transaction 안에서 `planWorkflow`(신뢰 실행 관측 필수) → `openConvergenceRoot` → `claimWorkflowAttempt`(관측된 호출자) → `startGuardedWorkflow`(continuity 결속은 commit 전)를 차례로 부른다. 네 단계의 검사·결속·attestation을 그대로 쓰며 따로 구현하지 않는다. 어느 단계가 실패하면 그 단계의 코드·세부를 그대로 돌려주고 root·lease·run·소비한 관측을 모두 되돌린다.
- 나머지 TaskEnvelope 필드는 기본값(`riskLevel: "medium"`, 권한 목록 비움, 작업 단위 1개 등)으로 채우고 결과의 `defaultsUsed`에 적는다. 계획을 만들 수 없으면(없는 capability 등) 계획의 첫 오류를 돌려준다.
- 시작 전에 구간에 센 파일이 있으면(잠금 중이면 거부로 끝난 구간의 파일. 그 뒤 phase-check로 구간이 바뀌어도 센다) `lateAdoption: {label: "사후 편입·근거 미검증", priorFileCount}`을 돌려주고 TaskEnvelope `constraints`에 같은 문구를 넣어 root에 남긴다.
- 한 세션은 겹치지 않는 경로로 workflow를 여러 개 함께 진행한다(3.3.0). 세션 결속은 epoch마다 root 여러 개이며 `continuity_tasks.root_id`는 가장 최근 root(복원 카드·pending marker용)다. 결속 행은 `continuity_observations`의 `workflow-root:<rootId>`로 남긴다(공유 상태 모듈 표 목록을 바꾸지 않도록 fork pin과 같은 방식). 다른 root와의 세션 결속 충돌은 없다. 경로 충돌은 convergence 가드의 `ROOT_CONFLICT`가 맡는다. 결속 CAS는 epoch만 보며, 실패하면 다시 시도할 수 있는 `STALE_REVISION`이다.
- 결속된 root가 모두 정리됐을 때만(각 root의 run·소비 lease가 모두 끝남) 시작 전에 새 epoch로 옮긴다(새 프롬프트가 하는 것과 같다). 하나라도 진행 중이면 옮기지 않는다.
- 이어 가기: `rootId`를 주면 새 root를 열지 않고 이 세션이 결속했던(epoch 무관) `open` root에 새 시도를 만든다. 다른 세션의 root는 `INVALID_INPUT`(`ROOT_NOT_OWNED`), open이 아닌 root는 `INVALID_TRANSITION`(`ROOT_NOT_OPEN`)이다. `goal`·`stages`·`acceptanceCriteria`·`writeTargets`는 그 root의 값과 같아야 한다(`ROOT_TASK_MISMATCH`). 최근 시도가 실패했으면 `priorFailure`(hypothesis·changeSummary·discriminator·evidenceRefs)가 필요하고 실패 fingerprint는 서버가 최근 outcome에서 채운다. 에이전트용 root 포기 도구는 두지 않았다.
- `ROOT_CONFLICT`는 겹친 경로(`requestedEntry`·`existingPath`), 이 세션 소유 여부(`ownedBySession`), `nextActions`(겹치지 않는 writeTargets로 다시 시작 / 자기 open root면 rootId로 이어 가기 / 판정 대기 root면 `resolve_convergence_gate`)를 돌려준다.
- root를 처음 저장할 때 식별에 host ID를 넣는다. host ID는 OS 기계 ID(Windows `MachineGuid`, macOS `IOPlatformUUID`, Linux `/etc/machine-id`·`/var/lib/dbus/machine-id`)의 SHA-256 digest를 UUID 모양으로 쓴 값이다. 원래 기계 ID는 저장하지 않고, 기계 ID가 있으면 파일도 쓰지 않고 읽지도 않는다. 그래서 상태 디렉터리를 지우거나 복사하거나 hook과 서버가 서로 다른 상태 디렉터리를 읽어도 한 컴퓨터의 host ID는 하나이고, 저장된 root는 계속 막는다. 기계 ID를 읽지 못하면(`reg.exe`·`ioreg` 실행 실패, Linux 파일의 권한 오류, systemd 첫 부팅의 `uninitialized`) 무작위 값으로 넘어가지 않고 `HOST_IDENTITY_UNRESOLVED`다. 처음 구현은 무작위 UUID를 `host-id`에 두었다. 이 파일이 지워지면 새 ID가 생겨 gated root 거부와 겹침 판정이 통과 쪽으로 풀렸다(리뷰 F1). 이어서 도출값을 캐시하던 구현에서는 파일에 다른 UUID가 있으면 그 값을 믿고, 기계 ID를 한 번 읽지 못하면 무작위 값을 저장했다(재리뷰 R1·R2). 지금은 OS에 기계 ID가 아예 없을 때만(Linux에서 두 파일이 모두 없거나 그 밖의 OS) 공유 AGS 상태 디렉터리(`AGENT_GOVERNANCE_SHARED_STATE_DIR`, 기본 `~/.agent-governance-suite`)의 `host-id`에 무작위 UUID를 한 번 만들어 hard link로 원자적으로 게시한다. hard link를 만들 수 없는 파일 시스템(FAT, 일부 네트워크 드라이브)에서는 배타 생성(`wx`)으로 게시한다(3.4.0, 리뷰 H2). 3.3.0은 이때 root 저장이 영구히 `HOST_IDENTITY_UNRESOLVED`였다. 배타 생성에서도 먼저 만든 하나만 이긴다. 다만 생성과 쓰기 사이에 읽은 프로세스는 ID를 아직 보지 못해 그 호출만 `HOST_IDENTITY_UNRESOLVED`이고, 그 사이에 프로세스가 죽으면 빈 파일이 남아 지울 때까지 `HOST_IDENTITY_UNRESOLVED`다. 그 경우에는 파일을 지우면 ID가 바뀌고, 상태 디렉터리를 복사하면 ID도 복제된다는 한계가 남는다. Windows와 macOS는 프로세스마다 `reg.exe`·`ioreg`를 한 번 실행한다(이 PC 실측 warm 약 25ms, cold 631ms). 쓰기 잠금을 잡은 채 기다리지 않도록 이 읽기는 잠금 전에 끝낸다. `open_convergence_root`는 SQLite root 삽입 트랜잭션 전에, `start_workflow`는 새 root를 열 때 바깥 workflow 트랜잭션(`BEGIN IMMEDIATE`) 전에 읽는다. 남는 한계는 셋이다. 기계 ID 읽기가 계속 실패하면(정책이 `reg.exe`를 막는 등) `start_workflow`가 모두 `INVALID_INPUT`이 되고, 편집 창 한도에 이르면 편집도 막힌다. 막는 쪽이지만 쓸 수 없게 될 수 있다. Windows sysprep·재설치나 이미지 복제 뒤 machine-id 재생성처럼 기계 ID가 바뀌면 기존 root는 다른 호스트로 판정된다. 한 컴퓨터에서 일부 프로세스만 sandbox로 기계 ID를 못 보면 그 프로세스는 무작위 ID를 쓴다(확인한 호스트는 없음). Windows·macOS에서 읽기가 막히면 무작위 ID가 아니라 `HOST_IDENTITY_UNRESOLVED`이므로 이 갈라짐은 Linux에서 두 파일이 모두 보이지 않을 때만 생긴다. 3.4.0에서 대책을 검토했으나 넣지 않았다. 기계 ID가 있는 프로세스가 도출값을 `host-id`에 써 두면 같은 상태 디렉터리를 보는 sandbox 프로세스는 같은 값을 읽지만, 기계 ID가 있으면 파일을 쓰지 않는다는 위 결정(F1·R2)을 되돌리고, 상태 디렉터리까지 다르면 효과가 없다. 「OS에 기계 ID가 없음」과 「sandbox가 가림」은 프로세스 안에서 구별할 수 없다. 컴퓨터 이름이 바뀌어도 유지된다. host ID가 다르면 같은 경로라도 겹치지 않는다. host 없이 저장된 식별은 같은 호스트로 보며, 다시 도출한 식별에는 host를 붙이지 않는다. host ID를 읽지도 만들지도 못하면 root 저장은 `INVALID_INPUT`(`HOST_IDENTITY_UNRESOLVED`)이고, 편집 관문은 같은 호스트로 보고 판정한다.
- 다른 세션이 결속한 root를 `start_guarded_workflow` 등으로 결속하려 하면 `INVALID_INPUT`(`ROOT_NOT_OWNED`)이다. continuity 저장소가 없으면 rootId 이어 가기는 `CONTINUITY_UNAVAILABLE`이다.
- Claude governance hook이 transcript에서 실행 관측을 읽도록 `HOST_ATTESTATION_TOOLS`에 `start_workflow`를 넣었다.
- 기존 4단계 경로는 바뀌지 않는다. `start_guarded_workflow`의 continuity 결속도 workflow 시작 관측을 남겨 잠금을 푼다.
- 3.2.1: 필수 산출물(`requiredArtifacts`)이 있는 단계는 passed 기록 때 plan의 `taskEnvelope.artifactContracts` 대상 digest와 맞아야 한다. 최소 시작은 이 계약을 만들지 않으므로, 그런 단계가 하나라도 있으면 `INVALID_INPUT`(`details.field: "stages"`, `details.capabilities`)으로 거부하고 아무것도 남기지 않는다. 현재 registry에서 최소 시작이 받는 단계는 `minimal-implementation`뿐이다. 나머지는 대상이 정해진 뒤 4단계 경로로 시작한다.

### 7.6 오류

- AGS 인프라 오류는 원인 코드를 그대로 보이고 통과시킨다. hook이 workflow 저장소를 열지 못하거나 읽지 못하면 `phase-gate-unavailable:<원인 코드>`를 남기고 편집을 허용한다. 시작 호출이 `MCP_UNAVAILABLE`·`CONTINUITY_UNAVAILABLE`·`BINDING_REQUIRED`·`BINDING_INVALID`·`INTEGRITY_FAILED`로 실패하면 서버가 `workflow-start-failed:<코드>[:<reasonCode>]`를 남기고, 그 구간의 편집을 허용한다(판정 대기 root 범위의 거부는 제외). 다음 Stop이 원인 코드를 한 번 낸다. 3.3.0부터 Stop은 실제로 판정 없이 통과시킨 편집이 있을 때(관문이 판정하지 못했거나 시작 실패 때문에 구간 편집을 통과시켰을 때)만 「막지 않았다」고 말하고, 시작 실패만 있고 편집은 평소대로 판정됐으면 시작 실패와 원인 코드만 알린다(`hooks.phaseCheck.startFailed`). 또 3.3.0부터 시작의 `BINDING_INVALID`는 호출자·호스트 실행 관측(adapter·capability 불일치, 소비됐거나 결속이 맞지 않는 관측)에서만 나오고 세션 결속에서는 나오지 않는다.
- 입력 검증 오류(`INVALID_INPUT`, `GATE_FAILED`, `ROOT_CONFLICT`, `LEASE_CONFLICT` 등)는 통과 사유가 아니다.
- continuity 저장소 자체가 열리지 않으면 지금처럼 hook이 진단 한 줄을 남기고 출력 없이 끝난다(fail-open).

### 7.7 관측(수치 조정용)

모두 `continuity_observations` 행이다. 경로는 HMAC으로만 남는다.

- `phase-file`: 구간의 서로 다른 제품 파일(`turn_hash` = 경로 HMAC).
- `phase-deny`: 거부 1건마다 1행.
- `phase-workflow-start`: 시작 1건마다 1행, `success = 1`이면 거부 뒤의 시작. 「거부 뒤 시작 비율」은 `success = 1` 시작 수를 잠금 구간 수와 비교해 얻는다.
- `workflow-start-failed:*`, `phase-gate-unavailable:*`: 인프라 실패.

### 7.8 남는 한계

- 셸(`Bash`·`PowerShell`·`run_command`)로 바꾼 파일은 세지 않는다. 편집 도구만 막는다.
- Claude governance hook이 `start_workflow` 호출 자체를 거부하면 서버가 호출을 받지 못한다. 그래서 hook이 실패 경로에서 같은 `workflow-start-failed:BINDING_REQUIRED:<hook 원인 코드>`를 continuity에 직접 남긴다(`governance-hook.ts` `recordStartRefusal`). 기록마저 실패하면 `WORKFLOW_START_FAILURE_UNRECORDED` 진단을 남기고 거부는 그대로다. agy runner의 host-attestation 단계 fail-closed 거부는 아직 같은 처리를 하지 않는다.
- agy 1.4.12는 호출 `_meta`에 모델을 싣지 않아(`ANTIGRAVITY_EXECUTION_UNOBSERVED`) 신뢰 실행 관측이 필수인 workflow 시작(`plan_workflow`·`start_workflow`의 bootstrap)이 `BINDING_REQUIRED`로 실패한다(v3.0.2부터 같은 코드). agy에서는 거부 뒤 시작이 인프라 실패로 통과하므로 강제가 한 번 거부에 그친다. 3.2.0에서 고쳤다(agy PreToolUse 관측 기록과 서버 짝짓기).
- 다른 세션의 활성 root가 같은 workspace를 덮으면 최소 시작은 `ROOT_CONFLICT`로 실패하고 통과 사유가 아니다.
- 구간은 turn마다(Stop의 phase-check) 다시 센다. 한 turn에 2개씩 여러 turn에 나눠 고치면 거부되지 않는다.
- 버전 관리 밖의 제품(`git init` 전에 만드는 새 프로젝트, 저장소 밖 설정 파일)은 세지 않는다. `GIT_DIR`로 따로 둔 저장소도 표지가 없어 세지 않는다. 판정 대기 root의 쓰기 범위 검사는 받는다(3.4.0, 7.3).
- 경로를 읽지 못한 편집 도구 호출(7.2)은 구간에 한 파일로 세지만 판정 대기 root 검사는 받지 않는다(N8). 경로를 모르므로 겹침도 비겹침도 보일 수 없다. 이 경우를 거부하면 어느 세션이든 판정 대기 root가 하나라도 있는 동안 이 컴퓨터의 모든 세션에서 그런 호출이 막힌다. 그래서 한계로 둔다.
