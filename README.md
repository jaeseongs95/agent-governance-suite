# Agent Governance Suite

한국어 | [English](README.en.md)

Agent Governance Suite(AGS)는 Claude Code, Codex, Antigravity(`agy`)에 설치하는 로컬 플러그인입니다. 에이전트가 요청에 맞는 전문 스킬을 쓰고, 여러 단계의 일을 완료 기준에 따라 진행하며, 사용자의 교정과 남은 일을 이어 가도록 돕습니다. 문서·조사·의사결정·안내물·소프트웨어 작업에 쓸 수 있습니다. 세 호스트는 같은 MCP 서버와 공통 규칙을 쓰며, hook 이벤트·깨우기 방식·설치 형식처럼 호스트마다 다른 부분은 호스트별 어댑터가 맡습니다.

[설치](#설치) · [사용하기](#사용하기) · [스킬](#스킬) · [문서](#문서)

## 어떤 일에 쓰나요?

| 하려는 일 | AGS가 돕는 부분 |
| --- | --- |
| 자료를 조사하고 결정을 내리기 | 목표·제약·완료 기준 정리, 의견이 갈리는 선택의 검토, 주장과 실제 근거의 대조 |
| 문서·안내문·서비스 절차 만들기 | 독자와 이용자의 흐름·접근성 점검, 프롬프트 설계, 사실을 보존한 한국어 산문 편집 |
| 소프트웨어를 만들거나 고치기 | 작은 구현 방향 선택, 설계·시험·코드 리뷰·보안 검토, 반복 실패의 원인 판별 |
| 여러 단계나 세션에 걸쳐 이어 가기 | workflow 진행 상태, 교정·남은 일의 작업 기록, 세션 현황판과 PEER 메시지 |

## 구성

- **스킬:** 전문 스킬 23개, 흐름을 잇는 `orchestrator`, 현황판 사용을 돕는 `session-board`
- **로컬 MCP 서버:** workflow, 작업 기록, 현황판, 세션 메시지, 상태 정리 도구
- **호스트 hook:** 세션·턴·도구 경계에서 안내를 넣고 편집 대상을 관측합니다.
- **로컬 관리자 페이지:** 전역 컨텍스트, 역할, JEV처럼 사람이 정하는 설정을 패스키로 서명해 바꿉니다. 기본 주소는 `http://localhost:47615/`입니다.

안내가 있다는 사실만으로 에이전트가 지시를 따랐거나 결과가 검증됐다고 볼 수는 없습니다. AGS가 보장하지 않는 것은 [사용하기](docs/user/usage.md#보장하지-않는-것)에 있습니다.

## 설치

필요한 것은 Node.js **24.0.0 이상**과 호스트의 플러그인 기능입니다. 협업할 호스트마다 설치합니다. 플러그인을 쓰는 데 이 저장소를 clone하거나 `pnpm install`을 실행할 필요는 없습니다.

<!-- release-version:start -->
현재 공개 릴리스는 `v4.1.0`이며 아래 설치 예시는 이 버전 기준입니다. 4.0.0부터 JEV는 관리자 페이지에서만 설정합니다([4.0.0 릴리스 노트](docs/release-notes/release-notes-v4.1.0.md)의 업그레이드 전 확인). 3.x는 2.x와 호환하지 않습니다. 버전별 변경 사항은 [GitHub 릴리스](https://github.com/jaeseongs95/agent-governance-suite/releases)와 `docs/release-notes/release-notes-v<버전>.md`에 있습니다.
<!-- release-version:end -->

이미 설치했다면 [업데이트와 이전](docs/user/update.md)을 따릅니다.

### 패키지와 언어

패키지는 호스트마다 하나입니다. 모델이 읽는 AGS 문구는 언어 설정 없이 문구마다 토큰이 적은 형태 하나로 고정됩니다. 그래서 hook 안내, MCP 도구 설명·결과, 오류, 스킬·hook CLI 출력, 스킬 description은 영어이고 MCP instructions의 공통 접수 기준은 한국어이며, 스킬 본문은 원문(대부분 한국어) 그대로입니다. 3.x의 영어 전용 패키지(`agent-governance-suite-en`)를 설치했다면 [업데이트와 이전](docs/user/update.md#이전-판에서-올릴-때)을 따릅니다.

| 호스트 | 패키지 |
| --- | --- |
| Claude Code | `agent-governance-suite@agent-governance-claude` |
| Codex | `agent-governance-suite@agent-governance` |
| Antigravity | `agent-governance-suite-antigravity-<tag>.zip` |

### Claude Code

Claude Code 안에서 실행하고, 설치 뒤 새 세션을 시작합니다.

```text
/plugin marketplace add jaeseongs95/agent-governance-suite
/plugin install agent-governance-suite@agent-governance-claude
```

### Codex

터미널에서 실행합니다.

<!-- release-install:start -->
```bash
codex plugin marketplace add jaeseongs95/agent-governance-suite --ref v4.1.0
codex plugin add agent-governance-suite@agent-governance
```
<!-- release-install:end -->

새 Codex 세션을 시작한 뒤 `/hooks`에서 AGS hook을 검토하고 신뢰합니다. 신뢰하기 전에는 플러그인 hook이 실행되지 않아 턴 안내, 작업 기록, 현황판, 메시지 전달이 동작하지 않습니다. hook 정의가 바뀐 판으로 업데이트하면 다시 검토합니다.

### Antigravity (`agy`)

`agy plugin install`은 로컬 디렉터리만 받습니다. 릴리스에 첨부한 설치본을 받아 풀고 그 디렉터리를 설치합니다. 설치본에는 agy가 읽는 파일만 들어 있습니다. 저장소 전체를 설치하면 Antigravity 앱의 설치됨 화면이 멈출 수 있습니다. 설치하는 동안 Antigravity 앱을 닫아 둡니다. 앱이 켜져 있으면 기존 설치 폴더를 지우지 못해 설치가 실패합니다. Windows에서는 `Expand-Archive`로 풉니다.

<!-- release-agy:start -->
```bash
curl -LO https://github.com/jaeseongs95/agent-governance-suite/releases/download/v4.1.0/agent-governance-suite-antigravity-v4.1.0.zip
unzip agent-governance-suite-antigravity-v4.1.0.zip
agy plugin install ./agent-governance-suite
agy plugin list
```
<!-- release-agy:end -->

`agy` CLI가 없는 Antigravity 네이티브 앱에서는 [공식 수동 설치 안내](https://antigravity.google/docs/plugins#manual-plugin-installation)를 따릅니다. 앱을 정상 종료하고 기존 AGS 폴더를 플러그인 검색 경로 밖에 복구용으로 보존한 뒤, 릴리스에 첨부된 Antigravity 설치용 ZIP의 `agent-governance-suite` 폴더를 `~/.gemini/config/plugins/` 아래에 둡니다(Windows: `%USERPROFILE%/.gemini/config/plugins/agent-governance-suite`). 앱을 다시 시작하고 `Customizations > Installed`에서 AGS 버전을 확인합니다. 저장소 전체를 복사하지 마십시오. 이 방식에는 CLI 추가 설치가 필요하지 않습니다.

설치본에는 MCP 서버 등록(`mcp_config.json`, 서버 이름 `ags`, `AGENT_GOVERNANCE_HOST_ATTESTATION=antigravity`)과 hook(`hooks.json`)이 함께 들어 있어 따로 설정할 것이 없습니다. 이 저장소의 `GEMINI.md`와 `AGENTS.md`는 AGS 자체를 개발할 때 쓰는 지침이며 설치본에 들어 있지 않습니다.

### 설치 뒤 확인

- 새 세션에서 AGS 스킬과 MCP 도구가 보이는지 확인합니다. 보이지 않으면 [문제 해결](docs/user/troubleshooting.md)을 봅니다.
- 관리자 페이지(`http://localhost:47615/`)를 열어 첫 패스키를 등록합니다. 첫 키는 확인 없이 받으므로 먼저 등록해 두는 것이 좋습니다. [관리자 페이지와 컨텍스트](docs/user/admin-page.md)

## 사용하기

원하는 결과와 확인할 조건, 바꾸면 안 되는 대상을 함께 알려 주십시오. 모든 요청에 스킬이나 workflow를 직접 지정할 필요는 없습니다. 에이전트가 요청 목적과 스킬의 적용·제외 조건을 대조하고, 단계가 이어지는 변경에는 workflow를 씁니다.

```text
이 기능을 구현하고 검증해 줘. 수정 범위와 완료 기준을 먼저 정리하고,
최종 결과에는 실제로 실행한 검사와 아직 해결하지 못한 문제를 함께 적어 줘.
```

설치하면 달라지는 동작, workflow와 편집 관문, 작업 기록은 [사용하기](docs/user/usage.md)에, 여러 세션의 협업은 [세션 협업](docs/user/collaboration.md)에 있습니다.

## 스킬

전문 스킬 23개의 버전과 출처는 [registry](skills/registry.json)와 [source lock](skills/source-lock.json)을 따릅니다. 이 밖에 흐름을 잇는 [`orchestrator`](skills/orchestrator/)와 현황판 사용법을 담은 [`session-board`](skills/session-board/)가 있습니다. 작업 기록은 스킬이 아니라 MCP 도구와 hook이 맡습니다.

| 스킬 | 출처 | 버전 | 하는 일 |
| --- | --- | --- | --- |
| [`instruction-scope-resolver`](skills/instruction-scope-resolver/) | AGS | 1.0.0 | 경로에 적용되는 지침 파일과 우선순위를 확인합니다. |
| [`workspace-convention-profiler`](skills/workspace-convention-profiler/) | AGS | 1.0.0 | 저장소 구조, 관례, 검증 명령을 조사합니다. |
| [`task-contract`](skills/task-contract/) | AGS | 1.1.0 | 목표, 범위, 완료 기준, 위험, 권한을 작업 계약으로 정리합니다. |
| [`model-effort-advisor`](skills/model-effort-advisor/) | AGS | 0.2.0 | 승인된 서브에이전트를 호출하기 전에 작업 요구와 호스트 지원 조합으로 모델·추론 수준을 선택합니다. |
| [`coordinate-subagents`](skills/coordinate-subagents/) | AGS | 1.1.0 | 위임할지 판단하고 담당 범위, 전달할 맥락, 검증 책임을 정합니다. |
| [`minimal-implementation`](skills/minimal-implementation/) | AGS | 1.0.0 | 코드, 문서, 자료, 설정, 절차 등 모든 결과물에서 필요한 것만 담은 가장 작은 완전한 결과를 고르고, 대체물로 만든 통과를 완료로 내지 않습니다. |
| [`change-scope-guardian`](skills/change-scope-guardian/) | AGS | 1.0.0 | 기준 상태와 현재 변경을 비교해 범위 밖 파일을 찾습니다. |
| [`mutation-risk-preflight`](skills/mutation-risk-preflight/) | AGS | 1.0.3 | 되돌리기 어려운 변경 직전에 대상, 승인, 영향, 복구 조건을 점검합니다. |
| [`independent-deliberation-panel`](skills/independent-deliberation-panel/) | AGS | 1.0.0 | 갈리는 결정을 독립 관점과 반론으로 검토합니다. |
| [`iteration-frame-auditor`](skills/iteration-frame-auditor/) | AGS | 1.0.0 | 반복 작업에서 원래 계약과 판단 전제가 바뀌었는지 감사합니다. |
| [`acceptance-evidence-validator`](skills/acceptance-evidence-validator/) | AGS | 1.0.0 | 완료 기준을 실제 결과의 근거와 대조합니다. |
| [`independent-audit-gate`](skills/independent-audit-gate/) | AGS | 1.0.0 | 변경을 만든 작업자와 분리된 감사자가 고위험 변경과 근거를 확인합니다. |
| [`blocker-diagnostician`](skills/blocker-diagnostician/) | AGS | 1.1.0 | 반복 실패에서 관측과 가설을 나누고 다음 판별 검사를 고릅니다. |
| [`recovery-strategy-selector`](skills/recovery-strategy-selector/) | AGS | 0.2.0 | 원인이 확정된 실패의 복구 전략을 비교하고 인계 자료를 만듭니다. |
| [`cs-engineering`](skills/cs-engineering/) | AGS | 0.2.0 | 동시성·DB·메시징·알고리즘·성능 문제에 CS 원리로 불변조건과 검증 의무를 세웁니다. |
| [`solid-design`](skills/solid-design/) | AGS | 0.1.0 | 실제 모듈·계약·어댑터 경계에 SOLID를 적용해 최소 변경 방향을 제시합니다. |
| [`prompt-engineering`](skills/prompt-engineering/) | AGS | 0.1.0 | LLM 프롬프트·지침·입력 템플릿을 설계·진단하고 비교 검증 사례를 만듭니다. |
| [`ui-ux-design`](skills/ui-ux-design/) | AGS | 0.1.0 | 화면, 인쇄·광고, 영상, 공간·안내물, 제품, 서비스 절차, 문서·양식처럼 사람이 보고 쓰는 결과물의 사용자 흐름·정보 계층·접근성·예외 상황을 설계·점검하고, 대상 사용자에게 통하는지부터 확인합니다. |
| [`test-engineering`](skills/test-engineering/) | AGS | 0.1.0 | 요구와 코드 경계에서 시험 사례를 설계하고 결함 탐지 능력을 확인합니다. |
| [`code-review`](skills/code-review/) | AGS | 0.1.0 | 고정된 diff·PR의 실제 실패 경로를 검토하고 결함·권고·질문을 나눕니다. |
| [`software-security-auditor`](skills/software-security-auditor/) | AGS | 0.1.0 | 웹·API와 CLI·MCP의 공격 경로, 방어 통제, 검사 공백을 감사합니다. |
| [`evaluation-validity-auditor`](skills/evaluation-validity-auditor/) | AGS | 1.0.0 | 평가의 입력·판정·집계가 공정하고 재현 가능한지 감사합니다. |
| [`korean-prose-editor`](skills/korean-prose-editor/) | AGS | 0.1.0 | 사실·숫자·링크·코드를 보존하며 한국어 산문을 편집하고 검증합니다. |

언제 어떤 스킬을 쓰는지는 [사용하기의 스킬을 쓰는 시점](docs/user/usage.md#스킬을-쓰는-시점)에 있습니다.

## 문서

| 대상 | 문서 |
| --- | --- |
| 사용자 | [사용하기](docs/user/usage.md), [관리자 페이지와 컨텍스트](docs/user/admin-page.md), [세션 협업](docs/user/collaboration.md), [상태 저장과 정리](docs/user/state.md), [업데이트와 이전](docs/user/update.md), [문제 해결](docs/user/troubleshooting.md) |
| 기여자 | [기여 안내](CONTRIBUTING.md), [아키텍처](docs/contributing/architecture.md), [개발 참고](docs/contributing/development.md), [시험과 CI](docs/contributing/testing-and-ci.md), [발행](docs/contributing/release.md) |
| 전체 목록 | [문서 안내](docs/README.md), [보관 기록](docs/archive/README.md), [릴리스 노트](docs/release-notes/), [보안 정책](SECURITY.md) |

## 라이선스

[MIT License](LICENSE)
