# Agent Governance Suite v1.9.0

`v1.9.0`은 `korean-prose-editor`에 읽기 전용 SQLite 용어집과 MCP 조회 경로를 추가하는 minor 릴리스다. Provider는 이 버전에서 계속 비활성이다.

## 변경 사항

- 검토 가능한 `glossary.seed.jsonl`과 배포용 `korean-prose-glossary.sqlite3`를 추가한다.
- `lookup_korean_prose_terms`가 source digest를 다시 계산하고 UTF-16 범위와 정책을 반환한다.
- MCP 경로에서 원문당 한 번만 조회한 match set을 selection, editing, verification에 공유한다.
- `protect` 항목만 보호 구간에 합치며 `prefer`, `avoid`, `allow`는 편집 판단의 보조 근거로 사용한다.
- 용어집 장애·한도 초과·비-NFC 입력은 부분 결과 없이 고정 상태와 warning으로 기록한다.
- finalizer가 역할별 glossary binding과 보호 manifest의 digest 불일치를 거부한다.

## 품질 상태와 제한

- 초기 용어집은 소규모 검증 데이터이며 일반 국어사전이 아니다.
- direct mode에서는 SQLite를 읽지 않는다.
- 품질 게이트와 별도 활성화 승인이 남아 있으므로 registry, 직접 descriptor와 implicit invocation은 비활성 상태다.

## 호환성과 복구

workflow와 continuity SQLite schema는 `v1.8.0`과 같다. 용어집 DB는 workflow 상태 DB와 분리된 읽기 전용 배포 자산이다. 문제가 생기면 marketplace ref와 설치 버전을 `v1.8.0`으로 복원한다.
