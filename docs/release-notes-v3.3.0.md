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

- **스킬 이름과 상태:** manifest 이름은 두 패키지 모두 `agent-governance-suite`다. 그래서 스킬 이름(`agent-governance-suite:<skill>`)과 상태 DB가 같고, 다시 설치하면 언어를 바꿀 수 있다. **한 호스트에서 두 패키지를 함께 켜지 않는다.** 같은 manifest 이름이 둘이면 Claude Code는 한쪽 hook만 불러온다.
- **생성:** `scripts/build-en-packages.mjs`가 `claude-plugin-en/`과 `codex-plugin-en/`을 만든다. 둘 다 원본과 `runtime/locale.json`만 다르다.
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
- **스킬 본문:** `en` 패키지에서도 스킬 본문은 대부분 한국어다.

## 검증

- **다중 workflow 최종 후보 1aa8617f**
  - Linux 시험 서버 `pnpm test:server`: INSTALL·TSC·I18N_CHECK·TEST 종료 코드 모두 0, vitest 파일 274개 통과·1개 skip, 시험 4059개 통과, node:test 499/499
  - CI 41661964476: ubuntu·windows success
- 발행 후보의 검증 결과는 발행 직전에 이 절에 덧붙인다.
