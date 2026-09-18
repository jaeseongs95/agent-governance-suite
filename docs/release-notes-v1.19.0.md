# v1.19.0 — 큰 stage 출력의 파일 참조

## 핵심 변경

- `record_stage_result`가 선택 필드 `outputFile: { locator, digest }`를 받습니다. provider 출력(`output.output`)이 클 때 그 JSON을 로컬 파일에 두고 절대 경로와 SHA-256을 넘기면, 서버가 파일을 읽어 digest를 확인하고 인라인 출력과 똑같이 출력 schema, 상태 대응, 게이트, receipt 정책을 검사합니다. receipt에는 참조와 digest만 남고 `output.output`은 `null`입니다.
  - 절대 경로의 일반 파일, 16 MiB 이하, JSON 객체만 받습니다. digest가 다르면 `INTEGRITY_FAILED`, 읽을 수 없거나 JSON 객체가 아니거나 상대 경로면 `INVALID_INPUT`입니다. `outputFile`과 인라인 `output.output`을 함께 보내면 `INVALID_INPUT`입니다.
  - Windows 도구가 붙이는 byte order mark는 무시합니다.
- Claude용 orchestrator 지침에 "큰 stage 출력" 절을 넣었습니다. 저장소 크기에 비례하는 출력은 항목을 줄이거나 요약하지 않고 파일 참조로 넘깁니다.

## 배경

v1.18.0 준비 중 새 세션에 실제 고위험 요청을 주었을 때, 세션은 orchestrated 경로를 골랐지만 첫 stage(`change-scope-guardian` baseline, 972개 항목·262KB)의 결과를 도구 인자로 넘길 수 없어 run을 닫고 direct로 전환했습니다. 다음 stage는 이미 이전 stage의 산출물을 locator와 digest로 받고 있었고, 출력 전체가 필요한 곳은 기록 시점의 검사뿐이었습니다.

## 호환성

- 공용 계약 `StageResult.v1`에 선택 필드 하나가 추가됩니다. Codex 배포물이 보는 `record_stage_result` 도구 스키마에도 이 필드가 생기지만, 이 필드를 쓰지 않는 호출은 v1.18.0과 똑같이 처리됩니다. Codex용 orchestrator 지침(`skills/orchestrator`)은 바뀌지 않았습니다.
- SQLite schema는 바뀌지 않습니다. 파일 참조로 기록한 stage 결과는 receipt에 `outputFile`과 `output.output: null`로 저장됩니다.

## 알려진 제한

- 서버는 호출자가 지정한 로컬 파일을 같은 OS 사용자 권한으로 읽습니다. 내용은 검사에만 쓰고 응답이나 receipt에 되돌려 싣지 않지만, 파일 경로는 receipt에 남습니다.
- 파일 참조로 기록한 stage의 출력 내용은 receipt에 없으므로, 나중에 내용을 다시 보려면 그 파일이 남아 있어야 합니다. digest로 같은 파일인지 확인할 수 있습니다.
