# AGS 2.7.3 wake-liveness 재감사 보고서 (e739090 → 651f5ec)

- 새 후보: `claude/v273-wake-liveness` = `651f5ec94e120703b2685c6fbbe68cfebd1afbfd` (tree `a857f79deb3c250a072f15a9306f62b6f8e0ed6e`)
  - `cc0d51c0`: F1과 F4 수정
  - `651f5ec9`: F2, F3, F5, F6의 문서·도구 설명·schema 설명
- 이전 감사 대상: `e739090952710d418a67dae71d76b1f2ef169441`. 이전 감사 evidence는 `claude/evidence-v273-wake-audit-20260928T144912Z`(`0b63801`)에 있다.
- writer evidence `claude/evidence-v273-wake-fix-20260928T150836Z`(`7a80789`)는 있는 것만 확인했다. 판정 근거로는 쓰지 않았다.
- 범위: `git diff e739090 651f5ec9`의 15개 파일. 읽기 전용이며 제품 소스는 고치지 않았다. mutant는 버리는 worktree에서만 적용했다가 되돌렸다.
- 환경: Linux cloud 컨테이너 1대, Node v24.21.0, pnpm 11.19.0.

## 최종 판정: **ACCEPT**

이전 minor 6건(F1~F6)은 모두 해소됐다. 새 finding은 없다. 새 코드는 F1 수정으로 바뀐 `claimHostWake`(`session-message-store.ts:1017-1047`)와 F4 capability 이동이다. 둘 다 직접 재현, 반증, mutation으로 확인했다.

## 항목별 결과

| # | 항목 | 결과 | 근거 |
|---|---|---|---|
| 1 | F1 | PASS | 감사 2b 원본은 예상대로 실패한다(옛 동작 단정). 기대값을 고친 사본 F1-a~f와 hook 수준 시험 4건은 통과했다. mutant M1은 writer 테스트가 잡았다. |
| 2 | F4 | PASS | hook의 wake 판정에 host 이름 분기가 없다. capability는 host adapter 모듈에서 정한다. Claude 동작은 e739090과 같다. mutant M2~M4는 writer 테스트가 잡았다. |
| 3 | F2·F3·F5·F6 문서·설명 | PASS | 문구가 코드 동작과 일치한다. 생성물 사본과 byte가 같다. |
| 4 | race·retire 재실행 | PASS | retire 18개 중 17개 통과. 실패 1개는 2b 원본이며 F1 수정으로 기대된 실패다. race는 10회와 40회 모두 통과했다. |
| 5 | 전체 검증 | PASS (validate:official만 FAIL_UNRELATED) | 아래 표 |
| 6 | previous-broker 호환 | PASS | v2.7.2, v2.7.1, v2.2.6의 broker 파일 경로로 각각 2/2 통과 |

### 1. F1 — PASS

코드(`session-message-store.ts:1020-1047`)의 흐름은 다음과 같다.

1. 검증된 prompt의 퇴역 행에는 `late_observed_at`만 `coalesce`로 한 번 기록한다.
2. 퇴역 행을 뺀 나머지 행(`live`)만으로 판정한다.
3. `live`가 비면 `{recognized:false, retired:true}`를 돌려준다.
4. `live`가 현재 세대로 유효하면 claim하고 관측한다.
5. 유효하지 않으면 옛 세대·만료 규칙을 따르고 `retired` 표시는 붙이지 않는다.

observed로 쓰는 UPDATE는 `live`에만 적용되므로 퇴역 행은 observed가 될 수 없다.

- **2b 원본**(`logs/audit-retire-on-651f5ec.log`): 예상대로 실패했다. probe 출력은 `recognized:true`, messages 1건(현재 본문), binding=W2, `w2late:null`, pending 0이다.
- **F1-a**(2b 기대값 수정본): 현재 attempt가 자기 본문을 1번 claim한다. W2는 `observed`이고 `late_observed_at`은 null이다. 퇴역 행은 `expired-unobserved`를 유지하고 late만 기록되며, 나머지 열은 그대로다. 같은 marker를 순서를 바꾸거나 현재 marker만 넣어 새 receipt로 3번 다시 보내도 두 번째 claim은 없고, 퇴역 행의 late 시각도 처음 값 그대로다.
- **F1-b**: 퇴역 marker만 있는 prompt는 여전히 `retired:true`이고 본문을 claim하지 않는다. late는 한 번만 기록되며(중복 nonce 포함 재도착 시에도 그대로) pending은 1로 남는다.
- **F1-c**: 퇴역 marker와 퇴역하지 않은 옛 세대 marker가 섞인 경우다. 결과는 `{recognized:false}`이고 `retired` 표시가 없으며 claim도 없다. 옛 세대 행은 `observed`가 된다(기존 늦은 도착 규칙). 옛 marker가 현재 판정을 "차단"이나 "claim" 쪽으로 바꾸는 경로는 없다.
- **F1-d**: 퇴역, 현재, 미등록 nonce가 섞이면 prompt 전체를 거절하고 아무것도 쓰지 않는다.
- **F1-e**: 섞인 prompt에 위조 receipt를 쓰면 아무것도 쓰지 않는다.
- **F1-f**: 퇴역 marker와, 만료가 지난 현재 marker가 섞이면 claim하지 않고 `retired` 표시도 없다.
- **hook 수준**(`tests/audit/reaudit-f1-hook.test.ts`, 실제 source broker):
  - codex와 claude-code 모두 섞인 prompt에서 현재 본문이 전달되고 차단되지 않는다. 같은 prompt를 다시 보내면 본문도 차단도 없다.
  - 퇴역 marker만 있는 prompt는 codex에서만 `decision: block`이고 claude-code는 `{}`다.
  - 같은 파일을 e739090에서 돌리면 섞인 prompt 2건은 실패하고(옛 동작), 퇴역 marker만 있는 2건은 통과한다(`logs/reaudit-f1-hook-on-e739090.log`).
- **Mutation**(`mutants.sh`, `logs/mutants-summary.log`): M1은 store를 e739090으로 되돌린 것이다. writer의 `F1: a retired nonce mixed with the current nonce …`가 실패해 잡혔다. 대조군(변형 없음)은 98/98 통과했다.

### 2. F4 — PASS

- `session-message-hook.ts`의 두 차단 조건(`:206`, `:211`)은 이제 `profile.blocksEmptyWakePrompt`만 본다. hook 파일에 남은 host 이름은 두 곳이다.
  - `:31` (`host === "codex" ? explicitHostPid : process.ppid`): 이전부터 있던 프로세스 식별 코드이며 이번 변경과 wake 판정 모두와 무관하다.
  - `:248`: Codex 진입점 호출이다.
- 위치 판정: capability는 `host-input-adapter.ts:130`의 `hostDeliveryProfile`에서 정한다. 이 모듈은 원래 host별 transport 선택(`claude-inbox`, `codex-queue`, `codex-deferred`)과 Codex 전용 `nativePeerWait`를 담는 host adapter 경계다. 공통 판정 로직(hook의 wake 분기, store, broker)은 벤더 이름을 보지 않는다. AGENTS.md의 "공통 구현과 벤더별 adapter 분리"에 맞다.
  - 새 host의 기본값은 `false`(fail-open)라 안전하다.
  - codex-deferred도 `true`지만, 이 경로는 `supportsInjection(peer-wake)`일 때만 도달하므로 동작은 e739090과 같다.
- Claude(`blocksEmptyWakePrompt:false`) 동작: 퇴역 marker만 있는 prompt는 e739090과 새 후보 모두 `{}`이고 pending이 유지된다. 앞서 본 hook 시험을 양쪽에서 돌려 확인했다. writer 테스트 `blocks a verified retired Codex wake marker…`도 claude-code는 `{}`를 요구한다.
- Mutation(`logs/mutants-summary-M2-M4-clean.log`, dist 재빌드 포함):
  - M2(capability 항상 true): 3개 실패로 잡힘.
  - M3(항상 false): 3개 실패로 잡힘.
  - M4(퇴역 차단이 capability를 무시): 1개 실패로 잡힘.
  - 첫 실행(`logs/mutants-summary.log`)에서는 M1의 staged 변경이 되돌려지지 않아 M2~M4가 오염됐다. 그래서 M1만 그 로그에서 채택했고, M2~M4는 `git checkout HEAD -- .`로 고쳐 다시 실행한 결과를 쓴다.

### 3. F2·F3·F5·F6 — PASS

- **F2**: 문서에 "(주입 TTL + 유예), 곧 약 70분마다 최대 1개"라는 누적 상한과 "활동도 새 세대도 없는 세션에는 쌓이지 않는다"가 추가됐다. 거절 대안의 설명도 고쳐졌다. 감사 LT probe를 새 후보에서 다시 돌려도 제출 간격이 70분 이상인 4개로, 코드는 바뀌지 않았고 문서와 일치한다(1주기당 1개).
- **F3**: schema 설명과 문서 표가 "현재 세대가 아니거나 만료된 이전 알림이 새 wake를 막고 있다"로 바뀌었다. 감사 5b 출력(만료 전 옛 세대 → `latched`, 미래 `basisAt`)과 일치한다.
- **F5**: 활동 목록에 SessionEnd 정리와 hook 없는 CLI의 claim·ACK가 추가됐다(`session-message-hook.ts:150`, `session-message-cli.ts:9`와 일치). 신뢰 수준(같은 OS 사용자, 비권위)도 명시됐다.
- **F6**: `list_session_status`와 `get_session_message_status` 설명, 문서에 "조회도 prune과 퇴역을 일으킬 수 있다(멱등)"가 추가됐다. `listPresence`(`:1151`)와 `status`(`:616`)의 prune과 일치한다.
- **F1·F4 문서**: "모든 marker가 퇴역한 경우에만 `blocksEmptyWakePrompt` host가 차단", "섞이면 퇴역 행은 판정에서 빠진다", "나머지가 무효하면 `retired`를 붙이지 않는다"는 모두 F1-a~f와 hook 시험 결과와 일치한다.
- **생성물**:
  - `contracts/session-auto-wake-outlook.v1.schema.json`, `mcp-server/dist/{server,session-message-broker,session-message-hook}.mjs`가 `claude-plugin/` 사본과 byte 단위로 같다(`cmp`).
  - 전체 검증 중 build와 claude:build 뒤 `git status --porcelain`과 `git diff --stat`이 비어 있었다.

### 4. race·retire 재실행 — PASS

- `audit-retire.test.mjs` 18개 중 17개가 통과했다. 1개는 2b 원본의 예상된 실패다(`logs/audit-retire-on-651f5ec.log`). 1a~1i(퇴역 조건), 2a·2c·2d, 5a, C2 fuzz 2000개는 모두 통과했다.
- `audit-race.test.mjs`는 10회(`logs/audit-race-10rounds.log`)와 40회(`logs/audit-race-40rounds.log`) 모두 3/3 통과했다.
  - R1: relay 6개 프로세스, 매 회 effect 1개.
  - R2: 늦은 도착 대 relay, 옛 nonce의 claim 0건.
  - R3: 활동 뒤 relay 4개, effect 1개.
- F1 재감사 테스트는 `reaudit-f1-store.test.mjs` 6개와 `reaudit-f1-hook.test.ts` 4개, 합계 10/10 통과했다(`logs/reaudit-f1.log`).

### 5. 전체 검증 — PASS (validate:official만 FAIL_UNRELATED)

별도 worktree(`651f5ec` detached)에서 지난번과 같은 순서로 실행했다(`harness/run-full.sh`, `logs/full-summary.tsv`).

| 순서 | 명령 | 종료 코드 |
|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | 0 |
| 2 | `pnpm bundle:check` | 0 |
| 3 | `pnpm claude:drift` | 0 (`claude-plugin: fresh`) |
| 4 | `pnpm lint` | 0 |
| 5 | `pnpm build` | 0 |
| 6 | `pnpm test` | 0 (파일 60 통과·1 skip, 테스트 839 통과·2 skip) |
| 7 | `pnpm runtime:check` | 0 (29 skill CLI) |
| 8 | `pnpm validate:all` | 0 |
| 9 | `pnpm validate:official` | 1, **FAIL_UNRELATED(환경)**: Codex `validate_plugin.py` ENOENT |
| 10 | `pnpm claude:build` | 0 |
| 11 | `pnpm claude:check` | 0 (`fresh`) |
| 12 | `git diff --check` | 0 |

이번 전체 실행에서 `korean-prose-cycle-receipt`는 통과했다.

### 6. previous-broker 호환 — PASS

`AGS_PREVIOUS_BROKER_PATH`에는 디렉터리가 아니라 파일 경로를 줬다. 각 파일은 `git archive <tag> mcp-server/dist`로 추출했고, sha256 앞 16자는 `git show <tag>:…`의 해시와 같다.

| 태그 | 파일 sha256(앞 16자) | 결과 |
|---|---|---|
| v2.7.2 | `fbb808e0fd8d52df` | 2/2 통과 |
| v2.7.1 | `d4b667d417c6c8a8` | 2/2 통과 |
| v2.2.6 | `14f9345d3b18611f` | 2/2 통과 |

## Findings

새 finding은 없다. 이전 F1~F6의 상태는 다음과 같다.

| ID | 이전 심각도 | 상태 | 근거 |
|---|---|---|---|
| F1 | minor | 해소 | 1절 |
| F2 | minor | 해소(문서) | 3절 |
| F3 | minor | 해소(schema·문서) | 3절 |
| F4 | minor | 해소 | 2절 |
| F5 | minor | 해소(문서) | 3절 |
| F6 | minor | 해소(설명·문서) | 3절 |

참고(정보, finding 아님): `session-message-hook.ts:31`의 `host === "codex"` 프로세스 식별 분기는 이번 변경 범위 밖에 이전부터 있던 코드다.

## NOT_RUN과 이유

- Windows(Node 24) 검증: NOT_RUN. Linux cloud 한 환경에서만 했다.
- 실제 Codex·Claude host에서의 wake 주입·관측과 host queue의 marker 병합 빈도: NOT_RUN. host 환경이 없다.
- 실제 설치 캐시, marketplace, 설치된 MCP 동작: NOT_RUN. 설치 환경이 없다.
- `pnpm validate:official`: 실행했으나 FAIL_UNRELATED(환경). PASS로 세지 않는다.
- 이번 변경 범위 밖(이관, 퇴역 조건 SQL, outlook 계산)은 코드가 바뀌지 않았다(`git diff e739090 651f5ec9`로 확인). 그래서 이관 SIGKILL campaign은 다시 돌리지 않았다(NOT_RUN, 이전 감사 결과 유지). 퇴역 조건 테스트와 race는 다시 돌렸다.
- korean-prose flaky 반복: 이번 범위가 아니라 반복하지 않았다(NOT_RUN). 전체 test 1회는 통과했다.

## 가림(redaction)

이전 감사와 같은 `harness/redact.py`를 적용했다. 대상은 토큰·키 형태, private key 줄, Bearer 헤더, 이메일(`noreply@anthropic.com` 제외), 사용자 이름이 든 홈 경로, root 홈 경로, IPv4이며 건수는 `meta.json`의 `redaction`에 있다. 가린 뒤 `SHA256SUMS`를 다시 만들었다. 하네스 스크립트 안의 경로도 가려졌으므로 다시 실행할 때는 실제 경로로 바꿔야 한다.

## 산출물

- `audit/REPORT.md`, `audit/meta.json`, `audit/SHA256SUMS`
- `audit/logs/`: 전체 검증, 재감사 테스트, mutant, previous-broker, race 로그
- `audit/tests/`: `reaudit-f1-store.test.mjs`, `reaudit-f1-hook.test.ts`, 이전 감사의 `audit-retire.test.mjs`·`audit-race.test.mjs`·`fixtures/audit-race-worker.mjs`
- `audit/harness/`: `run-full.sh`, `mutants.sh`, `redact.py`, `make-meta.sh`
