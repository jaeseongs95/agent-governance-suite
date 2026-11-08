# v1.18.0 — Claude Code의 orchestrated workflow 경로 복구

## 핵심 변경

- Claude Code에서 MCP orchestrated workflow의 계획부터 finalize까지의 경로가 동작합니다(작은 stage 출력으로 확인). v1.17.0은 실행 보증 관측값을 붙였지만, 두 가지가 더 막고 있었습니다. 저장소 크기에 비례하는 stage 출력은 아직 도구 인자로 넘기기 어렵습니다(알려진 제한 참고).
  - Claude용 orchestrator 지침이 "Claude Code에서는 orchestrated 모드가 시작되지 않는다"고 안내해, 세션이 MCP 경로를 쓰지 않았습니다.
  - Claude Code는 MCP 도구 스키마의 `$ref`를 풀지 못해, 외부 `$ref`로 정의된 `taskEnvelope`·`frame` 필드를 문자열로 보냈습니다. 그래서 `open_convergence_root`가 항상 `INVALID_INPUT`으로 거절됐습니다.
- Claude 배포물의 서버(`AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE=anthropic`)는 `$ref`가 있는 도구 스키마를 참조 없이 펼친 사본으로 내보냅니다. 입력 검증은 원래 계약 그대로입니다. 펼친 스키마와 원래 계약이 같은 입력을 받고 거절하는지 테스트로 확인합니다.
- Claude용 orchestrator 지침(`claude-overlay/adaptations/orchestrator.json`)이 실행 방식을 함께 정합니다. 실패 영향이 크고 고른 단계가 둘 이상이면 MCP orchestrated workflow로 순서와 감사 게이트를 MCP 원장이 강제하게 하고, `BINDING_REQUIRED`·`BINDING_INVALID`가 나오거나 도구를 쓸 수 없으면 이유를 밝히고 전문 스킬을 직접 호출합니다. 서브에이전트에 맡긴 stage를 메인 세션이 기록하면 메인 세션의 관측값이 결속된다는 점도 안내합니다.
- host attestation 보완:
  - 추론 수준은 훅 입력과 transcript 메시지의 값 중 낮은 쪽을 씁니다. 한쪽이 알 수 없는 값이면 다른 쪽을 쓰고, 둘 다 없으면 토큰을 만들지 않습니다.
  - Bedrock(`us.`·`global.`·`us-gov.` 접두사를 포함한 `anthropic.claude-…`), Vertex(`claude-…@버전`), 이전 형식(`claude-3-5-sonnet-…`) 모델 ID를 인식합니다.
  - 토큰 유효기간을 서버가 받는 관측값의 최대 나이인 5분으로 늘렸습니다(이전 2분). 권한 승인 대기로 토큰이 만료되는 일이 줄어듭니다.
- `mutation-risk-preflight`를 원본 `v1.0.1`로 올렸습니다. 여러 대상이 같은 근거 파일을 쓰거나 backup과 복구 절차가 같은 파일일 때, 평가기가 자기 schema(`uniqueItems`)를 어기는 보고서를 만들고 receipt 검증이 그 보고서를 거부하던 결함을 고쳤습니다.
- Windows CI에서 제한 시간 부근을 오가던 `stdio-integration` 격리 트리 테스트의 제한을 15초에서 60초로 늘렸습니다.

## 검증

- 전체 검증(AGENTS.md 순서)과 `pnpm claude:check`, `pnpm source:verify`.
- 빌드한 Claude 배포물로 transcript를 남기는 새 Claude Code 세션(`claude-sonnet-5`, effort `high`)에서 `plan_workflow` → `open_convergence_root` → `claim_workflow_attempt` → `start_guarded_workflow` → `record_stage_result` → `finalize_workflow`가 모두 통과하고 run이 `passed`로 끝나는 것을 확인했습니다. stage 결과에는 그 stage와 revision에 결속된 관측값이 기록됐습니다.
- 같은 세션에서 서브에이전트(`effort: high`)가 부른 `plan_workflow`는 서브에이전트 actor로 관측돼 통과했습니다. 스키마 수정 전 실행에서는 `effort: low`로 정의한 서브에이전트의 훅 입력에 `low`가 들어왔고, 하한 미달로 `BINDING_INVALID`였습니다.
- 스키마 수정 전 빌드로는 같은 흐름이 `open_convergence_root`에서 `INVALID_INPUT`("must be object")으로 멈췄습니다.
- 실제 고위험 요청(CI 변경 후 병합·push)을 새 세션(`claude-fable-5-1`)에 한 번 주었을 때, 세션은 orchestrator 지침에 따라 `orchestrated`를 골라 계획·root·claim·start까지 진행했습니다. 첫 stage(`change-scope-guardian` baseline)의 결과를 기록하려면 972개 항목(262KB)의 baseline 전체를 도구 인자에 넣어야 했고, 세션은 항목을 줄이거나 기록을 우회하지 않고 `abort_workflow`로 run을 닫은 뒤 `direct`로 전환했습니다. 이 한 번은 60턴 제한에 걸려 병합·push 전에 끝났습니다.

## 호환성

- Codex 배포물: 서버의 스키마 펼침과 host attestation은 Claude 배포물만 넘기는 환경 변수가 있을 때만 켜지므로 동작이 바뀌지 않습니다. 공개 도구 스키마도 v1.17.0과 같습니다. 두 배포물이 함께 쓰는 `mutation-risk-preflight` 스킬의 결함 수정은 Codex에도 적용됩니다.
- 공개 계약 schema와 SQLite schema는 v1.17.0과 같습니다.

## 알려진 제한

- 토큰이 보장하는 것은 "하네스가 기록한 값"까지이며, 같은 OS 사용자로 실행되는 프로세스의 위조는 막지 못합니다. 통제 대상 모델 자신도 Bash 같은 도구로 그런 프로세스를 실행할 수 있습니다.
- 서브에이전트에 맡긴 semantic stage를 메인 세션이 기록하면 메인 세션의 모델과 추론 수준이 결속됩니다.
- transcript를 남기지 않는 세션(`--no-session-persistence`)에서는 모델을 관측할 수 없어 `BINDING_REQUIRED`입니다.
- orchestrator가 고위험 요청에서 MCP 경로를 스스로 고르는지는 새 세션 1회로만 관찰했습니다. 통계적 측정이 아닙니다.
- stage 결과는 provider 출력 전체를 `record_stage_result` 인자로 넘겨야 합니다. 저장소 크기에 비례하는 출력(예: `change-scope-guardian` baseline)은 실제 저장소에서 도구 인자로 넘기기 어려워 세션이 `direct`로 전환합니다. 큰 출력을 파일 참조와 digest로 넘기는 계약은 다음 릴리스에서 다룹니다.
