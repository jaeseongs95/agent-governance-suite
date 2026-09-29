# CASE=wake-271-state-upgrade — 2.7.1 운영 상태를 53eff30a가 여는 일회용 실험

- 기준(2.7.1): d5c5932cd5a0d87630f6ed94f8e3721181ab9864 (/tmp/v271)
- 대상: 53eff30a2984d41fc749d38dd2062966017684fa, tree c030fa4e19411ef511c5d5c89cf588aa6f42c059 (/tmp/v53, tree 일치 확인)
- 환경: Linux cloud 컨테이너 1개, Node v24.21.0(SHASUMS256 검증 tarball), pnpm 11.19.0. **사용자 운영 DB는 없고 /tmp 아래 일회용 상태만 사용했다. 사용자 PC 운영 상태·live host 증거가 아니다.** 실제 host(codex queue/Claude inbox)는 호출하지 않았고, hook 도착은 `adaptHostInput` + `recordWakeHookObservation`(실제 hook 경로와 같은 receipt 발급 함수)으로 합성했다.
- 시각은 모든 store 호출에 명시 nowMs로 주었다(base = 실행 시각 −3h, TF = base+61분).

## 단계별 결과

| 단계 | 내용 | 결과 | 근거 |
|---|---|---|---|
| 1 | fetch, worktree 2개, install+build | 둘 다 EXIT=0, 빌드 후 worktree clean | 01,04–07,20 |
| 2 | 코드 읽기, 재현 절차 | 2.7.1은 `!valid` 도착을 `state='unknown'+late_observed_at`으로 남김(store.ts:835-838), 활성 행이 있으면 reserve가 새 행을 만들지 않음(:722-737, unique index :240). 53은 같은 분기에서 `observed`로 종료(:836-841). 스키마 코드 변경 없음 | 08, 10 |
| 3 | 2.7.1로 /tmp/state-271 생성 | T1–T6 전부 새 세대(또는 TTL 후) `reserveManagedWake` dispatch=false, presence 모두 online. 대조 T0은 dispatch=true | 12 |
| 3 부수 | T4 crash 행: 새 세대 reserve가 started→unknown, 이후 옛 attempt의 늦은 `submitted` outcome을 2.7.1이 수락해 unknown→submitted로 바뀜(여전히 활성) | 관측 | 12 `3.t4-late-outcome-271` |
| 4 복사 | live snapshot(연결 열린 채 BEGIN IMMEDIATE 중 복사, DB+WAL+SHM) → /tmp/state-53 | sha256 동일 | 13 |
| 4a | 53 생성자로 열기 전·후 스키마 | 완전 동일(객체·열·user_version 0·journal wal). 생성자 open에서 main·WAL bytes 불변, SHM만 변경 | 14, 18, 17 |
| 4b | 열기만 한 직후 상태 | 옛 행 7개 상태 그대로(변화 없음) | 16 `4b.status-after-open-no-action` |
| 4b | ACK(T1), 세대 재교체(T1 inst-3), WAKE_TTL+60s 경과 + prune(전체) | T1·T3·T4·T5 해제 안 됨, 새 reserve false. 표시만 pending→observation-overdue | 16 `4b.*` |
| 4c | 열기 직후 새 wake admission | T1–T6 전부 false | 16 `4c.*` |
| 4d− | T1에 mixed nonce / 미등록 receipt / 30s 지난 receipt / 잘못된 target | 전부 recognized=false, T1은 unknown 유지(종료 근거 아님) | 16 `4d-.*` |
| 4d | T2(옛 세대 submitted)에 검증된 옛 도착 | recognized=false, messages 0, binding null, T2만 observed(observedAt=lateObservedAt), 다른 target 변화 없음. 옛 attempt 늦은 outcome 거절, 같은 receipt 재생 거절. 이어 새 세대 reserve·start 성공, 현재 세대 도착이 새 본문 1건 claim | 16 `4d.*` |
| 4d 합성 | T6(2.7.1이 이미 late→unknown 처리)에 **같은 marker 재도착을 합성** | observed로 종료 후 새 reserve true. 실제로는 marker가 이미 한 번 소비돼 재도착을 기대하기 어렵다 | 16 `4d.synthetic-rearrival-T6` |
| 4e | 단계별 wake 관련 행 dump | rows/53-*.json, rows/271-final.json | rows/ |
| 5 | 읽기 전용 open(node:sqlite readOnly), 3가지 복사본 | 아래 표 | 19 |

### 단계 5: 읽기 전용 open

| 복사본 | main DB bytes | WAL | SHM | 논리 내용(all_sha256) |
|---|---|---|---|---|
| live snapshot(DB+WAL+SHM) | 불변 | 불변 | **변경**(a6536e…→c60aec…) | cc0fb1e7…, 2회 동일 |
| clean close(DB만) | 불변 | **생성**(0 bytes, close 후 남음) | **생성**(32768, 남음) | cc0fb1e7… |
| WAL만 있고 SHM 없음 | 불변 | 불변 | **생성** | cc0fb1e7… |
| 참고: 53 쓰기 생성자 open→close(live snapshot) | checkpoint로 변경(→16b7c0a2…, 2.7.1 clean close 파일과 byte 동일) | 삭제 | 삭제 | cc0fb1e7… |

읽기 전용 연결의 쓰기 probe는 `attempt to write a readonly database`로 거절. 논리 내용은 네 경우 모두 같다. 읽기 전용 open도 sidecar(-shm, 빈 -wal)를 만들거나 바꾸므로 "파일 무변경"을 원하면 복사본에서 열어야 한다.

## 53eff30a로도 남는 운영 행 (= historical reconcile 대상)

53eff30a에는 open·migration 때 옛 행을 재분류하는 코드가 없다. 해제 경로는 **새로 도착한 검증된 hook marker**뿐이다.

| 유형 | 조건(wake_nonces) | 실험 target | 53에서 해제 조건 |
|---|---|---|---|
| R1 2.7.1 late-unknown | `state='unknown' AND late_observed_at IS NOT NULL` | T3(세대 교체 뒤 도착), T6(TTL 뒤 도착) | 같은 marker의 새 검증 도착뿐. 2.7.1이 이미 `verifyObservation` 통과(:825) 뒤에만 late_observed_at을 기록했으므로 도착 증거가 DB에 있다. 이 행이 가장 확실한 reconcile 대상 |
| R2 옛 세대 미관측 | `state IN ('unknown','submitted') AND late_observed_at IS NULL` + (instance_id, birth_generation, transport) ≠ 현재 presence | T1(unknown), T2(submitted), T4(crash→unknown→늦은 outcome으로 submitted) | 옛 marker가 실제로 도착하면 해제(T2로 확인). host가 marker를 버렸으면 영구 잔존 |
| R3 같은 세대 만료 미관측 | `state IN ('unknown','submitted') AND expires_at <= now AND late_observed_at IS NULL`, 세대는 현재와 같음 | T5, (TTL 뒤) T0 | 검증된 도착만. status는 observation-overdue |
| R4 started 잔존 | `state='started'`, 옛 세대 | T4 초기 | 다음 reserve가 unknown으로 바꿀 뿐 해제 안 됨 → R2 |

ACK, 본문 TTL, WAKE_TTL 경과, prune, 세대 재교체는 어느 유형도 해제하지 않았다(설계 의도와 일치: docs "실제 도착이 없는 unknown은 ACK·세대 교체·lease·TTL만으로 해제하지 않는다").

## NOT_RUN / 한계
- 실제 Codex·Claude host wake, 설치 캐시, broker 프로세스(TLS)는 실행하지 않았다(범위 밖). store API를 직접 호출했다.
- 사용자 PC 운영 DB는 이 환경에 없다. 이 결과는 합성 이력이다.
- 첫 시도 2회는 스크립트 결함으로 다시 실행했다: attempt1은 nonce 길이 부족으로 중단, attempt2는 T5/T6 heartbeat 공백으로 presence lease가 끊겨 T5/T6 결과가 오염됐다. 두 로그는 `*-attempt1-*`, `*-attempt2-*`로 보존했고 최종 결과는 12–19번이다.
- trust.sqlite3(실험용 HMAC 서명 키 포함)는 증거에서 제외하고 sha256만 db/SOURCE-HASHES.txt에 남겼다.

## 재현
```
export AGENT_GOVERNANCE_TRUST_DB_PATH=/tmp/state-271/trust.sqlite3
cd /tmp/v271 && node_modules/.bin/tsx /tmp/ev/scripts/build-271-state.mjs /tmp/v271 /tmp/state-271
cp -a /tmp/state-271-live-snapshot /tmp/state-53
AGENT_GOVERNANCE_TRUST_DB_PATH=/tmp/state-53/trust.sqlite3 bash -c 'cd /tmp/v53 && node_modules/.bin/tsx /tmp/ev/scripts/open-with-53.mjs /tmp/v53 /tmp/state-53'
cd /tmp/v53 && REF_DIR=<copy> node_modules/.bin/tsx /tmp/ev/scripts/readonly-open.mjs /tmp/v53 <copies...>
```
스크립트: scripts/lib.mjs, scripts/build-271-state.mjs, scripts/open-with-53.mjs, scripts/readonly-open.mjs
