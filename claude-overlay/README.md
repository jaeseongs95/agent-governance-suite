# Agent Governance Suite for Claude Code

이 폴더는 `scripts/build-claude-plugin.mjs`가 생성한다. 직접 수정하지 말고 저장소 루트의 원본이나 `claude-overlay/`를 고친 뒤 `pnpm claude:build`를 실행한다.

## 설치

```text
/plugin marketplace add jaeseongs95/agent-governance-suite
/plugin install agent-governance-suite@agent-governance-claude
```

## Codex 배포물과의 격리

- 이 플러그인의 루트는 `claude-plugin/`이다. 저장소 루트의 Codex용 `hooks/hooks.json`, `.mcp.json`, `.codex-plugin/`은 읽지 않는다.
- workflow·continuity SQLite 상태는 `${CLAUDE_PLUGIN_DATA}`에 저장한다. Codex 플러그인의 상태 디렉터리를 열지 않는다.
- `codex-token-usage-analyzer`는 Codex 세션 로그 전용이라 포함하지 않는다.

## 실행 보증 제한

실행 보증이 필요한 orchestrated workflow는 Claude Code에서 시작되지 않고 `BINDING_REQUIRED`를 반환한다. 서버에 신뢰할 수 있는 실행 관측값 제공자가 없고, Claude Code 훅은 추론 수준만 알려 주며 모델 정보는 주지 않기 때문이다. Codex 배포물의 서버도 같은 조건에서 같은 결과를 낸다. 전문 스킬 단독 호출과 실행 보증이 필요 없는 MCP 기능은 그대로 사용할 수 있다.

## Claude용 보정

- `claude-overlay/replacements.json`: 공용 파일에 적용할 치환 목록이다. 찾을 문구가 없거나 두 번 이상 나오면 생성이 실패한다.
- 생성된 `SKILL.md`, `references/*.md`, `agents/*.md`에 Codex 전용 표현(`fork_turns`, `$스킬명` 호출 등)이 남으면 생성이 실패한다. 두 호스트를 함께 설명하는 `coordinate-subagents` 문서는 예외다.
- `agents/independent-auditor.md`, `agents/deliberation-reviewer.md`: 부모 대화를 상속하지 않고, 파일 수정과 재위임을 막은 서브에이전트 정의다.
- `instruction-scope-resolver`의 스크립트는 `AGENTS.md` chain만 계산한다. `CLAUDE.md` 계층은 `references/claude-code-instructions.md`에 따라 스킬이 따로 확인한다.
