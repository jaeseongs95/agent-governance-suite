# 3.9.0 세션 메시지 회수 검증 계획

- 기준: `99fd589a`(v3.8.2), 브랜치 `claude/v390-msg-recall`.
- 원 요구(11-07): 상대가 아직 받지 않은 메시지는 보낸 세션이 회수할 수 있다. 메일 발송 취소와 같은 정책.
- 공개 경계: MCP 도구 `recall_session_message` → `SessionMessageService.recall` → `sessionMessageRequest("recall")` → `dispatchSessionMessageOperation` → `SessionMessageStore.recall`(한 `BEGIN IMMEDIATE` writer transaction). 같은 연산은 공용 CLI(`session-message-cli`)에도 열린다.
- 상태 전이: `queued`(messages 행, `claimed_at IS NULL`) → `recalled`(messages 행 삭제 + 제출 영수증 JSON에 `recalledAt`, 영수증 보존 기한은 ACK와 같은 `min(기존, 지금+1시간)`). `delivered`·`acknowledged`·만료·`prepared`는 바뀌지 않는다.
- 시험 위치: Linux 시험 서버(ssh-test `default`)와 CI. 이 PC는 build·tsc·lint만.

## 불변조건(cs-engineering: CONC-CLAIM-001, CONC-CANCEL-004, 재요청 멱등)

1. R1 한 메시지에서 회수 성공과 claim 성공 중 하나만 일어난다. 둘 다 같은 writer lock 아래에서 행 상태를 다시 확인한다(회수는 `claimed_at IS NULL` 조건 삭제의 영향 행 수 1, claim은 행 존재).
2. R2 회수된 메시지는 어떤 claim(MCP claim, 도구 경계, 턴 끝, 깨우기 도착)에도 다시 나오지 않고, 대기 수·깨우기 후보에서 빠진다.
3. R3 같은 회수 요청을 다시 보내면 같은 `recalledAt`과 `duplicate: true`를 돌려주고 아무것도 바꾸지 않는다.
4. R4 거절(받음·만료·준비만 됨·모름)은 아무것도 쓰지 않는다. 남의 메시지와 모르는 ID는 같은 응답(`status: null`)이다.
5. R5 깨우기 신호가 이미 나간 뒤 회수하면 도착한 깨우기는 인식되고(`recognized: true`) 메시지 0건이다. 훅은 이를 실패로 보고하지 않는다(기존 빈 깨우기 경로).

## 사례

| ID | 입력·절차 | 기대 결과 | 수준 |
| --- | --- | --- | --- |
| RC01 | prepare·send 뒤 수신자 claim 전에 발신자가 회수 | `recalled: true`, `status.state: "recalled"`, `recalledAt`; 수신자 claim 0건, pending 0; status 조회도 `recalled` | store |
| RC02 | RC01 뒤 같은 회수 재요청 | `recalled: true`, `duplicate: true`, 같은 `recalledAt`; 행·영수증 변화 없음 | store |
| RC03 | 수신자가 claim(받음) 뒤 회수 | `recalled: false`, `reason: "delivered"`, `status.state: "delivered"`, `claimedAt`·`firstDeliveredAt` 그대로; 이후 ACK 정상 | store |
| RC04 | 받고 ACK 뒤 회수 | `reason: "delivered"`, `status.state: "acknowledged"`, `acknowledgedAt` | store |
| RC05 | 다른 세션이 같은 ID로 회수, 모르는 ID 회수 | 둘 다 `recalled: false`, `reason: "unknown"`, `status: null`; 원 메시지는 그대로 claim 가능 | store |
| RC06 | TTL이 지난 뒤 회수 | `reason: "expired"`; 아무것도 쓰지 않음 | store |
| RC07 | prepare만 하고 send 전 회수 | `reason: "not-sent"`, `status.state: "prepared"` | store |
| RC08 | 깨우기 reserve·start·handed-off 뒤 회수, 그다음 그 깨우기 도착 | `recognized: true`, messages 0건; 새 reserve는 dispatch 안 함 | store |
| RC09 | 두 프로세스가 같은 DB에서 동시에: A는 N개를 차례로 회수, B는 1개씩 claim 반복 | 회수 성공 집합과 claim 집합이 겹치지 않고 합이 N; A의 거절은 모두 B가 받은 것 | 프로세스 |
| RC10 | MCP 서버(stdio)에서 결속된 발신자로 `recall_session_message`, 다른 세션으로 같은 ID | 발신자는 `recalled`, 다른 세션은 `status: null`; get_session_message_status `recalled`; 도구 목록에 노출 | MCP |
| RC11 | 도구 이름 목록·locale 설명(ko·en) | 목록 테스트·i18n 검사 통과 | 정적 |

## 결함 탐지 확인(test-proof)

새 기능이라 수정 전 코드에는 연산 자체가 없다(red는 자명). 대신 격리 사본에서 표적 변이를 넣어 같은 시험이 실패하는지 본다.

- M1 회수 삭제 조건에서 `claimed_at IS NULL`을 빼면 RC03·RC09가 실패해야 한다.
- M2 회수 뒤 영수증에 `recalledAt`을 쓰지 않으면 RC01(status)·RC02가 실패해야 한다.

## 실제 결과

Linux 시험 서버(ssh-test `default`, Node v24.22.1), 격리 worktree `/home/mcpops/ags-tests/v390-recall-r01/wt`, `flock /home/mcpops/ags-tests/.heavy.lock`. 명령은 `node node_modules/vitest/vitest.mjs run <파일> --maxWorkers=1 --reporter=json`.

| 실행 | 대상 커밋 | 범위 | 종료 코드 | 결과 |
| --- | --- | --- | --- | --- |
| green | `54f43f13e0c9a606f5f64b688d8b909de8aba7ee` | message-recall, session-message, stdio-integration, d0315-positive-child, ags38-peer-wake, claude-plugin, message-lifecycle, message-retention, wake-doorbell, ack-claim-history(10 파일) | 0 | 237/237 통과 |
| M1(`claimed_at IS NULL` 제거) | 같음 | message-recall | 1 | RC03·RC09 실패(9 중 2) |
| M2(`recalledAt` 미기록) | 같음 | message-recall | 1 | RC01·RC02 실패(9 중 2) |
| green2 ×3 | `c45f8f6d966aed53ea1d11d3a0e4b207b77ca8bb` | message-recall | 0, 0, 0 | 9/9씩. RC09 분포(회수/claim) 40/0, 8/32, 3/37 |
| M1 재확인 | 같음 | message-recall | 1 | RC03 실패. 이 회차 RC09 분포 40/0이라 RC09는 통과 |

- RC09는 두 프로세스가 실제로 섞인 회차(8/32, 3/37)에서 불변조건(겹침 0, 합 40)을 확인했다. 첫 판(둘 다 앞에서부터)은 claim이 항상 앞서 한쪽 순서만 시험해, 회수를 최신부터 하도록 고쳤다(`c45f8f6d`). 분포는 스케줄에 따라 달라 단정하지 않는다. 그래서 M1을 RC09가 잡는지는 회차에 따라 다르며, M1은 RC03이 결정적으로 잡는다.
- 원시 결과: 서버 `/home/mcpops/ags-tests/v390-recall-r01/`의 `run.log`, `run2.log`, `green.json`, `m1.json`, `m2.json`, `green2-{1,2,3}.json`, `m1b.json`.
- 빈 깨우기의 hook 처리(recognized·managed·메시지 0건 → 실패 보고 없이 기존 빈 깨우기 경로)는 기존 `tests/mcp/ags38-peer-wake.test.ts` PE02·PE04가 확인하고, RC08은 회수 뒤 store가 그 모양을 돌려주는지 확인한다. 실제 호스트(Claude·Codex·agy) 시험은 하지 않았다.
