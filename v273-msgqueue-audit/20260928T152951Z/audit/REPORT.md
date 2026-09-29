# AGS 2.7.3 메시지 영수증 보존 한도(Q) 독립 감사 보고

- 지시: 총괄 ca8e3dc4. 이 세션은 후보를 만든 세션과 분리된 독립 감사자이며, 제품 소스를 고치거나 `claude/v273-msgqueue`에 push하지 않았다.
- 후보: `cc5b1e9dc439647fff18ed8aaa58170fc9389369`(tree `14282b51539b70fe605c12c9a5b2baa9ac40030f`, 둘 다 `git rev-parse`로 확인). detached worktree에서 감사했다.
- 기준: `8763cef2b11f2635d6c9af7861b5bffd496e2a30`(main, v2.7.2).
- 환경: Linux cloud 컨테이너 1곳(4 vCPU), Node v24.21.0, pnpm 11.19.0. 상세는 `meta.json`.
- 읽은 것: 루트 `AGENTS.md`·`CLAUDE.md`, `docs/session-message-lifecycle.md`, 분석 브랜치 `v273-msgqueue-retention/DESIGN.md`. 구현 세션 보고서(`claude/evidence-v273-msgqueue-20260928T143235Z`)는 대조용으로만 읽었고, 아래 판정은 모두 이 감사에서 직접 실행한 결과를 근거로 한다.
- 아래 `파일:줄`은 모두 후보 commit 기준이다.

## 최종 판정: **ACCEPT_WITH_FINDINGS**

구현은 F1·F2·F3·D1 요구를 모두 충족하며, 멱등성·상한·경합·호환 검사에서 결함을 찾지 못했다. blocker는 없다. 다만 후보 테스트가 잡지 못하는 mutant가 4개 있다. 그중 하나(M05: 용량 검사를 duplicate 검사 앞으로 옮김)는 최우선 항목인 멱등성과 "확정 무효과" 안내의 정확성을 지키는 순서를 회귀 테스트가 고정하지 않는다는 뜻이므로 major로 분류했다. 모두 테스트 보강으로 해결할 수 있고, 현재 코드의 동작은 올바르다.

## 항목별 결과

| # | 항목 | 결과 | 근거 |
|---|---|---|---|
| 1 | 멱등성 | PASS | I1–I6 (`tests/audit-msgqueue.test.ts`), 코드 `session-message-store.ts:335-343`, `:556-560`, `:271-285` |
| 2 | 상한 정확성 | PASS | L1–L5, 후보 `message-retention.test.ts` |
| 3 | 경합 | PASS | R1–R4 각 20회(child process 2개, SQLite 연결 2개) |
| 4 | 기존 테스트 변경의 정당성 | PASS | `message-lifecycle.test.ts:131-158`: 강화이며 약화 아님 |
| 5 | 회귀 테스트 실효성 | PASS_WITH_FINDINGS | mutant 22개 중 18개 검출, 4개 생존(M03, M05, M11, M20) |
| 6 | 이전 broker와 wire 호환 | PASS | v2.7.2·v2.7.1·v2.2.6 previous-broker 통과, C1–C3 |
| 7 | 문구와 문서 | PASS (minor 1) | `server.ts:530`, `:536`, `docs/session-message-lifecycle.md:26`, `:33`, `:35`, `:37`, `session-message-service.ts:60-61`, `:73-74` |
| 8 | 벤더 비종속 | PASS | 추가된 줄에 제품명 분기 없음 |
| 9 | 전체 검증 재실행 | PASS (validate:official은 FAIL_UNRELATED(환경)) | `logs/full-validation/` |
| 10 | 생성물 일치 | PASS | build·claude:build 뒤 `git status --porcelain` 빈 출력 |
| 11 | wake 브랜치 통합 위험 | 참고(판정 근거 아님) | 소스 충돌 3파일, 의미 충돌 1곳(`message-retention.test.ts:113`) |

### 1. 멱등성 — PASS

코드 근거:

- `submitPrepared`는 prepared 행이 없으면 거절하고(`session-message-store.ts:335-337`), 영수증이 있으면 용량 검사보다 **먼저** 기존 영수증을 `duplicate: true`로 돌려준다(`:338-342`). 용량 검사(`:343`)는 그 뒤에만 실행된다. 따라서 같은 ID로 두 번째 삽입이 일어날 경로가 없고, 이미 큐에 들어간 메시지의 재전송이 "확정 무효과" 용량 거절로 바뀌지 않는다.
- `acknowledge`는 `messages`의 UPDATE가 `changes === 1`일 때만 영수증 만료를 `min(expires_at, ACK+1h)`로 줄인다(`:551-560`). 같은 `BEGIN IMMEDIATE` 안이다(`:554`, `:561`).
- `prune`은 ACK된 메시지 행을 `acknowledged_at <= now-1h`에(`:274`), 영수증을 `expires_at <= now`에(`:284`) 지운다. ACK 시각 T에서 둘 다 T+1h에 지워진다.

직접 시험(모두 통과):

| 시점 | 시험 | 결과 |
|---|---|---|
| 영수증 보존 중(미ACK) | I1: 같은 ID 재전송 | `duplicate: true`, 해당 ID 행 1개 |
| ACK 직후, ACK+1h−1ms | I1 | `duplicate: true`, 영수증 1개 |
| ACK+1h | I1 | `Issued message ID is unavailable; delivery may be unknown…`, 행 0개, 영수증 0개, status `null` |
| 메시지 만료(미ACK) | I1: 만료 시각과 만료+1h−1ms | 영수증으로 `duplicate: true`, 새 행 0개 |
| 메시지 만료+1h | I1 | unavailable, 새 행 0개 |
| 전체 용량이 찬 상태 | I2: 이미 보낸 ID 재전송 | `duplicate: true`(용량 거절 아님), 행 수 불변 |
| 재소비·재ACK | I3: lease 만료 재전달 뒤 ACK, 그 뒤 claim·중복 ACK 3회 | 영수증 만료 `ACK+1h` 고정, 영수증 수 1, status `acknowledged`, `acknowledgedAt` 불변 |
| 입력 정규화 | I4: ID 대문자·앞뒤 공백·개행·하이픈 제거, sender 대소문자·공백 | 모두 unavailable 또는 identity 형식 거절, 행 1개·영수증 1개 불변 |
| 용량 거절된 draft | I5: 같은 ID는 draft 만료 전까지만 유효 | 해제가 draft 만료보다 늦으면 unavailable, 전달 0 |

ACK+1h 뒤 늦은 재시도(I6, 실제 broker와 service 경유):

- 결과는 `MCP_UNAVAILABLE`, `details: null`이고, 문구는 "delivery may be unknown … do not prepare again for the same uncertain delivery"다. "definite", "had no effect", "not queued" 같은 확정 무효과 문구는 붙지 않는다.
- 두 번 전달되지 않는다: 새 행 0개.
- 발신자가 잘못된 결론을 내리지 않는다: 안내가 "전달되지 않았다"고 말하지 않고, 기존 계약(`docs/session-message-lifecycle.md:21`, 서버 instructions "unknown ID는 이전 전송 완료나 기록 정리 가능성")과 같은 불확실 안내를 준다. 달라진 점은 ACK된 메시지에서 불확실 구간이 `메시지 만료+1h`에서 `ACK+1h`로 앞당겨진다는 것뿐이다. 응답을 잃은 발신자는 이 시각 뒤에 전달 여부를 status로 확인할 수 없다. 이는 설계에서 받아들인 변화이며(DESIGN §3 F2), 문서 `:37`에 적혀 있다.

부수 관찰(결함 아님): 거절된 transaction은 그 안의 `prune`까지 rollback한다. 그래서 I1에서 ACK+1h 거절 직후 DB에는 만료된 행이 남아 있다가 다음 prune에서 지워진다. 다음 호출이 먼저 prune하므로 관측 가능한 동작은 달라지지 않는다.

### 2. 상한 정확성 — PASS

| 시험 | 결과 |
|---|---|
| L1 sender 경계: 249번째 수락, prepare 입장 통과, 250번째 수락, 251번째 prepare 거절 | 문구 `The bounded message receipt store is full for this sender; no draft was created.`, `details = {scope: "sender", earliestReleaseAt: 첫 영수증 만료}`. 다른 sender는 곧바로 수락 |
| L2 전역 998→999→1000, 이어서 sender와 전역이 함께 찬 상태 | 찬 sender(250)는 `scope: "sender"`와 자기 영수증의 가장 이른 만료를 받는다. 다른 sender는 prepare·send 모두 `scope: "global"`과 전역에서 가장 이른 만료를 받는다. 행 수는 1000 |
| L3 해제 시각 직전과 그 시각, 한 자리씩 해제 | `earliestReleaseAt − 1ms`에는 거절, 그 시각에는 prepare·send 수락, 바로 다음 prepare는 거절되고 `earliestReleaseAt`이 정확히 다음 영수증 만료(+1ms)로 바뀐다. 3회 반복 |
| L4 전역 scope에서 해제 시각 직전과 그 시각 | 직전 거절, 그 시각에 prepare→send 수락 |
| L5 byte 한도(4 MiB) send 거절 | 문구 `The bounded message receipt store is full.`, `scope: "global"`, `earliestReleaseAt`은 가장 이른 draft 만료(1000+600000ms). 1ms 전에는 거절, 그 시각에는 수락 |

byte 한도 해제의 충분성도 확인했다: 영수증 전환 때 늘어나는 byte는 144 byte(draft 273 → 영수증 417, 1 byte 본문)이고 가장 작은 기록도 이보다 크므로, 기록 하나가 풀리면 늘어나는 byte를 수용할 수 있다. prepare 단계의 byte 거절은 기존 `The bounded message preparation store is full.`이며 details가 없다. 이는 영수증 용량 거절이 아니므로 D1 범위 밖이다.

### 3. 경합 — PASS

기존 하네스 `tests/session-messaging/fixtures/issued-send-worker.ts`(후보가 `acknowledge` 동작을 추가한 판)를 그대로 쓰고 반복 횟수만 늘렸다. 각 회차는 새 파일 DB, 두 child process, 두 SQLite 연결이며 두 worker가 ready를 보낸 뒤 동시에 요청을 보낸다.

| 시험 | 반복 | 결과 |
|---|---|---|
| R1 같은 sender, limit−1에서 두 send | 20 | 매회 수락 1, 거절 1(`…full for this sender.`), 영수증 250, 행 250 |
| R2 서로 다른 sender, 전역 999에서 두 send | 20 | 매회 수락 1, 거절 1(`…receipt store is full.`), 영수증 1000 |
| R3 같은 ID의 send와 ACK 동시 | 20 | 매회 행 1개. 순서 관측: send 먼저 15회(만료 = ACK+1h), ACK 먼저 5회(ACK 0건, 만료 = 메시지 만료+1h) |
| R4 limit−1에서 prepare 입장 검사와 마지막 자리를 쓰는 send 동시 | 20 | 매회 영수증 250. prepare 먼저 6회(draft 1개 생성), send 먼저 14회(`…; no draft was created.`, draft 증가 없음) |

두 순서가 모두 관측되었으므로 양쪽 분기가 실제로 실행되었다. 후보 자체의 경합 테스트 2개(`message-retention.test.ts` R1·R3 대응)도 전체 검증에서 통과했다.

### 4. 기존 테스트 변경의 정당성 — PASS

`git diff 8763cef cc5b1e9 -- tests`에서 기존 파일 변경은 두 곳뿐이다.

1. `tests/session-messaging/message-lifecycle.test.ts:131-158`("applies global draft, receipt and byte backpressure without evicting valid records")
   - 이전: 영수증 1000개가 찬 뒤 `prepare(store, 602_001)`가 성공한다고 전제하고, send가 `/receipt store is full/`로 거절되는지만 봤다.
   - 이후: 999개에서 draft를 준비하고 1000번째를 채운 뒤, (a) prepare 거절을 정확한 문구(`^…; no draft was created\.$`), `details`, draft 수 불변으로 확인하고, (b) send 거절을 정확한 문구(`^…full\.$`), `details`, `messages` 행 수 불변으로 확인한다. `status = prepared` 단언은 그대로 남아 있다.
   - 판단: F3 때문에 prepare가 이제 먼저 거절되므로 전제를 바꿔야 했다. 정규식을 정확 일치로 좁히고 단언 4개를 더했으며, 빠진 단언은 없다. **약화 아님.**
   - 이 사례의 byte 부분(`:159` 이후)은 바뀌지 않았다.
2. `tests/session-messaging/fixtures/issued-send-worker.ts`: `acknowledge` 동작 추가. 기존 prepare·send 경로는 그대로다.

그 밖의 기존 테스트 기대값은 바뀌지 않았다. 새 파일은 `message-retention.test.ts`뿐이다.

### 5. 회귀 테스트 실효성 — PASS_WITH_FINDINGS

방법: 별도 worktree에서 mutant 하나를 적용하고 `node scripts/build.mjs`로 dist를 다시 만든 뒤(broker 경유 테스트가 dist를 쓴다), 후보 테스트(`tests/session-messaging`, `tests/session-board`)와 감사 테스트(race 5회)를 차례로 돌렸다. 각 mutant 뒤에는 `git checkout -- .`으로 되돌렸다. 스크립트는 `scripts/mutants.py`, `scripts/run-mutants.sh`, 결과는 `logs/mutants/mutants.tsv`, 각 mutant의 diff와 로그는 `logs/mutants/`에 있다. 기준선(BASELINE)은 후보 263개 중 262개 통과·1개 skip, 감사 16/16 통과다.

| mutant | 대상 | 변경 | 후보 테스트 | 감사 테스트 |
|---|---|---|---|---|
| M01 | F1 | sender 상한 251 | **검출**(5 실패) | 검출 |
| M02 | F1 | sender 검사 제거 | **검출**(4) | 검출 |
| M03 | F1/D1 | 전역 검사를 sender 검사보다 먼저 | **생존** | 검출(L2) |
| M04 | F1 | send의 용량 검사 제거(prepare 입장만 남김) | **검출**(5) | 검출 |
| M05 | F1/멱등 | 용량 검사를 duplicate 반환 앞으로 이동 | **생존** | 검출(I2) |
| M06 | F1 | 용량 검사를 `BEGIN IMMEDIATE` 밖으로 분리 | **검출**(2, 경합 R1 포함) | 생존(race 5회에서 미관측) |
| M07 | F2 | ACK의 `changes` 검사 제거 | **검출**(3) | 검출 |
| M08 | F2 | `min()` 제거(만료 연장 가능) | **검출**(1) | 생존 |
| M09 | F2 | ACK 때 영수증 갱신 제거 | **검출**(6) | 검출 |
| M10 | F2 | ACK+1h 대신 ACK 시각 | **검출**(7) | 검출 |
| M11 | F2 | 영수증 갱신을 COMMIT 뒤로(transaction 분리) | **생존** | 생존 |
| M12 | F3 | prepare 입장 검사 제거 | **검출**(5) | 검출 |
| M13 | F3 | 입장 검사를 prune 앞으로 | **검출**(2) | 검출 |
| M14 | D1 | broker가 details 누락 | **검출**(1) | 생존 |
| M15 | D1 | client가 details 무시 | **검출**(1) | 생존 |
| M16 | D1 | service가 details를 null로 | **검출**(1) | 생존 |
| M17 | D1 | earliestReleaseAt에 max 사용 | **검출**(2) | 검출 |
| M18 | D1 | sender scope 라벨을 global로 | **검출**(2) | 검출 |
| M19 | D1 | 용량 거절에 불확실 안내 사용 | **검출**(1) | 생존 |
| M20 | D1 | byte 한도 send 거절의 details 누락 | **생존** | 검출(L5) |
| M21 | D1 | 모든 broker 거절을 확정 무효과로 표시 | **검출**(1) | 검출(I6) |
| M22 | F1 | sender 개수를 전체로 계산 | **검출**(4) | 검출 |

후보 테스트: 22개 중 18개 검출. 생존 4개는 아래 finding N1–N4다. 감사 테스트는 service·wire 경로를 일부러 좁게 보았으므로, 감사 테스트의 생존은 판정 근거로 쓰지 않았다.

### 6. 이전 broker와 wire 호환 — PASS

각 태그의 `mcp-server/dist`, `runtime`, `package.json`을 `git archive`로 꺼내 `AGS_PREVIOUS_BROKER_PATH`로 지정했다. 로그: `logs/previous-broker-<tag>.log`.

| 시험 | v2.7.2 | v2.7.1 | v2.2.6 |
|---|---|---|---|
| `previous-broker.test.ts`(새 hook·CLI + 이전 broker) | PASS | PASS | PASS |
| C1 새 service/client + 이전 broker, 전역 영수증이 찬 뒤 send | PASS: `details: null`, 기존 안내 "Retry only the known prepared ID…", "definite"·"earliest" 없음 | PASS(같음) | 해당 없음: 이전 broker에 prepare가 없어 `Unknown broker operation.`(details null)로 끝나며, 이것도 단언했다 |
| C2 이전 release broker·CLI로 만든 실제 DB를 새 broker로 열기 | PASS | PASS | 해당 없음(prepare·영수증 없음, `logs/previous-broker-v2.2.6-C2C3-not-applicable.log`) |
| C3 이전 CLI + 새 broker, sender 상한 거절 | PASS: `{"ok":false,"error":"The bounded message receipt store is full for this sender; no draft was created."}`, 종료 코드 1 | PASS | 해당 없음(`Unsupported session message operation.`) |

C2의 세부 결과: 이전 broker가 ACK한 메시지의 영수증 만료는 `메시지 만료+1h`로 기록되어 있다. 새 broker에서 이 ID를 다시 send하면 `duplicate: true`, 다시 ACK하면 `acknowledged: 0`이고, 만료는 그대로다(비소급). 같은 DB에서 이전 release가 ACK하지 않은 메시지를 새 broker로 ACK하면 만료가 `ACK+1h`로 줄어든다. schema 이관은 없고 행 2개가 보존된다.

C1의 참고 관찰: 이전 broker에는 prepare 입장 검사가 없으므로 전역이 찬 상태에서도 prepare가 draft를 만든다. 혼합 버전 동작이며 문서 `:35` 마지막 문장과 맞는다.

후보가 `details`를 추가한 방식(broker 응답의 선택 필드, `session-message-broker.ts:506-508`)은 이전 client가 무시하고(C3), 새 client는 필드가 없거나 형식이 틀리면 `null`로 처리한다(`session-message-client.ts:26-37`).

### 7. 문구와 문서 — PASS(minor 1)

- 표(`docs/session-message-lifecycle.md:26`)와 코드가 일치한다: 전역 1000(`session-message-store.ts:18`), sender 250(`:20`), 미ACK는 메시지 만료+1h(`:346`), ACK되면 `min(…, ACK+1h)`(`:552`, `:558`).
- `:33`의 검사 순서("정리 뒤 sender 상한, 전역 상한")는 `:288-297`, `:334`, `:343`과 일치한다. `no draft was created` 문구는 `:313`과 일치한다.
- `:35`의 확정 무효과 설명은 rollback 구조(`:354-356`, `:323-325`)와 일치하며, I2·I6·M21 검출로 불확실한 경우에 확정 안내가 붙지 않음을 확인했다. 확정 안내는 broker의 `MessageCapacityError`에만 붙고(`session-message-broker.ts:508`), 이 오류는 duplicate 판정 뒤에만 던져지므로(`session-message-store.ts:338-343`) 이미 큐에 들어간 ID에는 붙을 수 없다. client의 자동 재시도는 transport 실패에서만 일어나고 broker 거절은 재시도하지 않는다(`session-message-client.ts:258`, `:288`, `:334`). 첫 시도가 실제로 큐에 넣었다면 재시도는 duplicate를 받는다.
- `:37`의 ACK 규칙과 비소급은 I1·I3·C2로 확인했다.
- 도구 설명(`server.ts:530`, `:536`)은 코드와 일치한다.
- 인증·principal 표현: 추가된 줄에서 해당 단어는 모두 부정문이다("인증된 principal이 아니므로", "not an authenticated principal", "not authentication"). 상한을 인증 수단으로 표현한 곳은 없다.
- minor(N5): send 용량 거절 안내(`session-message-service.ts:74`, `server.ts:536`)는 "a new prepare may succeed"만 말한다. 문서 `:33`에 적힌 것처럼 거절된 draft는 준비 만료(10분)까지 같은 ID로 다시 보낼 수 있는데, 도구 응답은 이를 알리지 않는다. 아래 finding 참조.

### 8. 벤더 비종속 — PASS

`git diff 8763cef cc5b1e9 -- mcp-server/src tests docs`의 추가 줄에서 `codex|claude|grok|spark|openai|anthropic`는 0건이다. 추가 코드에 호스트별 분기가 없다.

### 9. 전체 검증 재실행 — PASS(validate:official FAIL_UNRELATED(환경))

후보 worktree(`logs/full-validation/`, 종료 코드는 `exit-codes.tsv`)에서 지시된 순서로 실행했다.

| 명령 | 종료 코드 | 결과 |
|---|---|---|
| `pnpm install --frozen-lockfile` | 0 | PASS |
| `pnpm bundle:check` | 0 | PASS |
| `pnpm claude:drift` | 0 | PASS, `claude-plugin: fresh` |
| `pnpm lint` | 0 | PASS, `repository: valid` |
| `pnpm build` | 0 | PASS |
| `pnpm test` | 0 | PASS: 파일 60개 통과·1개 skip, 테스트 822개 통과·1개 skip(skip은 `AGS_PREVIOUS_BROKER_PATH` 없는 previous-broker, 6절에서 따로 실행) |
| `pnpm runtime:check` | 0 | PASS, `runtime: ready (29 skill CLIs, Node.js 24.21.0)` |
| `pnpm validate:all` | 0 | PASS |
| `pnpm validate:official` | 1 | **FAIL_UNRELATED(환경)**: `/root/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py` 없음(ENOENT) |
| `pnpm claude:build` | 0 | PASS, `wrote 404 files` |
| `pnpm claude:check` | 0 | PASS, `fresh` |
| `git diff --check` | 0 | PASS |

참고: `tests/tooling/commands.test.mjs`의 한 사례는 `npx vitest`로 직접 실행하면 후보에서도 실패하고 `pnpm test`로는 통과한다. pnpm이 넣는 환경값에 기대는 테스트이며, 이 후보와 무관하다.

### 10. 생성물 일치 — PASS

`logs/full-validation/05b-git-status-after-build.txt`, `10b-git-status-after-claude-build.txt`, `12b-git-status-final.txt` 모두 비어 있다.

### 11. wake 브랜치 통합 위험 — 참고

`claude/v273-wake-liveness`(`e739090952710d418a67dae71d76b1f2ef169441`, main 대비 1 commit)를 후보 위에 `git merge --no-commit`으로 임시 병합했다. push하지 않았다. 로그: `logs/wake-merge*.log`, 해소 결과 diff: `logs/wake-merge-resolved-vs-candidate.diff`, 해소 스크립트: `scripts/resolve-wake-merge.py`.

텍스트 충돌:

| 파일 | 충돌 | 기계적 해소 |
|---|---|---|
| `mcp-server/src/server.ts` | send 설명 문자열 두 판 | wake 문장 뒤에 D1 문장을 붙임 |
| `mcp-server/src/session-message-service.ts` | import(`BrokerRequestRejected` 대 `SessionPresenceView`) | 둘 다 가져옴 |
| `mcp-server/src/session-message-store.ts` | (1) `assertReceiptCapacity`와 `retireUnobservedWakes`·`recordActivity`가 같은 위치, (2) `submitPrepared`의 용량 검사와 wake의 `target` 변수, (3) `acknowledge` 루프(F2)와 wake의 `recordActivity` | (1) 둘 다 유지, (2) `assertReceiptCapacity` + `target` 변수, (3) F2 루프 뒤에 `recordActivity` |
| `mcp-server/dist/*`, `claude-plugin/mcp-server/dist/*` | 생성물 | `node scripts/build.mjs`, `node scripts/build-claude-plugin.mjs`로 재생성 |

해소 뒤 `tsc --noEmit` 통과, build 통과. `vitest run` 전체: 847개 통과, 실패 2개.

- **의미 충돌(통합 때 반드시 수정)**: `tests/session-messaging/message-retention.test.ts:113`(병합본 기준)의 `expect(store.submitPrepared(hot, sent.messageId, ackAt + H - 1)).toEqual({ ...sent, duplicate: true })`. wake 브랜치는 `submitPrepared` 반환값에 호출 시점의 `autoWake`(`checkedAt` 포함)를 붙이므로 `checkedAt`이 달라 실패한다. wake 브랜치가 `message-lifecycle.test.ts`에서 쓴 방식(`autoWake: { ...first.autoWake, checkedAt: … }`)으로 기대값을 맞춰야 한다. retention 테스트의 다른 `toEqual`은 details와 DB 행 비교라서 영향이 없다.
- 다른 1건은 위 9절의 `tests/tooling/commands.test.mjs`(npx 실행 탓)이며, `pnpm test tests/tooling/commands.test.mjs`로는 12/12 통과했다(`logs/wake-merge-test-tooling-pnpm.log`).
- 코드 의미: 병합본에서 duplicate 반환은 여전히 용량 검사보다 앞에 있고 `autoWake`만 덧붙는다. 용량 거절은 `autoWakeOutlook` 호출 전에 rollback된다. `acknowledge`의 `recordActivity`는 같은 transaction 안에 있다. 이 감사에서는 이 병합본에 감사 테스트를 돌리지 않았다.

## Findings

| ID | 심각도 | 내용 |
|---|---|---|
| N1 | major | 멱등성 순서를 고정하는 테스트 없음(M05 생존) |
| N2 | minor | sender·전역이 함께 찼을 때의 scope 우선순위 테스트 없음(M03 생존) |
| N3 | minor | byte 한도 send 거절의 details 테스트 없음(M20 생존) |
| N4 | minor | ACK 영수증 갱신의 원자성을 관측하는 테스트 없음(M11 생존) |
| N5 | minor | send 용량 거절 안내가 draft가 남아 있다는 점을 알리지 않음 |

### N1 (major) — 용량 검사가 duplicate 판정 뒤에 있어야 한다는 불변식을 후보 테스트가 고정하지 않는다

- 재현: `python3 scripts/mutants.py <worktree> M05-F1-capacity-before-duplicate` → `node scripts/build.mjs` → `npx vitest run tests/session-messaging tests/session-board` → 262개 모두 통과(`logs/mutants/M05-F1-capacity-before-duplicate.candidate.log`). 감사 테스트 I2는 실패한다.
- 영향: 현재 코드는 올바르다(`session-message-store.ts:338-343`). 하지만 이 순서가 리팩터링으로 바뀌면, 이미 큐에 들어간 메시지의 재전송이 용량이 찬 동안 "This definite rejection had no effect: the message was not queued"로 응답한다. 응답을 잃은 발신자는 이 거짓 확정 안내를 믿고 새 prepare로 두 번째 메시지를 보낼 수 있다. 멱등성과 D1 안내의 정확성이 함께 깨지는데, 이를 막는 회귀 테스트가 없다.
- 권장 수정: store 단위로 "sender 250개가 찬 상태에서 이미 보낸 ID를 재전송하면 `duplicate: true`이고 행 수가 불변"(감사 I2와 같음)을 추가한다. 가능하면 service 단위로 "용량이 찬 상태에서 이미 보낸 ID를 send하면 ok와 duplicate"도 추가한다.

### N2 (minor) — sender와 전역이 함께 찼을 때 sender scope를 먼저 보고하는지 테스트하지 않는다

- 재현: M03 적용 → 후보 테스트 전부 통과. 감사 L2는 실패한다.
- 영향: 순서가 바뀌면 찬 sender가 `scope: "global"`과 전역의 가장 이른 시각을 받는다. 그 시각에 풀리는 자리는 다른 sender의 것이므로 이 sender는 여전히 거절된다. 안내가 틀려진다.
- 권장 수정: 감사 L2처럼 두 한도를 함께 채운 뒤 찬 sender의 `details.scope === "sender"`와 해당 sender의 가장 이른 만료를 단언한다.

### N3 (minor) — byte 한도 send 거절의 details를 테스트하지 않는다

- 재현: M20(`MessageCapacityError` → 일반 `Error`) 적용 → 후보 테스트 전부 통과. 감사 L5는 실패한다.
- 영향: 회귀가 생기면 byte 한도 거절이 다시 불확실 안내("do not prepare again")로 떨어진다. 문서 `:35`의 확정 무효과 계약에서 벗어난다.
- 권장 수정: 감사 L5처럼 byte 여유를 영수증 증가분(약 144 byte)보다 작게 만든 뒤 send 거절의 `details`와 해제 시각 직전·직후 동작을 단언한다.

### N4 (minor) — ACK의 영수증 갱신이 같은 transaction이라는 점을 관측하는 테스트가 없다

- 재현: M11(갱신을 COMMIT 뒤로) 적용 → 후보·감사 테스트 모두 통과.
- 영향: 요구 F2의 "같은 transaction"은 현재 코드에서 지켜진다(`session-message-store.ts:554-561`). 분리되면 COMMIT과 갱신 사이에 프로세스가 끝났을 때 ACK는 기록되고 영수증은 줄지 않는다. 결과는 용량이 늦게 풀리는 것뿐이며 중복 전달은 생기지 않는다.
- 권장 수정: 선택 사항이다. 갱신 문장에서 오류를 주입하면(예: 테스트용 trigger) ACK 전체가 rollback되는지 확인하는 테스트를 둘 수 있다. 비용이 크면 코드 리뷰 항목으로 남겨도 된다.

### N5 (minor) — send 용량 거절 안내가 draft가 남는다는 사실을 알리지 않는다

- 재현: 감사 I5와 후보 `message-retention.test.ts` service 사례. 용량 거절 뒤 `store.status`는 `prepared`이고, draft 만료 전 해제가 오면 같은 ID의 send가 성공한다. 그런데 service 문구(`session-message-service.ts:74`)와 도구 설명(`server.ts:536`)은 "a new prepare_session_message may succeed"만 말한다.
- 영향: 발신자가 새로 prepare해서 보낸 뒤 옛 ID도 다시 보내면, 한 의도가 두 메시지로 전달될 수 있다. 현재 안내는 거절을 확정으로 표시하므로 옛 ID를 다시 보낼 이유는 약하다. 그래서 minor다. 해제 시각은 대개 draft 만료(10분)보다 늦으므로 실제로는 새 prepare가 주된 경로다.
- 권장 수정: 문구에 "the rejected messageId stays prepared until its draft expiry; after release either retry that same ID or prepare again, not both"처럼 한 문장을 추가한다. 문서 `:33`과 일치시킨다.

## 실행하지 못한 것(NOT_RUN)

| 항목 | 이유 |
|---|---|
| Windows(CI 기준 조합의 하나) | 이 감사는 Linux cloud 컨테이너 한 곳에서만 실행했다 |
| 실제 호스트(Codex, Claude Code 등)에서의 MCP 호출 | 컨테이너에 실제 호스트 설치가 없다 |
| 실제 플러그인 설치·설치 캐시 확인 | 같은 이유 |
| `pnpm validate:official` | FAIL_UNRELATED(환경): Codex 공식 validator가 컨테이너에 없다 |
| wake 병합본에 대한 감사 테스트·경합 시험 | 11절은 통합용 참고이며 범위 밖이다 |
| 프로세스 강제 종료를 주입하는 원자성 시험(N4) | 하네스가 없다 |

## 산출물

- `audit/REPORT.md`(이 파일), 저장소 루트의 `meta.json`, `SHA256SUMS`
- `tests/audit-msgqueue.test.ts`(I1–I6, L1–L5, R1–R4, C1), `tests/audit-compat.test.ts`(C2, C3). 후보 트리의 `tests/session-messaging/`에 복사해 실행했다.
- `scripts/full-validation.sh`, `scripts/mutants.py`, `scripts/run-mutants.sh`, `scripts/resolve-wake-merge.py`
- `logs/full-validation/`(명령별 로그와 `exit-codes.tsv`), `logs/audit-tests-*.log`, `logs/previous-broker-*.log`, `logs/mutants/`, `logs/wake-merge*`

재현 명령 예:

```sh
export PATH=/opt/node24/bin:$PATH
git worktree add --detach ../audit cc5b1e9dc439647fff18ed8aaa58170fc9389369 && cd ../audit
pnpm install --frozen-lockfile
cp <evidence>/tests/audit-*.test.ts tests/session-messaging/
AUDIT_RACE_ROUNDS=20 npx vitest run tests/session-messaging/audit-msgqueue.test.ts
AGS_PREVIOUS_ROOT=<v2.7.2 tree> AGS_PREVIOUS_BROKER_PATH=<v2.7.2 tree>/mcp-server/dist/session-message-broker.mjs \
  npx vitest run tests/session-messaging/previous-broker.test.ts tests/session-messaging/audit-*.test.ts -t "previous|C1|C2|C3"
```

## 비밀값·개인정보 처리

push 전에 모든 산출물을 다음 패턴으로 검사했다: `ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `AKIA`, `BEGIN PRIVATE KEY`, `Authorization: Bearer`, 이메일 주소, IPv4 주소. 결과는 `meta.json`의 `redaction` 항목에 적었다. env·printenv 전체 출력은 남기지 않았다. 로그의 경로는 컨테이너 기본 경로(`/home/user/...`, `/root/...`, `/tmp/...`)이며 개인 계정 이름이 아니다.
