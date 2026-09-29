# AGS 2.7.3 intake 재감사 보고

지시: 총괄 ca8e3dc4. 감사자는 구현 세션과 분리된 세션이며, 제품 소스를 고치지 않았다(읽기 전용). 범위는 이전 감사 대상 732ba286 이후 바뀐 커밋 두 개다. 이전 감사 evidence는 `claude/evidence-v273-intake-audit-20260928T141218Z`(57036eaf)에 있다.

## 최종 판정: ACCEPT_WITH_FINDINGS

이전 major F-1, F-2와 minor F-3은 해소됐다. 새 intake 문장은 벤더 중립이며, 기존 제외 규칙이나 출력 금지 문장과 모순되지 않는다. 문장을 지우거나 한 줄 바꾸는 mutant는 revision 고정 테스트가 모두 잡았다. mutant 19개가 모두 KILLED였다. 남은 것은 minor뿐이다. 이전 F-4, F-5는 판정만 유지하고, 새 minor R-1을 하나 추가한다.

| 대상 | SHA |
| --- | --- |
| 새 후보 (`claude/v273-intake`) | 33dfdc02508ff13d5a2763f0fa318cd81e2971a7 (tree d25c6caf31046c2c12b283d590ed5191431e9490, 확인함) |
| 이전 감사 대상 | 732ba286a68b35a7cbd99aefbea12d11b88f1b8c |
| 커밋 | 9c8c6f6a (docs와 복사 검사 확대), 33dfdc02 (선택 시점 규칙) |
| 기준 | main 8763cef2b11f2635d6c9af7861b5bffd496e2a30 |

환경: Linux cloud 컨테이너 하나, Node.js v24.21.0(`/opt/node24`), pnpm 11.19.0. 이전과 같은 worktree 두 개를 새 SHA로 detached checkout해 사용했다.

## 항목별 결과

| # | 항목 | 결과 | 근거 |
| --- | --- | --- | --- |
| 0 | 변경 범위와 2.7.2 보존 | PASS | `logs/checks/delta.log` |
| 1 | F-1, F-2 해소 | PASS | `README.md:66`, `README.en.md:66`, `claude-overlay/README.md:17-18,73`, 생성된 `claude-plugin/README.md` |
| 2 | F-3 해소와 mutant 재실행 | PASS (19/19 KILLED) | `logs/mutation/summary.log`, `logs/checks/copy-guard-coverage.log` |
| 3 | 33dfdc02 intake 문장 | PASS (minor R-1) | `skills/orchestrator/SKILL.md:16,19`, `logs/checks/intake-neutrality.log` |
| 4 | init-smoke 9경우 | PASS | `logs/checks/init-smoke.log` |
| 5 | 전체 검증과 생성물 byte 비교 | PASS, 예외 2건(환경 사유) | `logs/full/*`, `logs/checks/generated-byte-compare.log` |
| 6 | 이전 F-4, F-5 | 판정 유지(minor, 미해결) | 다시 다루지 않음 |

### 0. 변경 범위와 2.7.2 보존: PASS

- 732ba286..33dfdc02는 파일 10개를 바꿨다: README 두 개, overlay와 plugin README, 원본과 생성된 orchestrator `SKILL.md`, revision 고정 스크립트, 테스트 3개.
- MCP 소스와 두 dist 번들은 732ba286과 같다. 두 번들의 `"2.7.2"`(1회)와 `verifyInputSource`(3회)도 그대로이고, sha256은 `6bbf349e…`다.
- wake, broker, session-message, plugin-info, version 관련 파일은 이번 범위에 없다.
- 2.7.2 쪽 변경과 겹치는 파일은 `README.md`, `README.en.md`뿐이다. 기준 대비 두 README의 차이는 66행 hunk 하나이므로, 2.7.2의 README 변경은 보존됐다.

### 1. F-1, F-2 해소: PASS

- 루트 `README.md:66`과 `README.en.md:66`: 두 호스트 모두 MCP `instructions`로 공통 접수 기준을 받고, Claude Code는 SessionStart에서 같은 원문을 함께 받는다고 적었다. 실제 동작(4절 init-smoke, 이전 감사의 hook 재현)과 맞다. 원문 링크 `skills/orchestrator/SKILL.md`도 해석된다.
- `claude-overlay/README.md`의 세 항목은 이제 현재 동작과 맞는다.
  - 17행: profile과 관계없이 같은 `instructions`를 내보내고, Codex도 받으며, 원문을 읽지 못하면 서버가 시작하지 않는다. 마지막 내용은 이전 감사의 fail-closed 재현과 같다.
  - 18행: "호출과 관측" 절이 공통 block 뒤, navigation 앞에 들어간다.
  - 73행: SessionStart에서 원문만 투영하고, UserPromptSubmit·PreToolUse에는 등록하지 않는다.
- 생성된 `claude-plugin/README.md`에도 같은 내용이 반영됐다(5절 byte 비교 일치).
- 옛 설명("추천", "선택 결정", "접수 규칙", keyword hook)이 README 두 개, overlay README, `docs/architecture.md`에 남아 있지 않다. 과거 release notes에만 남아 있으며 이는 역사 기록이다.
- 공통 문장을 옮겨 적지 않았다. 문장 21개 전체 일치는 공통 원본, 생성된 사본, 테스트 fixture 세 곳에만 있다(`intake-copy-scan.log`).
- 변경 파일 10개의 상대 링크와 anchor는 모두 해석되고(`link-check.log`, broken=0), 외부 스킬 저장소 링크는 없다.

### 2. F-3 해소와 mutant 재실행: PASS

- 복사 검사 테스트(`tests/tooling/claude-plugin.test.mjs:132-147`)는 이제 `git ls-files` 전체를 본다. 허용 목록은 `skills/orchestrator/SKILL.md`, `claude-plugin/skills/orchestrator/SKILL.md`, `tests/tooling/claude-plugin.test.mjs` 세 파일뿐이다(`:138`).
- 검사 범위를 따로 확인했다.
  - 추적 파일 1192개 가운데 읽지 못하는 파일은 0개이고, symlink와 submodule도 없다. 따라서 읽기 실패를 조용히 넘기는 `.catch(() => "")`가 빠뜨리는 파일은 현재 없다.
  - intake 문장 21개가 모두 20자를 넘으므로 전부 검사 대상이다(`copy-guard-coverage.log`).
- `tests/mcp/tool-schema-profile.test.ts:201-205`가 추가됐다. 서버 안내에서 공통 block 바깥 부분에 공통 문장이 다시 나오면 실패한다. 이전 감사에서 이 테스트로는 잡히지 않던 M1d를 이제 이 테스트도 잡는다.

이전 mutant 13개에 M1g와 M4a–M4e를 더해 모두 다시 실행했다(`scripts/mutations.sh`). 끝난 뒤 worktree 변경은 0줄이었다.

| mutant | 결과 | 걸린 검사 |
| --- | --- | --- |
| M0 대조군 | 모두 통과 | — |
| M1a overlay README 복사 | KILLED | keeps no copy… in any tracked file |
| M1b adaptation 복사 | KILLED | 위 테스트 |
| M1c overlay hook 복사 | KILLED | 위 테스트, projects the current common intake… |
| M1d `server.ts` 복사 | KILLED | 위 테스트, advertises the same host-neutral intake…, claude:check |
| M1e Codex `hooks/hooks.json` 복사 | KILLED (이전: 살아남음) | keeps no copy… |
| M1f `plugin-info.ts` 복사 | KILLED (이전: 살아남음) | keeps no copy… |
| M1g `docs/architecture.md` 복사 (신규) | KILLED | keeps no copy… |
| M2a default profile에서 intake 제거 | KILLED | advertises…, claude:check |
| M2b anthropic profile에서 intake 제거 | KILLED | advertises…, bundled server…, claude:check |
| M2c Claude hook에서 intake 제거 | KILLED | projects… |
| M3a 공통 문장 변경(재생성) | KILLED | pins the intake revision…, preserves the reviewed… |
| M3b 생성물 문장만 변경 | KILLED | keeps the orchestrator selection policy…, claude:check |
| M3c overlay에 정책 문장 추가 | KILLED | keeps the orchestrator selection policy… |
| M4a 시점 규칙("첫 도구 호출 전") 삭제 (신규) | KILLED | pins the intake revision…, preserves… |
| M4b 시점 규칙 문구 변경("첫 파일 수정 전") (신규) | KILLED | 위 두 테스트 |
| M4c "상태 확인보다 먼저 … 호출" 문장 삭제 (신규) | KILLED | 위 두 테스트 |
| M4d 생성물의 시점 규칙만 변경 (신규) | KILLED | keeps the orchestrator selection policy…, claude:check |
| M4e "·태그" 제거 (신규) | KILLED | pins the intake revision…, preserves… |

원본 문장 변경(M3a, M4a–c, M4e)을 막는 것은 여전히 `pnpm test`의 revision 고정 테스트뿐이다. `lint`와 `claude:check`는 통과한다. 이것은 설계대로이며 finding이 아니다.

### 3. 33dfdc02 intake 문장: PASS (minor R-1)

바뀐 내용:
- `SKILL.md:16`에 "선택 결과를 출력하지 않아도 선택은 상태 확인·읽기를 포함한 첫 도구 호출 전에 끝낸다."를 추가했다.
- `SKILL.md:19`에서는 다음을 바꿨다.
  - "커밋·병합·push처럼 … 단계에서는"을 "커밋·병합·push·태그처럼 … 요청에는"으로 바꿨다.
  - "위험한 실제 변경 직전에는"을 "위험한 실제 변경 전에는"으로 바꿨다.
  - "목표가 실제 변경인 요청은 상태 확인보다 먼저 해당 전문 스킬이나 `orchestrator`를 실제 호출한다."를 추가했다.

판정:
- **벤더 중립: PASS.** intake block(2528 byte)에 제품명(Claude, Codex, Anthropic, OpenAI, Grok, Spark, GPT), 호스트 도구와 이벤트 이름(Skill 도구, Bash, Read, SessionStart, UserPromptSubmit, `mcp__`, `plan_workflow` 등), 호출 문법(`/agent-governance-suite:`, `$skill`)이 없다. "도구 호출"과 "상태 확인"은 일반 개념이다(`intake-neutrality.log`).
- **제외 규칙 약화 없음: PASS.** 설명·인사·일반 질문(22행), 읽기 전용 일반 리뷰·감사·검증(18행), 개념 설명·명령 이력 조회(19행) 제외 문장은 글자 그대로 남았다. 새 시점 규칙은 선택을 언제 끝낼지만 정하고, 무엇을 선택할지는 바꾸지 않는다. 그래서 읽기 전용 요청에서 결론이 "스킬 없음"이면 그대로 성립한다. 새 호출 문장은 "목표가 실제 변경인 요청"에만 적용된다.
- **출력 금지와 모순 없음: PASS.** "선택 결과를 출력하지 않아도"는 22행의 "실패 영향 분류나 생략 이유를 출력하지 않는다"와 같은 방향이다. 새 문장은 출력 없이 선택 시점만 앞당긴다.
- **G2 case 과적합 없음: PASS.** G2 prompt 식별자, 공개 저장소·main·origin·버전 문자열 같은 case 문구가 없다. "태그"는 push와 같은 반영 행동의 일반 범주이고, "공개 push·태그·배포" 예시는 20행에 이미 있었다. "상태 확인"은 p7 실패 양상(상태 확인이 먼저 나옴)에서 온 표현이지만, 특정 명령이나 문장을 적지 않은 일반 규칙이다.
- **mutant 탐지: PASS.** 2절의 M4a–M4e와 같다.

### 4. init-smoke 9경우: PASS

서버 배치 세 가지(Codex 루트 dist, 저장소 안 `claude-plugin`, 떼어 낸 `claude-plugin` 사본)와 profile 세 가지(default, anthropic, 미설정)를 곱한 9경우 모두 결과가 같았다. 공통 block은 1회, instructions sha256은 `474cdcdb93a2…`, 크기는 3548 byte, 도구는 28개였고, 제품명 표현은 없었다. intake block의 sha256은 `f40bce91…`이다.

### 5. 전체 검증과 생성물 일치

지난번과 같은 순서로 실행했다(`logs/full/`).

| # | 명령 | 종료 코드 | 결과 |
| --- | --- | --- | --- |
| 01 | `pnpm install --frozen-lockfile` | 0 | PASS |
| 02 | `pnpm bundle:check` | 0 | PASS |
| 03 | `pnpm claude:drift` | 0 | PASS (`fresh`) |
| 04 | `pnpm lint` | 0 | PASS |
| 05 | `pnpm build` | 0 | PASS |
| 06 | `pnpm test` | 0 | PASS: 파일 59개 통과·1개 skip, 테스트 814개 통과·1개 skip |
| 07 | `pnpm runtime:check` | 0 | PASS (skill CLI 29개) |
| 08 | `pnpm validate:all` | 0 | PASS |
| 09 | `pnpm validate:official` | 1 | FAIL_UNRELATED(환경): Codex validator가 없음(ENOENT). NOT_RUN 성격이다 |
| 10 | `pnpm claude:build` | 0 | PASS |
| 11 | `pnpm claude:check` | 0 | PASS (`fresh`) |
| 12 | `git diff --check` | 0 | PASS |
| 12b | `git diff --check 8763cef HEAD` | 0 | PASS |
| 13 | `pnpm source:check` | 0 | PASS |
| 14 | `pnpm source:verify` | 1 | NOT_VERIFIABLE: 삭제된 `ponytail` 원격 저장소가 인증을 요구했다. 결함이 아니다 |
| 15 | 검증 뒤 `git status` | — | 변경 0줄 |

생성물 byte 비교: `git archive 33dfdc02`로 푼 tree(`d25c6caf…` 일치)에서 `claude-plugin/`을 옆으로 옮기고 다시 만들었다. 파일 404개가 `diff -r`로 byte 단위로 같았다. `mcp-server/dist`와 `claude-plugin/mcp-server/dist`의 파일 9개도 모두 같고, `server.mjs`의 sha256은 `6bbf349e…`다.

## Findings

### 이전 finding 처리

| ID | 이전 심각도 | 상태 |
| --- | --- | --- |
| F-1 루트 README 불일치 | major | RESOLVED (9c8c6f6a) |
| F-2 overlay/plugin README 불일치 | major | RESOLVED (9c8c6f6a) |
| F-3 복사 방지 검사 범위 | minor | RESOLVED (9c8c6f6a, M1d–M1g KILLED) |
| F-4 Claude 세션 이중 투영 | minor | 판정 유지(미해결). README가 이중 수신을 이제 명시하지만, 의도한 fallback인지는 적혀 있지 않다 |
| F-5 구현 보고서 서술 | minor | 판정 유지(미해결) |

### R-1 (minor) 공통 문장에서 `mutation-risk-preflight` 시점이 "직전"에서 "전"으로 느슨해졌다

- 위치: `skills/orchestrator/SKILL.md:19`. 732ba286에는 "위험한 실제 변경 직전에는"이었다.
- 내용: 스킬 본문 `skills/mutation-risk-preflight/SKILL.md:11`은 여전히 "실제 상태 변경 직전에 계획된 행동과 대상을 고정"한다고 적는다. 그래서 스킬을 로드하면 시점이 회복되므로 모순은 아니다. 하지만 같은 줄에 추가된 "상태 확인보다 먼저 … 실제 호출한다"와 함께 읽으면, 사전 점검을 앞에서 받아 두고 그 뒤 다른 단계를 거쳐 변경하는 해석이 공통 문장만으로는 막히지 않는다. 호출 시점(먼저)과 판정 신선도(직전)가 한 단어로 섞였다.
- 재현: `git diff 732ba286 33dfdc02 -- skills/orchestrator/SKILL.md`를 보고, `skills/mutation-risk-preflight/SKILL.md:11`과 대조한다.
- 권장: 호출은 먼저 하되 `READY` 판정은 실제 변경 직전 상태로 받는다는 뜻이 드러나게 "직전"을 되살린다. 예: "…위험한 실제 변경 직전에는 `mutation-risk-preflight`의 판정을 받는다." 문장을 바꾸면 revision hash와 G2 재측정도 함께 갱신해야 하므로, 이번 G2 결과와 묶어 판단한다.

### 관찰 (finding 아님)

- esbuild 번들은 한글을 `\uXXXX`로 escape한다. 그래서 복사 검사는 dist 번들 안의 복사를 직접 보지 못한다. 번들은 `bundle:check`로 소스와 묶여 있고 소스는 검사 대상이므로 현재 경로로는 우회되지 않는다.
- "목표가 실제 변경인 요청"에 코드 편집 요청도 들어가는지는 문장만으로 분명하지 않다. 들어간다고 읽어도 18행의 `ponytail` "먼저 실제 호출"과 방향이 같아 모순은 없다.

## NOT_RUN

- `validate:official`: 컨테이너에 Codex validator가 없다(FAIL_UNRELATED, 환경).
- `source:verify`의 `ponytail` 원격 확인: NOT_VERIFIABLE(저장소 삭제).
- Windows 조합, 실제 marketplace 설치, 설치 캐시, 설치된 호스트의 MCP 동작: 이 감사는 Linux cloud 한 환경의 결과라 범위 밖이다.
- G2 재측정(33dfdc02가 p7 등의 스킬 사용을 회복했는지): 별도 세션 범위라 이 감사에서 판정하지 않는다.
- 구현 세션의 새 evidence 두 개(`…-fix-20260928T143834Z`, `…-reinforce-20260928T150116Z`) 보고서 대조: 지시에 따라 F-5 판정만 유지하고 다시 다루지 않았다.

## 가린 값

push 전에 스캔했다. 토큰 패턴(`ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `AKIA`, PRIVATE KEY 줄, Authorization Bearer), 이메일 주소, IP는 발견되지 않았다. 치환 결과는 아래 표와 같으며, 치환한 뒤 `SHA256SUMS`를 만들었다. `env`·`printenv` 출력은 남기지 않았다.

| 대상 | 치환 | 파일 수 | 횟수 |
| --- | --- | --- | --- |
| 사용자 이름이 들어간 컨테이너 홈 경로(user 계정 홈) | `[REDACTED-HOME]` | 22 | 22 |
| root 계정 홈 경로 | `[REDACTED-HOME]` | 1 | 2 |
| GitHub 계정 이름(URL 소유자) | `[REDACTED-ACCOUNT]` | 2 | 3 |

## 파일

- `REPORT.md`, `meta.json`, `SHA256SUMS`
- `scripts/`: `run-full.sh`, `mutations.sh`(M1g와 M4a–M4e 추가), `intake-copy-scan.mjs`, `init-smoke.mjs`, `link-check.mjs`
- `logs/full/`, `logs/mutation/`, `logs/checks/`
