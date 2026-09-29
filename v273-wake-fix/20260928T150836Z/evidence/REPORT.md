# AGS 2.7.3 wake-liveness 감사 후속 수정 보고서 (F1~F6)

- 수정 전 후보: `claude/v273-wake-liveness` = `e739090952710d418a67dae71d76b1f2ef169441`
- 새 후보: `651f5ec94e120703b2685c6fbbe68cfebd1afbfd` (tree `a857f79deb3c250a072f15a9306f62b6f8e0ed6e`)
  - `cc0d51c` fix: let a current wake claim when a retired marker shares its prompt (F1, F4)
  - `651f5ec` docs: align wake retirement limits, latched meaning and read-side pruning (F2, F3, F5, F6)
- 감사 근거: `claude/evidence-v273-wake-audit-20260928T144912Z` (`0b63801`) `audit/REPORT.md`
- 환경: Linux cloud 컨테이너, Node v24.21.0, pnpm 11.19.0 (`meta.json`)
- push: `claude/v273-wake-liveness`에 non-force fast-forward(`e739090..651f5ec`), `git ls-remote`로 `651f5ec` 확인

새 의존성, schema 이관, ErrorCode는 추가하지 않았다. 병행 작업 영역(`submitPrepared`, `acknowledge`, `prepare`의 receipt 보존)은 건드리지 않았다. 바뀐 store 코드는 `claimHostWake` 안쪽뿐이다.

## finding별 변경

| finding | 변경 위치 | 내용 |
|---|---|---|
| F1 | `mcp-server/src/session-message-store.ts:1020-1047` | 퇴역 행은 먼저 `late_observed_at`만 기록하고 판정에서 뺀다(`live`). 모든 marker가 퇴역이면 `retired: true`를 돌려준다(`:1026`). 나머지 행이 현재 세대로 유효하면 평소처럼 관측하고 본문을 claim한다(`:1041`). 유효하지 않으면 기존의 늦은 도착 규칙을 따르고 `retired`는 붙이지 않는다(`:1033`) |
| F1 | `tests/session-messaging/wake-liveness.test.mjs:189` | 감사 2b를 회귀 테스트로 옮겼다. 섞인 prompt에서 현재 attempt가 본문을 claim하고, 퇴역 행은 late만 기록하며, 재생 시 `retired` 없이 거절되는지 확인한다 |
| F4 | `mcp-server/src/host-input-adapter.ts:118-131` | `HostDeliveryProfile.blocksEmptyWakePrompt` capability를 추가했다. 값은 adapter가 정한다(Codex `true`, Claude `false`) |
| F4 | `mcp-server/src/session-message-hook.ts:206`, `:211` | `host === "codex"` 두 분기를 `profile.blocksEmptyWakePrompt`로 바꿨다 |
| F4 | `tests/session-messaging/session-message.test.ts:802-805` | Codex queue·deferred는 `true`, Claude는 `false`임을 확인한다. 기존 hook 테스트(`blocks a verified retired Codex wake marker…`, empty-hook 시나리오)는 Codex 차단과 Claude fail-open이 그대로임을 계속 확인하며 통과한다 |
| F2 | `docs/session-message-lifecycle.md:124`, `:141`, `:149` | (주입 TTL + 유예)마다 marker 최대 1개라는 누적 상한을 명시했다. 잔여 marker 문구와 "만료만으로 해제" 거절 이유를 이 상한과 맞췄다. 활동 근거 범위는 바꾸지 않았다 |
| F3 | `contracts/session-auto-wake-outlook.v1.schema.json:12`, `docs/session-message-lifecycle.md:161` | `latched` 정의를 "현재 세대가 아니거나 만료된 이전 알림이 새 wake를 막고 있다"로 고쳤다. 출력 형태와 reason 값은 그대로다 |
| F5 | `docs/session-message-lifecycle.md:135`, `:137` | 활동 근거에 SessionEnd 정리와 hook 없는 CLI의 claim·ACK 호출을 넣었다. 근거는 권위가 아니며 같은 OS 사용자 수준이라는 문장을 덧붙였다 |
| F6 | `docs/session-message-lifecycle.md:139`, `mcp-server/src/server.ts:527`, `:551` | `list_session_status`와 `get_session_message_status`가 prune과 퇴역을 일으킬 수 있음을 문서와 도구 설명에 적었다. 동작과 annotation은 바꾸지 않았다 |
| F4 문서 | `docs/session-message-lifecycle.md:96`, `:145` | prompt 차단 조건을 `blocksEmptyWakePrompt` capability(현재 Codex)로 설명하고, 퇴역 차단은 모든 marker가 퇴역일 때만이라고 적었다 |

생성물 `mcp-server/dist/{session-message-broker,session-message-hook,server}.mjs`와 `claude-plugin/` 대응 파일, `claude-plugin/contracts/…outlook…json`은 `pnpm build`, `pnpm claude:build`로만 다시 만들었다.

## 먼저 실패한 테스트

- `tests/session-messaging/wake-liveness.test.mjs > F1: a retired nonce mixed with the current nonce …`
  - 수정 전 후보(e739090 코드 + 새 테스트): 실패, 종료 코드 1 (`logs/f1-before-fix.log`). 첫 assertion `result.recognized === true`에서 `false`로 실패한다.
  - 수정 후: 통과 (`logs/f1-f4-after-fix.log`, 전체 `logs/full-06-test.log`).
- 감사 원본 테스트 2b는 옛 동작(`messages.length === 0`)을 assertion으로 적은 probe다. 새 후보에서 원본 그대로 돌리면 이 assertion 하나만 실패한다(`logs/audit-tests-final-original.log`, 20 통과·1 실패). 수정 뒤 기대값으로 2b를 바꾼 사본(`logs/audit-2b-expectation-update.diff`)은 21/21 통과했다(`logs/audit-tests-final-2b-updated.log`). 이 실패는 F1이 고쳐졌다는 뜻이다. 나머지 감사 테스트 20개(audit-retire 1a~1i·2a·2c·2d·5a·5b 등, audit-race R1~R3)는 원본 그대로 통과했다. 감사 테스트는 제품 트리에 커밋하지 않았다.

## 검증 결과 (최종 트리 = 651f5ec, `logs/full-summary.tsv`)

| 순서 | 명령 | 종료 코드 | 결과 |
|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | 0 | PASS |
| 2 | `pnpm bundle:check` | 0 | PASS |
| 3 | `pnpm claude:drift` | 0 | PASS (`claude-plugin: fresh`) |
| 4 | `pnpm lint` | 0 | PASS |
| 5 | `pnpm build` | 0 | PASS |
| 6 | `pnpm test` | 0 | PASS (파일 60 통과·1 skip, 테스트 839 통과·2 skip) |
| 7 | `pnpm runtime:check` | 0 | PASS |
| 8 | `pnpm validate:all` | 0 | PASS |
| 9 | `pnpm validate:official` | 1 | FAIL_UNRELATED(환경): Codex validator `validate_plugin.py` 없음(ENOENT) |
| 10 | `pnpm claude:build` | 0 | PASS |
| 11 | `pnpm claude:check` | 0 | PASS |
| 12 | `git diff --check` | 0 | PASS |

검증 뒤 `git status --porcelain`의 변경 15개는 모두 이 두 commit에 들어갔고, commit 뒤 작업 트리는 깨끗했다. test의 skip 2개는 `previous-broker.test.ts`의 env 조건부 테스트이며 아래에서 따로 실행했다.

이전 실행 기록:
- `logs/run1-pre-regeneration/`: 첫 실행. `server.ts` 설명을 고친 뒤 build 전에 돌려 `bundle:check`가 `server.mjs is stale`로 실패했다(종료 코드 1). build 단계가 번들을 다시 만든 뒤 전체를 다시 돌렸다.
- `logs/run2-superseded/`: 두 번째 실행은 모두 통과(official 제외)했다. 그 뒤 `list_session_status` 설명의 "no delivery or status change" 문구가 부정확해(퇴역은 wake 행 상태를 바꾼다) 지우고, 최종 트리에서 전체를 다시 돌렸다. 위 표는 최종 실행 결과다.

## 이전 broker 호환

태그 `v2.7.2`, `v2.7.1`, `v2.2.6`의 `mcp-server/dist`를 `git archive`로 추출했다. `AGS_PREVIOUS_BROKER_PATH=<추출>/mcp-server/dist/session-message-broker.mjs`로 `tests/session-messaging/previous-broker.test.ts`를 실행했다.

| 태그 | 결과 | 로그 |
|---|---|---|
| v2.7.2 | 2/2 통과 | `logs/previous-broker-v2.7.2.log` |
| v2.7.1 | 2/2 통과 | `logs/previous-broker-v2.7.1.log` |
| v2.2.6 | 2/2 통과 | `logs/previous-broker-v2.2.6.log` |

처음에는 변수에 dist 디렉터리를 넣어 broker가 뜨지 못하고 세 태그 모두 실패했다(`logs/previous-broker-wrong-path/`). 이는 실행 방법 오류다. 변수는 broker 파일을 가리켜야 한다. 파일 경로로 다시 실행한 위 결과가 판정 근거다.

## NOT_RUN과 이유

- Windows(Node 24) 검증: NOT_RUN. 이 환경은 Linux 컨테이너 하나다.
- 실제 Codex·Claude host에서 섞인 marker prompt의 빈도와 hook 차단 관측: NOT_RUN. host 실행 환경이 없다.
- 설치 캐시, marketplace 설치, 설치된 MCP 동작: NOT_RUN. 범위 밖이며 설치 환경이 없다.
- `pnpm validate:official`: 실행했으나 FAIL_UNRELATED(환경). PASS로 세지 않는다.
- 감사의 이관 SIGKILL, v2.7.2 코드로 만든 DB 이관, 다중 프로세스 40회 반복: 다시 실행하지 않았다(NOT_RUN). 이번 변경은 schema·이관·prune·reserve를 바꾸지 않았다. audit-race 기본 반복은 통과했다.

## 가림(redaction)

push 전에 evidence 트리의 모든 텍스트 파일을 `redact.py` 규칙으로 검사했다. 걸린 값만 바꿨고 건수는 `meta.json`의 `redaction`에 있다. 규칙: GitHub 토큰(`ghp_`, `gho_`, `github_pat_`), `sk-ant-`, `AKIA`, private key 줄, Bearer 헤더, 이메일(커밋 trailer의 `noreply@anthropic.com` 제외), 사용자 이름이 들어간 홈 경로(`/home/<name>` → `/home/[REDACTED]`), root 홈 경로(→ `/[REDACTED-HOME]`), IPv4. 결과: 홈 경로 21건, root 홈 경로 6건, 나머지 0건이다. 두 번째 검사 결과는 `meta.json`의 `redactionSecondPass`에 있다. `env`·`printenv` 출력은 수집하지 않았다. 가린 뒤 `SHA256SUMS`를 다시 만들었다.

## 산출물

- `REPORT.md`, `meta.json`, `SHA256SUMS`
- `logs/f1-before-fix.log`: 수정 전 실패 로그
- `logs/f1-f4-after-fix.log`: 수정 후 대상 테스트 통과 로그
- `logs/full-*.log`, `logs/full-summary.tsv`, `logs/full-post-status.txt`: 최종 명령별 로그와 종료 코드
- `logs/previous-broker-*.log`: 이전 broker 호환
- `logs/audit-tests-final-*.log`, `logs/audit-2b-expectation-update.diff`: 감사 테스트 재실행
- `logs/run1-pre-regeneration/`, `logs/run2-superseded/`, `logs/previous-broker-wrong-path/`: 대체된 실행 기록
