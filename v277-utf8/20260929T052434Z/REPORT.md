# AGS 2.7.7: 세션 메시지 UTF-8 framing 수정

- 기준: main = `9e76a07b81c8c8eba855acf48b7b25bf395e7548` (tree `079ddd76`)
- 브랜치: `claude/v277-utf8-framing`. 최종 HEAD는 `fd3f486a4ad976756532d1de0705e8a819f92778`, tree는 `1933de6506562af9dda1f4982fcbc24cc370952b`이다.
- push: 새 브랜치 non-force push. `ls-remote`와 `merge-base --is-ancestor 9e76a07 HEAD`로 확인했다.
- commit(`logs/commits.txt`)
  - `bd571c7` fix: decode session message frames once per line in bytes. 소스, 시험, dist, claude-plugin을 포함하며 버전은 2.7.6이다.
  - `cf09ff6` docs: describe byte-level session message framing for 2.7.7
  - `fd3f486` chore: release 2.7.7
- `bd571c7`과 `fd3f486`에서 `bundle:check`는 0이고 `claude:check`는 fresh다(`logs/commit-freshness.log`). `cf09ff6`은 문서만 바꿨다.

## reader 설계와 위치

`mcp-server/src/session-message-protocol.ts`의 `sessionMessageLineReader(limitBytes)`다. client와 broker가 이미 함께 import하는 공통 모듈이다.

- 받은 조각(Buffer)을 byte 그대로 이어 붙인다.
- 줄바꿈 `0x0A`를 byte에서 찾는다.
- 한도는 원시 byte로 센다. 줄바꿈이 있으면 `newline + 1`(줄바꿈 포함)을, 없으면 지금까지 모은 byte 수를 센다. 이 값이 `limitBytes`보다 크면 `RangeError`를 던진다.
- 줄이 완성되면 그 줄만 한 번 `toString("utf8")`로 풀어 돌려준다. 그 뒤 reader를 비운다. 이는 옛 broker가 줄 뒤 `buffer = ""`로 하던 동작과 같다.
- client는 오류를 `"The broker response exceeded its limit."`(일반 `Error`)로 바꾼다. broker는 `"Request exceeds the broker limit."` 응답으로 바꾼다. 문구와 분류는 그대로다.
- StringDecoder를 쓰지 않은 이유: 원시 byte로 한도를 세려면 byte 버퍼가 어차피 필요하다. 버퍼를 두면 decode는 줄마다 한 번이면 된다.

## 경계 기준

줄바꿈을 포함한 줄의 UTF-8 byte 수가 32768 이하이면 수락하고, 32769 이상이면 거절한다. broker가 응답을 맞출 때 쓰는 기준과 같다. `claimResponseBytes`와 `list-presence`는 모두 `JSON.stringify(...)` byte에 `+1`(줄바꿈)을 더해 `> 32768`이면 거절한다.

## 시험 (`tests/session-messaging/utf8-framing.test.ts`, 12개)

| 시험 | 9e76a07 | 수정 후 |
|---|---|---|
| 1. 단위: 16384에서 한글 1\|2, 2\|1, 이모지 1\|3, 2\|2, 3\|1 (5개) | 실패: reader 없음(`sessionMessageLineReader is not a function`) | 통과 |
| 1'. 단위: 16 byte 한도에서 정확히 한도 수락, 한 byte 초과 거절, 부분 문자는 원시 byte로 셈 | 실패: reader 없음 | 통과 |
| 2a. 실제 broker(TLS) claim 응답: 32768 byte이고 한글이 1\|2 또는 2\|1로 걸리면 수락, 32769 byte는 일반 Error로 거절 (2개) | 실패: `The broker response exceeded its limit.` | 통과 |
| 2b. 실제 broker(TLS) 요청: ping 요청 줄 32768 byte이고 한글이 1\|2 또는 2\|1로 걸리면 수락, 32769 byte는 `BrokerRequestRejected("Request exceeds the broker limit.")` (2개) | 실패: 32768 요청이 거절됨 | 통과 |
| 3. CLI claim 경로(`runSessionMessageCli`)로 한글 8개씩 12묶음 받기 | 실패: 11묶음 깨짐(0-10), U+FFFD 29개 | 통과(깨짐 0, U+FFFD 0) |
| 4. lease: 32767 byte 한글 응답 | 실패: 반환 0, 온전함 false, lease 9행, attempt 1, lease 120000 ms | 통과: 반환 9, 온전함 true, lease 9행, attempt 1, lease 120000 ms |

- 로그: `logs/before-9e76a07-utf8-framing.log`, `logs/after-fix-utf8-framing.log`
- 수정 전 로그는 9e76a07 worktree에 최종 시험 파일 3개를 복사해 돌렸다.
- 시험 1의 수정 전 실패는 reader가 없어서다. 옛 decode 방식에서 실패하는 모습은 mutant M1에서 보인다. M1에서 decode 시험 5개가 모두 원문과 달라 실패했다.
- 응답 32769는 fixture(`fixtures/padded-claim.mjs`)로 만든다. store가 한도에 맞춘 뒤 `over-by-one` 대상의 마지막 본문에 1 byte를 더한다. 실제 broker는 32769 응답을 만들지 않기 때문이다.
- 결정성
  - 응답과 요청의 byte 배치는 `fixtures/utf8-layout.ts`가 계산하고, 보낸 줄을 다시 직렬화해 길이와 16384 위치를 확인한다.
  - 벽시계 lease나 sleep을 쓰지 않는다. lease 판정은 DB의 `claimed_at`과 `claim_until`의 차이로 본다.
  - broker는 시험마다 새 상태 디렉터리에서 띄우고, 끝나면 `exit`를 기다린 뒤 디렉터리를 지운다.

## lease 경우 판정: 확인

- 9e76a07에서 32767 byte 응답(한글 1|2 분할)으로 재현했다.
- client는 inflate된 크기(+6 byte)로 한도 초과 일반 Error를 냈다. `sessionMessageRequest`는 거절이 아닌 오류라서 broker를 확인하고 한 번 더 claim했다.
- 첫 claim이 9행에 lease를 걸었으므로 두 번째 claim은 0개를 받았다. CLI는 오류 없이 `messages: []`를 반환했고, 9행은 attempt 1, lease 120초로 남았다.
- 수정 뒤에는 같은 경우 9개를 원문 그대로 받는다.

## mutant (`logs/mutants/mutants.tsv`, 대상: utf8-framing 시험)

| mutant | 결과 | 실패 시험 수 |
|---|---|---|
| BASELINE | PASS | 0 |
| M1 조각마다 decode(옛 방식 문자열 누적) | KILLED | 12 |
| M2a decode한 누적 문자열로 한도 세기 | KILLED | 1 |
| M2b 조각마다 decode한 byte 합으로 한도 세기 | KILLED | 6 |
| M3 한도 비교 `>` → `>=` | KILLED | 5 |
| M4 줄바꿈을 한도 계산에서 뺌 | KILLED | 5 |
| M5 broker만 옛 reader(9e76a07 broker.ts) | KILLED | 2 |
| M6 client만 옛 reader(9e76a07 client.ts) | KILLED | 4 |

## previous-broker (Linux)

새 client와 옛 broker를 섞은 조합이다. `AGS_PREVIOUS_BROKER_PATH`와 `AGS_PREVIOUS_BROKER_VERSION`을 주고 돌렸다.

| broker | 결과 | 로그 |
|---|---|---|
| v2.7.6 | 5/5 | `logs/previous-broker-v2.7.6.log` |
| v2.7.5 | 5/5 | `logs/previous-broker-v2.7.5.log` |
| v2.7.3 | 5/5 | `logs/previous-broker-v2.7.3.log` |

- 기존 4개 시험에 새 시험 하나를 더했다.
  - 새 client는 옛 broker가 보낸 32768 byte 한글 응답을 온전히 받는다.
  - 요청 쪽은 옛 broker의 reader 기준이다. 버전이 2.7.7 미만이면 32768 byte 한글 요청을 옛 동작대로 한도 초과로 거절하는 것을 기대한다.
- 같은 시험을 9e76a07 client와 v2.7.6 broker로 돌리면 `The broker response exceeded its limit.`로 실패한다(`logs/previous-broker-v2.7.6-with-9e76a07-client.log`).
- v2.7.6과 v2.7.5의 broker 번들은 byte가 같다(`logs/previous-broker-dists.sha256`). tag의 blob과도 같다.

## 검증 (Node v24.21.0, `logs/summary.tsv`)

| 단계 | 종료 코드 |
|---|---|
| install --frozen-lockfile, bundle:check, claude:drift(fresh), lint, build | 0 |
| test | 0 (파일 65 통과·1 skip, 시험 898 통과·5 skip) |
| runtime:check, validate:all | 0 |
| validate:official | 1, FAIL_UNRELATED. Codex 공식 validator `validate_plugin.py`가 이 환경에 없다(ENOENT). |
| claude:build, claude:check(fresh), source:check | 0 |
| git diff --check, git diff --check 9e76a07..HEAD | 0 |

- 10회 반복(`logs/repeat-10x.log`): utf8-framing 10/10(12/12), previous-broker v2.7.6의 새 시험 10/10
- 끝난 뒤 남은 broker process는 0개다.

## 문서와 버전

- `docs/release-notes-v2.7.7.md`를 새로 썼다.
- `docs/architecture.md`의 claim 한도 문장 뒤에 byte 단위 줄 읽기 한 문장을 더했다. `docs/session-message-lifecycle.md`에는 framing 설명이 없어 바꾸지 않았다.
- 버전은 `release/version.json`을 2.7.7로 바꾸고 `node scripts/sync-release-metadata.mjs --write`로 맞췄다. 대상 7개 파일은 v2.7.6 때와 같다. README 두 개의 release marker는 `--ref v2.7.7`이다. dist와 claude-plugin은 다시 생성했다.

## NOT_RUN

- Windows 실행(총괄 수동 관문), push 뒤 CI
- `source:verify`(NOT_VERIFIABLE)
- previous-broker v2.7.4, v2.7.2 이하

## 가림

- evidence 폴더 밖에 둔 스크립트로 push 전에 가렸다.
- 규칙: 토큰 패턴, private key 줄, Bearer, 이메일, 사용자 홈 경로, root 홈, IP, 계정명, Windows 사용자 홈
- 건수는 `meta.json`에 있다. 두 번째 pass는 0건이었고, push 전 계정명·이메일 grep도 0건이었다.
- `harness/redact.py`는 같은 규칙의 사본이다. 계정명 패턴은 파일에 두지 않고 `AGS_REDACT_ACCOUNT_PATTERN`으로 받는다. 이 파일은 스스로를 바꾸지 않도록 가림 대상에서 뺐고, 개인정보가 없음을 따로 확인했다.
- IP 규칙은 loopback 주소도 가린다.
- `SHA256SUMS`는 커밋된 blob 기준이다.
