# 2단계: wake 수명주기·reconcile 쓰기 지점과 transaction 경계 (e9b4c73 기준 줄 번호)

53eff30a와 e9b4c73의 차이는 `reconcileHistoricalWake`(추가), broker의 `reconcile-wake-observation` 분기(추가), prune 기산점(`coalesce(consumed_at, …)`), `TrustStore.readVerifiedInputSource`(추가)뿐입니다. 아래 줄 번호는 e9 기준이며, 53에서는 reconcile 관련 행이 없고 `claimHostWake`가 약 44줄 위(823~)에 있습니다. 원시 grep 결과는 `10-write-points-grep.log`에 있습니다.

| 단계 | 호출 경로 (프로세스) | 쓰기 지점 (파일:줄) | transaction 경계 |
|---|---|---|---|
| DB open/이관 | broker 시작 | `session-message-store.ts:131-132` busy_timeout, `journal_mode=WAL`; `:133-189` `CREATE TABLE/INDEX IF NOT EXISTS` (autocommit, 트랜잭션 밖) | `:190` BEGIN IMMEDIATE → ALTER/`wake_active_target` UNIQUE index → `:242` COMMIT / `:244` ROLLBACK |
| reserve | relay `session-message-relay.ts:70` → broker `reserve-wake` (`session-message-broker.ts:381-386`) → `reserveManagedWake` `:712` | prune DELETE들(`:253-266`, tx 안 `:720`), `:727` started→unknown (lease 교체 fencing), `:734` reserved relay_id 이관, `:746` INSERT reserved | `:718` BEGIN IMMEDIATE … `:753` COMMIT / `:755` ROLLBACK |
| start | relay `:73` → `start-wake` → `startManagedWake` `:759` | `:771` reserved→not-submitted, `:775` reserved→started, `dispatch_epoch+1`, `started_at` | `:760` BEGIN … `:768/:773/:777` COMMIT / `:779` ROLLBACK |
| dispatch (외부 effect) | relay `:76` `port.dispatch` | DB 쓰기 없음 (커밋된 start 뒤에만 호출) | 트랜잭션 밖 |
| outcome | relay `:78` → `record-wake-outcome` → `recordManagedWakeOutcome` `:782` | `:792` state=submitted/unknown/reserved(backoff), outcome_at, retry_* (`late_observed_at IS NULL`인 행만) | `:784` BEGIN … `:795` COMMIT / `:796` ROLLBACK |
| hook 도착: receipt | hook 프로세스 `session-message-hook.ts:202` → `session-message-wake-port.ts:135-143` → `trust-store.ts:65` `recordInputSource` | trust DB `input_source_receipts` INSERT (TrustStore 생성자의 schema init `trust-store.ts:197-217`, secret `:233-236` 포함) | trust DB: `:198` BEGIN IMMEDIATE…`:217` COMMIT, `:233` BEGIN IMMEDIATE…`:236` COMMIT (메시지 DB와 별개) |
| hook 도착: claim | hook → `claim-host-wake` (`broker.ts:244-271`) → `claimHostWake` `:860` | `:869` receipt 검증(broker 안에서 trust DB를 쓰기 모드로 열어 schema init/secret tx 실행), `:882-886` 다른 세대 도착은 late+observed로 은퇴, `:888` `claimLocked`(`:382` UPDATE messages claimed/claim_until), `:893` observed/consumed_at | `:867` BEGIN IMMEDIATE (메시지 DB) … `:869/:873/:886/:898` COMMIT / `:899` ROLLBACK. trust DB 쓰기 tx가 메시지 DB tx **안에서** 따로 열리고 닫힘 |
| claim/ACK | `acknowledge` → `:511` | `:516` UPDATE messages acknowledged_at | `:519` BEGIN … `:522` COMMIT |
| relay tick | `relay-tick` → `relayTick` `:616` | relay/presence heartbeat UPDATE | `:619` BEGIN … `:630` COMMIT (조건 불충족은 `:624` ROLLBACK) |
| presence | `presence-start` → `startPresence` `:902` | UPSERT 한 문장 (새 instance_id = 새 generation) | autocommit |
| reconcile 적용 (e9만) | CLI `reconcile-wake-observation` → `broker.ts:405-413` → `reconcileHistoricalWake` `:816` | `:831` 후보 SELECT, `:839` `verifyHistoricalWakeObservation` (trust DB를 `readOnly`+`query_only`+`BEGIN`으로 읽음, `trust-store.ts:159-170`, 쓰기 없음), `:842` state unknown→observed CAS UPDATE (원래 binding·epoch·late 전 필드 재확인) | `:830` BEGIN IMMEDIATE … `:837/:840/:849` COMMIT / `:856` ROLLBACK. 검증 읽기는 메시지 DB 쓰기 잠금을 잡은 상태에서 실행 |

주: `reserveWake`(구 경로, `:638`)와 `prune`(`:253`)은 트랜잭션 밖에서도 호출됩니다(`pendingCount` `:580`, `acquireRelay` `:592` 등). 이 경로의 DELETE는 autocommit 한 문장입니다.
