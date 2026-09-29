# AGS v2.7.6 재감사(반영분): L2-1, T-5, I-6

- 판정 대상: `claude/v276-presence-deadline` = `906a023a565806756bb6accc37d71970c35b740b` (tree `2bd8176e36d2dd45262d17ac35a19b38c0d31a83`)
- 비교 기준: 직전 감사 대상 `93a7e4bc69f556859bc929af1df871dfc74eae68` (fast-forward 확인), v2.7.5 `3706167d`
- 직전 감사: `evidence` 브랜치 `v276-audit/20260929T034034Z` (PASS_WITH_FINDINGS)
- writer 근거 `v276-presence-fix1/20260929T035617Z` (evidence `ddfbeac`)는 대조에만 썼고, 판정은 아래 직접 재현 결과로만 했다.
- 읽기 전용. 제품 소스는 바꾸지 않았다. 시험 추가·mutant는 버리는 worktree에서만 했고 원복을 `git status`로 확인했다.

## 판정: PASS — 출시 차단 아님

L2-1, T-5, I-6 반영이 모두 요구대로이고, 새 finding은 없다. 아래 정보 항목(I-8~I-11)은 변경을 요구하지 않는다.

## 1. 범위와 신선도 — PASS

- `93a7e4bc..906a023a`: 커밋 3개(61196426, 772f3a49, 906a023a), 8개 파일, +56/−22. 파일은 요청서에 적힌 범위와 같다.
- 버전 파일(package.json, `.codex-plugin`, `.claude-plugin`, `release/`, `skills/registry.json`) 변경 0.
- 두 dist(`mcp-server/dist/server.mjs`, `claude-plugin/mcp-server/dist/server.mjs`)는 byte 동일하고, service의 두 줄이 `performance.now()`로 바뀐 것을 반영한다. client 쪽 `performance` import가 `performance2`로 이름만 바뀐 것은 esbuild 이름 충돌 회피다.
- `bundle:check` 0, `claude:build` 뒤 `claude:check` 0 (logs/full-summary.tsv).

## 2. L2-1 — PASS

- `session-message-service.ts:112`(deadline)와 `:115`(remaining)가 모두 `performance.now()`다. 전역 `performance`는 Node에서 `node:perf_hooks`의 `performance`와 같은 객체(`true` 확인)이므로 client(`performance` import)와 같은 단조 시계다.
- 새 시험 "keeps the overall deadline when the wall clock steps back during a lookup"
  - 93a7e4bc 소스 + 후보 시험 파일: 이 시험만 실패(`expected null to be 20000`), 1~4는 통과 (logs/refute-base-93a7e4bc-new-deadline-test.log).
  - v2.7.5(3706167d) 소스 + 후보 시험 파일: 1, 2와 새 시험 실패(3/5), 직전 감사와 같은 판별력 유지 (logs/refute-v275-3706167d-new-deadline-test.log).
  - 후보: 5/5 통과.
- clock mutant (logs/mutants-summary.tsv, logs/mutants/)

  | mutant | 결과 | 잡은 시험 |
  |---|---|---|
  | C1 deadline·remaining 모두 `Date.now` (93a7e4bc 동작) | KILLED | 새 시계 시험만 |
  | C2 deadline만 `Date.now` | KILLED | deadline 시험 2개, B1 |
  | C3 remaining만 `Date.now` | KILLED | deadline 시험 2개, B1 |
  | C4 `await import("node:perf_hooks")` | 무효 mutant | 추가된 `await`가 시점을 바꿔 동등하지 않음. C4b로 대체 |
  | C4b 정적 `import { performance } from "node:perf_hooks"` (운영상 동등) | 4/5 실패 | I-8 참고 |

- clock-step probe 재실행 (fake timer, 300 세션, 묶음당 1.9초, 조회 5초 뒤 시계 이동; logs/clock-step.jsonl)

  | 커밋 | 시계 이동 | 단조 경과 | 요청 | 답 |
  |---|---|---|---|---|
  | 906a023a | −60초 | 20000ms | 11 | 30 |
  | 93a7e4bc | −60초 | 80000ms | 43 | 126 |
  | 906a023a | +60초 | 20000ms | 11 | 30 |
  | 93a7e4bc | +60초 | 5700ms | 3 | 9 |

  후보는 뒤로·앞으로 모두 영향이 없다. 93a7e4bc는 뒤로 가면 늘고 앞으로 가면 잘렸다.
- fake timer에 `performance`를 넣은 것: 시험 1~4 본문과 단언은 바뀌지 않았다(diff는 helper와 `beforeEach`뿐). 이 저장소의 vitest 5.0.0 기본 `toFake`는 nextTick·queueMicrotask를 뺀 전부라 `performance`는 이미 가짜였다. 실제로 93a7e4bc의 옛 시험 파일(기본 fake timer, `Date.now` helper)을 후보 소스에 돌려도 4/4 통과한다(logs/meaning-candidate-src-old-deadline-test.log). 명시 목록은 vitest 기본값 변화에 기대지 않게 고정하는 효과이며 의미 변화는 없다. 93a7e4bc·v2.7.5 소스에서 1~4의 통과/실패 양상도 직전 감사와 같다.

## 3. T-5 — PASS

- `previousAtLeast([2,7,5])`는 ended-birth 시험 시작에서 호출되고, 버전이 없거나 형식이 틀리면 임시 디렉터리를 만들기 전에 던진다. 나머지 3개 시험은 버전을 요구하지 않는다.
- 행렬 (logs/previous-broker-summary.tsv, logs/prev-*.log; tag dist broker)

  | 경우 | broker | 입력 버전 | 결과 |
  |---|---|---|---|
  | P1 | v2.7.5 | 2.7.5 | 4/4 |
  | P2 | v2.7.4 | 2.7.4 | 4/4 |
  | P3 | v2.7.3 | 2.7.3 | 4/4 |
  | P4 | v2.7.5 | 없음 | 3/4, "Set AGS_PREVIOUS_BROKER_VERSION…"로 실패 |
  | P5 | v2.7.4 | 2.7.5 (거짓) | 4/4 — 실제로 latch를 남기므로 엄격한 분기(`toEqual(before)`)를 탄다 |
  | P6 | v2.7.5 | 2.7.4 (거짓) | 3/4, `state: expired-unobserved`/`retired_at` 차이로 실패 |
  | P7 | v2.7.5 | v2.7.5 | 4/4 |
  | P8 | v2.7.5 | 2.7 (형식 오류) | 3/4, 버전 오류로 실패 |
  | P9 | v2.7.3 | 2.7.5 (거짓) | 4/4 — P5와 같은 이유 |

- 비교 함수 경계(logs/comparator.txt): 2.7.5, v2.7.5, 2.7.10, 2.8.0, 3.0.0 → true; 2.7.4, 2.7.3, 2.6.9, 1.99.99 → false; 없음, "", 2.7, 2.7.5-rc.1, " 2.7.5", V2.7.5 → throw. 숫자 비교라 2.7.10 > 2.7.5가 맞다.
- 엄격(버전 없으면 실패) 결정: 적절하다. 이 시험은 `AGS_PREVIOUS_BROKER_PATH`가 있을 때만 도는 출시 점검용이고 CI는 이 env를 설정하지 않으므로 CI를 깨지 않는다. 버전을 추측하면 T-5의 원래 문제(관찰값으로 기대를 정함)가 돌아오므로, 명시 입력이 없을 때 실패하는 쪽이 안전하다.
- 거짓 입력의 영향: "≥2.7.5"라고 거짓으로 주면, 그 broker가 실제로 퇴역시킬 때에만 완화 분기가 열린다. v2.7.4·v2.7.3은 퇴역시키지 않으므로 거짓 입력에도 엄격한 쪽이 유지된다(P5, P9). 반대로 v2.7.5를 2.7.4라고 하면 실패한다(P6). I-9 참고.

## 4. I-6 — PASS

- `presence-retention.test.ts:135`: `expect(elapsed).toBeLessThan(SESSION_MESSAGE_REQUEST_TIMEOUT_MS + 2_000)`, 상수는 client에서 import(`:9`). 값은 22000으로 이전과 같다.
- 10회 반복에서 느린 실제 broker 시험 전체 시간(준비 포함) 20324–20351ms.

## 5. 문서 — PASS

- release notes와 lifecycle 문서에 추가된 "client와 같은 단조 시계로 재므로 시스템 시계가 바뀌어도 상한은 늘거나 줄지 않는다"는 코드(2절)와 ±60초 probe 결과와 맞는다. release notes의 검증 범위 문장(가짜 client와 가짜 시계, 시스템 시계를 되돌리는 경우, 느린 실제 broker)도 시험 구성과 맞는다.
- 추가된 링크 없음. v2.7.6 notes의 링크는 저장소 안 상대 링크 2개(`session-message-lifecycle.md#presence-보존과-현황판-조회` — 제목 `:180` 존재, `../README.md#설치`)뿐이고 외부 스킬 저장소 링크는 없다.

## 6. 검증 — PASS (validate:official만 FAIL_UNRELATED)

906a023a 깨끗한 worktree, Node v24.21.0 (logs/full-*.log, full-summary.tsv):

| 단계 | 결과 |
|---|---|
| install --frozen-lockfile | 0 |
| bundle:check | 0 |
| claude:drift | 0 |
| lint | 0 |
| build | 0 |
| test | 0 — 64 files passed, 1 skipped; 886 passed, 4 skipped |
| runtime:check | 0 |
| validate:all | 0 |
| validate:official | 1 — Codex validator 파일 없음(ENOENT), FAIL_UNRELATED(환경) |
| claude:build / claude:check | 0 / 0 |
| git diff --check (작업 트리 / 93a7e4bc..906a023a) | 0 / 0 |
| source:check | 0 |
| 검증 뒤 작업 트리 변경 | 0 byte |

- presence-deadline·presence-retention·presence-batches 10회 반복: 10/10, 매회 19/19. 남은 broker process 0 (logs/repeat10.tsv).
- previous-broker v2.7.5, v2.7.4, v2.7.3 (올바른 버전 입력): 각 4/4 (3절).
- writer 근거 대조: `v276-presence-fix1/20260929T035617Z` SHA256SUMS 38/38 일치. writer의 요약(전체 검증 0, M1 KILLED, 버전 행렬)은 위 재현과 모순 없다.

## 정보 (변경 요구 없음)

- I-8: fake 시험은 전역 `performance` 객체에 묶여 있다. service가 운영상 동등한 `node:perf_hooks` import로 바뀌면 fake timer가 그 객체를 바꾸지 못해 5개 중 4개가 실패한다(C4b). 결함은 아니고, 그런 리팩터링 때 시험이 알려 준다는 뜻이다.
- I-9: T-5 분기는 버전 ≥2.7.5에서 "퇴역" 또는 "유지" 둘 다 허용한다(2.7.5 broker에 퇴역을 강제하지는 않음). 이전 broker 호환 시험의 목적상 충분하다. 입력 버전은 broker bytes와 대조하지 않는다.
- I-10: `AGS_PREVIOUS_BROKER_PATH`/`AGS_PREVIOUS_BROKER_VERSION`은 시험 파일 밖(문서·스크립트)에 적혀 있지 않다. PATH도 이전부터 그랬다. 출시 점검 절차에 두 env를 함께 적으면 P4 같은 실패를 피할 수 있다.
- I-11: writer evidence 첫 커밋 `4ce53cc`의 meta.json은 유효한 JSON이 아니었고(line 14에서 끊김), `ddfbeac`에서 고쳐졌다. 두 커밋 모두 계정명·홈 경로 문자열은 찾지 못했다.
- 직전 감사의 I-4(묶음 하나가 2.5초를 넘으면 5.5초에 전부 unknown), I-7은 이번 범위 밖이며 그대로다.

## NOT_RUN

- Windows runner, 906a023a의 GitHub CI 결과
- 실제 PC·설치 캐시·MCP 호출 흐름, Claude Code MCP 도구 제한
- previous-broker v2.7.2, v2.7.1, v2.2.6
- source:verify
- 실제 OS 시계 변경(권한·격리 문제로 fake timer probe로 대신함). 단조 시계 자체는 시스템 시계 변경에 영향받지 않는다는 Node 보장에 기댄다.

## 하네스 메모

- C4(`await import`)는 동등 mutant가 아니었다(await 추가로 시점 변화). 결과를 판정에 쓰지 않고 C4b로 대체했다.
- previous-broker 행렬 직후 broker process 1개가 보였는데(동시에 돌던 전체 시험의 것으로 추정), 이후 확인에서 0이었다(previous-broker-summary.tsv 마지막 줄).
