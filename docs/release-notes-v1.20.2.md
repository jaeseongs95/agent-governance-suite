# v1.20.2 — MCP 서버와 저장소 스크립트 정리

## 핵심 변경

- MCP 서버와 저장소 스크립트의 중복과 쓰지 않는 코드를 걷어냈습니다. 직접 작성한 소스가 순 736줄 줄었습니다(추가 953줄, 삭제 1,689줄). MCP 도구 이름·입출력 schema·오류 코드, SQLite 데이터 형식, hook 입출력, CLI 출력과 종료 코드는 바뀌지 않았습니다.
  - MCP 서버: compact/full 응답 모드 처리, SQLite 저장소의 오류 처리, workflow 서비스의 오류 결과 변환을 각각 한 곳으로 모았습니다. validator 표는 계약 schema 목록에서 만듭니다. 호출자가 없던 validator 메서드 3개와 생성자 옵션 1개를 지웠습니다.
  - continuity hook이 schema validator를 만들지 않도록 바꿔 번들에서 ajv가 빠졌습니다. 번들 크기가 약 414KB에서 90KB로 줄었고, hook 이벤트마다 계약 schema 전체를 컴파일하지 않습니다.
  - continuity, 상태 정리, 업데이트 확인: 트랜잭션, tombstone 기록, 정리 후보와 DB identity 계산, GitHub 요청 헤더를 각각 한 곳에서 처리합니다.
  - 한국어 산문 평가 CLI: 기록 CLI와 검증 CLI가 readiness 모듈의 canonical JSON, JSONL 처리, 원문 유출 검사, 인자 해석, run 경로 계산을 함께 씁니다.
  - 저장소 도구: clean-room 실행, 기본 provider, 스킬 허용 목록 복사, README 버전 갱신, 업스트림 업데이트 보고를 각각 한 곳에서 처리합니다.

## 호환성

- MCP 서버 instructions와 `tools/list`는 기본 profile과 anthropic profile 모두 v1.20.1과 같습니다. SQLite DDL과 schema version, `contracts/`와 스킬은 바뀌지 않았습니다.
- TS 모듈을 직접 불러 쓰는 코드에서는 다음 API가 없어졌습니다. `WorkflowService` 생성자의 6번째 인자 `readStageOutputFile`, `ContractValidator`의 `taskEnvelope`·`convergenceReview`·`apiResult`, `ContinuityGateway.available`, `PluginUpdateService`의 `successTtlMs`·`failureRetryMs` 옵션입니다. 저장소 안에는 사용처가 없으며 MCP·hook·CLI 동작과는 관계가 없습니다.
- 한국어 산문 평가 toolchain digest가 바뀝니다. 이전에 동결한 frame은 동결 당시 toolchain으로만 재검증할 수 있습니다.

## 알려진 제한

- continuity hook은 validator 없이 `ContinuityService`를 만듭니다. hook은 validator가 필요한 도구 메서드를 부르지 않지만, 이 제약은 타입으로 강제되지 않습니다.
- 대화형 Claude Code 세션에서는 실측하지 않았습니다. `runtime:check`의 clean-room 검사에 포함된 대화형 실행 보증 경로는 통과했습니다.

## 검증

- 리팩터링 후보 `91160f2`에서 `pnpm install --frozen-lockfile`, `bundle:check`, `claude:drift`, `lint`, `build`, `test`(353건 통과), `runtime:check`, `validate:all`, `validate:official`, `claude:check`, `git diff --check`가 모두 종료 코드 0이었습니다. `tests/`는 바꾸지 않았습니다.
- MCP 표면 비교: 기본, anthropic, anthropic과 실행 보증을 함께 켠 설정에서 `initialize`와 `tools/list` 응답이 기준 commit `cc5c08f`와 바이트 단위로 같았습니다.
- SQLite DDL과 schema version 추출 결과가 기준 commit과 같았습니다.
- 변경 범위 검사 PASS(31개 파일, 범위 밖 0건), 수용 기준 7건 충족, 구현자와 분리된 fresh 독립 감사 PASS(차단성 발견사항 없음).
