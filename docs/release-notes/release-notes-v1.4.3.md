# Agent Governance Suite v1.4.3

`v1.4.3`은 Windows CI가 같은 임시 경로를 긴 이름과 8.3 별칭으로 다르게 표현하는 경우에도 workflow receipt의 비덮어쓰기 계약을 검증하도록 테스트를 바로잡는 패치 릴리스다. 런타임 동작과 한국어 산문 provider의 비활성 상태는 바꾸지 않는다.

## 변경 사항

- 기존 파일을 발견한 기록기가 비정상 종료하고 `refusing to overwrite` 오류와 대상 파일명을 보고하는지 확인한다.
- 실패한 재실행 뒤 기존 `workflow-receipt.json` 내용이 바뀌지 않았는지 직접 비교한다.
- `v1.4.1`의 structured receipt, selection binding과 immutable Korean prose source 상태를 유지한다.

## 품질 상태와 제한

- 기존 11-case gate는 실패 기록과 합격선을 보존한 채 `invalid-corpus`로 종결했다.
- 별도 recovery는 edit 5/8, restraint 4/4, major meaning change 0, protected failure 0으로 실패했다.
- 새 정식 frame과 신규 private holdout이 기존 기준을 통과하기 전까지 `korean-prose-editor`는 registry, 직접 descriptor, implicit invocation과 fail-closed 지침에서 비활성이다.

## 호환성과 복구

공개 MCP 도구와 SQLite schema는 바뀌지 않는다. 문제가 생기면 marketplace ref와 설치 버전을 `v1.4.0`으로 복원한다. Windows CI 실패가 확인된 `v1.4.1`과 `v1.4.2`는 복구 대상으로 사용하지 않는다.
