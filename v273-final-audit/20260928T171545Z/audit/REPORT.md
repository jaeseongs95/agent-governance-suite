# AGS v2.7.3 출시 전 최종 결합 tree 독립 사전 감사

- 최종 후보: `claude/v273-integration` = `46859d041841fab208faa1d9b45e813de0f5e864` (tree `9003c47ca72a95db1545ce5f2610e5ba55d568f4`)
  - 감사 도중 총괄 지시로 추가됐다. `9a678df4`(tree `4e979fa9…`) 위의 테스트 전용 커밋 1개다.
  - 감사 본체는 `9a678df4`에서 수행했다. `46859d04`는 `tests/session-messaging/message-retention.test.ts`만 +7 −3 바꿨으므로(`git diff --quiet 9a678df4 46859d04 -- . ':!<그 파일>'` 확인), 그 변경을 별도로 판정하고 전체 검증을 `46859d04`에서 다시 실행했다.
- 기준: `main` = `8763cef2b11f2635d6c9af7861b5bffd496e2a30` (v2.7.2)
- 구성
  - wake `651f5ec9`
  - intake `33dfdc02`
  - Q `d99d768e`(병합 경로 `74395bf6` → `d99d768e`)
  - 통합 커밋 `d9498d6`, `e71b121`, `92b1a0d`, `4195850`, `b6deb37`, `6b5af08`, `6852c72`, `9a678df`, `46859d0`
- 감사자: 통합 세션과 분리된 독립 감사자. 읽기 전용으로 감사했다. mutant는 버리는 worktree에서만 적용하고 되돌렸다.
- 환경: Linux cloud 컨테이너 1대, Node v24.21.0, pnpm 11.19.0.

## 최종 판정: **PASS_WITH_FINDINGS**

**출시 차단 여부: 차단하지 않는다.** 이 tree(`46859d04`)를 main에 반영하고 v2.7.3 태그를 붙여도 된다.

- blocker와 major는 없다.
- minor 2건(P-1 릴리스 노트 문구, P-2 Windows 줄의 공개 증거 부재)은 문서와 증거 문제다.
- 정보 1건(I-1)은 이전부터 있던 시험 판별력 한계다.

## 항목별 결과

| # | 항목 | 결과 |
|---|---|---|
| 1 | 구성 일치 | PASS |
| 2 | 병합 해법의 의미 | PASS |
| 3 | 결합 회귀(감사 테스트, mutant, 교차 경로) | PASS |
| 4 | 버전과 문서 | PASS_WITH_FINDINGS (P-1, P-2) |
| 5 | 전체 검증과 previous-broker | PASS (`validate:official`만 FAIL_UNRELATED) |
| 6 | 46859d04 테스트 전용 변경 | PASS |
| 7 | 출시 차단 여부 | 차단 없음 |

### 1. 구성 일치 — PASS

각 병합 커밋의 두 부모를 `git merge-tree --write-tree`로 다시 병합하고, 그 결과 tree를 실제 병합 커밋과 비교했다(`logs/merge-replay.log`).

- `d9498d6`(base+wake)와 `e71b121`(+intake): 자동 병합 결과와 **완전히 같다**(diff 0).
- `92b1a0d`(+Q `74395bf`): 충돌 해법이 지정된 곳에만 있다.
  - `server.ts`의 send 설명
  - `session-message-service.ts`의 import
  - `session-message-store.ts`의 `recordActivity` 뒤 `assertReceiptCapacity` 배치, submitPrepared의 용량 검사와 `target` 재사용, acknowledge의 루프와 `recordActivity`
  - `message-retention.test.ts`의 autoWake 기대값 4줄
  - 해당 dist 번들 2개씩
- `6b5af08`(+Q `d99d768`): `server.ts`의 send 설명과 dist `server.mjs` 2개뿐이다.
- 비병합 통합 커밋:
  - `4195850`: 버전 11개 파일
  - `b6deb37`, `6852c72`, `9a678df`: `docs/release-notes-v2.7.3.md`만
  - `46859d0`: retention 테스트만
- 위에 적은 것 밖의 차이는 없다. dist가 병합된 소스의 빌드 결과와 같은지는 `bundle:check` 통과와, build·claude:build 뒤 `git status` 빈 출력으로 확인했다.

### 2. 병합 해법의 의미 — PASS

**submitPrepared** (`session-message-store.ts:393-432`, `9a678df4`)의 처리 순서는 다음과 같다.

1. `BEGIN IMMEDIATE`, 그 뒤 prune.
2. 발급 행이 없으면 unavailable로 거절한다.
3. 영수증이 있으면 autoWake를 계산해 duplicate로 반환한다. 용량 검사보다 먼저다.
4. 발신자·전역 용량 검사.
5. `send` 삽입.
6. byte 용량 검사.
7. 영수증 UPDATE, 그 뒤 autoWake 계산, 그 뒤 COMMIT.

용량 거절은 모두 autoWake 계산 전에 throw되고 catch의 ROLLBACK으로 돌아간다. 감사 X1b로 직접 확인했다. prepare 때는 여유가 있었는데 send 때 발신자 한도가 찬 경우, autoWake 호출은 0회, 여섯 표 snapshot은 그대로, draft는 본문을 유지한 채 prepared로 남았다.

**acknowledge** (`:625-648`): 한 `BEGIN IMMEDIATE` 안에서 메시지 ACK, 그 행에 한한 영수증 `min(기존, ACK+1h)`, `recordActivity`, COMMIT 순으로 처리한다.

- X2: 만료 뒤 ACK 한 번이 영수증과 활동을 함께 갱신했고, 다음 prune에서 알림이 한 번만 퇴역했다. 두 번째 ACK는 0건이고 영수증을 늘리지 않았다.
- X2b: `session_activity` 쓰기를 trigger로 실패시키면 ACK와 영수증 갱신이 함께 rollback됐다(snapshot 같음).

**send 설명** (`server.ts`): wake 문장("queued, not received", advisory autoWake)과 Q 문장(D1 확정 거절, `expiresAt`과 `earliestReleaseAt` 비교, "Never do both")이 모두 들어 있다. 앞은 성공 결과, 뒤는 거절 결과에 관한 문장이라 서로 모순되지 않는다. Q 문구는 재감사2에서 ACCEPT된 `d99d768e` 것과 같다.

**autoWake 기대값** (`message-retention.test.ts` 4곳): `{ ...sent, duplicate: true }`를 `{ ...sent, duplicate: true, autoWake: { ...sent.autoWake, checkedAt: <호출 시각> } }`으로 바꿨다. receipt 필드와 autoWake의 나머지 필드는 여전히 엄격히 비교한다. store 호출 3곳은 정확한 시각을, 별도 broker를 거치는 service 1곳만 `expect.any(String)`를 쓴다. 약해진 곳은 없다.

### 3. 결합 회귀 — PASS

감사 테스트는 모두 `9a678df4`에서 실행했다. race는 20회다.

| 묶음 | 결과 | 예상된 실패 |
|---|---|---|
| wake 감사·재감사(`audit-retire`, `audit-race`, `reaudit-f1-store`, `reaudit-f1-hook`) | 31개 중 30개 통과. R1·R2·R3 20회 모두 통과 | `2b`(원본 probe가 F1 수정 전 동작을 단정) |
| Q 감사·재감사(`audit-compat`, `audit-msgqueue`, `reaudit-n5`, `reaudit-trigger`, `reaudit2-guidance`), 원본 그대로 | 22개 중 19개 통과, 2 skip(env) | I1·I2(autoWake 추가로 `toEqual` 불일치), N5-b(옛 안내 문구 단정) |
| 같은 묶음, checkedAt만 조정한 사본(`logs/q-audit-autowake-only.diff`, 6줄) | 22개 중 21개 통과, 2 skip | N5-b만 |
| Q compat C1~C3 | v2.7.2와 v2.7.1에서 3/3 통과 | v2.2.6은 C1 통과. C2·C3은 해당 없음(v2.2.6 CLI에 prepare 없음: "Unsupported session message operation", 릴리스 노트와 일치) |
| intake init-smoke 9경우(3 layout × 3 profile) | 9/9에서 공통 블록 1회, 오류 0 | 없음 |

intake init-smoke의 instructions sha256(`474cdcdb…`)과 intake sha256(`f40bce91…`)은 intake 재감사 결과와 같다.

**mutant** (`logs/mutants/mutants.tsv`, 후보 테스트 `tests/session-messaging`와 `tests/session-board`)

- BASELINE: 295 통과, 2 skip.
- Q mutant 22개와 wake M1~M4, 합계 **26/26을 후보 테스트가 모두 검출**했다. 생존 0이다.
- 병합으로 앵커가 바뀐 Q mutant 2개는 같은 의미로 옮겼다(`logs/q-mutants-anchor-port.diff`).
  - M05: duplicate 분기에 autoWake 줄 포함
  - M11: ACK 루프 뒤 `recordActivity` 포함
- wake M1은 `cc0d51c`의 store hunk를 역적용했다. M2~M4는 이전과 같은 sed 앵커가 그대로 맞았다.

**교차 경로** (`tests/final-cross.test.mjs`, 5/5 통과)

- X1: 발신자 용량이 찬 상태에서 duplicate 재전송은 schema에 맞는 autoWake를 돌려준다(checkedAt은 호출 시각). 새 prepare는 `scope: sender` 확정 거절이며 표가 바뀌지 않는다.
- X1b, X2, X2b: 2절 참고.
- X3: 조회 도구(`listPresence`) 첫 호출 한 번이 만료 영수증 삭제와 알림 퇴역을 함께 일으켰다. 이어지는 `status`, `listPresence`, `status` 반복에서는 snapshot, 응답, `retired_at`이 모두 같았다(멱등).

### 4. 버전과 문서 — PASS_WITH_FINDINGS

**버전 표기**

- v2.7.2 태그에서 `2.7.2`를 담은 파일 12개와 최종 tree에서 `2.7.3`을 담은 파일을 비교했다. 차이는 두 가지다.
  - 릴리스 노트 파일 이름.
  - `scripts/check-skill-context-optimization.mjs:16`의 `revision: "2.7.3-intake-selection-timing"`. 이것은 intake 후보(33dfdc0)의 revision 표지이며 릴리스 버전 표기가 아니다.
- 남은 `2.7.2`는 모두 과거 기록이다: v2.7.2 노트, 2.7.3 노트와 lifecycle 문서의 "2.7.2는 …" 서술, 테스트 이름과 주석.

**릴리스 노트 대조**

- wake 퇴역 조건, 누적 상한, F1 섞인 prompt, `blocksEmptyWakePrompt`, C2, autoWake, 조회 prune, 발신자 250과 전역 1000, prepare 입장 검사, ACK+1h, D1 확정 거절과 재시도 규칙, C1~C3 혼합 동작, init 안내와 SessionStart hook(`claude-plugin/hooks/hooks.json`에서 skill-trigger hook은 SessionStart에만 등록됨), 알려진 한계(R-1, F-4 이중 투영, G2 표본)를 코드·테스트·evidence와 대조했다. 모두 일치한다. 예외는 P-1과 P-2다.
- 링크: `skills/orchestrator/SKILL.md#공통-접수선택-기준`(`:14`), `session-message-lifecycle.md#미관측-알림-퇴역과-자동-깨우기-신호`(`:132`), `README.md#설치`(`:26`)가 모두 해석된다.
- 외부 스킬 저장소 링크는 없다. 변경 파일의 외부 URL은 기준에 이미 있던 것뿐이다(plugin homepage, Codex hooks 문서).
- 제품명은 host 설명과 "현재 Codex" capability 설명에만 나온다. 공통 정책을 제품명으로 분기하지 않는다.

### 5. 전체 검증 — PASS (`validate:official`만 FAIL_UNRELATED)

같은 순서를 `9a678df4`(`logs/full-*`)와 `46859d04`(`logs46/full-*`)에서 두 번 실행했다. 결과는 두 번 모두 같다.

| 명령 | 종료 코드 |
|---|---|
| `pnpm install --frozen-lockfile` | 0 |
| `pnpm bundle:check` | 0 |
| `pnpm claude:drift` | 0 (`fresh`) |
| `pnpm lint` | 0 |
| `pnpm build` | 0 |
| `pnpm test` | 0 (파일 61 통과·1 skip, 테스트 858 통과·2 skip) |
| `pnpm runtime:check` | 0 (29 CLI) |
| `pnpm validate:all` | 0 |
| `pnpm validate:official` | 1, **FAIL_UNRELATED(환경)**: Codex `validate_plugin.py` ENOENT |
| `pnpm claude:build` | 0 |
| `pnpm claude:check` | 0 (`fresh`) |
| `git diff --check` | 0 |
| `pnpm source:check` | 0 (`source lock is consistent`) |

두 번 모두 build와 claude:build 뒤 `git status --porcelain`은 빈 출력이었다.

previous-broker는 태그 dist의 `session-message-broker.mjs` 파일 경로를 줘서 실행했다. v2.7.2(`fbb808e0…`), v2.7.1(`d4b667d4…`), v2.2.6(`14f9345d…`) 모두 2/2 통과했다. `9a678df4`와 `46859d04` 두 곳에서 돌렸다.

### 6. 46859d04 (`PRAGMA synchronous = NORMAL`, 테스트 전용) — PASS

- 범위: `message-retention.test.ts`에서 `fillFixture`를 추가하고 세 테스트(`:179`, `:243`, `:359`)의 채우기 연결만 바꿨다. 단언, 시험 조건, timeout, 제품 코드는 그대로다.
- per-connection 확인(`logs/sync-probe.log`):
  - 채우기 연결에 NORMAL을 걸면 그 연결은 `synchronous=1`이다.
  - 같은 파일을 여는 두 번째 in-process 연결과 별도 child process 연결(worker나 broker와 같은 방식)은 `synchronous=2`(FULL), `journal_mode=wal` 그대로다.
  - 제품 `session-message-store.ts`는 synchronous를 설정하지 않으므로 broker와 worker는 기본값을 쓴다.
  - WAL에서 synchronous는 전원 장애 때의 내구성에만 관여하고, 다른 연결이 commit을 보는 시점과는 무관하다.
- 경합 시험(`:179`) 판별력(`logs/race-discrimination.tsv`, `logs/race-discrimination-wide-workers.tsv`). 같은 mutant에 옛(`9a678df`) 파일과 새(`46859d04`) 파일을 각각 10회 돌렸다.

| mutant | 옛 파일 실패 | 새 파일 실패 |
|---|---|---|
| 없음 | 0/10 | 0/10 |
| M02(발신자 검사 제거) | 10/10 | 10/10 |
| M06(검사를 transaction 밖으로) | 1/10 | 1/10 |
| M06-wide(worker에서만 150ms 창) | 10/10 (길이 2 단언 실패) | 10/10 |

판별력은 떨어지지 않았다. 처음 만든 M06-wide는 채우기 과정에도 지연이 들어가 timeout으로 실패했으므로 무효로 처리하고, worker에서만 지연을 넣도록 고쳐 다시 쟀다.
- Linux 시간(3회): 바뀐 세 테스트가 각각 약 720→480ms, 2700→1900ms, 720→500ms로 줄었다. Windows CI 시간은 재지 않았다(NOT_RUN).

## Findings

### P-1 (minor, 릴리스 노트 문구) "3/3으로 회복"이 v2.7.2 대비 개선처럼 읽힌다

- 위치: `docs/release-notes-v2.7.3.md` 알려진 한계 3번째 문단.
- 근거:
  - G2 재측정(`claude/evidence-v273-g2r2-20260928T150232Z:g2/REPORT.md:18`): "p7에서 candidate는 3/3 … base도 3/3".
  - 2단계(`claude/evidence-v273-g2-20260928T142619Z:g2/REPORT.md:15`): 중간 후보 732ba28은 0/3.
  - 따라서 "회복"은 중간 후보 대비이고, 출시된 v2.7.2 대비로는 같은 수준이다.
- 권장: "첫 도구 호출 전 `orchestrator` 호출은 v2.7.2와 같은 3/3이다(개발 중 후보의 0/3 퇴행을 되돌렸다)"처럼 비교 대상을 적는다.

### P-2 (minor, 증거) Windows 줄을 뒷받침하는 공개 evidence가 없다

- 위치: `docs/release-notes-v2.7.3.md:31`.
- 근거: `claude/evidence-v273-*` 브랜치 전체를 검색했지만 Windows 11이나 Node 24.19.0 실행 로그는 없다. integration-1~4 보고서는 모두 Windows를 "총괄 로컬 검증 범위"로 남겼다. 이 감사는 그 결과를 재현하거나 확인할 수 없다(NOT_VERIFIABLE).
- 문구 자체는 범위를 넘지 않는다("저장소 검사이며 설치된 host의 동작 확인은 아닙니다"). 다만 어느 commit에서 실행했는지 적혀 있지 않다. 줄은 `9a678df`에서 썼고, 최종 후보는 테스트 파일이 바뀐 `46859d04`다.
- 권장: 태그 전에 Windows 로그(명령별 종료 코드, commit SHA 포함)를 evidence 브랜치로 공개하고, 그 commit이 `46859d04`임을 기록한다. 공개하지 않을 경우 notes에 "총괄 로컬 PC 실행, 로그 비공개"라고 밝힌다.

### I-1 (정보, 기존) 발신자 경합 시험은 좁은 TOCTOU 창을 가끔만 잡는다

- 위치: `tests/session-messaging/message-retention.test.ts:179`.
- M06을 옛 파일과 새 파일 모두 1/10으로 잡는다. 창을 넓히면 10/10이다. 46859d04와 무관하게 전부터 있던 성질이며, M06은 다른 후보 테스트가 결정적으로 잡으므로(26/26 표) 출시와 무관하다.

## NOT_RUN과 이유

- Windows 검증: 이 감사 환경에 Windows가 없다. 릴리스 노트 Windows 줄의 사실 여부는 NOT_VERIFIABLE이다(P-2).
- 새 GitHub CI run 36454035194 결과: 진행 중이라 들었고, 이 감사는 GitHub Actions를 조회하지 않았다.
- 실제 Codex·Claude host의 wake 주입·관측, 설치 캐시, marketplace 설치: host와 설치 환경이 없다.
- `pnpm validate:official`: 실행했으나 FAIL_UNRELATED(환경).
- 이관 SIGKILL campaign: 이관 코드가 wake 감사 이후 바뀌지 않아 다시 돌리지 않았고, 이전 감사 결과를 유지한다.
- korean-prose flaky 반복과 G2 자연어 측정 재실행: 범위 밖이다. G2는 evidence만 대조했다.

## 가림(redaction)

이전 감사와 같은 `harness/redact.py`를 적용했고 건수는 `meta.json`에 있다. 커밋 작성자 이메일 등 개인정보가 로그에 들어가지 않게 했으며, 걸린 값은 `[REDACTED]`로 바꿨다. 가린 뒤 `SHA256SUMS`를 다시 만들었다. 하네스 안의 경로도 가려졌으므로 다시 실행할 때는 실제 경로로 바꿔야 한다.

## 산출물

- `audit/REPORT.md`, `audit/meta.json`, `audit/SHA256SUMS`
- `audit/logs/` (`9a678df4`): 전체 검증, 병합 재생, 감사 테스트, mutant 27회, 교차 경로, previous-broker, compat, init-smoke, 판별력
- `audit/logs46/` (`46859d04`): 전체 검증, previous-broker, Linux 시간 측정
- `audit/tests/`: `final-cross.test.mjs`, `sync-probe.test.mjs`, 재사용한 wake 감사 테스트, checkedAt만 조정한 Q 감사 사본(원본 대비 diff는 logs에 있음)
- `audit/harness/`: `run-full.sh`, `run-full-46.sh`, `run-mutants.sh`, `mutants-q-final.py`(원본은 `mutants-q-original.py`), `wake-M1-F1.patch`, `race-discrimination.sh`, `init-smoke.mjs`, `redact.py`, `make-meta.sh`
