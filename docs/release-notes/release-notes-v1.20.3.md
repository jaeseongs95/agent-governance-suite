# v1.20.3 — orchestrated 계획 지침과 artifact digest 표기 정리

## 핵심 변경

- Claude Code 오케스트레이터 지침: `orchestrated`를 고르면 작업 계약의 `orchestration`에 `{ "requested": true, "mcpAvailable": true }`를 적도록 했습니다. 서버는 `requested` 값으로 실행 방식을 정하는데 지침에 그 값이 없어서, 세션이 `false`를 적고 direct로 진행하는 경우가 있었습니다(v1.20.2 헤드리스 측정 10회 중 6회). Claude용 task-contract 필드 안내도 `orchestration.requested`를 "orchestrated로 실행하기로 한 결정"으로 설명합니다.
- 같은 지침에 "stage 기록" 절을 더했습니다. `record_stage_result` 전에 계획된 stage의 `requiredArtifacts`를 모두 검증된 artifact로 넣고, 실제로 만들지 않은 산출물은 `verified: true`로 적지 않으며 그 stage를 `passed`로 기록하지 않습니다.
- MCP 서버의 provider 결과 검증: provider schema마다 artifact `digest`·`targetDigest` 표기가 달랐습니다. `change-scope-guardian`, `instruction-scope-resolver`, `task-contract`는 접두사 없는 64자리 hex를, `acceptance-evidence-validator`, `mutation-risk-preflight` 등은 `sha256:` 접두사를 요구합니다. 이제 `sha256:` 접두사 유무만 다른 SHA-256 digest는 provider가 선언한 표기로 바꿔 검증하고, 저장은 호출자가 보낸 값 그대로 합니다. 64자리 소문자 hex 요구, 필수 artifact 검사(`MISSING_EVIDENCE`), `outputFile` digest 검사(`INTEGRITY_FAILED`)는 그대로입니다.

## 호환성

- MCP 도구 이름·입력 schema·오류 코드, SQLite 형식, `contracts/`와 `skills/`는 바뀌지 않았습니다.
- digest 검증 변경은 서버 공용 코드라 Codex에도 적용됩니다. 전에 거절하던 입력(접두사만 다른 digest)을 받아들이는 변경이며, 전에 받던 입력은 모두 그대로 받습니다.
- 지침 변경은 Claude Code 배포물(`claude-plugin/`)에만 들어갑니다. Codex가 쓰는 루트 `skills/`는 바뀌지 않았습니다.

## 알려진 제한

- `orchestration.requested` 값은 여전히 지침으로만 유도합니다. 서버에서 강제하면 받는 입력이 좁아지므로 이번 patch에서는 뺐습니다.
- digest 표기 완화는 `record_stage_result`의 provider 결과 검증에만 적용됩니다. `change-scope-guardian` 스크립트의 compare 요청은 스킬 자체 입력 schema로 검사하므로 `baselineArtifactDigest`에 여전히 접두사 없는 64자리 hex(`manifestSha256`)만 받습니다.
- MCP 원장은 감사 전의 `git commit`을 막지 않습니다.
- Codex에는 host attestation이 없어 orchestrated 계획이 `BINDING_REQUIRED`로 거절되고 direct로 진행합니다(변화 없음).
- 대화형 Claude Code 세션에서는 실측하지 않았습니다.

## 검증

- 릴리스 준비 트리에서 `bundle:check`, `claude:drift`, `lint`, `test`(358건 통과, 새 테스트 5건 포함), `runtime:check`, `validate:all`, `validate:official`, `claude:check`, `release:check`, `source:check`가 모두 종료 코드 0이었습니다. 새 digest 테스트 3건은 수정 전 코드에서 실패하고 수정 후 통과합니다.
- MCP 표면 비교: 기본, anthropic, anthropic과 실행 보증을 함께 켠 설정에서 `tools/list`와 서버 instructions가 v1.20.2와 같고 `serverInfo.version`만 다릅니다.
- 헤드리스 재측정(Opus 5, v1.20.2 A/B와 같은 CI 변경 요청, 5회):
  - 4회가 orchestrated로 진행했고, `plan_workflow` 호출 6번 모두 `requested: true`였습니다(v1.20.2는 10회 중 4회 진행, 6회는 `false`). 그중 2회는 `finalize_workflow`까지 마쳤습니다. 1회는 헤드리스 실행의 파일 쓰기 제한 때문에 첫 stage를 기록하기 전에 스스로 중단했고, 1회는 수용 근거 검증기가 `BLOCKED`를 내 그 결과를 기록한 채 끝났습니다.
  - stage 기록 거절은 1건이었습니다(v1.20.2는 orchestrated run 4개에서 15건). 접두사 차이에 따른 digest 거절과 필수 artifact 누락 거절은 0건이었습니다. 남은 1건은 `targetDigest`에 SHA-256이 아닌 git commit 값을 넣은 입력이라 거절하는 것이 맞습니다.
  - 목표였던 5회 모두 orchestrated 진행에는 못 미쳤습니다. direct로 진행한 1회는 실패 영향을 높게 분류하고도 "로컬에서 되돌릴 수 있다"는 이유로 direct를 골랐습니다. 이번 수정이 다루지 않는 유형이며, 사용자 결정에 따라 그대로 릴리스합니다.
