# AGS 3.8.0 릴리스 노트(초안)

3.8.0은 서브에이전트·위임·세션 역할·열린 workflow 식별에 관한 결함 다섯 건(AGS3-D-0001, D-0002, D-0003, D-0004, D-0030)과 공통 접수 기준의 결함 여섯 건(D-0031, D-0032, D-0036, D-0039, D-0040, D-0041)을 고친다. D-0031에는 옛 D-0034·D-0035를 합쳤다. 판 번호와 판 메타데이터는 아직 올리지 않았다. 사용자 원문은 「3.7.0 릴리즈되면 결함중 가장 우선순위가 높은거 뽑아서 개선하고 릴리즈해.」「한번에 여러개 개선해도 돼.」「결함부터 때려잡아야 기능 개발을 하던지 할거아냐.」다. D-0030 관련 원문은 「그리고 AGS가 세션 협업을 유도하는지 확인해줄래?」「즉 자신의 역할을 인지하는지. 자신의 일이 아니면 다른 세션에 맡길수있는지 확인. 그래도 안되면 사용자에게 물어보기.」다.

다섯 건 중 네 건(D-0001, D-0002, D-0003, D-0030)은 원인이 같다. 안내가 메인 에이전트의 사용자 메시지 경계(UserPromptSubmit)와 전문 스킬 본문에만 있었다. 서브에이전트, 스킬을 호출하지 않은 위임, 자기 역할 판단에는 안내가 닿지 않았다.

호환성:

- 공개 계약은 더하기만 했다(SemVer minor). `update_session_status` 요청에 선택 필드 `role`이 생겼고, `list_session_status`의 각 행과 `update_session_status` 응답에 `role`(문자열 또는 null)이 생겼다. 기존 요청은 그대로 받는다.
- 세션 현황판(`session-board.sqlite3`)의 `board_sessions` 표에 `role` 열을 더하되 형식 판(`user_version` 1)은 바꾸지 않는다. 열을 이름으로 지정해 쓰는 이전 AGS도 같은 컴퓨터에서 이 현황판을 계속 읽고 쓴다. 이전 AGS가 요약을 갱신해도 `role`은 지워지지 않는다.
- hook 설정: Claude Code 플러그인(`claude-overlay/hooks/hooks.json`)과 Codex(`hooks/hooks.json`)에 `SubagentStart`를 등록했다. Codex의 UserPromptSubmit continuity hook `additionalContextLimit`를 1800에서 8192로 올렸다(아래 D-0003).
- 단계 확인 알림 `hooks.phaseCheck.pending`에 자리표시자 `{runId}`, `{rootId}`가 생겼다.

## AGS3-D-0001: 서브에이전트에 스킬 선택 안내가 닿지 않음

### 원인

- 스킬 대상 목록을 싣는 안내(`hooks.checkpointCue.skills`)는 continuity hook이 사용자 입력(`user-input`)에서만 냈다(`mcp-server/src/continuity-hook.ts`의 `observation.kind === "user-input"` 분기).
- 관측된 서브에이전트의 hook 호출은 편집 관문 말고는 모두 `{}`로 끝났다(같은 파일 `isObservedSubagent` 분기).
- 두 플러그인의 hook 설정 어디에도 서브에이전트 시작 이벤트가 없었다.

### 바뀐 점

- 공통 어댑터(`mcp-server/src/builtin-hook-host-adapters.ts`)가 호스트 이벤트 `SubagentStart`를 관측 종류 `subagent-start`로 바꾼다. 이 관측은 root로 추정하지 않는다. `agent_id`가 있으면 관측된 child이고, 없거나 잘못됐으면 indeterminate다.
- continuity hook은 `subagent-start`에 호스트 이름 분기 없이 같은 안내를 낸다(`subagentStartCue`, `hooks.subagentCue.skills`·`hooks.subagentCue.scope`). 안내에는 설치된 스킬별 대상 목록, 맞는 스킬을 실제 호출하라는 지시, 지시문의 목표·범위·금지 구역·쓰기 소유를 지키라는 지시가 들어 있다. 메인 에이전트의 일(사용자 원문 저장, 압축 뒤 복원)은 넣지 않는다.
- 이 안내는 상태 DB를 열지 않는다. 저장소가 깨져도 안내는 나간다.
- Claude Code와 Codex가 `SubagentStart`에 이 hook을 실행한다.

### 호스트별 지원

| 호스트 | 서브에이전트 시작 hook | 근거 | 이번 판 |
| --- | --- | --- | --- |
| Claude Code | `SubagentStart`. 입력에 `agent_id`, `agent_type`가 있고, `hookSpecificOutput.additionalContext`가 서브에이전트 문맥에 들어간다. | 공식 hooks 문서(code.claude.com/docs/en/hooks) | 지원 |
| Codex | `SubagentStart`. 입력은 부모 `session_id`, `turn_id`, `agent_id`, `agent_type`, `permission_mode`이고, `additionalContext`가 서브에이전트의 developer context로 들어간다. | 공식 hooks 문서(developers.openai.com/codex/hooks), 이 PC의 codex-cli 0.166.0 실행 파일에 있는 hook 이벤트 이름 목록 문자열 | 지원 |
| Antigravity(agy) | 없음. 공식 이벤트는 SessionStart, PreToolUse, PostToolUse, PreInvocation, PostInvocation, Stop의 여섯 개다. 서브에이전트 대화에서 hook이 실행되는지는 문서에 없다. | 공식 hooks 문서(antigravity.google/docs/hooks) | 미지원. 문서와 README에 적었다 |

## AGS3-D-0002: 위임 검토를 이끄는 안내가 없고 기본값이 직접 수행

### 원인

- 공통 접수 기준(`skills/orchestrator/SKILL.md`의 skill-intake 구간)에 위임 문장이 없었다.
- `skills/orchestrator/references/collaboration.md`의 위임 판단은 「자동 위임에서는 하나라도 확인할 수 없으면 메인이 직접 수행한다」였다.
- `skills/coordinate-subagents/references/entry-details.md`는 「keep work local when the net-benefit conditions are not all confirmed」였다. 조건을 확인하지 않은 채로 두면 직접 수행이 기본값이 됐다.

### 바뀐 점

- 공통 접수 기준의 역할 줄에 「독립적으로 완료·검증할 수 있는 작업 단위가 있으면 직접 수행을 기본값으로 두지 말고 `coordinate-subagents`의 위임 판단으로 위임 여부를 정한다」를 더했다.
- 두 참고 자료는 독립 단위가 있으면 순이익 조건을 먼저 확인하게 했다. 확인한 조건이 성립하지 않을 때만, 그 조건을 밝히고 직접 수행한다. 순이익 조건 자체와 명시적 위임의 예외는 바꾸지 않았다.
- 메시지마다 나가는 안내도 같은 검토를 요구한다(D-0003과 같은 문장).

## AGS3-D-0003: 위임 규칙이 위임 시점에 적용되지 않음

### 원인

- 위임 규칙(지시문에 고른 스킬·금지 구역을 적는다, 검증 에이전트에 대기·폴링을 맡기지 않는다 등)은 `coordinate-subagents`를 호출할 때만 읽혔다.
- Claude Code의 `PreToolUse` `Agent|Task` matcher는 fork 계보 고정만 했다.

### 바뀐 점

- 위임 규칙의 핵심을 늘 읽히는 두 곳에 넣었다.
  - 공통 접수 기준(MCP 서버 instructions, 세션 시작 포인터): 「위임 지시문에는 목표·범위·금지 구역·쓰기 소유, 고른 스킬과 완료·검증 기준을 적고, 빌드 감시·진행 폴링 같은 대기는 검증 에이전트에 맡기지 않는다」
  - 메시지마다 나가는 안내(`hooks.checkpointCue.skills`): 기존 「서브에이전트에 맡길 때는 고른 스킬을 지시문에 적는다」를 위 규칙과 위임 검토 문장으로 바꿨다.
- 서브에이전트 쪽에서는 D-0001의 시작 안내가 지시문의 범위·금지 구역·쓰기 소유를 지키게 한다. 범위 밖 변경이나 지시문에 없는 승인이 필요하면 맡긴 에이전트에게 돌려주라고 한다.
- 메시지마다 나가는 안내가 길어져(한국어판 약 2,560자, 영어판 약 3,460자) Codex UserPromptSubmit continuity hook의 `additionalContextLimit`를 1800에서 8192로 올렸다. 공식 문서에 따르면 이 한도의 단위는 대략적인 토큰이고, 넘치면 Codex가 전문을 파일에 두고 앞뒤 미리보기만 모델에 준다. 이전 한도에서 안내가 실제로 잘렸는지는 확인하지 않았다.

### 한계

- AGS는 위임 도구 호출의 지시문을 검사하지 않는다. Claude Code의 PreToolUse `additionalContext`는 공식 문서상 도구 결과 옆에 붙어 지시문 작성 전에 닿지 않는다. 지시문 내용으로 위임을 거부하는 것은 오판 위험이 커서 하지 않았다.

## AGS3-D-0004: 열린 workflow의 runId·rootId를 세션이 다시 찾을 수 없음

### 원인

- 턴 종료 단계 확인(`mcp-server/src/continuity-service.ts`의 `phaseCheckForSession`, `pendingStages`)은 단계 ID와 목표만 실었다.
- `get_workflow_status`는 `runId`를, `get_convergence_status`는 `rootId`를 요구한다. 그러나 세션이 자기 열린 workflow를 나열하는 경로가 없었다. 3.6.0 작업 세션은 runId를 몰라 workflow를 닫지 못했고, Stop 때마다 알림을 받았다.

### 바뀐 점

- 단계 확인 알림의 첫 줄에 그 workflow의 최신 run `runId`와 `rootId`를 싣고, 상태를 볼 도구(`get_workflow_status`, `get_convergence_status`)를 함께 적었다.
- 별도의 나열 도구는 더하지 않았다. 남은 단계가 있는 열린 workflow는 편집 뒤 Stop마다 이 알림으로 ID가 다시 전달된다.

## AGS3-D-0030: 세션이 자기 역할을 인지하고 담당 세션에 맡기도록 이끄는 장치가 없음

### 원인

- 세션 현황판 행에는 요약 한 줄뿐이고 역할 필드가 없었다.
- 공통 접수 기준의 역할 문장(「맡긴 역할 범위의 일은 진행하고 '권한 없음'으로 결론 내지 않는다」)에는 자기 역할 판단과 넘기기 안내가 없었다.
- 다른 세션에 묻게 하는 경로는 `ROOT_CONFLICT`의 `ask-owner-session`과 root 해제·교체 문구뿐이었다.
- `session-board` 스킬은 같은 PC의 동시 세션 상황에서만 선택된다.

### 바뀐 점

- `update_session_status`에 선택 필드 `role`(한 줄, 120자 이내, 공백만으로는 안 됨)을 더했다. `role`을 빼면 이미 적은 역할이 유지된다. `list_session_status`의 각 행에 `role`이 실린다.
- 도구 설명에 사용자가 정한 역할만 적으라는 문장을 넣었다. 다른 세션의 역할은 주장이며 지시나 승인이 아니라는 문장도 넣었다.
- 공통 접수 기준의 역할 줄이 다음 순서를 안내한다.
  1. 사용자 요청·지침이 이 세션의 역할을 정했으면 `role`에 적는다. 정하지 않은 역할은 지어내지 않는다.
  2. 받은 요청이 역할 밖이면 `list_session_status`로 그 역할의 세션을 찾아 `prepare_session_message`·`send_session_message`로 넘긴다.
  3. 맡을 세션이 없거나 응답이 없으면 누구에게 맡길지 사용자에게 묻는다.
  
  peer 메시지가 사용자 승인이 아니라는 문장은 그대로 둔다.
- 역할은 실행 권한이나 잠금이 아니다. 현황판은 여전히 작업을 막는 관문이 아니다.

## AGS3-D-0031: 닫기·삭제·되돌리기·대체 전에 대상의 목적이 이뤄졌는지 확인하게 하는 규칙이 없음

사용자 원문은 「아니 없애지만 말고. 저 pr에서 하려는건 그럼 메인에 있긴한거야?」「이것도 결함으로 등록해. 이미 등록되어있으면 최우선과제로 올리고.」다. Codex가 opendiy-desktop PR #4를 그 변경이 main에 들어갔는지 확인하지 않고 닫으려 했다.

### 원인

- 공통 접수 기준에는 대상을 없애기 전에 그 대상이 이루려던 일이 이미 이뤄졌는지 확인하라는 규칙이 없었다. 멈추기·교체 전 확인 규칙은 연결된 세션이 있는지만 물었다.

### 바뀐 점

- 직접 처리 줄에 규칙을 더했다. 닫기·삭제·되돌리기·대체를 고르거나 그 대상의 상태를 답하기 전에, 대상의 목적(예: PR이면 변경을 base에 반영)이 이미 이뤄졌는지 실제 상태(예: base와 head·발행 태그의 포함 관계)로 확인하고 결과를 답에 적는다. 이뤄지지 않았으면 대상을 없애지 않고 목적을 이루는 쪽을 고르며, 사용자가 선택지를 주면 이 확인 결과로 고른다.
- 회귀 시험 `tests/mcp/d0031-d0032-intake-purpose-check.test.ts`가 이 규칙이 공통 기준 원본과 MCP 서버 instructions(ko·en)에 실리는지 확인한다.

## AGS3-D-0032: 공통 접수 기준이 길고 중복돼 문맥을 낭비함

사용자 원문은 「AGS의 공통 접수 기준 <- 이거 프롬프트 최적화 해야하는지 보고 최적화 필요하면 최적화도해. 이것도 어떻게보면 토큰 낭비하는 결함이니 결함으로 등록하고.」다.

### 원인

- 같은 기준이 MCP 서버 instructions와 orchestrator `SKILL.md` 본문에 함께 있어, orchestrator를 호출하면 같은 글을 한 번 더 읽었다.
- 기준 안에서 같은 규칙이 여러 줄에 반복됐다(전문 스킬 하나로 끝나는 작업의 직접 처리, 선택한 스킬의 실제 호출·적용, 문서 읽기가 실행이 아니라는 문장).
- 사용자 메시지마다 나가는 확인 알림이 설치된 스킬별 대상 목록과 선택 규칙 전체를 매번 다시 실었다.

### 바뀐 점

1. 반복 규칙 합치기(bdcb0792): 같은 뜻의 문장을 한 곳으로 합쳤다. 줄이면서 빠진 규칙이 없도록 3.7.0 기준의 규칙 조각 78개가 남아 있는지 시험한다. 초안에서 빠졌다가 되살린 조건은 다음과 같다. 선택 결과를 출력하지 않아도 첫 도구 호출 전에 선택을 끝내는 조건, 선택만으로 실행을 대신하지 않는 목록의 「선택」, 메시지마다 변화를 확인하는 조건, 인계된 교정·제약 대조, 현재 권한으로 접근할 수 있는 정본 참조, `ponytail`의 가용·활성 조건, 기존 관측·도구 재사용, 사용자·에이전트 몫 나눠 적기, JEV OFF 프로필 문장, 추천·선택·실행 승인 구분과 미가용·미검증을 성공으로 세지 않는 조건, 새 요청에 과거 교정 절차를 더하지 않는 조건.
2. 원본 옮기기(553e0f0e): 공통 기준을 `skills/orchestrator/references/intake.md`로 옮겼다. 문구는 바꾸지 않았다(1단계 원본 줄과 바이트 단위로 같다). `SKILL.md`에는 MCP instructions로 받지 못한 호스트가 이 파일을 읽으라는 한 줄만 남겼다. MCP 서버(`mcp-server/src/skill-intake.ts`)와 Codex·agy 맥락 시작 포인터가 이 파일을 가리킨다.
3. 메시지마다 나가는 알림 줄이기(7ff84bc6, **미확정**): 스킬별 대상 목록과 선택 규칙은 맥락 시작마다 한 번 보낸다(Codex·agy는 intake hook, Claude Code는 SessionStart의 skill-trigger hook). 메시지마다 나가는 알림은 그 목록과 대조하라는 한 줄과 checkpoint 줄만 남긴다. 호스트 이름으로 분기하지 않고 어댑터가 정한 맥락 시작에 싣는다. 스킬 선택 정확도를 실호스트에서 비교하기 전이므로 발행 후보로 확정하지 않았다. 비교 도구는 `tests/real-host/cue-ab/`에 준비만 했고 실행하지 않았다(아래 검증).

### 측정(문자 수 / UTF-8 바이트)

| 대상 | 3.7.0 기준(d068dfd6) | 1단계 | 2단계 | 3단계 후보 |
| --- | --- | --- | --- | --- |
| 공통 기준 본문 | 4,771 / 10,648 | 4,732 / 10,548 | 같음(파일 이동) | 같음 |
| orchestrator `SKILL.md` | 6,297 / 13,160 | 6,258 / 13,060 | 1,572 / 2,644 | 같음 |
| 메시지마다 나가는 알림(codex, 저장 지시 없음, ko) | 2,562 / 3,475 | — | — | 479 / 1,046 |
| 같은 알림(en) | 3,460자 | — | — | 999자 |
| Codex·agy 맥락 시작 내용(ko) | 165 / 258 | — | — | 2,369 / 2,977 |
| 같은 내용(en) | 280자 | — | — | 3,019자 |

- 2단계 뒤 MCP 서버 instructions의 접수 안내는 ko 4,955자, en 5,113자다.
- 3단계 후보는 메시지마다 약 2,083자(ko)를 덜 보내고, 맥락 시작마다 약 2,204자(ko)를 더 보낸다. 맥락 시작보다 사용자 메시지가 많은 세션에서 줄어든다. Codex intake hook 한도(8192)는 바꾸지 않았고 ko·en 내용 모두 한도 안이다.
- 이 세션의 Claude Code 화면에서는 MCP instructions가 분류 지원 줄에서 잘려(`… [truncated]`) 보였다. 잘리는 길이 기준은 확인하지 않았다.

## AGS3-D-0031(옛 D-0034를 합침): 한 단계가 외부 원인으로 막히면 맡은 작업 전체를 멈춤

사용자 원문은 「저걸 다운못받으면 내가 시킨 모든 작업은 아예 멈춰도 되나?」다. 11-06 Codex 세션에서 원격 보고서 다운로드가 SSH MCP의 `UNTRUSTED_OWNER`로 두 번 거절되자, 세션은 SSH MCP 담당자가 고치면 이어가겠다고 보고하고 보고서가 필요 없는 PR·CI 확인까지 멈췄다.

### 원인

- 공통 접수 기준은 독립적으로 가능한 일을 계속하라는 문장을 세 경우에만 두었다. main 7c93e866의 `skills/orchestrator/SKILL.md` 기준으로 복원 근거·제약 누락(:20), 사용자만 할 수 있는 승인·입력·화면 조작(:25), 스킬 분류 지원 거부(:30)다. 이 브랜치에서는 `skills/orchestrator/references/intake.md`의 6·12·16번 줄이다.
- 도구 거절·권한 거부·다른 담당의 수정 대기처럼 외부 원인으로 한 단계가 막힌 경우의 일반 규칙은 `skills/independent-audit-gate/references/specialist-behavior.md:15`에만 있었다. 이 파일은 전문 스킬을 호출할 때만 읽힌다.
- 턴 종료 hook과 서버 안내에도 남은 독립 작업을 확인시키는 장치가 없다(이번에 바꾸지 않았다. 아래 「이번에 고치지 않은 것」).

### 바뀐 점

- 직접 처리 줄(`intake.md:12`)의 사용자 몫 문장 바로 뒤에 일반 규칙을 두었다. 한 단계가 사용자 몫, 근거 누락, 도구 실패, 권한 거절, 다른 담당의 수정 대기로 막히면 그 단계와 그것에 의존하는 단계만 보류하고, 무엇이 막혔고 누구를 기다리는지 적은 뒤 남은 독립 작업을 계속한다. 막힌 단계를 기다린다는 이유로 턴을 끝내거나 작업 전체를 멈추지 않는다.
- 세 경우의 「계속한다」 문장은 이 규칙 하나로 합쳤다. 문장마다 다른 조건은 제자리에 남겼다.

| 이전 문장(위치) | 남은 조건(위치) | 일반 규칙으로 옮긴 조건 |
| --- | --- | --- |
| 제약 누락(:6) | 정본 참조 먼저 확인, 누락된 제약만 확인(:6) | 영향받는 실행만 보류(원인 「근거 누락」), 독립 작업 계속 |
| 사용자만 할 수 있는 일(:12) | 그 부분과 이유만 요청, 사용자·에이전트 몫 나눠 적기(:12) | 독립 작업 계속(원인 「사용자 몫」) |
| 분류 지원 미확정·거부(:16) | 계약의 실패 처리를 따름(:16) | 막힌 의존 단계와 독립 작업의 구분(원인 「도구 실패·권한 거절」). 분류 계약 `skill-classification.md`의 실패 처리 문단도 같은 구분을 둔다. |

- 공통 기준 본문은 4,732자(10,603바이트)에서 4,768자(10,685바이트)로 36자 늘었다. 3.7.0 기준의 4,771자보다 여전히 짧다.

### 검증

- 회귀 시험 `tests/mcp/d0031-intake-blocked-step.test.ts`(새 시험): 규칙이 원본, MCP 서버 instructions(ko·en), 생성 패키지(`claude-plugin`, `claude-plugin-en`, `codex-plugin-en`)에 실리는지, 계속하라는 문장이 한 번만 나오고 이전 세 문장이 남지 않았는지 확인한다.
- 합친 문장의 고정 조각은 요구를 줄이지 않고 새 조각으로 바꿨다: `d0031-d0032-intake-purpose-check`(3.7.0 규칙 조각, 길이 상한 4,771자는 그대로), `governance-orchestrator-autonomy`, `tool-schema-profile`.
- CI(Linux·Windows, Node 24): 코드 변경 7e2bdda5의 run 42164180482가 두 job 모두 success였다(시험 파일 162개 통과, 새 시험은 그때 이름 `d0034-intake-blocked-step.test.ts`로 3개 통과). 그 뒤 장부에서 D-0034를 D-0031로 합쳐 시험 파일 이름과 주석의 표기만 바꿨다.
- CI가 돌리지 않는 프로세스 경계 시험(`source-binding-successor`, `skill-classification/evaluation.test`, `tool-schema-profile`, `claude-plugin.test.mjs`, `skill-context-optimization.test.mjs`)의 변경분은 실행하지 않았다(NOT_RUN). 대신 r26 결속 사슬, 현재 결속 해석, 코퍼스 출처 digest, inventory 대조, r25 시험이 r26 기준 판을 읽는 경로를 시험 밖 스크립트로 재현해 확인했고, 공통 기준 문장이 다른 추적 파일에 복사되지 않았는지도 같은 방식으로 확인했다. 시험 자체의 실행을 대신하지 않는다.
- 실호스트에서 막힌 단계를 두고 남은 작업을 계속하는지는 시험하지 않았다(NOT_RUN).

## 공통 접수 기준의 검증·요청 규칙: AGS3-D-0031(옛 D-0035를 합침), D-0036, D-0039, D-0040, D-0041

다섯 결함 모두 원인이 공통 접수 기준(`skills/orchestrator/references/intake.md`)에 있었다. 모든 세션이 이 기준을 MCP instructions로 받는다. 이번에 바뀐 줄은 직접 처리 줄(`intake.md:12`)과 역할 줄(`:13`)뿐이다.

사용자 원문:

- D-0031(옛 D-0035): 「글고 에이전트가 테스트할때 실제로 동작하는걸 검증하지 못하는거같거든? 이것도 결함장부에 등록해놔.」
- D-0036: 「그리고 테스트는 테스트케이스를 먼저 작성해야하지 않아? 일단 테스트부터 하는거같은데 그것도 구조 개편해줘. <- 이것도 결함에 추가해.」
- D-0039: 「씨발 명확하게 말 안하는것도 결함이다. 결함 장부에 당장 등록해놔.」
- D-0040: 「수정해야지.」「글고 넌 수정이 당연한걸 왜 나한테 되물어? 이것도 결함으로 등록해놔.」
- D-0041: 「…이 부분은 그대로 두고 다음 작업으로 넘어가겠습니다. <- 씨발련아. 너 이것도 결함으로 등록해.」

### 원인

- D-0031: 기준은 할 수 있는 확인을 끝내고 미실행을 완료로 쓰지 말라고만 했다. 어디서 확인해야 하는지는 정하지 않았다. 11-06 사례에서 세션은 장부 서버 안쪽 smoke check(도구 12개)만 보고 「반영됐다」고 보고했다. 사용자가 쓰는 Cloudflare 포털 경로에서는 도구가 10개였다. 세션은 공개 주소의 도구 목록을 직접 보지 않고 사용자에게 동기화를 눌러 보라고 넘겼다(장부 case 1).
- D-0036: 작업을 시작하기 전에 무엇을, 어디서, 어떤 결과면 성공으로 볼지 정하라는 단계가 없었다. 그래서 에이전트가 사례 없이 일부터 하고, 확인은 나중에 이미 있는 검사만 돌렸다.
- D-0039: 사용자에게 요청할 때 대상을 특정하라는 규칙이 없었다. 승인 요청에만 「대상·영향·실행할 명령」이 있었다. 사례: 「조회하려면 사용자의 Cloudflare 토큰이 필요합니다」라고만 쓰자 사용자가 「무슨토큰?」이라고 되물었다.
- D-0040: 이미 받은 승인을 보존하는 규칙은 `skills/mutation-risk-preflight/SKILL.md:15`(같은 대상·행동·환경)에만 있었다. 공통 기준에는 묻지 않을 일로 되돌릴 수 있는 구현 선택·관례 값·이미 답한 사항만 있었다. 11-06 사례에서 세션은 사용자가 승인한 「운영에 defect_case 반영」에 필요한 Cloudflare 설정 복구를 「할지 정해 주세요」라고 다시 물었다. 사용자만 할 수 있는 일은 본인 토큰 입력뿐이었다(장부 case 2).
- D-0041: 역할 줄은 역할 밖 요청을 담당 세션에 넘기는 규칙만 두었다. 다른 세션이 이 세션의 역할·도구로 풀 수 있는 막힘을 풀어 달라고 할 때 그 턴에 처리하라는 규칙은 없었다. 그래서 직접 처리 줄의 막힌 단계 보류 규칙이 다른 세션의 막힘을 미루는 근거로 읽혔다.

### 바뀐 점

- D-0036: 무언가를 만들거나 바꾸는 작업이면 시작하기 전에 확인할 사례를 먼저 정한다. 사례는 무엇을, 어디서 확인하고 어떤 결과면 성공인지다. 코드에 한정하지 않는다.
- D-0031: 작업이 끝나면 그 사례를 사용자가 실제로 쓰는 진입점과 대상 환경에서 실행해 확인한다. 예로 공개 주소·설치된 앱·게시된 문서·광고 관리 화면을 든다. 내부 점검이나 일부 시험의 통과로 대신하지 않는다. 할 수 있는 확인을 사용자에게 넘기지 않고, 실행하지 않은 범위는 미검증으로 적는다. 기존 「개수·해시·조회 한 번·기존 시험처럼 직접 확인」과 「미실행을 완료로 표현하지 않는다」 문장은 이 두 문장에 합쳤다. 이미 있던 닫기 전 목적 확인(:11)과 막힌 단계만 보류(:12)는 그대로 둔다.
- D-0039: 막힌 단계 문장 바로 뒤에 요청 규칙을 두었다. 사용자에게 요청할 때는 앞 문맥 없이 바로 할 수 있게 대상을 적는다. 대상은 어떤 값·파일·화면인지, 언제 무엇으로 받은 것인지, 위치, 새로 필요한지 기존 것을 다시 쓰는지다. 실행할 정확한 명령도 적는다. 예: 「토큰」 대신 어느 계정의 어떤 권한 토큰인지. 승인 요청 문장의 「대상·실행할 명령」은 이 규칙으로 옮기고, 승인 요청에는 영향을 담으라는 조건만 남겼다.
- D-0040: 묻지 않을 일에 「이미 승인된 목표를 이루는 데 필요한 후속 수정·복구(행동이 달라도)」를 더했다. 이런 수정·복구는 묻지 않고 진행한다. 경계도 두었다. 받은 승인 밖의 새 고위험 행동은 지금처럼 영향을 담아 묻는다. 예는 다른 대상의 영구 삭제, 새 공개·배포다. 고위험 변경 직전에 `mutation-risk-preflight`를 호출하는 규칙(:10)은 그대로다. 사용자만 할 수 있는 부분은 기존 사용자 몫 규칙대로 그 부분만 요청한다.
- D-0041: 역할 줄의 넘기기 규칙 바로 뒤에 규칙을 더했다. 다른 세션이 이 세션의 역할·도구로 풀 수 있는 막힘을 풀어 달라고 하면, 이 세션의 보류 단계로 미루지 않는다. 그 턴에 처리하거나 시작하고, 요청한 세션에 결과를 답한다.
- 규칙 문구에는 벤더·제품 이름을 넣지 않았다.

### 블록 크기(문자 수 / UTF-8 바이트)

| 대상 | 3.7.0 기준(d068dfd6) | 이번 수정 전(e7990a87) | 이번 수정 후(c71d3ea5) |
| --- | --- | --- | --- |
| 공통 기준 본문(시작·끝 표시 사이) | 4,771자 | 4,768자 | 5,229자 |
| `intake.md` 파일 | — | 10,685바이트 | 11,793바이트 |

- 3.7.0 기준보다 458자 길다. D-0032의 목표(3.7.0 크기 이하)를 이번에는 지키지 못했다. 다섯 규칙이 461자를 더했다. 직접 확인 문장, 미실행 보고 문장, 승인 요청의 대상·명령은 새 규칙에 합쳤다. 나머지 문장은 이미 D-0032 1단계에서 줄였고, 시험이 고정한 3.7.0 규칙 조각이 걸려 있다. 그래서 규칙을 빼지 않고는 더 줄일 곳을 찾지 못했다.
- `d0031-d0032-intake-purpose-check`의 크기 시험은 상한을 3.7.0의 4,771자에서 이번 검토 크기 5,229자로 바꿨다. 앞으로 더 커지는 것을 막는 용도다.
- MCP 서버 instructions의 접수 안내 전체는 ko 5,452자, en 5,610자다(`skillIntakeText`).

### 검증

- 회귀 시험 `tests/mcp/d0036-d0041-intake-verify-and-ask.test.ts`(새 시험, 8개)를 수정보다 먼저 커밋했다(e7990a87). 결함마다 규칙 문장이 원래 실패 사례의 조건·행동·경계를 담는지 확인한다. 예를 들어 「끝나면 그 사례를」로 미리 정한 사례와 이어지는지, 내부 점검으로 대신하지 않는지, 「토큰」 예와 대상 항목이 있는지 본다. 승인된 목표의 후속 수정은 묻지 않고, 새 고위험 행동은 여전히 묻는지도 본다. 다른 세션의 막힘을 보류 단계로 미루지 않는지, 문장 순서가 맞는지, 벤더 이름이 없는지도 확인한다. 규칙이 MCP instructions(ko·en)와 생성 패키지 세 개에 한 번씩 실리는지도 확인한다.
- 수정 전 실패(red): e7990a87의 CI run 42171106898은 두 job(ubuntu·windows) 모두 failure였다. 실패한 시험 파일은 새 시험 하나뿐이다(1 failed, 162 passed 파일, 새 시험 8개 실패).
- 수정 후(green): c71d3ea5의 CI run 42171816005는 두 job(ubuntu·windows) 모두 success였다(시험 파일 163개 통과, 새 시험 8개 통과).
- 고정 조각을 바꾼 시험은 `d0031-d0032-intake-purpose-check` 하나다. 합친 문장의 조각을 새 문장 조각으로 바꿨고, 확인하는 요구는 줄이지 않았다.
- CI가 돌리지 않는 프로세스 경계 시험 `source-binding-successor`, `skill-classification/evaluation.test`는 vitest로 실행하지 않았다(NOT_RUN). 대신 이 PC에서 vitest 대신 쓰는 최소 대체 실행기(describe·it·expect만 흉내 냄, tsx로 실행)로 같은 시험 파일을 돌렸다. 수정 후 두 파일 모두 통과했다(20개, 22개). 수정 전 커밋(e7990a87)에서는 `source-binding-successor`의 retirement 시험 하나가 위 결속 절의 이유로 실패했다. 공통 기준 문장이 다른 추적 파일에 복사되지 않았는지(`claude-plugin.test.mjs`의 검사)도 같은 방식의 스크립트로 확인했다(문장 61개, 파일 3,304개, 복사 0). 대체 실행은 vitest 실행을 대신하지 않는다.
- 로컬 정적 검사(이 PC): `node scripts/build-en-packages.mjs --check`, `node scripts/build-claude-plugin.mjs --check`, `node scripts/sync-release-metadata.mjs`, `node scripts/check-skill-context-optimization.mjs`, `node scripts/check-source-lock.mjs`, `node scripts/validate-repository.mjs`, `node --test`(prompt-engineering·solid-design 계약, preflight 호환 100개), `git diff --check`가 모두 종료 0이었다.
- 실제 모델이 이 규칙을 따르는지는 평가하지 않았다(NOT_RUN). 이 시험은 규칙 문장이 원래 실패 상황의 조건과 행동을 담는지만 확인한다.

## 스킬 출처 결속

공통 접수 기준과 `coordinate-subagents` 참고 자료를 바꾸면서 결속 사슬도 함께 고쳤다(기존 결함 AGS3-D-0026의 절차).

- 출처 결속 r23(`tests/skill-classification/fixtures.role-delegation-intake-source-successor.json`): r22 뒤에 orchestrator `SKILL.md`·`classification.json`과 coordinate-subagents `entry-details.md`·`classification.json`을 다시 결속한다. 각 원본에서 한 줄만 바뀌고 줄은 움직이지 않는다. 넓어진 span은 `orchestrator:applicability[5]`, `coordinate-subagents:exclusions[4]` 둘뿐이다.
- 문맥 최적화 검사: 새 바이트를 4849bdd4의 바이트에 대응시켰다. `board-store.d.mts`는 digest로 직전 바이트에 대응시켰다. 검토된 guidance 후속 바이트를 그대로 가진 참고 자료는 바뀐 파일로 허용한다.
- coordinate-subagents의 source lock 통합 checksum을 새 값으로 바꿨다.
- 출처 결속 r24(`fixtures.intake-purpose-check-source-successor.json`, D-0031·D-0032 1단계)와 r25(`fixtures.intake-reference-move-source-successor.json`, 2단계): r24는 orchestrator `SKILL.md`·`classification.json`을 다시 결속한다. r25는 공통 기준 span을 `references/intake.md`로 옮기며 각 span에 이전 경로(`previousPath`)를 남긴다. `SKILL.md`에 남은 안내 문단은 `orchestrator:applicability[9]`가 가리킨다.
- 문맥 최적화 검사: 1단계·2단계의 새 바이트를 각각 d068dfd6·bdcb0792의 바이트에 대응시켰다. 새로 생긴 `references/intake.md`는 digest를 고정한 검토된 추가 파일(`GUIDANCE_ADDITIONS`)로 허용한다.
- 출처 결속 r26(`fixtures.intake-blocked-step-source-successor.json`, D-0031의 옛 D-0034): r25 뒤에 orchestrator `classification.json`과 `references/intake.md`를 다시 결속한다. 6·12·16번 줄만 바뀌고 줄은 움직이지 않는다. 문구가 바뀐 span은 `orchestrator:applicability[4]`, `[5]` 둘이고, 16번 줄의 `exclusions[7]`은 같은 글을 가리키도록 바이트 위치만 옮겼다.
- 문맥 최적화 검사: 두 파일의 새 바이트를 86933a33의 바이트에 대응시켰다. 검토된 추가 파일은 대응시킨 바이트로 확인하고, 기준 판에 없던 파일의 후속 바이트는 기준 판에 대응시키지 않는다(그런 파일을 바꾸면 예외 대신 「unpinned context change」로 보고한다).
- 출처 결속 r27(`fixtures.intake-verify-and-ask-source-successor.json`, D-0031·D-0036·D-0039·D-0040·D-0041): r26 뒤에 orchestrator `classification.json`과 `references/intake.md`를 다시 결속한다. 12·13번 줄만 바뀌고 줄은 움직이지 않는다. 바이트가 바뀐 span은 `orchestrator:applicability[5]`(8~13번 줄) 하나다. `evaluation.ts`의 현재 결속 해석이 r27까지 따라가고, r26 시험은 r27이 다시 결속한 파일을 r27 기준 판(e7990a87)에서 읽는다.
- 문맥 최적화 검사: 두 파일의 새 바이트를 e7990a87의 바이트에 대응시켰다.
- 같은 시험 파일의 retirement(r22) 시험이 결속 해석 결과를 그 판의 digest와 비교하고 있었다. 뒤 판(r23)이 `SKILL.md`를 다시 결속한 뒤로는 맞지 않는 비교였다. 이 판정을 최신 digest와 비교하도록 고쳤다. 이 시험은 CI 범위 밖이라 그동안 실행되지 않았다. 이번 수정 전 커밋(e7990a87)에서도 같은 판정이 실패하는 것을 아래 대체 실행으로 확인했다.

## 검증

- 로컬 정적 검사(이 PC): `corepack pnpm build`, `node scripts/check-bundle.mjs`, `node scripts/check-skill-context-optimization.mjs`, `node scripts/validate-repository.mjs`, `node scripts/run-python-validations.mjs`, `node scripts/check-source-lock.mjs`, `node scripts/i18n.mjs --check`, `node scripts/sync-release-metadata.mjs`, `node scripts/build-claude-plugin.mjs --check`, `node scripts/build-en-packages.mjs --check`, `eslint .`, `git diff --check`가 모두 종료 0이었다. vitest는 이 PC에서 돌리지 않았다.
- CI(Linux·Windows, Node 24): 코드 변경을 모두 담은 0b1aa299에서 run 42153692286이 두 job 모두 success였다. 문서만 바꾼 최종 후보 커밋의 CI는 부모가 후보를 고정할 때 함께 적는다.
- 수정 전 실패 확인(red): 3.7.0 기준 4849bdd4에 이번 회귀 시험만 얹은 시험 브랜치 `test/v380-red-20261106`(7b75fef0)에서 CI run 42153760723이 두 job 모두 failure였다. 실패한 시험 파일은 아래 네 개의 새 시험·고친 시험 파일뿐이다(4 failed, 156 passed). 이 브랜치에서는 3.7.0의 `setSummary` 타입이 인자 세 개만 받아 tsc가 멈추므로, 시험 쪽에서만 타입 없는 별칭으로 실제 함수를 불렀다.
- 넣은 회귀 시험:
  - `tests/context-continuity/d0001-subagent-start-cue.test.ts`: Claude Code·Codex 입력 모양의 `SubagentStart`가 안내를 받는지, child로 관측되는지, 상태 DB 없이도 안내가 나가는지, 두 hook 설정에 등록됐는지, Codex 한도가 안내 전체를 담는지를 확인한다.
  - `tests/context-continuity/phase-check.test.ts`: 단계 확인 알림이 최신 run의 `runId`와 `rootId`를 싣는지 확인한다.
  - `tests/session-board/session-board.test.ts`: 역할 기록·유지·거절, 이전 3.x 현황판에 열을 제자리에서 더하는지, 이전 AGS가 계속 쓸 수 있는지, MCP 도구의 `role` 입출력을 확인한다.
  - `tests/mcp/d0002-d0030-intake-role-delegation.test.ts`: 공통 접수 기준의 역할·넘기기·질문·위임 문장과, 참고 자료의 직접 수행 기본값 제거를 확인한다.
  - `tests/context-continuity/d0347-checkpoint-cue.test.ts`, `d0360-skill-purpose-cue.test.ts`: 메시지마다 나가는 안내의 바뀐 위임 문장을 바이트 단위로 확인한다.
- D-0031·D-0032 CI(Linux·Windows, Node 24): 1단계 bdcb0792의 run 42158104872는 두 job 모두 failure였다(1 failed, 2390 passed). `skill-classification-inventory` 시험의 행 접두가 합친 문장 가운데를 가리킨 것이 원인이며, 2단계에서 줄 첫머리 접두로 고쳤다. 2단계 553e0f0e의 run 42159041421은 두 job 모두 success였다. 3단계 후보 7ff84bc6의 run 42159664336은 같은 브랜치의 다음 실행에 밀려 취소됐다(CI의 `cancel-in-progress`). 릴리스 노트를 더한 713c6816의 run 42159834885는 두 job 모두 failure였다(1 failed, 160 passed 파일). agy 턴 알림 시험이 스킬 목록을 메시지마다 알림 안에서 찾은 것이 원인이며, db41d041에서 그 시험이 실제 intake hook의 맥락 시작 내용에서 목록을 찾도록 고쳤다. db41d041의 run 42160642958은 두 job 모두 success였다.
- D-0031·D-0032에서 넣거나 고친 시험:
  - `tests/mcp/d0031-d0032-intake-purpose-check.test.ts`(새 시험): D-0031 규칙이 공통 기준과 MCP instructions(ko·en)에 실리는지, 합친 규칙이 한 번만 나오는지, 3.7.0 규칙 조각 78개가 남는지, 기준 본문이 3.7.0의 4,771자보다 짧은지 확인한다.
  - 문장을 합치거나 파일을 옮겨 바뀐 고정 문자열만 새 위치·새 조각으로 바꿨다. 확인하는 요구는 줄이지 않았다: `governance-orchestrator-autonomy`, `tool-schema-profile`, `orchestrator-resource-impact`, `skill-classification-inventory`, `root-cause-disable`, `i18n-tools`, `intake-hook`, `d0002-d0030-intake-role-delegation`, `claude-plugin.test.mjs`, `antigravity-plugin.test.mjs`, `skill-context-optimization.test.mjs`.
  - `source-binding-successor.test.ts`: r24·r25 사슬 시험 두 개를 더했다.
  - 3단계 후보: `d0360-skill-purpose-cue`, `d0347-checkpoint-cue`, `intake-hook`, `claude-plugin.test.mjs`, `antigravity-connector/hooks/antigravity-turn-cue.test.mjs`가 목록이 맥락 시작에 실리고 메시지마다 알림은 한 줄로 그 목록을 가리키는지 확인한다.
- CI는 프로세스 경계 시험을 돌리지 않는다(`scripts/test-scope.mjs`). 그래서 `source-binding-successor`, `claude-plugin.test.mjs`, `antigravity-plugin.test.mjs`, `skill-context-optimization.test.mjs`, `tool-schema-profile`, `skill-classification/evaluation.test` 변경분은 실행하지 않았다(NOT_RUN). 이 시험들이 읽는 원본·고정값은 로컬 정적 검사(`check-skill-context-optimization`, `validate-repository`, `build-* --check`)로만 확인했다.
- 3단계 스킬 선택 정확도 A/B는 실행하지 않았다(NOT_RUN). 비교 도구는 `tests/real-host/cue-ab/`에 있다. 시험 서버에서 Claude Code와 Codex 실호스트로 목적이 다른 요청 7턴을 이어 보내고, 기존 알림(A)과 후보(B)의 실제 Skill 호출을 대화 기록에서 판정한다. 실행 순서는 `tests/real-host/cue-ab/DESIGN.md`에 있다.
- 실호스트 시험(Claude Code·Codex에서 실제 서브에이전트를 띄워 안내가 들어가는지)은 하지 않았다. Codex는 공식 문서와 0.166.0 실행 파일의 이벤트 이름 문자열로만 지원을 확인했다.
- 모델 행동 평가(위임 검토·역할 넘기기를 실제로 하는지)는 하지 않았다(NOT_RUN).

### 이번에 고치지 않은 것

- agy 서브에이전트에는 시작 안내가 닿지 않는다. agy에 해당 hook 이벤트가 생기면 어댑터 매핑만 더하면 된다.
- 세션의 열린 workflow를 나열하는 전용 조회 도구는 없다.
- 위임 지시문 내용 검사는 하지 않는다.
- D-0032 3단계(메시지마다 알림 줄이기)는 A/B 결과 전까지 발행 후보가 아니다. A/B에서 스킬 선택이 나빠지면 7ff84bc6을 되돌린다.
- D-0031(옛 D-0034)의 막힌 단계 규칙은 문구만 바꿨다. 턴 종료 hook이 남은 독립 작업을 확인시키는 장치는 더하지 않았다. 문구만으로 부족한지는 실호스트 시험 전에는 알 수 없다. 부족하면 턴 종료(Stop) hook이 이번 턴에 보류한 단계가 있는데 남은 일이 적히지 않았을 때 한 번 되묻는 방안을 검토한다(미구현, 제안).
- `intake.md:16`의 `[공통 분류 지원 계약](references/skill-classification.md)` 링크는 파일이 `references/`로 옮겨진 뒤 상대 경로가 맞지 않는다(553e0f0e 이후). MCP instructions로 실릴 때는 글만 전달되므로 동작에는 영향이 없지만 링크로는 열리지 않는다. 이번 범위 밖이라 고치지 않았다.
