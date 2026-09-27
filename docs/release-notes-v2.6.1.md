# v2.6.1: Codex queue wake 설정 배포

공개 main에 반영된 Codex 플러그인 전용 queue wake 설정을 2.6.1 배포 버전으로 구분합니다. 공식 버전 원본, 플러그인 manifest, marketplace ref, MCP가 알리는 버전과 생성 번들을 동기화합니다. 이번 patch는 버전 metadata와 문서만 갱신하며 실행 로직, 공통 큐와 SQLite schema를 바꾸지 않습니다.

queue wake는 기본적으로 꺼져 있습니다. Codex hook이 제공한 절대 `PLUGIN_DATA` 아래 `session-messaging.json`의 `codex.queueWake`로 선택하며, 명시 ENV가 파일보다 우선합니다. 파일 읽기는 4096바이트로 제한하고 불량 설정이나 Windows의 드라이브 없는 root-relative 경로는 활성화하지 않습니다. Claude Code의 기존 inbox 경로는 유지합니다. 자세한 설정은 [입력 출처와 작업 경계](input-boundaries.md#codex-queue-wake-설정)를 따릅니다.

업데이트와 설정 변경 뒤에는 수신 세션의 새 `SessionStart`와 presence instance·transport를 확인해야 합니다. 기존 relay는 시작할 때 받은 transport를 유지합니다. peer 출처는 실행 권한을 만들지 않으며 nonce·TTL·generation·첫 경계 유예·불명확한 제출의 재전송 억제 규칙도 유지합니다.

버전 동기화와 설치 형태 회귀는 실제 설치 bytes나 자동 기상·본문 수신·ACK의 증거를 대신하지 않습니다. 설치·재연결 뒤 해당 경로를 별도로 관측합니다. 업데이트 때문에 사용자 DB·WAL·profile·키를 삭제하거나 schema를 마이그레이션할 필요는 없습니다.
