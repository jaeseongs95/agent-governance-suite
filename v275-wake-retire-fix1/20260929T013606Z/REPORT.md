# AGS 2.7.5 감사 후속 (fix1: T-2, I-2)

- 기준: `claude/v275-wake-retire` = `3501e7c5fe998a554e8fa3e3ab795b469dccf2e8`
- 감사: `claude/evidence-v275-audit-20260929T012510Z`를 반영했다. `audit/REPORT.md`의 T-2·I-1·I-2 절, `logs/counterexample.log`, `harness/counterexample.ts`, `harness/mutants.py`(A2·A4·A6)를 직접 읽었다.
- 새 commit: `44235fb5c0fc7efab69c989df4d8eff3975af26f`, tree `790a117efbf2fb41317c1b23e4abcbad58d95373`
  - `ba07468` test: pin the latest-birth retirement counterexample
  - `44235fb` docs: note the resumed-host marker change in 2.7.5 notes
- push: non-force fast-forward(`3501e7c..44235fb`)이다. `merge-base --is-ancestor`와 `ls-remote`로 확인했다.
- 제품 코드, 상수, 버전은 바꾸지 않았다(`logs/change.diff`: 시험 1개와 release notes).

## 추가한 사례 (`wake-liveness.test.mjs`의 `deaths` 표)

기존 퇴역 시험에 사례 3개를 추가했다. 각 사례에서 다음을 모두 확인한다.

- 만료 + 유예 1 ms 전에는 행이 그대로다.
- 그 시각에 `expired-unobserved`로 바뀌고 `retired_at`이 그 시각이다.
- 다른 열은 바뀌지 않는다.
- 활동 기록이 없다.
- 1시간 뒤 terminal 정리로 지워진다.

벽시계 lease에는 기대지 않는다. 모든 판정에 명시적 시각을 쓴다.

| 사례 | 내용 | 잡는 mutant |
|---|---|---|
| `live-birth-behind-ended` (T-2) | wake의 birth A는 lease를 유지한다(`keep`). 더 늦은 B가 태어났다가 끝났다. 퇴역한 뒤 최신 행은 `ended`이고, A로 `reserveManagedWake`해도 새 wake가 없으며(`dispatch: false`), `autoWake`는 `presence-not-online`이다 | A6 |
| `same-ms-other-instance` (A4, 감사 I-1) | 같은 ms에 태어난 다른 instance가 rowid로 최신 행이고 살아 있다 | A4 |
| `lease-ends-at-retirement` (A2) | A의 lease가 정확히 퇴역 시각에 끝난다. lease가 now보다 뒤가 아니면 live가 아니다 | A2 |

감사 `counterexample.log`의 후보 결과(`wakeAfterPrune: expired-unobserved`, `newWakeForA: false`, `autoWake: presence-not-online`)와 같은 내용을 T-2 사례가 단언한다.

## 수정 전후

| store | 결과 | 로그 |
|---|---|---|
| 3501e7c5 제품 코드 | 36/36 통과 | `logs/after-3501e7c-store-wake-liveness.log` |
| 0c8b52d9 store | exit 1, 12 failed / 24 passed(새 3사례 모두 실패) | `logs/before-0c8b52d-store-wake-liveness.log` |

A6에서도 실패했다(아래 mutant 표).

## 바꾼 문구 (`docs/release-notes-v2.7.5.md`)

- 동작 변화 절(I-2, 감사 O1)에 추가: "잠자기나 재부팅 뒤 복귀한 세션에 옛 marker가 먼저 도착해도 사용자에게 보이는 결과가 바뀝니다. 그 사이 다른 세션의 요청이 prune을 불러 알림이 이미 퇴역했다면, 2.7.4에서는 이 marker가 빈 모델 턴을 만들었지만 2.7.5에서는 Codex hook이 모델 요청 전에 막습니다. 본문은 복귀한 세션의 새 wake로 전달됩니다."
- 본문 셋째 문단(I-1): "새 규칙은 … 구간에서만 결과가 다릅니다." 뒤에 추가: "예외로, 알림의 birth와 같은 ms에 태어난 다른 instance가 최신 행으로 살아 있으면 2.7.4는 영구히 latch로 두었지만 2.7.5는 더 늦은 birth처럼 퇴역시키고 그 instance에 새 wake를 보낼 수 있습니다."
- lifecycle 문서의 "누적 억제 범위는 줄지 않는다" 문장은 이 예외에서도 맞다. 다른 instance이기 때문이다. 그래서 바꾸지 않았다.

## mutant (`logs/mutants/mutants.tsv`)

대상 시험: wake-liveness, presence-retention, session-message

| mutant | 결과 | 실패 시험 수 |
|---|---|---|
| BASELINE | PASS | 0 |
| N1 새 근거 삭제 | KILLED | 12 |
| N2 유예 삭제 | KILLED | 17 |
| N3 live 반전 | KILLED | 6 |
| N4 세션 live 행 존재만 | KILLED | 14 |
| N5 instance·birth 비교 삭제 | KILLED | 12 |
| N6 transport 결속 | KILLED | 1 |
| A2 `lease_until >= now` | KILLED | 1 (`lease-ends-at-retirement`) |
| A4 birth만 비교 | KILLED | 1 (`same-ms-other-instance`) |
| A6 가장 이른 행 | KILLED | 1 (`live-birth-behind-ended`) |

## 검증 (Node v24.21.0, `logs/summary.tsv`)

| 단계 | 종료 코드 |
|---|---|
| install --frozen-lockfile, bundle:check, lint, build | 0 |
| test | 0 (880 passed, 4 skipped) |
| claude:check | 0 (fresh) |
| git diff --check, git diff --check 3501e7c..HEAD | 0 |

- 검증 뒤 `git status`는 비어 있다.
- wake-liveness 10회 반복: 10/10, 매회 36/36(`logs/repeat-10x.log`)
- previous-broker v2.7.4: 4/4(`logs/previous-broker-v2.7.4.log`)
- 끝난 뒤 broker process는 0개다.

## NOT_RUN

- 요청 범위 밖의 전체 검증 단계: `claude:drift`, `runtime:check`, `validate:all`, `validate:official`, `claude:build`, `source:check`. 제품 코드가 바뀌지 않았다.
- previous-broker v2.7.3·v2.7.2·v2.7.1·v2.2.6(요청은 v2.7.4). Windows 실행, push 뒤 CI.

## 가림

같은 규칙으로 가렸다. 건수는 `meta.json`에 있다. `SHA256SUMS`는 커밋된 blob 기준이다.
