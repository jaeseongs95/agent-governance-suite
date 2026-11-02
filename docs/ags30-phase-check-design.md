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
- 활성 workflow: task에 결속된 root가 `completed`·`abandoned`가 아니고, 최신 run이 있고, 그 run이 `passed`·`failed`·`blocked`가 아니다. abandoned root와 끝난 run은 workflow 없음이다.
- 활성 workflow가 없으면 이번 편집의 새 파일을 더해 구간의 서로 다른 제품 파일이 `WORKFLOW_FILE_LIMIT`(3, 시작값) 이상이 될 때 그 호출을 거부하고 `phase-deny`를 남긴다. 이미 센 파일만 다시 고치는 호출은 허용한다. 활성 workflow 아래 편집은 세지 않으므로 workflow가 끝난 뒤 편집은 새로 센다.
- 잠금: 마지막 workflow 시작 뒤에 `phase-deny`가 있으면 그 뒤 제품 파일 편집을 모두 거부한다. phase-check로 풀리지 않고 workflow 시작으로만 풀린다.
- 서브에이전트: Claude·Codex는 child 편집의 `session_id`가 부모 세션이다. child(`agent_id` 관측) 편집은 같은 구간에 더하고 같은 판정을 받는다. 편집 집계 밖에서는 지금처럼 child를 다루지 않는다(pin·바인딩 없음).
- 거부 문구(호스트 공통 `hookSpecificOutput.permissionDecision: "deny"`, agy runner가 `{decision: "deny", reason}`으로 바꾼다):

```text
[AGS] workflow 없이 제품 파일 3개째 변경: <이번 호출의 경로> (앞서 바꾼 제품 파일 N개 포함). 먼저 workflow를 시작하라(최소 시작 호출 예: start_workflow {"goal":"<목표>","stages":["minimal-implementation","test-sensitivity-review"],"acceptanceCriteria":["<수용 기준>"]}).
```

### 7.3 면제

세지 않는 경로: OS 임시 폴더(`os.tmpdir()`, Claude scratchpad 포함), 호스트의 에이전트 메모 폴더, 사용자 설정 `AGENT_GOVERNANCE_PHASE_EXEMPT_PATHS`(플랫폼 경로 구분자로 나눈 절대 경로). 호스트 메모 폴더는 adapter가 정한다.

| 호스트 | 폴더 | 근거 |
| --- | --- | --- |
| Claude | `<CLAUDE_CONFIG_DIR 또는 ~/.claude>/projects/*/memory` | 사용자 지시(메모리 폴더) |
| Codex | 없음 | Codex 0.166의 메모리는 `~/.codex/memories_1.sqlite`(시험 서버 관측)로, 편집 도구가 쓰는 파일이 아니다 |
| agy | `~/.gemini/antigravity-cli/brain`, `~/.gemini/antigravity/brain` | CLI 경로는 시험 서버(agy 1.4.12)에서 관측. 편집기 경로는 관측하지 않았다 |

cwd는 기준으로 쓰지 않는다. 설정은 hook 프로세스의 환경에서만 읽으며 도구 입력으로는 바꿀 수 없다.

### 7.4 Stop

- 활성 run에 passed가 아닌 stage가 있을 때만 「[AGS 단계 확인] 진행 중인 workflow에서 다음 단계가 아직 passed가 아니다: <stage>. 빠진 단계를 지금 진행하거나, 필요 없으면 계획을 고쳐 그 단계를 빼라.」를 낸다. 기준 미만이거나 workflow 없는 구간은 출력 0이다. 「workflow 없이 변경함」과 「이유를 한 줄로」 문구는 없앴다.
- 7.6의 인프라 실패가 구간에 있으면 원인 코드를 한 번 낸다.
- 출력 형식은 3.4 그대로다. Codex Stop 입력의 `stop_hook_active`가 true면(이미 Stop으로 이어 간 turn) phase-check만 남기고 출력 0이다.

### 7.5 최소 시작 `start_workflow`

거부 전용이던 `start_workflow`를 최소 시작으로 바꾼다. 새 도구를 늘리지 않는다.

- 입력: `goal`, `stages`(AGENT가 고른 capability, 1개 이상), `acceptanceCriteria`(1개 이상). 선택: `workspace`(절대 경로), `writeTargets`(기본 workspace 전체). `workspace`를 생략하면 그 세션의 hook이 호스트 입력의 `cwd`로 세션 현황판에 남긴 작업 폴더를 쓴다. 서버 프로세스의 cwd는 쓰지 않는다(Codex는 MCP 서버를 plugin 폴더에서 띄워, Codex 0.166 실제 호스트에서 다른 시험의 root와 `ROOT_CONFLICT`가 났다). 현황판에 작업 폴더가 없으면 `INVALID_INPUT`(`field: workspace`)이다.
- 서버가 한 workflow transaction 안에서 `planWorkflow`(신뢰 실행 관측 필수) → `openConvergenceRoot` → `claimWorkflowAttempt`(관측된 호출자) → `startGuardedWorkflow`(continuity 결속은 commit 전)를 차례로 부른다. 네 단계의 검사·결속·attestation을 그대로 쓰며 따로 구현하지 않는다. 어느 단계가 실패하면 그 단계의 코드·세부를 그대로 돌려주고 root·lease·run·소비한 관측을 모두 되돌린다.
- 나머지 TaskEnvelope 필드는 기본값(`riskLevel: "medium"`, 권한 목록 비움, 작업 단위 1개 등)으로 채우고 결과의 `defaultsUsed`에 적는다. 계획을 만들 수 없으면(없는 capability 등) 계획의 첫 오류를 돌려준다.
- 시작 전에 구간에 센 파일이 있으면(잠금 중이면 거부로 끝난 구간의 파일. 그 뒤 phase-check로 구간이 바뀌어도 센다) `lateAdoption: {label: "사후 편입·근거 미검증", priorFileCount}`을 돌려주고 TaskEnvelope `constraints`에 같은 문구를 넣어 root에 남긴다.
- 끝난 workflow에 결속된 세션은 시작 전에 새 epoch로 옮긴다(새 프롬프트가 하는 것과 같다).
- Claude governance hook이 transcript에서 실행 관측을 읽도록 `HOST_ATTESTATION_TOOLS`에 `start_workflow`를 넣었다.
- 기존 4단계 경로는 바뀌지 않는다. `start_guarded_workflow`의 continuity 결속도 workflow 시작 관측을 남겨 잠금을 푼다.

### 7.6 오류

- AGS 인프라 오류는 원인 코드를 그대로 보이고 통과시킨다. hook이 workflow 저장소를 열지 못하거나 읽지 못하면 `phase-gate-unavailable:<원인 코드>`를 남기고 편집을 허용한다. 시작 호출이 `MCP_UNAVAILABLE`·`CONTINUITY_UNAVAILABLE`·`BINDING_REQUIRED`·`BINDING_INVALID`·`INTEGRITY_FAILED`로 실패하면 서버가 `workflow-start-failed:<코드>[:<reasonCode>]`를 남기고, 그 구간의 편집을 허용한다. 다음 Stop이 원인 코드를 한 번 낸다.
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
- Claude governance hook이 `start_workflow` 호출 자체를 거부하면(transcript 관측 실패 등) 서버가 호출을 받지 못해 `workflow-start-failed`를 남길 수 없다. 그 세션은 잠긴 채 남는다. governance hook의 실패 경로에서 `start_workflow`의 원인 코드를 continuity에 남겨야 풀리며, 이 부분은 governance hook 오류 처리 핫픽스(transcript 끝부분 읽기)와 겹쳐 이번 변경에 넣지 않았다. agy runner의 host-attestation 단계 fail-closed 거부도 같다.
- 다른 세션의 활성 root가 같은 workspace를 덮으면 최소 시작은 `ROOT_CONFLICT`로 실패하고 통과 사유가 아니다.
- 구간은 turn마다(Stop의 phase-check) 다시 센다. 한 turn에 2개씩 여러 turn에 나눠 고치면 거부되지 않는다.
