# Agent Governance Suite v1.7.0

`v1.7.0`은 공급망 업데이트 확인과 확인 기반 SQLite 상태 정리를 자동화하는 minor 릴리스다.

## 변경 사항

- source lock v2로 원본 commit, upstream checksum과 통합본 checksum을 함께 고정한다.
- 고정 원본의 새 안정 tag를 확인하고 draft update PR을 준비하는 workflow를 추가한다.
- 플러그인 업데이트 확인을 24시간 캐시하고 실패 시 1시간 뒤 재시도하며, 버전당 안내를 한 번만 claim한다.
- `prepare_state_cleanup`과 `execute_state_cleanup`으로 삭제 후보·정책·DB fingerprint에 결속된 확인 기반 정리를 제공한다.
- workflow와 continuity DB를 각각 백업하고 무결성을 확인한 뒤 대상별 transaction으로 정리한다.

## 호환성과 복구

이 릴리스는 workflow SQLite schema를 v3에서 v4로, continuity SQLite schema를 v1에서 v2로 자동 migration한다. 업그레이드 전 MCP 서버를 중지하고 두 DB를 `VACUUM INTO`처럼 WAL까지 반영하는 방식으로 각각 백업해야 한다.

`v1.6.0`으로 롤백하려면 새 MCP를 중지하고 migration 전 backup을 복원한 다음 marketplace ref와 설치 버전을 `v1.6.0`으로 되돌려 이전 MCP가 기존 상태를 여는지 확인한다. 새 schema DB를 둔 채 이전 MCP만 다시 설치하는 것은 롤백이 아니다.
