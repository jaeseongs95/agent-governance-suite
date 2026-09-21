---
name: session-board
description: 같은 컴퓨터에서 여러 에이전트 세션(다른 에이전트 호스트의 세션 포함)이 같은 저장소나 플러그인 설치를 동시에 다룰 때 쓴다. 세션마다 지금 하는 일을 한 줄로 로컬 현황판에 적고, main 병합·push·태그·릴리스·설치 전이나 다른 세션의 작업이 궁금할 때 현황판을 읽는다. 요청마다 첫 변경 전에 한 줄을 갱신한다. 요청 원문·비밀·개인정보는 적지 않는다.
license: MIT
metadata:
  version: "1.0.0"
---

# Session Board

같은 컴퓨터에서 동시에 일하는 세션들이 서로 무엇을 하는지 알고 부딪히지 않게 한다. 세션 ID와 작업 디렉터리는 플러그인 훅이 채우고, 에이전트는 지금 하는 일 한 줄만 적는다. 현황판은 이 컴퓨터의 모든 에이전트 호스트가 함께 쓰는 로컬 SQLite 파일 하나이며 외부로 보내지 않는다.

## 한 줄 갱신(필수)

- 사용자 요청을 받으면 파일을 고치거나 명령을 실행하기 전에 `update_session_status`를 `{ "schemaVersion": "1.0.0", "summary": "<한 줄>" }`로 호출한다.
- 한 줄에는 무엇을 하는지, 어디서 하는지(저장소·브랜치), 다음에 할 외부 영향 작업(main 병합, push, 태그, 설치)을 200자 이내로 적는다. 예: `v1.21.0 릴리스 준비 · claude/session-board · 다음은 main 병합·push·설치`.
- 같은 작업이 이어지는 요청이면 같은 문장을 다시 적어도 된다. 작업이 바뀌면 새 문장을 적는다.
- 요청 원문, 비밀, 개인정보, 긴 로그는 적지 않는다.
- 서브에이전트는 이 도구를 호출하지 않는다. 메인 세션의 줄은 메인 세션이 갱신한다.

플러그인 훅이 이 규칙을 강제한다. 요약이 없거나 마지막 요청 뒤 갱신되지 않았으면, 그 요청에서 처음 파일을 고치거나 명령·서브에이전트를 실행하려 할 때 한 번 거부하고 이유를 알린다. 두 번째 시도는 허용하므로 현황판에 장애가 있어도 작업은 멈추지 않는다. 읽기 전용 단일 명령(`git status`, `git log`, `git diff`, `git show`, `git branch`, `ls`, `cat`, `pwd`, `rg`, `grep`)은 거부하지 않는다. 연산자, 리다이렉션, 변수, 괄호·중괄호, 따옴표·백슬래시가 들어가거나 파일을 쓰거나 프로그램을 실행하는 옵션(`--output`, `--ext-diff`, `--pre`)이 있으면 읽기 전용으로 보지 않는다. 호스트가 제공하는 훅 이벤트에 따라 강제 범위가 좁아질 수 있다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
