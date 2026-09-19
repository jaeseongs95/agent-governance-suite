# v1.20.1 — Claude Code 대화형 세션의 실행 보증 수정

## 핵심 변경

- Claude Code 대화형 세션에서 `plan_workflow`·`record_stage_result`가 약 7초 뒤 항상 `BINDING_REQUIRED`로 거절되던 결함을 고쳤습니다. 이 때문에 대화형 세션에서는 orchestrated workflow를 시작할 수 없었습니다. 영향 범위는 v1.17.0부터 v1.20.0까지입니다.
  - 원인: 실행 보증 훅은 도구를 호출한 assistant 메시지를 transcript에서 찾아 모델을 읽습니다. 헤드리스(`claude -p`)는 이 메시지를 훅보다 먼저 기록하지만, 대화형 세션은 호출이 끝난 뒤에 기록합니다. 실측에서는 메시지 생성 시각 24.6초, 거절 시각 31.46초, 파일에 처음 나타난 시각 31.61초였습니다. Claude Code 문서도 transcript는 비동기로 기록된다고 밝힙니다. v1.17.0 이후의 검증은 모두 헤드리스였기 때문에 이 결함을 찾지 못했습니다.
  - 수정: 호출 메시지가 아직 없으면 두 출처 가운데 더 늦은 쪽의 모델로 증명합니다. 하나는 같은 세션·에이전트가 이미 기록한 가장 최근 assistant 메시지이고, 다른 하나는 같은 훅이 `SessionStart`의 `model`과 `PostModelSwitch`의 `to_model`에서 기록해 둔 메인 스레드의 현재 모델(`${CLAUDE_PLUGIN_DATA}/host-models/<session digest>.json`)입니다. Claude 배포물의 `hooks.json`에 두 이벤트를 등록했습니다.
  - 이 경로에서는 추론 수준을 훅 입력의 `effort.level`에서만 가져옵니다. 이전 메시지의 effort는 다른 모델의 값일 수 있기 때문입니다. 이전 메시지는 `sessionId`가 일치하고 과거 시각이 적힌 것만 씁니다. 호출 메시지가 있는데 다른 세션·sidechain이거나 모델이 없어 거부되면 이 경로를 쓰지 않습니다.
  - 서브에이전트에는 세션 시작·모델 전환 훅이 오지 않으므로, 자기 transcript에 이미 기록된 메시지만 씁니다.
  - transcript 대기 시간을 5초에서 0.3초로 줄였습니다.

## 호환성

- 서버의 토큰 계약, `contracts/` schema, MCP 도구, Codex 배포물(`hooks/`, `.codex-plugin/`, `.mcp.json`)은 바뀌지 않았습니다. 이 훅은 Claude 배포물에만 등록되며, Codex는 이전과 같이 `BINDING_REQUIRED`를 반환합니다.
- 헤드리스 세션은 이전과 같이 호출 메시지로 증명합니다.

## 알려진 제한

- 대체 경로의 보증은 "호출한 메시지의 모델"이 아니라 "하네스가 기록한 이 세션의 현재 모델"입니다. 전환 기록이 빠지면(훅 실패·시간 초과, 기록 쓰기 실패) 이전 모델로 증명됩니다.
- 실측한 것은 대화형 `SessionStart`(startup)와 `/model` 전환뿐입니다. resume·clear·fork 때의 `SessionStart`, `--resume --model`, 자동 fallback 전환은 관측하지 않았습니다.
- 대화형 세션의 서브에이전트가 첫 메시지로 바로 strict 도구를 부르면 여전히 `BINDING_REQUIRED`입니다.
- 호출 전에는 알 수 없는 `tool_use_id`가 더 이상 필요하지 않으므로, 같은 OS 사용자 권한으로 transcript에 줄을 덧붙이거나 기록 파일을 쓰면 이전보다 쉽게 모델을 위조할 수 있습니다. 문서화된 위협 모델(같은 사용자 권한 프로세스의 위조는 막지 못함)의 범위 안입니다.

## 검증

- 전체 검증: `pnpm install --frozen-lockfile`, `bundle:check`, `claude:drift`, `lint`, `build`, `test`(353건 통과), `runtime:check`(대화형 경로 clean-room 검사 추가), `validate:all`, `validate:official`, `claude:check`, `git diff --check`가 모두 종료 코드 0입니다.
- 사전 관측: 훅 입력만 기록하는 플러그인을 대화형 세션에 적재해 확인했습니다. `SessionStart`(startup)가 `model`을 넘기고, `/model` 전환 뒤 `PostModelSwitch`가 적용된 모델을 넘깁니다. `PreModelSwitch`는 적용되지 않은 요청에도 옵니다. Haiku에서는 PreToolUse 입력에 `effort`가 없고, `SubagentStart`에는 모델이 없습니다. 대화형 PreToolUse 4회 모두 호출 메시지가 transcript에 없었습니다.
- 대화형 실측(`claude --setting-sources project --plugin-dir <후보 claude-plugin>`, 사용자가 실행): Opus 5에서 `plan_workflow`가 1.5초 만에 통과했습니다(`claude-opus-5`, `deep`, `high`). `/model`로 Sonnet 5로 바꾼 뒤에는 Sonnet으로 증명돼 계획 하한 미달로 `BINDING_INVALID`가 반환됐습니다. 수정 전에는 약 7초 뒤 `BINDING_REQUIRED`였습니다.
- 헤드리스 E2E(`claude-opus-5`, 후보 빌드, 저장소 복제본): `plan_workflow`와 `record_stage_result` 4건이 모두 증명을 통과했습니다. 실행기 턴 한도(60)에 걸려 마지막 감사 stage와 finalize까지는 진행하지 않았습니다.
- 독립 감사: 첫 감사는 FAIL이었습니다. 대체 경로가 이전 메시지의 effort를 써서 effort를 지원하지 않는 모델의 호출이 다른 모델의 값으로 증명될 수 있었습니다. 수정 뒤 재감사는 PASS였습니다.
