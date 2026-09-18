# Agent Governance Suite for Claude Code

이 폴더는 `scripts/build-claude-plugin.mjs`가 생성한다. 직접 수정하지 말고 저장소 루트의 원본이나 `claude-overlay/`를 고친 뒤 `pnpm claude:build`를 실행한다.

## 설치

```text
/plugin marketplace add jaeseongs95/agent-governance-suite
/plugin install agent-governance-suite@agent-governance-claude
```

## Codex 배포물과의 격리

- 이 플러그인의 루트는 `claude-plugin/`이다. 저장소 루트의 Codex용 `hooks/hooks.json`, `.mcp.json`, `.codex-plugin/`은 읽지 않는다.
- MCP 서버에 `AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE=anthropic`을 넘겨 `plan_workflow`의 공개 스키마에서 최상위 `oneOf`를 없앤다. Anthropic API가 이 형태를 받지 않기 때문이다. 입력 검증은 기존 계약 그대로다.
- 같은 환경 변수로 MCP 서버가 세션 `instructions`(접수 규칙)를 내보낸다. Claude Code는 이것을 세션 시작 때 시스템 프롬프트에 넣는다. 규칙은 "파일을 고치거나 명령을 실행하기 전에 이 요청의 실패 영향을 한 줄로 분류하고, 크면 orchestrator를 호출해 필요한 단계와 생략할 단계를 이유와 함께 정한 뒤 정한 단계를 그 시점에 실제로 호출한다"이다. Claude Code 세션은 요청을 받으면 곧바로 첫 구현 단계로 들어가고 그 앞에 위험을 따지는 단계가 없어서, 스킬 설명문이나 orchestrator 지침을 통째로 넣어 주는 것만으로는 스킬을 스스로 고르지 않았다(측정 기록은 `docs/roadmap.md`). 환경 변수가 없는 Codex 서버는 `instructions`를 내보내지 않는다.
- `adaptations/orchestrator.json`은 생성된 orchestrator `SKILL.md` 맨 앞에 "Claude Code에서의 선택 결정" 절을 넣는다. 정해진 체인을 강제하지 않고, 첫 행동 전에 실패 영향과 필요한·생략하는 단계를 이유와 함께 적고 고른 단계를 실제로 호출하라고만 한다. 후보 스킬마다 고르는 조건을 적어 두었다. 접수 규칙이 orchestrator를 거치게 하는 이유는, "orchestrator 또는 전문 스킬"로 두면 세션이 이 절을 읽지 않고 전문 스킬 하나만 바로 부르기 때문이다.
- workflow·continuity SQLite 상태는 `${CLAUDE_PLUGIN_DATA}`에 저장한다. Codex 플러그인의 상태 디렉터리를 열지 않는다.
- `codex-token-usage-analyzer`는 Codex 세션 로그 전용이라 포함하지 않는다.

## 실행 보증 제한

실행 보증이 필요한 orchestrated workflow는 Claude Code에서 시작되지 않고 `BINDING_REQUIRED`를 반환한다. 서버에 신뢰할 수 있는 실행 관측값 제공자가 없고, Claude Code 훅은 추론 수준만 알려 주며 모델 정보는 주지 않기 때문이다. Codex 배포물의 서버도 같은 조건에서 같은 결과를 낸다. 전문 스킬 단독 호출과 실행 보증이 필요 없는 MCP 기능은 그대로 사용할 수 있다.

## 공용 원본과 Claude 전용 부분

- 공용: 루트 `skills/`, `runtime/`, `contracts/`, `mcp-server/dist/`를 그대로 복사한다. `skills/`는 각 스킬의 upstream 원본을 들여온 트리이고 Codex 플러그인이 그대로 설치하는 트리이므로, Claude 때문에 고치지 않는다.
- Claude 전용 파일: `claude-overlay/` 아래에 생성물과 같은 경로로 둔다. 공용 파일을 통째로 덮어쓰면 생성이 실패한다.
- Claude 전용 문구: 스킬마다 `claude-overlay/adaptations/<스킬명>.json` 한 파일에 모은다.
- 갱신 시점: 공용 원본이 바뀌어도 같은 변경에서 이 폴더를 다시 생성할 필요는 없다. CI는 `pnpm claude:drift`로 차이를 경고만 하고, 릴리스 준비나 Claude 쪽 작업에서 `pnpm claude:build`로 맞춘다. 생성이 실패하면 Codex 릴리스는 그대로 진행하고, Claude 배포물은 이전 버전으로 남는다.

## Claude용 보정

- `adaptations/<스킬명>.json`의 `description`: `SKILL.md` frontmatter의 `description` 필드를 통째로 바꾼다. Claude Code는 Codex의 `agents/openai.yaml` 암시 호출 정책을 읽지 않고 `description` 한 줄로만 스킬을 고르므로, 제외 조항보다 트리거 상황("커밋 전", "삭제·배포 직전", "같은 실패가 반복될 때" 등)을 앞세운다. 공용 description의 문구와 무관하게 적용되므로 원본 description이 바뀌어도 생성은 실패하지 않는다.
- `adaptations/<스킬명>.json`의 `replacements`: 호스트 중립 표현이 없는 문장만 스킬 폴더 기준 경로(`file`)와 정확히 한 번 나오는 원문(`find`)으로 바꾼다. 원문이 사라지거나 두 번 이상 나오면 해당 adaptation 파일 이름과 함께 생성이 실패한다.
- 배포하는 스킬을 Codex 방식으로 호출한 `$스킬명` 표기는 `/agent-governance-suite:스킬명`으로 자동 변환한다.
- 이 변환을 거친 뒤에도 생성된 `SKILL.md`, `references/*.md`, `agents/*.md`에 Codex 전용 표현(`fork_turns`, 배포하지 않는 스킬의 `$스킬명` 호출 등)이 남으면 생성이 실패한다. 두 호스트를 함께 설명하는 `coordinate-subagents` 문서는 예외다.
- `agents/independent-auditor.md`, `agents/deliberation-reviewer.md`: 부모 대화를 상속하지 않고, 파일 수정과 재위임을 막은 서브에이전트 정의다.
- `hooks/skill-trigger-hook.mjs`: Claude Code 전용 유도 훅이다. `UserPromptSubmit`에서 요청 문장을, `PreToolUse`(`Bash`)에서 실행할 명령을 정규식으로 보고 커밋·병합, 삭제·배포·마이그레이션, 반복 실패, 미정 사항이 남은 구현 요청에 해당하면 적용 가능한 스킬 이름을 `additionalContext`로 한 번 안내한다. 차단·승인 요구·상태 기록은 하지 않고 실패 시 조용히 종료한다. 설명문만으로는 짧은 자연어 요청에서 스킬이 거의 호출되지 않았기 때문에 둔 장치이며(측정 기록은 `docs/roadmap.md`), Codex 배포물의 `hooks/hooks.json`에는 없다.
- `instruction-scope-resolver`의 스크립트는 `AGENTS.md` chain만 계산한다. `CLAUDE.md` 계층은 `references/claude-code-instructions.md`에 따라 스킬이 따로 확인한다.
