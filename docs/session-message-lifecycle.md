# 시스템 발급 메시지 ID와 재시도

릴레이의 기존 5초 주기는 `relay-tick` 한 요청으로 현재 세션 세대와 relay lease를 확인하고 두 heartbeat를 함께 갱신한다. pending 조회는 해당 transport가 필요한 경우만 포함한다. 오래된 세대·종료된 presence·만료된 lease는 갱신하지 않으며, heartbeat 자체는 실제 wake 관측이 아니다.

2.6.0의 새 메시지는 `prepare_session_message`로 준비하고 반환된 `messageId`만 `send_session_message`에 전달한다. 준비는 발신자·대상·본문·TTL을 고정하며 수신 큐·peer 관계·wake에 영향을 주지 않는다. ID는 공통 broker가 발급하고 기존 메시징 SQLite에 보존한다. caller가 ID를 만들거나 전송 때 내용을 바꿀 수 없다.

```mermaid
stateDiagram-v2
    [*] --> Prepared: prepare / 시스템 ID 발급
    Prepared --> Submitted: 같은 발신자의 send(ID) / 원자 삽입·영수증
    Prepared --> Removed: 준비 만료
    Submitted --> Submitted: 같은 ID 재시도 / 최초 영수증
    Submitted --> Removed: 영수증 보존 만료
    Removed --> Removed: old ID send 거절
```

`schemaVersion: "1.0.0"`, `targetHost`, `targetSessionId`, `body`, 선택 `ttlSeconds`로 prepare를 호출한다. 이어 `schemaVersion`과 반환된 `messageId`로 send를 호출한다. 두 호출의 `_sessionBinding`은 기존 host hook이 결속하며 별도 사용자의 승인·principal을 만들지 않는다. 발급되지 않은 ID, 다른 sender, send의 추가 body/target/TTL은 큐 삽입 없이 거절한다.

prepare 응답이 유실되어 다시 준비하면 사용하지 않는 draft가 남을 수 있지만 전달은 일어나지 않는다. send 응답이 유실되면 이미 알고 있는 같은 발급 ID로 `get_session_message_status`를 조회하거나 send를 재시도한다. 최초 큐 삽입과 제출 상태·영수증 저장은 같은 `BEGIN IMMEDIATE` transaction으로 확정한다. broker 재시작이나 다른 연결의 동시 send에도 같은 ID로 다시 삽입하거나 expiry를 늘리지 않는다.

**unknown ID는 전송이 없었다는 증거가 아니다.** 이미 전송한 기록이 정리됐을 수 있으므로 보관한 영수증과 대조한다. 불명확한 전송을 무조건 새 prepare로 다시 보내지 않는다. 새 prepare는 새 전송 의도에 사용한다. 수신 모델의 업무를 exactly-once로 실행한다는 보장은 없다.

| 저장 대상 | 경계 |
| --- | --- |
| 미전송 draft | prepare부터 10분; sender별 100개, 전역 1000개 |
| 제출 영수증 | 최대 1000개; 최초 메시지 expiry 이후 1시간까지 보존 |
| draft·영수증 전체 | record JSON의 UTF-8 byte 합 최대 4 MiB; 전송 뒤 본문 중복 저장 제거 |
| 실제 수신 큐 | 기존 미ACK 메시지 최대 1000개·본문 합 4 MiB |
| 메시지 TTL | 첫 send부터 30~86400초, 기본 3600초 |

상한에서는 명시적으로 거절하며 미만료 기록을 강제로 지우지 않는다. 영수증이 정리된 ID도 unknown으로 거절해 새 메시지가 생기지 않는다. 영구 tombstone이나 별도 DB·daemon은 없다. status는 준비 상태, 기존 queued/delivered/acknowledged 상태 또는 큐 행이 정리된 뒤 제출 영수증과 `deliveryState: "unknown"`을 구별한다.

ACK 전 lease 재전달은 정상이며 같은 ID·본문을 유지한다. 중복 ACK는 최초 ACK 시각을 늘리지 않는다. ACK는 처리 확인으로, 업무 완료나 승인이 아니다. wake의 전달 결과가 불명확하면 기존 예약을 유지하고 새 wake 효과로 바꾸지 않는다. [peer 대기 판정](peer-wait-policy.md)의 nonce·generation·복귀 증거 만료 계약은 유지한다.

## hook 없는 CLI

`node mcp-server/dist/session-message-cli.mjs`의 stdin으로 아래 준비 요청을 보낸다.

```json
{"operation":"prepare","payload":{"sender":{"host":"spark","sessionId":"owner"},"target":{"host":"grok","sessionId":"worker"},"body":"검증 결과를 전달합니다.","ttlSeconds":600}}
```

성공 출력의 `data.messageId`를 보관하고 다음 전송 요청에 그대로 사용한다. 아래 ID 자리는 시스템이 반환한 실제 값으로 채운다.

```json
{"operation":"send","payload":{"sender":{"host":"spark","sessionId":"owner"},"messageId":"<returned-messageId>"}}
```

옛 send의 body/target/TTL이나 임의 ID 입력은 오류와 함께 종료하며 전달 효과가 없다. CLI도 broker와 같은 발급·보존·전이 계약을 사용한다. 본문과 비밀은 프로세스 인수에 넣지 않는다.

## 업데이트와 복구

기존 AGS MCP·relay·broker를 종료한 뒤 업데이트하고 재연결한다. 추가 `prepared_messages` 테이블은 기존 messages·키·nonce·presence 데이터를 보존한다. 기존 메시지는 계속 claim/status/ACK할 수 있지만 발급 이력이 없는 기존 ID로 새 send를 할 수 없다. 이전 broker와 섞이는 호환 경로는 이번 사용자 범위에서 제외했다.

문제가 생기면 운영 DB와 키를 지우지 않고 데이터를 보존해 조사한다. 구버전 재설치는 새 발급 ID·재시도 계약을 지킨다는 증거가 아니다. 새 테이블을 삭제하거나 DB를 덮어써서 복구하지 않는다. 실제 설치·실행 process의 후보 확인은 소스 검증과 별도로 수행한다.


## wake 알림 수명과 누적 억제

새 relay는 메시지 본문과 별도로 기존 `wake_nonces`에 managed 알림을 저장한다. 대상당 미관측 알림은 하나이며 뒤따르는 본문은 기존 `messages`에 남는다. 본문 claim, ACK, tool-boundary, turn-end는 managed 알림을 관측하거나 해제하지 않는다. board의 `consume-wake`는 nonce 소유 여부만 확인한다.

```mermaid
stateDiagram-v2
    [*] --> reserved: 현재 presence·relay / target UNIQUE
    reserved --> started: 현재 세대·lease·claimable 재검사 / CAS commit
    reserved --> not_submitted: start 전 본문 소진 또는 주입 만료 / 외부 효과 0
    started --> submitted: adapter 제출 응답
    started --> unknown: 응답 유실·timeout·crash·불명확 결과
    started --> reserved: 확실한 무제출 / 영속 backoff
    submitted --> observed: 유효한 실제 hook 관측과 원자 claim
    unknown --> observed: 유효한 실제 hook 관측과 원자 claim
    observed --> observed: 늦은 결과·재소비 거절
```

`not_submitted`는 저장값 `not-submitted`다. 외부 효과가 시작되기 전에 본문이 소진되었음을 확인한 종료 기록이며 host 관측으로 계산하지 않는다. reserved에서만 현재 lease 소유자가 기존 nonce와 attempt를 회수할 수 있다. relay 교체 뒤 옛 소유자의 start는 거절한다. definite failure의 재시도는 같은 attempt와 영속 backoff를 사용하며 새 dispatch epoch가 늦은 결과를 차단한다. started를 먼저 commit한 뒤에만 adapter를 호출한다. 시작 응답이 유실되었어도 재호출은 새 발송 권한을 만들지 않는다.

submitted는 host의 처리 ACK가 아니다. started 이후 불확실한 효과는 unknown으로 보존하고, relay나 broker 재시작, 본문 ACK, 메시지 만료, nonce 만료로 새 발송을 허용하지 않는다. nonce에는 대상, instance, presence의 birth generation, relay, attempt, dispatch epoch를 저장한다. 메모리 Map은 이 알림 수명의 원장이 아니다.

### hook 관측 경계

관측은 실제 `UserPromptSubmit` hook에서 adapter가 해석한 marker-only 입력과 기존 TrustStore의 비권위 source receipt를 함께 보낸다. broker는 저장된 서명·대상·정규화한 관측 digest·receipt TTL을 검증한 뒤 `BEGIN IMMEDIATE` 안에서 nonce, 현재 presence instance/birth generation과 claim 가능 본문을 확인한다. 일반 caller의 `approved`, normalized 입력 자칭, nonce 문자열만으로 managed observed를 만들 수 없다. 일반 peer 본문 receipt도 wake hook receipt로 사용할 수 없다. receipt 발급은 hook 코드에 있으며 공개 MCP 발급 도구는 없다.

receipt는 `authorityEffect: none`이다. 이 검사는 협력하는 로컬 hook 경로의 liveness provenance를 결속한다. 같은 OS 사용자가 코드를 실행하거나 source key를 변조할 수 없다는 보장, 사용자 승인·신원·업무 완료·W06 권위 채널 자격을 만들지 않는다. host payload에 instanceId가 없다는 한계를 숨기지 않고 nonce의 영속 결속과 현재 presence를 대조한다.

관측과 본문 claim은 하나의 transaction이며 batch/response budget 오류가 나면 둘 다 rollback한다. nonce는 한 번만 관측되고, 한 알림이 해당 시점의 claimable batch를 전달한다. batch 밖 본문과 ACK가 유실된 본문은 기존 claim lease 규칙에 따라 안전한 boundary에서 전달할 수 있다. 메시지 전달 자체를 exactly-once 업무 실행으로 확대하지 않는다.

만료 또는 옛 generation marker는 해당 행의 `lateObservedAt`만 기록하며 새 본문 claim이나 현재 fence 해제를 허용하지 않는다. 불확실한 fence는 그대로 unknown이다. 관측 기한이 지난 상태는 `observation-overdue`로 표시한다. `wake-status`와 메시지 status의 `wake` diagnostic에 상태·generation·attempt·주입 만료·재시도 시각·관측 시각을 표시하며 본문이나 nonce는 포함하지 않는다.

### capability와 이관

| adapter | 주입과 idle 깨우기 | 제출 후 의미 |
| --- | --- | --- |
| claude-inbox | peer-wake·tool-boundary·turn-end, silent next | 실제 peer-wake hook 관측 필요 |
| codex-queue | peer-wake·tool-boundary, user-message | 실제 peer-wake hook 관측 필요 |
| codex-deferred | tool-boundary만, idle wake 없음 | idle 알림 발송 0 |

공통 relay는 outcome/capability/dispatch port만 사용한다. transport 등록과 vendor SDK·protocol은 adapter 모듈에 둔다. 다른 vendor도 같은 port를 주입할 수 있으며 공통 알림 상태에 vendor 분기를 추가하지 않는다. 이 경로는 host queue 목록·취소·삭제를 호출하지 않는다.

이관은 기존 DB에 컬럼과 active target UNIQUE를 transaction으로 추가한다. 기존 nonce는 `legacy`이며 옛 consumed_at을 observed로 가져오지 않는다. 기존 queued marker는 자연 소진한다. legacy 종료에는 새 누적 억제 보장을 소급하지 않는다. 활성 managed target 한도는 기존 1000개 budget을 재사용하고 초과는 명시적으로 거절한다. 미확정 행은 TTL prune에서 제외하며 종료 기록은 최대 1000개, 종료 후 1시간까지 보관한다. 이관 실패는 추가 컬럼과 index를 rollback하며 기존 본문·nonce를 보존한다. 운영 DB 삭제·덮어쓰기나 구버전과 혼용한 자동 rollback은 제공하지 않는다.

### 보장과 남은 조건

start 이후 본문 claim과 외부 enqueue 사이 경합에서는 잔여 알림 최대 1개가 남을 수 있다. host가 submitted 또는 unknown marker를 끝내 처리하지 않으면 queue 관측·멱등 지원 없이 추가 누적 억제와 idle 자동 재깨움을 동시에 보장할 수 없다. 이 기능은 누적 억제를 택한다. nonce TTL은 주입 유효기간이고 메시지 TTL은 본문 전송 제외 기준이며 어느 TTL도 host queued marker 제거 증거가 아니다. idle liveness는 현재 generation의 유효한 hook 도착에 조건부다. 옛/만료 관측 뒤에도 남은 unknown은 이 한계로 드러낸다.

독립 process fixture와 번들 검사는 실제 host 설치·wake 관측을 대신하지 않는다. 실제 설치·양 host 실측은 별도 W07/출하 검증이며 로컬 PASS로 승격하지 않는다.
