# AGS 2.7.3 통합 2단계 보고 (Q 메시지 영수증 보존 한도)

지시: 총괄 ca8e3dc4. 1단계 통합(wake + intake) 위에 Q 후보를 병합하고, Linux에서 전체 검증했다. 버전은 바꾸지 않았다. Q는 수정분 재감사가 다른 세션에서 진행 중이다. 재감사가 결함을 찾으면 이 병합을 다시 할 수 있다.

## 판정: PASS (fast-forward push 완료)

| 대상 | SHA |
| --- | --- |
| 통합 기준 `claude/v273-integration` | e71b121a5481a0a04302a7f1c12ec3f4522df606 (fetch 후 일치) |
| Q `claude/v273-msgqueue` | 74395bf698012a8b2e034e58e3b42d51f53b0b68 (fetch 후 일치, main 조상) |
| **새 통합 후보 `claude/v273-integration`** | **92b1a0d147d280e511eaf5c23cbbf9d00ac790bf (tree f23b7d8d71ada7a59e8b9dde9b92073e72f14424)**. 부모: e71b121a, 74395bf6 |

환경: Linux cloud 컨테이너, Node.js v24.21.0, pnpm 11.19.0. push 전 원격이 e71b121a이고 새 HEAD의 조상임을 확인했다(fast-forward).

## 충돌 기록

원래 충돌 diff는 `logs/merge/conflicts-raw.diff`에 있다. 해소 결과는 두 diff로 남겼다. `logs/merge/resolved-vs-stage1.diff`는 1단계 대비, `logs/merge/resolved-src-tests-vs-q.diff`는 Q 대비 src·tests diff다.

| # | 파일 | wake/1단계 쪽 의도 | Q 쪽 의도 | 해법 |
| --- | --- | --- | --- | --- |
| 1 | `mcp-server/src/server.ts:536` send 설명 | 성공은 queue 적재일 뿐이라는 문장과 advisory autoWake 문장 | 용량 거절은 효과 없음이 확정이고 `error.details`(scope, earliestReleaseAt)를 담는다는 D1 문장. 거절된 ID는 draft 만료까지 prepared로 남고, 같은 ID 재시도와 새 prepare 중 하나만 한다는 N5 문장 | 두 쪽 공통 앞부분을 확인한 뒤, wake 문장 다음에 Q 문장 두 개를 붙였다. 세 문장이 모두 남는다 |
| 2 | `mcp-server/src/session-message-service.ts:2-3` import | `SessionPresence`를 `SessionPresenceView`로 바꿈 | `BrokerRequestRejected` import 추가(바뀌지 않은 `SessionPresence` 줄은 문맥일 뿐) | `BrokerRequestRejected, sessionMessageRequest`와 `SessionPresenceView`를 함께 import했다 |
| 3a | `mcp-server/src/session-message-store.ts:332-360` | `retireUnobservedWakes`, `recordActivity` 추가 | `assertReceiptCapacity` 추가 | 세 메서드를 모두 유지했다(wake 둘 다음에 Q) |
| 3b | 같은 파일 `submitPrepared:404-419` | 전역 영수증 수 검사와 `target` 변수 | `assertReceiptCapacity(sender, ".")`와 인라인 target | Q의 `assertReceiptCapacity`와 wake의 `target` 변수를 썼다. 최종 순서: prepared 없음 거절 → 기존 영수증이면 duplicate 반환(:404-409, autoWake 포함) → 용량 검사(:410) → `send` → byte 검사 → UPDATE → `autoWakeOutlook`(:419) → COMMIT. 용량 거절과 byte 거절은 autoWake 계산 전에 throw되고 catch의 ROLLBACK으로 되돌아간다 |
| 3c | 같은 파일 `acknowledge:~628-648` | 루프 뒤 `recordActivity` | changes가 1일 때만 영수증 만료 단축(F2) | Q의 루프를 쓰고(:639 영수증 갱신) 그 뒤에 `recordActivity`(:642)를 두었다. 둘 다 같은 `BEGIN IMMEDIATE` … `COMMIT` 안에 있다 |
| 4 | `mcp-server/dist/**`, `claude-plugin/mcp-server/dist/**` (4파일 충돌) | 생성물 | 생성물 | 손으로 합치지 않았다. `pnpm build`와 `pnpm claude:build`로 다시 만들었다(`logs/merge/build.log`, `claude-build.log`) |

### 의미 충돌: `tests/session-messaging/message-retention.test.ts`

wake는 `submitPrepared`의 duplicate 반환값에 호출 시점의 `autoWake`(`checkedAt` 포함)를 붙인다. 그래서 `{ ...sent, duplicate: true }` 형태의 단언이 깨진다.

- `:113`, `:279`, `:280`, `:285`(store, 호출 시각을 아는 경우): wake의 `message-lifecycle.test.ts:101` 방식으로 기대값만 맞췄다. `autoWake: { ...X.autoWake, checkedAt: new Date(<호출 시각>).toISOString() }` 형태이며, 정확한 시각으로 비교한다.
- `:271`(service, 실제 시계 경로): writer 보고서는 "service의 `toMatchObject`는 영향 없음"이라 했지만, 실제로는 실패했다. `firstSent`가 `autoWake`를 담고 있고, service는 `Date.now()`로 `checkedAt`을 만들기 때문이다. 이 값은 테스트가 정할 수 없으므로, wake가 실제 시계 경로에서 쓴 방식(`message-lifecycle.test.ts:224`, `:266`)을 따랐다. `checkedAt: expect.any(String)`만 느슨하게 하고, 나머지 autoWake 필드와 receipt 필드는 그대로 비교한다.
- 단언을 빼거나 다른 필드를 느슨하게 하지 않았다. 수정 뒤 `tests/session-messaging` 전체가 통과한다(279 통과, 2 skip).

### 문서 의미 충돌

Q와 wake 모두 `docs/session-message-lifecycle.md`를 바꿨고, git이 자동 병합했다. 모순은 찾지 못했다.

- Q 쪽 내용: 영수증 상한과 ACK 만료 규칙, "send는 같은 transaction에서 정리 뒤 sender, 전역 순으로 검사".
- wake 쪽 내용: 퇴역 규칙과 prune 지점(조회 도구도 prune), 퇴역의 근거가 되는 활동 목록(ACK 포함).
- 코드도 같은 동작이다. ACK는 한 transaction 안에서 영수증을 줄이고 활동을 기록한다.

## 전체 검증

명령별 stdout, stderr와 종료 코드는 `logs/full/`에 있다.

| # | 명령 | 종료 코드 | 결과 |
| --- | --- | --- | --- |
| 01 | `pnpm install --frozen-lockfile` | 0 | PASS |
| 02 | `pnpm bundle:check` | 0 | PASS |
| 03 | `pnpm claude:drift` | 0 | PASS (`claude-plugin: fresh`) |
| 04 | `pnpm lint` | 0 | PASS |
| 05 | `pnpm build` | 0 | PASS |
| 06 | `pnpm test` | 0 | PASS: 파일 61 통과·1 skip, 테스트 857 통과·2 skip(previous-broker, 아래에서 따로 실행) |
| 07 | `pnpm runtime:check` | 0 | PASS |
| 08 | `pnpm validate:all` | 0 | PASS |
| 09 | `pnpm validate:official` | 1 | FAIL_UNRELATED(환경): Codex validator `validate_plugin.py` 없음(ENOENT) |
| 10 | `pnpm claude:build` | 0 | PASS |
| 11 | `pnpm claude:check` | 0 | PASS |
| 12 | `git diff --check` | 0 | PASS |
| 13 | `git status --porcelain` | 0 | 출력 0 byte |

## 추가 확인

`logs/checks/`, `logs/mutants/`에 있다.

### Q 감사 테스트

`claude/evidence-v273-msgqueue-audit-20260928T152951Z`의 `tests/audit-msgqueue.test.ts`와 `tests/audit-compat.test.ts`를 임시로 `tests/session-messaging/`에 복사해 돌렸다. 설정은 `AUDIT_RACE_ROUNDS=10`, `AGS_PREVIOUS_ROOT`와 `AGS_PREVIOUS_BROKER_PATH`는 v2.7.2 트리다. 파일 hash는 `q-audit-tests.sha256`에 있다.

- **원본 그대로(`q-audit-original.log`)**: 16/18 통과. I1(`:59`)과 I2(`:90`)가 실패했다. 차이는 둘 다 `autoWake.checkedAt` 하나뿐이다(기대 00:00:01, 실제 00:00:02 / 00:00:05). I1은 첫 단언에서 멈추므로 뒤의 duplicate 단언 4개(`:63`, `:64`, `:76`, `:78`)는 이 실행에서 평가되지 않았다.
- **autoWake만 맞춘 사본(`q-audit-autowake-adjusted.log`, 변경은 `q-audit-autowake-only.diff`)**: duplicate 단언 6개에 `autoWake: { ...X.autoWake, checkedAt: <호출 시각 ISO> }`만 더했다. 결과는 **18/18 통과**(R1–R3 race 10회, C2·C3 compat 포함)다. 따라서 원인은 autoWake 추가뿐이다.
- 복사본은 실행 뒤 지웠다.

### Q 감사 mutant (후보 테스트 `tests/session-messaging` + `tests/session-board`만 실행)

감사 스크립트는 `logs/mutants/mutants.py`에, 통합용 적용 스크립트는 `mutants-integration.py`에 있다. mutant마다 `node scripts/build.mjs`로 dist를 다시 만든 뒤 실행하고, `git checkout`으로 되돌렸다. 끝난 뒤 작업 트리 변경은 0이었다.

| mutant | 앵커 | 결과 | 잡은 후보 테스트 |
| --- | --- | --- | --- |
| BASELINE | — | 294 통과, 2 skip | — |
| M03 전역 검사 먼저 | 감사 앵커 그대로 | **검출**(1) | sender·전역이 모두 찼을 때 sender scope 보고(N2) |
| M05 용량 검사를 duplicate 앞으로 | **옮김**: duplicate 블록에 wake의 `autoWake` 두 줄이 있어 원래 앵커가 맞지 않는다. 같은 의미(용량 검사를 duplicate 판정 앞으로)로, autoWake를 포함한 블록을 앵커로 썼다 | **검출**(2) | service 용량 거절 사례, 전 용량 duplicate 재전송(N1) |
| M11 영수증 갱신을 COMMIT 뒤로 | **옮김**: ACK 루프와 COMMIT 사이에 wake의 `recordActivity`가 있다. 같은 의미(영수증 갱신만 COMMIT 뒤로)로 옮기고 `recordActivity`는 transaction 안에 두었다 | **검출**(1) | 영수증 갱신 실패 시 ACK 전체 rollback(N4) |
| M20 byte 거절 details 누락 | 감사 앵커 그대로 | **검출**(1) | byte 한도 send 거절 details(N3) |

검출 사례와 수는 writer 수정 보고서 6절의 표와 같다.

### wake 재감사 테스트

`claude/evidence-v273-wake-reaudit-20260928T151802Z`의 `audit/tests`를 임시로 `tests/audit/`에 복사해 돌렸다. 실행 뒤 지웠다.

| 시험 | 결과 |
| --- | --- |
| F1 store·hook | 10/10 통과 |
| audit-retire | 17/18 통과. 실패는 2b 원본 probe(예상된 실패)이며, 출력(`recognized:true`, `w2late:null`, pending 0)이 재감사와 같다 |
| audit-race (`AUDIT_RACE_ROUNDS=10`) | 3/3 통과 |

### intake init-smoke

9경우(배치 3 × profile 3) 모두 sha256 `474cdcdb93a26a3bed0c58cc03313b3b47e7c19c654702476cb202efc43a0b75`, 3548 byte, intake 1회, 도구 28개다. 33dfdc02 단독, 1단계와 같다. Q는 instructions와 도구 수를 바꾸지 않았다.

### previous-broker

| 태그 broker | 결과 |
| --- | --- |
| v2.7.2 | 2/2 통과 |
| v2.7.1 | 2/2 통과 |
| v2.2.6 | 2/2 통과 |

## 후보 결함

발견하지 못했다. writer 보고서의 "service `toMatchObject`는 영향 없음" 서술은 병합 뒤 사실과 다르다(위 의미 충돌 `:271`). 이것은 통합 때 맞출 기대값 문제이며, 제품 코드 결함은 아니다.

## NOT_RUN

- `validate:official`의 실제 검사: 컨테이너에 Codex validator가 없다.
- `source:check`, `source:verify`: 이번 지시의 목록에 없다.
- Q 감사 mutant 22개 중 M03·M05·M11·M20 외 18개: 지시 범위 밖이다.
- race 20·40회 반복: 지시대로 10회만 했다.
- Windows × Node.js 24, 설치 캐시와 실제 호스트 동작: 범위 밖이다.
- Q 수정분 재감사: 다른 세션에서 진행 중이다.

## 가린 값

토큰 패턴(`ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `AKIA`, PRIVATE KEY 줄, Authorization Bearer), 이메일 주소, IPv4 주소와 GitHub 계정 이름은 발견되지 않았다. `env`·`printenv` 출력은 남기지 않았다. Python 캐시(`__pycache__`, 경로 포함 binary)는 넣지 않았다. 다음을 바꾼 뒤 `SHA256SUMS`를 만들었다.

| 대상 | 치환 | 파일 수 | 횟수 |
| --- | --- | --- | --- |
| 사용자 이름이 들어간 컨테이너 홈 경로 | `[REDACTED-HOME]` | 16 | 16 |
| root 계정 홈 경로 | `[REDACTED-HOME]` | 1 | 2 |
