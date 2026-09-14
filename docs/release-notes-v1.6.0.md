# Agent Governance Suite v1.6.0

`v1.6.0`은 `korean-prose-editor`에 읽기 전용 SQLite 용어집과 MCP 조회 경로를 추가하고, 명시적 배포 승인에 따라 해당 workflow를 활성화하는 minor 릴리스다.

## 변경 사항

- 검토 가능한 JSONL 원본과 배포용 SQLite DB를 추가하고 논리적 content digest로 둘을 검증한다.
- `protect`, `prefer`, `avoid`, `allow` 정책을 가진 43개 entry와 48개 form을 제공한다.
- MCP 경로에서 원문당 한 번만 용어를 조회하고 동일한 glossary binding을 selection, editing, verification에 전달한다.
- direct mode에서는 SQLite에 접근하지 않으며, MCP 장애 시 `GLOSSARY_UNAVAILABLE`을 기록하고 기본 편집으로 계속한다.
- source digest, glossary digest, match-set digest와 보호 manifest가 일치하지 않으면 finalizer가 원문 전체로 복귀한다.
- registry, 직접 descriptor와 implicit invocation에서 `korean-prose-editor`를 활성화한다.

## 품질 상태와 제한

- 용어집 빌드·SQLite 조회·MCP 통합·저장소 회귀 검증은 통과했다.
- 독립 구조·의미 감사를 통과한 100-case corpus의 SQLite 조회는 100/100 일치했다.
- 실제 모델을 사용한 엄격한 holdout 평가는 direct editing의 최소 편집 범위 검증에서 중단돼 MCP arm과 최종 `≥80%` 지표를 생성하지 못했다. 이 릴리스는 해당 품질 임계값을 통과했다고 주장하지 않는다.
- 용어집은 어휘 근거만 제공하며 자동 치환이나 일반 국어사전 역할을 하지 않는다.

## 호환성과 복구

이 릴리스는 workflow SQLite schema를 v3에서 v4로, continuity SQLite schema를 v1에서 v2로 자동 migration한다. 기존 run, revision, run ID sequence, 계획 서명 키, 업데이트 상태, convergence guard 이력과 continuity snapshot은 회귀 테스트에서 보존됨을 확인했다.

업그레이드 전 MCP 서버를 중지하고 두 DB를 `VACUUM INTO`처럼 WAL까지 일관되게 반영하는 방식으로 각각 백업해야 한다. `v1.5.0`으로 롤백하려면 새 MCP를 중지하고, migration 전 backup을 별도 경로에서 복원한 다음 marketplace ref와 설치 버전을 `v1.5.0`으로 되돌려 이전 MCP가 기존 상태를 여는지 확인한다. 새 schema DB를 그대로 둔 채 이전 MCP만 재설치하는 것은 롤백이 아니다. 업그레이드 전에 DB가 없었다면 새 DB를 별도 보관하고 원래 상태 경로에서 제거한 뒤 이전 MCP를 시작한다. `v1.5.0`에서는 `korean-prose-editor`가 비활성 상태다.
