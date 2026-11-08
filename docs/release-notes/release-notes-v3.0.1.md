# AGS 3.0.1 릴리스 노트

3.0.1은 3.0.0의 핫픽스다. 계약·DB 스키마·도구 목록은 바뀌지 않았다. 3.0.0을 쓰는 호스트는 3.0.1로 바꾸고 AGS 프로세스를 다시 시작한다.

## 고친 결함

### 3.0 이전에 만든 세션 세대가 relay를 잃으면 다시 연결되지 않음

- 증상: 3.0.0-rc.1 이하에서 시작한 Claude Code·Codex 세션은 3.0.0으로 바꾼 뒤 이전 relay가 끝나면 현황판에서 `unreachable`로 남았다. 다음 hook의 relay 복구가 `RELAY_RECOVERY_PARENT_UNREPORTED`로 매번 거부됐고, 새 SessionStart(`/compact`·재시작) 전까지 메시지를 받거나 깨어날 수 없었다.
- 원인: 3.0 이전 SessionStart가 만든 세대에는 호스트 프로세스 보고(`host_pid`)가 없다. hook은 보고된 호스트가 없는 세대의 relay 복구를 모두 거부했다.
- 수정: 보고된 호스트가 없고 살아 있는 relay도 없는 세대는 다음 hook이 자기 호스트 pid로 `grant-relay`를 요청해 넘겨받는다. 저장소는 `host_pid`가 비어 있을 때만 이를 기록하므로, 다른 프로세스가 같은 세대를 다시 요청하면 `HOST_MISMATCH`로 거부된다. 넘겨받은 relay는 첫 tick에서 호스트 시작 시각을 결속한다.
- 유지한 거부: 다른 코드로 살아 있는 relay를 바꾸는 요청(`replace`)은 계속 `RELAY_RECOVERY_PARENT_UNREPORTED`로 거부한다. 보고된 호스트와 hook의 호스트가 다르면 `RELAY_RECOVERY_PARENT_MISMATCH`다.
- 남은 제약: 같은 세션을 3.0 이전 프로세스 둘이 동시에 이어 쓰고 있으면 먼저 hook을 실행한 쪽이 세대를 넘겨받는다. 업그레이드 때 한 번만 생기는 경우다.

## 검증

- Linux 시험 서버(Node 24.22.1)에서 바뀐 시험 파일 2개와 전체 시험(`node scripts/run-tests.mjs --maxWorkers=1`)을 실행했다.
- CI(ubuntu·windows, Node 24)를 실행했다.
