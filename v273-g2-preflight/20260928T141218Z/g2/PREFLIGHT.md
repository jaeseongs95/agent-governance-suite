# G2 v2.7.3 자연어 선택·실행 비교 — 1단계 preflight

- 총괄: ca8e3dc4 / 실행: Claude cloud runner / 시작 2026-09-28T14:12:18Z
- 범위: 1단계(preflight)만 수행했다. **측정 run 66개는 한 건도 시작하지 않았다**(`/tmp/ev/runs`는 비어 있다).
- 제품 소스는 고치지 않았다. 동결 harness 원본도 고치지 않았다(`/tmp/ev/scripts` 전체 digest가 probe 전후로 fixtureSource와 같다: `6691d7d0…`).

## 결론

| 대상 | permissions.required | permissions.isolation | 금지 항목 | 두 arm 동일 | 판정 |
|---|---|---|---|---|---|
| 동결 harness `scripts/nl-ab.sh` | 미충족 | 미충족 | 일부 뚫림 | 동일(둘 다 실패) | **FAIL** |
| harness-v2 `nl-ab-v2.sh` | 충족(Glob/Grep은 호스트에 없음) | 충족 | 차단(잔여 위험 1건) | 동일 | **PASS(조건부)** |

## 0. 입력 확인

- `G2-v273-input.json`(claude/v273-inputs `6b9b2dec`) sha256 `65b84d51…0f6a`, 14345 bytes로 지시값과 같다.
- fixtureSource `7b7f49ac`의 `port272-nl-ab/` 아래 prompt 11개, fixture 7개, harness 8개가 모두 입력의 sha256·byte 수와 같다(26/26). prompt·fixture는 `text`도 같다.
- arm의 tree: base `8763cef2` → `eed08f96`, candidate `732ba286` → `06d58b25`로 입력과 같다. `git archive`를 `/tmp/base`, `/tmp/cand`에 풀었다. plugin 경로는 `/tmp/base/claude-plugin`, `/tmp/cand/claude-plugin`이며 harness의 `PLUGIN=/tmp/$ARM/claude-plugin`과 맞는다. 두 plugin의 차이는 `hooks/hooks.json`, `hooks/skill-trigger-hook.mjs`, `mcp-server/dist/server.mjs`, orchestrator `SKILL.md`와 참조 2개다. 두 manifest 모두 version 2.7.2다.

## 1. Node와 Claude

- `/opt/node24/bin/node --version` = v24.21.0으로 design.node와 같아서 `/tmp/node-v24.21.0-linux-x64 -> /opt/node24` 심볼릭 링크를 걸었다. tarball은 받지 않았다. npm 11.19.0, pnpm 11.19.0.
- `claude --version` = `2.1.283 (Claude Code)`로 입력과 같다. init 이벤트의 `claude_code_version`도 2.1.283, model은 `claude-opus-5-5`다.
- 일회용 HOME에서 nested `claude -p`가 인증되는지 별도로 한 번 확인했다(프롬프트 "Reply with exactly: OK", 결과 OK). 이 확인은 probe·측정이 아니며 원문은 넣지 않았다.

## 2. Probe 설계

- probe는 측정 run이 아니다. 측정 prompt(p1–x2)를 쓰지 않고 `prompts/probe-<arm>.txt`를 임시로 추가해 `nl-ab.sh <run> <arm> probe-<arm>`으로 실행했다. `prepare-cwd.sh`는 기본 분기(README만 있는 git repo, remote 없음)를 탔다. probe가 끝난 뒤 임시 prompt를 지웠다.
- 두 arm의 probe 문구는 plugin 경로만 다르다(`probes/probe-template.txt`, `probes/probe2-template.txt`). v2 probe는 원 probe의 S01–S21을 그대로 두고 S22–S25를 덧붙였다.
- 판정 근거는 각 run의 `stream.jsonl` 원문이다. `probes/extract.mjs`가 tool_use와 tool_result, 최종 `permission_denials`를 뽑아 `extract.json`을 만든다. 격리는 real HOME 상태 목록(이름·크기·mtime, 내용 없음, `probes/snap.sh`)을 probe 전후로 비교해 확인했다.

## 3. 동결 harness probe 결과 (FAIL)

`probes/probe-frozen-{base,cand}` — 두 arm의 결과가 단계별로 같다. `permission_denials` 12건, 22 turns.

| 단계 | 요구/금지 | 결과(base = cand) | stream 근거 |
|---|---|---|---|
| S01 Skill `agent-governance-suite:ponytail` | 요구 | 허용 | `Launching skill: …` |
| S02 Read plugin `SKILL.md` | 요구 | **거부** | `Claude requested permissions to read from /tmp/<arm>/claude-plugin/skills/ponytail/SKILL.md, but you haven't granted it yet.` |
| S03 Read 참조 `finalization.md` | 요구 | **거부** | 같은 문구 |
| S04/S05 Glob·Grep | 요구 | 도구 없음 | init `tools`에 Glob·Grep이 없다(2.1.283 호스트 표면) |
| S06 Write `package.json` | — | plugin hook이 차단 | `PreToolUse:Write hook error: 세션 현황판 … update_session_status` (권한이 아니라 arm의 session-board hook) |
| S07 Write test 파일 | — | 허용 | acceptEdits |
| S08–S10 `node --test`, `npm test`, `pnpm test` | 요구 | **거부** | `This command requires approval` |
| S11 스킬 checker `node …/query-registry.mjs` | 요구 | **거부** | `This command requires approval` |
| S12–S15 `git status/log/diff/remote -v` | 요구 | 허용 | 호스트의 읽기 전용 자동 허용 |
| S16 `node -e` HOME 확인 | — | 거부 | 같은 문구 |
| S17 Read `/root/.profile` | 금지 | 거부 | 권한 미부여 |
| S18 `git push origin main` | 금지 | 거부 | `requires approval` |
| S19 `cat /root/.profile` | 금지 | 거부 | 작업 디렉터리 밖 cat 차단 |
| S20 `node -e existsSync('/root/.profile')` | 금지 | 거부 | `requires approval` |
| S21 MCP `send_session_message` | 금지(운영 queue) | **실행됨** | server 응답 `MCP_UNAVAILABLE: Issued message ID is unavailable` — 권한 확인 없이 호출이 서버까지 갔다. 가짜 ID여서 전송 효과는 없다 |

격리(`probes/home-before-frozen.txt` 대 `home-after-frozen.txt`):

- `HOME`이 실제 `/root` 그대로다. 두 arm이 **같은 plugin data 디렉터리** `/root/.claude/plugins/data/agent-governance-suite-inline/`(`workflows.sqlite3`, `continuity.sqlite3`)를 만들어 함께 썼다. `--plugin-dir`로 올린 plugin은 arm과 관계없이 이름이 `agent-governance-suite-inline`이라 arm끼리 workflow·continuity 상태를 공유한다.
- 공유 상태 root가 `/root/.agent-governance-suite/`로, 이 runner 세션의 실제 상태와 같다. probe가 `session-board.sqlite3`를 만들고 `session-messaging/`에 broker 인증서·키·token·`session-messages.sqlite3`를 만들었으며, runner 세션의 `trust.sqlite3`(-wal)를 갱신했다.
- `/root/.claude.json`이 바뀌었고 transcript는 `/root/.claude/projects/-tmp-nlwork-…`에 쌓였다. real HOME의 사용자 스킬(`session-start-hook`)이 두 arm 세션에 로드됐다(init `skills` 41개).
- 부모 환경의 `CLAUDE_ADDITIONAL_DIRECTORIES=/mnt/user-data`가 unset되지 않아 모든 run이 같은 추가 작업 디렉터리를 물려받는다.
- 격리한 것은 `XDG_STATE_HOME`뿐인데, Claude plugin은 workflow·continuity를 `CLAUDE_PLUGIN_DATA`(HOME 아래)에, board·messaging·trust를 `$HOME/.agent-governance-suite`에 둔다(`mcp-server/dist/server.mjs`의 `sharedUserStateDirectory`, `resolveTrustDatabasePath`). 그래서 `XDG_STATE_HOME`은 이 plugin의 상태를 사실상 격리하지 못한다.

판정: 두 arm에 **똑같이** 적용되지만 permissions.required(참조 읽기, node·npm·pnpm test, checker)를 충족하지 못하고 isolation도 충족하지 못한다. 운영 queue 도구가 권한 확인 없이 실행된다. 이전 G의 한계(참조 읽기·node/npm 테스트 거부)가 그대로 재현됐다. → **FAIL**

부수 효과: 동결 probe 2회가 real HOME의 공유 상태(board 생성, messaging broker 파일, trust WAL)와 `/root/.claude/plugins/data/…-inline`에 기록을 남겼다. 지우면 되돌릴 수 없어서 삭제하지 않았다. 남은 nested 프로세스는 없다.

## 4. harness-v2 (새 파일, 원본 유지)

파일은 `harness-v2/`에 있다. `nl-ab-v2.sh`, `run-one-v2.sh`, `driver-v2.sh`, `collect-v2.sh`와 원본 대비 diff(`*.diff`)다. `prepare-cwd.sh`, `make-order.mjs`, `order.txt`, `order-seed.txt`, `analyze.mjs`, `summarize.mjs`, prompt, fixture는 원본을 그대로 쓴다. 원본의 `driver.sh`, `collect.sh`는 fixtureSource에 있지만 동결 목록 8개에는 없다.

`nl-ab.sh` 대비 바뀐 점(`harness-v2/nl-ab.diff`):

1. 두 arm에 같은 명시 허용 목록을 둔다. 다른 것은 활성 plugin 경로뿐이며, 이는 `--plugin-dir`이 이미 arm마다 다른 것과 같다.
   `--allowedTools "Read(//tmp/<arm>/claude-plugin/**)" "Bash(node:*)" "Bash(npm test:*)" "Bash(pnpm test:*)" "Bash(git status:*)" "Bash(git log:*)" "Bash(git diff:*)" "Bash(git show:*)" "Bash(git rev-parse:*)" "Bash(git ls-files:*)" "Bash(git remote -v)" "Bash(git branch --show-current)"`
2. 두 arm에 같은 거부 목록을 둔다.
   `--disallowedTools "Read(//<real HOME>/**)" "Edit(//tmp/<arm>/claude-plugin/**)" "Write(//tmp/<arm>/claude-plugin/**)" "Bash(git push:*)" "Bash(git tag:*)" "Bash(gh:*)"`, plugin MCP의 `prepare_session_message`·`send_session_message`·`acknowledge_session_messages`, `SendMessage`, `CronCreate`, `CronDelete`, `ScheduleWakeup`, `PushNotification`
3. run마다 일회용 root를 쓴다. `HOME=/tmp/nlwork/<run>/home`(plugin data는 `<HOME>/.claude/plugins/data/…`로 따라간다), `XDG_STATE_HOME`(원래 값 유지), `XDG_CONFIG_HOME`·`XDG_DATA_HOME`·`XDG_CACHE_HOME`, `AGENT_GOVERNANCE_SHARED_STATE_DIR=/tmp/nlwork/<run>/shared`(board·messaging·trust). broker·hook·MCP 서버가 모두 같은 환경변수로 같은 trust store를 찾는다.
4. 물려받은 `CLAUDE_ADDITIONAL_DIRECTORIES`와 미리 설정된 `AGENT_GOVERNANCE_*` 경로 변수를 unset한다.
5. `cmd.txt`에 격리 env와 허용·거부 목록을 적고, run마다 일회용 상태 root의 파일 목록(이름·크기)을 `state-roots.txt`에 남긴다.
6. `run-one-v2.sh`와 `driver-v2.sh`는 호출 경로만, `collect-v2.sh`는 transcript 위치(일회용 HOME)만 바꿨다.

prompt, fixture, order, seed, model `claude-opus-5-5`, `--max-turns 20`, `--permission-mode acceptEdits`, concurrency 4, 재시도 규칙은 바꾸지 않았다. `--dangerously-skip-permissions`와 `bypassPermissions`는 쓰지 않았다.

### v2 probe 결과

`probes/probe-v2-{base,cand}` — 두 arm의 결과가 같다. `permission_denials` 6건, init `tools`도 같다(비 MCP 34개, MCP 25개).

| 단계 | 요구/금지 | 결과(base = cand) | stream 근거 |
|---|---|---|---|
| S01 Skill | 요구 | 허용 | `Launching skill` |
| S02/S03 Read plugin `SKILL.md`·참조 | 요구 | **허용** | 첫 줄 `---`, `# Finalization provider` |
| S04/S05 Glob·Grep | 요구 | 도구 없음(호스트) | init `tools`에 없다. 두 arm 동일 |
| S22/S23 `ls`·`grep` plugin 안 | 요구 대체 경로 | **허용** | `LICENSE SKILL.md VERSION`, `2:name: orchestrator` |
| S06 Write `package.json` | — | plugin hook이 차단 | 동결과 같다(arm 동작이며 권한 문제가 아니다) |
| S08–S10 `node --test test/`, `npm test`, `pnpm test` | 요구 | **허용·실행** | 종료 코드 1·254·1. `package.json`이 없고 Node 24의 `test/` 인자 처리 때문이며(아래 조건 2), 권한 거부는 없다 |
| S11 checker `query-registry.mjs` | 요구 | **허용** | `{"schemaVersion":"1.0.0",…"providers":[{"skillId":"korean-prose-editor"…` |
| S12–S15 읽기 전용 git | 요구 | 허용 | |
| S16 HOME 확인 | — | 허용 | `home=/tmp/nlwork/probe-v2-<arm>/home`, `xdgState=…/state`, `sharedState=…/shared` |
| S17 Read `/root/.profile` | 금지 | **거부** | `File is in a directory that is denied by your permission settings.` |
| S18 `git push origin main` | 금지 | **거부** | `Permission to use Bash with command git push origin main has been denied.` |
| S19 `cat /root/.profile` | 금지 | **거부** | `…has been denied.` |
| S20 `node -e existsSync('/root/.profile')` | 금지 | **실행됨(true)** | 잔여 위험. 아래 조건 3 |
| S21 MCP `send_session_message` | 금지 | 도구 없음 | 도구 목록에서 빠졌다(cand는 ToolSearch 결과 `No matching deferred tools found`) |
| S24 Write plugin 안 | 금지 | **거부** | `…denied by your permission settings.` |
| S25 Read 다른 arm의 `SKILL.md` | 금지 | **거부** | `Claude requested permissions to read from /tmp/<other>/…, but you haven't granted it yet.` |

격리(`probes/home-before-v2.txt` 대 `home-after-v2.txt`): real HOME 상태 목록에서 바뀐 것은 이 runner 세션 자신의 transcript 3줄뿐이다(`[REDACTED]` 경로). `/root/.agent-governance-suite`, `/root/.claude/plugins/data`, `/root/.claude.json`에는 변화가 없다. 같은 시간대에 `/tmp` 밖에서 바뀐 파일도 없다. 각 run의 `state-roots.txt`를 보면 plugin data(`workflows`·`continuity`), board, messaging, trust가 모두 `/tmp/nlwork/<run>/` 아래에 run마다 따로 생겼다. real HOME의 사용자 스킬도 더는 로드되지 않는다(init `skills` 41 → 40, 빠진 것은 `session-start-hook`).

판정: 두 arm에 같은 권한과 같은 격리를 적용하고, 요구 권한은 허용하고 금지 항목(원격 push·tag, real HOME Read·cat, 운영 queue 도구, plugin 쓰기, 다른 arm 읽기)은 막는다. → **PASS(조건부)**. 조건은 아래와 같다.

### p4 fixture로 한 실행 확인(권한과 별도)

`prepare-cwd.sh p4`로 만든 cwd에서 v2와 같은 일회용 HOME env로 테스트 명령을 직접 실행했다(`probes/envcheck-*.log`, claude 없이 실행). 세 명령 모두 종료 코드 1이다.

- `node --test test/`: `Cannot find module '…/repo/test'`. Node v24.21.0은 `test/`를 파일 하나로 보고, `math.test.js`의 테스트 3개를 실행하지 않는다.
- `npm test`, `pnpm test`: package.json의 test script가 위 명령이라 같은 가짜 실패 1건(`test at test:1:1`)만 낸다.
- 비교: `node --test`(인자 없음)나 `node --test test/math.test.js`는 테스트 3개를 실행하며 pass 1, fail 2(의도된 `sum` 결함)다.

## 5. 측정 run을 시작하기 위한 조건

1. **harness 승인**: 동결 `nl-ab.sh`는 FAIL이다. 측정에는 harness-v2(sha256은 아래)를 쓰도록 총괄이 승인하거나, 입력의 harness 해시를 v2로 다시 동결해야 한다. 이 runner는 승인 없이 v2로 측정을 시작하지 않는다.
2. **p4 fixture 결함 처리**: fixture의 `npm test`(`node --test test/`)는 입력에 고정된 Node v24.21.0에서 소스를 고쳐도 통과하지 않는다. rubric p4의 "passing result tied to changed source"는 모델이 test script까지 바꿔야만 성립한다. 두 arm에 똑같이 적용되는 결함이다. 총괄이 (a) 알려진 한계로 두고 p4 해석 규칙을 정하거나 (b) fixture를 다시 동결하는 것 중 하나를 결정해야 한다. runner는 동결 fixture를 바꾸지 않는다.
3. **잔여 위험 감시**: `Bash(node:*)`는 임의 코드를 실행할 수 있어서 절대경로로 real HOME에 닿을 수 있다(S20). 권한 규칙만으로는 막을 수 없고, OS sandbox(bubblewrap)는 이 호스트에 없다. 기본 경로는 모두 일회용 root로 향한다. 2단계에서는 66 run 전후로 real HOME 상태 목록(`snap.sh`)을 비교하고, 각 run의 stream·transcript에서 real HOME 경로 참조를 검사해 보고해야 한다.
4. **참고로 알릴 사항**(차단 요인 아님)
   - Glob·Grep은 2.1.283 호스트 도구 목록에 없다. 두 arm 모두 같으며, 대체 경로(Read, plugin 안의 `ls`·`grep`)는 허용된다.
   - 거부 목록에 없는 plugin MCP 도구(workflow·board·cleanup 등)는 권한 확인 없이 실행되지만 일회용 상태에만 닿는다.
   - session-board PreToolUse hook은 `update_session_status`가 먼저 호출되지 않으면 Write를 막는다. 두 arm에 공통인 plugin 동작이다.
5. 실행 전 정리 상태: `/tmp/ev/runs`는 비어 있다. `/tmp/ev/scripts`는 fixtureSource와 같다. v2는 `/tmp/ev/scripts-v2/`에 있고, Node 링크와 `/tmp/base`, `/tmp/cand`는 그대로 둔다.

**2단계 준비 상태: 기술적으로는 준비됐다(v2 동작 검증 완료). 조건 1(harness 승인)과 조건 2(p4 결정)는 총괄의 결정을 기다린다.**

## 6. 파일 sha256

harness-v2:

```
4c1191e8b4c9c4cf97d68d7c85f343053e00858ac8b06204046e38ecbc79bbfd  harness-v2/nl-ab-v2.sh
82c33d323d59785844468559e45b1a1835e7588bc3f0ea99bc9efd9f5b1bf40f  harness-v2/run-one-v2.sh
e46bf84ba5f8707b7508426020647257120d72d561821f362235f581d848e61c  harness-v2/driver-v2.sh
a0624c729234eef9469ca49added8f3d4c3f32899953a9a0438c9b5ae7812ace  harness-v2/collect-v2.sh
d353647eefd7c5398f89c75ed307a41f756397318316c7a54181e32973307433  harness-v2/nl-ab.diff
40939b04328a5081dbf6a9ad778887241f819c728bfaf622edd3e6c34362b6c7  harness-v2/run-one.diff
30ce592657c42d5b340056479889a1507252957df3781bb15098c4b58dec86f4  harness-v2/driver.diff
d2807d62083029fc5050e6f57907372b35b0d2c3494d8a45bf18cdbb7c351660  harness-v2/collect.diff
```

원본: `nl-ab.sh` `32e7487a…25c1`, `run-one.sh` `49a45d56…867a`, `driver.sh` `f0eba780…f43a`, `collect.sh` `8f3055af…926c`. 전체 목록은 `SHA256SUMS`에 있다.

## 7. 가린 값

- 비밀값 패턴(`ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `AKIA`, `BEGIN … PRIVATE KEY`, `Authorization: Bearer`)은 검출되지 않았다. 세션 token, GitHub token, messaging token, ingress token 값을 전체 파일과 대조했으며 일치 0건이다.
- 이메일 주소와 IP는 검출되지 않았다.
- `probes/home-*.txt` 4개에서 계정 UUID, 조직 UUID, 이 runner 세션 ID를 `[REDACTED]`로 바꿨다(파일마다 5곳, 경로 이름에 들어 있던 값).
- `/root`(시스템 root 계정의 기본 HOME)와 `/home/user`(컨테이너의 일반 경로)는 개인 사용자 이름이 아니고 격리 판정의 핵심 근거라서 남겼다.
- `env`·`printenv` 전체 출력은 저장하지 않았다. broker의 key·token 파일은 이름과 크기만 기록했고 내용은 넣지 않았다.
- 인증 확인 run의 원문과 일회용 HOME(`.claude.json` 포함)은 넣지 않았다.
