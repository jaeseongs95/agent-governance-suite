---
name: session-board
description: "Use when several sessions on one computer handle the same work folder (for example a repository) or plugin install. Each session writes its current work in one line on the local board, reads the board before shared-state actions such as main merge, push, tag, release or install or when others' work matters, and updates the line when its work or next external action changes. Never write request text, secrets or personal data."
license: MIT
metadata:
  version: "1.0.0"
---

# Session Board

이 스킬을 적용할 때 [공통 행동 기준](../independent-audit-gate/references/specialist-behavior.md)을 먼저 읽고 따른다.

같은 컴퓨터에서 동시에 일하는 세션들이 서로 무엇을 하는지 알고 부딪히지 않게 한다. 세션 ID와 작업 디렉터리는 플러그인 훅이 채우고, 에이전트는 지금 하는 일 한 줄만 적는다. 현황판은 이 컴퓨터의 모든 에이전트 호스트가 함께 쓰는 로컬 SQLite 파일 하나이며 외부로 보내지 않는다.

## 작업이 바뀔 때 한 줄 갱신

- 새 작업을 시작하거나 작업 내용·다음 외부 작업이 바뀌면 `update_session_status`를 `{ "schemaVersion": "1.0.0", "summary": "<한 줄>" }`로 호출한다. 같은 작업을 계속하는 요청마다 반복 호출하지 않는다.
- 한 줄에는 무엇을 하는지, 어디서 하는지(작업 폴더·저장소·브랜치), 다음에 할 외부 영향 작업(main 병합, push, 태그, 설치)을 200자 이내로 적는다. 예: `v1.21.0 릴리스 준비 · claude/session-board · 다음은 main 병합·push·설치`.
- 훅이 관측한 세션 시작과 사용자 입력 시각은 자동으로 기록한다. 요청 원문을 요약으로 복사하지 않는다.
- 요청 원문, 비밀, 개인정보, 긴 로그는 적지 않는다.
- 서브에이전트는 이 도구를 호출하지 않는다. 메인 세션의 줄은 메인 세션이 갱신한다.

현황판은 작업을 막는 승인 관문이 아니다. 요약이 없거나 오래되었어도 파일 수정·시험·명령·위임의 첫 시도를 거부하지 않는다. `stale`은 요약 작성 뒤 사용자 입력이 있었는지 표시하며 실행 권한이나 relay 연결 상태가 아니다. 명시적인 현황판 조회·갱신은 관측된 메인 세션에만 결속하고 잘못된 요약은 거절한다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
