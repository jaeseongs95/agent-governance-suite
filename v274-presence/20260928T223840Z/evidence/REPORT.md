# AGS 2.7.4 핫픽스: 세션 현황판 presence 조회 복구

- 기준: `origin/main` = `65bdd257b749e894b3099a882996feb463ccb96d` (tag `v2.7.3`). fetch 뒤 대조했다.
- 브랜치: `claude/v274-presence` (non-force push, `git ls-remote`로 확인)
- 최종 commit `7125d7fdffb7f4574f216a3a2867132a13f6e810`, tree `5ace3e6b1f68438321aa5519e05b0077939bef55`
  - `9b0927f` fix: bound presence retention and batch board presence requests
  - `3e4e059` test: cover presence retention, batched board presence and older brokers
  - `056d148` chore(release): prepare v2.7.4
  - `7125d7f` docs: document presence retention, batched board lookup and v2.7.4 notes
- 최종 tree는 전체 검증을 돌린 작업 트리의 tree(`validated-tree`)와 같다. 중간 fix commit `9b0927f`에서도 `check-bundle`과 `claude:check`가 fresh였다(`logs/fix-commit-9b0927f-freshness.log`).
- 환경: Linux cloud 컨테이너, Node v24.21.0, pnpm 11.19.0 (`meta.json`)
- 지침: 요구 4의 `agent-governance-suite:ponytail`은 이 세션의 Skill 도구에 등록되어 있지 않아 호출이 `Unknown skill`로 실패했다. 그래서 저장소의 `skills/ponytail/SKILL.md`를 직접 읽고 그 지침에 따라 구현했다.

## 결함 재현

`tests/session-messaging/presence-retention.test.ts`의 첫 시험이 반증 시험이다. 342개 identity와 1302개 행(대부분 10일 전에 끝났거나 lease가 지남, 40개는 1시간 전 종료, 2개는 live)으로 fixture를 만든다. 그 DB로 실제 source broker를 띄우고, 현황판에 보이는 identity 44개를 `SessionMessageService.listPresence`로 조회한다.

- v2.7.3 source(수정 파일만 stash해서 되돌린 상태): `MCP_UNAVAILABLE`, `"The broker response exceeded its limit."`로 실패했다. 현황판에서 모든 presence가 `unknown`이 되는 것과 같은 경로다. `logs/before-fix-v273.log`, 종료 코드 1. 새 파일의 다른 시험 6개도 v2.7.3에서 실패했다. 새 상수가 없거나 presence 정리가 없어서다. live 행 보존 시험 1개는 v2.7.3에서도 통과한다(정리가 없으니 당연하다).
- 수정 후: 8/8 통과. recent 40개는 `ended`, live 2개는 `online`/`available`, 오래된 identity는 `unknown`/`presence-unknown`이고, DB에는 42행이 남는다.

## 설계 선택

| 항목 | 선택 | 근거 |
|---|---|---|
| 보존 기간 | lease 끝(`lease_until`) 뒤 24시간 (`PRESENCE_RETENTION_MS`, `session-message-store.ts:36`) | 현황판(`board-store.mjs`의 `RETAIN_MS`)이 24시간 안에 갱신된 세션만 보여 준다. 그 동안 끝난 세션은 `ended`/`unreachable`로 보인다. 주입 만료와 유예(70분)보다 길다 |
| 삭제 조건 | `lease_until <= now-24h`이고, identity에 live 행이 있으면 그 identity의 가장 최근 행은 제외 (`:329-334`) | live 행은 lease 끝이 미래라서 조건에 걸리지 않는다. presence 조회, 퇴역 규칙(`retireUnobservedWakes`)과 `autoWake`는 모두 가장 최근 행만 읽는다. 그래서 live 행이 있는 동안 그 행을 남기면 정리 전후 판정이 같다 |
| 조회 방식 | 서버는 현황판 identity만 넘기고(`server.ts:296`), service는 3개씩 순서대로 요청한다(`session-message-service.ts:105-106`). broker는 `targets`만 돌려준다(`session-message-broker.ts:382-395`) | 3개(`SESSION_PRESENCE_LIST_MAX_TARGETS`, `session-message-protocol.ts:6`)는 모든 문자열 필드가 최대 길이이고 6바이트로 escape되는 문자로 채워져도 한도 안에 든다. 시험으로 확인했다 |
| broker 한도 보장 | `targets`가 1~3개가 아니면 거절한다. 응답이 32 KiB를 넘으면 명시적으로 거절한다(`:393`) | 묶음 크기로 보장하고, `targets` 없는 이전 service 요청은 명시적 거절로 막는다 |

혼합 버전 동작은 다음과 같다(`docs/session-message-lifecycle.md:177` 이하, release notes에도 적었다).

| service | broker | 현황판 presence |
|---|---|---|
| 2.7.4 | 2.7.4 | 세션 수와 DB 크기에 관계없이 동작 |
| 2.7.4 | 2.7.3, 2.7.2, 2.7.1, 2.2.6 | `targets`를 무시하고 전부 반환한다. 한도 안이면 정상이고, 넘으면 2.7.3처럼 모두 `unknown`/`null`이다(시험으로 확인) |
| 2.7.3 이하 | 2.7.4 | 전부 요청한다. 정리 뒤 24시간 안 identity만 남는다. 한도를 넘으면 broker가 명시적으로 거절하고, 이전 service는 모두 `unknown`으로 둔다 |

## 의도적으로 뺀 것

- 한도를 넘는 묶음을 나눠 보내거나 부분 결과를 합치는 처리: 묶음 3개가 최악의 경우에도 한도 안이므로 넣지 않았다.
- 요청 병렬화: 묶음은 순서대로 보낸다. 현황판 세션이 많을 때 지연이 문제되면 넣는다.
- 묶음 하나가 실패할 때 그 묶음만 `unknown`으로 두는 처리: 이전처럼 전체가 `unknown`이 된다. 한도 초과로 실패하는 경우는 위 보장으로 없다.
- 이전 service의 `targets` 없는 요청을 여러 응답으로 나눠 주는 방식: 명시적 거절만 한다.
- 설정 가능한 보존 기간, schema 이관, 새 ErrorCode, 계약(schema) 변경: 모두 없다. `list-presence`는 내부 broker 프로토콜이라 공개 계약은 바뀌지 않는다.
- 끝난 세션 앞으로 남은 활성 wake 행의 정리: 범위 밖이다(퇴역 규칙 변경 없음). release notes의 알려진 한계에 적었다.

## 테스트

`tests/session-messaging/presence-retention.test.ts`(8개):

1. 반증: 342 identity·1302행 DB를 실제 broker로 조회한다(위).
2. 보존 경계: 종료 행과 lapsed 행을 각각 lease 끝+24h-1ms에는 유지하고, +24h에는 삭제한다.
3. live 보존: birth가 10일 전인 live 행을 유지한다. 가장 최근 행이 아닌 live 행도 lease 조건만으로 유지하고, 그때 끝난 최신 행도 남긴다.
4. 불변: presence 삭제를 trigger로 막은 DB 사본과 비교한다. wake 행, messages, 퇴역 결과, presence와 autoWake(`checkedAt` 제외)가 같다. 행이 모두 지워진 identity만 `unknown`/`presence-unknown`이 되고, 사본은 `ended`/`presence-not-online`이다(둘 다 `no-live-relay`).
5. 재등록 세대: 행이 지워진 instance가 다시 등록되면 birth가 이전 wake의 birth generation보다 크다. 옛 nonce 도착은 새 본문을 claim하지 않는다.
6. 경합: 두 process가 같은 DB에서 prune과 등록을 20회씩 한다. 둘 다 정상 종료하고, 결과 행 42개가 다시 prune해도 같다.
7. 한도: 최악 크기 view 3개의 응답이 32 KiB 이하다. 4개 요청과 빈 요청은 거절한다. 한도를 넘는 `targets` 없는 요청은 명시적으로 거절한다.
8. `targets` 없는 작은 요청은 전체를 나열한다. 보존 기간이 주입 만료와 유예보다 길다.

`tests/session-messaging/previous-broker.test.ts`: 이전 broker에 새 묶음 요청을 보내는 시험을 추가했다. 작은 DB는 정상이고, 큰 DB는 `ok: false`이며 잘못된 데이터는 없다.

## mutant (`logs/mutants.tsv`, `logs/mutant-*.log`)

| mutant | 되돌린 것 | 결과 | 잡은 시험 |
|---|---|---|---|
| M1 | 삭제 기준을 lease 끝 대신 birth로 바꿔 live 보존을 깸 | KILLED | 경계, live 보존, 불변 |
| M2 | live identity의 최신 행 보호 제거 | KILLED | live 보존, 불변 |
| M3 | 보존 기간 0 | KILLED | 반증, 경계, 불변, 경합 |
| M4 | 보존 기간 48시간 | KILLED | 경계 |
| M5 | presence 삭제 제거 | KILLED | 반증, 경계, 불변, 재등록, 경합 |
| M6 | 묶음 크기 100 | KILLED | 반증, 한도 |
| M7 | service가 묶지 않고 한 번에 요청 | KILLED | 반증 |
| M8 | broker가 `targets` 무시 | KILLED | 반증 |
| M9 | broker 응답 크기 검사 제거 | KILLED | 한도 |

9/9 KILLED. 처음 돌렸을 때 M1은 live 보존 시험이 아니라 다른 시험에만 잡혔다(live 행이 최신 행이기도 해서 최신 행 보호로 살아남았다). 그래서 최신 행이 아닌 live 행을 확인하도록 시험을 보강했다. M2 치환식도 우선순위 때문에 live 행까지 지우던 것을 보호절만 끄는 식으로 고쳤다. 표는 보강 뒤 다시 돌린 결과다.

## 전체 검증 (`logs/full-summary.tsv`, 최종 tree와 같은 작업 트리)

| 순서 | 명령 | 종료 코드 | 결과 |
|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | 0 | PASS |
| 2 | `pnpm bundle:check` | 0 | PASS |
| 3 | `pnpm claude:drift` | 0 | PASS (`claude-plugin: fresh`) |
| 4 | `pnpm lint` | 0 | PASS |
| 5 | `pnpm build` | 0 | PASS |
| 6 | `pnpm test` | 0 | PASS (파일 62 통과·1 skip, 테스트 866 통과·3 skip) |
| 7 | `pnpm runtime:check` | 0 | PASS |
| 8 | `pnpm validate:all` | 0 | PASS |
| 9 | `pnpm validate:official` | 1 | FAIL_UNRELATED(환경): `validate_plugin.py` ENOENT, Codex validator 없음 |
| 10 | `pnpm claude:check` | 0 | PASS (`fresh`) |
| 11 | `pnpm source:check` | 0 | PASS (`source lock is consistent`) |
| 12 | `git diff --check` | 0 | PASS |
| - | `pnpm source:verify` | 1 | NOT_VERIFIABLE: 삭제된 외부 저장소 `ponytail`의 clone 실패(`logs/source-verify.log`). 차단 사유가 아니며 원격 복원이나 lock 완화는 하지 않았다 |

test의 skip 3개는 `previous-broker.test.ts`의 env 조건부 테스트다. 아래에서 따로 실행했다. `claude:build`는 release 준비 때 실행했고, 결과는 `claude:check` fresh로 확인했다.

## 이전 broker 회귀

태그의 `mcp-server/dist`를 `git archive`로 추출해 `AGS_PREVIOUS_BROKER_PATH=<추출>/mcp-server/dist/session-message-broker.mjs`로 실행했다.

| 태그 | commit | 결과 |
|---|---|---|
| v2.7.3 | 65bdd25 | 3/3 통과 |
| v2.7.2 | 8763cef | 3/3 통과 |
| v2.7.1 | d5c5932 | 3/3 통과 |
| v2.2.6 | 863ed7a | 3/3 통과 |

## NOT_RUN과 이유

- 실제 PC 운영 DB 사본에서의 재측정: NOT_RUN. 운영 DB 파일 사용이 금지되어 있다. 같은 규모의 합성 fixture로 대신했다.
- Windows(Node 24) 검증: NOT_RUN. 이 환경은 Linux 컨테이너 하나다.
- 설치 캐시, marketplace 설치, 설치된 MCP의 `list_session_status` 확인: NOT_RUN. 설치 환경이 없고 release 범위 밖이다.
- `validate:official`: 실행했으나 FAIL_UNRELATED(환경). `source:verify`: NOT_VERIFIABLE.
- 혼합 버전에서 이전 broker와 새 broker가 같은 DB에서 동시에 도는 운용: NOT_RUN.

## 가림(redaction)

push 전에 evidence 트리의 모든 텍스트 파일을 `redact.py` 규칙으로 검사했다. 걸린 값만 바꿨다. 규칙은 GitHub 토큰, `sk-ant-`, `AKIA`, private key 줄, Bearer 헤더, 이메일(`noreply@anthropic.com` 제외), 사용자 이름이 든 홈 경로(`/home/<name>` → `/home/[REDACTED]`), root 홈 경로(→ `/[REDACTED-HOME]`), IPv4다. 건수는 `meta.json`의 `redaction`과 `redactionSecondPass`에 있다. `env`·`printenv` 출력은 수집하지 않았다. 하네스 스크립트 안의 작업 경로도 같은 규칙으로 가려졌으므로, 다시 실행하려면 실제 경로로 바꿔야 한다. `SHA256SUMS`는 커밋된 blob(`git show <commit>:<path>`)으로 계산했다.
