# CS 2.8.0 최종 후보 Claude Cloud 검증 (claude-final-1)

지시: Claude AGS 테스트 담당 `d4a4b6b2`(로컬). 근거: AGS 리드 `01a1023f` 브리프 `966537de`(2026-10-06 05:34Z). 사용자가 이미 승인한 2.8.0 릴리스 검증 범위 안의 작업이다. 사람에게 묻지 말고 끝까지 진행한다. 막히면 정확한 지점과 원문 출력을 기록하고, 남은 독립 단계를 계속한다.

## 0. 대상 핀 — 가장 먼저 확인
- 받은 repo의 branch는 `claude/cs280-release-final`이다.
- commit `b7341d3e6636b79217b1f3d37d7a5014fcbf47be`, tree `5648f76558e923244cedf78a8263892d00df8299`
- base `4ba47558020bd5e501fa9718f09d562dcf573713`. base→final 변경은 7파일이고, `git diff --binary --full-index` SHA256은 `9f7117cd88cfc5c71b6eef06d52f8f584cf87630cb785b0c15a0089848d1062a`이다.
- 변경 파일: README.md, README.en.md, release/version.json, docs/roadmap.md, docs/release-notes-2.8.0-rc.ko.md, tests/cs-engineering/files.node.mjs(W1), tests/session-messaging/session-message.test.ts(W2). 제품·공용·Claude 생성물 bytes 변경은 0이다.
- 받은 HEAD/tree, dirty·untracked 수, base 조상 여부, 위 patch SHA를 기록한다.
- 하나라도 다르거나 squashed snapshot이면 제품 검사 전에 멈추고 관측만 보고한다.
- 각 검사 단계 앞뒤로 HEAD/tree/dirty를 기록한다.
- 이 저장소의 `claude-plugin/`과 source는 수정하지 않는다. `claude:build`, fixture 수정, 외부 실패를 넘기기 위한 skip이나 우회도 금지한다.

## 1. 환경 기록 (사용자 원칙: 재사용 여부 구분)
`environment.json`에 각 항목을 실제 근거와 함께 new / reused / unknown으로 판정한다. 근거가 없으면 unknown이다.

- container ID, hostname, `CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE`, 환경 ID(관측 출처가 없으면 unknown)
- PID 1: `ps -o pid,comm,args -p 1`. 끝난 하위 프로세스를 회수하는 init인지 적는다.
- uptime, 시작 시점의 `ps -ef` snapshot, 같은 컨테이너에서 이전에 돌았거나 지금 같이 도는 job
- `/root`, `/home/user`에 처음부터 있던 항목
- workspace를 이번에 새로 받았는지
- 이전 CS280 Claude Cloud 실행(container `container_01X3fps58ifZLjJEtfzpuoxD`, 4ba 기준 914/0/5)과 같은 container인지 독립인지
- deps와 store: pnpm store reused/downloaded 수
- TMP, state, DB 경로
- 실제 버전: Node, pnpm, Python, git, `claude --version`
- model과 effort는 관측 출처가 없으면 unknown이다.

## 2. 격리
- `ST=/root/cs2x-final-<UTC>`를 새로 만든다. 모든 로그와 state는 repo 밖 `ST` 아래에 둔다.
- `TMPDIR`/`TEMP`/`TMP`, `XDG_CONFIG_HOME`/`DATA`/`STATE`/`CACHE`, `AGENT_GOVERNANCE_SHARED_STATE_DIR`, `CLAUDE_PLUGIN_DATA`, `PLUGIN_DATA`, `CODEX_HOME`(비어 있는 디렉터리), `npm_config_store_dir`를 모두 `ST` 아래로 둔다.
- pnpm 11.19.0은 task-local Corepack(`COREPACK_HOME=$ST/corepack`, shim은 `$ST/bin`)으로 고정한다. global 설정은 바꾸지 않는다.
- 제품 명령과 하위 Claude 실행에서는 `CLAUDE_CODE_MESSAGING_SOCKET`과 `CLAUDE_CODE_MESSAGING_TOKEN`을 unset한다. 실제 세션 wake와 inbox를 쓰지 않기 위해서다.
- 모든 명령은 wrapper로 실행하고 `commands.jsonl`에 남긴다. 기록 항목: seq, name, argv, cwd, startUtc, endUtc, exitCode, stdout·stderr 파일, 로그 SHA256, 전후 HEAD/tree/dirty.

## 3. A — 영향 범위 검사 (final에서 1회씩, 같은 입력 반복 0)
1. `pnpm install --frozen-lockfile --store-dir $ST/pnpm-store` — lock 변경이 없어야 한다.
2. `pnpm bundle:check` — **build 전에** 실행한다.
3. `pnpm source:check`
   - `source:verify`(원격)는 실행하지 않는다.
   - 실행이 필요한 상황이 생겨도, 사용자가 삭제한 외부 스킬 저장소의 404는 NOT_VERIFIABLE 예외로만 기록한다. lock 완화는 금지다.
4. `pnpm claude:drift` — 출력을 그대로 기록한다.
5. `pnpm lint`
6. `pnpm build`
   - build 뒤 dirty가 0이어야 한다.
7. `pnpm test -- --reporter=verbose --reporter=json --outputFile.json=$ST/.../vitest.json`
   - 전체 1회, 표준 runner와 checked-in fixture를 그대로 쓴다.
   - 실패, 건너뜀, 통과를 **test ID(파일 › 제목) 단위로 전부** 추출한다. 옛 합계 914/919에 맞추지 않는다.
   - skip 집합을 기존 4ba 결과와 사례별로 대조한다. 기존 skip은 previous-broker 5건이고 사유는 `AGS_PREVIOUS_BROKER_PATH` 미설정이다.
   - W2 `session-message.test.ts`는 사례별 결과를 기록한다.
8. 보충 관측 1회: `node --test --test-reporter=spec tests/cs-engineering/*.node.mjs`
   - 이유: 7의 CS wrapper(suite-integration)는 성공하면 Node harness 사례를 출력하지 않는다.
   - W1의 `file symlink is rejected`와 `intermediate directory symlink or junction is rejected`가 Linux에서 skip 없이 실행·통과했는지 사례 ID로 남긴다.
   - 이것은 gate가 아니라 관측이다.
9. `pnpm validate:all` — README 변경 영향이 있다.
10. `pnpm claude:check` — fresh여야 한다.
11. `pnpm bundle:check` — build 후 결과다.
12. `pnpm release:check` — `release/version.json` 변경 영향이 있다.
13. `git diff --check`, porcelain 0, HEAD/tree 유지, `git fsck --no-dangling`

**실행하지 않고 기존 근거로 묶는 것** (제품 bytes 변경 0)
- `runtime:check`, `skills:context-check`: 4ba Claude Cloud 근거(evidence `cs280-claude-cloud/20261006T033701Z/08·13`)로 묶는다. B가 Claude 트리를 별도로 덮는다.
- `validate:official`: Codex Cloud `01a10ee6` 담당이다. 이 작업에서는 실행하지 않고 "owner 별도"로 적는다.
- `status.json`에 영향표를 만든다: 변경 파일 → 영향 gate → 실행 또는 기존 근거 결속.

## 4. B — node_modules 없는 Claude 트리 clean-room
1. repo의 `claude-plugin/`과 `.claude-plugin/marketplace.json`을 `$ST/claude-clean/mkt/` 아래로 복사한다. marketplace의 source `./claude-plugin`이 그대로 풀리게 둔다.
   - 복사본 상위 경로 어디에도 `node_modules`가 없다는 확인을 기록한다.
   - 복사본의 파일별 sha256 목록이 repo `claude-plugin/`과 같아야 한다.
2. 아래에서 `<C>`는 복사된 claude-plugin 루트다.
   - `node <C>/skills/cs-engineering/scripts/validate.mjs`(무인자 = help): exit 0, stdout에 `check-stage-bundle`이 있어야 한다.
   - `… validate.mjs self-check`: exit 0, `status: PASS`, `rules: 40`, `schemaEngine: ags-ajv2020`이어야 한다. `standalone-closed-schema-subset`이면 실패다.
   - `… validate.mjs check-bundle --root <C>/skills/cs-engineering/assets/examples/sqlite-queue --binding binding.json --task task.json --policy policy.json --review review.json --candidate candidate.json`: exit 0, `verdict: PASS`.
   - `… validate.mjs not-a-command`: exit 2, `INVALID_INPUT`.
   - exit 코드 의미: 3은 FAIL/NEEDS_REDESIGN, 4는 BLOCKED/NEEDS_INPUT, 2는 adapter 오류다.
3. MCP STDIO: `node <C>/mcp-server/dist/server.mjs`
   - env: `AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE=anthropic`, `AGENT_GOVERNANCE_HOST_ATTESTATION=claude-code`. DB와 state는 `$ST` 전용이다.
   - JSON-RPC로 `initialize`와 `tools/list`만 보낸다.
   - 모든 tool inputSchema에서 `$ref` 0, top-level `oneOf`/`anyOf`/`allOf` 0이어야 한다.
   - instructions에 공통 접수 원문("agent-governance-suite 접수 안내")이 있어야 한다.
   - 원 응답 JSON을 보존한다.
4. `claude plugin validate <C> --json`과 `--strict --json`: exit 코드와 경고 원문을 기록한다. strict 판정은 root가 한다.

## 5. C1 — disposable config 설치 (모델 호출 없음)
- `export CLAUDE_CONFIG_DIR=$ST/claude-config`로 둔다. 새 빈 디렉터리이며 기존 `~/.claude`를 복사하지 않는다.
1. `claude plugin marketplace add $ST/claude-clean/mkt`
2. `claude plugin install agent-governance-suite@agent-governance-claude --scope user --json`
3. `claude plugin list --json`, `claude plugin details agent-governance-suite`
   - 확인: version 2.8.0, 스킬에 cs-engineering이 노출되는지
4. 설치 캐시의 실제 경로를 찾는다. 파일별 sha256 목록을 repo `claude-plugin/`과 대조한다(일치 수 / 불일치 / 누락).
5. `claude mcp list`: plugin MCP의 health 결과를 기록한다. 목록에 없으면 unknown이다.
- 인증을 요구해서 막히면 원문을 기록하고 BLOCKED로 둔다.

## 6. C2 — 실제 Claude host 흐름 (인증 확인 먼저)
1. 같은 `CLAUDE_CONFIG_DIR`에서 `claude auth status --json`을 실행한다.
   - 공개 기록에는 인증 방식과 로그인 여부만 남긴다. 토큰, 이메일, 계정값은 0이다.
   - 미인증이면 C2 전체를 **BLOCKED/unknown**으로 기록하고 끝낸다.
   - `auth login`, 새 token 발급, credential·config 복사, env token 주입은 모두 금지다.
2. 인증이 되어 있으면, 설치된 플러그인을 쓰는 새 하위 Claude Code 세션으로 아래를 실행한다.
   - 실행: `claude -p --output-format stream-json --verbose`(같은 isolated config)
   - stream-json stdout 전체를 raw transcript로 보존한다.
3. 흐름 F1 (최소, CS 25/67 대표 guarded flow)
   - 입력: `skills/cs-engineering/assets/examples/sqlite-queue`를 `$ST/flow/`로 복사한다. task에 `requiredCapabilities=["cs-implementation-review"]`, `orchestration={requested:true,mcpAvailable:true}`를 둔다.
   - payload 형태는 checked-in `tests/cs-engineering/workflow-integration.test.ts`(fixture·taskDigest 결속·stage-bundle manifest)를 참고한다. 다만 **MCP 호출은 하위 Claude host가 플러그인 MCP 도구로 직접 한다.** 스크립트로 서비스를 직접 부르면 안 된다.
   - 순서: `plan_workflow` → `open_convergence_root` → `claim_workflow_attempt` → `start_guarded_workflow` → `record_stage_result`(stage 67 cs-implementation-review, cs-review-bundle·cs-review-report artifact, **outputFile** 방식) → `finalize_workflow`
   - 성공 조건 (모두 충족):
     - plan에서 CS provider가 bootstrap 25와 workflow 67로 선택된다.
     - record와 finalize에서 MCP가 `validate.mjs check-stage-bundle`을 실제로 실행하고 파일을 다시 읽는다.
     - 최종 state가 passed다.
     - observation은 Claude 배포물 hook(host-attestation)의 실제 관측이다.
4. 음성 대조 1건: F1과 같은 형태로 record까지 간 run에서, 참조 파일(review.json) 1바이트를 바꾼 뒤 finalize한다. 거절되어야 한다.
5. release.md:23 — 하위 세션에서 서브에이전트(Agent 도구)가 `plan_workflow`를 1회 호출하게 한다. 관측 actor가 서브에이전트로 기록되는지 확인한다.
6. release.md:24 — 저장소 크기에 비례하는 stage 출력을 outputFile로 넘긴다. 예: `git ls-files` 전체와 파일별 sha256을 담은 JSON, 16 MiB 이하. orchestrated run이 finalize까지 가는지 확인한다. F1과 합칠 수 있으면 합치고, 최소 단계만 추가한다.
7. 금지와 판정 기준:
   - synthetic이나 주입 observation, signed observation 위조, hook·`HOST_ATTESTATION` 제거·우회, unknown field 삭제 재시도는 금지다.
   - 관측이나 인증이 부족하면 그대로 BLOCKED/unknown이다.
   - H01~ 자동 선택·품질 eval과 `claude plugin eval`은 범위 밖이다.
8. 출처 구분: 다음을 서로 구분해 기록한다.
   - CLI 실제 버전, 분리 config 경로
   - 하위 세션 stream-json raw
   - MCP DB(`$ST`)의 run·receipt·observation 행. 값 대신 ID, state, digest, actor를 추출한다.
   - 도구 결과

## 7. 결과물과 evidence 게시 (사용자 상시 원칙)
- 원본 디렉터리는 `$ST/out/`에 둔다. 포함할 것:
  - `commands.jsonl`과 단계별 stdout·stderr
  - vitest JSON, 사례 ID 목록(pass/fail/skip)
  - `environment.json`, `status.json`(단계별 PASS / FAIL / BLOCKED / NOT_RUN / 기존근거결속)
  - B·C1·C2 원 출력, MCP 응답
  - 하위 세션 stream-json transcript
  - 이 세션 자체의 작업 로그: 이 세션 transcript(`~/.claude/projects/` 아래 jsonl)도 **무조건 빼지 않는다.** 민감정보를 제거할 수 있는 부분은 게시한다. 제거할 수 없거나 제공되지 않는 부분은 NOT_VERIFIABLE에 이유와 함께 적는다.
- 민감정보 제거
  - 대상: 이메일, 계정명, 홈 경로, IP, github·sk·xox·AKIA·JWT 토큰, Bearer, `*_TOKEN|_SECRET|_KEY=` 값, URL query, 200자 넘는 base64, 런타임 비밀값 리터럴
  - 리터럴 대조 목록은 repo 밖 임시 파일에만 두고, 쓰고 나면 바로 삭제한다.
  - 원래 값은 어디에도 적지 않는다.
  - `REDACTION.md`: 파일별 종류와 횟수, 잔여 검사 결과(개수만), 동결 cutoff UTC
  - `MANIFEST.tsv`: `path`, `pre_redaction_sha256`, `public_sha256`, `redactions`
  - `SHA256SUMS`, `NOT_VERIFIABLE.md`
  - 실패는 그대로 보존한다.
- 게시 위치: 공개 저장소 `jaeseongs95/agent-governance-suite`의 `evidence` 브랜치, **새 하위 `cs280-release-prep/claude-final-1/`에만** 추가한다.
  - 별도 worktree `/root/evidence-wt`에서 `git fetch origin evidence` → `merge --ff-only FETCH_HEAD`로 진행한다. 후보 repo는 건드리지 않는다.
  - 커밋 변경이 그 폴더 밖에서 0이고 추가(A)만 있는지 확인한다.
  - push 전후의 원격 `ls-remote`를 기록한다.
  - `git push origin HEAD:evidence`(non-force)로 push한다. non-fast-forward면 fetch와 `--ff-only` 후 1회 재시도한다.
  - bundle 세션이라 403("not in this session's authorized repository set")이 나면, 이 세션의 `add_repo` 도구로 이 저장소를 붙여 push 권한을 얻는다. 2026-10-06 CS280 선례다. 다른 권한 변경이나 우회는 0이다. 그래도 막히면 원문을 기록하고 멈춘다.
  - force, amend, rebase, main·tag·release 변경, 현재 PC 설치는 0이다.
- 후처리 로그: 게시 뒤 redaction·commit·push 단계의 원 로그를 `cs280-release-prep/claude-final-1/worklog-append-1/`에 **한 번만** 추가한다. 형식은 같다(REDACTION·MANIFEST·SUMS·cutoff). 그 뒤 생기는 기록은 NOT_VERIFIABLE에 적고, 자기 게시를 반복하지 않는다.

## 8. 최종 응답 (짧게)
- 세션·container ID, 환경 판정 요약, 받은 핀 대조 결과
- A·B·C1·C2 단계별 결과 표(PASS / FAIL / BLOCKED / NOT_RUN / 결속). 실패는 test ID와 위치를 적는다.
- evidence commit SHA, tree, parent, `ls-remote`, 폴더 파일 수, SUMS·MANIFEST 자체 SHA256
- 마지막 push 출력 원문과 NOT_VERIFIABLE 요약
