# AGS 2.7.6 감사 후속 (fix1: L2-1, T-5, I-6)

- 기준: `claude/v276-presence-deadline` = `93a7e4bc69f556859bc929af1df871dfc74eae68`. 감사 `evidence:v276-audit/20260929T034034Z/audit/REPORT.md`와 `harness/clock-step.audit.test.ts`를 읽고 반영했다.
- 새 HEAD: `906a023a565806756bb6accc37d71970c35b740b`, tree `2bd8176e36d2dd45262d17ac35a19b38c0d31a83`
- push: non-force fast-forward(`93a7e4b..906a023`)이다. `merge-base --is-ancestor`와 `ls-remote`로 확인했다.
- commit(`logs/commits.txt`). 세 commit 모두 `bundle:check` 0이고 `claude:check`가 fresh다(`logs/commit-freshness.log`).
  - `6119642` fix: measure the board presence deadline on the monotonic clock
  - `772f3a4` test: bind the retired-latch branch to the previous broker version
  - `906a023` test: tie the slow broker bound to the client deadline
- 버전은 2.7.6 그대로다.

## L2-1: 단조 시계

- `session-message-service.ts`: `deadline`과 `remaining`을 `Date.now()` 대신 전역 `performance.now()`로 잰다. client도 단조 시계를 쓴다.
  - client는 `node:perf_hooks`의 `performance`를 import해 쓴다. 전역 `performance`는 Node에서 같은 객체다.
  - service에서 import 대신 전역을 쓴 이유: vitest fake timer가 import binding은 바꾸지 못해 시험에서 가짜 시계를 쓸 수 없었다. import로 쓴 첫 시도에서 가짜 시계 시험 4개가 실패했다.
- 시험 `presence-deadline.test.ts` "keeps the overall deadline when the wall clock steps back during a lookup"
  - fake timer에 `performance`를 포함했다. 감사 probe처럼 느린 broker(1.9 s×100 묶음)에서 조회 5 s 뒤 시스템 시계를 60 s 되돌린다.
  - 단조 경과 20,000 ms에 끝나고, 요청 11회, 앞 30개 answered, 나머지 unanswered인지 본다.
  - 파일의 모든 시험이 가짜 performance에서 돌도록 `beforeEach`를 바꿨다. 경과 시간도 단조 시계로 잰다.
- 수정 전후:

| service | 결과 | 로그 |
|---|---|---|
| 93a7e4b(`Date.now`) | exit 1. 새 시험만 `expected null to be 20000`으로 실패, 4 passed | `logs/before-93a7e4b-presence-deadline.log` |
| 수정 후 | 5/5 | `logs/after-fix-presence-deadline.log` |

- 문서: lifecycle 조회 절과 v2.7.6 notes에 "client와 같은 단조 시계로 재므로 시스템 시계가 바뀌어도 상한은 그대로"라는 한 문장을 더했다. notes의 확인 범위 문장에 시계를 되돌리는 경우도 넣었다.

## T-5: 이전 broker 버전 입력

- `previous-broker.test.ts`
  - `AGS_PREVIOUS_BROKER_PATH` 옆에 `AGS_PREVIOUS_BROKER_VERSION`(예: `2.7.5` 또는 `v2.7.5`)을 읽는다.
  - "이미 퇴역한 행은 binding만 비교" 분기는 버전이 2.7.5 이상일 때만 허용한다. 그 미만이거나 행이 퇴역하지 않았으면 `expect(kept).toEqual(before)`다(managed-wake 이전 broker는 기존 분기).
- **버전 입력이 없으면: 이 시험이 실패하고 변수 이름을 알린다.**
  - 어느 결과가 맞는지 추측하지 않는 쪽이 가장 엄격하다.
  - 버전 없이 엄격 비교로 떨어뜨리는 방식은 2.7.5 broker에서 원인이 보이지 않는 diff로 실패한다.
  - 다른 세 시험은 버전에 의존하지 않으므로 경로만으로 돈다.
  - 저장소에서 이 변수들을 쓰는 곳은 이 시험뿐이다.

확인(`logs/previous-broker-*-as-*.log`):

| broker | 버전 입력 | 결과 |
|---|---|---|
| v2.7.5 | 2.7.5 | 4/4 |
| v2.7.4 | 2.7.4 | 4/4 |
| v2.7.3 | 2.7.3 | 4/4 |
| v2.7.4 | 2.7.5 (거짓) | 4/4. 퇴역하지 않았으므로 엄격 비교(`toEqual(before)`)로 통과했다 |
| v2.7.5 | 2.7.4 (거짓) | 1 failed. 퇴역한 행이 엄격 비교에서 걸렸다 |
| v2.7.5 | 없음 | 1 failed. "Set AGS_PREVIOUS_BROKER_VERSION …" |

## I-6

실제 느린 broker 시험의 상한 `22_000`을 `SESSION_MESSAGE_REQUEST_TIMEOUT_MS + 2_000`으로 바꿨다. client에서 import한다.

## mutant (`logs/mutants/mutants.tsv`)

대상: presence-deadline, presence-batches, presence-retention, session-board

| mutant | 결과 | 실패 시험 수 |
|---|---|---|
| BASELINE | PASS | 0 |
| M1 deadline을 `Date.now`로 되돌림 | KILLED | 1 (벽시계 되돌림 시험) |
| D1 전체 deadline 제거 | KILLED | 4 |
| D2 진행 중 요청에 남은 시간을 넘기지 않음 | KILLED | 3 |
| D3 묶음마다 deadline을 새로 잡음 | KILLED | 4 |
| D4 전송 실패 뒤 계속 요청 | KILLED | 2 |

T-5는 위 표의 "v2.7.5를 2.7.4로 입력"한 경우가 관찰 상태로만 판단하는 이전 동작을 잡는다. 93a7e4b의 시험이었다면 통과했을 입력이다.

## 검증 (Node v24.21.0, `logs/summary.tsv`)

| 단계 | 종료 코드 |
|---|---|
| install --frozen-lockfile, bundle:check, claude:drift(fresh), lint, build | 0 |
| test | 0 (886 passed, 4 skipped) |
| claude:build, claude:check(fresh), source:check | 0 |
| git diff --check, git diff --check 93a7e4b..HEAD | 0 |

- 검증 뒤 `git status`는 비어 있다.
- 10회 반복(`logs/repeat-10x.log`): presence-deadline 10/10(5/5), presence-batches 10/10(4/4), presence-retention 10/10(10/10)
- previous-broker: 위 표
- 끝난 뒤 broker process는 0개다. `/tmp/ags-*` 3개는 2026-09-28 15:04에 만들어진 이전 작업의 잔여물이다.

## NOT_RUN

- 요청 목록 밖의 `runtime:check`, `validate:all`, `validate:official`
- Windows 실행과 push 뒤 CI
- `source:verify`(NOT_VERIFIABLE)
- previous-broker v2.7.2, v2.7.1, v2.2.6

## 가림

push 전에 `harness/redact.py`로 가렸다.

- 규칙: 기존 규칙(토큰 패턴, 키 줄, Bearer, 이메일, 사용자 홈 경로, root 홈, IP)에 계정명 문자열과 Windows 사용자 홈 경로를 더했다.
- 건수는 `meta.json`에 있다.
- 두 번째 검사는 0건이었고, push 전에 계정명 문자열을 별도로 grep해 0건임을 확인했다.
- 계정명 규칙 자체가 계정명을 담고 있어 `harness/redact.py`의 그 패턴도 `[REDACTED]`로 바뀌었다. 다시 실행하려면 패턴을 채워야 한다.
- `SHA256SUMS`는 커밋된 blob 기준이다.
