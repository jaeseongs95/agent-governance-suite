# AGS v2.7.3 Windows 로컬 전체 검증

- 후보: `e3220a48ce0f1aaea30f90db4bbb597b8fd7ea92` (tree `2934992daa71fa2b24af7f58bd95454ea59d46c2`), `claude/v273-integration`의 코드 최종 커밋이다. 이 뒤의 커밋은 release notes 문서만 바꾼다.
- 환경: Windows 11 Pro 10.0.26200, Node.js v24.19.0, pnpm 11.19.0. 작업 경로에 한글 디렉터리 이름이 들어 있다.
- 실행자: 총괄 ca8e3dc4. detached worktree에서 AGENTS.md의 순서대로 실행했다.

## 결과 (`logs/summary.tsv`)

| # | 명령 | 종료 코드 |
|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | 0 |
| 2 | `pnpm bundle:check` | 0 |
| 3 | `pnpm claude:drift` | 0 |
| 4 | `pnpm lint` | 0 |
| 5 | `pnpm build` | 0 |
| 6 | `pnpm test` | 0 (테스트 858 통과, 2 skip) |
| 7 | `pnpm runtime:check` | 0 |
| 8 | `pnpm validate:all` | 0 |
| 9 | `pnpm validate:official` | 0 |
| 10 | `pnpm claude:build` | 0 |
| 11 | `pnpm claude:check` | 0 |
| 12 | `pnpm source:check` | 0 |
| 13 | `git diff --check` | 0 |
| 14 | 검증 뒤 `git status --porcelain` | 0 byte |
| — | previous-broker v2.7.2 / v2.7.1 / v2.2.6 | 각 2/2 통과 (`logs/prev-*.log`) |

previous-broker는 각 태그의 `git archive`에서 꺼낸 `mcp-server/dist/session-message-broker.mjs` 파일 경로를 `AGS_PREVIOUS_BROKER_PATH`로 주었다.

## 범위

저장소 검사다. 설치된 host의 wake 주입·관측, 설치 캐시, marketplace 설치는 확인하지 않았다(NOT_RUN).

## 가림

로그에서 이메일, 계정 이름, 사용자 홈 경로, IP, 토큰 패턴을 찾았고 걸린 값이 없어 바꾼 것이 없다. 작업 경로는 meta.json에 적지 않았다.
