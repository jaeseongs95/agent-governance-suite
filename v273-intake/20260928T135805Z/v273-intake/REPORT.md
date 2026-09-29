# AGS 2.7.3 intake 이식 검증 보고

지시: 총괄 ca8e3dc4. 실행: AGS 클라우드 세션 2. 범위는 1단계(이식, 회귀 테스트, 전체 검증, push)이며, G2 평가는 실행하지 않았다(NOT_RUN).

## 결과

| 항목 | 값 |
| --- | --- |
| base | `main` 8763cef2b11f2635d6c9af7861b5bffd496e2a30 (tree eed08f96…) |
| 원본 | `claude/v273-intake-src` cb59ad7f (계보 53eff30a → 2b53e325 → cb59ad7f) |
| 최종 커밋 | `claude/v273-intake` 732ba286a68b35a7cbd99aefbea12d11b88f1b8c |
| 최종 tree | 06d58b258d467214db08943d30e13d3c3e4ef2fe |
| push | non-force, 8763cef..732ba28, `ls-remote` 일치 |

커밋:

1. c548c77f `refactor: port common skill intake to the 2.7.2 candidate`: 2b53e325를 cherry-pick했다.
2. afafd4e6 `fix(intake): expose shared selection policy to both hosts`: cb59ad7f를 cherry-pick했다.
3. 732ba286 `test(intake): reject common intake copies in the Claude overlay`: 이 세션에서 추가한 회귀 테스트다.

## 충돌 해결

충돌이 없었다. main이 53eff30a 이후 바꾼 파일 중 이식과 겹치는 파일은 `mcp-server/dist/server.mjs`와 `claude-plugin/mcp-server/dist/server.mjs` 두 개뿐이다. git이 두 파일을 자동 병합했다.

- 두 번들 모두 `bundle:check`(소스로 다시 빌드한 결과와 비교)와 `claude:check`를 통과했다.
- 2.7.2 표지(`version: "2.7.2"`, `verifyInputSource`)가 두 번들에 남아 있다.
- `git patch-id --stable` 결과 이식 커밋 두 개가 원본과 같다: 2b53e325 ↔ c548c77f = 812a2f22…, cb59ad7f ↔ afafd4e6 = 202ac276…. 따라서 소스 변경은 원본 그대로 옮겨졌다(`logs/patch-id.log`, `logs/range-diff-vs-source.log`).
- 이식 diff의 파일 집합은 원본 두 커밋과 새 테스트 파일의 합집합에 들어간다. 2.7.2에서 바뀐 소스·테스트·문서는 건드리지 않았다.
- 원본 커밋 메시지에는 출처 줄(`cherry picked from`)과 Co-Authored-By trailer만 더했다. tree는 바꾸지 않았다.

## 테스트와 검증 (최종 커밋, 깨끗한 작업 트리)

| # | 명령 | 결과 |
| --- | --- | --- |
| 01 | `pnpm install --frozen-lockfile` | PASS |
| 02 | `pnpm bundle:check` | PASS |
| 03 | `pnpm claude:drift` | PASS (`claude-plugin: fresh`) |
| 04 | `pnpm lint` | PASS |
| 05 | `pnpm build` | PASS |
| 06 | `pnpm test` | PASS: 테스트 파일 59개 통과·1개 skip, 테스트 814개 통과·1개 skip |
| 07 | `pnpm runtime:check` | PASS (skill CLI 29개, clean-room) |
| 08 | `pnpm validate:all` | PASS |
| 09 | `pnpm validate:official` | FAIL: 환경에 Codex 공식 validator(`~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py`)가 없음(ENOENT). 저장소 결함은 아니지만 검사가 돌지 않았다 |
| 10 | `pnpm claude:build` | PASS |
| 11 | `pnpm claude:check` | PASS |
| 12 | `git diff --check` (작업 트리) | PASS |
| 13 | `git diff --check 8763cef HEAD` | PASS |
| 14 | 검증 후 `git status` | 변경 0줄(빌드가 커밋 산출물을 바꾸지 않음) |
| 15 | `pnpm source:check` | PASS |
| 16 | `pnpm source:verify` | NOT_VERIFIABLE: 원격 `ponytail` 저장소 clone이 인증 요구로 실패했다. 지시에 따르면 이 저장소는 사용자가 의도적으로 삭제했다. 원격 참조가 있는 source는 `ponytail` 하나뿐이고, offline 검사 오류는 없었다 |
| 17 | 패키지 서버 initialize smoke (`scripts/smoke-init.mjs`) | PASS: Codex 루트 배치와 `claude-plugin/` 배치 × default/anthropic profile 네 경우 모두 instructions가 같고(sha256 a410cfd1…) 공통 block을 정확히 한 번 포함한다 |

skip된 테스트 1개는 `tests/session-messaging/previous-broker.test.ts`의 `it.skipIf(!previousBroker)`다. 이전 릴리스 broker가 없으면 건너뛰며, 이번 변경과 관계없다.

`logs/preliminary/`는 새 테스트를 추가하기 전인 cherry-pick 직후 상태의 1차 실행이다. 그 결과는 813개 통과이고 09번만 같은 이유로 FAIL이었다. 실행 도중 테스트 파일을 편집했으므로 이 1차 실행은 참고용이다. 판정에는 `logs/final/`만 쓴다.

### 요구된 회귀 테스트

- 테스트 1(두 profile 모두에서 공통 block 정확 포함): `tests/mcp/tool-schema-profile.test.ts` "advertises the same host-neutral intake instructions to every schema profile"와 "applies the environment profile in the bundled server"가 다룬다(cb59ad7f에서 이식). 17번 smoke가 Claude 생성물 서버까지 넓혀 확인했다.
- 테스트 2(overlay에 정책 원문 중복 없음): 이식된 "keeps the orchestrator selection policy in the shared source…" 테스트에 더해, 이 세션에서 "keeps no copy of the common intake sentences in the Claude overlay or MCP source" 테스트를 추가했다. 이 테스트는 `claude-overlay/`의 모든 파일과 `mcp-server/src/server.ts`에 공통 block 문장(20자 초과)이 나오지 않는지 검사한다. `claude-overlay/README.md`에 문장 하나를 일시적으로 넣자 실패했고, 원복했다.
- 테스트 3(개념 설명·인사·일반 리뷰에서 keyword 추천 없음): `tests/tooling/claude-plugin.test.mjs` "projects the current common intake at session start without keyword selection"이 다룬다. rebase/merge 개념 질문, 인사, change.diff 리뷰를 UserPromptSubmit으로 넣고 `git merge`를 Bash PreToolUse로 넣으면 모두 출력이 없다. MCP 서버에는 keyword 경로가 없다.

## G2 fixture·harness 확인

`claude/evidence-port272-nl-ab-20260928T073317Z`(7b7f49acb4e93bdd06ee77f7792140e839c4a9a9)의 `port272-nl-ab/scripts/` 아래에서 확인했다. G2-input.json에 동결된 prompt 11개, fixture 7개, harness 8개가 모두 경로·byte 수·sha256까지 일치한다. 같은 디렉터리의 `collect.sh`, `driver.sh`는 G2-input의 harness 목록에 없다. 초안은 `G2-input.draft.json`이다.

## 가린 값

다음 값을 `[REDACTED]`로 바꾼 뒤 SHA256SUMS를 만들었다.

- 이메일 주소: `logs/range-diff-vs-source.log`의 commit trailer 두 곳.
- 계정 이름: `logs/final/16-source-verify.stderr.log`의 GitHub URL 소유자 한 곳.
- 계정 이름이 들어간 컨테이너 홈 경로 두 종류(root 계정 홈, user 계정 홈): `logs/{final,preliminary}/`의 `06-test.stdout.log`, `08-validate-all.stdout.log`, `09-validate-official.stderr.log`.

IP와 지시에 명시된 토큰 패턴 7종은 발견되지 않았다. `env`·`printenv` 출력은 남기지 않았다.

## 남은 위험

- 자연어 요청의 실제 스킬 사용이 회복됐는지는 NOT_RUN이다. G에서 본 11/27 → 0/27 회귀가 cb59ad7f로 되돌아왔는지는 G2 평가로만 판정할 수 있다.
- MCP 서버는 모듈 로드 때 `skills/orchestrator/SKILL.md`를 읽는다. 파일이 없거나 marker가 깨지면 서버가 시작하지 않는다(fail-closed). 설치물은 `skills/`를 함께 배포하고 runtime clean-room과 Claude 생성물 smoke로 확인했지만, 실제 설치 캐시에서는 확인하지 않았다.
- SessionStart hook만 공통 block을 투영하므로, 세션 중간에 SKILL.md를 바꾸면 다음 SessionStart(startup/resume/clear/compact) 전까지 반영되지 않는다.
- `validate:official`은 이 환경에서 돌지 않았다. Codex validator가 있는 환경에서 다시 실행해야 한다.
- 이 결과는 Linux cloud 한 환경의 결과다. Windows CI 조합과 실제 marketplace 설치·설치 캐시·MCP 동작 검증은 하지 않았다.
