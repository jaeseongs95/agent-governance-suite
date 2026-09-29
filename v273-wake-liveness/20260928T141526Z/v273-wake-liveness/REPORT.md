# v273-wake-liveness 검증 보고서

- 후보 브랜치: `claude/v273-wake-liveness`
- 후보 commit: `e739090952710d418a67dae71d76b1f2ef169441`, tree `f3bfdf1be77a6e857c595dacb9231402f86974a9`
- 기준: `8763cef2b11f2635d6c9af7861b5bffd496e2a30`(v2.7.2, tree `eed08f96…`), 작업 시작 때 일치를 확인했다.
- 환경: Linux cloud 컨테이너 한 대, Node v24.21.0(nodejs.org `latest-v24.x` tarball을 SHASUMS256.txt로 검증), pnpm 11.19.0(corepack).
- **범위 제한:** 이 결과는 Linux cloud 한 환경에서 얻었다. Windows 검증과 실제 PC 설치 캐시·호스트 wake 관측 검증이 아니다.

## commit 식별자 주의

처음 만든 commit `a119a2a`의 committer가 저장소 정책과 맞지 않아, push 전에 같은 tree로 author만 다시 쓴 `e739090`으로 고쳤다. 두 commit의 tree는 `f3bfdf1…`로 같다. 전체 검증 순서의 앞 6개 로그(install~test)는 `head=a119a2a`로, 나머지는 `head=e739090`으로 기록되어 있다. 원격에는 `e739090`만 push했다.

## 결과 요약

| 단계 | 로그 | 결과 |
|---|---|---|
| 수정 전 회귀 테스트 probe | `01-prefix-failing-tests.log` | 26개 중 25개 FAIL(의도한 실패), 1개 PASS |
| `pnpm install --frozen-lockfile` | `10-…` | PASS |
| `pnpm bundle:check` | `11-…` | PASS |
| `pnpm claude:drift` | `12-…` | PASS(`claude-plugin: fresh`) |
| `pnpm lint` | `13-…` | PASS |
| `pnpm build` | `14-…` | PASS |
| `pnpm test` 1차 | `15-…` | **FAIL 1** / PASS 837 / skip 2 (파일 61) |
| `pnpm runtime:check` | `16-…` | PASS(29개 스킬 CLI) |
| `pnpm validate:all` | `17-…` | PASS |
| `pnpm validate:official` | `18-…` | **NOT_RUN**: Codex 공식 validator(`validate_plugin.py`)가 이 컨테이너에 없음(ENOENT). PASS로 세지 않는다. |
| `git diff --check` | `19-…` | PASS |
| `pnpm claude:check` | `20-…` | PASS(`claude-plugin: fresh`) |
| 검증 뒤 `git status` | `21-…` | 변경 없음 |
| 실패 테스트 단독 재실행 | `22-…` | PASS 13/13 |
| `pnpm test` 전체 재실행 | `23-…` | PASS 838 / skip 2 |
| previous-broker v2.7.2(`8763cef` 번들, sha256 `fbb808e0…`) | `02-previous-broker-v272.log` | PASS 2/2 |
| previous-broker v2.7.1 태그 번들 | `02-previous-broker-v2.7.1.log` | PASS 2/2 |
| previous-broker v2.2.6 태그 번들 | `02-previous-broker-v2.2.6.log` | PASS 2/2 |

### `pnpm test` 1차 FAIL

- 실패: `tests/mcp/korean-prose-cycle-receipt.test.ts > rejects a label leaked into the independent adjudicator input`. 기록 스크립트 `scripts/record-korean-prose-run.ts`를 자식 프로세스로 실행했는데 종료 코드가 0이 아니라 1이었다.
- 이번 변경은 한국어 산문 기록·검증 코드와 trust store를 건드리지 않는다.
- 같은 tree에서 이 파일만 다시 돌리면 13/13, 전체를 다시 돌리면 838/838(skip 2)이 통과했다.
- 1차 실행에서 자식 프로세스 stderr가 남지 않아 원인은 **확인하지 못했다**. 전체 병렬 실행 부하와 관련된 것으로 추정하지만 검증하지 않았다. 기준 commit에서 같은 비교 실행은 하지 않았다(NOT_RUN). 따라서 이 1건은 "원인 미확인 FAIL, 재실행 PASS"로 남긴다.

### skip 2

`tests/session-messaging/previous-broker.test.ts`의 두 시험은 `AGS_PREVIOUS_BROKER_PATH`가 있을 때만 돈다. 전체 실행에서는 skip이고, 위 표의 세 이전 broker 번들로 따로 실행해 모두 통과했다. v2.2.6은 만료된 nonce 행을 상태와 관계없이 prune하므로, 새 시험은 managed wake를 모르는 broker에게 퇴역 행의 "보존 또는 삭제"만 요구하고 다른 상태로 바꾸지 않는지 확인한다. v2.7.x broker에는 행이 그대로 남아야 한다.

## 수정 전 실패 증명

`01-prefix-failing-tests.log`는 새 시험 파일을 수정 전 소스에 적용해 돌린 결과다. 아직 없는 export `WAKE_RETIRE_GRACE_MS` 대신 같은 값(10분)을 시험 파일 안에 두었다. 주요 실패는 다음과 같다.

- 옛 세대 submitted·unknown·started 행과 새 live 세대: 새 wake 예약이 `dispatch: false`(assertion 실패).
- K 재현: receipt TTL 30초를 넘긴 claim 재시도가 거절되고 행은 `submitted`로 남는다. 만료 뒤 활동이 있어도 새 wake가 없다.
- C2 재현: 같은 ms에 다시 태어난 presence의 `startedAt`이 이전 birth와 같다.
- 나머지는 아직 없는 API(`autoWakeOutlook`, 이관, `retired` 응답 등) 때문에 실패했다.

## 가림(redaction)

push 전에 `scripts/redact.py`로 모든 텍스트 파일을 검사해 걸린 값만 `[REDACTED]`로 바꿨다. 규칙과 건수는 `meta.json`의 `redaction`에 있다. 대상은 이메일 주소, 계정·사용자 이름, 사용자 이름이 들어간 홈 경로와 root 홈 경로, IPv4 주소(루프백 주소 포함), GitHub·Anthropic·AWS 토큰, private key, Bearer 헤더다. `env`·`printenv` 출력은 남기지 않았다. 가린 뒤 `SHA256SUMS`를 다시 만들었고, push 전 비밀 패턴 검사(GitHub 토큰 접두사, Anthropic 키 접두사, AWS 액세스 키, PEM private key 머리글, Bearer 인증 헤더)에서 걸린 것이 없었다. `scripts/redact.py`는 이 검사가 자기 패턴 문자열에 걸리지 않도록 문자열을 나눠 적었다.

## NOT_RUN / NOT_VERIFIABLE

- `pnpm validate:official`: NOT_RUN(Codex 공식 validator 미설치).
- Windows(Node 24) 검증: NOT_RUN(이 세션 범위 밖).
- 실제 PC 설치 캐시·Codex/Claude 호스트의 wake 관측: NOT_RUN.
- `pnpm source:verify`: 이번 필수 순서에 없어 실행하지 않았다(NOT_RUN). 스킬 원본 독립 저장소는 사용자가 삭제했으므로, 실행했다면 404는 NOT_VERIFIABLE로 분류할 대상이다.
- 기준 commit에서의 전체 테스트 비교 실행: NOT_RUN.
- broker 프로세스 SIGKILL을 넣는 e9 방식의 kill-point campaign: NOT_RUN. 크래시 경계는 store 수준 시험(퇴역 commit 직후 프로세스 종료, 이관 rebuild 도중 실패 rollback)과 두 프로세스 경합 시험으로만 확인했다.
