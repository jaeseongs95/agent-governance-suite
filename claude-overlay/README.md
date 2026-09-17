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
