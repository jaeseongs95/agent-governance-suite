# v2.5.0: Claude 세션 메시지 wake 큐 수정

Claude Code inbox adapter가 세션 메시지 wake를 `priority: "next"`로 보냅니다. 기존 `now` 전송을 제거해 진행 중인 호스트 작업을 중단시키는 전달 경로를 피합니다. wake에는 nonce만 넣고, 본문은 기존 TLS broker의 SQLite 큐에서 소비합니다.

## 보존하는 계약

- broker·SQLite schema·claim lease·ACK·TTL과 Codex의 기존 전달 방식을 유지합니다. 별도 메시지 큐나 전역 설정을 추가하지 않습니다.
- 도구 완료 경계와 turn-end에서 기존 hook이 peer를 소비합니다. 중복 wake를 막고, ACK 이후에는 같은 메시지로 다시 깨우지 않습니다.
- 연결 후 결과가 불확실하면 기존 `accepted-or-unknown`과 nonce 보존 정책을 유지합니다. `now`로 재시도하지 않습니다.
- peer 본문은 비신뢰 context이며 사용자 승인이나 실행 권한을 만들지 않습니다. socket write 성공은 peer 소비 또는 ACK 증거가 아닙니다.

## 검증 범위

격리 IPC 검사는 실제 adapter가 auth frame과 `next` wake frame을 보내는지 확인합니다. 기존 `now` 구현에서는 이 검사가 실패합니다. 필요한 inbox 환경값의 부재, 재시작 후 안전시점 소비, 중복 wake와 ACK 이후 재깨움 방지도 검사합니다. 합성 IPC와 SQLite 회귀는 실제 호스트의 도구 비중단 동작과 구분합니다.

호스트 정적 조사 대상은 Claude Code 2.1.283입니다. 다른 버전의 지원을 이 결과에서 추정하지 않으며, 지원이 확인되지 않은 경우 interrupt 방식으로 fallback하지 않습니다. 실제 사용 중인 호스트와 설치물은 릴리스·설치 검증에서 별도로 확인합니다.

## 설치와 복구

업데이트는 기존 사용자 상태 DB를 삭제하거나 마이그레이션하지 않습니다. 복구가 필요하면 marketplace ref와 플러그인 설치를 `v2.4.0`으로 되돌린 뒤 호스트를 재시작합니다. 이전 설치와 사용자 데이터를 보존한 상태에서 수행합니다.
