# AGS 3.0.0 릴리스 노트

3.0.0은 2.x와 호환하지 않는다. 업그레이드할 때는 모든 호스트를 3.0.0으로 함께 바꾸고, AGS 프로세스와 호스트 세션을 다시 시작한다. 2.x와 3.0을 섞어 실행하지 않는다. MCP 서버에는 Node.js 24.0.0 이상이 필요하다. tag와 GitHub Release를 게시하기 전까지는 공개 완료 상태가 아니다.

## 2.x와 호환되지 않는 변경

### broker 프로세스 제거, relay가 presence 관리

- 세션 메시지 broker 프로세스가 없어졌다. 각 프로세스가 같은 SQLite 파일을 직접 열고, 연산 하나를 쓰기 트랜잭션 하나로 처리한다.
- 세션의 presence(온라인 여부와 출생 세대)는 세션마다 뜨는 relay가 lease로 관리한다. 호스트 프로세스가 끝나거나 SessionEnd hook이 실행되면 그 출생이 끝난다.
- messaging DB는 `user_version` 3에서 4(`relay_leases`)로 한 번 이전된다. 2.x broker는 v4 DB를 거절하고, 실행 중인 2.x 프로세스는 SQL 오류로 실패한다.
- 2.x가 남긴 `endpoint.json`·`broker.token`·`broker-key.pem`·`broker-cert.pem`·`broker.lock*`은 3.0이 읽지도 지우지도 않는다. 2.x 프로세스를 모두 끝낸 뒤 지워도 된다(`docs/operations.md`).

### root 전용 원칙 폐기, 호스트가 관측한 호출자와 parentChain

- 「AGS 도구는 root만 호출한다」는 원칙을 버렸다. 호스트가 모델이 고칠 수 없는 child 신원을 주면 child 호출도 허용한다.
- 호출자는 호스트 관측값(`provenance: host-observed`)으로 기록한다. `caller.parentChain`은 root부터 직속 부모까지의 actor 목록(root면 빈 목록, 최대 16)이고, `parentChainComplete`는 직속 부모까지 이어졌는지를 나타낸다.
- 사슬이 맞지 않으면 `CALLER_CHAIN_INCONSISTENT`, 너무 깊으면 `CALLER_CHAIN_TOO_DEEP`이다.

### 응답 오류 코드 변경

`contracts/*.json`과 `ERROR_CODE` 목록은 그대로이고, 일부 경우에 돌려주는 값이 바뀐다(`docs/ags30-error-model.md` 4장).

| 경우 | 2.x | 3.0 |
| --- | --- | --- |
| 도구의 계약 밖 예외 | `INVALID_INPUT`과 원문 message | `MCP_UNAVAILABLE`과 고정 message, `details {reason, cause}` |
| `classify_skills`·`record_skill_selection`의 호스트 관측 오류 | `INVALID_INPUT` | 자기 코드(`BINDING_INVALID`, `MCP_UNAVAILABLE` 등). 요청 상태 거절은 계속 `INVALID_INPUT` |
| 미초기화 상태의 `prepare_state_cleanup`·`execute_state_cleanup` | `INVALID_INPUT` | `MCP_UNAVAILABLE` |
| stage validator 실행 실패·signal 종료·JSON 아닌 출력 | `GATE_FAILED`·`INVALID_INPUT` | `MCP_UNAVAILABLE`(`VALIDATOR_SPAWN_FAILED`·`VALIDATOR_TERMINATED`·`VALIDATOR_OUTPUT_INVALID`), `stderr` 원문 제거 |
| `lookup_korean_prose_terms`의 sourceDigest 불일치 | `INVALID_INPUT` | 변경 없음 |

workflow·trust DB 스키마가 더 새것이면 `MCP_UNAVAILABLE`(`reason: "SCHEMA_NEWER"`), 저장 키·run sequence·receipt 메타 불일치는 `INTEGRITY_FAILED`, run sequence 소진은 `MCP_UNAVAILABLE`로 정했다. workflow 저장소 오류 details에서 `databasePath`와 원문 `cause` 문자열을 지우고 `{reason, cause}` 형태로 바꿨다. `sqliteErrcode`는 남는다.

### workflow DB v6와 관문 계약

- workflow DB는 열 때 v5에서 v6로 한 번 이전된다. 끝나지 않은 v5 run(`running`, `needs-*`)은 `blocked`가 되고 blocker `pre-3.0-gate-contract`가 붙는다. 진행 중이던 convergence attempt는 `failed`로 닫히고 시도 1회를 쓴 것으로 남는다. 이전이 실패하면 rollback되어 v5가 그대로 남는다.
- receipt의 산출물·증거에서 `verified`를 지우고 `check: "not-checked"`를 넣는다. 서버가 확인한 적이 없는 값이었기 때문이다.
- attempt proposal의 `actorId`와 convergence review의 `implementationActorIds`를 지웠다. 행위자는 서버가 lease와 호출자 관측으로 정한다.
- receipt와 convergence 상태에 `unverifiedClaims`를 추가했다. AGS가 관측하지 못한 성질(예: `evidence-relevance`, `evidence-content`, `actor-independence`, `fresh-context`, `user-approval`)에 기대는 통과는 여기에 적고, 선언을 검증으로 올리지 않는다.

### 세션 현황판 v1과 messaging v4

- 현황판은 새 형식(`user_version = 1`, `board_sessions` 표)으로 다시 만들었다. 2.x 현황판 데이터는 옮기지 않고 빈 상태에서 시작한다. 다른 표가 있거나 버전이 다른 파일은 `BOARD_FOREIGN_DATABASE`로 거부하고 파일을 건드리지 않는다.
- 쓸 수 없는 현황판(R9): update는 `MCP_UNAVAILABLE`이고 `step`은 실제로 실패한 단계(`open`·`write`)다. 읽을 수 있으면 list는 `board.status: "ok"`와 요약을 그대로 보여 주고, 읽지 못할 때만 `unavailable`과 실패 단계를 보인다(`docs/ags30-session-board-design.md`).
- messaging은 위 v4 형식을 쓴다.

## 스킬 변경

- mutation-risk-preflight 1.0.2: 제한된 신규 비공개 외부 준비(`freshResourceContainment.externalPreparation`)를 구분한다. 효과 근거가 있는 비공개 신규 외부 준비는 조건부 중단·보존 경로로 점검할 수 있고, 실제 공개·기존 객체 변경·권한 확대에는 이 경로를 적용하지 않는다.

## 고친 결함

- D-0353: Windows Codex hook이 relay를 붙잡지 않게 했고, 관측되지 않은 깨우기를 정해진 만료·유예 뒤에 해제하며 일반 활동으로는 해제하지 않게 했다.
- D-0351: 호스트의 SessionEnd에서 그 출생을 끝내고, 깨울 수 없다고 밝힌 대상을 정확한 출생 세대로 막는다. Codex SessionEnd hook에도 호스트 프로세스(`--host-pid`)를 넘긴다.
- D-0354 계열: agy CLI를 호스트 프로세스로 인식하고, relay가 뜨지 않거나 일찍 끝난 이유와 시작 거부 사유를 기록하며, 같은 호스트 출생의 시작 사건이 살아 있는 세대를 바꾸지 않게 했다. relay 복구는 그 세대가 보고한 호스트 출생에만 결속한다.
- R5: 호스트가 SIGTERM으로 relay를 멈추면 lease를 놓는다.
- 좀비 호스트: Linux에서 좀비·종료 상태의 호스트 프로세스를 끝난 것으로 본다.
- Codex ENOENT: Windows npm 설치(PATH에 `codex.cmd`만 있음)에서도 shell 없이 Codex 큐 깨우기를 시작한다.
- Codex ack 안내: peer 메시지 봉투에 확인 도구 이름(`acknowledge_session_messages`)을 적는다.
- hook PID 0: 0 이하의 호스트 PID는 확인하지 못한 값으로 보고 `RELAY_HOST_PID_UNRESOLVED`로 거부한다.
- `CODEX_EXECUTABLE_MISSING` 오표시: codex 실행 파일이 없으면 송신자에게 깨우기 가능으로 알리기 전에 그 사실을 보고한다.

## 알려진 제약

- agy(Antigravity CLI)는 자동 깨우기를 지원하지 않는다(gemini-deferred).
- Codex에서 `/clear`를 해도 이전 thread는 Codex가 SessionEnd를 실행할 때까지 온라인으로 남는다. Codex 공식 동작이다(세션 전환만으로는 바로 끝나지 않는다).
- MCP 서버는 Node.js 24.0.0 이상이 필요하다.
- 실제 호스트 재측정과 양 Cloud 검증은 완료로 주장하지 않는다. 운영 DB 이전·공용 MCP 전환은 포함하지 않는다.
