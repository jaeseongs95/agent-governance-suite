# AGS 2.7.3 intake 독립 감사 보고

지시: 총괄 ca8e3dc4. 감사자는 구현 세션과 분리된 세션이며, 제품 소스를 고치지 않았다(읽기 전용 감사).

## 최종 판정: ACCEPT_WITH_FINDINGS

이식과 코드 동작은 결함 없이 재현됐다. 2.7.2 변경은 되돌려지지 않았고, 두 schema profile은 같은 공통 block을 정확히 한 번 받으며, 필수 mutation 9개는 모두 테스트에서 걸렸다. blocker는 없다. 다만 공개 문서 두 곳(major)이 이제는 사라진 동작을 설명하므로 릴리스 전에 고쳐야 한다. 회귀 테스트 범위와 보고서 서술에는 minor 항목이 있다.

| 대상 | SHA |
| --- | --- |
| 후보 (`claude/v273-intake`) | 732ba286a68b35a7cbd99aefbea12d11b88f1b8c (tree 06d58b25…) |
| 기준 (`main`, v2.7.2) | 8763cef2b11f2635d6c9af7861b5bffd496e2a30 |
| 원본 | 2b53e325f549a9ebd32a143d1d11f7b4393355fa, cb59ad7f0f74a32a910e0afc2d196d12ea460c67 |
| 구현 evidence | 24cb23bc39e91f22c84cef46e30008154a74ebff (`v273-intake/REPORT.md`) |

환경: Linux cloud 컨테이너 하나, Node.js v24.21.0(`/opt/node24`에 있어 따로 내려받지 않음), pnpm 11.19.0. 후보는 detached worktree 두 개(검증용, mutation용)에서 검사했다.

## 항목별 결과

| # | 항목 | 결과 | 근거 |
| --- | --- | --- | --- |
| 1 | 이식 충실성 | PASS | `logs/checks/patch-id.log`, `revert-check.log`, `file-sets.log`, `commit-messages.log` |
| 2 | 벤더 비종속 (F1) | PASS (minor 관찰 F-4) | `intake-copy-scan.log`, `init-smoke.log`, `hook-and-failclosed.log` |
| 3 | 회귀 테스트 실효성 | PASS (범위 공백 F-3) | `logs/mutation/summary.log`, `scripts/mutations.sh` |
| 4 | 전체 검증 재실행 | PASS, 단 validate:official FAIL_UNRELATED(환경), source:verify NOT_VERIFIABLE | `logs/full/*` |
| 5 | 생성물 일치 | PASS | `generated-byte-compare.log` |
| 6 | 문서와 공개 표면 | FAIL (F-1, F-2 major) | `README.md:66`, `README.en.md:66`, `claude-overlay/README.md:17-18,73` |
| 7 | 구현 보고서 대조 | 주요 주장 재현, 일부 누락·과장 (F-5 minor) | 아래 7절 |

### 1. 이식 충실성: PASS

- `git patch-id --stable`을 직접 계산했다. 2b53e325와 c548c77f는 `812a2f22…`, cb59ad7f와 afafd4e6은 `202ac276…`로 같다.
- 두 이식 커밋이 바꾼 경로에서 원본 tip(cb59ad7f)과 afafd4e6의 내용은 byte 단위로 같다(`git diff --stat` 출력 없음).
- 교환 검사: `diff(53eff30→8763cef)`(원본 기준에서 main까지의 2.7.2 변경)와 `diff(cb59ad7f→732ba286)`에서 새 테스트 파일을 뺀 부분의 patch-id가 `a54a35d2…`로 같다. 따라서 후보는 2.7.2 변경 전체와 intake 변경을 함께 담고, 2.7.2 쪽을 한 줄도 되돌리지 않았다.
- 2.7.2 경로와 겹치는 파일은 두 `server.mjs` 번들뿐이다. 두 번들의 diff는 intake 부분(`readFileSync` import, `SKILL_INTAKE_SERVER_INSTRUCTIONS`, `serverInstructions()`)만 담는다. 두 번들 모두 `"2.7.2"`가 1회, `verifyInputSource`가 3회 나와 기준과 같다.
- wake·broker·session-message 관련 소스, 번들, 계약과 테스트 38개 파일은 기준과 blob이 같다(`revert-check.log`).

### 2. 벤더 비종속: PASS

- 공통 intake block의 문장 19개를 추적 파일 전체에서 찾았다(`scripts/intake-copy-scan.mjs`). 문장 전체가 나오는 곳은 공통 원본 `skills/orchestrator/SKILL.md:13-23`, 생성물 `claude-plugin/skills/orchestrator/SKILL.md`, 테스트 fixture(`tests/tooling/claude-plugin.test.mjs`)뿐이다. claude-overlay, claude-plugin의 수동 파일(hooks), MCP 서버 소스와 번들에는 없다. 16자 조각이 일치한 곳은 모두 `mutation-risk-preflight` 같은 스킬 식별자다.
- 서버는 intake를 소스에 복사하지 않는다. 모듈 로드 때 `../../skills/orchestrator/SKILL.md`의 marker 사이를 읽는다(`mcp-server/src/server.ts:329-332`). profile은 instructions에 영향을 주지 않는다(`server.ts:334-336`, `361`).
- 직접 재현(`scripts/init-smoke.mjs`): 서버 배치 세 가지(Codex 루트 `mcp-server/dist`, 저장소 안 `claude-plugin`, 저장소 밖으로 떼어 낸 `claude-plugin` 사본)와 profile 세 가지(default, anthropic, 미설정)를 곱한 9경우를 stdio로 초기화했다. 9경우 모두 공통 block을 정확히 1회 담았고, instructions sha256은 모두 `a410cfd1…`, 크기는 3295 byte, 도구는 28개였으며 제품명 표현이 없었다. 구현 보고서의 값과 같다.
- 벤더별 차이는 adapter와 생성 단계에만 있다. Claude 쪽은 `claude-overlay/adaptations/orchestrator.json`(호출·관측 절 삽입)과 `claude-overlay/hooks/skill-trigger-hook.mjs`(SessionStart에서 공통 block을 읽어 투영하고 Claude 호출 문법 한 줄을 붙임)뿐이다. 두 파일 모두 정책 문장을 담지 않는다. 생성물 hook과 hooks.json은 overlay와 byte 단위로 같다. anthropic profile은 schema 변환만 바꾼다(테스트 `tests/mcp/tool-schema-profile.test.ts:193-217`).
- CRLF 위험은 `.gitattributes`의 `*.md text eol=lf`로 막혀 있다.

### 3. 회귀 테스트 실효성: PASS

`scripts/mutations.sh`는 후보 SHA의 별도 worktree에서 mutant마다 (overlay를 고친 경우 `claude:build`로 다시 생성) → `node scripts/build.mjs` → 관련 vitest 3개 파일 → `claude:check` → `lint`를 실행하고, `git checkout`/`git clean`으로 원상 복구했다. 끝난 뒤 worktree의 변경은 0줄이었다.

| mutant | 내용 | 결과 | 걸린 검사 |
| --- | --- | --- | --- |
| M0 | 변경 없음(대조군) | 모두 통과 | — |
| M1a | 공통 문장 하나를 `claude-overlay/README.md`에 복사 | KILLED | keeps no copy… |
| M1b | 같은 문장을 `adaptations/orchestrator.json`에 복사 | KILLED | keeps no copy… |
| M1c | 같은 문장을 overlay hook 출력에 복사 | KILLED | keeps no copy…, projects the current common intake… |
| M1d | 같은 문장을 `mcp-server/src/server.ts` 안내 앞머리에 복사 | KILLED | keeps no copy…, claude:check |
| M1e | 같은 문장을 Codex `hooks/hooks.json`에 복사 (범위 탐색) | 살아남음 | 없음 → F-3 |
| M1f | 같은 문장을 `mcp-server/src/plugin-info.ts`에 복사 (범위 탐색) | 살아남음 | 없음 → F-3 |
| M2a | default profile에서 intake 제거 | KILLED | advertises the same host-neutral intake…, claude:check |
| M2b | anthropic profile에서 intake 제거 | KILLED | 위 테스트, applies the environment profile in the bundled server, claude:check |
| M2c | Claude SessionStart hook에서 intake 제거 | KILLED | projects the current common intake… |
| M3a | 공통 원본 문장 하나 변경(생성물도 다시 만듦) | KILLED | pins the intake revision…, preserves the reviewed skill revisions… |
| M3b | 생성물 SKILL.md 문장만 변경 | KILLED | keeps the orchestrator selection policy…, claude:check |
| M3c | overlay 절에 정책 문장 추가 | KILLED | keeps the orchestrator selection policy… |

지시된 세 종류(overlay 복사, profile 하나에서 intake 제거, 문장 하나 변경)는 모두 걸렸다. M1d는 `tool-schema-profile` 테스트로는 걸리지 않았다. 그 테스트는 block 전체가 한 번 나오는지만 보기 때문이며, 대신 복사 검사 테스트가 잡았다. M3a의 `lint`는 통과했으므로 공통 원본 변경을 막는 것은 `pnpm test`뿐이다.

### 4. 전체 검증 재실행

후보 worktree(작업 트리 깨끗함)에서 지시 순서대로 실행했다. 명령별 stdout, stderr와 종료 코드는 `logs/full/NN-*.{stdout,stderr}.log`, `.exit`에 있다.

| # | 명령 | 종료 코드 | 결과 |
| --- | --- | --- | --- |
| 01 | `pnpm install --frozen-lockfile` | 0 | PASS |
| 02 | `pnpm bundle:check` | 0 | PASS |
| 03 | `pnpm claude:drift` | 0 | PASS (`claude-plugin: fresh`) |
| 04 | `pnpm lint` | 0 | PASS |
| 05 | `pnpm build` | 0 | PASS |
| 06 | `pnpm test` | 0 | PASS: 파일 59개 통과·1개 skip, 테스트 814개 통과·1개 skip |
| 07 | `pnpm runtime:check` | 0 | PASS (skill CLI 29개) |
| 08 | `pnpm validate:all` | 0 | PASS |
| 09 | `pnpm validate:official` | 1 | FAIL_UNRELATED(환경): Codex validator `~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py`가 없음(ENOENT). 검사 자체가 돌지 않았으므로 NOT_RUN 성격이다 |
| 10 | `pnpm claude:build` | 0 | PASS |
| 11 | `pnpm claude:check` | 0 | PASS |
| 12 | `git diff --check` | 0 | PASS |
| 12b | `git diff --check 8763cef HEAD` | 0 | PASS |
| 13 | `pnpm source:check` | 0 | PASS |
| 14 | `pnpm source:verify` | 1 | NOT_VERIFIABLE: 원격 `ponytail` 저장소 clone이 인증 요구로 실패했다. 사용자가 의도적으로 삭제한 저장소이므로 결함이 아니다. 다른 source 오류는 없었다 |
| 15 | 검증 뒤 `git status` | — | 변경 0줄 |

skip된 테스트 1개는 이전 릴리스 broker가 없을 때 건너뛰는 `previous-broker` 테스트이며, 구현 보고서의 설명과 같다.

### 5. 생성물 일치: PASS

- 후보 tree를 `git archive`로 새 디렉터리에 풀고(tree `06d58b25…` 일치 확인), 추적된 `claude-plugin/`을 옆으로 옮긴 뒤 `build-claude-plugin.mjs`로 다시 만들었다. `diff -r` 결과 404개 파일이 byte 단위로 같다.
- `mcp-server/dist/server.mjs`와 `claude-plugin/mcp-server/dist/server.mjs`는 sha256 `6bbf349e…`로 같다. dist 파일 9개 모두 두 위치에서 같다.
- 후보 worktree에서 `claude:build`를 실행한 뒤에도 `git status`의 변경과 무시된 파일은 0개였다.

### 6. 문서와 공개 표면: FAIL

- 변경된 18개 파일의 상대 링크와 heading anchor는 모두 해석된다(`link-check.log`). `entry-details.md`의 `../SKILL.md#공통-접수선택-기준`도 맞다. adaptation JSON의 `references/mcp-execution.md` 한 건은 생성된 `SKILL.md` 기준 경로라 도구의 오탐이며, 생성물에서는 해석된다. 외부 스킬 저장소 링크는 없고, 번들 안의 github.com URL은 제3자 코드 주석과 저장소 자기 링크로 기준과 같다.
- 사용자에게 보이는 문구 가운데 두 곳이 후보의 실제 동작과 다르다(F-1, F-2). 후보는 이 문서들을 고치지 않았고, 원본 cb59ad7f와 기준 8763cef에서도 같은 내용이다.

### 7. 구현 세션 보고서 대조

재현된 주장: patch-id 두 쌍, 충돌 없음, 두 번들의 2.7.2 표지, 테스트 814/1 skip, runtime CLI 29개, `claude-plugin: fresh`, validate:official ENOENT, source:verify의 ponytail 인증 실패, instructions sha256 `a410cfd1…`와 네 경우 1회 포함, 새 복사 검사 테스트가 overlay README 복사를 잡는다는 점, hook이 UserPromptSubmit·PreToolUse(Bash)에서 아무것도 내보내지 않는다는 점.

재현되지 않거나 과장된 부분은 F-5에 적었다.

## Findings

### F-1 (major) 루트 README가 없어진 keyword 추천과 이전 Codex 동작을 설명한다

- 위치: `README.md:66`, `README.en.md:66`.
- 내용: "Claude Code는 일부 요청과 명령에 추가 스킬을 추천하는 안내를 제공합니다 / Codex의 암시 선택은 모델의 판단에 의존합니다." 후보는 UserPromptSubmit·PreToolUse(Bash) keyword 추천 hook을 없앴다(`claude-overlay/hooks/hooks.json`, 테스트 `claude-plugin.test.mjs`의 "projects the current common intake…"). 또 Codex(default profile)에도 공통 intake를 MCP instructions로 보낸다.
- 재현: `node scripts/init-smoke.mjs <repo> <plugin-copy>`를 실행하면 default profile에도 intake가 1회 들어 있다. `echo '{"hook_event_name":"UserPromptSubmit","prompt":"git merge 해 줘"}' | node claude-plugin/hooks/skill-trigger-hook.mjs`는 아무것도 출력하지 않는다.
- 권장: 두 README의 해당 문단을 "두 호스트 모두 MCP 서버 초기화 안내로 `skills/orchestrator/SKILL.md`의 공통 접수 기준을 받고, Claude Code는 SessionStart에서 같은 원문을 함께 받는다"로 바꾼다. 영어판도 같은 변경에서 맞춘다.

### F-2 (major) Claude overlay README와 생성된 plugin README가 이전 접수 규칙을 설명한다

- 위치: `claude-overlay/README.md:17`, `:18`, `:73`. 생성물 `claude-plugin/README.md`의 같은 줄에도 그대로 복사된다.
- 틀린 서술:
  - 17행은 "실패 영향을 한 줄로 분류"하는 접수 규칙이 anthropic에서만 나가고 "Codex 서버는 `instructions`를 내보내지 않는다"고 한다. 실제로는 profile과 관계없이 공통 block이 나가며, 실패 영향 분류를 출력하지 말라고 한다(`SKILL.md:22`).
  - 18행은 adaptation이 `SKILL.md` "맨 앞에 'Claude Code에서의 선택 결정' 절"을 넣는다고 한다. 실제로는 공통 block 뒤, navigation 앞에 "Claude Code에서의 호출과 관측" 절을 넣는다.
  - 73행은 `skill-trigger-hook.mjs`가 정규식으로 요청과 Bash 명령을 보고 스킬을 안내한다고 한다. 실제로는 SessionStart에서 공통 원문만 투영한다.
- 재현: `git show 732ba286:claude-overlay/README.md | sed -n '17,18p;73p'`와 `claude-overlay/hooks/skill-trigger-hook.mjs`, `hooks.json`, `init-smoke.log`를 대조한다.
- 권장: overlay README의 세 항목을 현재 동작으로 고치고 `pnpm claude:build`로 생성물을 다시 만든다. overlay README에 공통 문장을 옮겨 적으면 새 복사 검사 테스트에 걸리므로, 동작만 요약하고 원문은 `skills/orchestrator/SKILL.md`를 가리키게 한다.

### F-3 (minor) 복사 방지 테스트의 검사 범위가 F1 원칙보다 좁다

- 내용: "keeps no copy…" 테스트는 `claude-overlay/`와 `mcp-server/src/server.ts`만 본다. 공통 문장을 Codex `hooks/hooks.json`(M1e)이나 다른 MCP 소스 `mcp-server/src/plugin-info.ts`(M1f)에 복사하면 test, lint, claude:check가 모두 통과한다. `tool-schema-profile`의 "exactly once" 검사도 block 전체 단위라서, 안내 앞머리에 문장 하나를 복사한 M1d는 잡지 못한다.
- 재현: `scripts/mutations.sh`의 M1e, M1f(`logs/mutation/M1e-*`, `M1f-*`).
- 권장: 추적 파일 전체를 검사하고, 허용 목록은 `skills/orchestrator/SKILL.md`, 생성된 `claude-plugin/skills/orchestrator/SKILL.md`, 테스트 fixture로 한정한다. 서버 안내에서 intake 바깥 부분에 공통 문장이 없는지도 문장 단위로 확인한다.

### F-4 (minor) Claude Code 세션에서는 같은 공통 block이 두 번 들어간다

- 내용: Claude Code 세션은 MCP 서버 instructions와 SessionStart hook의 `additionalContext` 양쪽에서 같은 block(약 3.3KB)을 받는다. 둘 다 같은 원본을 투영하므로 정책 복사는 아니고 F1 위반도 아니다. 하지만 "정확히 한 번"은 경로별로만 성립하고, 모델 context 전체에서는 두 번이 된다. Codex는 한 번 받는다.
- 재현: `logs/checks/hook-and-failclosed.log`, `init-smoke.log`.
- 권장: 이 중복이 의도한 fallback(예: MCP 서버가 뜨지 않을 때)이면 overlay README에 그렇게 적는다. 아니면 Claude 경로 하나를 고른다. 이 선택은 G2 평가 결과와 함께 판단한다.

### F-5 (minor) 구현 보고서의 누락과 과장

- "원본 커밋 메시지에는 출처 줄과 Co-Authored-By trailer만 더했다"고 했지만, 실제로는 "Ported onto v2.7.2 main (8763cef2) without conflicts." 줄과 `Claude-Session:` trailer도 더했다(`commit-messages.log`). tree는 바뀌지 않았으므로 영향은 없다.
- "새 테스트 파일"이라고 했지만, 새 파일이 아니라 기존 `tests/tooling/claude-plugin.test.mjs`에 테스트 한 개(14줄)를 더한 것이다.
- 문서 영향(F-1, F-2)과 Claude 이중 투영(F-4)은 보고서에 나오지 않는다. 남은 위험 목록에서 문서 불일치가 빠졌다.
- 권장: 다음 보고서에서 정정한다. 판정에는 영향이 없다.

### 관찰 (finding 아님)

- 서버는 공통 원본을 읽지 못하면 시작하지 않는다(fail-closed). 떼어 낸 plugin 사본에서 end marker를 지우자 `Error: Shared skill intake instructions are missing.`로 종료했고, hook은 조용히 아무것도 내보내지 않았다(`hook-and-failclosed.log`). 즉 intake 문서가 깨지면 workflow·세션 메시지 도구까지 모두 쓸 수 없다. 구현 보고서가 이미 밝힌 위험이며, 원본 hash 고정 테스트(M3a)와 clean-room 검사가 이를 완화한다.

## NOT_RUN

- `validate:official`: 컨테이너에 Codex 공식 validator가 없다(FAIL_UNRELATED, 환경).
- `source:verify`의 `ponytail` 원격 확인: 저장소가 삭제돼 인증 요구가 돌아왔다(NOT_VERIFIABLE).
- Windows(CI의 Windows × Node.js 24 조합): 이 감사는 Linux cloud 한 환경의 결과다.
- 실제 marketplace 설치, 설치 캐시, 설치된 호스트(Codex, Claude Code)에서의 MCP 동작: 범위 밖이다.
- G2 자연어 평가(스킬 실제 사용률 회복 여부): 범위 밖이다.

## 가린 값

push 전에 다음을 스캔했다. 토큰 패턴(`ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `AKIA`, PRIVATE KEY 줄, Authorization Bearer), 이메일 주소와 IPv4 주소는 발견되지 않았다. 커밋 로그의 trailer 이메일은 기록할 때 `<[REDACTED]>`로 바꿨다.

| 대상 | 치환 | 파일 수 | 횟수 |
| --- | --- | --- | --- |
| 사용자 이름이 들어간 컨테이너 홈 경로(user 계정 홈) | `[REDACTED-HOME]` | 16 | 16 |
| root 계정 홈 경로 | `[REDACTED-HOME]` | 2 | 3 |
| GitHub 계정 이름(URL 소유자) | `[REDACTED-ACCOUNT]` | 3 | 5 |

`env`·`printenv` 출력은 남기지 않았다. 치환한 뒤 `SHA256SUMS`를 만들었다.

## 파일

- `REPORT.md`, `meta.json`, `SHA256SUMS`
- `scripts/run-full.sh`: 전체 검증 재실행
- `scripts/mutations.sh`: mutation 검사
- `scripts/intake-copy-scan.mjs`: 공통 문장 복사 탐색
- `scripts/init-smoke.mjs`: 서버 초기화 재현
- `scripts/link-check.mjs`: 링크 검사
- `logs/full/`: 명령별 로그
- `logs/mutation/`: mutant별 diff, 결과와 로그
- `logs/checks/`: 이식·생성물·링크·hook 검사 로그
