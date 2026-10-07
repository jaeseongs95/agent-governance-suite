# AGS Claude Cloud 환경 확인 (env-probe-r1)

- 관측 시각(UTC): 2026-10-07T07:03:16Z ~ 07:03:46Z (`observations.log` 참조)
- 저장소: `jaeseongs95/agent-governance-suite`, 기준 commit `b28a442ad424b255283fe32fe3c0e661b195fa4e`
- 성격: 읽기 전용 환경 관측. install, build, test, 소스 수정, 제품(MCP 도구) 호출은 하지 않았다. 서브에이전트 0, Fable 0.
- 판정 기준: PASS = 기대와 일치, FAIL = 기대와 다름, UNKNOWN = 기대값이 없거나 확인 불가.

## 요약

| # | 항목 | 판정 | 근거 |
|---|------|------|------|
| 1 | 모델·effort | PASS | `claude-opus-5-5` / `high` |
| 2 | host | PASS | Firecracker VM(`/proc/1/comm`=`process_api`), Ubuntu 24.04.5, 4 vCPU, 16 GB |
| 3 | Cloud 표지 | PASS | `CLAUDE_CODE_REMOTE=true`, `CLAUDE_CODE_ENTRYPOINT=remote` |
| 4a | `/opt/node24` | PASS | `v24.21.0` |
| 4b | 기본 `node` | FAIL | PATH의 `node`는 `/opt/node22/bin/node` `v22.22.0`, `engines.node >=24.0.0`과 다름 |
| 4c | pnpm·corepack·python·git | PASS | pnpm `11.19.0`(= `packageManager`), corepack `0.34.0`, Python `3.13.16`, git `2.43.0` |
| 5a | HEAD·tree | PASS | HEAD `b28a442…`, tree `e1ffc736bc999781e7ea0670e43d7eca3bd80a82`(기대값 일치) |
| 5b | 작업 트리 | PASS | `git status --porcelain` 0줄 |
| 5c | 기준 commit fetch·tree | PASS | fetch 성공, tree 기대값 일치 |
| 5d | 원격 ref | PASS | `main`=`b28a442…`, `v2.8.1^{}`=`b28a442…`, `evidence`=`f83d56e…` 존재 |
| 6a | npm registry | PASS | `200` |
| 6b | `https://github.com` | FAIL | `400` (proxy 응답, 아래 참조). git fetch/ls-remote는 정상 |
| 7a | 도구·MCP 목록 | PASS | 아래 목록 |
| 7b | 이전 작업 | PASS | 이 세션의 첫 요청. 이전 작업 없음 |
| 7c | 작업 트리 충돌 | PASS | 다른 세션 프로세스 없음. 작업 트리 cwd 프로세스는 모두 이 세션(`claude` pid 86) 소속 |
| 8 | 설치 후보 | PASS | `package.json`, `pnpm-lock.yaml`, `.mcp.json` 존재, 값은 아래 |

PASS 14, FAIL 2, UNKNOWN 0.

## 1. 모델·effort

- 인식 모델 ID: `claude-opus-5-5`, effort: `high`
- `get_session`(claude-code-remote, 읽기 전용): `configured_model`=`claude-opus-5-5`, `session_context.model`=`claude-opus-5-5`, `effort_level`=`high`, `external_metadata.last_served_model`=`claude-opus-5-5`

## 2. host

- `hostname`=`vm`, `uname -a`=`Linux vm 6.18.44-fc-v77 #1 SMP PREEMPT_DYNAMIC @0 x86_64 x86_64 x86_64 GNU/Linux`
- `/etc/os-release`: Ubuntu 24.04.5 LTS
- `/proc/1/comm`=`process_api` (`--firecracker-init`)
- `nproc`=4, 메모리 16094 MB(swap 0), `df -h .`: `/dev/vda` 252G 중 9.9G 사용, Avail 30G

## 3. Cloud 표지

| 변수 | 값 |
|------|----|
| `CLAUDE_CODE_CONTAINER_ID` | `container_01GbpE3uZmBQfbGw3r3fjKYA` |
| `CLAUDE_CODE_ENTRYPOINT` | `remote` |
| `CLAUDE_CODE_REMOTE` | `true` |
| `CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE` | `cloud_default` |
| `CLAUDE_CODE_REMOTE_HERMETIC_MODE` | `0` |
| `CLAUDE_CODE_REMOTE_SDK_URL` | `https://api.anthropic.com/v1/code/sessions/cse_01SYxtBgrhohfGEbRPonbSkK` |
| `CLAUDE_CODE_REMOTE_SEND_KEEPALIVES` | `true` |
| `CLAUDE_CODE_REMOTE_SESSION_ID` | `cse_01SYxtBgrhohfGEbRPonbSkK` |
| `CLAUDE_CODE_REMOTE_TOOLS_FORWARD` | `1` |
| `CLAUDE_CODE_VERSION` | `2.1.42` |

- 토큰 형태 값: 없음(`<redacted>` 적용 0건). SDK URL은 query string이 없고 경로 끝은 세션 ID다.
- 참고(사실): `get_session`의 `external_metadata.container_cc_version`은 `2.1.292`로, 환경변수 `CLAUDE_CODE_VERSION=2.1.42`와 다르다. 어느 쪽이 실제 실행 중인 CLI 버전인지는 확인하지 않았다.

## 4. 환경(node24)

- `ls -d /opt/node*`: `/opt/node-tools`, `/opt/node20`, `/opt/node21`, `/opt/node22`, `/opt/node24`
- `/opt/node24/bin/node -v`=`v24.21.0`
- `node -v`=`v22.22.0`, `which node`=`/opt/node22/bin/node`
- `which pnpm corepack claude`: 모두 `/opt/node22/bin/` 아래
- 영향(추론): 저장소 명령을 기본 PATH로 실행하면 Node 22에서 돈다. `engines.node >=24.0.0`을 맞추려면 `/opt/node24/bin`을 PATH 앞에 두어야 한다. 실행 중인 플러그인 broker/relay(pid 409, 446)도 `/opt/node22/bin/node`로 떠 있다.

## 5. 저장소

- `git remote -v`: `origin https://github.com/jaeseongs95/agent-governance-suite` (fetch/push)
- 현재 브랜치: `claude/ags-cloud-env-probe-h97a1x` (HEAD는 `main`과 같은 `b28a442…`)
- `git worktree list`: 작업 트리 1개
- `git ls-remote`: `refs/heads/evidence`=`f83d56e2ecd46a5551ad398980c105ca7d405b43`, `refs/heads/main`=`b28a442ad424b255283fe32fe3c0e661b195fa4e`, `refs/tags/v2.8.1`=`42c5477fb1c27f946ee139297fcbb34c970ff99a`(annotated tag 객체), `refs/tags/v2.8.1^{}`=`b28a442ad424b255283fe32fe3c0e661b195fa4e`

## 6. 네트워크

- `https://registry.npmjs.org/pnpm`: `200`
- `https://github.com`: `400`. 보조 확인 결과 proxy CONNECT는 `200 Connection Established`, 이후 응답은 `400 Bad Request`, 본문 `{"message":"Request path could not be canonicalized.", ...}`
- 보조: `https://api.github.com/zen`은 `403`, 본문 `This GitHub API path is not available: sessions are bound to their configured repositories. Use repository-scoped endpoints (repos/{owner}/{repo}/...).`
- 해석(추론): github.com 웹 경로는 세션 proxy가 걸러 내며, 저장소 범위 git 전송(fetch, ls-remote)은 허용된다. 제품 동작에 필요한 경로인지는 이번 범위에서 확인하지 않았다.

## 7. 도구·충돌

### 사용 가능한 도구

- 기본: Agent, Artifact, AskUserQuestion, Bash, Edit, Glob, Grep, ListAgents, Read, ReadNotifications, ReportFindings, ScheduleWakeup, SendUserFile, ShowOnboardingRolePicker, Skill, SuggestSkills, ToolSearch, Workflow, Write
- 지연 로드(ToolSearch 필요): ArtifactComments, ArtifactData, CronCreate, CronDelete, CronList, DesignSync, EnterPlanMode, ExitPlanMode, EnterWorktree, ExitWorktree, ListConnectors, ListMcpResourcesTool, ListPlugins, ListSkills, Monitor, NotebookEdit, PushNotification, ReadMcpResourceDirTool, ReadMcpResourceTool, SearchMcpRegistry, SearchPlugins, SearchSkills, SendMessage, SuggestConnectors, SuggestPluginInstall, TaskCreate, TaskGet, TaskList, TaskStop, TaskUpdate, WebFetch, WebSearch

### 연결된 MCP 서버

| 서버 | 도구 접두사 | 비고 |
|------|-------------|------|
| `claude-code-remote` | `mcp__claude-code-remote__*` | 세션·트리거·저장소 관리 (27개) |
| `github` | `mcp__github__*` | GitHub API (54개), 범위 `jaeseongs95/agent-governance-suite` |
| `agent-governance-suite` | `mcp__agent-governance-suite__*` | 저장소 `.mcp.json`, pid 304 `node mcp-server/dist/server.mjs` (28개) |
| `plugin:agent-governance-suite:agent-governance-suite` | `mcp__plugin_agent-governance-suite_agent-governance-suite__*` | 설치 플러그인 캐시, pid 381 (28개) |

같은 이름의 AGS MCP 서버가 저장소 소스와 플러그인 캐시 두 곳에서 동시에 떠 있다.

### 이전 작업

- 이 세션의 첫 요청이다. 이전 커밋, 변경, 상태 기록 없음.
- 세션 시작 시 AGS 플러그인 SessionStart 훅이 접수 안내를 주입했다.
- 첫 Bash 호출을 AGS 세션 현황판 PreToolUse 훅이 막았다. 원문: `PreToolUse:Bash hook error: 세션 현황판: 이 요청에서 무엇을 하는지 한 줄로 먼저 적어야 합니다. update_session_status를 {"schemaVersion":"1.0.0","summary":"<무엇을 · 어디서(브랜치) · 다음 외부 작업>"}로 호출한 뒤 다시 시도하세요. 같은 작업이 이어지면 같은 문장도 됩니다. 도구를 쓸 수 없으면 그대로 다시 시도하세요. 다음 시도는 허용됩니다.` `update_session_status`는 제품 상태를 쓰는 호출이라 "제품 시험 안 함" 조건에 따라 호출하지 않았고, 같은 명령을 다시 실행하자 허용됐다.
- 같은 이유로 SessionStart 안내가 요구한 `change-scope-guardian`, `mutation-risk-preflight`, `orchestrator` 스킬은 호출하지 않았다. 대신 게시 대상(`evidence` 브랜치, 새 폴더, non-force)을 `publish.log`에서 수동으로 확인했다.

### 작업 트리 충돌

- `ps -eo pid,comm,args | head -40`은 커널 스레드만 보여 판단 근거가 부족해 `/proc/*/cwd`로 보조 확인했다.
- 작업 트리를 cwd로 쓰는 프로세스: `claude`(pid 86), 그 자식인 MCP 서버 2개(304, 381), 관측용 bash. pid 409, 446(`session-message-broker.mjs`, `session-message-relay.mjs`)은 ppid 1로 분리돼 있으나 플러그인 캐시의 AGS 프로세스이며 이 세션이 띄운 것으로 보인다(추론).
- 다른 Claude 세션이나 사용자 프로세스는 보이지 않았다.

## 8. 설치 후보 (실행 없음)

- `ls`: `.mcp.json`, `package.json`, `pnpm-lock.yaml` 모두 존재
- `package.json`: `name`=`agent-governance-suite`, `version`=`2.8.1`, `engines`=`{"node": ">=24.0.0"}`, `packageManager`=`pnpm@11.19.0`
- 기준 상태와 일치: version `2.8.1` = tag `v2.8.1`, pnpm `11.19.0` 설치됨. Node 24는 `/opt/node24`에 있으나 기본 PATH가 아니다(4b).

## 비밀값 검사

게시 전에 `report.md`(이 절을 채우기 전)와 `observations.log`를 대소문자 구분 없이 검사했다. 명령과 출력은 `publish.log`에 있다.

| 패턴 | report.md | observations.log |
|------|-----------|------------------|
| `ghp_` | 0 | 1 |
| `gho_` | 0 | 1 |
| `sk-ant` | 0 | 1 |
| `token` | 0 | 0 |
| `Authorization` | 0 | 0 |

- 일치 합계 3건. 모두 `observations.log` 211행 한 줄이며, 관측 스크립트의 마스킹 `sed` 정규식이 프로세스 목록에 찍힌 것이다. 비밀값은 아니다.
- 실제 비밀값으로 판단한 일치: 0건.
- 관측 로그의 마스킹: 플러그인 캐시 경로의 긴 식별자 3곳(`plugins/synced/<redacted>`)을 예방 차원에서 가렸다. 허용 목록 환경변수 값의 마스킹은 0건이다.

## 산출물

- `report.md`: 이 문서
- `observations.log`: 관측 명령과 출력 원문(허용 목록 환경변수 외 값 없음)
- `SHA256SUMS`: 위 두 파일의 SHA-256
- `publish.log`: 게시 단계 명령과 출력(최종 push 출력 제외)
