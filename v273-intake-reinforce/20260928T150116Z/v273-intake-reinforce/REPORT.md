# AGS 2.7.3 공통 intake 선택 시점 보강 보고

지시: 총괄 ca8e3dc4. 근거는 G2 evidence `claude/evidence-v273-g2-20260928T142619Z`의 `g2/REPORT.md`다. 판정은 NOT_RECOVERED였다. p7에서 base는 3/3 orchestrator를 먼저 호출했고, candidate는 0/3으로 스킬 없이 상태 확인 git 명령부터 실행했다. G2의 prompt와 fixture 문구는 intake에 넣지 않았다.

| 대상 | 값 |
| --- | --- |
| 이전 후보 | 9c8c6f6a62204bc99fc3ab49df1688ddb023e01d |
| 새 후보 (`claude/v273-intake`) | 33dfdc02508ff13d5a2763f0fa318cd81e2971a7 (tree d25c6caf31046c2c12b283d590ed5191431e9490) |
| 환경 | Linux cloud 컨테이너, Node.js v24.21.0, pnpm 11.19.0 |

## 바꾼 intake 문장 (`skills/orchestrator/SKILL.md`, 전체 diff는 `intake.diff`)

| 위치 | 전 | 후 |
| --- | --- | --- |
| 도입 문단 (추가) | — | 선택 결과를 출력하지 않아도 선택은 상태 확인·읽기를 포함한 첫 도구 호출 전에 끝낸다. |
| 둘째 항목 1문장 | 커밋·병합·push처럼 실제 변경을 반영하는 단계에서는 `change-scope-guardian`의 범위 확인을 적용한다. | 커밋·병합·push·태그처럼 실제 변경을 반영하는 요청에는 `change-scope-guardian`의 범위 확인을 적용한다. |
| 둘째 항목 2문장 | … 위험한 실제 변경 직전에는 `mutation-risk-preflight`를 적용한다. | … 위험한 실제 변경 전에는 `mutation-risk-preflight`를 적용한다. |
| 둘째 항목 (추가) | — | 목표가 실제 변경인 요청은 상태 확인보다 먼저 해당 전문 스킬이나 `orchestrator`를 실제 호출한다. |

- 새 문장은 두 개다. 스킬 하나로 충분한지, 여러 gate를 이어야 하는지는 기존 셋째 항목이 정한다.
- 출력 금지 문장("모든 요청에 실패 영향 분류나 생략 이유를 출력하지 않는다.")은 그대로 뒀다. 새 도입 문장은 출력 없이도 선택 시점을 지키라고 적어 두 문장이 모순되지 않는다.
- 설명·인사·일반 질문, 읽기 전용 리뷰, 개념 설명에 대한 제외 문장은 바꾸지 않았다. `ponytail`의 "수정 단계에서 적용" 예외(테스트 실행 뒤 수정)도 그대로다.
- 제품명, 도구 이름, 호출 문법은 넣지 않았다(`tool-schema-profile` 호스트 중립 검사 통과).

## 함께 바꾼 고정값

- `scripts/check-skill-context-optimization.mjs`: revision `2.7.3-intake-selection-timing`, reconstructed sha256 `12744ae24122ce513b09152f3e4884b63883c7d15e808fa7b2b6c19c27be3af9`. frontmatter와 mcp-execution hash, 초기 로드 한도 4585 byte는 그대로다. orchestrator `SKILL.md`는 4583 byte다.
- `tests/tooling/skill-context-optimization.test.mjs`: candidateBytes 45598 → 45851, reducedBytes 70081 → 69828, reductionPercent 60.582301 → 60.363592.
- `claude-plugin/skills/orchestrator/SKILL.md`: `pnpm claude:build`로 다시 만들었다. `pnpm build`로 다시 만든 서버 번들은 바뀌지 않았다(서버는 원문을 실행 중에 읽는다).

## 서버 instructions

`logs/checks/init-smoke.log`에 있다. 감사 스크립트 `init-smoke.mjs`를 다시 실행했다. 대상은 서버 배치 3가지(Codex 루트, 저장소 안 claude-plugin, 떼어 낸 claude-plugin 사본)와 profile 3가지(default, anthropic, 미설정)를 곱한 9경우다.

- 9경우 모두 결과가 같았다. sha256 `474cdcdb93a26a3bed0c58cc03313b3b47e7c19c654702476cb202efc43a0b75`, 3548 byte, intake 1회, 도구 28개, 제품명 없음.
- 이전 값은 `a410cfd1…`, 3295 byte다.
- intake block sha256은 `f40bce9199375b13d3ad1f4307f88603e574c726eeb9e548218fabba68600d36`다.

## 검증

명령별 stdout, stderr와 종료 코드는 `logs/full/`에 있다.

| # | 명령 | 종료 코드 | 결과 |
| --- | --- | --- | --- |
| 01 | `pnpm install --frozen-lockfile` | 0 | PASS |
| 02 | `pnpm bundle:check` | 0 | PASS |
| 03 | `pnpm claude:drift` | 0 | PASS (`claude-plugin: fresh`) |
| 04 | `pnpm lint` | 0 | PASS |
| 05 | `pnpm build` | 0 | PASS |
| 06 | `pnpm test` | 0 | PASS: 파일 59 통과·1 skip, 테스트 814 통과·1 skip. 복사 방지 테스트도 통과 |
| 07 | `pnpm runtime:check` | 0 | PASS |
| 08 | `pnpm validate:all` | 0 | PASS |
| 09 | `pnpm validate:official` | 1 | FAIL_UNRELATED(환경): Codex validator `validate_plugin.py` 없음(ENOENT) |
| 10 | `pnpm claude:build` | 0 | PASS |
| 11 | `pnpm claude:check` | 0 | PASS |
| 12 | `git diff --check` | 0 | PASS |
| 13 | `pnpm source:check` | 0 | PASS |
| 14 | `pnpm source:verify` | 1 | NOT_VERIFIABLE: 삭제된 `ponytail` 원격 저장소 clone 인증 실패. 결함 아님 |

## NOT_RUN과 한계

- 이 변경이 G2 p7을 회복시키는지는 측정하지 않았다. G2 재측정이 필요하다.
- `validate:official`의 실제 검사와 `ponytail` 원격 확인은 위 이유로 돌지 않았다.
- Windows × Node.js 24, 설치 캐시와 실제 호스트 동작은 확인하지 않았다.

## 가린 값

토큰 패턴(`ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `AKIA`, PRIVATE KEY 줄, Authorization Bearer), 이메일 주소, IPv4 주소는 발견되지 않았다. `env`·`printenv` 출력은 남기지 않았다. 다음을 바꾼 뒤 `SHA256SUMS`를 만들었다.

| 대상 | 치환 | 파일 수 | 횟수 |
| --- | --- | --- | --- |
| 사용자 이름이 들어간 컨테이너 홈 경로 | `[REDACTED-HOME]` | 3 | 3 |
| root 계정 홈 경로 | `[REDACTED-HOME]` | 1 | 2 |
| GitHub 계정 이름(URL 소유자) | `[REDACTED-ACCOUNT]` | 1 | 1 |
