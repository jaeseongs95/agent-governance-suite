# AGS 2.7.4 감사 후속 수정 (fix2: F1, F2, F3)

- 기준: `claude/v274-presence` = `0f0c192e3027525d2f12e17620c29e9e2cfd7c43`
- 감사: `claude/evidence-v274-audit-20260928T230037Z` `audit/REPORT.md` (PASS_WITH_FINDINGS). R5, R6, B1 절을 읽고 반영했다.
- 새 commit: `240e0ca5c22302f689a22c27d3ed34e1151a8ce4`, tree `6e0cb45107e32b57338a215e232ac424b8302136`
  - `d04fd6b` fix: isolate board presence batches and skip identities the broker rejects
  - `240e0ca` docs: narrow the presence retention equivalence claim
- push: non-force fast-forward(`0f0c192..240e0ca`). `git ls-remote`로 확인했다.
- 최종 tree는 전체 검증을 돌린 작업 트리의 tree(`validated-tree`)와 같다. 중간 fix commit에서도 `check-bundle`과 `claude:check`가 fresh였다(`logs/fix-commit-d04fd6b-freshness.log`).
- 지침: Skill 도구의 `agent-governance-suite:ponytail`은 이번에도 `Unknown skill`이었다. `skills/ponytail/SKILL.md`의 지침을 따랐다.
- 버전은 바꾸지 않았다(2.7.4 유지).

## F2 설계

- 패턴 공유: `isBoundedIdentity`를 `session-message-protocol.ts:9`에 두었다. store의 `boundedIdentity`(`session-message-store.ts:89`)와 service가 같은 함수를 쓴다. 정규식은 한 곳에만 있다. protocol 모듈은 client와 broker가 이미 함께 쓰는 모듈이라 서버 번들에 store(`node:sqlite`)를 끌어들이지 않는다.
- service(`session-message-service.ts:102-124`):
  - 패턴 밖 identity는 요청하지 않는다.
  - 나머지는 3개씩 묶는다. 묶음마다 try/catch로 실패를 격리한다.
  - 건너뛴 identity와 실패한 묶음의 identity는 `unanswered`로 돌려준다. 결과는 항상 `ok`다.
- server(`server.ts:246-254`): `unanswered`에 있는 세션은 `unknownPresence(..., brokerAnswered=false)`로 표시해 `autoWake: null`이다. broker가 답했는데 행이 없는 세션은 기존대로 `no-live-relay`/`presence-unknown`이다. 성공한 묶음은 정상으로 표시한다.
- 공개 도구 schema와 결과 형태는 바뀌지 않았다. `unanswered`는 내부 `SessionPresenceList` 필드이며 도구 결과에는 나가지 않는다.
- 이전 broker는 `targets`를 무시하고 전부 돌려준다. 그래서 묶음이 모두 성공하거나(한도 안) 모두 실패한다(한도 초과). 실패하면 모든 세션이 `unknown`/`null`이다(previous-broker 시험의 기대값을 이에 맞췄다).

## 수정 전 실패 (`logs/before-fix-0f0c192.log`, exit 1)

`0f0c192` 코드에서 새 시험 4개가 실패했다.

- `presence-batches.test.ts` 묶음 격리: `ok`가 `false`였다. 한 묶음 실패로 전체가 실패했다.
- `presence-batches.test.ts` 패턴 필터: 패턴 밖 identity도 요청됐다.
- `presence-retention.test.ts` B1(실제 broker, 정상 6개와 `"has space"` 1개): `ok`가 `false`였다.
- `session-board.test.ts` overlay: `unanswered` 세션의 `autoWake`가 `null`이 아니었다.

수정 뒤에는 모두 통과했다.

## F1, F3 문구

바꾼 문구 전문은 `logs/wording.diff`에 있다.

- release notes와 lifecycle 문서: 정리 전후로 같은 것은 live 세션의 presence, 퇴역 판정, `autoWake` 상태로 좁혔다. live 행이 없는 세션은 표시되는 instance, 상태, 기준 시각이 바뀌거나 `unknown`이 될 수 있다고 적었다.
- `reconcile-wake-observation`: 코드를 확인했다(`isOldGeneration`은 `this.presence()`, 즉 최신 행을 쓰고, presence가 없으면 false). 판정이 드물게 달라질 수 있고, 행이 모두 지워지면 거절된다는 한 문장을 넣었다.
- store 주석(`session-message-store.ts:327-329`)도 같게 고쳤다. 주석은 번들에 들어가지 않아 dist는 바뀌지 않는다.
- F2 문구: 묶음 실패와 패턴 밖 식별자의 새 동작, 혼합 버전 표의 "모든 묶음이 실패해"를 반영했다.
- F3: 알려진 한계에 ceil(N/3) 요청, 전체 deadline 없음, 감사 측정 N=300에서 약 0.5초를 적었다.

## mutant (`logs/mutants.tsv`)

시험 대상: presence-retention, presence-batches, session-board.

| mutant | 결과 |
|---|---|
| BASELINE | PASS |
| F2a 격리 되돌림(묶음 실패 시 전체 failure) | KILLED (묶음 격리 시험) |
| F2b 패턴 필터 제거 | KILLED (패턴 필터 시험) |
| A1 최신 대신 가장 오래된 행 보호 | KILLED |
| A2 끊긴 행도 live로 간주 | KILLED |
| A3 마지막 부분 묶음 누락 | KILLED |
| M1 birth 기준 삭제 | KILLED |
| M5 presence 삭제 제거 | KILLED |
| M7 service 묶지 않음 | KILLED |
| M9 broker 크기 검사 제거 | KILLED |

A3와 M7의 치환식은 새 루프 변수(`asked`)에 맞춰 바꿨다. 뜻은 감사와 writer 정의와 같다.

## 검증

| 명령 | 종료 코드 |
|---|---|
| `pnpm install --frozen-lockfile` | 0 |
| `pnpm bundle:check` | 0 |
| `pnpm claude:drift` | 0 (fresh) |
| `pnpm lint` | 0 |
| `pnpm build` | 0 |
| `pnpm test` | 0 (파일 63 통과·1 skip, 테스트 869 통과·3 skip) |
| `pnpm runtime:check` | 0 |
| `pnpm validate:all` | 0 |
| `pnpm validate:official` | 1, FAIL_UNRELATED(환경: Codex validator ENOENT) |
| `pnpm claude:build` | 0 |
| `pnpm claude:check` | 0 (fresh) |
| `pnpm source:check` | 0 |
| `git diff --check` | 0 |
| `pnpm source:verify` | 1, NOT_VERIFIABLE (삭제된 외부 저장소 `ponytail` clone 실패) |

추가 검증:

- presence-retention과 presence-batches 10회 반복: 10/10 통과, 매회 11/11(`logs/repeat-summary.tsv`).
- 반복 뒤 남은 broker process와 임시 디렉터리: 0개. broker 자식 process는 모두 종료를 기다린 뒤 디렉터리를 지운다(B1 시험도 같은 cleanup 관례를 쓴다).
- previous-broker: v2.7.3 3/3, v2.7.2 3/3. 개발 중에 v2.7.1과 v2.2.6도 3/3으로 확인했으나, 그 로그는 남기지 않았다.

## NOT_RUN

- Windows 재검증: 이 환경은 Linux다. 새 B1 시험은 broker 종료를 기다리는 cleanup을 쓰지만 Windows 확인이 필요하다.
- 실제 host 현황판 표시, 설치 캐시: 환경이 없다.
- F3의 크기 기반 묶음과 전체 deadline 구현: 지시대로 알려진 한계로만 기록했다.

## 가림

지난번과 같은 규칙으로 가렸다. 건수는 `meta.json`에 있다. 하네스 안의 작업 경로도 가려졌다. `SHA256SUMS`는 커밋된 blob 기준이다.
