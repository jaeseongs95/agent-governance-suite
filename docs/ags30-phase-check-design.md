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
