# AGS 3.5.0 릴리스 노트

3.5.0은 하나를 고친다. 다단계 변경은 workflow로 시작한다는 공통 접수 규칙이 agy(Antigravity) 모델에게 전달되지 않았다. 사용자 질문(「gemini쪽은 AGS가 설치되어있어도 AGS 워크플로우를 호출하지 않는거같은데 왜 그렇게 행동하는지 봐줄래?」)으로 원인을 찾았고, 「3.5.0으로 발행해줘.」로 발행했다. 설계 제약은 사용자 원문 「AGS는 어떤 에이전트, 어떤 벤더사던지 쓴다는걸 명심해줘.」이다.

호환성: 공개 도구 계약, 오류 code, DB schema 버전은 바뀌지 않는다. 새 실행 파일은 `mcp-server/dist/intake-hook.mjs` 하나다. 전에 3.5.0으로 예상하던 DBMS 전환은 다음 판으로 미룬다.

## 원인

공통 접수 규칙은 `skills/orchestrator/SKILL.md`의 `skill-intake` 블록이다. 3.4.0까지 이 규칙을 모델에게 주는 경로는 MCP 서버 `instructions` 하나였다. Claude Code에서는 이것만으로 충분했다. Claude Code가 `instructions`를 모델 맥락에 그대로 싣기 때문이다. agy는 그렇지 않았다.

Linux 시험 서버에서 agy 1.4.12에 3.4.0 release zip을 설치하고 판별했다. 도구를 쓰지 않게 하고 물었다.

| 질문 | 결과 |
|---|---|
| 맥락에 「agent-governance-suite 접수 안내」로 시작하는 문장이 있으면 인용 | 2/2 `NONE`, 도구 호출 0 |
| 대조: 도구 목록에서 `start_workflow`·`plan_workflow` 이름 | 2/2 정확히 답함(`agent-governance-suite_ags` 서버의 lazy 도구) |

표지 문장은 서버 `instructions`에만 있고 어떤 `SKILL.md`에도 없다. agy는 AGS MCP 서버에 연결해 도구는 보지만 `instructions`는 모델에게 주지 않는다. agy의 세션 시작 hook도 피어 메시지와 이어받기 상태만 넣고 접수 규칙은 넣지 않았다. 그래서 agy 모델이 접수 규칙을 보려면 orchestrator `SKILL.md`를 스스로 열어야 했다.

규칙을 어기면 막는 장치(workflow 없이 세 번째 제품 파일을 편집하면 거부)는 agy에도 연결돼 있었다. 다만 VCS 아래 파일만 세고 셸 편집은 세지 않으며, 턴 끝 단계 확인은 이미 묶인 workflow가 있어야 동작한다. 그래서 대부분의 작업이 막힘 없이 workflow 없이 끝났다.

## 바뀐 점

- **접수 규칙의 원본 하나.** `mcp-server/src/skill-intake.ts`가 `SKILL.md`의 블록을 틀 문장과 함께 렌더링한다. 서버 `instructions`와 새 hook이 같은 함수를 쓴다. 블록은 설치된 패키지 언어 그대로이고 틀 문장만 locale을 따른다(i18n 설계 4.2).
- **공통 세션 시작 hook.** `mcp-server/src/intake-hook.ts`는 호스트 어댑터가 세션 시작(새 세션, fork, clear, resume, compact)이라고 판정한 입력에만 접수 규칙을 `additionalContext`로 낸다. 호스트 이름으로 분기하지 않는다. 처음 보는 호스트도 어댑터가 세션 시작을 알려 주면 같은 출력을 받는다.
- **등록은 호스트 패키지가 정한다.** 호스트 차이는 hook 등록에서만 다룬다.
  - agy: runner의 SessionStart 단계가 `session-message`, `intake`, `continuity` 순이 된다. 결과는 `systemMessage` injectStep으로 들어간다.
  - Codex: `hooks/hooks.json` SessionStart에 `intake-hook.mjs`를 등록했고 `additionalContextLimit`는 8192다. OpenAI 공식 문서는 Codex가 `instructions`를 쓴다고 하면서도 앞 512자를 독립적으로 쓰라고 권한다. 그래서 전문이 모델에게 가는지 확신할 수 없어 등록했다. Codex가 전문을 보여 준다면 같은 글을 두 번 읽는다.
  - Claude Code: 등록하지 않는다. `instructions` 전문을 모델에게 보여 주고 압축 뒤에도 남는다. `skill-trigger-hook`은 지금처럼 호출 방식 한 줄만 붙인다.
  - MCP만 쓰는 호스트는 서버 `instructions`로 받는다. 지금과 같다.
- **처음에 시도한 방식.** 처음에는 공통 continuity hook의 세션 시작 출력에 접수 규칙을 붙였다(f413d8fa). 작업 이어받기와 정책 전달이 한 출력에 섞였고, 세션 시작 출력을 고정한 기존 continuity 시험이 20개 넘게 실패했다(Linux 표적 시험 GREEN_EXIT=1). 별도 hook으로 나누고 continuity는 3.4.0 그대로 두었다(86532fb5).

## 검증

(작성 중)

## 알려진 제한

- agy의 SessionStart는 새 대화에서만 발생한다(runner 주석, AGS-D-0317). 3.5.0을 설치하기 전부터 열려 있던 agy 대화에는 접수 규칙이 들어가지 않는다. 새 대화를 열어야 한다.
- agy가 긴 대화에서 앞쪽 systemMessage를 잘라 내는지는 확인하지 않았다.
- Codex 실호스트 시험은 이번에도 돌리지 않았다(Codex API 크레딧 문제). Codex의 `additionalContextLimit`가 문자 수인지 토큰 수인지는 공식 문서에서 확인하지 못했다. 접수 규칙은 한국어판 3,969자, 8,767바이트다.
- 편집 관문이 VCS 밖 파일과 셸 편집을 세지 않는 한계는 그대로다(설계 7.8).
