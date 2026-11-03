# AGS 3.3.0 릴리스 노트

3.3.0은 세 가지를 담는다. 한 세션이 겹치지 않는 경로로 workflow를 여러 개 함께 진행할 수 있게 했고, AGS가 내보내는 모든 문장을 메시지 카탈로그로 옮겨 한국어·영어로 낸다. 영어 전용 플러그인 패키지도 새로 낸다. 함께 전문 스킬 문구 개선(c38319ac)과 이번에 찾은 결함 수정이 들어간다. 스킬 본문 번역과 전문적인 스킬 최적화는 행동 전체를 다시 시험해야 하므로 후속 과제로 남겼다.

호환성:
- `start_workflow`는 이제 `writeTargets`가 필수다. 없으면 `INVALID_INPUT`이다(아래 "다중 workflow").
- 오류의 `message` 문장은 카탈로그로 렌더링되며 locale에 따라 달라진다. 오류를 판별할 때는 `code`·`details`·`messageKey`를 쓴다.
- DB 스키마 표 목록은 바뀌지 않았다. 세션 결속은 기존 `continuity_observations` 표에 행을 더해 남긴다.

## 바뀐 점

### 다중 workflow 동시 구성

- **배경:** 3.2.x는 한 세션 epoch에 root 하나만 결속했다. 그래서 한 세션이 첫 workflow를 진행하는 동안 다른 경로의 두 번째 workflow를 열면 `BINDING_INVALID`("The workflow start conflicts with the current continuity task.")로 거부됐다. 실제로 R36 담당 세션은 R35 workflow가 남아 있어 새 workflow를 등록하지 못했다. 원인은 R35·R36 작업 내용이 아니라 이 구조였다. 이번 방향은 독립 토론 패널(판정 A1~A7)로 정했다.
- **결속:** 세션 결속은 epoch마다 root 여러 개다. 결속 행은 `continuity_observations`의 `workflow-root:<rootId>`로 남긴다. 다른 root와 세션 결속이 충돌하는 일은 없고, 경로 충돌은 convergence 가드의 `ROOT_CONFLICT`가 맡는다.
- **편집 관문:** 편집 파일이 속한 root 표면을 기준으로 판정한다. 판정 대기(`needs-review`·`needs-user`) root 표면 안의 편집은 같은 세션, 다른 세션, 같은 저장소의 다른 checkout 모두에서 거부한다. 세션 결속 충돌이 관문을 fail-open시키지 않는다.
- **epoch:** 결속된 root가 모두 정리됐을 때만(각 root의 run과 소비 lease가 모두 끝남) 새 epoch로 옮긴다.
- **이어 가기:** `start_workflow`에 `rootId`를 주면 새 root를 열지 않고 이 세션이 결속했던 `open` root에 새 시도를 만든다.
  - 다른 세션의 root는 `INVALID_INPUT`(`ROOT_NOT_OWNED`)이다.
  - open이 아닌 root는 `INVALID_TRANSITION`(`ROOT_NOT_OPEN`)이다.
  - `goal`·`stages`·`acceptanceCriteria`·`writeTargets`는 그 root와 같아야 한다(`ROOT_TASK_MISMATCH`).
- **`writeTargets` 필수:** 경로를 모르면 겹침을 판정할 수 없기 때문이다.
- **`ROOT_CONFLICT` 안내:** 응답에 겹친 경로(`requestedEntry`·`existingPath`), 이 세션 소유 여부(`ownedBySession`), `nextActions`가 들어간다. `nextActions`는 겹치지 않는 writeTargets로 다시 시작하기, 자기 open root면 `rootId`로 이어 가기, 판정 대기 root면 `resolve_convergence_gate` 중 해당하는 것이다. orchestrator 지침 2곳(`convergence-guard.md`, `mcp-execution.md`)도 같은 내용으로 고쳤다.
- **호스트 구분:** root 식별에 host ID를 넣어, 다른 호스트의 같은 경로는 겹치지 않는 것으로 본다. host가 없는 예전 식별은 같은 호스트로 본다.
  - host ID는 OS 기계 ID의 SHA-256 digest를 UUID 모양으로 쓴 값이다. Windows는 `MachineGuid`, macOS는 `IOPlatformUUID`, Linux는 `/etc/machine-id`·`/var/lib/dbus/machine-id`를 쓴다. 원래 기계 ID는 저장하지 않는다.
  - 상태 디렉터리를 지우거나 복사해도, hook과 서버가 다른 상태 디렉터리를 읽어도 한 컴퓨터의 host ID는 하나다.
  - 기계 ID를 읽다 실패하면 무작위 값으로 대신하지 않고 `HOST_IDENTITY_UNRESOLVED`로 거부한다. 기계 ID가 없는 환경에서만 공유 상태 디렉터리의 `host-id` 파일을 쓴다.
  - 첫 읽기(Windows `reg.exe`, macOS `ioreg` 실행)는 쓰기 잠금을 잡기 전에 끝낸다. `open_convergence_root`는 root 삽입 트랜잭션 전에, `start_workflow`는 바깥 workflow 트랜잭션 전에 읽는다.
- **리뷰:** 별도 리뷰어가 5회 검토했다. 차단 결함은 F1, R1·R2가 나와 고쳤다. F1은 host ID가 상태 디렉터리마다 달라지던 문제, R1은 읽기 실패를 무작위 값으로 숨기던 문제, R2는 예전 파일이 도출값보다 우선하던 문제다. 비차단 결함 1건(`start_workflow` 경로에서 잠금 안에서 읽던 순서)도 고쳤다. 마지막 회차는 차단·비차단 모두 0건이다.

### 단계 확인 문구

- Stop hook은 시작 실패로 편집이 실제로 통과된 경우에만 "편집이 막히지 않았다"고 말한다(`START_FAILURE_PASS_EVENT`가 있거나 관문을 쓸 수 없을 때).

### i18n: 모든 문장을 카탈로그로

- 관리자 페이지만이 아니라 AGS가 내보내는 모든 문장이 대상이다. hook 문구, MCP `instructions`, 도구·schema 설명, 오류, 저장 문장, 세션 메시지 안내, CLI, 스킬 스크립트 메시지, engineering-practices CLI가 여기에 들어간다. 모두 `locales/<locale>/*.json` 카탈로그에서 ICU 메시지로 렌더링한다. `ko`와 `en`을 낸다.
- **호스트 쪽 locale 결정:** 다음 순서로 정한다(`docs/i18n-design.md` 4.1).
  1. 환경 변수 `AGENT_GOVERNANCE_LOCALE`(`Accept-Language` 문법)
  2. `<공유 상태 디렉터리>/settings.json`의 `locale`
  3. 설치 패키지의 `runtime/locale.json`
  4. 위가 모두 없으면 `en`

  잘못된 값은 그 단계만 건너뛴다.
- **오류 객체:** 오류는 `code`·`messageKey`·`params`를 갖는다. 오류 안에 들어간 메시지도 읽는 쪽 locale로 렌더링한다.
- **검사:** `pnpm i18n:check`가 카탈로그 키·인자·ICU 문법과 생성 형식을 검사한다. CI `lint`에 들어 있다.

### 영어 전용 플러그인 패키지

- 같은 플러그인의 영어 전용 패키지다. AGS 문장이 영어로 나온다. 스킬 본문은 번역 전까지 원문 그대로다(설계 7.1을 "번역이 없으면 원문"으로 바꿨다).
- **설치 이름:**

  | 호스트 | 한국어 | 영어 전용 |
  |---|---|---|
  | Claude Code | `agent-governance-suite@agent-governance-claude` | `agent-governance-suite-en@agent-governance-claude` |
  | Codex | `agent-governance-suite@agent-governance` | `agent-governance-suite-en@agent-governance` |
  | agy | `agent-governance-suite-antigravity-<tag>.zip` | `agent-governance-suite-antigravity-<tag>-en.zip` |

- **manifest 이름:**
  - Claude Code는 항목 이름과 manifest 이름이 달라도 된다. 그래서 영어판 manifest 이름도 `agent-governance-suite`로 두어, 스킬 이름(`agent-governance-suite:<skill>`)이 같다.
  - Codex는 둘이 같아야 한다. codex-cli 0.166.0이 `plugin.json name 'agent-governance-suite' does not match marketplace plugin name 'agent-governance-suite-en'`으로 설치를 거부했다. 그래서 Codex 영어판은 manifest `id`·`name`을 `agent-governance-suite-en`으로 하고, 소개 문구를 영어로 바꾼다. Codex에서 스킬이 어떤 이름으로 보이는지는 실행 확인을 못 했다(크레딧 없음, 미확인).
- **상태:** MCP 서버 이름과 상태 DB 위치는 두 패키지가 같다. 다시 설치하면 언어를 바꿀 수 있다.
- **한 호스트에서 두 패키지를 함께 켜지 않는다.** Claude Code는 같은 manifest 이름이 둘이면 한쪽 hook만 불러오고, Codex는 이름이 달라 hook과 MCP 서버가 둘 다 돈다.
- **생성:** `scripts/build-en-packages.mjs`가 `claude-plugin-en/`과 `codex-plugin-en/`을 만든다. 원본과 다른 것은 `runtime/locale.json`이다.
  - Codex 영어판은 manifest도 바꾼다(위).
  - `pnpm en:check`는 차이를 실패로 보고하고, CI의 `pnpm en:drift`는 경고로 보고한다.
  - agy `-en` zip은 release workflow가 `build-antigravity-package.mjs --locale en`으로 함께 만들어 붙인다.
  - `sync-release-metadata.mjs`는 두 marketplace의 `-en` 항목 버전도 맞춘다.

### 전문 스킬 문구 개선

- 전문 스킬 문구를 에이전트가 안정적으로 따르도록 고쳤다(c38319ac). 전문적인 스킬 최적화(정밀 행동 시험 포함)는 후속 과제다.
- **행동 A/B 시험:** Linux 시험 서버에서 호스트 3종 × 과제 5개 × 판 2개 × 3회 = 90회를 돌렸다.
  - 3.2.1판(A)은 40/45, 개선판(B)은 44/45였다.
  - 피셔 정확 검정 p = 0.203이라 우열을 판별할 수 없다. 개선판이 퇴행했다는 근거도 없다.
  - 하네스는 `tests/real-host/skill-ab/`에 있다.

## 업그레이드 시 확인할 것

- `start_workflow`를 직접 부르는 자동화는 `writeTargets`를 넣어야 한다.
- 다중 workflow는 hook과 MCP 서버가 모두 3.3.0이어야 동작한다. 설치 뒤 AGS MCP 프로세스를 다시 시작한다. Codex는 `/hooks`에서 바뀐 hook을 다시 신뢰해야 한다.
- 영어로 쓰려면 `-en` 패키지로 다시 설치하거나, 한국어 패키지에서 `AGENT_GOVERNANCE_LOCALE=en` 또는 `settings.json`의 `"locale": "en"`을 쓴다.

## 알려진 제한

- **host ID 관련:**
  - sandbox 때문에 일부 프로세스만 기계 ID를 보지 못하면, 같은 컴퓨터가 다른 호스트로 보일 수 있다(3.4.0 후보).
  - OS 기계 ID가 바뀌면 다른 호스트가 된다.
  - 기계 ID 읽기가 계속 실패하는 환경(정책으로 `reg.exe` 차단 등)에서는 root를 여는 시작이 모두 `INVALID_INPUT`(`HOST_IDENTITY_UNRESOLVED`)이다.
- **이 PC 3.2.0 설치본의 결함(3.2.1에서 수정):** 3.2.0 `start_workflow`로 연 다중 workflow 개발 run은 `change-code-review` 단계의 산출물 대상 계약이 없어 passed로 기록할 수 없었다. 그래서 그 단계는 `blocked`(`MISSING_EVIDENCE`)로 남겼다. 리뷰 원파일 묶음은 `check-stage-bundle`을 통과했다(`NO_BLOCKING_FINDINGS`).
- **실호스트 미실행:** Codex는 API 크레딧이 없어 실호스트 실행을 하지 않았다. 영어 패키지도 Codex에서는 설치·목록 확인까지만 했다.
- **스킬 본문:** `en` 패키지에서도 스킬 본문은 대부분 한국어다. MCP `instructions`는 앞뒤 안내 문장만 영어다. 본문에 그대로 싣는 orchestrator 공통 접수 기준(`skills/orchestrator/SKILL.md`의 intake 블록)은 한국어로 나온다. Linux 실측 결과 7089자 중 한글이 2280자였다. 스킬 번역 때 함께 바뀐다.

## 검증

- **다중 workflow 최종 후보 1aa8617f**
  - Linux 시험 서버 `pnpm test:server`: INSTALL·TSC·I18N_CHECK·TEST 종료 코드 모두 0, vitest 파일 274개 통과·1개 skip, 시험 4059개 통과, node:test 499/499
  - CI 41661964476: ubuntu·windows success
- **영어 패키지 실설치(Linux 시험 서버, d7e48d94 브랜치)**
  - Claude Code 2.1.314: 설정 폴더를 따로 두고 `claude plugin marketplace add jaeseongs95/agent-governance-suite@feat/en-package-20261104`, `claude plugin install agent-governance-suite-en@agent-governance-claude`를 실행했다. 둘 다 exit 0이고 목록에 3.3.0 enabled로 나왔다. 설치본의 `runtime/locale.json`은 `en`이다.
  - `claude -p` 실행: 스킬 25개가 `agent-governance-suite:*`로 보였고, MCP 서버는 `connected`, AGS 도구는 31개였다. SessionStart hook 출력에 한글은 0자였다.
  - 처음 설치에서는 `mcp-server/dist`가 `.gitignore` 때문에 커밋에서 빠져 `ERR_MODULE_NOT_FOUND`가 났다. 예외 규칙과 `en:check`·시험의 ignore 검사를 넣어 고쳤다.
  - Codex 0.166.0: `CODEX_HOME`을 따로 두고 `git-subdir` 항목으로 `codex plugin add agent-governance-suite-en@agent-governance`를 실행했다. exit 0이고 `installed, enabled 3.3.0`으로 나왔다. 설치본의 locale은 `en`, manifest는 `agent-governance-suite-en`이다. 실행은 하지 않았다(크레딧 없음).
- **발행 후보 460ab868**
  - Linux 시험 서버 전체 시험(d7e48d94): vitest 파일 276개 중 274개 통과·1개 skip·1개 실패. 실패는 `tests/tooling/claude-plugin.test.mjs`의 공통 접수 문장 사본 검사였다. 생성 패키지 `claude-plugin-en/`의 사본을 허용 목록에 넣지 않아서 났다. 허용 목록을 `build-en-packages`의 경로 대응으로 도출하게 고쳤다(460ab868).
  - Linux 시험 서버(460ab868): 그 뒤 바뀐 시험 8개 파일 241개 통과. vitest 실패 때문에 돌지 못한 node:test 499/499, 설치 런타임 smoke 종료 코드 0. tsc·build 0.
  - Windows 시험 서버 첫 실행(7fbe8b44)에서 Linux와 CI에서 보이지 않던 실패가 나왔다. 수렴 frame 시험 fixture가 `D:/` 드라이브를 고정으로 썼는데, 이 서버에는 D: 드라이브가 없어 workspace 식별이 `WORKSPACE_IDENTITY_UNRESOLVED`(ENOENT)로 거부됐다. 해당 파일은 convergence-guard, continuity, d0344-terminal-direct였다. fixture 경로를 임시 디렉터리 아래로 바꿨다(55f1b38c). 이 시험들은 서버 전용이라 CI Windows에서는 돌지 않는다. Windows 서버(460ab868)에서 바뀐 7개 파일 234개 시험이 통과했다.
  - CI 41675486783(460ab868): ubuntu·windows success.
  - 영어 패키지 번들이 lint 대상에 들어가 CI가 실패한 것(41670002876)은 `claude-plugin/`처럼 생성물로 제외해 고쳤다(7fbe8b44).
  - Windows 시험 서버 전체 시험(460ab868): vitest 파일 276개 중 272개 통과·2개 skip·2개 실패. 실패는 `tests/tooling/skill-context-optimization.test.mjs` 26건과 `tests/tooling/specialist-behavior-source.test.mjs` 12건이고 모두 30초 시간 초과였다(파일 시간 992초, 401초). 검사 스크립트가 검사 한 번에 `git show`·`git diff`를 수백 번 띄우는데, 이 서버에서는 git 프로세스 시작이 느리다. 시간 한도는 바꾸지 않고, 커밋 SHA로만 이름 붙은 git 출력을 프로세스 안에서 재사용하게 고쳤다. 작업 트리와 index 읽기는 매번 한다. 검사 출력은 바뀌지 않는다.
