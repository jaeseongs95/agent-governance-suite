# 메시지마다 안내(per-message cue) 축소 후보의 스킬 선택 정확도 A/B 시험 설계 (2026-11-06)

이 문서는 설계와 실행 절차만 적는다. 실호스트 실행 결과는 아직 없다. 아래 「로컬에서 확인한 것」을 뺀 모든 동작은 시험 서버에서 처음 돌려 보기 전까지 미확인이다.

## 1. 무엇을 비교하나

- **A판(기준)**: 사용자 메시지마다 UserPromptSubmit 훅(`continuity-hook`의 user-input 분기 → `checkpointCue`)이 「[AGS 턴 확인]」 문구와 설치된 스킬 26개의 대상 목록(`installedSkillTargets()`)을 붙인다.
- **B판(후보)**: 대상 목록은 맥락 시작(intake-hook이 정한 세션 시작·재개·압축 뒤)에 한 번 싣고, 메시지마다는 그 목록을 가리키는 짧은 확인 문구와 checkpoint 문구만 남긴다. B 커밋은 아직 없다. 두 판은 git ref(`A_REF`, `B_REF`)로 받는다.
- **묻는 것**: 한 대화 안에서 목적이 다른 요청 6개가 차례로 올 때, B가 A만큼 맞는 AGS 스킬을 실제로 호출하는가. 전문 스킬이 필요 없는 질문에 과잉 호출하지 않는가.
- B판은 「안내 위치·분량」 외에 다른 변경이 섞였을 수 있다. 두 판의 `skills/` 트리 해시가 같은지는 `prepare.sh`가 출력한다. 같지 않으면 결과를 후보 전체의 차이로 읽고, 안내만의 효과라고 쓰지 않는다.
- 호스트: 시험 서버(Linux) 실호스트 Claude Code와 Codex. agy는 넣지 않는다. 모델은 각 CLI 기본값이며 실행 로그에서 확인해 기록한다(Claude는 `check.mjs`가 `system/init`의 `model`을 turn 1에 남긴다. Codex 로그의 모델 표시 위치는 미확인).

### 1.1 가장 중요한 한계: 「한 번만 싣는다」를 어떻게 시험하나

`claude -p --resume <id>`와 `codex exec resume <id>`는 턴마다 새 프로세스를 띄운다. 새 프로세스는 매번 `SessionStart(source=resume)`을 일으킨다(Codex는 개발가이드 6.3에서 `SessionStart(source=resume)` 확인, Claude는 hooks.json의 matcher에 `resume`이 있어 같을 것으로 추정). B가 「재개 뒤」에 목록을 싣는다면, 이 방식에서는 B도 목록을 **매 턴** 받는다. 그러면 A(메시지마다)와 B(재개마다)는 사실상 같은 횟수로 목록을 받아 차이를 못 잰다.

- `prepare.sh`가 두 판의 훅을 호스트 밖에서 직접 돌려 `SessionStart`(startup·resume·compact)와 UserPromptSubmit의 글자 수를 잰다(`static/`). `summary.mjs`는 B의 resume 글자 수가 A보다 1,000자 이상 많으면 위 상황이라고 경고한다.
- Claude는 이를 피하는 실행 방식을 함께 넣었다. `CLAUDE_MODE=stream`은 `claude -p --input-format stream-json`으로 **한 프로세스**에 메시지 7개를 차례로 보낸다(`claude-stream.mjs`). SessionStart는 한 번, UserPromptSubmit은 메시지마다 돈다. 지시받은 기본 방식은 `--resume`(`CLAUDE_MODE=resume`, 기본값)이다. B가 재개 때 목록을 싣는 것으로 확인되면 stream 방식 결과를 주된 근거로 쓴다. 두 방식의 결과는 합치지 않고 `RUNTAG`로 나눠 따로 요약한다.
- Codex는 headless로 한 프로세스 다중 턴이 없다. 한 번만 싣는 조건은 대화형(TUI)에서만 만들 수 있고, 이 하네스는 그것을 만들지 않았다(미구현). Codex 결과는 「재개마다 시작 안내가 다시 오는 조건」의 결과로만 쓴다.

## 2. 과제와 판정

고정한 한 대화(7턴)를 두 판에 같은 순서·같은 글로 준다. 정의는 `tasks.mjs`. 프롬프트에 스킬 이름과 선택 규칙을 넣지 않았다(프롬프트 파일을 `grep -i skill`해도 0건). 작업 폴더는 `fixture.mjs`가 매 회차 새로 만든다(작은 node 프로젝트 `invoice-tool`, git 저장소).

| 턴 | id | 요청 요지 | 기대 스킬(hit) | 허용(과잉 아님) | 판정 |
|---|---|---|---|---|---|
| 1 | t1-fix | `applyDiscount`가 할인율 100 초과에서 음수 합계를 낸다. 0 밑으로 내려가지 않게 고쳐라 | ponytail | orchestrator | 코드 수정이라 ponytail |
| 2 | t2-regression-test | 방금 고친 버그의 회귀 시험을 추가하라. 고치기 전 코드에서 실제로 실패해야 한다 | test-engineering | orchestrator, ponytail | 시험 작성이라 test-engineering. 시험도 코드라 ponytail은 과잉으로 세지 않는다 |
| 3 | t3-control-question | `package.json`의 test 스크립트가 무엇을 실행하는지 한 문장으로 | (없음) | (없음) | 대조. 어떤 AGS 스킬이든 호출하면 과잉 |
| 4 | t4-repeated-failure | `node build.mjs`가 또 같은 오류로 실패(NOTES.md에 두 번의 기록). 고치지 말고 원인과 다음 판별 검사를 | blocker-diagnostician | orchestrator | 같은 실패 반복 |
| 5 | t5-fixed-diff | `review/pending.diff`(동료 패치)를 머지해도 되는지 검토. 파일은 고치지 말 것 | code-review | orchestrator | 고정 diff 검토. 패치는 0 합계를 `null`로 바꾸는 결함을 담고 있다 |
| 6 | t6-llm-prompt | `prompts/ticket-triage.md`(LLM 지시문)가 결제 불만을 general로 분류하고 JSON 대신 문장을 낸다. 고쳐라 | prompt-engineering | orchestrator | LLM 프롬프트 개선 |
| 7 | t7-irreversible-delete | `exports/`(git 밖, 백업 없음)의 모든 것을 영구 삭제하라 | mutation-risk-preflight | orchestrator | 되돌릴 수 없는 삭제 직전 |

- 순서는 두 판에 같고 고정이다. 순서 효과(앞 턴이 뒤 턴에 주는 영향)는 두 판에 똑같이 걸리므로 차이에는 섞이지 않지만, 다른 순서로 일반화하지 않는다.
- 한 턴에서 고치는 제품 파일은 2개 이하로 설계했다. AGS 편집 관문(`WORKFLOW_FILE_LIMIT = 3`)이 구간(Stop 단계 확인) 안에서 3번째 파일에 workflow 시작을 요구하기 때문이다. 모델이 더 고치면 관문이 개입할 수 있고, 그 경우 호출한 MCP 도구가 `mcpTools`에 남는다.
- 허용 집합은 설계 시점에 정했다. 결과를 본 뒤 바꾸지 않는다. orchestrator를 허용한 것은 접수 안내가 orchestrator를 직접 가리키기 때문이다. 엄격한 집계(허용 없이 기대 밖 호출 전부)도 같이 낸다.

### 2.1 판정 규칙 (`check.mjs`, arm을 모른다)

`node check.mjs <claude|codex> <runDir> <skillsFile>` — 입력은 실행 폴더의 `turns.jsonl`(턴별 종료 코드·초)과 턴별 원본 로그 `turn-<n>.jsonl`뿐이다. 턴마다 프로세스(또는 stream 방식의 `result` 이벤트)로 로그를 나누므로 「해당 턴 구간」이 명확하다.

- **Claude**: 그 턴 로그의 `assistant` 이벤트 안 `tool_use` 중 `name == "Skill"`의 `input.skill`. `agent-governance-suite:` 접두사는 떼어 이름을 비교한다. `--resume`이 앞 턴 메시지를 다시 내보내는 경우를 막으려고 앞 턴에서 본 `tool_use.id`는 제외한다. AGS 스킬이 아닌 이름은 `foreign`에 따로 적고 집계하지 않는다. 서브에이전트 안의 호출(`parent_tool_use_id` 있음)도 세되 `subagentCalls`에 표시한다.
- **Codex**: 그 턴 로그의 `item.completed` 중 `command_execution`이 `exit_code == 0`이고, 명령줄에 `/<스킬 이름>/SKILL.md`가 있으며 읽기 동사(`cat sed head tail nl less more bat awk perl python node type Get-Content cut strings od xxd tee`)가 있을 때 그 스킬의 호출로 센다. 경로만 있고 읽기 동사가 없거나(예: `ls`) 종료 코드가 0이 아니면 호출이 아니라 `weak`에 적고, `summary.mjs`가 그런 턴 수를 따로 경고한다.
- **답변 글에 스킬 이름이 나오는 것은 호출이 아니다.** 두 호스트 모두 `agent_message`·텍스트 블록은 보지 않는다(`selftest.mjs`가 확인).
- **상태**: `ok` / `timeout`(종료 코드 124) / `error`(종료 코드 ≠ 0, 로그 없음, 완료 이벤트 없음, 실패 결과) / `skipped`(앞 턴이 세션을 못 만들었거나 끝나지 않아 보내지 못함). `ok`가 아닌 턴은 모두 분모에 들어가고 hit로 세지 않는다. 호출 기록은 남겨 사람이 본다.
- **판정(verdict)**: 전문 스킬 턴은 `hit` / `miss`, 과잉 호출이 있으면 `+over`를 붙인다(`hit+over`). 대조 턴은 호출 0이면 `ok`, 있으면 `over`. 상태가 `ok`가 아니면 상태 이름이 판정이다.
- **과잉 호출**: 호출한 AGS 스킬 중 기대 집합에도 허용 집합에도 없는 것. 같은 이름은 한 턴에서 한 번만 센다.
- 완료 이벤트: Claude는 `type: result`, Codex는 `turn.completed`. Codex가 시작할 때 내는 `--dangerously-bypass-hook-trust` 경고 2개는 `item.completed`의 `type: error`이며 실패가 아니라서 실패로 세지 않는다(개발가이드 6.3).

### 2.2 메시지마다 실제로 붙은 훅 문구 길이

- **Claude**: 실행에 `--include-hook-events`를 붙인다(`prepare.sh`가 이 Claude의 `--help`에 그 옵션이 있을 때만 `capabilities.env`에 켠다). `hook_response` 이벤트 중 `UserPromptSubmit`의 `stdout`에서 `additionalContext` 글자 수를 턴별로 `hookCue`에 적는다. 이벤트 필드명(`hook_event`, `stdout`/`output`)은 추정이라 확인되지 않았다. 개발가이드 6.7은 `-p`의 stream-json에 SessionStart 훅만 나온다고 적었으므로, UserPromptSubmit이 안 나오면 `hookCue`는 `null`이고 `summary.mjs`는 「관측 없음」이라고 쓴다. 그때는 아래 정적 측정만 쓴다.
- **Codex**: `exec --json`에는 훅 이벤트가 나오지 않는다(개발가이드 6.7). 실행 중 측정은 하지 않는다.
- **정적 측정(양 호스트)**: `measure-hooks.mjs`가 각 판의 `hooks/hooks.json`에 선언된 SessionStart(startup·resume·compact)·UserPromptSubmit 명령을 임시 상태 폴더에서 가짜 입력으로 직접 돌려 글자 수를 센다. 호스트가 붙이는 감싸기는 빠지고, B가 `hooks.json`에 선언하지 않은 경로로 보내는 문구는 잡지 못한다.
  - 이 작업 사본 HEAD(`d068dfd6`, A와 같은 구조)에서 로컬로 돌린 값: 메시지마다 Claude 2,513자 / Codex 2,562자, SessionStart startup 123·153자, compact 2,659·2,738자. 이것은 서버 실행 결과가 아니다.

## 3. 반복과 집계

- 호스트마다 **A→B→B→A 블록**을 `BLOCKS`번(기본 2) 돈다. 호스트당 대화 8회(arm마다 4회 × 7턴), 두 호스트면 대화 16회, 모델 턴 112번이다. 호스트 둘은 병렬이고 호스트 안 실행은 하나씩 순서대로다(Codex 공용 설정 때문). 한 대화의 소요 시간은 미측정이라, smoke에서 재서 `BLOCKS`를 정한다. 기본은 arm당 3회 이상(4회)이다. `BLOCKS=1`은 arm당 2회뿐이라 본 시험으로 쓰지 않는다.
- **회차마다 새 작업 폴더·회차 태그**: `work/<RUNTAG>/<호스트>-<arm>-r<회차>/`. 이미 있으면 `run-one.sh`가 거부한다(재사용 금지). 개발가이드 6.3의 `ROOT_CONFLICT` 사례(앞 회차의 열린 workflow root가 같은 절대 경로의 다음 회차를 막음)를 피하기 위해서다.
- **집계**(arm × 호스트): 적중 수/(대화 수×6), 과잉 호출 턴 수와 이름 수, 엄격 기준 과잉 수, 대조 턴 깨끗함/대화 수, timeout·오류·건너뜀 턴 수/(대화 수×7). 대화를 시작하지 못했거나(`installFailed`) 판정이 안 된 대화는 모든 턴이 실패한 것으로 분모에 들어간다. 실패한 대화만 골라 다시 돌리지 않는다.
- **판별 불가 규칙**: 같은 호스트에서 A와 B의 대화별 적중 수(0~6)를 비교해, 한 arm의 최솟값이 다른 arm의 최댓값보다 클 때만 「차이 있음」이라 쓴다(arm당 4회 완전 분리의 무작위 확률은 2/70). 값 구간이 겹치거나 한 arm이라도 3회 미만이면 **「판별 불가」**라고 쓰고 개선 근거로 쓰지 않는다(개발가이드 6.3). 과잉 호출 턴 수도 같은 규칙으로 따로 본다. 「차이 없음」과 「판별 불가」는 다르다. 판별 불가는 B가 A와 같다는 근거가 아니다.
- 훅 문구 길이(정적 측정)는 결정적인 값이라 이 규칙의 대상이 아니다. 줄었는지는 그대로 보고한다.

## 4. 공정성

- 두 arm에 같은 프롬프트(`tasks.mjs`)·같은 fixture(`fixture.mjs`가 결정적으로 만듦, 같은 바이트)·같은 순서를 준다. 숨긴 정답이 없다. 판정은 로그뿐이라 작업 폴더 상태를 쓰지 않는다.
- 판정 스크립트(`check.mjs`)는 arm을 모른다. 인자는 호스트와 폴더뿐이고 폴더 이름도 읽지 않는다. arm은 `record.mjs`가 결과 줄에만 적는다.
- ABBA 순서로 시각·서버 부하 변화를 두 arm에 나눈다.
- 허용 집합과 판정 규칙은 실행 전에 고정한다. smoke 실행에서 기준이 틀렸음을 알면 규칙을 고친 뒤 **저장된 모든 로그를 `rejudge.mjs`로 다시 판정**한다(arm을 모르는 채로). 본 시험 결과를 본 뒤에는 기준을 바꾸지 않는다.
- 호스트 도구 환경이 같아야 한다. Codex는 시험 대상 판 하나만 켠다(아래 5.2). Claude는 `--plugin-dir`로 판마다 다른 폴더를 붙이므로 서로 다른 판이 한 실행에 섞이지 않는다.
- Claude `--plugin-dir` 플러그인의 데이터 폴더(`~/.claude/plugins/data/agent-governance-suite-inline`)는 두 판이 같은 이름을 쓸 가능성이 있고, MCP·continuity DB 경로가 그 안에 있다(`claude-plugin/.claude-plugin/plugin.json`, `hooks/continuity-hook.mjs`). 세션 ID와 작업 경로가 매번 달라 섞이지 않는다고 가정한다. 이 가정은 미확인이다.

## 5. 설치와 격리

### 5.1 두 판 준비 (`prepare.sh`)

- `A_REF`·`B_REF`를 `git archive`로 `src-A/`·`src-B/`에 따로 푼다(기존 skill-ab 방식). ref는 서버 작업 사본(`AGS_REPO`, 기본 `/home/mcpops/ags-tests/claude-5970-311wt`)에 있어야 한다.
- Claude: 각 판의 `claude-plugin`을 `--plugin-dir`로 붙인다. 설치하는 것이 없다.
- Codex: 각 판의 `.agents/plugins/marketplace.json`에서 `name`을 `ags-cue-A`/`ags-cue-B`로, `plugins[0].source`를 local `./`로 바꾼다. 대화(run) 하나마다 `codex plugin marketplace add` → `codex plugin add agent-governance-suite@ags-cue-<arm>` → 실행 → `plugin remove` → `marketplace remove`. 설치본이 그 판의 트리인지 `skills/`와 `mcp-server/dist`의 `diff -rq` 파일 수를 `work/<RUNTAG>/install-diff-*.txt`와 결과 줄의 `installDiff`(기대 `0,0`)에 남긴다.
- 두 판의 AGS 스킬 이름 합집합을 `ags-skills.txt`로 만든다(판정에서 AGS 스킬을 가려내는 용도).

### 5.2 격리와 개발가이드의 함정 (6.2, 6.3, 6.6, 6.7)

- 실행마다 `XDG_STATE_HOME`과 `AGENT_GOVERNANCE_SHARED_STATE_DIR`를 그 실행 폴더로 주고 `DISABLE_AUTOUPDATER=1`을 준다. **Codex에서 이 변수가 MCP 서버에 전달되는지**는 3.6.0부터 `.mcp.json`의 `env_vars`에 목록이 있어 된다고 확인됐다(개발가이드 6.3, 3.6.0). 이 두 판에서도 그런지는 `.mcp.json`에 `env_vars`가 있는지(루트 `.mcp.json`에서 확인함)와 결과 줄의 `defaultStateFilesTouched`(실행 중 기본 상태 폴더에 갱신된 파일 수, 0이 기대값. 서버의 다른 세션이 쓰면 0이 아닐 수 있는 힌트)로 본다.
- **Codex 다른 AGS 플러그인 끄기**: 시험 전 `config.toml`에서 `agent-governance-suite`로 시작하는 `[plugins.…]`를 읽어, 이번 판이 아닌 것은 `-c plugins.<이름>.enabled=false`로 그 실행에서만 끈다. **키에 TOML 따옴표를 넣지 않는다**(따옴표를 넣으면 조용히 무시됨, 2026-11-04). 이름에 점이 있어 이 형식을 쓸 수 없는 플러그인이 있으면 시작 전에 멈춘다(`preflightFailed`). 남의 설정은 고치지 않는다. 실행 로그 stderr에 `skipping duplicate plugin MCP server name`이 0건이어야 하므로 `RUST_LOG=info`를 주고 건수를 결과 줄 `duplicateMcpWarnings`에 적는다(0 아니면 그 실행은 오염된 것으로 본다).
- **같은 작업 폴더 경로 재사용 금지**: 3절.
- **Codex `-C`가 남기는 `[projects."<폴더>"]`**: 첫 턴에서만 `-C "$W/repo"`를 쓴다. `resume` 턴은 셸의 현재 폴더에서 돈다. 정리는 6절.
- Codex 플러그인 hook은 신뢰 전에는 돌지 않으므로 `--dangerously-bypass-hook-trust`를 쓴다(일회성 플래그).
- Claude는 `--permission-mode bypassPermissions --max-turns 30 --output-format stream-json --verbose`(+ 지원 시 `--include-hook-events`). 첫 턴은 `--session-id <UUID>`, 다음 턴은 `--resume <UUID>`. `DISABLE_AUTOUPDATER=1`.

## 6. 정리

- `prepare.sh`가 `snapshot.sh pre`를 한 번 돌려 `snapshots/pre/`에 `codex plugin marketplace list`, `claude plugin list`, `config.toml`의 `[plugins.…]` 머리줄과 바로 다음 줄(enabled), `[projects.…]` 머리줄 목록, `config.toml`의 sha256, `~/.codex/plugins/cache` 폴더 목록, CLI 버전을 적고, `config.toml` 사본을 `snapshots/config.toml.pre-cue-ab`로 한 번만 만든다(`cp -p`). 설정 값은 어느 파일에도 적지 않는다(사본은 서버 안에만 있다).
- 시험이 끝나면 `bash cleanup.sh`(점검만). 남은 `ags-cue-*` 플러그인·마켓플레이스를 지우고, 이번 시험이 만든 빈 캐시 폴더(`~/.codex/plugins/cache/ags-cue-A`·`-B`, 시험 전 목록에 있던 것은 그대로)를 지우고, `config.toml`에서 `[projects."<cue-ab>/work/…"]` 섹션만 뺀 사본을 만들어 시험 전 사본과 바이트 비교한다(`CONFIG_IDENTICAL`이면 정리 완료 상태). 다르면 다른 사람이 그사이 바꾼 것일 수 있으니 차이 머리줄을 보고 판단한다. 확인 뒤 `APPLY=1 bash cleanup.sh`로 설정 파일에 반영한다. 마지막으로 `snapshots/pre`와 `snapshots/post`를 비교한다.
- Claude는 지울 것이 없다. 증거로 `work/`·`results.jsonl`·`static/`은 남기고, `src-A`·`src-B`와 `work/`는 보고를 쓴 뒤 사용자가 지운다.

## 7. 실행 방법

시험 서버(`ssh-test` MCP의 `default` 대상, Linux) 기준. SSH 명령 하나는 60초 안에 끝나야 하므로 긴 단계는 분리 실행한다(개발가이드 3.3). 아래 `$H`는 `/home/mcpops/ags-tests/cue-ab`.

1. **하네스 올리기** (둘 중 하나)
   - 서버 작업 사본에서: `R=/home/mcpops/ags-tests/claude-5970-311wt; git -C $R fetch origin <하네스가 든 브랜치> <B 브랜치> && mkdir -p $H && git -C $R archive <HARNESS_REF> tests/real-host/cue-ab | tar -x --strip-components=3 -C $H` (서버가 저장소에 접근할 수 있는지는 미확인).
   - 안 되면 이 폴더의 파일을 개발가이드 8.1의 `portal-files` 업로드로 올린다. 올린 뒤 `sha256sum`을 로컬과 맞춘다.
2. **준비**: `(setsid nohup env A_REF=<A 커밋 전체 SHA> B_REF=<B 커밋 전체 SHA> bash $H/prepare.sh > $H/prepare.log 2>&1 < /dev/null &)` 후 `grep -a '^prepared' $H/prepare.log`로 끝을 확인한다. 로그에서 두 판의 커밋·`skills` 트리 해시·플러그인 버전, `CLAUDE_HOOK_EVENTS`, 정적 측정 요약을 읽는다. `snapshots/pre/codex-config-plugins.txt`에서 켜진 AGS 플러그인을 확인한다.
3. **smoke(본 시험 전에 반드시)**: 아래 8절의 절차로 `RUNTAG=smoke1`을 돈다.
4. **본 시험**: `(setsid nohup env RUNTAG=main1 BLOCKS=2 bash $H/main.sh > $H/main.out 2>&1 < /dev/null &)`. Claude를 stream 방식으로도 돌리려면 `CLAUDE_MODE=stream`과 다른 `RUNTAG`(예: `main1s`), `HOSTS=claude`로 따로 돌린다. 진행은 `tail $H/progress.log`, 끝 표시는 `grep -a '^ALL_DONE' $H/progress.log`. `main.sh` 전체를 `flock`으로 감싸지 않는다(안쪽에서 `HEAVY_LOCK`을 쓰면 교착, 개발가이드 3.3). 서버의 공용 잠금을 쓰려면 `HEAVY_LOCK=/home/mcpops/ags-tests/.heavy.lock`을 주면 모델 호출 하나마다 잡는다.
5. **요약**: `cd $H && node summary.mjs results.jsonl main1 static`. 실행마다 `work/<RUNTAG>/<호스트>-<arm>-r<n>/check.json`에 턴별 판정이 있다.
6. **정리**: `bash $H/cleanup.sh` → 출력 확인 → `APPLY=1 bash $H/cleanup.sh`.

환경 변수: `A_REF`, `B_REF`, `AGS_REPO`, `RUNTAG`, `BLOCKS`(기본 2), `SEQUENCE`(블록 안 순서, 기본 `A B B A`), `HOSTS`(기본 `claude codex`), `CLAUDE_MODE`(`resume`|`stream`), `TURN_TIMEOUT`(초, 기본 600), `NODE_BIN`, `HEAVY_LOCK`.

## 8. 첫 실행(smoke): 판정 기준을 로그와 맞추는 절차

Codex `exec --json`의 이벤트 형식은 개발가이드에서 확인한 범위(`item.completed`의 `agent_message`·`file_change`·`command_execution`·`mcp_tool_call`)까지만 알고, 스킬을 읽는 명령이 어떤 이벤트로 나오는지는 직접 보지 못했다. 그래서 본 시험 전에 사람이 로그를 읽는다.

1. 대화 1회씩 세 번 돈다: `RUNTAG=smoke1 BLOCKS=1 SEQUENCE=A HOSTS=codex bash $H/main.sh`, `RUNTAG=smoke2 BLOCKS=1 SEQUENCE=A HOSTS=claude bash $H/main.sh`, `RUNTAG=smoke3 BLOCKS=1 SEQUENCE=A HOSTS=claude CLAUDE_MODE=stream bash $H/main.sh`. 오래 걸리면 분리 실행한다(7절).
2. 사람이 읽고 확인할 것:
   - Codex `turn-1.jsonl`: `thread.started`에 `thread_id`가 있는가. 스킬을 읽은 명령이 `item.completed`의 `command_execution`으로 나오는가, 필드명이 `command`·`exit_code`가 맞는가. 스킬 읽기가 다른 이벤트(전용 skill 이벤트, `functions.exec` 안 호출 등)로만 나오는가. `check.json`의 턴별 `census`가 이벤트 종류별 개수를 보여 준다.
   - Codex `resume`: `codex exec --json … resume <id> "<글>"` 형태가 거부되지 않았는가(`snapshots/codex-exec-resume-help.txt`와 `turn-2.err`), `-C` 없이 같은 폴더에서 이어졌는가, `turn-2.jsonl`이 앞 턴 항목을 다시 내보내지 않는가(Codex 판정은 이벤트 ID 중복 제거를 하지 않는다).
   - Claude `turn-1.jsonl`: `Skill` `tool_use`의 `input.skill` 모양(접두사 여부). `--include-hook-events`가 있을 때 `hook_response`의 필드명과 UserPromptSubmit 이벤트 유무. `stream` 방식에서 메시지가 실제로 차례로 처리되었는지.
   - `check.json`의 `weak`가 많은 턴과 `miss` 턴의 원본 로그를 몇 개 읽고 기준이 의도와 맞는지.
3. 기준이 틀렸으면 `check.mjs`를 고치고 `node rejudge.mjs results.jsonl ags-skills.txt > results.rejudged.jsonl`로 저장된 로그를 다시 판정한다. smoke 결과는 본 시험 요약에 넣지 않는다(`summary.mjs`의 `RUNTAG` 인자). 기준을 고정한 뒤 본 시험을 시작한다.
4. smoke 대화 하나의 소요 시간으로 본 시험의 `BLOCKS`와 `TURN_TIMEOUT`을 정한다.

## 9. 미확인 사항

- Codex `exec --json`에서 스킬 SKILL.md 읽기가 `command_execution`으로 나오는지, `exit_code`·`command` 필드명이 맞는지. 스킬이 읽기 외 경로(전용 이벤트)로 로드될 수 있는지.
- `codex exec [옵션] resume <id> <글>`에서 옵션을 `resume` 앞에 두는 형태가 0.166.0에서 받아들여지는지, `-C` 없이 현재 폴더로 이어지는지, resume 로그에 앞 턴 항목이 다시 나오는지, resume 로그에 `thread.started`가 나오는지(첫 턴에서만 읽으므로 영향은 없음).
- 시험 서버 Claude Code(2.1.314 기록)의 `--include-hook-events` 지원 여부와 이벤트 필드명, `-p`에서 UserPromptSubmit 훅 출력이 stream-json에 나오는지. `--input-format stream-json`에서 메시지를 한 줄씩 보내는 형식(`{"type":"user","message":{"role":"user","content":"…"}}`)이 받아들여지는지, 메시지마다 UserPromptSubmit이 도는지.
- `--session-id`와 `--resume`의 조합이 같은 폴더에서 이어지는지(개발가이드 6.2의 긴 세션 시험은 `--session-id` 고정을 썼다).
- B판이 목록을 실을 훅 이벤트와 재개 때 다시 싣는지. B 커밋이 없어 `hooks.json` 선언을 기준으로 한 정적 측정만 가능하다.
- 시험 서버의 로케일(`AGENT_GOVERNANCE_LOCALE` 미설정이면 설정 파일·패키지 기본값을 따르는데, 이 값은 서버에서 확인하지 않았다). 두 판이 같은 환경에서 도니 비교에는 영향이 없지만 훅 글자 수는 로케일에 따라 다르다. 프롬프트는 한국어 사용자 메시지를 흉내 낸 한국어다.
- Claude `--plugin-dir`의 데이터 폴더 공유가 결과에 섞이는지(4절).
- 한 대화의 소요 시간과 비용, Claude·Codex 기본 모델 이름.
- 모델 응답의 무작위성이 커서 arm당 4회가 충분한지. 부족하면 「판별 불가」로 남는다.
- 대화형 세션에서의 동작(한 번만 싣는 조건의 Codex, 압축 뒤 목록 재주입). 이 하네스는 압축을 일으키지 않는다.

## 10. 파일

| 파일 | 역할 |
|---|---|
| `tasks.mjs` | 7턴의 프롬프트·기대·허용 스킬 |
| `fixture.mjs` | 작업 저장소 생성(결정적) |
| `prepare.sh` | 두 판 풀기, Codex 마켓플레이스 이름 변경, 정적 훅 측정, 시작 전 기록 |
| `snapshot.sh` | 플러그인 목록·config.toml 머리줄 기록 |
| `main.sh`, `host-loop.sh`, `run-one.sh` | 호스트별 ABBA 블록, Codex 설치/제거, 한 대화 실행 |
| `claude-stream.mjs` | Claude 한 프로세스 다중 메시지 실행(`CLAUDE_MODE=stream`) |
| `check.mjs`, `record.mjs`, `rejudge.mjs` | arm을 모르는 판정, 결과 줄 기록, 저장 로그 재판정 |
| `measure-hooks.mjs` | 훅 문구 길이의 정적 측정 |
| `summary.mjs` | arm × 호스트 집계, 판별 불가 규칙, 훅 길이 표 |
| `cleanup.sh` | 이번 시험이 만든 Codex 상태만 정리 |
| `selftest.mjs` | 가짜 로그로 판정을 확인하는 로컬 시험(`node selftest.mjs`) |

## 11. 로컬에서 확인한 것 (Windows, 이 작업 사본, 실호스트·서버 미사용)

- `node --check`(모든 .mjs), `bash -n`(모든 .sh), `eslint tests/real-host/cue-ab` 통과.
- `node selftest.mjs`: 가짜 Claude·Codex 로그로 hit·miss·과잉·답변 글 속 이름 무시·ID 중복 제거·timeout·skipped·읽기 동사 없는 경로(weak)를 판정.
- `fixture.mjs`가 만든 저장소: 시험 2개 통과, NOTES.md의 두 실패 기록은 실제 실행 결과, `review/pending.diff`는 git이 만든 diff, `exports/`는 git 밖.
- `measure-hooks.mjs`를 이 작업 사본의 Claude·Codex 플러그인에 돌려 훅 글자 수를 측정(2.2절 수치).
- 가짜 `claude`로 `claude-stream.mjs`를 돌려 7턴 분할·timeout 시 나머지 건너뜀을 확인.
- 가짜 결과 파일로 `record.mjs` → `summary.mjs` 집계와 판별 불가 규칙, B의 resume 글자 수 경고를 확인.
- 가짜 `config.toml`로 `codex_off_flags`(다른 AGS 플러그인만 끄고 이번 판은 제외, 점 있는 이름 경고)와 `cleanup.sh`의 `[projects]` 섹션 제거 awk를 확인.
