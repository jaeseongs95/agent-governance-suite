# AGS 2.7.3 메시지 영수증 보존 한도(Q) 2차 재감사 보고 — R1 수정분(d99d768e)

- 지시: 총괄 ca8e3dc4. 이 세션은 구현 세션과 분리된 독립 감사자이며, 읽기 전용으로 감사했다. 제품 소스는 고치지 않았다.
- 새 후보: `d99d768eab65878bab228ea73e5f5660ac98c616`(tree `bfa89453d591e03a3e9c66fe6df14a503e798bbc`). 둘 다 `git rev-parse`로 확인했다.
- 이전 대상: `74395bf698012a8b2e034e58e3b42d51f53b0b68`. 그 재감사 보고는 `claude/evidence-v273-msgqueue-reaudit-20260928T160657Z`에 있다.
- 범위: commit `d99d768e` 하나.
- writer evidence(`claude/evidence-v273-msgqueue-fix2-20260928T161528Z`)는 fetch만 하고 대조용으로 두었다. 판정은 모두 이 감사에서 직접 실행한 결과를 근거로 한다.
- 환경: Linux cloud 컨테이너 1곳, Node v24.21.0, pnpm 11.19.0. 상세는 `meta.json`에 있다.

## 최종 판정: **ACCEPT**

R1이 해소됐다. 이제 용량 거절 안내는 prepare 응답의 `expiresAt`과 `earliestReleaseAt`을 비교해 분기를 하나로 정해 준다. 두 분기 모두 한 번만 전달되고, 경계값도 코드와 맞는다(G1–G3). 새 문서 문장은 "확정 거절 뒤 그 ID로 다시 send하지 않았다"는 조건 아래에서만 새 prepare를 허용한다. 확정 거절 기록이 없는 unknown에는 기존 안내가 그대로 붙는다(G4).

mutant 22개는 모두 후보 테스트가 검출한다. 전체 검증도 통과했다. 새 finding은 없다. 참고 관찰 2건(O1, O2)은 판정에 영향을 주지 않는다.

## 항목별 결과

| # | 항목 | 결과 | 근거 |
|---|---|---|---|
| 1 | 범위 | PASS | 문구 3곳, dist `server.mjs` 2개, 테스트 1개만 바뀌었다. store·broker·client·contracts·runtime은 diff가 0이다 |
| 2 | R1 해소(N5-b, N5-a 조건) | PASS | G1, G2, G3 |
| 3 | 새 문서 문장의 멱등성 안전 | PASS | 아래 3절, G4 |
| 4 | 세 곳 뜻 일치, 벤더명·인증 표현 없음, 확정 안내 오표시 없음 | PASS | 추가된 줄에서 벤더명·인증 단어 0건. M21, G4, BASELINE 감사 I6 |
| 5 | 새 테스트의 문구 고정과 M16·M19·M21 검출 | PASS | 정확한 부분 문자열 상수 `RETRY_GUIDANCE`로 고정. 22/22 검출 |
| 6 | 전체 검증과 생성물 일치 | PASS | 11개 명령 종료 코드 0. validate:official은 FAIL_UNRELATED(환경). git status 빈 출력 |

### 1. 범위 — PASS

`git diff --stat 74395bf6 d99d768e`에 나온 파일은 다음 6개다.

- `docs/session-message-lifecycle.md`
- `mcp-server/src/server.ts`
- `mcp-server/src/session-message-service.ts`
- `mcp-server/dist/server.mjs`
- `claude-plugin/mcp-server/dist/server.mjs`
- `tests/session-messaging/message-retention.test.ts`

같은 범위에서 store·broker·client·contracts·runtime의 `--stat`은 비어 있다. dist diff는 문자열 2줄씩(삭제 2, 추가 2)이다. 두 dist의 `server.mjs`는 같은 파일이다(`cmp` 동일). `session-message-service.ts:74`에서는 템플릿 문자열만 바뀌었고 분기 조건은 그대로다.

### 2. R1 해소 — PASS

감사 테스트는 `tests/reaudit2-guidance.test.ts`, 로그는 `logs/reaudit2-guidance.log`다.

| 시험 | 조건 | 결과 |
|---|---|---|
| G1 (N5-b 대응, 실제 broker와 service) | `earliestReleaseAt`(약 2h 뒤) > draft `expiresAt`(10분 뒤) | 거절 문구가 "If earliestReleaseAt is before that expiresAt, retry that same messageId after earliestReleaseAt; otherwise the draft expires first, so prepare again. Never do both."를 포함한다. 이 조건이면 분기는 새 prepare 쪽이다. "do not prepare again"이나 "Retry only the known prepared ID" 같은 불확실 안내는 없다. 두 시각이 지난 뒤 새 prepare→send는 1회 수락되고, 같은 본문 메시지는 1개, 옛 ID의 행은 0개다 |
| G2 (N5-a 조건) | 해제 = 30s+1h < draft 만료(해제+5분) | 해제 시각에 같은 ID로 재시도하면 `duplicate: false`로 1회 삽입된다. 그 뒤 재시도는 `duplicate: true`이고, draft 만료 뒤에도 영수증으로 `duplicate: true`다. 같은 본문 메시지는 1개다 |
| G3 경계 | 해제 == draft 만료 | 그 시각의 같은 ID 재시도는 unavailable이고 행은 0개다. "before"가 아니므로 안내도 새 prepare 쪽이라 코드와 일치한다 |
| G3 경계 | 해제 == draft 만료 − 1ms | 해제 시각의 같은 ID 재시도는 수락된다 |

경계 근거: draft는 `expires_at > now`일 때만 쓸 수 있다(`session-message-store.ts:335-336`). 자리는 `expires_at <= now`일 때 풀린다(`:284`). 따라서 "earliestReleaseAt이 expiresAt보다 이르면"이라는 엄격한 부등호가 정확한 조건이다.

참고: 1차 재감사 때의 N5-b(`tests/reaudit-n5.test.ts`)는 이번 후보에서 실패한다. 이 테스트는 이전 문구 "either retry … not both"를 단언하므로, 실패는 문구가 바뀌었다는 뜻이다(`logs/reaudit2-guidance.log`). 새 문구에 대한 판정은 G1로 했다. N5-a("둘 다 하면 두 번 전달")는 계속 통과한다. 따라서 "Never do both"는 여전히 필요한 안내다.

### 3. 새 문서 문장의 멱등성 — PASS

`docs/session-message-lifecycle.md:35`에 추가된 문장은 다음과 같다. "용량 거절을 받은 뒤 그 ID로 다시 send하지 않았는데 draft가 만료돼 같은 ID의 send가 unknown으로 거절될 수 있다. 이 경우 … 저장한 거절 응답과 대조한 뒤 새로 prepare해도 된다. 확정 거절 기록이 없는 unknown ID는 기존처럼 …"

이 문장이 안전한 이유:

- 확정 거절 응답은 그 호출이 끝난 시점의 최종 상태를 나타낸다.
  - 용량 검사는 duplicate 판정 뒤에만 있다(`session-message-store.ts:338-343`). 그래서 이미 큐에 든 ID는 확정 거절을 받을 수 없다(M05 검출).
  - client는 broker 거절을 재시도하지 않는다. transport 실패로 재시도하더라도 첫 시도가 큐에 넣었다면 duplicate를 받는다.
  - 따라서 "확정 거절 기록이 있고, 그 뒤 그 ID로 send하지 않았다"면 그 ID는 큐에 들어간 적이 없다.
- 같은 ID는 그 sender 세션만 보낼 수 있다(`:335`의 sender 조건). 문서의 "그 ID로 다시 send하지 않았는데"라는 조건이 확정 이후의 유일한 효과 경로를 막는다. 반대로 해제 뒤 같은 ID로 재시도했는데 응답을 잃었다면 이 조건에 해당하지 않으므로, 기존 불확실 규칙이 적용된다.
- 확정 거절 기록이 없는 unknown과 섞일 경로를 점검했다(G4).
  - 모르는 ID의 send는 `details: null`이고 "delivery may be unknown … do not prepare again for the same uncertain delivery" 안내가 붙는다.
  - 확정 문구나 새 조건부 문구는 붙지 않는다.
  - 이 예외는 호출자가 저장한 확정 거절 응답이 있을 때만 쓸 수 있다. 도구 응답이 스스로 이 예외를 적용하는 경로는 없다.
  - M21(모든 거절을 확정으로 표시)은 이번에도 후보 테스트 2건이 검출한다.

### 4. 세 곳의 뜻 일치와 표현 — PASS

| 위치 | 핵심 |
|---|---|
| `session-message-service.ts:74` | prepare가 돌려준 `expiresAt`까지 prepared로 남는다. `earliestReleaseAt`이 그보다 이르면 그 뒤 같은 ID로 재시도하고, 아니면 새로 prepare한다. 둘 다 하지 않는다 |
| `server.ts:536` | 같은 뜻(“if earliestReleaseAt is before that expiresAt, retry that same ID after earliestReleaseAt, otherwise prepare again. Never do both.”) |
| `docs/session-message-lifecycle.md:35` | 같은 뜻에, 위 3절의 draft 만료 뒤 unknown 예외를 더했다 |

- 세 곳의 분기 조건과 결론은 같다. 문서의 예외 문장은 도구 문구와 충돌하지 않는다(O2 참고).
- 추가된 줄에서 `codex|claude|grok|spark|openai|anthropic|principal|authenticat|인증`은 0건이다.
- 확정 안내가 불확실한 경우에 붙지 않는지도 확인했다.
  - 코드 분기(`capacityDetails`)는 그대로다.
  - M21은 검출된다.
  - 감사 I6은 BASELINE 감사 열 16/16에 포함돼 통과했다.
  - G4도 통과했다.

### 5. 새 테스트와 M16·M19·M21 — PASS

- 후보 테스트의 문구 고정 방식:
  - 안내 한 덩어리를 상수 `RETRY_GUIDANCE`로 두고 `toContain`으로 정확히 부분 일치시킨다(`message-retention.test.ts:16`, `:256`, `:366`).
  - "otherwise the draft expires first, so prepare again"도 따로 단언한다(`:367`).
- 새 사례(`:353-382`)가 확인하는 것:
  - `earliestReleaseAt`이 draft 만료보다 늦은지를 전제로 먼저 단언한다(`:365`). 영수증 보존이 2h라 실제 시각에 의존하지 않는다.
  - 만료된 같은 ID가 unknown이고 행이 0개임을 본다.
  - 새 prepare→send가 1회 수락되고 같은 본문 메시지가 1개임을 본다.
- mutant 22개 재실행 결과(`logs/mutants/mutants.tsv`):

| 구분 | 결과 |
|---|---|
| BASELINE | 후보 테스트 267 통과·1 skip, 감사 테스트 16/16 통과 |
| M01–M22 | 모두 후보 테스트가 검출(22/22) |
| M16 service details null | 검출(2): service capacity 사례, 새 draft 만료 사례 |
| M19 불확실 안내 사용 | 검출(2): 같음 |
| M21 모든 거절을 확정으로 | 검출(2): 같음 |

실행 뒤 mutation worktree의 `git status`는 비어 있다.

### 6. 전체 검증 — PASS

지난번과 같은 순서로 실행했다(`logs/full-validation/exit-codes.tsv`).

| 명령 | 종료 코드 |
|---|---|
| install --frozen-lockfile | 0 |
| bundle:check | 0 |
| claude:drift | 0 |
| lint | 0 |
| build | 0 |
| test | 0(827개 통과·1개 skip, previous-broker) |
| runtime:check | 0 |
| validate:all | 0 |
| validate:official | 1 — **FAIL_UNRELATED(환경)**: `/root/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py` ENOENT |
| claude:build | 0 |
| claude:check | 0 |
| git diff --check | 0 |

생성물 일치: build 뒤, claude:build 뒤, 마지막 시점의 `git status --porcelain`이 모두 0 byte다.

## 참고 관찰(finding 아님, 판정에 영향 없음)

- **O1**: service 문구의 끝에는 기존 `capacityRelease` 문장("…; after that a new prepare_session_message may succeed.")이 조건부 안내 뒤에 그대로 붙는다. 같은 ID 재시도 분기에서도 이 문장이 보인다. 바로 앞에 "Never do both."가 있어 둘 다 하라는 뜻으로 읽히지는 않는다. 원한다면 이 꼬리 문장을 "capacity may be free after that time"처럼 분기와 무관한 표현으로 바꿀 수 있다.
- **O2**: 문서 `:35`의 "draft 만료 뒤 unknown이면 새 prepare 허용" 예외는 문서에만 있다. 도구 응답의 unknown 문구는 여전히 "do not prepare again for the same uncertain delivery"이지만, 이 문구는 불확실한 경우에만 적용된다고 명시하므로 모순은 아니다. 이 예외가 필요한 경우는 좁다. 해제가 draft 만료보다 일러서 같은 ID 분기를 골랐지만 재시도가 draft 만료 뒤에 도착한 경우다. 이때도 중복 전달은 생기지 않는다.

## 실행하지 못한 것(NOT_RUN)

| 항목 | 이유 |
|---|---|
| Windows | 이 감사는 Linux cloud 컨테이너 한 곳에서만 실행했다 |
| 실제 호스트(Codex, Claude Code 등)의 MCP 호출, 실제 설치와 설치 캐시 | 컨테이너에 실제 호스트 설치가 없다 |
| `pnpm validate:official` | FAIL_UNRELATED(환경) |
| previous-broker·통합 병합 재실행 | 이번 요청 범위 밖이다. 이 commit은 문구와 테스트만 바꾸어 wire와 store 동작에 영향이 없다(1절) |

## 산출물

- `audit/REPORT.md`(이 파일), `meta.json`, `SHA256SUMS`
- `tests/reaudit2-guidance.test.ts`(G1–G4). 참고로 이전 감사 테스트 `tests/reaudit-n5.test.ts`도 넣었다
- `logs/full-validation/`, `logs/mutants/`, `logs/reaudit2-guidance.log`
- 사용한 스크립트는 이전 증거 브랜치의 `scripts/full-validation.sh`, `scripts/mutants.py`, `scripts/run-mutants.sh`와 같고, `scripts/`에 복사했다

## 비밀값·개인정보 처리

push 전에 다음 패턴으로 모든 산출물을 검사했다.

- 비밀값: `ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `AKIA`, `BEGIN PRIVATE KEY`, `Authorization: Bearer`
- 개인정보: 이메일 주소, IPv4 주소, 계정 이름

걸린 값은 없었고, 결과는 `meta.json`의 `redaction`에 적었다. env·printenv 전체 출력은 남기지 않았다.
