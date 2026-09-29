# AGS 2.7.6: 현황판 presence 조회 대기 상한 (L2), 시험 시간 초과 (T-4)

- 기준: `main` = `3706167d4646c53c8b47510eebda58931cbd1cfe` (v2.7.5)
- 브랜치: `claude/v276-presence-deadline` = `93a7e4bc69f556859bc929af1df871dfc74eae68`, tree `90ec390cc6dffdcf34e52960103f71e883833907`. 새 브랜치로 non-force push했고 `ls-remote`로 확인했다.
- commit(`logs/commits.txt`). 다섯 commit 모두 `bundle:check` 0이고 `claude:check`가 fresh다(`logs/commit-freshness.log`).
  - `bfdbeee` test: seed the large presence fixture in one transaction (T-4)
  - `2e3066a` fix: bound the board presence lookup with one overall deadline (L2)
  - `e33e47e` docs: describe the board presence lookup deadline
  - `10cfd37` chore: release 2.7.6
  - `93a7e4b` test: accept a previous broker that already retires ended-birth wakes
- Skill `agent-governance-suite:ponytail`은 이 세션에 등록되어 있지 않다. 저장소의 `skills/ponytail/SKILL.md` 지침을 따랐다.

## T-4 원인: 현황판 조회가 아니라 fixture 시드였다

실패한 Windows CI 로그는 PR #18의 run 36509846601 attempt 1, job 109219332149다.

| 시험 | 실패 run | 한도 |
|---|---|---|
| `:90` 342-identity | 80,292 ms | 60 s |
| `:255` 두 process 경합 | 40,400 ms | 30 s |

- B1(`:117`)은 이 run에서 824 ms로 통과했다. 총괄이 적은 `:117`은 이 run에서는 `:255`였다.
- 실패한 두 시험의 공통점은 `largeFixture`다. 약 2000번의 개별 commit(WAL, fsync)으로 1302행을 쓴다.
- `:90`의 현황판 조회는 44개 identity, 15개 묶음뿐이다. `:255`는 조회를 하지 않는다. 따라서 114번 순차 요청 가설은 이 실패의 원인이 아니다.
- 재현(`harness/timing.sh`): strace로 vitest와 모든 자식 process의 fsync·fdatasync 뒤에 20 ms를 넣어 느린 디스크를 흉내 냈다.

| 시험 | 3706167 평소 | 3706167 fsync+20ms | fixture 수정 뒤 평소 | 수정 뒤 fsync+20ms | HEAD 평소 | HEAD fsync+20ms |
|---|---|---|---|---|---|---|
| `:90` 342-identity | 2,878 ms | 48,625 ms | 837 ms | 1,738 ms | 718 ms | 1,760 ms |
| B1 | 366 ms | 1,142 ms | 362 ms | 1,138 ms | 280 ms | 1,129 ms |
| `:255` 경합 | 1,400 ms | **47,336 ms, 시간 초과** | 630 ms | 2,536 ms | 554 ms | 2,292 ms |

수정: `largeFixture`를 `BEGIN`…`COMMIT` 하나로 묶었다. 시험 한도, assertion, 제품 코드는 바꾸지 않았다.

## L2 재현과 설계 판정

- **재현된다.** client의 요청 하나는 `min(2.5 s, 남은 시간)` 안에 답을 받아야 하고, 묶음 하나는 20 s 안에 끝나야 한다. 조회 전체에는 상한이 없었다.
  - 가짜 client(fake time): 묶음마다 1.9 s가 걸리면 3706167은 20 s가 지나도 끝나지 않는다. 300개(100개 묶음)면 190 s다.
  - 실제 source broker: 시험 전용 preload `tests/session-messaging/fixtures/slow-list-presence.mjs`로 `list-presence`마다 1 s를 지연시켰다. 90개 세션 조회가 3706167에서 30,210 ms 걸렸다(`logs/before-3706167-real-slow-broker.log`).
- **총괄 방향 중 전체 deadline은 채택했다.**
  - `listPresence`는 시작할 때 `deadline = now + SESSION_MESSAGE_REQUEST_TIMEOUT_MS`(20 s)를 잡는다.
  - 묶음마다 `totalTimeoutMs: deadline - now`를 client에 넘긴다. 남은 시간이 0 이하면 요청하지 않는다.
  - 시간 초과는 기존 규칙에서 "거절이 아닌 실패"라 그대로 멈춘다. 그 묶음과 남은 묶음은 unanswered가 되고, 앞서 받은 결과는 유지된다.
  - client는 deadline에 연결을 끊고 promise는 한 번만 settle되므로, 늦은 응답이 결과를 바꿀 수 없다.
  - 코드 변경은 service 6줄과 client 상수 export 한 줄이다.
- **동시성은 기각했다.**
  - broker는 요청을 한 process의 이벤트 루프에서 동기적으로 처리한다. 동시에 보내도 broker 쪽 시간은 줄지 않는다.
  - 정상 broker에서 300개 조회는 약 0.5 s(v2.7.4 감사 측정)이다.
  - T-4의 원인도 요청 수가 아니었다.
  - 동시성을 넣으면 순서, 중복, in-flight 처리가 필요하지만 이득이 없다. 그래서 요구 mutant 중 동시성 관련 항목은 해당하지 않는다.
- **deadline 20 s의 근거**
  - 다른 broker 요청 하나의 기존 client deadline과 같은 값이라 새 설정이 없다.
  - broker가 없을 때 첫 조회가 broker를 띄우고 기다리는 시간(최대 15 s)을 덮는다.
  - 응답 없는 broker의 기존 최악 시간(약 17.5 s)을 늘리지 않는다.
  - Codex MCP 도구 호출 기본 제한 60 s보다 짧다.
  - 10 s처럼 더 짧게 잡으면, 재부팅 뒤 broker를 새로 띄우는 첫 현황판이 모두 unknown이 될 수 있다.

## 시험

`tests/session-messaging/presence-deadline.test.ts`는 새 파일이다. client는 stub이고 fake time을 쓴다. stub은 실제 client처럼 `totalTimeoutMs`(없으면 20 s)에 전송 실패로 끝나고, broker의 답은 그 뒤에도 기록한다.

1. 느리지만 답하는 broker(1.9 s×100 묶음)에서 정확히 20,000 ms에 끝난다. 앞 30개는 받고, 나머지 270개는 순서대로 unanswered다. 요청은 11회이고, 마지막 예산은 1,000 ms다.
2. deadline 뒤 도착한 답은 결과를 바꾸지 않는다. 답이 도착한 것을 확인한 뒤에도 결과 snapshot이 같다.
3. 응답 없는 broker는 20 s에 한 번만 묻고 전부 unanswered다.
4. 정상 broker에서 301개가 순서대로 한 번씩 오고, 패턴 밖 identity만 unanswered다.

`presence-retention.test.ts`에 실제 source broker 시험을 추가했다. 1 s 지연 preload를 쓰고, 90개 세션 조회가 22 s 안에 끝나며, 받은 결과가 순서대로 앞부분이고 나머지는 unanswered인지 본다. 수정 후 20,387 ms였다.

보호 시험은 그대로 통과했다. presence-batches(거절 격리, 패턴 필터, 전송 실패 뒤 멈춤, 앞선 결과 유지)와 presence-retention B1, session-board overlay다.

### 반증 전후

| 시험 | 3706167 | 수정 후 |
|---|---|---|
| presence-deadline | exit 1, 2 failed / 2 passed: 1번과 2번이 `expected null to be 20000` | 4/4 |
| 실제 느린 broker | exit 1, `expected 30210 to be less than 22000` | 통과, 20.4 s |

로그: `logs/before-3706167-presence-deadline.log`, `logs/after-fix-presence-deadline.log`, `logs/before-3706167-real-slow-broker.log`.

### 느린 runner 흉내

- 요청당 지연: 임시 변형 `harness/slow-request-variant.py`는 커밋하지 않았고 실행 뒤 되돌렸다. `:90`과 B1의 broker에 `list-presence`당 1 s 지연을 넣었다. `:90`은 15,895 ms(한도 60 s)로, 15개 묶음이 모두 20 s 안에 답해 전체 결과가 나왔다. B1은 2,269 ms였다(`logs/timing-slow-request-1000ms.log`).
- 디스크 지연: 위 T-4 표의 fsync+20ms 열.

## mutant (`logs/mutants/mutants.tsv`)

대상: presence-deadline, presence-batches, presence-retention, session-board

| mutant | 결과 | 잡은 시험 |
|---|---|---|
| BASELINE | PASS | |
| D1 전체 deadline 제거(남은 시간 확인과 예산 전달 모두) | KILLED | 3 (fake 1·2, 실제 느린 broker) |
| D2 진행 중인 요청에 예산을 넘기지 않음(deadline 뒤 답을 반영) | KILLED | 2 (fake 1·2) |
| D3 묶음마다 deadline을 새로 잡음 | KILLED | 3 |
| D4 전송 실패 뒤 계속 요청 | KILLED | 2 (presence-batches) |

동시성 상한 mutant는 해당하지 않는다. 동시성을 넣지 않았기 때문이다.

## 문서와 버전

- `docs/session-message-lifecycle.md` 조회 절: 전체 deadline, 남은 시간 전달, 늦은 응답, 20 s 근거, 동시성을 택하지 않은 이유를 적었다. "여러 묶음을 합친 전체 deadline은 없다" 문장은 지웠다.
- `docs/release-notes-v2.7.6.md`를 새로 썼다.
- 2.7.6으로 올린 파일은 v2.7.5와 같은 집합이다: `package.json`, `.codex-plugin/plugin.json`, `release/version.json`, `.agents/plugins/marketplace.json` ref, `mcp-server/src/plugin-info.ts`, README 두 개(설치 ref v2.7.6), `docs/roadmap.md`. dist와 claude-plugin은 다시 생성했다.
- 공개된 v2.7.5 이하 notes는 바꾸지 않았다.

## 검증 (Node v24.21.0)

전체 순서는 `10cfd37`에서 돌렸다(`logs/summary.tsv`).

| 단계 | 종료 코드 |
|---|---|
| install, bundle:check, claude:drift(fresh), lint, build | 0 |
| test | 0 (885 passed, 4 skipped) |
| runtime:check, validate:all | 0 |
| validate:official | 1, FAIL_UNRELATED(환경: Codex validator ENOENT) |
| claude:build, claude:check(fresh), source:check, git diff --check(작업 트리, 3706167..HEAD) | 0 |

- 검증 뒤 `git status`는 비어 있다.
- 마지막 `93a7e4b`는 `previous-broker.test.ts`만 바꿨다. 이 시험은 env가 없으면 skip된다. 이 commit에서 다시 확인했다(`logs/post-test-fix-checks.log`): lint 0, bundle:check 0, claude:check fresh, `git diff --check 3706167..HEAD` 0.
- 10회 반복(`logs/repeat-10x.log`): presence-deadline 10/10(4/4), presence-batches 10/10(4/4), presence-retention 10/10(10/10)
- previous-broker(`logs/previous-broker-*.log`)
  - 새 service·client와 옛 broker를 섞은 혼합 버전 presence 시험이 포함된다.
  - v2.7.5 첫 실행은 1개 실패였다(`logs/previous-broker-v2.7.5-first-run-failed.log`). v2.7.5 broker가 끝난 birth의 wake를 스스로 퇴역시키는데, 시험은 2.7.4 이하 broker를 가정했기 때문이다. 시험을 고친 뒤(`93a7e4b`) v2.7.5, v2.7.4, v2.7.3 모두 4/4다.
- 끝난 뒤 broker process는 0개다.
  - `/tmp/ags-*` 중 3개는 2026-09-28 15:04에 만들어진 이전 작업의 잔여물이다.
  - 3706167 fsync 기준선에서 시간 초과로 남은 fixture 디렉터리 1개(합성 DB)는 지웠다.

## NOT_RUN

- Windows 실행, push 뒤 CI. SIGSTOP은 쓰지 않았다. 새 시험의 자식 broker는 종료를 기다린 뒤 디렉터리를 지운다. preload 경로는 `pathToFileURL`로 넘긴다.
- 실제 Codex MCP 도구 timeout과 결합한 현황판 호출.
- `source:verify`: 삭제된 외부 저장소 때문에 NOT_VERIFIABLE이며 실행하지 않았다.
- previous-broker v2.7.2, v2.7.1, v2.2.6: 요청 범위 밖이다.

## 남은 한계

- broker가 20 s 안에 다 답하지 못하면 현황판 뒤쪽 세션은 그 조회에서 unknown이다.
- 실제 느린 broker 시험의 elapsed 여유는 2 s다. fsync 흉내에서 시험 전체가 21.2 s였고, broker 기동을 포함한 값이다.
- 현황판 파일 읽기와 다른 broker 요청의 deadline은 그대로다.
- L3, T-3, I-3은 범위 밖이다.

## 가림

같은 규칙으로 가렸다. 건수는 `meta.json`에 있다. `SHA256SUMS`는 커밋된 blob 기준이다.
