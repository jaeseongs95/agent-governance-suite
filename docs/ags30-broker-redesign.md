# AGS 3.0 메시징 broker·잠금·프로세스 신원 계층 재설계

- 상태: 설계안 r1(2026-11-01). 구현 전이다.
- 근거: 사용자 지시 「1번과 2번도 진행해줘. 마찬가지로 설계부터하고 개발진행해줘.」(1번 = broker 프로세스·잠금·PID 소유권 구조)
- 기준 커밋: `feat/ags30-broker-redesign` 4b2dc571. 줄 번호는 이 커밋 기준이다. 깨우기 설계 r3.2(`docs/ags30-wake-doorbell-design.md`)를 전제로 한다.
- 결함: AGS-D-0002·0003·0004·0005·0006·0007·0008·0031·0059·0060·0212·0214·0246·0254·0287·0297·0327·0330·0331·0350·0361·0362·0363·0365, 참고 D-0348·D-0351.

| 약어 | 파일 (`mcp-server/src/` 아래) |
|---|---|
| B | `session-message-broker.ts` |
| C | `session-message-client.ts` |
| S | `session-message-store.ts` |
| L | `broker-process-lock.ts` |
| W | `broker-lock-witness.ts` |
| PI | `process-identity.ts` |
| R | `session-message-relay.ts` |
| H | `session-message-hook.ts` |
| PW | `peer-wait-policy.ts` |
| SC | `runtime/unified-state/shared-connection.mjs` (저장소 루트 기준) |

## 1. 판정: 구조 결함이다. broker는 필요 없다

### 1.1 broker가 실제로 하는 일

broker는 SQLite store 앞에 TLS RPC를 하나 더 둔 것이다. 자기만 직렬화하는 상태는 없다.

| 주장될 수 있는 broker의 역할 | 실제 코드 | SQLite만으로 되는가 |
|---|---|---|
| 요청 직렬화 | 모든 연산이 store 메서드 한 번 호출이다(B:379-563). 동기 함수이고 await가 없다. 예외는 `ensure-relay`·`acquire-relay` 두 개이며 OS 신원 조회 때문에 await한다(B:658-660). | 된다. 각 store 메서드는 이미 `BEGIN IMMEDIATE` transaction이다(S:1555-1567). busy_timeout(S:214)과 WAL(S:220)도 있다. |
| await 사이의 경합 방지 | `ensure-relay`는 await 전에 `previous`·`expectedPresenceInstanceId`를 읽고(B:275-279), 쓰기 transaction 안에서 같은 값인지 비교한다(S:1030). 즉 이미 CAS다. | 된다. 다른 프로세스가 끼어들어도 같은 CAS가 막는다. |
| 깨우기를 한 번만 보내기(I3) | `startManagedWake`의 `UPDATE … WHERE state='reserved' AND dispatch_epoch=?`와 `changes === 1`(S:1312-1315)이 막는다. broker가 막는 것이 아니다. | 된다. 행 CAS다. |
| 위조 표식 거절(I1) | `claimHostWake`는 trust DB의 서명된 receipt로 검증한다(S:1390, `session-message-wake-port.ts:199-203`). 서명 키는 trust DB에 있고 같은 사용자 프로세스가 읽을 수 있다(`trust-store.ts:196`). hook도 같은 키로 receipt를 쓴다(`session-message-wake-port.ts:190-191`). | 된다. broker만 가진 비밀이 없다. |
| 접근 통제 | TLS·token·인증서 pin(B:122-172, C:145-182)이다. 문서 스스로 같은 사용자 프로세스는 막지 못한다고 적는다(`docs/architecture.md:79`). | 필요 없다. 네트워크 구간이 없어지면 막을 대상도 없다. 0700 디렉터리와 0600 파일 권한은 그대로 둔다. |
| 단일 시계 | 깨우기 설계 2장은 「독립 모드는 broker 단일 프로세스의 `Date.now()`」라고 적는다(`ags30-wake-doorbell-design.md:41`). 그러나 `Date.now()`는 한 프로세스 안에서도 단조가 아니다. 또 claim은 transaction 전에 시각을 잡는다(B:400 → S:698). | 된다. 잠금 뒤 시각을 읽고 DB에 high-water를 저장하는 방식이 이미 있다(SC:44-67, SC:139-145). |
| peer 대기 판정 상태 | `peerWaitRuntimes` 메모리 map(B:174-201)과 `PeerWaitPolicy.snapshots`(PW:25-26)다. 그런데 `resumeObserved`는 `alive(relay.pid)`·`alive(relay.parentPid)`로 PID를 믿는다(B:113-120, B:475). | 표 2개로 옮기면 된다(3.5). 관측 시각은 이미 `wake_nonces.observed_at`에 있다(S:1412-1413). |

이미 제품 안에 SQLite를 여러 프로세스가 직접 여는 경로가 있다. 현황판 store는 hook 프로세스에서 `DatabaseSync`를 직접 연다(`skills/session-board/scripts/board-store.mjs:16`).

### 1.2 잠금과 PID 소유권이 지키는 것

`broker.lock`(B:583-585, L:153-217)은 「상태 디렉터리 하나에 broker 하나」만 보장한다. 이 잠금은 broker 자신을 위해서만 존재한다. 잠금이 죽은 소유자를 회수하려면 PID를 믿어야 했다. 그래서 출생 시각 조회(L:39-45, L:47-70)와 Windows pipe 증인(W 전체)이 생겼다. 그 결과 결함이 줄줄이 생겼다: PID 재사용(D-0004), 판정과 삭제 사이의 경합(D-0005), 빈 디렉터리 영구 점유(D-0212), 오류 소실(D-0214), 기동 기한 안의 PowerShell 조회(D-0331·D-0330). broker가 없으면 잠금도, 회수도, PID 판정도 필요 없다.

### 1.3 PID가 정말 필요한 곳은 하나다

relay는 남는다. 호스트가 유휴일 때 깨우려면 호스트 턴 밖에서 도는 프로세스가 있어야 하기 때문이다. relay가 알아야 하는 것은 하나뿐이다. 「내 호스트가 죽었는가」. 지금은 이것 말고도 PID를 권한 판정에 쓴다.

- relay lease의 주인 판정: `parent_pid`(D-0002), `process.kill(pid,0)`과 ESRCH(B:289-313, D-0007).
- hook이 기한 안에서 출생 시각을 읽는다(H:164-171, H:190, H:559). Windows에서는 PowerShell을 동기로 실행한다(PI:15-16, PI:67).

권한 판정은 SQLite lease 행과 fencing 값으로 옮긴다. 호스트 생존 감시만 relay 안에 비동기로 둔다. 이 감시는 어떤 기한 안에도 없다(3.4).

## 2. 결함 처분 (26건)

| 처분 | 결함 | 이유 |
|---|---|---|
| 코드 삭제로 사라짐 (13) | D-0004·0005·0212·0214 | `broker-process-lock.ts`·`broker-lock-witness.ts`를 지운다. |
| | D-0008 | broker idle 판정을 지운다. |
| | D-0006 | 네트워크 재전송(C:501-516)이 없어진다. 같은 프로세스에서 COMMIT은 성공하거나 throw한다. |
| | D-0246·0297·0330 | 잠금 디렉터리와 그것을 다루는 시험을 지운다. |
| | D-0331 | 기동 기한 안의 신원 조회(L:41, B:280·306·345, H:190·559)를 모두 지운다. 남는 조회는 relay 안에서 비동기로 하고 기한이 없다(3.4). |
| | D-0002·0007 | lease 판정에서 PID를 뺀다. 주인은 무작위 `relay_id`로만 판정한다(3.3). |
| | D-0003 | lease 갱신은 로컬 SQLite 쓰기이고 독립 타이머가 한다. dispatch await 뒤에 줄 세우지 않는다(3.3). |
| 설계 규칙으로 고침 (4) | D-0031·0060 | 모든 시각은 `BEGIN IMMEDIATE` 다음에 읽고 high-water로 단조를 보장한다(3.2). |
| | D-0059 | DDL 전체와 `user_version` 읽기를 같은 IMMEDIATE transaction에 둔다. 지금은 CREATE TABLE이 transaction 밖에 있다(S:221-274). 버전이 맞으면 쓰기 없이 연다(3.2). |
| | D-0348 | grant 규칙에 「설치된 relay 코드 digest가 다르면 교체」를 넣는다(3.6). |
| 제품 경로 삭제, CI 근거 필요 (6) | D-0254·0287·0327·0350·0362·0365 | 모두 broker를 띄우고 준비를 벽시계 기한으로 기다리는 시험에서 실패했다(C:296-389, 예 `tests/session-messaging/peer-wait.test.ts:280`). 그 경로가 제품과 시험에서 모두 없어진다. 원인은 계속 UNKNOWN으로 기록한다. 종결은 「경로 삭제」로 하고, 다시 쓴 시험이 Windows CI에서 실행된 기록을 붙인다. |
| 남음 (3) | D-0361 | 묶음 MCP 서버 시작 시험이다. broker와 관계없다. |
| | D-0363 | 이 시험의 hook이 broker를 띄우는 경로는 없어진다. 그것이 원인이었는지는 모른다. 원래 30초 기한으로 Windows CI를 다시 돌려서 판정한다. |
| | D-0351 | 호스트 세션 ID가 바뀌는 문제는 presence 식별의 문제다. 이 설계가 다루지 않는다(9장). |

## 3. 설계

### 3.1 접근: 각 프로세스가 SQLite를 직접 연다

- `session-message-client.ts`를 지우고 `session-messaging.ts` 하나로 바꾼다.

```ts
/** 프로세스·경로당 연결 하나. busyTimeoutMs는 hook 예산에서 정한다. clock은 시험에서만 주입한다. */
export function openSessionMessaging(stateDirectory?: string,
  options?: { busyTimeoutMs?: number; clock?: () => number }): { run<T>(operation: string, payload: Record<string, unknown>): T; close(): void };
```

- `run`은 지금의 `dispatchSessionMessageBrokerOperation`(B:379-563)을 그대로 쓴다. 이름은 `dispatchSessionMessageOperation`으로 바꾸고 `session-message-operations.ts`로 옮긴다. 입력 검증 경계는 지금과 같다.
- 호출처는 MCP service, hook, CLI, relay, 현황판 hook 다섯 곳이다(`session-message-service.ts:54-130`, H:351-372, `session-message-cli.ts:20-31`, R 전체, `session-board-hook.ts:89`). `await sessionMessageRequest(...)`를 동기 `messaging.run(...)`으로 바꾼다.
- hook은 남은 예산에서 응답 여유를 뺀 값으로 `PRAGMA busy_timeout`을 정한다. 상한은 5000ms다. MCP 서버와 relay는 5000ms를 쓴다. transaction 콜백은 동기만 허용하므로(SC:23) 잠금을 잡고 있는 시간은 CPU 시간뿐이다.
- `SQLITE_BUSY`는 BEGIN에서만 난다. 쓰기 전이므로 `MESSAGING_BUSY`로 그대로 보고한다. 자동 재시도는 하지 않는다.
- `PRAGMA synchronous=FULL`을 쓴다. receipt와 ACK가 전원 손실 뒤에도 남아야 하기 때문이다(SC:87과 같다).
- 지우는 연산: `ping`, `ensure-relay`, `acquire-relay`, `heartbeat-relay`, `release-verified-relay`, `presence-end`의 relay 분기. claim receipt 버전 검사(B:653-655, C:177-180)도 지운다. 같은 프로세스에는 섞인 버전이 없다.

### 3.2 시각과 스키마

- store의 `transaction(op)`는 `runObservedTimeTransaction`(SC:44-67)을 재사용한다. 순서는 `BEGIN IMMEDIATE` → `now = max(clock(), authority_time.last_ms)` → `op(now)` → high-water 저장 → COMMIT이다.
- 모든 공개 메서드의 `nowMs = Date.now()` 기본 인자와 `atMs`를 지운다. 시각은 생성자에서 받은 `clock`으로만 들어온다. 잠금 전에 시각을 만들 수 있는 길이 없어진다(D-0031·D-0060).
- 독립 모드와 공유 모드를 가르는 분기가 S에 있다. `if (this.shared && !this.shared.inTransaction)` 35줄과 `if (this.shared) nowMs = …` 30줄이다(`grep -c` 기준). 이 분기를 없애고 `prune`을 포함한 모든 연산을 transaction 안에서 실행한다. 지금은 일부가 transaction 밖에서 prune한다(S:698, S:815, S:950).
- 열기: 먼저 `user_version`을 읽기만 한다. 값이 현재 버전이면 끝이다. 다르면 `BEGIN IMMEDIATE` 안에서 다시 읽고 DDL과 이전을 모두 실행한다(D-0059). 지금처럼 열 때마다 쓰기 잠금을 잡지 않는다(S:275).

### 3.3 relay lease: 주인은 무작위 id, PID는 쓰지 않는다

`relay_leases`(v4):

```sql
CREATE TABLE relay_leases (
  host TEXT NOT NULL, session_id TEXT NOT NULL, transport TEXT NOT NULL,
  instance_id TEXT NOT NULL,       -- 이 lease가 섬기는 presence 세대
  relay_id TEXT NOT NULL,          -- grant마다 randomUUID. 재사용하지 않으므로 fencing 값이다
  code_digest TEXT,                -- grant를 요청한 설치본의 relay 코드 digest
  granted_at TEXT NOT NULL, lease_until TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (host, session_id, transport)) STRICT;
```

| 연산 | 호출자 | 한 transaction 안의 규칙 |
|---|---|---|
| `grant-relay` | hook (SessionStart, 경계 복구) | presence가 online이어야 한다. `presence.host_pid`가 있는데 hook이 찾은 호스트 PID와 다르면 거절한다(`HOST_MISMATCH`). 비어 있으면(3.0 이전 SessionStart가 만든 세대) 요청한 PID를 `host_pid IS NULL` 조건으로 기록한다. 경계 hook은 살아 있는 relay를 바꾸라는 힌트(`replace`)가 아닐 때만 자기 호스트 PID로 이 입양을 요청한다. 기존 lease가 같은 instance이고 아직 live이며, 코드 digest가 같거나 grant한 지 `RELAY_START_GRACE_MS`(30초)가 안 됐으면 거절한다(`RELAY_ALIVE`). 그 밖에는 새 `relay_id`로 upsert하고 `lease_until = now + 30s`로 둔다. |
| `relay-tick` | relay, 5초마다 | `relay_id`·instance가 현재 행과 같고 presence가 online일 때만 lease(15초)와 presence(20초)를 갱신한다. 처음 보낸 `hostStart`는 `presence.host_start`가 비어 있으면 기록한다. 이미 있는데 값이 다르면 `alive:false`를 돌려준다. 자기 instance presence가 이미 끝났으면 `ended:true`를 더해 돌려주고, relay는 이를 실패가 아닌 정상 종료로 처리한다. 반환은 `{alive, count, hostBound, ended?}`다. |
| `release-relay` | relay 종료, 호스트 사망 | 자기 `relay_id` 행만 지우고 자기 instance presence를 끝낸다. |
| `presence-end-host` | hook (SessionEnd) | 현재 presence 세대가 이 hook의 호스트 세대일 때만 끝내고 그 세대의 lease를 지운다. 조건은 셋이다. `presence.host_pid`가 hook의 호스트 PID와 같다. relay가 묶은 `presence.host_start`가 있고 hook 자신의 시작(`hostAliveAtBound`, 감시자와 같은 경계)보다 늦지 않다. 세대의 `started_at`이 hook 시작보다 늦지 않다. 먼저 끝낸 쪽만 남는다(`endPresence`는 이미 끝난 세대를 바꾸지 않는다). |
| `reserve-wake`·`start-wake` | relay | 기존 `wakeBindingCurrent`(S:1226-1233)에 조건 `presence.host_start IS NOT NULL`을 더한다. 호스트를 확인하지 않은 relay는 울리지 않는다. |

- **두 relay가 함께 울리지 못한다.** 새 grant가 나오면 옛 relay의 `relay_id`는 다음 tick에서 맞지 않는다. 그러면 옛 relay는 끝난다. 그 사이에 옛 relay가 `start-wake`를 불러도 `wakeBindingCurrent`의 relayId 비교에서 실패한다. 이미 start CAS를 통과한 시도는 행 상태가 `started`라 활성 슬롯을 차지한다(I5). 그래서 새 relay는 그 시도가 끝날 때까지 새로 예약하지 못한다(I3 유지).
- **죽은 relay를 PID로 판정하지 않는다.** 만료(15초)만 쓴다. 다음 hook 경계의 `relayRecovery` 힌트(B:369-377)가 다시 grant한다. 지금 있는 `pid=0` 미확정 grant, `confirmedDead`, `confirmedAlive`, `verifiedPresenceForCleanup`, `host-process-v1` 해시 instance, `verified-relay-v1` id 형식(S:960-1130, B:261-366)을 지운다.
- **갱신은 줄을 서지 않는다(D-0003).** relay에 동기 신원 조회가 없어진다. 그래서 5초 갱신 타이머는 dispatch의 비동기 I/O와 상관없이 돈다. 갱신 하나는 로컬 쓰기 몇 ms다.

### 3.4 호스트 생존 감시 (relay 안, 기한 없음)

`process-identity.ts`를 `host-process-watch.ts`로 줄인다. 공개 함수는 하나다.

```ts
/** bound: 호스트가 살아 있었다고 확실한 시점. 호스트 출생이 이보다 늦으면 다른 프로세스다. */
export function watchHostProcess(pid: number, bound: HostAliveBound): { bound: Promise<string /* hostStart */>; exited: Promise<string /* reason */>; close(): void };
```

| 플랫폼 | 방식 | PID 재사용 |
|---|---|---|
| Linux | 5초마다 `/proc/<pid>/stat`의 starttime(부팅 기준 tick, 단조)을 읽어 처음 값과 비교한다. `bound`는 hook 자신의 `/proc/self/stat` starttime이다. | 재사용된 PID는 starttime이 다르다. 다음 tick에서 판정한다. |
| Windows | relay마다 PowerShell 하나를 비동기로 띄운다. 순서는 `GetProcessById` → `Handle`(handle 보유) → 같은 handle로 `StartTime` → `bound`와 비교 → token 출력 → `WaitForExit()`이다. 자식 프로세스가 끝나면 `exited`가 된다. `bound`는 hook의 `performance.timeOrigin`이다. | handle이 열려 있는 동안 Windows는 그 PID를 재사용하지 않는다. |
| 그 밖 POSIX | 5초마다 `ps -o lstart=`를 비동기로 실행한다(지금 PI:17과 같다). | starttime 비교로 판정한다. |

- 감시자는 hook이 아니라 relay가 띄운다. relay가 새로 만든 pipe만 넘기고(`stdio: ["ignore", "pipe", "ignore"]`) hook에서 물려받은 handle은 넘기지 않는다. 그래서 hook이 끝날 때 호스트가 hook의 job·pipe를 정리해도(D-0353) 감시자는 영향을 받지 않는다. relay 자신을 handle 상속 없이 띄우는 방식은 D-0353 브랜치의 수정을 따른다. 그 브랜치가 들어오면 이 브랜치를 rebase하고, relay가 Windows job에 묶여 죽지 않는지 실호스트에서 확인한다.
- PowerShell 기동 시간은 relay 안에서 한 번만 쓴다. 이 시간은 어떤 hook 기한, MCP 요청, 시험 기한에도 들어가지 않는다(D-0331). 감시가 결과를 내기 전에는 `hostBound=false`이므로 울리지 않는다. 감시가 실패하면(권한 거부 등) 고정 사유를 기록하고 relay가 끝난다. 다음 경계에서 다시 시도한다.
- hook은 신원을 조회하지 않는다. hook은 호스트 PID(`resolveHookProcessPid`)와 `bound`만 넘긴다. Linux hook은 `/proc`가 싸므로 `hostStart`를 직접 읽어 같이 넘길 수 있다. Antigravity 어댑터처럼 이미 token을 가진 호출자도 넘길 수 있다. 넘긴 값은 relay가 감시 결과와 정확히 비교한다.
- D-0354(compact 중 세대 유지)는 `presence-start`에서 처리한다. live lease가 같은 instance이고, `presence.host_pid`가 같고, 코드 digest가 같으면 세대를 유지한다. Linux에서는 `hostStart`도 같아야 한다. Windows에서는 relay가 handle을 잡고 있으므로 같은 PID는 같은 프로세스다.

### 3.5 peer 대기 판정 상태를 DB로 옮긴다

- `resumeObserved`(B:473-477)를 다시 정의한다. 조건은 네 가지다. 보낸 쪽 presence가 online이다. 현재 lease가 live이고 `hostBound`다. 같은 instance·relay_id의 `wake_nonces` 행 중 `state='observed'`이고 `observed_at > now-30s`인 행이 있다. 능력 조건은 지금과 같다. `alive(pid)`와 메모리 map은 지운다.
- `PeerWaitPolicy`의 snapshot map을 표 `peer_wait_snapshots(query_key PRIMARY KEY, owner_key, fingerprint, expires_at)`으로 옮긴다. 최대 1000행이고 만료 행은 prune한다. `observe-native-input`은 owner의 행을 지운다(B:425). CLI와 hook은 수명이 짧은 프로세스다. 메모리에 두면 매번 「재시작」이 되어 반복 억제가 작동하지 않는다.

### 3.6 설치본이 바뀐 relay 교체 (D-0348)

- 모든 경계 hook은 `claim-*`와 `observe-native-input`에 자기 설치본의 relay 코드 digest를 넣는다(지금 H:427-428에서 SessionStart만 하는 일).
- lease의 `code_digest`가 다르면 `relayRecovery`에 `replace:true`를 실어 보낸다. hook은 `grant-relay`로 교체한다. 옛 relay는 다음 tick에서 fencing에 걸려 끝난다. 30초 유예 덕분에 교체는 grant마다 최대 한 번이다.
- 현황판은 `relayCode.status`(S:1543-1552)를 그대로 보여준다.

## 4. 깨우기 불변식 유지

| 불변식 | 지키는 곳 | broker 제거의 영향 |
|---|---|---|
| I1 위조·세탁 표식 | trust receipt 검증(S:1390) | 없음. 검증기가 hook 프로세스 안에서 같은 trust DB를 읽기 전용으로 연다. |
| I2 이전 출생 | `claimHostWake`의 출생 비교(S:1397-1399) | 없음 |
| I3 시도당 한 번 | start CAS(S:1312-1315)와 relay_id fencing(3.3) | 여러 프로세스에서도 같다. 원래 broker가 아니라 행 CAS가 지켰다. |
| I4 응답을 잃어도 바로 다시 울리지 않음 | `started` 시간 초과 → `unknown`(doorbell 2.2) | 네트워크 응답 유실 자체가 없어진다. relay가 죽어도 행은 `started`로 남는다. |
| I5 대상당 활성 시도 하나 | `reserveManagedWake`(S:1273-1285) | 없음 |

시각 규칙이 바뀌므로 깨우기 설계 2장의 「독립 모드는 broker 단일 프로세스의 `Date.now()`」(`ags30-wake-doorbell-design.md:41`)를 「잠금 뒤 관측한 authority time(3.2)」으로 고친다.

## 5. DB 변경과 이전 (messaging `user_version` 3 → 4)

- `relay_leases`: 지우고 3.3 형식으로 다시 만든다. lease는 일시 상태이고 3.0 설치 뒤 모든 relay를 다시 띄우기 때문이다.
- `session_presence`: `verified_parent_pid`·`verified_parent_token`·`reported_parent_pid`·`reported_parent_token`을 지우고 `host_pid INTEGER`·`host_start TEXT`를 더한다. 옛 행은 `host_pid=NULL`이다. 이 세대에는 grant를 거절하고(`HOST_UNREPORTED`), 다음 SessionStart에서 새로 시작한다.
- 새 표: `authority_time(singleton INTEGER PRIMARY KEY CHECK(singleton=1), last_ms INTEGER NOT NULL)`, `peer_wait_snapshots`.
- `wake_nonces`·`messages`·`prepared_messages`·`wake_paths`: 바뀌지 않는다.
- 공유 형식 후보(SC:12)의 messaging 표 목록과 버전도 같이 4로 올린다.
- 2.x와의 호환은 하지 않는다. 2.x broker가 v4 DB를 열면 기존 검사(S:216-219)에서 거절된다. 실행 중인 2.x 프로세스는 없어진 열에 쓰다가 SQL 오류로 실패한다. 업그레이드는 지금처럼 AGS 프로세스와 호스트를 다시 시작하는 절차를 따른다(`docs/peer-wait-policy.md` 끝 문단).
- 상태 디렉터리의 `endpoint.json`·`broker.token`·`broker-key.pem`·`broker-cert.pem`·`broker.lock*`은 3.0이 읽지도 지우지도 않는다. 섞인 업그레이드 중에 2.x broker가 아직 쓰고 있을 수 있기 때문이다. 정리 안내는 릴리스 노트와 `docs/operations.md`에 적는다.

## 6. 파일

- **지움:** `session-message-broker.ts`(작업 표는 `session-message-operations.ts`로 옮김), `session-message-client.ts`(`parseWakeMessages`·`wakeMessage`·`newWakeNonce`는 `session-message-protocol.ts`로), `broker-process-lock.ts`, `broker-lock-witness.ts`, `broker-identity-budget.ts`, `self-signed-certificate.ts`(호출처는 B:16 하나), `process-identity.ts`(→ `host-process-watch.ts`), `scripts/check-process-identity.ts`, protocol의 broker 잠금·기동 코드(`BROKER_LOCK_*`, `brokerStartupCode`, 줄 읽기기·크기 상한 중 TLS 전용 부분).
- **바꿈:** S(3.2·3.3·3.5, 5장), R(3.3·3.4, lease 갱신 타이머, 감시 연결), H(신원 조회 제거, grant·digest 전달), `session-message-service.ts`(배치 기한 루프 106-130 삭제), `session-message-cli.ts`, `session-board-hook.ts`, PW(저장소를 표로), `relay-wake-observation.ts`(:45·:106의 `processStartToken`을 실행마다 무작위 id로), `host-input-adapter.ts`(신원 필드 정리), SC(messaging v4 목록), `antigravity-connector/hooks/antigravity-hook-runner.mjs`(warm ensure 제거, token은 선택 입력으로만), `scripts/runtime-bundles.mjs`·`check-runtime.mjs`·`runtime-smoke.mjs`, `.github/ci/ags30-r11/*`·`.github/scripts/ags30-*`의 broker 항목, `docs/architecture.md` 69-79, `docs/operations.md`, `docs/peer-wait-policy.md`, 깨우기 설계 2장 한 줄, dist·claude-plugin 재생성.

## 7. 시험

벽시계 기한 안에서 진짜 broker를 띄우는 시험은 24개 파일이다(`grep -l` 기준). 이 시험들이 의존하던 대상 자체가 없어진다. 한도를 늘리거나 재시도를 붙이는 수정은 하지 않는다.

- **지움:** `broker-lifecycle`, `broker-lock-witness`, `broker-process-lock`(.os 포함), `broker-startup-convergence`, `d0254-broker-boundary`, `d0254-idle-inflight`, `d0254-lock-budget`, `d0254-lockstage-longpath`와 fixture, `d0298-*` 세 개와 fixture, `d0331-identity-batch`, `d0254-process-identity-diagnostics`, `verified-relay-transaction-budget`, `utf8-framing`(TLS 줄 조립), `antigravity-hook-warm-ensure`.
- **같은 프로세스에서 다시 씀:** `session-message`, `message-lifecycle`, `message-retention`, `peer-wait`, `presence-retention`, `pruned-generation-fence`, `relay-generation-fence`, `session-start-generation-fence`, `verified-relay-hook`(→ `relay-grant`), `wake-doorbell`, `claim-owner-late-ack-r01`, `historical-wake`, `relay-code-broker`(→ `relay-code`), `d0031-wake-lock-clock`(시각 oracle로 유지).
- **판정이 시간에 기대지 않게 하는 기법**
  1. 시각은 주입한 `clock`으로만 진행한다. 시험은 값을 직접 올린다.
  2. 잠금 경합: 연결 A가 `BEGIN IMMEDIATE`를 잡는다. 연결 B는 `busy_timeout=0`으로 연산한다. 기대 결과는 `MESSAGING_BUSY`이고 행 변화 0이다. A가 COMMIT한 뒤 B는 성공한다. 기다리지 않으므로 순서가 결정적이다.
  3. 잠금 뒤 시각(D-0031·D-0060): 주입한 clock이 호출되는 순간 `database.isTransaction === true`인지 단언한다. 잠금 전 시각으로 판정할 경로가 있으면 실패한다.
  4. 프로세스 간 경합: N개 자식이 같은 DB에서 claim·start를 동시에 실행한다. 판정은 결과 집합뿐이다(메시지당 receipt 하나, 시도당 dispatch 하나). 소요 시간은 판정에 쓰지 않는다.
  5. relay: 스케줄러, 감시, port를 주입한다. `tick()`을 명시적으로 진행하고 감시의 `exited`를 직접 resolve한다.
  6. 감시 OS 시험: Linux와 Windows에서 진짜 자식 프로세스를 띄운다. `bound`가 나온 뒤 kill하면 `exited`가 되는지 이벤트로 확인한다. 기한은 vitest 기본값만 hang 방지로 쓴다. `bound`보다 늦게 태어난 프로세스를 거절하는지도 확인한다.
  7. 정적 검사: 빌드된 hook·MCP·CLI 묶음에 `powershell.exe`·`tls.createServer`·`broker.lock`·`execFileSync` 문자열이 없어야 한다. 기한 경로에 신원 조회가 다시 들어오면 실패한다.
- **실호스트 확인**
  - Linux 테스트 서버: 묶음 설치 → Claude Code·Codex 두 세션 사이에서 send → 깨우기 → claim → ACK. 호스트 종료 뒤 presence가 lease 안에 ended/unreachable이 되는지 본다. 새 설치본으로 relay가 교체되는지(D-0348) 본다. 상태 디렉터리에 broker 파일이 생기지 않고 broker 프로세스가 0개인지 본다.
  - Windows: GitHub Actions windows-2025 shard에서 위 시험 전부와 원 기한 그대로의 D-0254·0287·0327·0350·0362·0363·0365 대상 시험을 돌린다. Windows 테스트 서버의 실호스트 확인은 서버가 준비됐다는 사용자 알림 뒤에 한다. 확인 항목은 hook 실행 중 PowerShell 자식 0개, relay당 PowerShell 1개, 호스트 종료 시 relay 종료다.

## 8. 남는 위험

- **PID 재사용 창 하나.** `bound`보다 늦게 태어난 프로세스는 거절한다. 그래도 호스트와 hook 사이에 셸이 끼어 있고, 셸 생성과 hook 생성 사이에 호스트가 죽고 그 PID가 재사용되면 relay가 엉뚱한 프로세스에 묶일 수 있다. Windows는 여기에 `timeOrigin`의 벽시계 역행까지 겹쳐야 한다. 영향: 그 프로세스가 끝날 때까지 presence가 online으로 보이고 깨우기가 `not-delivered`로 끝난다. I1~I11은 영향받지 않는다. 본문 인수는 실제 호스트 hook의 receipt가 있어야 하기 때문이다.
- **네트워크 파일시스템.** 상태 디렉터리가 네트워크 공유에 있으면 WAL 공유 메모리가 동작하지 않는다. 지금은 broker 하나만 DB를 열어서 드러나지 않았다. 열 때 `journal_mode=WAL` 결과를 확인하고, 실패하면 `MESSAGING_STATE_UNSUPPORTED`로 거절한다. 조용히 바꾸지 않는다.
- **Codex 샌드박스 안의 CLI.** 상태 디렉터리에 쓸 수 있어야 한다. 지금도 loopback이 막혀 같은 제약이 있다. 실호스트 확인 항목에 넣는다.

## 9. 현황판 재설계와의 관계

- `D:/codex/build/ags-5970-board`에는 현황판 설계 문서가 아직 없다(2026-11-01 확인: 같은 커밋 4b2dc571, 작업 트리 변경 0, `docs/`의 ags30 문서는 d0019·doorbell 둘뿐).
- 이 설계가 현황판에 주는 계약은 세 가지다.
  - `openSessionMessaging().run("list-presence", {targets})`를 같은 프로세스에서 호출한다.
  - 생존은 `presence.state`(authority time의 lease)로 본다. `relayLive`는 「lease live이고 `hostBound`」다.
  - PID·출생 token 필드는 내보내지 않는다.
- 겹치는 파일: `session-message-service.ts`(배치 기한 루프 삭제), `session-board-hook.ts`(`request` 주입 → 동기 `run`), S의 `listPresence`. 이 설계를 먼저 반영하거나, 현황판이 위 계약을 기준으로 작성한다.
- D-0351(세션 ID 교체 뒤 옛 presence가 online)은 presence 식별 문제다. 이 설계는 PID를 세대 판정에 쓰지 않으므로 해결하지 않는다. 한 호스트 프로세스가 여러 세션을 가질 수 있는지(예: 한 Codex 프로세스의 여러 thread) 확인한 뒤 현황판 쪽에서 다룬다.

## 10. 사용자에게 물을 것

없다. 2.x 상태 파일은 지우지 않고 남겨 두기로 했다(5장). Windows 실호스트 확인은 이미 정해진 서버 알림을 기다린다.

## 11. 구현 기록 (r1.1, 2026-11-01)

### 11.1 설계와 달라진 점
- `session-message-client.ts`는 지우지 않고 내용을 같은 프로세스 실행으로 바꿨다. 현황판 담당이 바꾸는 `session-message-service.ts`·`session-board-hook.ts`를 다시 건드리지 않기 위해서다. `sessionMessageRequest`는 같은 이름의 비동기 껍데기로 남고, 동기 `runSessionMessageOperation`이 실제 실행이다.
- 공개 메서드의 시각 인자는 지우지 않았다. 기본값 `AUTHORITY_NOW`(NaN)이면 잠금 뒤 시각을 읽는다. 숫자를 주면 시험용 고정 시각으로 그대로 쓴다. 제품 호출처(연산 표)는 숫자를 넘기지 않는다.
- `presence-start`가 같은 transaction에서 relay grant까지 한다. hook이 보고한 호스트 PID가 없으면 relay를 주지 않는다(`HOST_UNREPORTED`).

### 11.2 불변조건과 검증 의무 (cs-engineering, CONC-FENCE-002·CONC-CLAIM-001·DB-BOUNDARY-001·DB-MIGRATION-004)
| ID | 불변조건 | 실패 관측 | 검증 |
|---|---|---|---|
| CS-1 | lease를 갱신하거나 깨우기를 시작하는 것은 현재 `relay_id` 주인뿐이다. | 교체된 relay의 tick·start가 성공한다. | `broker-removal.test.ts` fencing 사례 |
| CS-2 | 시도 하나의 외부 호출은 한 번이다(I3). | 두 연결·여러 프로세스의 start가 둘 이상 `dispatch:true`다. | 같은 파일 두 연결 + N개 자식 프로세스, 결과 집합으로 판정 |
| CS-3 | 시각은 잠금 뒤에만 읽고 transaction당 한 번이며 줄지 않는다. | 잠금 밖에서 clock이 불리거나 거꾸로 간 시각으로 판정한다. | 주입 clock이 `isTransaction`을 기록 |
| CS-4 | 잠금 경합은 쓰기 0으로 `MESSAGING_BUSY`가 된다. | 일부만 쓰이거나 재시도로 숨는다. | 다른 연결이 `BEGIN IMMEDIATE`를 잡은 채 `busyTimeoutMs:0` |
| CS-5 | v3 → v4 이전은 한 번이고 다시 열 때 쓰기 잠금을 잡지 않는다. 새 버전은 거절한다. | 같은 버전으로 중복 이전하거나 현재 파일을 열 때 잠금을 기다린다. | v3 모양 파일 이전, 잠금을 잡은 상태에서 현재 파일 열기 |
| CS-6 | lease 갱신은 dispatch를 기다리지 않는다(D-0003). | dispatch가 끝나지 않으면 tick도 멈춘다. | 끝나지 않는 port와 주입 delay |
각 사례는 격리 사본에서 해당 변이를 넣으면 실패하고 원본에서 통과해야 한다(red/green).

### 11.3 Windows 호스트 감시 방식 결정
Windows 시험 서버(Windows Server 2022, node 24.22.2, PowerShell 5.1)에서 실측했다.

| 방식 | 재사용 판별 | 비용 |
|---|---|---|
| A. 상주 PowerShell, handle 보유 + `WaitForExit` | 된다. handle이 열려 있으면 프로세스 객체가 남고 PID가 재사용되지 않는다(Microsoft `PROCESS_INFORMATION`, "Terminating a Process"). | 첫 줄까지 약 0.31초, Private 약 51.8 MB + conhost 약 2.8 MB, 종료 감지 약 29 ms |
| B. node `process.kill(pid,0)` | 안 된다. 재사용된 PID도 살아 있다고 답한다. | 1회 약 2.2 µs |
| C. `wmic`·CIM 출생 시각 조회 반복 | 조회 사이의 재사용을 놓친다. | 75 ms(wmic), 508 ms(CIM) |
| D. `csc.exe`로 만든 OpenProcess/WaitForSingleObject 도우미 | 된다. | Private 약 9.5 MB. 그러나 실행 파일을 빌드·배포해야 한다. |

Node 24 공식 문서에는 임의 PID의 handle을 잡거나 종료를 기다리는 API가 없다(`node:ffi` 없음). 그래서 node만으로는 불가능하다. 결정: 내장 도구만 쓰는 A를 쓴다. 비용은 relay당 약 52 MB다. 이 비용이 문제가 되면 D로 바꾼다(`host-process-watch.ts`의 `ponytail:` 주석). 감시자는 5초마다 relay PID를 확인하고 relay가 없으면 끝난다. 그래서 relay가 비정상 종료해도 감시자가 남지 않는다.

### 11.4 SessionEnd가 자기 세대를 끝낸다 (R5 Windows·R10, 2026-11-02)
- 실측: Linux(Claude Code 2.1.314)는 세션 종료 때 비동기 SessionStart hook의 프로세스 그룹에 SIGTERM을 보낸다. relay는 SIGTERM을 받아 release한다(a9f09a51). Windows는 신호 없이 hook 트리를 끝낸다. 그래서 relay가 release하지 못하고 presence가 lease 만료까지 online으로 남다가 unreachable이 된다. `/clear`는 호스트 프로세스를 유지한다. 그래서 이전 세션 ID의 relay가 계속 tick하고 그 세션이 online으로 남는다(D-0351).
- 결정: SessionEnd hook이 `presence-end-host`로 현재 세대를 끝낸다. hook payload에는 instance가 없다. 그래서 세대가 이 hook의 호스트 출생인지를 PID와 출생 경계로 확인한다. 두 살아 있는 프로세스는 PID를 나눠 갖지 않는다. 그래서 같은 PID이고 출생이 hook 시작보다 늦지 않으면 같은 호스트다. 다른 프로세스에서 resume한 새 세대는 PID나 출생이 다르므로 끝내지 않는다. hook보다 나중에 시작한 세대도 끝내지 않는다. 같은 프로세스의 `/clear`는 이전 세션 ID의 세대와 일치하므로 끝낸다.
- hook은 OS 신원을 조회하지 않는다. SessionEnd 예산이 1.5초이고(Claude Code hooks 문서, 플러그인 hook의 timeout은 예산을 늘리지 않는다), Windows의 출생 조회는 PowerShell이 필요하기 때문이다. 대신 relay가 이미 묶은 `host_start`를 hook 자신의 시작 경계와 비교한다(`startNotAfter`). 묶이지 않은 세대는 끝내지 않고 lease 만료에 맡긴다.
- compact: Claude Code 문서의 SessionEnd `reason`은 `clear`·`resume`·`logout`·`prompt_input_exit`·`other`이며 compact는 SessionStart(`compact`)만 보낸다. 그래서 reason으로 거르지 않는다. 실호스트 확인 결과는 구현 보고에 적는다.
- relay의 release 경로는 그대로다. 둘 중 먼저 끝낸 쪽의 `end_reason`이 남는다. SessionEnd가 먼저면 relay는 다음 tick에서 `ended:true`를 받고 실패 기록 없이 끝난다.
- Codex(2026-11-02, 실호스트 매트릭스 27d29452): Codex 어댑터는 호스트 PID를 `--host-pid`에서만 받는다. 그런데 Codex의 SessionEnd 명령(`hooks/hooks.json`)에 그 인자가 없어서, Codex SessionEnd는 아무 세대도 끝내지 못했다. 이제 SessionStart·UserPromptSubmit과 같은 `--host-pid`를 넘긴다. Codex 공식 문서(learn.chatgpt.com/docs/hooks)에 따르면 SessionEnd는 main thread에서 실행된다. 열린 대화를 archive·삭제할 때, Codex가 정상 종료할 때, 그리고 어떤 클라이언트에서도 열려 있지 않은 채 30분 동안 쉬었을 때다. 다른 대화로 옮기는 것만으로는 바로 끝나지 않는다. payload의 `session_id`는 끝나는 그 thread다. `/clear`는 SessionStart `source:"clear"`로 새 세션을 알리지만, 문서는 바뀐 이전 thread를 이름으로 알리지 않고 그 thread가 그 시점에 끝난다고도 하지 않는다. 그래서 clear 시점에 같은 프로세스의 다른 세대를 끝내지 않는다. Codex app-server는 한 프로세스에서 여러 thread를 띄우므로 그렇게 하면 살아 있는 thread를 끝낼 수 있다. 이전 thread는 Codex가 그 thread의 SessionEnd를 보낼 때 끝난다.
