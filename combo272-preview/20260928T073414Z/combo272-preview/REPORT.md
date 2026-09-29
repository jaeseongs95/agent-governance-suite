# CASE=combo272-preview: 2.7.2 결합 미리보기

**최종 결합 후보가 아니다.** reconcile e9b4c73은 독립 감사 F1(trust DB 경로 결속 불일치)로 수정될 예정이다. docs patch에는 2.7.x에 없는 FlowMarshal 서술(`docs/architecture.md:25`)이 들어 있다. 이 문서는 결합 상호작용 결함을 먼저 찾으려는 미리보기다. 결합 commit은 `/tmp/combo` 안에만 있고 push하지 않았다.

- 환경: Linux cloud 컨테이너 1개. Node v24.21.0(nodejs.org tarball, SHASUMS256으로 검증), pnpm 11.19.0(corepack). 사용자 PC의 실제 설치, 설치 캐시, live host 증거가 아니다.
- 입력: wake `53eff30a`, reconcile `e9b4c73b`, intake `2b53e325`, docs patch(sha256 `812cb623…f1`, evidence branch `claude/evidence-wake53-docs-merge-trial-20260928T065200Z`)

## 1. merge 과정

| 단계 | 결과 | 근거 |
|---|---|---|
| fetch 5개 branch | 세 branch의 tip이 지정 SHA와 일치 | 01 |
| `merge-tree --merge-base 53eff30a e9b4c73 2b53e325` | tree `144bda8a46b4690079dd64b185101bd13e556f21`, 충돌 없음 | 03 |
| merge e9b4c73(`--no-ff`) | `9c7bab9`, 충돌 없음(ort) | 04 |
| merge 2b53e325 | `6c3fbe84b312f757d3c5df26dc5265dce066dab4`, 두 dist `server.mjs`가 자동 merge되고 충돌 없음 | 05 |
| 코드 결합 tree와 예상값 비교 | `144bda8a…` = 예상값 **일치** | 06 |
| docs patch `git apply --3way` | 기준 blob(`2f89fad`, `89afbee`)이 저장소에 없어 3-way를 쓰지 못하고 직접 적용으로 넘어감. 세 파일 모두 적용됨(apply exit 0). patch 기준이 53eff30a의 architecture.md(`c68f8ab`)·roadmap.md(`8f2a3b0`)와 다르지만 context가 맞았다 | 08 |
| docs commit | **combo `db35be0649d54c8065b5699adaa267c9bc779385`, tree `4b730ef51dc0ec74f987c10ad899a5442c77244a`** | 08, 81 |
| FlowMarshal 확인 | 저장소 전체(ts/md/mjs/json)에서 `docs/architecture.md:25` 한 곳에만 나옴. 코드에는 없다 → 대조 결과가 재확인됨 | 09 |
| 공식 재생성(`pnpm build`, `pnpm claude:build`) | 두 명령 모두 EXIT 0. 재생성된 dist 18개(Codex·Claude)가 자동 merge 결과와 **byte 단위로 같다**. 작업 트리 변경이 없어 재생성 commit도 없다 | 14, 15, 16, 17 |

재생성 dist sha256 전체는 `82-combo-dist-sha256.txt`에 있다. 주요 파일(Codex와 Claude가 같음):
- `server.mjs` `9231cb1e2bc86820c2c3d3d5384eaecb434037b413f8f95e4b50c741550043d3`
- `session-message-broker.mjs` `80c00e7b96dd3e4ef32aeea10dc8683c7123c3334b04df002507207bee2ace65`
- `session-message-cli.mjs` `41977dabc6a50c36e3128b50ed7717fc6057f60760601356c2d67d4c842a98bb`
- `session-message-hook.mjs` `cb29a763646e4ce8113424f3dbceb0dff1c9bf7d5100e279c95103511122a092`

## 2. 검증 exit 표 (combo `db35be0`)

| 명령 | EXIT | 판정 | 로그 |
|---|---|---|---|
| `pnpm install --frozen-lockfile` | 0 | PASS | 10 |
| `pnpm bundle:check` (재생성 전, 자동 merge dist) | 0 | PASS | 11 |
| `pnpm bundle:check` | 0 | PASS | 20 |
| `pnpm claude:drift` | 0 (`claude-plugin: fresh`, 경고 없음) | PASS | 21 |
| `pnpm claude:check` | 0 | PASS | 22 |
| `pnpm lint` | 0 | PASS | 23 |
| `pnpm build` | 0 | PASS | 24 |
| build 뒤 `git status --porcelain` | 0줄(clean) | PASS | 25 |
| `pnpm test` 1회차 / 2회차 | 0 / 0 (769 passed, 1 skipped / 770) | PASS | 26 |
| `pnpm test --reporter=json` 1회차 / 2회차 | 0 / 0 (JSON: 770 tests, 769 passed, 0 failed, 1 skipped) | PASS | 29 (+ `.json`) |
| `pnpm runtime:check` | 0 (`runtime: ready (29 skill CLIs, Node.js 24.21.0)`) | PASS | 30 |
| `pnpm validate:all` | 0 (404·NOT_VERIFIABLE 없음) | PASS | 31 |
| `pnpm validate:official` | 1 | **NOT_RUN**: `/root/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py` 없음(ENOENT). Codex 공식 validator가 이 환경에 없다 | 32 |
| `pnpm bundle:check` (마지막) | 0 | PASS | 33 |
| `git diff --check` | 0 | PASS | 34 |
| 최종 `git status` | 0줄 | PASS | 35 |

### 테스트 수와 실패·건너뜀 전체 이름

- 전체 test(29 JSON, 2회 동일): 136 suites, 770 tests, 통과 769, 실패 0, 건너뜀 1
  - 건너뜀: `tests/session-messaging/previous-broker.test.ts :: preserves queued messages when new hooks meet the previous released broker` (`AGS_PREVIOUS_BROKER_PATH`가 없을 때 `skipIf`로 건너뜀)
- **harness 결함으로 폐기한 실행(제품 FAIL로 세지 않음)**
  - 26: `pnpm test -- --reporter…` 형식에서 `--` 때문에 reporter 인자가 vitest에 전달되지 않아 JSON이 없었다. 테스트 결과는 유효하다(0 failed).
  - 27: `bash -c "… pnpm exec vitest …"`로 실행하니 `npm_execpath`가 설정되지 않았다. 그래서 `tests/tooling/commands.test.mjs :: skill maintenance commands forwards pnpm script arguments without a standalone separator`가 2회 모두 실패했다(`expected undefined to be truthy`, commands.test.mjs:37). 공식 `pnpm test` 경로(26, 29)에서는 통과했다.

## 3. 상호작용 실험

### 3a. 순서 무작위 반복 (`--sequence.shuffle.files --sequence.shuffle.tests`)

대상: `tests/session-messaging`(wake-lifecycle, historical-wake, message-lifecycle, broker-lifecycle, peer-wait, session-message, self-signed-certificate, previous-broker), `tests/session-board`, `tests/mcp/trust-provenance.test.ts`, `tests/mcp/tool-schema-profile.test.ts`, `tests/tooling/skill-context-optimization.test.mjs`, `tests/tooling/claude-plugin.test.mjs`

| seed | EXIT | tests | 통과 | 실패 | 건너뜀 |
|---|---|---|---|---|---|
| 11 | 0 | 248 | 247 | 0 | 1 (previous-broker, 위와 같은 이름) |
| 272 | 0 | 248 | 247 | 0 | 1 |
| 4242 | 0 | 248 | 247 | 0 | 1 |
| 53053 | 0 | 248 | 247 | 0 | 1 |
| 99991 | 0 | 248 | 247 | 0 | 1 |

판정: PASS. 5개 seed에서 순서 의존 실패가 없었다(40, 41).

### 3b. previous-broker 테스트를 2.7.1 broker로 켜기 (추가 실험)

`AGS_PREVIOUS_BROKER_PATH=/tmp/v271/mcp-server/dist/session-message-broker.mjs`(d5c5932) → EXIT 1. 실패 테스트: `tests/session-messaging/previous-broker.test.ts :: preserves queued messages when new hooks meet the previous released broker`. 원인은 `expected [ 'atomic-wake-claim', …(3) ] to not include 'deferred-boundary'`이다. 이 테스트는 `deferred-boundary`가 없는 옛 broker(2026-09-20에 작성, 8651aca 이전)를 전제로 한다. 2.7.1 broker는 이미 이 capability를 광고하므로 전제 단언에서 멈췄다. 결합 코드의 결함 근거가 아니며, 2.7.1을 "이전 broker"로 둔 호환성은 이 테스트로 **UNKNOWN**이다(45).

### 3c. clean-room (git archive, node_modules 0개)

`git archive db35be0`를 `/tmp/cr/codex`(Codex 루트)에 풀고, `claude-plugin/`만 따로 `/tmp/cr/claude`에 복사했다. archive dist와 작업 트리 dist의 sha256은 같다(60). HOME·XDG_STATE_HOME은 임시 디렉터리로 격리했다.

| 항목 | Codex 루트 | Claude `claude-plugin/` |
|---|---|---|
| MCP initialize | PASS (protocol 2025-06-18, serverInfo version **2.7.1**) | PASS (같음) |
| tools/list | PASS, 28개 | PASS, 28개(이름 집합이 Codex와 같음) |
| schema의 `$ref` 수 | 38 (기본 profile) | 0 (`anthropic` profile로 inline 처리) |
| hook 실행 | 14개 모두 exit 0, timeout 안, stdout JSON 파싱 오류 0 | 18개 모두 exit 0, timeout 안, 파싱 오류 0 |

hook 32개(이벤트·matcher별 전체 목록): SessionStart·SessionEnd·UserPromptSubmit·PreCompact·PostCompact·PreToolUse(host-attestation, session-message, continuity, session-board, shell/Bash/Edit)·PostToolUse·PostModelSwitch·Stop. 세부 내용은 61에 있다. SessionStart hook이 띄운 detached broker 2개와 relay 1개가 hook 종료 뒤에도 남아 있었고, 기록한 뒤 종료했다(62, 예상된 동작).

참고: serverInfo version이 2.7.1이다. 이 미리보기에는 release metadata 갱신이 없다(결함이 아니라 후보 조립 때 할 일).

### 3d. 2.7.1 상태 → 결합 트리 reconcile 1회 복구

1. `/tmp/v271`(d5c5932)에서 evidence 스크립트 `build-271-state.mjs`로 일회용 2.7.1 상태를 만들었다. T0–T6를 만들었고, T1–T6의 새 reserve는 모두 dispatch=false, T0 대조군은 true였다(52).
2. 복사본 3개(A, B, probe)를 두었다. receipt ID는 probe 복사본의 trust DB를 읽기 전용으로 열어 찾았다(71).
3. clean-room 결합 CLI(`/tmp/cr/codex/mcp-server/dist/session-message-cli.mjs`)로 호출했다. broker는 CLI가 자동으로 띄웠다(70).

| 호출 | 대상 | 결과 | 판정 |
|---|---|---|---|
| A1 | T6(같은 generation에서 late) | `reconciled:false` | 설계대로 거절(이전 generation만 대상) |
| A2 | T1(late 기록 없음) + T3 receipt | `reconciled:false` | PASS |
| A3 | T3 + T6 receipt(다른 대상) | `reconciled:false` | PASS |
| A4 | T3 + 추가 필드 `nowMs` | `ok:false` "unsupported fields", CLI exit 1 | PASS |
| **A5** | **T3 정상** | **`reconciled:true`**, evidence에 source ID·digest·oldBinding(inst-1/relay-1/epoch 1)·세 시각 | **PASS (1회 복구 관측)** |
| A6 | T3 반복 | `reconciled:false` | PASS |
| B1 | trust DB 경로를 없는 파일로 지정 | `reconciled:false`, 그 경로에 파일이 생기지 않음 | PASS (fail-closed, 생성 없음) |

전후 비교(75):
- A에서는 T3 행만 바뀌었다: `state unknown→observed`, `observed_at=05:30:14.000Z`(원본 관측 시각), `consumed_at=07:31:44.872Z`(복구 적용 시각).
- 나머지 행 6개, presence, messages(11), trust receipt(2)와 논리 digest는 그대로였다.
- `trust.sqlite3` 본 파일 sha256(`757f3534…`)도 그대로였다. 다만 `trust.sqlite3-shm`(32768 bytes)과 빈 `-wal`이 새로 생겼다. 문서가 말한 조정 파일 동작과 같다.
- B는 모든 행이 그대로였다.

복구 뒤 wake 재개(76, `/tmp/rc/A2` 복사본, 결합 소스 store): 현재 presence와 relay를 새로 시작하고 새 본문 1건을 넣은 뒤 reserve했다. **T3는 dispatch=true**였다. 대조군 T1(복구 대상 아님)은 dispatch=false로 계속 막혀 있다. 첫 시도(76-attempt1)는 본문 TTL이 지나 pending이 0이어서 비교할 수 없었고, 기록으로만 보존했다.

스크립트 오류로 다시 실행한 기록: `70-reconcile-271-attempt1-script-error.log`는 제 inspect 스크립트가 없는 `outcome` 열을 조회해 receipt ID가 빈 값이었던 실행이다. 모든 호출이 "Invalid historical wake identity"로 거절돼 상태 변화가 없었다. 그 뒤 새 복사본으로 다시 실행했다.

## 4. 상호작용 결함과 관찰

| # | 내용 | 판정 |
|---|---|---|
| 1 | 코드 결합 tree가 예상값과 같고, 공식 재생성 dist가 자동 merge 결과와 byte 단위로 같다 | PASS |
| 2 | 전체 test 2회, 무작위 5 seed, clean-room MCP·hook, reconcile 1회 복구에서 결합 상호작용 결함을 관측하지 못했다 | 결함 미관측 |
| 3 | docs의 FlowMarshal 서술(`docs/architecture.md:25`)이 결합 결과에 그대로 들어 있다. 2.7.x 코드에는 해당 기능이 없다 | FAIL (문서 정합, 알려진 사항) |
| 4 | reconcile에는 `sourceReceiptId`가 필요하지만, 이를 찾는 공개 CLI·MCP 경로를 이 실험에서 확인하지 못했다. 이번에는 trust DB를 읽기 전용으로 직접 조회해 얻었다. 운영 절차에 조회 방법이 필요한지는 확인이 필요하다 | UNKNOWN |
| 5 | T6(같은 generation, TTL 뒤 late), T1·T2·T4·T5(late 없음)는 reconcile 대상이 아니라 여전히 막혀 있다(문서화된 범위) | 관찰 |
| 6 | F1(trust DB 경로 결속)은 이번 범위에서 따로 재현하지 않았다. B1은 명시 경로가 없는 파일일 때 fail-closed임만 확인했다 | NOT_RUN(F1 재현) |

## 5. NOT_RUN과 한계

- `validate:official`: Codex 공식 validator 파일이 없어 NOT_RUN.
- 실제 Codex·Claude host, 설치 캐시, marketplace 설치, Windows CI 조합은 실행하지 않았다.
- 2.7.1 상태는 합성 이력이다. 사용자 운영 DB가 아니다.
- 원격에는 이 evidence branch만 push한다. 결합 commit `db35be0`은 로컬 `/tmp/combo`에만 있다.
