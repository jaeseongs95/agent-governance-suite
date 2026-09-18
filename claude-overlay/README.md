# Agent Governance Suite for Claude Code

이 폴더는 `scripts/build-claude-plugin.mjs`가 생성한다. 직접 수정하지 말고 저장소 루트의 원본이나 `claude-overlay/`를 고친 뒤 `pnpm claude:build`를 실행한다.

## 설치

```text
/plugin marketplace add jaeseongs95/agent-governance-suite
/plugin install agent-governance-suite@agent-governance-claude
```

## Codex 배포물과의 격리

- 이 플러그인의 루트는 `claude-plugin/`이다. 저장소 루트의 Codex용 `hooks/hooks.json`, `.mcp.json`, `.codex-plugin/`은 읽지 않는다.
- MCP 서버에 `AGENT_GOVERNANCE_HOST_ATTESTATION=claude-code`를 넘겨 host attestation 토큰 검증을 켠다(아래 "실행 보증" 절).
- MCP 서버에 `AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE=anthropic`을 넘겨 `plan_workflow`의 공개 스키마에서 최상위 `oneOf`를 없앤다. Anthropic API가 이 형태를 받지 않기 때문이다. 입력 검증은 기존 계약 그대로다.
- 같은 환경 변수로 MCP 서버가 세션 `instructions`(접수 규칙)를 내보낸다. Claude Code는 이것을 세션 시작 때 시스템 프롬프트에 넣는다. 규칙은 "파일을 고치거나 명령을 실행하기 전에 이 요청의 실패 영향을 한 줄로 분류하고, 크면 orchestrator를 호출해 필요한 단계와 생략할 단계를 이유와 함께 정한 뒤 정한 단계를 그 시점에 실제로 호출한다"이다. Claude Code 세션은 요청을 받으면 곧바로 첫 구현 단계로 들어가고 그 앞에 위험을 따지는 단계가 없어서, 스킬 설명문이나 orchestrator 지침을 통째로 넣어 주는 것만으로는 스킬을 스스로 고르지 않았다(측정 기록은 `docs/roadmap.md`). 환경 변수가 없는 Codex 서버는 `instructions`를 내보내지 않는다.
- `adaptations/orchestrator.json`은 생성된 orchestrator `SKILL.md` 맨 앞에 "Claude Code에서의 선택 결정" 절을 넣는다. 정해진 체인을 강제하지 않고, 첫 행동 전에 실패 영향과 필요한·생략하는 단계를 이유와 함께 적고 고른 단계를 실제로 호출하라고만 한다. 후보 스킬마다 고르는 조건을 적어 두었다. 실행 방식도 함께 정한다. 실패 영향이 크고 고른 단계가 둘 이상이면 MCP orchestrated workflow로 계획·stage 기록·finalize를 진행해 순서와 감사 게이트를 MCP 원장이 강제하게 하고, MCP가 `BINDING_REQUIRED`·`BINDING_INVALID`를 반환하거나 도구를 쓸 수 없으면 이유를 밝히고 전문 스킬을 직접 호출한다. v1.17.0까지 이 절은 "Claude Code에서는 orchestrated 모드가 시작되지 않는다"고 안내해, host attestation을 추가한 뒤에도 세션이 MCP 경로를 쓰지 않았다. 접수 규칙이 orchestrator를 거치게 하는 이유는, "orchestrator 또는 전문 스킬"로 두면 세션이 이 절을 읽지 않고 전문 스킬 하나만 바로 부르기 때문이다.
- workflow·continuity SQLite 상태는 `${CLAUDE_PLUGIN_DATA}`에 저장한다. Codex 플러그인의 상태 디렉터리를 열지 않는다.
- `codex-token-usage-analyzer`는 Codex 세션 로그 전용이라 포함하지 않는다.

## 공개 도구 스키마

Claude Code는 MCP 도구 스키마의 `$ref`를 풀지 못한다. 외부 `$ref`로 정의된 `taskEnvelope`·`frame` 같은 필드는 객체가 아니라 문자열로 서버에 도착해, v1.17.0까지 `open_convergence_root`가 항상 `INVALID_INPUT`으로 거절됐다. `AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE=anthropic`이면 서버는 `$ref`가 있는 도구 스키마를 참조 없이 펼친 사본으로 내보낸다. 입력 검증은 원래 계약 그대로이고, 이 값이 없는 Codex 서버는 이전 스키마를 그대로 내보낸다.

## 큰 stage 출력

stage 결과는 provider 출력(`output.output`)을 `record_stage_result`로 넘겨 schema와 게이트 검사를 받는다. 저장소 크기에 비례하는 출력(`change-scope-guardian` baseline은 실제 저장소에서 972개 항목, 262KB였다)은 도구 인자로 넘기기 어려워, v1.18.0 세션은 orchestrated run을 닫고 direct로 전환했다. v1.19.0부터 `record_stage_result`는 `outputFile: { locator, digest }`를 받는다. 절대 경로의 JSON 파일(16 MiB 이하)을 읽어 SHA-256을 확인하고, 인라인 출력과 똑같이 검사한 뒤 receipt에는 참조만 남긴다. receipt 정책이 있는 stage는 다음 stage가 저장된 출력에서 actor를 비교하므로 인라인 출력만 받는다. orchestrator 지침(`adaptations/orchestrator.json`)의 "큰 stage 출력" 절이 이 방식을 안내한다.

## 실행 보증(host attestation)

실행 보증이 필요한 orchestrated workflow는 `hooks/host-attestation-hook.mjs`가 관측한 값으로 진행한다.

- Claude Code는 `plan_workflow`와 `record_stage_result`를 호출하기 직전에 이 훅을 실행한다. 훅 입력에는 모델 이름이 없지만 `tool_use_id`, `transcript_path`, 추론 수준(`effort.level`)이 있다.
- 훅은 transcript에서 그 `tool_use_id`를 낸 assistant 메시지를 찾아 `message.model`을 읽는다. 서브에이전트가 호출했으면 `<세션>/subagents/agent-<agent_id>.jsonl`을 읽고, actor를 서브에이전트로 기록한다. transcript에서는 그 메시지의 모델과 effort만 꺼내고 내용을 저장하지 않으며, 계획과 receipt에 남는 actor ID에는 session·agent ID의 SHA-256 digest만 쓴다. transcript는 호출보다 늦게 기록될 수 있어 최대 5초 동안 다시 읽는다.
- 추론 수준은 훅 입력의 `effort.level`과 transcript 메시지에 기록된 `effort`를 함께 본다. 둘 다 있고 다르면 낮은 쪽을 쓰고, 하나만 있거나 한쪽이 알 수 없는 값이면 다른 쪽을 쓰며, 둘 다 없으면 토큰을 만들지 않는다. 서브에이전트(`effort: low`로 정의)가 호출했을 때 훅 입력은 서브에이전트 값(`low`)을 줬고, 서버는 하한 미달로 `BINDING_INVALID`를 반환했다(v1.18.0 준비 중 실제 세션으로 확인).
- 모델 class는 `coordinate-subagents`의 Claude 라우팅 프리셋과 같게 haiku=`lightweight`, sonnet=`general`, opus=`deep`, fable=`frontier`로 정한다. Anthropic API ID(`claude-opus-5`, `claude-3-5-sonnet-20241022`), Bedrock ID(`us.`·`global.`·`us-gov.` 같은 지역 접두사를 포함한 `anthropic.claude-…`), Vertex ID(`claude-opus-5@…`)를 인식한다. 모델군을 알 수 없는 ID, 찾지 못한 메시지, 추론 수준이 없는 호출에는 토큰을 만들지 않는다.
- 토큰을 만들지 못하면 훅은 호출자가 도구 인자에 넣은 `_hostAttestation`을 지우고 넘긴다. launcher도 훅이 실패하거나 시간을 넘기거나 `CLAUDE_PLUGIN_DATA`가 없을 때 같은 처리를 한다. 따라서 모델이 도구 인자로 넣은 토큰은 서버에 닿지 않는다. 예외는 `node`를 실행하지 못하거나 Claude Code가 훅 timeout(10초)으로 launcher를 끝낸 경우다. 이때 Claude Code는 원래 입력으로 도구를 호출한다. 그 입력에 든 토큰은 같은 사용자 권한으로 서명 키를 읽어 만들었거나, 아래처럼 transcript에 남은 미소비 토큰을 옮긴 것이어야 한다.
- 토큰은 도구 이름, 도구 입력 digest, task·run·stage·revision, actor와 5분 유효기간(서버가 받는 관측값의 최대 나이)을 담고 `${CLAUDE_PLUGIN_DATA}/workflows.sqlite3`에 저장한 키로 HMAC 서명한다. 훅은 `permissionDecision` 없이 `updatedInput`만 돌려주므로 권한 확인 흐름은 그대로다. 토큰은 권한 확인보다 먼저 만들어지므로, 대화형 세션에서 도구 승인에 5분 넘게 걸리면 `BINDING_INVALID`가 되고 다시 호출하면 된다. Claude Code는 훅 출력을 transcript에 기록하므로 토큰도 transcript에 남는다. 남은 토큰은 입력이 완전히 같은 호출에 한 번만, 5분 안에만 쓸 수 있고, 훅이 정상 실행되는 호출에서는 새 토큰으로 덮어쓴다.
- 서버는 `plugin.json`이 넘기는 `AGENT_GOVERNANCE_HOST_ATTESTATION=claude-code`가 있을 때만 토큰을 검증한다. 입력이 바뀌었거나, 서명이 틀렸거나, 만료됐거나, 이미 쓴 토큰이면 `BINDING_INVALID`, 토큰이 없으면 `BINDING_REQUIRED`다. 관측한 모델·추론 수준이 계획의 하한보다 낮으면 기존처럼 `BINDING_INVALID`다.
- transcript를 남기지 않는 세션(`--no-session-persistence`)에서는 모델을 관측할 수 없어 `BINDING_REQUIRED`가 된다.
- 이 토큰이 보장하는 것은 "모델이 도구 인자로 주장한 값이 아니라 하네스가 기록한 값"까지다. 서명 키와 transcript는 같은 OS 사용자 권한으로 읽고 쓸 수 있으므로, 같은 사용자로 실행되는 프로세스의 위조는 막지 못한다. 통제 대상 모델 자신도 Bash 같은 도구로 그런 프로세스를 실행할 수 있다.

Codex 배포물은 이 훅을 등록하지 않고 환경 변수도 넘기지 않으므로 이전처럼 `BINDING_REQUIRED`를 반환한다. 전문 스킬 단독 호출과 실행 보증이 필요 없는 MCP 기능은 두 배포물 모두 그대로 사용할 수 있다.

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
