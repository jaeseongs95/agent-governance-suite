# Agent Governance Suite v1.4.2

`v1.4.2`는 `v1.4.1`의 Windows CI에서 드러난 경로 대소문자 비교 문제를 교정하는 후속 패치 릴리스다. 런타임 동작과 한국어 산문 provider의 비활성 상태는 바꾸지 않는다.

## 변경 사항

- workflow receipt의 기존 파일 덮어쓰기 거부 테스트가 Windows의 대소문자 비구분 임시 경로를 허용하도록 경로 문자열 비교를 정규화한다.
- `v1.4.1`에 포함된 structured receipt, selection binding과 immutable Korean prose source 상태를 그대로 유지한다.

## 품질 상태와 제한

- 기존 11-case gate는 실패 기록과 합격선을 보존한 채 `invalid-corpus`로 종결했다.
- 별도 recovery는 edit 5/8, restraint 4/4, major meaning change 0, protected failure 0으로 실패했다.
- 새 정식 frame과 신규 private holdout이 기존 기준을 통과하기 전까지 `korean-prose-editor`는 registry, 직접 descriptor, implicit invocation과 fail-closed 지침에서 비활성이다.

## 호환성과 복구

공개 MCP 도구와 SQLite schema는 바뀌지 않는다. 문제가 생기면 marketplace ref와 설치 버전을 `v1.4.0`으로 복원한다. `v1.4.1`은 Windows CI 실패가 확인된 릴리스이므로 복구 대상으로 사용하지 않는다.
