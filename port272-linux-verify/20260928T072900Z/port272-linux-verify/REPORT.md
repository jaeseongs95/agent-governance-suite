# port272-linux-verify — 스킬 intake 이식 후보 2b53e325 Linux 검증

- 대상: `2b53e325f549a9ebd32a143d1d11f7b4393355fa` (branch `codex/v272-skill-intake-port`), tree `851c82604427f8d0bb01ed15167909eee643f566` — 확인 일치(03 로그)
- 기준: `53eff30a2984d41fc749d38dd2062966017684fa`
- 환경: Linux cloud 컨테이너 1개, Node v24.21.0(SHASUMS256 검증 tarball), pnpm 11.19.0. **사용자 PC의 실제 Codex/Claude 설치나 live 동작을 증명하지 않는다.**
- 소스·테스트·설정은 고치지 않았다. 변조 실험은 `/tmp/ck/<case>` 분리 worktree에서만 했고 끝난 뒤 제거했다. 원 checkout(`d5c5932`)과 `/tmp/cand`는 끝까지 clean(26 로그).

## 1. 명령별 exit (AGENTS.md 순서)

| # | 명령 | exit | 판정 | 로그 |
|---|---|---|---|---|
| 01 | git fetch origin codex/v272-skill-intake-port codex/v2711-codex-empty-wake | 0 | PASS | 01-fetch.log |
| 02 | Node 24 tarball 다운로드 + sha256 검증 | 0 | PASS | 02-node24.log |
| 03 | git worktree add /tmp/cand 2b53e325 (tree 확인) | 0 | PASS | 03-worktree-cand.log |
| 04 | pnpm install --frozen-lockfile | 0 | PASS | 04-install.log |
| 05 | pnpm bundle:check | 0 | PASS | 05-bundle-check.log |
| 06 | pnpm claude:drift (`claude-plugin: fresh`) | 0 | PASS | 06-claude-drift.log |
| 07 | pnpm claude:check (`claude-plugin: fresh`) | 0 | PASS | 07-claude-check.log |
| 08 | pnpm lint | 0 | PASS | 08-lint.log |
| 09 | pnpm build | 0 | PASS | 09-build.log |
| 10 | build 뒤 `git status --porcelain` (출력 없음 = clean) | 0 | PASS | 10-post-build-status.log |
| 11 | pnpm test 1회차(`--` 인자 전달로 JSON 미생성) | 0 | PASS(참고) | 11-test-run1.log |
| 12 | pnpm test 2회차(`--` 인자 전달로 JSON 미생성) | 0 | PASS(참고) | 12-test-run2.log |
| 13 | pnpm test 1회차 JSON | 0 | PASS | 13-test-run1-json.log, 13-test-run1.json |
| 14 | pnpm test 2회차 JSON | 0 | PASS | 14-test-run2-json.log, 14-test-run2.json |
| 15 | pnpm runtime:check (`29 skill CLIs, Node.js 24.21.0`) | 0 | PASS | 15-runtime-check.log |
| 16 | pnpm validate:all | 0 | PASS | 16-validate-all.log |
| 17 | pnpm validate:official | 1 | **NOT_RUN** | 17-validate-official.log |
| 18 | git diff --check | 0 | PASS | 18-diff-check.log |

- 17 NOT_RUN 이유: `ENOENT /root/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py` — 이 컨테이너에는 Codex 시스템 스킬(공식 validator)이 없다. 환경 부재이며 제품 FAIL로 세지 않는다. 공식 validator 판정은 관측하지 못했다.
- 11/12는 `pnpm test -- --reporter…` 형태로 `--`가 vitest에 그대로 넘어가 JSON 파일이 생성되지 않았다. 같은 725개 테스트가 돌았고 exit 0이다. JSON이 필요한 2회 실행은 13/14로 다시 했다(결과적으로 전체 테스트 4회 실행).

## 2. 테스트 수

| 실행 | files | tests total | passed | failed | skipped |
|---|---|---|---|---|---|
| 11 | 58 passed + 1 skipped (59) | 725 | 724 | 0 | 1 |
| 12 | 58 passed + 1 skipped (59) | 725 | 724 | 0 | 1 |
| 13 (JSON) | 59 | 725 | 724 | 0 | 1 |
| 14 (JSON) | 59 | 725 | 724 | 0 | 1 |

건너뛴 테스트(4회 모두 동일, 전체 이름):
- `tests/session-messaging/previous-broker.test.ts > preserves queued messages when new hooks meet the previous released broker` — `it.skipIf(!process.env.AGS_PREVIOUS_BROKER_PATH)`. 이전 릴리스 broker 설치 경로가 필요한 릴리스 검사용이며 이 환경에는 없다 → NOT_RUN.

실패 테스트: 없음.

## 3. 반증 (기준 53eff30a + 후보의 변경 테스트 3개)

`git diff --name-status 53eff30a 2b53e325 -- tests` = `M tests/mcp/tool-schema-profile.test.ts`, `M tests/tooling/claude-plugin.test.mjs`, `M tests/tooling/skill-context-optimization.test.mjs`. 이 세 파일만 후보 버전으로 `/tmp/base`에 덮어 실행(21), 같은 세 파일을 후보에서 실행(22).

- 기준+후보 테스트: 28개 중 23 통과, **5 실패**, exit 1 (21-base-with-cand-tests.log/.json)
- 후보: 28개 중 28 통과, exit 0 (22-cand-changed-tests.log/.json)

| # | 기준에서 실패·후보에서 통과한 테스트 (전체 이름) | 기준 실패 원인(요약) |
|---|---|---|
| 1 | `tests/mcp/tool-schema-profile.test.ts > MCP tool schema profiles > advertises the same host-neutral intake instructions to every schema profile` | 기준 서버에 SKILL_INTAKE 지침 없음 (`expected '세션 메시지는…' to be 'undefined\n세션 메시지는…'`) |
| 2 | `tests/mcp/tool-schema-profile.test.ts > MCP tool schema profiles > applies the environment profile in the bundled server` | 기준 번들 지침 문자열이 후보 기대값과 다름 |
| 3 | `tests/tooling/claude-plugin.test.mjs > generated Claude plugin > keeps the orchestrator selection policy in the shared source and adapts only Claude invocation and observation` | 기준 Claude 생성물 orchestrator SKILL.md에 `$skill` 호출 표기가 남음 |
| 4 | `tests/tooling/skill-context-optimization.test.mjs > skill context optimization > pins the intake revision and rejects a one-byte policy or reference change` | `TypeError: matchesOrchestratorIntakeUpdate is not a function` (기준 checker에 pin 없음) |
| 5 | `tests/tooling/skill-context-optimization.test.mjs > skill context optimization > preserves the reviewed skill revisions while reducing their initial load` | 기준 checker 보고가 기대 객체(totals·policyBaselineUpdates)와 불일치 |

기준에서 통과하던 23개는 후보에서도 통과했다(회귀 없음). 실행 뒤 `/tmp/base`에는 덮어쓴 세 테스트 파일 외 변경이 없다.

## 4. skill-context checker 변조 행렬

방법: 케이스마다 후보 commit의 분리 worktree(`/tmp/ck/<case>`, BASELINE `7bc7753` 도달 가능)를 만들고 `/tmp/ev/scripts/tamper.py`로 변조한 뒤 `node scripts/check-skill-context-optimization.mjs`(CLI)와 `vitest run tests/tooling/skill-context-optimization.test.mjs`를 실행했다. 1바이트 변경은 ASCII 영문자 하나의 대소문자 토글(UTF-8 유지). 원시 결과: `23-tamper-matrix.log`, `23-tamper/<case>.{mutation.log,cli.json,cli.stderr,cli.exit,vitest.log,vitest.exit}`.

| 요구 | case | 변조 | CLI exit | checker 오류(요약) | vitest | 판정 |
|---|---|---|---|---|---|---|
| 대조군 | z0-control | 없음 | 0 | pass=true | 3/3 통과 | PASS(수용) |
| (a) | a1-orch-skill-body | orchestrator SKILL.md byte 2500 (navigation marker 안) | 1 | marker exactly once; reconstructed ≠ pin | 2 fail | 거절 PASS |
| (a) | a1b-orch-skill-body-tail | orchestrator SKILL.md byte 3879 (본문) | 1 | reconstructed ≠ pin | 2 fail | 거절 PASS |
| (a) | a2-orch-frontmatter | orchestrator SKILL.md byte 60 (frontmatter) | 1 | reconstructed ≠ pin; frontmatter ≠ pin | 2 fail | 거절 PASS |
| (a) | a3-orch-entry-details | orchestrator references/entry-details.md 1B | 1 | reconstructed ≠ pin | 2 fail | 거절 PASS |
| (a) | a4-orch-mcp-execution | orchestrator references/mcp-execution.md 1B | 1 | MCP execution ≠ pin | 2 fail | 거절 PASS |
| (a) | a5-orch-unpinned-ref | orchestrator references/collaboration.md 1B | 1 | unexpected skill-owned changes | 1 fail | 거절 PASS |
| (b) | b1-other-skill-md | task-contract SKILL.md 1B | 1 | marker; reconstruct ≠ baseline | 1 fail | 거절 PASS |
| (b) | b2-other-entry-details | session-board entry-details.md 1B | 1 | reconstruct ≠ baseline | 1 fail | 거절 PASS |
| (b) | b3-other-skill-script | task-contract contracts/acceptance-evidence-plan.v1.schema.json 1B | 1 | unexpected skill-owned changes | 1 fail | 거절 PASS |
| (b) | b4-ponytail | ponytail(제외 스킬) .md 1B | 1 | excluded skill ponytail changed | 1 fail | 거절 PASS |
| (b) | b5-other-openai-yaml | task-contract agents/openai.yaml 1B | 1 | openai.yaml changed; unexpected | 1 fail | 거절 PASS |
| (b) | b6-untracked-new-file-in-skill | task-contract/references/extra.md 새 파일(미추적, 미stage) | **0** | pass=true | 3/3 통과 | **미탐지** (관측 사항) |
| (b) | b7-staged-new-file-in-skill | 같은 새 파일을 `git add` | 1 | unexpected skill-owned changes | 1 fail | 거절 PASS |
| (c) | c1-registry | skills/registry.json 1B | 1 | skills/registry.json changed | 1 fail | 거절 PASS |
| (d) | d1-orch-over-4585 | SKILL.md 3935→4586B | 1 | reconstructed ≠ pin; initial load exceeds limit | 2 fail | 거절 PASS |
| (d) | d2-orch-over-4585-repinned | 4586B + reconstructed pin을 새 내용으로 교체(상한만 남김) | 1 | initial load exceeds limit (단독) | 1 fail | 거절 PASS |
| (d) 경계 | d3-exactly-4585-repinned | 정확히 4585B + pin 교체 | 0 | pass=true (상한은 `>` 비교) | 1 fail(totals 고정값) | 수용(설계대로) |
| (e) | e1-pin-reconstructed | reconstructed pin만 0×64 | 1 | reconstructed ≠ pin | 2 fail | 거절 PASS |
| (e) | e2-pin-frontmatter | frontmatter pin만 f×64 | 1 | frontmatter ≠ pin | 2 fail | 거절 PASS |
| (e) | e3-pin-mcpExecution | mcpExecution pin만 sha256("x") | 1 | MCP execution ≠ pin | 2 fail | 거절 PASS |
| (e) | e4-pin-maxbytes-lowered | initialMaxBytes 4585→3000 | 1 | initial load exceeds limit | 1 fail | 거절 PASS |
| (f) | f1-delete-mcp-execution | mcp-execution.md 삭제 | 1 | JSON 없음, `ENOENT` 미처리 예외 | 2 fail | 거절 PASS(예외 경로) |
| (f) | f2-delete-entry-details | orchestrator entry-details.md 삭제 | 1 | JSON 없음, `ENOENT` 예외 | 2 fail | 거절 PASS(예외 경로) |
| (f) | f3-delete-orch-skill-md | orchestrator SKILL.md 삭제 | 1 | JSON 없음, `ENOENT` 예외 | 2 fail | 거절 PASS(예외 경로) |
| (f) | f4-delete-session-board-fixture | session-board 2.6.0 fixture 삭제 | 1 | JSON 없음, `ENOENT` 예외 | 1 fail | 거절 PASS(예외 경로) |

관측 사항(수정하지 않음):
- b6: checker의 스킬 소유 파일 검사는 `git diff --name-only BASELINE -- skills/<id>`라 **미추적 파일**을 보지 못한다. stage 또는 commit되면(b7) 거절된다. CI처럼 commit된 트리를 검사하면 영향이 없지만, 작업 폴더의 미추적 파일은 통과한다.
- (f) 삭제 케이스는 구조화된 `errors` 대신 미처리 `ENOENT` 예외로 exit 1이 된다. 거절은 되지만 JSON 보고가 나오지 않는다.
- (e) hash pin 변경은 테스트 파일이 아니라 checker의 pin 상수를 바꾼 것이다. 내용이 그대로여도 pin 불일치로 거절된다.

## 5. node_modules 없는 설치 트리

`git archive 2b53e325` → `/tmp/inst/codex`(저장소 루트, Codex 설치 형태), `git archive 2b53e325:claude-plugin` → `/tmp/inst/claude`. 두 트리 모두 node_modules 0개. 로그: 24-install-trees.log, 25-blobcheck.log.

| 항목 | Codex 트리 | Claude 트리 | 판정 |
|---|---|---|---|
| node_modules 부재 | 0 | 0 | PASS |
| 모든 파일 bytes = git blob (`git hash-object` vs `ls-tree -z`) | 1189/1189 일치(skills 354) | 404/404 일치(skills 324) | PASS |
| MCP initialize | ok, protocol 2025-06-18, serverInfo agent-governance-suite 2.7.1 | 같음 | PASS |
| MCP tools/list | 28개 | 28개(이름 집합 동일) | PASS |
| 서버 instructions | 1221B, `agent-governance-suite 접수 안내: …` 로 시작 | 같음 | PASS |
| `mcp-server/dist/` 9개 파일 sha256 | server.mjs `674af6f7…a496` | 동일 | PASS(동일) |
| `runtime/`, `contracts/` | — | diff 없음 | PASS(동일) |
| orchestrator references 6개(collaboration, convergence-guard, entry-details, input-origin, mcp-execution, specialist-handoffs) | — | 모두 바이트 동일 | PASS(동일) |
| orchestrator SKILL.md의 `references/…` 링크 대상 존재 | entry-details.md OK | entry-details.md, mcp-execution.md OK | PASS |

- 24 로그의 `MISMATCH codex "tests/instruction-scope-resolver/fixtures/unicode/한글/AGENTS.md"` 한 줄은 첫 스크립트가 `ls-tree`의 비ASCII 경로 인용을 풀지 못해 생긴 **실험 스크립트 결함**이다. NUL 구분으로 다시 잰 25 로그에서 0 mismatch다. 24의 blob 결과 대신 25를 따른다.
- 24 로그의 `hasIntake: false`는 탐색 문자열을 `접수 규칙`으로 잘못 넣은 스크립트 결함이다. 실제 지침은 `접수 안내`로 시작하며(instructionsHead) 두 트리에서 같다.
- root `skills/`와 `claude-plugin/skills/`의 SKILL.md, registry.json, source-lock.json, 일부 references 차이와 `agents/`·`codex-token-usage-analyzer`의 Claude 쪽 부재는 overlay/adaptation 설계에 따른 생성물 차이다. `claude:check`가 fresh이므로 생성 결과와 일치한다.
- MCP 프로브는 격리된 HOME·DB 경로에서 raw JSON-RPC(stdio)로 실행했다. 실제 Codex·Claude Code 호스트가 띄운 것이 아니다.

## 6. NOT_RUN / 한계

- `pnpm validate:official`: Codex 시스템 스킬 validator 부재 → NOT_RUN.
- `previous-broker.test.ts`: 이전 릴리스 broker 경로(`AGS_PREVIOUS_BROKER_PATH`) 부재 → NOT_RUN(skip).
- `source:verify`는 지시 범위 밖이라 실행하지 않았다.
- Windows CI 조합, 사용자 PC 설치 캐시, 실제 호스트의 live 동작은 관측하지 않았다.
- 서비스(GitHub/npm/nodejs.org) 429/5xx·네트워크 실패: 없음.
