# wake53-claude-host-probe 결과

대상: 53eff30a2984d41fc749d38dd2062966017684fa (tree c030fa4e19411ef511c5d5c89cf588aa6f42c059), claude-plugin 2.7.1 (claude:check fresh).
중첩 실행: claude 2.1.283, `-p --plugin-dir <repo>/claude-plugin --output-format stream-json --verbose --max-turns 6`, 권한 모드 default, cwd /tmp/scratch(원격 없는 git). 총 6회.

## 판정: 부분 가능
- 가능: 플러그인 로딩(init에 agent-governance-suite@inline 2.7.1), MCP 서버 connected(도구 27개), 스킬 20개·에이전트 2개 노출, hook 실행(SessionStart 3, UserPromptSubmit 3, PreToolUse/PostToolUse, Stop), 자연어 스킬 선택 관찰.
- 한계: (1) 기본 권한 모드 headless에서는 Edit/Write/일부 Read가 승인 대기로 거절되어 구현 결과까지는 볼 수 없음(b, d2). (2) max-turns 6에서 세션 현황판 선기록 훅의 첫 Bash deny + ToolSearch로 2~3턴을 써 b·c·e는 error_max_turns로 끝남. (3) 중첩 실행의 session_id가 바깥 cloud 세션 ID(63f5010f-…)와 같아 세션 현황판 바인딩이 바깥 세션과 겹침 — 다중 세션·현황판 실험에는 부적합. (4) 모델은 host 기본값(claude-sonnet-5)이며 cloud 환경의 기본 스킬(anthropic-skills 등)도 함께 노출됨. (5) 플러그인 내부 references 읽기(Read on plugin dir)가 권한 거절됨(c).

## 프롬프트별
| 프롬프트 | skill-trigger 훅 안내 | 선택 Skill | 주요 도구 순서 | 종료 |
|---|---|---|---|---|
| (a) 인사 | 없음 | 없음 | 없음 | success, 1턴 |
| (b) README 오타 | 없음 | 없음 | Bash(현황판 훅 deny)→ToolSearch→update_session_status→Bash→Read→Edit(권한 거절) | max_turns |
| (c) 공개 push+태그 | change-scope-guardian 제안 | orchestrator | Skill→Read×2(거절)→Bash(현황판 deny)→ToolSearch→update_session_status | max_turns, push/태그 실행 없음 |
| (d) "이 함수에 캐시" | 없음 | 없음 | 없음 — 대상 함수 되물음 | success, 1턴 |
| (d2) fib.js 캐시(추가) | 없음 | ponytail | Skill→Bash(deny)→ToolSearch→Bash→update_session_status→Read→Edit(권한 거절) | success(승인 요청으로 종료) |
| (e) 한국어 문서 다듬기 | 없음 | korean-prose-editor(Read 후) | Bash(deny)→ToolSearch→update_session_status→Bash→Read→Skill | max_turns |

관찰 기준 대비(판정 아님): (a) 강제 워크플로 없음. (b) 구현 계열 스킬 미선택(직접 편집 시도). (d) 모호해 되물음; (d2)에서 ponytail 선택. (c) orchestrator 선택(훅은 change-scope-guardian 제안; mutation-risk-preflight 직접 호출은 max_turns 전 관찰 안 됨). (e) korean-prose-editor 선택.
scratch 저장소 변경·태그·원격 없음(모든 편집 거절됨).

이 결과는 Linux cloud 한 환경의 실험이며 사용자 PC의 실제 Codex/Claude 설치·live 동작 증거가 아니다.
