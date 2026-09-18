# v1.17.0 — Claude Code host attestation

## 핵심 변경

- Claude Code 배포물에서 실행 보증이 필요한 orchestrated workflow가 시작됩니다. v1.16.2까지는 서버에 `TrustedExecutionContextProvider` 구현체가 없어 `plan_workflow`이 항상 `BINDING_REQUIRED`를 반환했습니다.
- Claude 전용 훅 `hooks/host-attestation-hook.mjs`를 추가했습니다. Claude Code는 `plan_workflow`와 `record_stage_result`를 호출하기 직전에 이 훅을 실행합니다. 훅은 PreToolUse 입력의 `tool_use_id`로 transcript에서 그 호출을 낸 assistant 메시지를 찾아 모델을 읽고, 추론 수준은 훅 입력의 `effort.level`에서 읽고, 없으면 transcript 메시지의 `effort`를 씁니다. 서브에이전트가 호출하면 서브에이전트 transcript를 읽습니다.
- 훅은 도구 이름, 도구 입력 digest, task·run·stage·revision, actor와 2분 유효기간을 담은 토큰을 HMAC으로 서명해 도구 입력의 `_hostAttestation`에 넣습니다. 서명 키는 Claude 배포물의 workflow DB(`${CLAUDE_PLUGIN_DATA}/workflows.sqlite3`)에 둡니다.
- 서버의 `HostAttestationProvider`가 토큰을 검증해 관측값을 넘기고, 기존 결속·유효기간·1회 소비 검사는 그대로 적용됩니다. 입력이 바뀌었거나, 서명이 틀렸거나, 만료됐거나, 이미 쓴 토큰이면 `BINDING_INVALID`입니다. 토큰이 없으면 `BINDING_REQUIRED`입니다.
- 모델 class는 Claude 라우팅 프리셋과 같게 haiku=`lightweight`, sonnet=`general`, opus=`deep`, fable=`frontier`로 정합니다. 목록에 없는 모델에는 토큰을 만들지 않습니다.
- 훅이 토큰을 만들지 못하면 호출자가 도구 인자에 넣은 `_hostAttestation`을 지웁니다. launcher도 훅 실패·시간 초과·`CLAUDE_PLUGIN_DATA` 없음에서 같은 처리를 하므로, 도구 인자로 넣은 토큰은 서버에 닿지 않습니다.
- 계획과 receipt에 남는 actor ID는 session·agent ID의 SHA-256 digest로 만듭니다. 훅은 transcript에서 해당 메시지의 모델과 effort만 꺼내고 내용을 저장하지 않습니다.

## 배경

Claude Code 세션에서 orchestrated MCP를 쓰려다 `BINDING_REQUIRED`로 막혔습니다. 이전 문서는 "Claude Code 훅은 추론 수준만 알려 주며 모델 정보는 주지 않는다"고 적었지만, 훅 입력의 `tool_use_id`와 `transcript_path`로 그 호출을 낸 메시지의 모델을 찾을 수 있었습니다. 모델이 도구 인자로 자기 실행 정보를 주장하는 방식은 서버가 계속 거부하고, Claude Code 하네스가 실행하는 훅이 관측한 값만 받도록 했습니다.

## 검증

- 단위·통합 테스트: MCP 경계에서 계획부터 stage 기록과 종료까지 완료, provider 없는 서버의 `BINDING_REQUIRED` 유지, 토큰 없음·입력 변경·서명 위조·다른 키·재사용·만료·하한 미달 거절, transcript 지연 재시도, 서브에이전트 transcript, 알 수 없는 모델·다른 세션·sidechain 메시지 거절, 관측 실패 시 호출자 토큰 제거(훅과 launcher).
- `node_modules` 없는 설치 트리에서 번들된 훅이 토큰을 만드는지 확인하는 clean-room 검사를 추가했습니다.
- 빌드한 Claude 배포물로 transcript를 남기는 새 Claude Code 세션(`claude-sonnet-5`, effort `high`)을 띄워 `plan_workflow`이 `bootstrapExecution`에 관측값(`claude-sonnet-5`, `general`, `high`)을 담아 통과하는 것을 확인했습니다. 훅이 시작될 때 transcript에는 아직 그 호출이 없었고, 재시도로 찾았습니다. `permissionDecision` 없이 돌려준 `updatedInput`도 적용됐습니다.

## 호환성

- Codex 배포물은 동작이 바뀌지 않습니다. 서버는 `AGENT_GOVERNANCE_HOST_ATTESTATION=claude-code`일 때만 provider를 켜고, 이 값은 Claude 배포물의 `plugin.json`만 넘깁니다. Codex의 `hooks/hooks.json`, `.mcp.json`, `skills/`는 바뀌지 않았고, Codex 설치물에는 쓰이지 않는 `mcp-server/dist/host-attestation-hook.mjs` 파일 하나가 추가됩니다.
- 공개 계약 schema와 SQLite schema는 v1.16.2와 같습니다. 서명 키는 기존 workflow metadata 테이블에 새 키 하나로 저장합니다.
- 스킬 구성과 용어집 데이터(1.2.1)는 v1.16.2와 같습니다.

## 알려진 제한

- 토큰이 보장하는 것은 "모델이 도구 인자로 주장한 값이 아니라 하네스가 기록한 값"까지입니다. 서명 키와 transcript는 같은 OS 사용자 권한으로 읽고 쓸 수 있으므로, 같은 사용자로 실행되는 프로세스의 위조는 막지 못합니다. 통제 대상 모델 자신도 Bash 같은 도구로 그런 프로세스를 실행할 수 있습니다.
- Claude Code는 훅 출력을 transcript에 기록하므로 토큰도 transcript에 남습니다. 남은 토큰은 입력이 완전히 같은 호출에 한 번만, 2분 안에만 쓸 수 있고, 그 호출에도 훅이 새 토큰으로 덮어씁니다.
- 토큰은 권한 확인보다 먼저 만들어집니다. 대화형 세션에서 도구 승인에 2분 넘게 걸리면 `BINDING_INVALID`가 되고, 다시 호출하면 됩니다.
- `claude-<모델군>-…` 형식이 아닌 모델 ID(Bedrock의 `us.anthropic.claude-…`, `claude-3-5-sonnet-…` 등)는 관측하지 않으므로 이전처럼 `BINDING_REQUIRED`입니다.
- 서브에이전트가 메인 세션과 다른 추론 수준으로 실행될 때 훅 입력의 `effort.level`이 서브에이전트 값을 주는지는 실제 세션으로 확인하지 않았습니다.
- transcript를 남기지 않는 세션(`--no-session-persistence`)에서는 모델을 관측할 수 없어 `BINDING_REQUIRED`입니다.
- 실제 Claude Code 세션으로 확인한 것은 `plan_workflow` 경로입니다. `record_stage_result`와 서브에이전트 경로는 테스트로만 확인했습니다.
- 훅은 transcript에서 호출 메시지를 찾을 때까지 최대 5초 기다리며, 그 시간은 도구 호출 지연에 더해집니다.
- Codex 호스트용 attestation adapter는 없습니다.
