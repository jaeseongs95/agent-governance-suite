# AGS v2.7.3 최종 사전 감사 2차 (46859d04 → b67ee6eb 변경분)

- 새 최종 후보: `claude/v273-integration` = `b67ee6eb15aa60c3863756407d3f5a7f3c02dbcf` (tree `db108241096cb9f96b6955d3f4d1213440abb0ea`)
- 이전 감사: `46859d04`에 대해 PASS_WITH_FINDINGS. evidence는 `claude/evidence-v273-final-audit-20260928T171545Z`(`ae849a1`)에 있다.
- 범위: `e3220a48`(테스트 전용)과 `b67ee6eb`(release notes). 읽기 전용이며 제품 소스는 고치지 않았다. mutant는 버리는 worktree에서만 적용하고 되돌렸다.
- 참고한 evidence(대조용):
  - `claude/evidence-v273-integration-6-20260928T173523Z`
  - `claude/v273-evidence-windows-20260928T173839Z`(`0980fde`)
- 환경: Linux cloud 컨테이너 1대, Node v24.21.0, pnpm 11.19.0.

## 판정: **PASS_WITH_FINDINGS** — 출시 차단 없음

`b67ee6eb`를 main에 반영하고 v2.7.3 태그를 붙여도 된다. 이전 P-1과 P-2는 해소됐다. 새 finding은 minor 1건(Windows evidence의 SHA256SUMS 불일치)으로, 제품이 아니라 증거 무결성 문제다.

## 항목별 결과

| # | 항목 | 결과 |
|---|---|---|
| 1 | 범위 | PASS |
| 2 | e3220a48 시험 의미 보존 | PASS |
| 3 | b67ee6eb 문구와 Windows evidence | PASS_WITH_FINDINGS (W-1) |
| 4 | 영향 범위 검증 | PASS |

### 1. 범위 — PASS

`git diff --stat 46859d04 b67ee6eb`에 나온 파일은 두 개뿐이다.

- `docs/release-notes-v2.7.3.md`: +2 −2
- `tests/session-messaging/wake-lifecycle.test.mjs`: +19 −8

제품 코드, 번들, 계약은 바뀌지 않았다.

### 2. e3220a48 — PASS

- **SQL, 행 수, 값, 단언이 같다.** 네 테스트(`:284`, `:295`, `:520`, `:528`)의 INSERT 문자열은 한 글자도 바뀌지 않았다. 행 수는 1005, 1000, 1000, 1005로 같다. 값 식도 `i => [...]`로 옮겼을 뿐 같다. 단언 줄은 diff에 없다.
- **채우기 연결은 store가 읽기 전에 닫힌다.** `fillRows`는 `try { … } finally { filler.close(); }`이고, 동기 함수라 반환 전에 닫힌다. store의 다음 호출(`prune`, `reserveManagedWake`, `SELECT count`)은 그 뒤에 일어난다.
- **행이 보이는 시점과 transaction 가정이 같다.** 두 방식 모두 autocommit이다.
  - store는 wake 행을 메모리에 캐시하지 않고 매번 SQL로 읽는다.
  - 채우는 동안 store 연결에는 열린 transaction이 없다(모든 store 메서드는 반환 전에 COMMIT이나 ROLLBACK한다).
  - WAL에서 commit된 행은 store 연결의 다음 읽기 snapshot에 보인다. 옛 방식(store 자신의 연결)과 관측 가능한 차이가 없다.
  - WAL 모드는 DB 파일에 남아 있으므로 채우기 연결도 WAL을 쓴다.
  - `busy_timeout 5000`은 잠금 충돌 때 기다리기만 하며, store가 쓰기 잠금을 쥐고 있지 않으므로 경합도 없다.
- **synchronous는 연결별 설정이다.** 이전 감사의 `sync-probe`에서 연결별 설정이 다른 연결에 퍼지지 않음을 이미 측정했다. store 연결은 기본값(FULL)을 유지한다.
- **결함 검출력**(`logs/lifecycle-mutants.tsv`). 같은 mutant를 옛(`46859d04`)과 새(`e3220a48`) 테스트 파일에 적용해 비교했다.

| mutant | 옛 파일 | 새 파일 | 잡은 테스트 |
|---|---|---|---|
| 없음 | 51/51 통과 | 51/51 통과 | — |
| B1 active 예산 검사 제거 | 2 실패 | 2 실패 | `:295`, `:520` |
| B2 예산에서 backoff 행 제외 | 1 실패 | 1 실패 | `:295` |
| P1 보관 상한이 backoff 보호를 무시 | 1 실패 | 1 실패 | `:284` |
| P2 보관 상한 OFFSET +10 | 1 실패 | 1 실패 | `:528` |
| P3 보관 상한이 최신 대신 가장 오래된 행을 남김 | 0 실패 | 0 실패 | 옛·새 모두 못 잡음(I-2, 기존) |

검출은 옛 파일과 새 파일이 완전히 같다. 판별력이 떨어지지 않았다.

### 3. b67ee6eb — PASS_WITH_FINDINGS

- **P-1(해소)**: "`orchestrator` 호출은 v2.7.2와 같은 3/3", "옮기는 도중의 후보에서 0/3으로 떨어졌던 것을 되돌린 것이며, v2.7.2보다 나아진 것은 아닙니다"로 고쳤다. G2 재측정(base 3/3, candidate 3/3)과 2단계 결과(중간 후보 0/3)에 맞는다.
- **P-2(해소)**: 검증 commit `e3220a48`과 로그 브랜치를 적었다.
  - `e3220a48`은 코드 최종 커밋이다. 뒤의 `b67ee6eb`는 notes만 바꾼다.
  - Windows evidence의 대상 SHA와 tree(`2934992d…`)가 `git rev-parse e3220a48^{tree}`와 일치한다.
- Windows evidence 내용과 notes 대조:
  - `summary.tsv`: 14단계와 previous-broker 3개가 모두 종료 코드 0이다.
  - `06-test.log`: 858 통과, 2 skip.
  - `09-validate_official.log`: "Plugin validation passed", "Skill is valid!".
  - `claude:check` fresh, `source lock is consistent`, runtime 29 CLI, `prev-*.log` 각 2/2.
  - 환경은 Node v24.19.0, pnpm 11.19.0, Windows 11 Pro다.
  - notes의 "설치부터 `validate:official`, `claude:check`, `source:check`까지 통과, previous-broker 세 태그 통과, 저장소 검사이며 host 동작 확인은 아님"과 일치한다. 과장은 없다.
- Windows evidence 가림:
  - 이메일, 사용자 이름이 든 홈 경로(`C:\Users\…`), 계정 이름, 토큰 패턴, IP는 0건이다.
  - 로그에 작업 경로 `D:\codex\거버전스 3.0\agent-governance-suite-v273-integration`이 남아 있다. 사용자 이름이 들어 있지 않아 가림 규칙 위반은 아니다. 다만 REPORT의 "작업 경로는 meta.json에 적지 않았다"는 meta.json에만 해당하는 말이다.
- GitHub CI run 36459480815: GitHub MCP로 읽기 전용 조회했다. `e3220a48`에서 ubuntu-latest와 windows-latest job이 모두 `success`였다(`logs/ci-run-36459480815.txt`). 총괄 보고와 일치한다.

### 4. 영향 범위 검증 — PASS

모두 `b67ee6eb`에서 실행했다.

| 검증 | 결과 | 로그 |
|---|---|---|
| `wake-lifecycle.test.mjs` 10회 | 10/10에서 51/51 통과, 회당 약 5.0~5.8초 | `logs/wake-lifecycle-10x.txt` |
| `pnpm lint` | 종료 코드 0 | `logs/lint.log` |
| `pnpm test` | 종료 코드 0, 858 통과·2 skip | `logs/test.log` |
| `git diff --check` | 0 (작업 트리 기준, `46859d04..b67ee6eb` 범위 모두) | `logs/diff-check*.log` |
| 검증 뒤 `git status --porcelain` | 0 byte | `logs/summary.txt` |

## Findings

### W-1 (minor, 증거 무결성) Windows evidence의 SHA256SUMS가 3개 파일에서 맞지 않는다

- 위치: `claude/v273-evidence-windows-20260928T173839Z:windows/SHA256SUMS`
- 재현: 브랜치를 `git archive`로 풀고 저장소 루트에서 `sha256sum -c windows/SHA256SUMS`를 실행한다(`logs/windows-evidence-sha256-check.txt`).
  - FAILED: `windows/logs/00-env.txt`, `windows/logs/08-validate_all.log`, `windows/logs/09-validate_official.log`
  - 나머지 19개는 OK다.
  - LF/CRLF, BOM, UTF-16, CP949, 끝 줄바꿈 변형을 모두 시도했지만 기록된 해시를 재현하지 못했다. 해시를 만든 뒤 내용이 바뀐 것으로 보인다(예: 경로 정리). 무엇이 바뀌었는지는 알 수 없다.
- 영향: 제품과 출시에는 영향이 없다. 내용 자체는 notes와 맞고, 같은 commit의 GitHub CI windows job도 success다. 다만 이 세 파일은 체크섬으로 무결성을 입증할 수 없다.
- 권장: 브랜치에서 SHA256SUMS를 다시 만들고, 해시 뒤에 바꾼 내용(있다면)을 REPORT의 가림 절에 적는다. 새 커밋으로 추가하면 되며 force push는 필요 없다.

### I-2 (정보, 기존) 보관 상한의 "최신 행을 남긴다" 순서는 어떤 테스트도 고정하지 않는다

- mutant P3(`DESC`를 `ASC`로)를 옛·새 파일 모두 잡지 못한다. e3220a48과 무관하게 전부터 있던 공백이다. 출시에는 영향이 없다.
- 선택 권장: `:528` 테스트에서 남은 1000개가 최신 `observed_at`인지 단언을 추가한다.

## NOT_RUN과 이유

- Windows 실행: 이 환경에 없다. 총괄의 Windows 로그와 GitHub CI windows job 결과로 대조만 했다.
- 13단계 전체 순서 재실행: 요청 범위(test·lint·diff-check)만 실행했다. 이번 변경은 제품 코드·번들·계약에 영향이 없고, 나머지 단계는 `46859d04` 감사에서 통과했다.
- 실제 host와 설치 확인: 환경이 없다.

## 가림(redaction)

이전과 같은 `redact.py` 규칙을 적용했고 건수는 `meta.json`에 있다. CI job 기록에는 URL(계정 이름 포함)을 옮기지 않고 job 이름, 결론, SHA만 적었다. 가린 뒤 `SHA256SUMS`를 다시 만들었다.

## 산출물

- `audit/REPORT.md`, `audit/meta.json`, `audit/SHA256SUMS`
- `audit/logs/`: 영향 범위 검증, mutant 비교, CI 조회 요약, Windows evidence 체크섬 검증
- `audit/harness/`: `lifecycle-mutants.sh`, `redact.py`, `make-meta.sh`, 옛 테스트 파일 사본(`wake-lifecycle.46859d04.test.mjs`)
