# J2 보고: e9b4c73 reconcile 변조 행렬 + trust 경로 F1 실제 프로세스 재현 (CASE=e9-tamper-trustpath)

- 대상: `e9b4c73b2ff4294c68c6490411fbc6118c69c8c8` (codex/wake-history-reconcile), tree `4316195bbb2cdade6efa1a62150e33358ef60a7c` 확인(03-worktree.log), parent `53eff30a…`.
- 환경: Linux cloud 컨테이너 1대, root 사용자(권한 사례는 uid 65534로 따로 실행), Node v24.21.0(SHASUMS256 검증, 02-node.log), pnpm 11.19.0.
- 일회용 실험이다. 사용자 PC의 운영 상태나 live 증거가 아니다.
- 준비: `pnpm install --frozen-lockfile` → `pnpm bundle:check`(EXIT=0) → `pnpm build`(EXIT=0). 설치 트리는 `git archive`로 만든 `/tmp/install/codex`, `/tmp/install/claude`이며 둘 다 `node_modules`가 없다(28-no-node_modules.log).
- 기존 회귀 테스트 `tests/session-messaging/historical-wake.test.mjs`: 45/45 통과(30-vitest-historical-wake.log). 기존 CLI 테스트는 `AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR`와 `AGENT_GOVERNANCE_TRUST_DB_PATH`를 같은 디렉터리로 함께 지정하므로 F1을 덮지 않는다.

## 요약

| 항목 | 판정 |
|---|---|
| F1 코드 확인 (broker 476–477 ↔ reconcile 405–412 → store 816–839 → wake-port 111–114) | **확인됨** |
| F1 (a1) broker가 결속한 R/trust에 유효 증거가 있고, 기본 경로에는 다른 trust DB가 있음 | **FAIL**: 유효 history를 거절함(잘못된 DB 조회, false negative) |
| F1 (a2) 유효 증거가 결속되지 않은 기본 경로 trust에만 있음 | **FAIL**: broker의 wake reader에 결속되지 않은 DB의 증거로 `unknown`을 해제함(`reconciled:true`) |
| F1 (b) 기본 경로에 trust DB 없음 | 안전 쪽 PASS: 거절하고 기본 경로 디렉터리·DB를 만들지 않음. 다만 R의 유효 증거를 거절함(가용성 FAIL은 a1과 같은 원인) |
| F1 (c) R = 기본 state 디렉터리 | PASS: 수락, 재실행 시 거절 |
| F1 (c2) 공개 CLI가 broker를 자동 기동(env 상속) | PASS: 경로가 일치하고 수락함. 즉 F1은 broker의 `--state-directory`가 broker 프로세스 env에서 도출한 기본 경로와 다를 때만 드러난다 |
| 변조·실패 행렬(in-process, 81건) | PASS 77 / **FAIL 1** (`db-trust-user_version-99`) / OBSERVE 3 |
| 실제 프로세스 부분 행렬(설치 CLI+broker, codex 8건 + claude 5건) | `trust-user_version-99`가 두 설치 트리에서 모두 **FAIL**. 나머지는 불변식을 지킴 |
| MCP 진입점 | 두 설치 트리의 `tools/list` 28개 중 reconcile·wake·history 도구가 없다. MCP 경로의 F1은 해당 없음(NOT_APPLICABLE, 29-mcp-tools-list.log) |

잘못된 unknown 해제(판정 기준: broker 결속 trust가 아니거나 지원 범위 밖 schema의 증거로 해제한 경우)는 2종이다. F1-a2와 user_version=99가 여기에 해당한다. 모든 사례에서 현재 claim·enqueue·dispatch는 0이었다(`messages.claimed_at`=null, `delivery_attempts`=0, 새 `reserved/started` wake 행 없음). 없는 trust DB나 key를 만든 사례도 0건이다.

## 1. F1 코드 확인

- `session-message-broker.ts:476-477`: `createWakeHookObservationReader(env.AGENT_GOVERNANCE_TRUST_DB_PATH ? … : path.join(stateDirectory, "trust.sqlite3"))`. 현재 wake reader는 `--state-directory R`의 `R/trust.sqlite3`에 결속된다.
- `session-message-broker.ts:405-412`: `reconcile-wake-observation` → `store.reconcileHistoricalWake(identity, attemptId, sourceReceiptId, Date.now())`. 이때 `verify` 인자는 기본값이다.
- `session-message-store.ts:816-817`: `verify = verifyHistoricalWakeObservation`, `:839` `verify(target, nonce, …, nowMs)`에는 경로 인자가 없다.
- `session-message-wake-port.ts:111-114`: `databasePath = resolveTrustDatabasePath()`. 이 값은 `AGENT_GOVERNANCE_TRUST_DB_PATH`이거나, 없으면 `resolveSessionMessageStateDirectory(process.env)/trust.sqlite3`이다. broker의 `--state-directory`를 보지 않는다.
- 공개 CLI(`session-message-cli.ts`)는 `--state-directory`를 받지 않고 env로 R을 정한다. 자동 기동하는 broker에는 같은 env를 넘긴다(`sessionMessageBrokerEnvironment`). 그래서 자동 기동 경로에서는 두 경로가 같다(c2). 두 경로가 갈리는 경우는 broker가 `--state-directory R`로 기동됐는데 broker env가 R을 가리키지 않을 때다(직접 기동, 다른 env에서 기동된 broker를 공유하는 경우 등).

## 2. F1 실제 프로세스 재현 표

공통 조건: `HOME=/tmp/f1/<case>/home`. 기본 trust는 `D=$HOME/.agent-governance-suite/session-messaging/trust.sqlite3`다. broker는 `env -i PATH HOME node <INST>/mcp-server/dist/session-message-broker.mjs --state-directory R`로 기동했다. broker env에는 `AGENT_GOVERNANCE_*` 키가 0개이며 `/proc/<pid>/environ`에서 확인했다. CLI는 `echo '<json>' | env -i PATH HOME AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR=R node <INST>/mcp-server/dist/session-message-cli.mjs`로 실행했다. `AGENT_GOVERNANCE_TRUST_DB_PATH`는 broker와 CLI 어디에도 지정하지 않았다. 내부 테스트 전용 ENV는 쓰지 않았다. fixture(세션 DB 행과 hook receipt)는 `scripts/seed.mjs`가 만든다. 기존 테스트 fixture와 같은 방식이며, v2.7.1 형태의 `late_observed_at`은 UPDATE로 넣었다.

| 조건 | 설치 트리 | 증거 위치 | 1차 CLI 출력 | 2차 | 행 dump(후) | 판정 | 로그 |
|---|---|---|---|---|---|---|---|
| a1: R 지정, D에 무관한 trust DB | codex | R/trust | `reconciled:false` | false | wake `unknown`, consumed null, 메시지 미claim | **FAIL**(유효 증거 거절, 다른 DB 조회) | 10, 15(claude 동일) |
| a2: R 지정, 증거가 D에만 있고 R/trust는 무관한 DB | codex | D/trust | **`reconciled:true`**, evidence.oldBinding attempt=해당 attempt | false | wake `observed`, observed_at=receipt 시각, consumed_at=reconciledAt, 메시지 미claim, obs 0 | **FAIL**(결속되지 않은 trust DB로 unknown 해제) | 11, 16(claude 동일), 최소 재현 31 |
| b: D 없음 | codex/claude | R/trust | `reconciled:false` | false | wake `unknown`; D 디렉터리가 생성되지 않음("default dir exists after: no") | 안전 PASS / 가용성 FAIL(a1과 같은 원인) | 12, 17 |
| c: R = D의 상위 디렉터리 | codex | R/trust(=D) | `reconciled:true` | false | wake `observed` | PASS | 13 |
| c2: CLI가 broker 자동 기동 | codex | R/trust | `reconciled:true` | false | wake `observed` | PASS(env 상속으로 경로 일치) | 14 |

DB 원본은 `db/f1-*.tgz`에 있다(세션 DB, 두 trust DB, seed.json).

## 3. 변조·DB 실패 행렬

방법: `scripts/matrix.mjs`. 사례마다 새 fixture 디렉터리를 만들고, 변조를 적용한 뒤 before/after 스냅샷을 비교한다. 비교 대상은 세션 DB의 `wake_nonces`, `messages`, `input_observations` 수, presence, trust DB의 논리 내용(key, schema, user_version, receipt), trust 파일별 sha와 크기다. 기본 호출은 broker와 같은 `dispatchSessionMessageBrokerOperation`이다. TTL 경계(ms 단위)는 `store.reconcileHistoricalWake(…, nowMs)`에 실제 `verifyHistoricalWakeObservation`을 넣어 호출했다. 이 harness는 in-process이며, 행렬 fixture의 trust 경로는 공개 설정 변수 `AGENT_GOVERNANCE_TRUST_DB_PATH`로 지정했다. "재서명(resigned)"은 DB의 실제 key로 HMAC을 다시 계산한 경우로, key를 가진 공격자 모델이다. "세션행 불변"은 accept 사례에서 false가 정상이다(대상 행이 observed로 바뀜).

receipt에는 key id 필드가 없다. 그래서 "key id" 항목은 `trust_metadata.key` 이름 변경, key 행 누락·교체·길이 16B·base64 손상으로 대신 시험했다.

| # | 사례 | 기대 | reconciled | 결과/예외 | 세션행 불변 | 메시지 claim/enqueue/dispatch 0 | trust 논리(키·receipt·schema) 불변 | trust 파일 변화 | 판정 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `control-valid` | accept | true | true | false | true | true | 없음 | PASS |
| 2 | `control-replay-second-call` | accept | true | 1st=true,2nd=false | false | true | true | 없음 | PASS |
| 3 | `mac-flip-one-char` | reject | false | false | true | true | true | 없음 | PASS |
| 4 | `mac-truncated` | reject | false | false | true | true | true | 없음 | PASS |
| 5 | `mac-missing` | reject | false | false | true | true | true | 없음 | PASS |
| 6 | `mac-empty` | reject | false | false | true | true | true | 없음 | PASS |
| 7 | `mac-field-changed-not-resigned` | reject | false | false | true | true | true | 없음 | PASS |
| 8 | `target-payload-session` | reject | false | false | true | true | true | 없음 | PASS |
| 9 | `target-payload-host` | reject | false | false | true | true | true | 없음 | PASS |
| 10 | `target-receipt-session-resigned` | reject | false | false | true | true | true | 없음 | PASS |
| 11 | `target-receipt-host-resigned` | reject | false | false | true | true | true | 없음 | PASS |
| 12 | `target-payload-extra-field` | reject | false | THROW: Historical wake reconciliation contains unsupported fields. | true | true | true | 없음 | PASS |
| 13 | `nonce-row-changed` | reject | false | false | true | true | true | 없음 | PASS |
| 14 | `nonce-row-and-digest-changed-consistently` | reject | false | false | true | true | true | 없음 | PASS |
| 15 | `nonce-row-null` | reject | false | false | true | true | true | 없음 | PASS |
| 16 | `nonce-receipt-for-other-nonce` | reject | false | false | true | true | true | 없음 | PASS |
| 17 | `nonce-receipt-multi-candidate` | reject | false | false | true | true | true | 없음 | PASS |
| 18 | `digest-altered-resigned` | reject | false | false | true | true | true | 없음 | PASS |
| 19 | `digest-missing-resigned` | reject | false | false | true | true | true | 없음 | PASS |
| 20 | `digest-uppercase-resigned` | reject | false | false | true | true | true | 없음 | PASS |
| 21 | `digest-other-normalization-actor` | reject | false | false | true | true | true | 없음 | PASS |
| 22 | `observed-before-start-1ms` | reject | false | false | true | true | true | 없음 | PASS |
| 23 | `observed-equals-start` | accept | true | true | false | true | true | 없음 | PASS |
| 24 | `observed-equals-late` | accept | true | true | false | true | true | 없음 | PASS |
| 25 | `observed-late+1ms` | reject | false | false | true | true | true | 없음 | PASS |
| 26 | `observed-future` | reject | false | false | true | true | true | 없음 | PASS |
| 27 | `observed-missing` | reject | false | false | true | true | true | 없음 | PASS |
| 28 | `observed-nonISO-parseable` | OBSERVE | false | false | true | true | true | 없음 | OBSERVE |
| 29 | `observed-offset-format-+00:00` | OBSERVE | true | true | false | true | true | 없음 | OBSERVE |
| 30 | `late-row-future` | reject | false | false | true | true | true | 없음 | PASS |
| 31 | `ttl-now=expires-1ms` | reject | false | false | true | true | true | 없음 | PASS |
| 32 | `ttl-now=expires` | accept | true | true | false | true | true | 없음 | PASS |
| 33 | `ttl-now=expires+1ms` | accept | true | true | false | true | true | 없음 | PASS |
| 34 | `ttl-expires=late-1ms` | reject | false | false | true | true | true | 없음 | PASS |
| 35 | `ttl-expires=late` | reject | false | false | true | true | true | 없음 | PASS |
| 36 | `ttl-expires=late+1ms` | accept | true | true | false | true | true | 없음 | PASS |
| 37 | `ttl-not-expired-future` | reject | false | false | true | true | true | 없음 | PASS |
| 38 | `ttl-expires-missing` | reject | false | false | true | true | true | 없음 | PASS |
| 39 | `gen-row-is-current-instance` | reject | false | false | true | true | true | 없음 | PASS |
| 40 | `gen-no-current-presence` | reject | false | false | true | true | true | 없음 | PASS |
| 41 | `gen-current-deleted-old-remains` | reject | false | false | true | true | true | 없음 | PASS |
| 42 | `gen-row-birth-null` | reject | false | false | true | true | true | 없음 | PASS |
| 43 | `gen-epoch-zero` | reject | false | false | true | true | true | 없음 | PASS |
| 44 | `gen-row-state-submitted` | reject | false | false | true | true | true | 없음 | PASS |
| 45 | `gen-row-late-null` | reject | false | false | true | true | true | 없음 | PASS |
| 46 | `gen-row-already-consumed` | reject | false | false | true | true | true | 없음 | PASS |
| 47 | `gen-started-at-after-observed` | reject | false | false | true | true | true | 없음 | PASS |
| 48 | `key-missing-row` | reject | false | false | true | true | true | 없음 | PASS |
| 49 | `key-rotated-not-resigned` | reject | false | false | true | true | true | 없음 | PASS |
| 50 | `key-other-key-signed-receipt` | reject | false | false | true | true | true | 없음 | PASS |
| 51 | `key-16byte-and-resigned` | reject | false | false | true | true | true | 없음 | PASS |
| 52 | `key-renamed-id` | reject | false | false | true | true | true | 없음 | PASS |
| 53 | `key-invalid-b64` | reject | false | false | true | true | true | 없음 | PASS |
| 54 | `receipt-missing-id` | reject | false | false | true | true | true | 없음 | PASS |
| 55 | `receipt-json-receiptId-mismatch` | reject | false | false | true | true | true | 없음 | PASS |
| 56 | `receipt-schemaVersion-changed-resigned` | reject | false | false | true | true | true | 없음 | PASS |
| 57 | `receipt-adapter-changed-resigned` | reject | false | false | true | true | true | 없음 | PASS |
| 58 | `receipt-authority-changed-resigned` | reject | false | false | true | true | true | 없음 | PASS |
| 59 | `receipt-origin-changed-resigned` | reject | false | false | true | true | true | 없음 | PASS |
| 60 | `receipt-attestation-missing-resigned` | reject | false | false | true | true | true | 없음 | PASS |
| 61 | `replay-other-session-receipt` | reject | false | false | true | true | true | 없음 | PASS |
| 62 | `replay-after-reconcile-other-attempt-id` | reject | false | false | true | true | true | 없음 | PASS |
| 63 | `replay-attempt-row-pruned` | reject | false | false | true | true | true | 없음 | PASS |
| 64 | `db-trust-missing` | reject | false | false | true | true | true | 없음 | PASS |
| 65 | `db-trust-dir-missing` | reject | false | false | true | true | true | 없음 | PASS |
| 66 | `db-trust-file-readonly-0444` | accept | true | true | false | true | true | 없음 | PASS |
| 67 | `db-trust-dir-readonly-0555-no-sidecars` | OBSERVE | true | true | false | true | true | 없음 | OBSERVE |
| 68 | `db-trust-other-proc-BEGIN-EXCLUSIVE` | accept | true | true | false | true | true | {"trust.sqlite3-shm":"REMOVED","trust.sqlite3-wal":"REMOVED"} | PASS |
| 69 | `db-trust-other-proc-locking_mode-EXCLUSIVE` | reject | false | false | true | true | true | {"trust.sqlite3-wal":"REMOVED"} | PASS |
| 70 | `db-session-other-proc-BEGIN-EXCLUSIVE-held-7s` | reject | false | THROW: database is locked | true | true | true | 없음 | PASS |
| 71 | `db-trust-main-header-corrupt` | reject | false | false | true | true | true | 없음 | PASS |
| 72 | `db-trust-user_version-99` | reject | true | true | false | true | true | 없음 | FAIL |
| 73 | `db-trust-table-renamed` | reject | false | false | true | true | true | 없음 | PASS |
| 74 | `db-trust-column-renamed` | reject | false | false | true | true | true | 없음 | PASS |
| 75 | `db-trust-metadata-dropped` | reject | false | false | true | true | true | 없음 | PASS |
| 76 | `db-trust-receipt-json-garbage` | reject | false | false | true | true | true | 없음 | PASS |
| 77 | `wal-control-receipt-only-in-wal` | accept | true | true | false | true | true | 없음 | PASS |
| 78 | `wal-corrupt-last-frame-byte` | reject | false | false | true | true | true | 없음 | PASS |
| 79 | `wal-corrupt-header` | reject | false | false | true | true | true | 없음 | PASS |
| 80 | `wal-truncated-mid-frame` | reject | false | false | true | true | true | 없음 | PASS |
| 81 | `wal-append-garbage` | accept | true | true | false | true | true | 없음 | PASS |

주: 20-matrix.log와 21-matrix-rerun.log는 harness 버그가 있던 이전 실행이다. 20에서는 `settle()`이 없는 DB를 열면서 새로 만들어 `db-trust-missing`이 거짓 FAIL로 나왔다. 21에서는 잠금 중 before 스냅샷이 실패했고 사후 읽기 전용 스냅샷이 -shm을 남겨 `locking_mode` 사례가 거짓 FAIL로 나왔다(22-shm-origin.log가 reader가 -shm을 남기지 않음을 보인다). 최종 판정은 23-matrix-final.log와 23-matrix-results.json을 따른다.

### OBSERVE 사례 해설
- `observed-nonISO-parseable`: `toUTCString()`은 ms를 버린다. 그래서 시각이 `started_at`보다 앞서게 되어 거절됐다. 형식 자체를 시험한 판별 사례가 아니다.
- `observed-offset-format-+00:00`: 재서명한 `…+00:00` 표기를 `Date.parse`로 받아들여 수락했다. 서명 key가 있어야 만들 수 있으므로 위조 경로는 아니다. 다만 hook은 항상 `Z` 형식을 만들기 때문에 형식 엄격성이 부족하다는 관측으로만 남긴다.
- `db-trust-dir-readonly-0555-no-sidecars`(in-process): root로 실행해 권한이 무력화됐고 수락됐다. 유효한 권한 시험으로 보지 않는다. 아래 nobody 실행으로 대체했다.

## 4. 실제 프로세스 부분 행렬(설치 트리 CLI와 자동 기동 broker, env 일관 구성)

| 사례 | codex | claude | 관측 | 판정 |
|---|---|---|---|---|
| control | true | true | wake observed, 메시지 미claim, obs 0 | PASS |
| mac-flip(integrityToken 1자 변경) | false | false | wake unknown, trust main sha 불변 | PASS |
| **trust-user_version-99** | **true** | **true** | `new TrustStore()`는 같은 파일에서 `INVALID_INPUT Trust database schema is newer than this server supports.`를 던진다. 그런데 reconcile의 `readVerifiedInputSource`는 `PRAGMA user_version`을 검사하지 않고 증거를 수락해 unknown을 해제했다 | **FAIL** |
| trust-missing | false | false | trust DB와 sidecar가 생성되지 않음 | PASS |
| session-lock-7s(다른 프로세스가 세션 DB에 `BEGIN EXCLUSIVE`) | 6.6s 뒤 true | – | broker의 busy_timeout(5s) 뒤 클라이언트가 재시도했고, 잠금 해제 후 CAS가 한 번 적용됨 | PASS(유효 증거, 1회 적용) |
| session-lock-25s | exit 1 `The session message broker timed out.` | – | 잠금 중 wake unknown. 30초 더 기다린 뒤에도 unknown이어서 클라이언트 실패 뒤 뒤늦게 적용되지 않음(26 로그) | PASS |
| trust-file-0444(uid 65534) | true | – | 유효 증거 수락. main sha 불변 | PASS |
| trust-dir-0555(uid 65534) | false | false | 읽기 전용 디렉터리에서 -shm을 만들 수 없어 읽기 실패 → 거절. 변화 없음 | 안전 PASS / 가용성 관측(유효 증거 거절) |

**읽기 전용 sidecar(별도 기록)**: 실제 프로세스에서는 trust DB를 읽기 전용으로 열 때마다 `trust.sqlite3-shm`(32768B)과 `trust.sqlite3-wal`(0B, frame 없음)이 새로 생긴다. 거절 경로(mac-flip)도 같다. 모드는 원본 파일 모드를 따른다(0600 또는 0444). main DB sha는 모든 사례에서 불변이고, 새 WAL frame은 0이다. trust가 없는 사례(trust-missing, F1-b)에서는 sidecar도 생성되지 않았다.

## 5. 위반·실패 전체 이름
1. `F1-a2-receipt-only-in-default` (codex, claude): 결속되지 않은 기본 경로 trust DB의 증거로 unknown을 해제함.
2. `F1-a1-receipt-in-R-other-default` (codex, claude): broker에 결속된 R/trust의 유효 증거를 거절함(다른 DB 조회).
3. `db-trust-user_version-99` (in-process 행렬), `trust-user_version-99` (codex, claude 실제 프로세스): 지원 범위 밖 schema version의 trust DB에서 온 증거를 수락함.

## 6. 최소 재현
- `scripts/min-repro-F1.sh` → 31-min-repro-F1.log: 기대값은 `reconciled:false`인데 관측값은 `reconciled:true`다. 이때 `R/trust.sqlite3`는 존재하지도 않는다.
- `scripts/min-repro-user_version.sh` → 32-min-repro-user_version.log: 기대값은 false인데 관측값은 true다.
- 제안(참고용이며 수정하지 않았다): broker가 wake reader에 쓰는 trust 경로를 `reconcileHistoricalWake`의 `verify`에도 넘기고(dispatch 인자로 결속), `readVerifiedInputSource`에 `user_version`의 == 또는 ≤ 1 검사를 추가한다.

## 7. NOT_RUN / UNKNOWN
- WAL 손상 사례는 in-process에서만 실행했다(실제 프로세스 CLI 경로로는 NOT_RUN). 이유: WAL-only 상태를 만들려면 고정 연결이 필요해 설치 트리 경로에서 재현 절차가 커진다.
- 다른 프로세스의 trust DB `BEGIN EXCLUSIVE`와 `locking_mode=EXCLUSIVE`도 in-process reader와 별도 잠금 프로세스로만 시험했다(실제 broker 경로 NOT_RUN).
- Windows와 macOS는 NOT_RUN이다(Linux 한 환경만 실행).
- 전체 검증 명령 순서(`claude:drift`, lint, test 전체 등)는 이 작업 범위가 아니어서 NOT_RUN이다. bundle:check와 build만 실행했다.
- 네트워크·서비스 실패: 없음.

주: `db/*.tgz`의 trust DB에는 이 실험에서 새로 만든 일회용 HMAC 서명 key가 들어 있다(fixture 값이며 운영 비밀이 아님). broker TLS key나 token은 포함하지 않았다.
