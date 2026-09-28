# 2.7.3 메시지 큐 보존 한도(Q·receipt) 수정 설계

- 지시: 총괄 ca8e3dc4, 읽기 전용 분석. 이 브랜치에는 설계 문서와 scratch 시제품만 있고, 제품 소스·테스트·설정은 바꾸지 않았다.
- 기준: `main` `8763cef2b11f2635d6c9af7861b5bffd496e2a30`(v2.7.2). 아래 `파일:줄`은 모두 이 commit 기준이다.
- 입력: `docs/release-notes-v2.7.2.md:13`의 알려진 한계, `claude/evidence-wake53-msgqueue-idem-20260928T075615Z`의 `wake53-msgqueue-idem/REPORT.md`(O1·O2, 53eff30과 v2.7.1에서 측정).
- 환경: Linux cloud 컨테이너, Node v24.21.0(SHASUMS256 검증), pnpm 11.19.0, `pnpm install --frozen-lockfile`.
- 병행 작업: `claude/v273-wake-liveness`, `claude/v273-intake`는 조회만 했다. 조회 시점에 두 브랜치 모두 `main` 대비 commit이 없었다.
- 지시문이 "Q-O6: 같은 OS 사용자 한계와 일치. 별도"에서 끊겨 있었다. 이 문서는 O6를 범위 밖으로 보고, O1·O2의 문서 보완이 끝났다는 리드 판단을 전제로 한다. 진단 문구 개선은 리드 판단대로 별도 항목(§6 D1)으로 분리했다.

## 1. 결론

v2.7.2의 한계는 영수증 수가 아니라 **영수증 보존 기간과 소유 단위**에서 생긴다. 2.7.3의 핵심 수정 세 가지를 권한다.

| # | 변경 | 해결하는 관측 | 계약 영향 |
|---|---|---|---|
| F1 | 발신자별 영수증 상한 `MESSAGE_SENDER_RECEIPT_LIMIT` 추가(권장 250, 전역 1000 유지) | O1: 한 발신자가 전역 풀을 채워 다른 발신자를 모두 막음 | 상한 추가. 한 발신자의 최대 동시 영수증이 1000에서 250으로 줄어듦 |
| F2 | ACK 시 해당 영수증 만료를 `min(기존 만료, ACK + 1h)`로 줄임 | O1: 수신자가 모두 ACK해도 TTL+1h(최대 25h) 동안 풀이 차 있음 | ACK된 ID의 영수증 보존이 "메시지 만료+1h"에서 "ACK+1h"로 짧아짐. 이후 status는 `null`(unknown) |
| F3 | prepare 입장 검사: 발신자·전역 영수증 상한에 이미 닿았으면 draft를 만들지 않고 거절 | O2: 거절된 send의 draft가 쌓여 발신자 draft 한도 100을 채움 | prepare가 더 일찍 실패할 수 있음. 기존 테스트 1건의 기대값 변경 |

세 변경 모두 기존 테이블 컬럼만 사용하므로 schema 이관이 없다. 불변식 "같은 ID는 두 번 삽입되지 않는다"는 prepared 행이 없으면 send를 거절하는 기존 규칙(`mcp-server/src/session-message-store.ts:303-305`)에 기대므로, 영수증을 더 일찍 지워도 성립한다(§4).

## 2. 현재 동작과 원인 (v2.7.2)

| 규칙 | 위치 |
|---|---|
| 전역 영수증 상한 1000, 발신자 구분 없음 | `session-message-store.ts:18`, `:311-312` |
| 영수증 만료 = 메시지 만료 + 1h, ACK와 무관 | `:20`, `:315`, `:319-320` |
| ACK는 `messages`만 갱신, `prepared_messages`는 건드리지 않음 | `:513-530` |
| ACK된 메시지 행은 ACK+1h에 prune, 영수증은 계속 남음 | `:256`, `:266` |
| 발신자 draft 100·전역 draft 1000, draft 10분 | `:15-17`, `:282-285` |
| 영수증 상한 거절은 draft를 남긴 채 rollback | `:311-312`, `:323-325` |
| service는 거절을 `MCP_UNAVAILABLE` + "같은 ID만 재시도, 다시 prepare 금지"로 매핑 | `session-message-service.ts:53-60` |
| client는 broker의 업무 거절을 재시도하지 않음 | `session-message-client.ts:25`, `:188`, `:246` |

원인은 두 가지다.

1. 수신자가 ACK해 spool(`messages` 미ACK 1000, `:360-361`)이 비어도 영수증은 메시지 만료+1h까지 전역 1000을 차지한다. 기본 TTL에서는 2h, TTL 86400에서는 25h 동안 모든 발신자가 막힌다.
2. 영수증 상한 거절은 확정적 무효과인데도 draft가 남고, 안내는 "다시 prepare 금지"다. draft는 10분 뒤 만료되고 용량은 그보다 늦게 풀리므로, 새 의도로 prepare를 반복하면 발신자 draft 100에 막힌다.

### 재현 (scratch 시제품, `prototype/retention.test.ts`)

| 사례 | 결과 |
|---|---|
| 한 발신자가 1200건 send 후 즉시 ACK(기본 TTL) | 1000 수락·200 거절, 미ACK spool 0. 다른 발신자는 ACK+1h+1ms와 2h−1ms에 거절, 정확히 2h에 수락 |
| 한 발신자가 TTL 86400으로 1000건 send | 다른 발신자는 25h−1ms까지 거절, 25h에 수락 |
| 위 상태에서 다른 발신자가 150회 prepare→send | 수락 0, 남은 draft 100 = `MESSAGE_SENDER_DRAFT_LIMIT` |

이 수치는 REPORT.md의 O1(E1 8 발신자 합산 1000 뒤 전부 거절)과 O2(same-sender draft 100)와 같은 경계다.

## 3. 변경 설계

모든 검사는 기존 `BEGIN IMMEDIATE` transaction 안에서 `prune(nowMs)` 뒤에 한다. 시제품은 검증 편의로 부모 메서드를 감쌌으므로 transaction이 나뉘어 있다. 실제 구현은 이 방식을 따르지 않는다.

### F1. 발신자별 영수증 상한

- 상수: `export const MESSAGE_SENDER_RECEIPT_LIMIT = 250;` (`session-message-store.ts:18` 옆).
- `submitPrepared`의 전역 검사(`:311-312`) 바로 앞에 같은 발신자의 `receipt IS NOT NULL` 개수를 세어 상한 이상이면 거절한다. 기존 index `prepared_messages_owner (sender_host, sender_session_id, receipt)`(`:206`)를 그대로 쓴다.
- 오류 문구는 전역 초과와 구별한다. 예: `"The bounded message receipt store is full for this sender."`. 기존 `/receipt store is full/` 정규식과 맞도록 앞부분은 유지한다.
- 값 250의 근거: 전역 1000의 1/4이므로 최소 네 발신자가 각자 한도를 다 쓸 수 있다. 한 orchestrator가 여러 worker에 동시에 보내는 일반적인 규모(수십 건)는 충분히 수용한다. 이 값은 공정성과 단일 발신자 처리량 사이의 조정값이므로 리드가 확정한다(대안: 200 또는 전역의 1/5).
- 이 상한은 보안 할당량이 아니다. 신원은 호출자가 주장한 `_sessionBinding`이므로(O6) 같은 OS 사용자는 세션 ID를 바꿔 우회할 수 있다. 협력하는 세션 사이의 공정성으로만 설명한다.
- 부수 효과: 공개 경로의 모든 미ACK 메시지는 영수증을 가지므로, 한 발신자의 미ACK spool 점유도 250 이하로 제한된다.

### F2. ACK에 결속한 영수증 만료

- `acknowledge`(`:513-530`)의 같은 transaction에서 실제로 ACK된 ID(`changes === 1`)만 대상으로 다음을 실행한다.

  ```sql
  UPDATE prepared_messages SET expires_at = min(expires_at, :ackPlus1h)
  WHERE message_id = :id AND receipt IS NOT NULL
  ```

  `:ackPlus1h`는 `iso(nowMs + 3600_000)`이며, 메시지 행의 ACK 보존(`:255-256`)과 같은 경계를 쓴다. 두 번째 ACK는 `changes = 0`이므로 만료를 다시 바꾸지 않는다.
- 대상 확인은 기존 ACK 조건(`target_host`, `target_session_id`, `acknowledged_at IS NULL`)으로 충분하다. 다른 세션의 ACK는 0건이므로 영수증을 줄이지 않는다(시제품 확인).
- `record_bytes`는 바꾸지 않는다. 본문은 이미 send 때 제거됐다(`:319`).
- 결과: ACK된 메시지의 영수증은 ACK+1h에 메시지 행과 함께 사라진다. ACK되지 않은 메시지는 기존대로 메시지 만료+1h까지 `submitted/deliveryState unknown`을 보여 준다.
- 관찰 가능한 변화: ACK+1h 이후 같은 ID로 send하면 `duplicate:true` 대신 "Issued message ID is unavailable" 거절, status는 `null`이다. 문서의 "unknown ID는 전송이 없었다는 증거가 아니다" 계약(`docs/session-message-lifecycle.md:21`) 안에 있는 변화지만 릴리스 노트에 명시한다.
- 경계: 이미 만료됐지만 아직 prune되지 않은 행의 ACK(O4 계열)도 `min`이므로 만료를 늘리지 않는다.

### F3. prepare 입장 검사

- `prepare`의 draft 검사(`:282-285`)와 같은 transaction에서 발신자 영수증 수가 `MESSAGE_SENDER_RECEIPT_LIMIT` 이상이거나 전역 영수증 수가 `MESSAGE_RECEIPT_LIMIT` 이상이면 draft를 만들지 않고 거절한다.
- 문구는 draft 한도와 구별한다. 예: `"The bounded message receipt store is full; no draft was created."`.
- 이 검사는 권고 수준이다. prepare와 send 사이에 용량이 찰 수 있으므로 send의 검사(F1, `:311-318`)는 그대로 권위 검사로 남는다. 반대로 prepare 거절 직후 용량이 풀리면 호출자가 다시 prepare하면 된다(이전 draft가 없으므로 중복 위험이 없다).
- 남는 경우: prepare와 send 사이에 용량이 찬 draft는 최대 10분 남는다. 이는 발신자별 in-flight draft이며 F1 때문에 다른 발신자에 영향을 주지 않는다.
- 대안(권장하지 않음): 용량 거절 시 draft 삭제. 같은 ID 재시도 안내(`session-message-service.ts:60`)와 충돌하고, 응답 유실 뒤 재시도가 "unavailable"로 바뀌어 진단이 더 모호해진다.

## 4. 불변식 검토

| 불변식 | 변경 뒤 근거 |
|---|---|
| 같은 ID가 두 번 삽입되지 않음 | `submitPrepared`는 prepared 행이 없으면 거절(`:303-305`). F2로 영수증이 먼저 사라져도 삽입 경로가 없다. 메시지 행과 영수증은 같은 시각(ACK+1h, 둘 다 `<=`)에 prune된다. 시제품에서 ACK+1h send 거절 뒤 두 번째 행 0건 확인 |
| 거절은 상태 무변화 | F1·F3 거절은 기존과 같이 transaction rollback. 이때 transaction 안의 `prune`도 함께 rollback된다(기존 동작, 시제품에서 관측). 다음 호출의 prune이 정리하므로 무해 |
| 수락된 메시지 유실 0 | F2는 ACK된 메시지에만 적용되고 `messages` 행 보존 규칙(`:256`)은 그대로다 |
| 미만료 기록을 강제로 지우지 않음 | F2는 만료 시각을 계약에 따라 재계산할 뿐 eviction이 아니다. 문서 표(`docs/session-message-lifecycle.md:26`)를 갱신해 새 보존 규칙을 계약으로 만든다 |
| 다른 세션이 남의 메시지에 영향 못 줌 | F2는 target 조건을 통과한 ACK에만 적용. 단 O6 한계(호출자 주장 신원)는 그대로다 |
| 혼합·하향 버전 | schema 변경 없음. v2.7.2 broker가 같은 DB를 열면 줄어든 `expires_at`을 그대로 따라 더 일찍 prune할 뿐이다. 발신자 상한은 적용되지 않는다. 혼합 실행 보장은 기존처럼 범위 밖 |

## 5. 구현·검증 계획 (2.7.3 구현 세션용)

변경 파일(예상):

- `mcp-server/src/session-message-store.ts`: 상수 1개, `prepare`, `submitPrepared`, `acknowledge`.
- `tests/session-messaging/message-lifecycle.test.ts`: `:131`의 "applies global draft, receipt and byte backpressure" 사례는 영수증이 가득 찬 상태의 `prepare(store, 602_001)` 성공을 전제로 한다. F3 뒤에는 prepare가 거절되므로, 기대값을 "prepare 거절, draft 0"으로 바꾸고 send 단계 거절은 prepare와 send 사이에 용량을 채우는 순서로 따로 검증한다. 이 사례의 1000 발신자 루프는 발신자별 상한에 걸리지 않는다(발신자마다 1건).
- `mcp-server/dist/*` 재생성(`pnpm build`), `pnpm bundle:check`로 신선도 확인. `claude-plugin/`은 공용 dist를 복사하므로 릴리스 준비 때 `pnpm claude:build`·`pnpm claude:check`.
- 문서: `docs/session-message-lifecycle.md:25-31` 표와 상한 설명, `docs/release-notes-v2.7.3.md`(알려진 한계 문단 갱신), 필요하면 `README.md`·`README.en.md`의 해당 문구.

추가 테스트(정상·경계·실패):

1. 발신자 A가 상한까지 send한 뒤 A의 다음 send·prepare는 거절, B의 send는 수락(F1·F3).
2. 상한 −1, 정확히 상한, 상한 +1 경계.
3. ACK 시각 T에서 영수증 만료가 `min(E+1h, T+1h)`인지, T+1h−1ms에는 `duplicate:true`와 `acknowledged`, T+1h에는 거절과 `null`인지(F2).
4. 다른 세션의 ACK, 두 번째 ACK, 모르는 ID ACK는 영수증 만료를 바꾸지 않음.
5. 미ACK 메시지의 영수증은 여전히 E+1h까지 `submitted/unknown`.
6. 두 연결(별도 프로세스)이 같은 발신자로 상한 직전에 동시 send → 수락 합계가 상한을 넘지 않음. 기존 child-process 경합 하네스를 쓴다(AGENTS.md의 SQLite 경합 요구).
7. 동시 send와 ACK 경합에서 같은 ID 1행, 만료는 단조 감소만.
8. 기존 v2.7.2 DB(영수증 만료가 E+1h로 기록된 ACK 행)를 열었을 때 이관 없이 동작하고, 새 ACK부터만 규칙이 적용됨(소급 없음 명시).

전체 검증은 AGENTS.md 순서를 따른다: `pnpm install --frozen-lockfile` → `pnpm bundle:check` → `pnpm claude:drift` → `pnpm lint` → `pnpm build` → `pnpm test` → `pnpm runtime:check` → `pnpm validate:all` → `pnpm validate:official` → `git diff --check`.

병행 브랜치와의 충돌: `claude/v273-wake-liveness`도 `session-message-store.ts`를 바꿀 가능성이 높다. 이 설계는 `prune`의 wake 부분(`:258-265`)과 wake 메서드를 건드리지 않고 `prepare`·`submitPrepared`·`acknowledge`만 바꾼다. 문맥 충돌은 `:18` 근처 상수 추가와 `prune` 인접 영역에서만 예상된다. 통합 순서는 리드가 정한다.

## 6. 범위 밖과 별도 항목

| # | 항목 | 판단 |
|---|---|---|
| D1 | 진단: 용량 거절을 "확정 무효과, 큐에 들어가지 않음"으로 표시하고 `details`에 `scope`(sender/global)와 가장 이른 해제 시각을 넣기. 현재 service는 `details: null`이고 send 거절에 "다시 prepare 금지"를 덧붙인다(`session-message-service.ts:14-16`, `:60`) | 리드 판단대로 별도 항목. 다만 F3 없이 이 문구만 남으면 O2가 재발하므로, D1을 미루더라도 F3는 2.7.3에 넣는 것을 권한다. 새 `ErrorCode` 추가는 공용 계약 변경이므로 피하고 `details`만 쓰는 방식을 권한다 |
| D2 | 대상별 미ACK 상한(죽은 대상에 여러 발신자가 긴 TTL로 보내 spool 1000을 채우는 경우) | 큐 공정성 확장. F1으로 발신자당 250으로 줄지만 네 발신자면 여전히 가득 찬다. 2.7.3에서는 보류하고 한계로 남긴다 |
| D3 | 전역 상한(1000, 4 MiB) 상향 | 수용량 변경. F1·F2 뒤 실측이 필요할 때 검토 |
| D4 | 발신자의 미ACK 메시지 취소 | 새 상태 전이와 도구가 필요하다. 범위 밖 |
| O6 | 신원이 호출자 주장인 점 | 같은 OS 사용자 신뢰 경계와 일치. 범위 밖 |

2.7.3 릴리스 노트에 남길 한계(초안): "발신자별 영수증 상한은 협력하는 세션 사이의 공정성 장치이며 신원 인증이 아닙니다. ACK되지 않은 긴 TTL 메시지는 여전히 메시지 만료 후 1시간까지 발신자 상한을 차지하고, 여러 발신자가 응답하지 않는 대상에 보내면 전역 수신 큐가 찰 수 있습니다. ACK 후 1시간이 지난 ID는 status에서 확인되지 않습니다."

## 7. 실행한 검증

| 명령 | 결과 |
|---|---|
| `vitest run --root <scratchpad>/proto` (`prototype/retention.test.ts`) | 7 passed. 기준 동작 3건 재현, 설계안 4건 확인 |
| `vitest run tests/session-messaging/message-lifecycle.test.ts` (수정 없는 main) | 14 passed |

첫 시제품 실행에서 1건이 실패했다. 거절된 `submitPrepared` transaction이 내부 `prune`까지 rollback해 ACK된 옛 행 1개가 남은 것을 "행 0개"로 단언한 탓이다. 두 번째 행이 없음을 확인하는 단언으로 고쳐 재실행했다. 이 결과는 제품 결함이 아니며 §4에 기록했다.

실행하지 않은 것: 저장소 전체 검증 순서, 다중 프로세스 경합 시험, Windows, 실제 Codex·Claude Code 호스트. 시제품은 부모 메서드를 감싼 구조라 transaction 원자성을 검증하지 않는다.
