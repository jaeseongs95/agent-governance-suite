# v1.19.0 — 큰 stage 출력의 파일 참조

## 핵심 변경

- `record_stage_result`가 선택 필드 `outputFile: { locator, digest }`를 받습니다. provider 출력(`output.output`)이 클 때 그 JSON을 로컬 파일에 두고 절대 경로와 SHA-256을 넘기면, 서버가 파일을 읽어 digest를 확인하고 인라인 출력과 똑같이 출력 schema, 상태 대응, 게이트, receipt 정책을 검사합니다. receipt에는 참조와 digest만 남고 `output.output`은 `null`입니다.
  - 절대 경로의 로컬 일반 파일(네트워크 경로 제외), 16 MiB 이하, JSON 객체만 받습니다. 크기와 종류는 연 파일에서 확인하고 읽는 양도 한도로 제한합니다. digest가 다르면 `INTEGRITY_FAILED`, 읽을 수 없거나 JSON 객체가 아니거나 상대 경로면 `INVALID_INPUT`입니다. `outputFile`과 인라인 `output.output`을 함께 보내면 `INVALID_INPUT`입니다.
  - Windows 도구가 붙이는 byte order mark는 무시합니다.
- receipt 정책이 있는 stage(한국어 산문, 평가 타당성)는 다음 stage가 저장된 출력에서 actor를 비교하므로 `outputFile`을 받지 않고 인라인 출력만 받습니다. 이 stage들의 출력은 참조 전용이라 크지 않습니다.
- 세 스킬의 결과 schema(`acceptance-evidence-validator`, `blocker-diagnostician`, `recovery-strategy-selector`)가 공용 envelope의 `schemaVersion`을 선언하지 않으면서 모르는 키를 금지해, 이 stage들은 어떤 입력으로도 기록할 수 없었습니다. `StageResult.v1`은 `output.schemaVersion`을 요구하므로, 서버는 provider schema가 이 필드를 선언하지 않을 때 그 필드만 빼고 provider schema를 검사합니다. 다른 모르는 키는 그대로 거절합니다. 두 배포물 모두에 적용되는 결함 수정입니다.
- Claude용 orchestrator 지침에 "큰 stage 출력" 절을 넣었습니다. 저장소 크기에 비례하는 출력은 항목을 줄이거나 요약하지 않고 파일 참조로 넘깁니다.

## 배경

v1.18.0 준비 중 새 세션에 실제 고위험 요청을 주었을 때, 세션은 orchestrated 경로를 골랐지만 첫 stage(`change-scope-guardian` baseline, 972개 항목·262KB)의 결과를 도구 인자로 넘길 수 없어 run을 닫고 direct로 전환했습니다. 다음 stage는 이미 이전 stage의 산출물을 locator와 digest로 받고 있었고, 출력 전체가 필요한 곳은 기록 시점의 검사뿐이었습니다.

## 검증

- 전체 검증(AGENTS.md 순서, `pnpm source:verify` 포함).
- 실제 고위험 요청(CI 변경 후 로컬 `main` 병합)을 새 Claude Code 세션에 주었을 때, 세션은 orchestrated 경로에서 `change-scope-guardian` baseline(975개 항목, 263KB)을 `outputFile`로 기록해 통과했습니다. 같은 실행에서 3번째 stage(`acceptance-evidence-validator`)가 위의 envelope 충돌로 기록되지 않았고, 세션은 run을 닫고 direct로 전환해 작업을 끝냈습니다. 이 충돌을 고친 빌드로 같은 요청을 다시 주었을 때, 세션은 orchestrated 경로에서 baseline·범위 확인·수용 근거 stage를 `outputFile`로, 독립 감사 stage를 인라인으로 기록했고 `finalize_workflow`가 `passed`로 끝났습니다.

## 호환성

- 공용 계약 `StageResult.v1`에 선택 필드 하나가 추가됩니다. Codex 배포물이 보는 `record_stage_result` 도구 스키마에도 이 필드가 생기지만, 이 필드를 쓰지 않는 호출은 v1.18.0과 똑같이 처리됩니다. Codex용 orchestrator 지침(`skills/orchestrator`)은 바뀌지 않았습니다.
- SQLite schema는 바뀌지 않습니다. 파일 참조로 기록한 stage 결과는 receipt에 `outputFile`과 `output.output: null`로 저장됩니다.

## 알려진 제한

- 서버는 호출자가 지정한 로컬 파일을 같은 OS 사용자 권한으로 읽습니다. 파일 내용 전체를 응답이나 receipt에 싣지는 않지만, 파일 경로는 receipt에 남고, 오류 응답으로 파일이 있는지·한도를 넘는지·schema 검사에서 어느 필드가 틀렸는지(필드 이름과 일부 값)는 알 수 있습니다. digest가 다를 때 파일의 실제 digest는 돌려주지 않습니다.
- 파일 참조로 기록한 stage의 출력 내용은 receipt에 없으므로, 나중에 내용을 다시 보려면 그 파일이 남아 있어야 합니다. digest로 같은 파일인지 확인할 수 있습니다.
