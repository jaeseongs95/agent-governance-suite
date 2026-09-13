# SQLite 상태 보존과 정리

상태 정리는 자동으로 실행되지 않는다. `prepare_state_cleanup`은 현재 후보를 읽기만 하고 15분 동안 유효한 HMAC 서명 token을 반환한다. 사용자가 그 미리보기를 확인한 뒤 같은 실행 중 `execute_state_cleanup`에 token을 전달해야 삭제가 시작된다. token은 데이터베이스 경로와 schema version, 정책, cutoff, 정확한 후보 ID·revision·timestamp·digest에 결속되고 한 번만 사용할 수 있다.

고정 보존 정책은 다음과 같다.

- workflow의 terminal run과 `completed`/`abandoned` convergence root: 180일
- `active`가 아닌 continuity snapshot payload: 30일 뒤 hash tombstone으로 치환
- `active`가 아닌 continuity task와 request/tombstone/observation metadata: 180일 뒤 전체 삭제
- active workflow root, 그 root에 연결된 run, active continuity snapshot/task: 삭제하지 않음
- workflow metadata, run sequence, plugin update state, cleanup claim과 signing key: 삭제하지 않음

terminal convergence root와 연결된 run은 하나의 단위로 계산하고 삭제한다. 실행 직전에 후보를 다시 계산하며 하나라도 바뀌면 stale token으로 거절한다. continuity 삭제 transaction 안에서는 snapshot 상태·root 연결과 task의 모든 자식 레코드 시각을 다시 확인하며, 연결된 workflow root가 활성화되지 못하도록 workflow write lock을 함께 유지한다. 삭제할 데이터베이스마다 먼저 같은 상태 디렉터리의 `backups/` 아래에 `VACUUM INTO` snapshot을 만들고 그 snapshot의 `PRAGMA integrity_check`가 `ok`인지 확인한다. 데이터베이스별 삭제는 독립된 transaction이다. 한 데이터베이스가 실패해도 이미 완료된 다른 데이터베이스 결과와 각 backup 경로를 receipt에 남긴다.

backup은 자동 삭제하지 않으며 운영자가 복구 요구가 끝난 뒤 직접 지워야 한다. 애플리케이션 수준 암호화는 제공하지 않는다. Unix 계열에서는 상태 디렉터리와 파일을 사용자 전용 mode로 제한한다. Windows receipt의 `os-managed-unverified`는 NTFS 계정 권한과 BitLocker 같은 OS 보호를 사용해야 하지만 MCP가 그 활성 상태를 검증하지 않았다는 뜻이다.

복구할 때는 MCP 서버를 중지하고 현재 DB 파일을 별도 보관한 뒤 receipt에 기록된 backup을 원래 경로로 복사한다. 재시작 후 `PRAGMA integrity_check`, workflow 조회와 continuity 조회로 복구를 확인한다.
