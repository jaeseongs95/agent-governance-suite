# 상태 저장과 정리

AGS가 이 컴퓨터에 남기는 상태 파일의 위치, 위치를 바꾸는 환경 변수, 오래된 상태를 지우는 방법과 복구 절차를 설명합니다.

## 저장 위치

| 데이터 | 파일 | 기본 위치 | 바꾸는 환경 변수 |
| --- | --- | --- | --- |
| workflow 상태와 계획 서명 키 | `workflows.sqlite3` | 호스트별 상태 폴더(아래) | `AGENT_GOVERNANCE_DB_PATH` |
| 작업 기록(상황 컨텍스트) | `continuity.sqlite3` | workflow DB와 같은 폴더 | `AGENT_GOVERNANCE_CONTINUITY_DB_PATH` |
| 세션 현황판 | `session-board.sqlite3` | 공유 상태 폴더 | `AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH` |
| 세션 메시지 | `session-messaging/` | 공유 상태 폴더 | `AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR` |
| 입력 출처 영수증 | `trust.sqlite3` | `session-messaging/` 안 | `AGENT_GOVERNANCE_TRUST_DB_PATH` |
| 전역·담당 컨텍스트, 관리자 서명 기록 | `context-layers.sqlite3` | 공유 상태 폴더 | `AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH` |
| 페이지에서 등록한 key의 데이터 키 | `jev-key-vault.bin` | `context-layers.sqlite3`와 같은 폴더 | (위 경로를 따름) |
| 표시 언어 설정 파일 | `settings.json` | 공유 상태 폴더 | (공유 상태 폴더를 따름) |
| 관리자 페이지를 연 프로세스의 포트·pid(4.0.0부터) | `admin-page.json` | 공유 상태 폴더 | (공유 상태 폴더를 따름) |
| 기계 ID가 없는 환경의 호스트 ID | `host-id` | 공유 상태 폴더 | (공유 상태 폴더를 따름) |

- **호스트별 상태 폴더:** Windows `%LOCALAPPDATA%\agent-governance-suite`, macOS `~/Library/Application Support/agent-governance-suite`, Linux `$XDG_STATE_HOME/agent-governance-suite`(기본 `~/.local/state/agent-governance-suite`). Claude Code 플러그인은 `${CLAUDE_PLUGIN_DATA}` 아래에 `workflows.sqlite3`와 `continuity.sqlite3`를 둡니다.
- **공유 상태 폴더:** 모든 호스트가 함께 쓰는 `~/.agent-governance-suite`입니다. 절대 경로인 `AGENT_GOVERNANCE_SHARED_STATE_DIR`로 바꿀 수 있습니다. 호스트가 workflow DB 위치를 바꿔도 공유 상태 폴더는 따라가지 않습니다.
- 샌드박스처럼 기본 경로가 달라지는 환경에서는 협업할 모든 호스트에 같은 절대 경로의 `AGENT_GOVERNANCE_SHARED_STATE_DIR`를 줍니다.
- 상태 폴더는 MCP 서버를 실행하는 사용자만 접근할 수 있도록 보호합니다. Unix 계열에서는 AGS가 상태 폴더와 파일을 사용자 전용 mode로 제한합니다.

## 무엇이 저장되나

- workflow DB에는 전체 `WorkflowReceipt`가 평문 JSON으로 들어갑니다. 각 단계 결과의 provider output, 근거 메모, findings, blockers, error가 포함됩니다.
- 작업 기록 DB에는 상황 컨텍스트 본문과 그 이전 내용이 평문 JSON으로 남습니다. 에이전트 API는 이전 내용을 보여 주지 않지만, 같은 OS 사용자의 파일 직접 접근은 막지 않습니다.
- 애플리케이션 수준 암호화는 하지 않습니다(페이지에서 등록한 key만 암호화합니다).
- 그러므로 비밀값, 개인정보, 원시 로그·코드를 작업 기록이나 단계 결과에 넣지 마십시오.

## 오래된 상태 정리

상태 정리는 자동으로 실행되지 않습니다. 보존 기간이 지났다는 이유만으로 지워지지도 않습니다.

1. `prepare_state_cleanup`이 지울 후보를 읽기만 하고 HMAC 서명 token을 돌려줍니다.
2. 사용자가 미리보기를 확인합니다.
3. 같은 token을 `execute_state_cleanup`에 넘겨야 삭제가 시작됩니다.

token에는 유효 시간이 없습니다. 확인을 기다리는 동안 후보가 바뀌면 digest 불일치로 거부됩니다. token은 데이터베이스 경로와 schema version, 정책, cutoff, 정확한 후보 ID·revision·timestamp·digest에 결속되고 한 번만 쓸 수 있습니다.

고정 보존 정책은 다음과 같습니다.

- workflow의 terminal run과 `completed`/`abandoned` convergence root: 180일
- `active`가 아닌 continuity snapshot payload: 30일 뒤 hash tombstone으로 치환
- `active`가 아닌 continuity task와 request/tombstone/observation metadata: 180일 뒤 전체 삭제
- active workflow root, 그 root에 연결된 run, active continuity snapshot/task: 삭제하지 않음
- 세션이 결속한 root 가운데 하나라도 active이면 그 continuity task와 snapshot: 삭제하지 않음(3.6.0). 한 세션은 root를 여러 개 결속하고 `root_id`는 가장 최근 root만 가리킵니다. 3.5.x는 이 대표 root만 보아서, 대표 root가 끝나면 다른 active root의 소유 기록(`workflow-root:<rootId>` 관측 행)까지 지울 수 있었습니다.
- workflow metadata, run sequence, plugin update state, cleanup claim과 signing key: 삭제하지 않음

terminal convergence root와 연결된 run은 하나의 단위로 계산하고 삭제합니다. 실행 직전에 후보를 다시 계산하며 하나라도 바뀌면 stale token으로 거절합니다. continuity 삭제 transaction 안에서는 snapshot 상태·root 연결과 task의 모든 자식 레코드 시각을 다시 확인하며, 연결된 workflow root가 활성화되지 못하도록 workflow write lock을 함께 유지합니다.

### 백업

삭제할 데이터베이스마다 먼저 같은 상태 폴더의 `backups/` 아래에 `VACUUM INTO` snapshot을 만들고, 그 snapshot의 `PRAGMA integrity_check`가 `ok`인지 확인합니다. 데이터베이스별 삭제는 독립된 transaction입니다. 한 데이터베이스가 실패해도 이미 끝난 다른 데이터베이스 결과와 각 backup 경로를 receipt에 남깁니다.

backup은 자동으로 지우지 않습니다. 복구가 더 필요 없을 때 직접 지웁니다. Windows receipt의 `os-managed-unverified`는 NTFS 계정 권한과 BitLocker 같은 OS 보호를 써야 하지만 MCP가 그 활성 상태를 확인하지 않았다는 뜻입니다.

### 복구

1. MCP 서버를 멈춥니다.
2. 현재 DB 파일을 별도로 보관합니다.
3. receipt에 기록된 backup을 원래 경로로 복사합니다.
4. 다시 시작한 뒤 `PRAGMA integrity_check`, workflow 조회, continuity 조회로 복구를 확인합니다.

### 미리보기의 보호 집계

미리보기의 선택적 `rootProtection`은 workflow의 같은 조회 transaction에서 계산한 보호 집계입니다. `activeRoots`는 기존 `counts.protectedActiveRoots`와 같은 전체 활성 root 수입니다. `linkedNonTerminalRoots`, `linkedRecentRoots`, `linkedMissingReceiptRoots`는 180일이 지난 terminal root 중 연결된 run 때문에 제외된 고유 root 수입니다. 한 root가 여러 이유에 들어갈 수 있으며 `totalProtectedRoots`는 이유별 합계가 아니라 활성 root와 제외된 terminal root의 중복 없는 총수입니다. terminal root 자체가 아직 보존 기간 안에 있는 경우와 continuity task는 이 집계에 섞지 않습니다.

이 객체의 여섯 필드는 함께 있습니다. 새 미리보기의 관측된 0은 0이고, 구형 응답이나 token에 객체가 없으면 미관측(UNKNOWN)입니다. 부분 객체나 잘못된 숫자는 거절합니다. `previewCreatedAt`은 plan의 생성 시각이며, HMAC으로 결속된 같은 집계를 receipt에 복사합니다. receipt의 집계는 실행 시점의 재관측이나 삭제 성공을 뜻하지 않습니다. 실제 삭제 건수와 실패 여부는 `databases`의 status·deleted 필드로 확인합니다. 진단만 변해도 기존 후보와 연결 메타데이터가 같으면 기존 token의 실행 조건은 바뀌지 않습니다.

3.0의 타입과 plan/receipt output schema는 이 선택적 필드를 함께 지원합니다. 과거의 `additionalProperties: false` validator는 새 응답을 거부할 수 있으므로 모든 구형 소비자와의 호환을 보장하지 않습니다.

## 이전 판이 남긴 파일

- 3.0부터 메시지 broker 프로세스는 없고 각 프로세스가 같은 SQLite 파일을 직접 엽니다. 2.x가 남긴 `endpoint.json`·`broker.token`·`broker-key.pem`·`broker-cert.pem`·`broker.lock*`은 3.0 이후 판이 읽지도 지우지도 않으며, 모든 2.x 프로세스를 끝낸 뒤 지워도 됩니다.
- `host-id`는 2.x 파일과 함께 지우지 않습니다. 3.3.0부터 host ID는 OS 기계 ID에서 얻고, 기계 ID가 없는 환경(`/etc/machine-id`가 없는 컨테이너 등)에서만 이 파일을 만듭니다. 지우면 새 ID가 생겨 기존 root가 다른 호스트의 것으로 판정됩니다.
- 이전 기본 경로의 현황판과 메시지 저장소는 새 공유 상태 폴더로 자동 병합하지 않습니다. 사용 중인 SQLite WAL을 복사하면 서로 다른 상태가 섞일 수 있기 때문입니다. 기본 경로를 바꾸는 업데이트는 모든 호스트에 함께 적용하고 세션을 다시 시작합니다. 필요한 대기 메시지는 업데이트 전에 처리하거나 TTL 만료에 맡깁니다.
- 3.7 이하에서 3.8.0 이상으로 올릴 때 작업 기록 DB 이관은 [3.8.0 업그레이드와 기존 데이터 이관](migrate-to-v3.8.0.md)을 따릅니다.
- workflow SQLite의 이전 schema에서 올린 DB는 이전 서버로 열 수 없습니다. 이전 판으로 돌아갈 가능성이 있으면 업그레이드 전에 MCP 서버를 멈추고 SQLite의 일관된 backup 방식(`VACUUM INTO` 등)으로 DB를 복사해 둡니다. 플러그인만 다시 설치해서는 롤백되지 않습니다.
