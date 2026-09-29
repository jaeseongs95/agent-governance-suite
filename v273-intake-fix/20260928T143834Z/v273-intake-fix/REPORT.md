# AGS 2.7.3 intake 감사 후속 수정 보고

지시: 총괄 ca8e3dc4. 감사 evidence `claude/evidence-v273-intake-audit-20260928T141218Z`의 F-1, F-2, F-3을 고쳤다. 코드 동작은 바꾸지 않았고 문서와 테스트 검사 범위만 바꿨다. F-4, F-5는 범위 밖이다.

| 대상 | 값 |
| --- | --- |
| 수정 전 후보 | 732ba286a68b35a7cbd99aefbea12d11b88f1b8c |
| 수정 후 후보 (`claude/v273-intake`) | 9c8c6f6a62204bc99fc3ab49df1688ddb023e01d (tree fdb4640f13a1cec6e9cae66ee8359d0c29714f24) |
| 환경 | Linux cloud 컨테이너, Node.js v24.21.0, pnpm 11.19.0 |

## 변경

- F-1: `README.md:66`, `README.en.md:66`. keyword 추천과 이전 Codex 동작 서술을 "두 호스트 모두 MCP 서버 초기화 안내로 `skills/orchestrator/SKILL.md`의 공통 접수 기준을 받고, Claude Code는 SessionStart에서 같은 원문을 함께 받는다"로 바꿨다. 직접 지정 문장은 그대로 뒀다.
- F-2: `claude-overlay/README.md:17`, `:18`, `:73`과 `pnpm claude:build`로 다시 만든 `claude-plugin/README.md`의 같은 줄.
  - 17행: profile과 관계없이 공통 block을 `instructions`로 내보내고 Codex 서버도 같다고 적었다. 서버가 원문을 시작 때 읽고, 읽지 못하면 시작하지 않는다는 점도 적었다.
  - 18행: adaptation이 공통 block 뒤, navigation 앞에 "Claude Code에서의 호출과 관측" 절을 넣는다고 적었다.
  - 73행: `skill-trigger-hook.mjs`는 SessionStart에서 공통 원문만 투영하고 호출 방식 한 줄을 덧붙이며, UserPromptSubmit·PreToolUse에는 등록하지 않는다고 적었다.
  - 공통 intake 문장은 옮겨 적지 않았다(새 복사 검사 통과).
- F-3:
  - `tests/tooling/claude-plugin.test.mjs:132`: `git ls-files -z`의 추적 파일 전체를 검사한다. 허용 목록은 `skills/orchestrator/SKILL.md`, `claude-plugin/skills/orchestrator/SKILL.md`, 이 테스트 파일의 fixture(`tests/tooling/claude-plugin.test.mjs`) 셋이다(`:138`).
  - `tests/mcp/tool-schema-profile.test.ts:201`: 서버 안내에서 intake block을 뺀 나머지에 공통 문장이 하나도 없는지 문장 단위로 확인한다.

## mutant 결과

새 테스트를 적용한 작업 트리에서 감사 `scripts/mutations.sh`와 같은 편집을 하나씩 적용하고, 같은 vitest 3개 파일을 실행한 뒤 `git checkout`으로 되돌렸다. 로그는 `logs/mutation/`에 있다.

| mutant | 감사 때 | 이번 | 걸린 테스트 |
| --- | --- | --- | --- |
| M1d `server.ts` 안내 앞머리에 문장 복사 | KILLED(복사 검사만) | KILLED | 추적 파일 복사 검사, 서버 안내 문장 단위 검사(메시지에 해당 문장), bundled server 검사 |
| M1e Codex `hooks/hooks.json`에 문장 복사 | 살아남음 | KILLED | 추적 파일 복사 검사 |
| M1f `mcp-server/src/plugin-info.ts`에 문장 복사 | 살아남음 | KILLED | 추적 파일 복사 검사 |
| 복구 뒤 | — | 통과 (3 files, 30 tests) | — |

## 검증

명령별 stdout, stderr, 종료 코드는 `logs/full/`에 있다.

| # | 명령 | 종료 코드 | 결과 |
| --- | --- | --- | --- |
| 01 | `pnpm install --frozen-lockfile` | 0 | PASS |
| 02 | `pnpm bundle:check` | 0 | PASS |
| 03 | `pnpm claude:drift` | 0 | PASS (`claude-plugin: fresh`) |
| 04 | `pnpm lint` | 0 | PASS |
| 05 | `pnpm build` | 0 | PASS |
| 06 | `pnpm test` | 0 | PASS: 파일 59 통과·1 skip, 테스트 814 통과·1 skip |
| 07 | `pnpm runtime:check` | 0 | PASS |
| 08 | `pnpm validate:all` | 0 | PASS |
| 09 | `pnpm validate:official` | 1 | FAIL_UNRELATED(환경): Codex validator `validate_plugin.py`가 컨테이너에 없음(ENOENT) |
| 10 | `pnpm claude:build` | 0 | PASS |
| 11 | `pnpm claude:check` | 0 | PASS |
| 12 | `git diff --check` | 0 | PASS |
| 13 | `pnpm source:check` | 0 | PASS |
| 14 | `pnpm source:verify` | 1 | NOT_VERIFIABLE: 삭제된 `ponytail` 원격 저장소 clone이 인증 요구로 실패. 결함 아님 |

검증 뒤 작업 트리 변경은 커밋 대상 6개 파일뿐이었고, 생성물은 `claude-plugin: fresh`였다.

## NOT_RUN

- `validate:official`의 실제 검사: validator가 없어 돌지 않았다.
- `source:verify`의 `ponytail` 원격 확인: 저장소가 삭제됐다.
- Windows × Node.js 24: Linux 한 환경만 실행했다.
- mutant별 `claude:check`, `lint`: 이번에는 vitest만 실행했다(감사 때 이 mutant들은 lint를 통과했고, 확인 대상은 새 테스트였다).
- 설치 캐시·marketplace·실제 호스트 동작, G2 평가: 범위 밖이다.

## 가린 값

토큰 패턴(`ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `AKIA`, PRIVATE KEY 줄, Authorization Bearer), 이메일 주소, IPv4 주소는 발견되지 않았다. `env`·`printenv` 출력은 남기지 않았다. 다음을 바꾼 뒤 `SHA256SUMS`를 만들었다.

| 대상 | 치환 | 파일 수 | 횟수 |
| --- | --- | --- | --- |
| 사용자 이름이 들어간 컨테이너 홈 경로 | `[REDACTED-HOME]` | 7 | 7 |
| root 계정 홈 경로 | `[REDACTED-HOME]` | 1 | 2 |
| GitHub 계정 이름(URL 소유자) | `[REDACTED-ACCOUNT]` | 2 | 3 |
