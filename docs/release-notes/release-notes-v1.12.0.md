# Agent Governance Suite v1.12.0

`v1.12.0`은 한국어 산문 워크플로의 SQLite 용어집을 공식 한국어 기술 용어로 확장하는 minor 릴리스다.

## 변경 사항

- GitHub 한국어 용어집에서 검토한 199개 용어와 `완료 영수증`을 `완료 결과`로 안내하는 항목을 추가했다.
- 용어집은 243개 entry와 248개 form을 포함하며, 다의적인 단일어는 산문 편집을 과도하게 고정하지 않도록 `allow` 정책으로 분류했다.
- 용어집 데이터 버전을 `1.2.0`으로 올리고 MCP binding, edit, verification, finalization 계약과 배포 SQLite DB를 함께 갱신했다.
- `korean-prose-editor`는 registry, 직접 descriptor, Codex implicit invocation에서 계속 활성 상태다. 엄격한 신규 holdout의 최종 `≥80%` 품질 지표는 아직 생성되지 않았으므로 이 릴리스도 해당 품질 기준 통과를 주장하지 않는다.

## 호환성과 제한

- 워크플로와 continuity SQLite schema는 `v1.11.0`과 같다.
- `korean-prose-editor`의 MCP 호출자는 용어집 binding version `1.2.0`을 사용해야 한다. 이전 binding을 재사용하면 fail-closed로 처리된다.
- 문제가 생기면 marketplace ref와 설치 버전을 `v1.11.0`으로 되돌리고 새 Codex 세션을 시작한다.
