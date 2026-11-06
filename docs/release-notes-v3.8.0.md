# AGS 3.8.0 릴리스 노트(초안)

3.8.0은 서브에이전트·위임·세션 역할·열린 workflow 식별에 관한 결함 다섯 건(AGS3-D-0001, D-0002, D-0003, D-0004, D-0030)을 고친다. 판 번호와 판 메타데이터는 아직 올리지 않았다. 사용자 원문은 「3.7.0 릴리즈되면 결함중 가장 우선순위가 높은거 뽑아서 개선하고 릴리즈해.」「한번에 여러개 개선해도 돼.」「결함부터 때려잡아야 기능 개발을 하던지 할거아냐.」다. D-0030 관련 원문은 「그리고 AGS가 세션 협업을 유도하는지 확인해줄래?」「즉 자신의 역할을 인지하는지. 자신의 일이 아니면 다른 세션에 맡길수있는지 확인. 그래도 안되면 사용자에게 물어보기.」다.

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

## 스킬 출처 결속

공통 접수 기준과 `coordinate-subagents` 참고 자료를 바꾸면서 결속 사슬도 함께 고쳤다(기존 결함 AGS3-D-0026의 절차).

- 출처 결속 r23(`tests/skill-classification/fixtures.role-delegation-intake-source-successor.json`): r22 뒤에 orchestrator `SKILL.md`·`classification.json`과 coordinate-subagents `entry-details.md`·`classification.json`을 다시 결속한다. 각 원본에서 한 줄만 바뀌고 줄은 움직이지 않는다. 넓어진 span은 `orchestrator:applicability[5]`, `coordinate-subagents:exclusions[4]` 둘뿐이다.
- 문맥 최적화 검사: 새 바이트를 4849bdd4의 바이트에 대응시켰다. `board-store.d.mts`는 digest로 직전 바이트에 대응시켰다. 검토된 guidance 후속 바이트를 그대로 가진 참고 자료는 바뀐 파일로 허용한다.
- coordinate-subagents의 source lock 통합 checksum을 새 값으로 바꿨다.

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
- 실호스트 시험(Claude Code·Codex에서 실제 서브에이전트를 띄워 안내가 들어가는지)은 하지 않았다. Codex는 공식 문서와 0.166.0 실행 파일의 이벤트 이름 문자열로만 지원을 확인했다.
- 모델 행동 평가(위임 검토·역할 넘기기를 실제로 하는지)는 하지 않았다(NOT_RUN).

### 이번에 고치지 않은 것

- agy 서브에이전트에는 시작 안내가 닿지 않는다. agy에 해당 hook 이벤트가 생기면 어댑터 매핑만 더하면 된다.
- 세션의 열린 workflow를 나열하는 전용 조회 도구는 없다.
- 위임 지시문 내용 검사는 하지 않는다.
