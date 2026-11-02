# AGS 3.0.2 릴리스 노트

3.0.2는 작업을 마치기 전에 빠뜨린 단계를 에이전트가 알아차리게 하는 기능을 더한다. 계약·DB 스키마·MCP 도구 목록은 바뀌지 않았다. 3.0.1을 쓰는 호스트는 3.0.2로 바꾸고 AGS 프로세스를 다시 시작한다.

## 바뀐 점

### 작업을 마칠 때 빠진 단계 확인

- 파일 편집 도구가 쓰인 turn이 끝날 때(Stop) AGS가 한 번 확인한다. workflow 없이 바꿨거나, 연결된 workflow에서 통과하지 않은 단계가 있으면 에이전트에게 알린다.
- 에이전트는 빠뜨린 단계를 사용자에게 밝히고, 필요하면 그 단계를 진행하고, 필요 없으면 이유를 한 줄로 남긴다. 작업을 막지는 않는다.
- 같은 확인은 반복하지 않는다. 확인 뒤 다시 편집하면 다음 Stop에서 한 번 더 확인한다. 편집이 없는 turn에는 출력이 없다.
- 편집으로 세는 도구: Claude `Edit`·`Write`·`MultiEdit`·`NotebookEdit`, Codex `apply_patch`, Antigravity `write_to_file`·`replace_file_content`·`multi_replace_file_content`. 셸과 subagent 위임은 세지 않는다.
- 호스트별 출력: Claude는 Stop `additionalContext`, Codex는 Stop `{decision: "block", reason}`(이어 가기 프롬프트), Antigravity는 Stop `{decision: "continue", reason}`이며 세션 메시지 문구와 하나로 합친다.

### 접수 기준

- 설계·구현·시험·반영처럼 단계가 이어지는 변경 작업은 `plan_workflow`로 시작하도록 접수 기준(`skills/orchestrator/SKILL.md`)을 고쳤다. 질문 답변, 설명, 한 줄 수정, 전문 스킬 하나로 끝나는 작업은 지금처럼 직접 처리한다.

### CI

- release-3.0 push에서만 돌던 예전 증거 수집 작업(`verify-release`)과 그 작업만 쓰던 스크립트를 지웠다. 모든 브랜치에서 같은 `verify` 작업이 돈다.

## 업그레이드 시 확인할 것

- Codex는 플러그인 hook을 설치만으로는 실행하지 않는다. `/hooks`에서 AGS hook(새로 추가된 `Stop`, `apply_patch` 포함)을 검토하고 신뢰해야 이 기능이 동작한다.

## 관측하지 못하는 것

- 셸로 바꾼 파일과 배포, subagent의 편집, Codex hosted tool의 편집.
- 에이전트가 밝힌 이유가 맞는지.

## 검증

- CI(ubuntu·windows, Node 24)와 Linux 시험 서버(Node 24.22.1) 전체 시험을 실행했다. 새 시험은 고치기 전 코드에서 실패하는 것을 확인했다.
- 실제 호스트에서 파일 한 줄을 고치게 해 Stop 뒤 단계 확인 답변을 확인했다: Claude Code 2.1.316(Windows), Codex 0.166.0(Windows, hook 신뢰 후), Antigravity 1.4.12(Linux).
