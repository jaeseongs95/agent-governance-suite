# Agent Governance Suite

한국어 | [English](README.en.md)

Agent Governance Suite(AGS)는 Claude Code, Codex, Antigravity(`agy`)에 설치하는 로컬 플러그인입니다. 에이전트가 작업에 맞는 전문 스킬을 고르고, 여러 단계로 이어지는 변경을 workflow로 진행하며, 사용자의 교정과 남은 일을 기록하도록 돕습니다. 같은 컴퓨터의 다른 세션과는 현황판과 PEER 메시지로 협업합니다.

[설치](#설치) · [설치하면 달라지는 것](#설치하면-달라지는-것) · [사용하기](#사용하기) · [스킬](#스킬) · [보장하지 않는 것](#보장하지-않는-것) · [문제 해결](#문제-해결) · [문서](#문서)

## 구성

| 구성 | 하는 일 |
| --- | --- |
| 전문 스킬 24개 | 작업 계약, 위험 점검, 완료 근거 검증, 독립 감사, 실패 진단, 코드 리뷰, 보안 감사 같은 판단을 하나씩 맡습니다. |
| `orchestrator` | 필요한 전문 스킬을 고르고 실행 순서와 입출력을 연결합니다. |
| 로컬 MCP 서버 | workflow의 계획·단계 결과·완료 조건을 검사하고, 작업 기록·현황판·메시지 도구를 제공합니다. 별도 포트나 상주 데몬 없이 호스트가 필요할 때 실행합니다. |
| 호스트 hook | 세션 시작, 사용자 메시지, 도구 호출, 턴 종료 시점에 안내를 넣고 관측을 기록하며 메시지를 전달합니다. |

상태는 이 컴퓨터의 SQLite 파일에 저장합니다.

## 설치

필요한 것은 Node.js **24.0.0 이상**과 호스트의 플러그인 기능입니다. 협업할 호스트마다 설치합니다. 플러그인을 쓰는 데 이 저장소를 clone하거나 `pnpm install`을 실행할 필요는 없습니다.

<!-- release-version:start -->
현재 공개 릴리스는 `v3.7.0`이며 아래 설치 예시는 이 버전 기준입니다. 3.x는 2.x와 호환하지 않습니다. 버전별 변경 사항은 [GitHub 릴리스](https://github.com/jaeseongs95/agent-governance-suite/releases)와 `docs/release-notes-v<버전>.md`에 있습니다.
<!-- release-version:end -->

### 패키지 고르기

호스트마다 한국어 패키지와 영어 전용 패키지가 있습니다. 영어 전용 패키지는 AGS 메시지, MCP 도구 설명, hook 문구, 오류를 영어로 내고, 스킬 본문은 원문(대부분 한국어) 그대로 둡니다. 상태는 같은 위치를 쓰므로 다시 설치해서 언어를 바꿀 수 있습니다. **한 호스트에서는 둘 중 하나만 켜십시오.** 둘 다 켜면 Claude Code는 한쪽 hook만 불러오고 Codex는 둘 다 실행합니다.

| 호스트 | 한국어 패키지 | 영어 전용 패키지 |
| --- | --- | --- |
| Claude Code | `agent-governance-suite@agent-governance-claude` | `agent-governance-suite-en@agent-governance-claude` |
| Codex | `agent-governance-suite@agent-governance` | `agent-governance-suite-en@agent-governance` |
| Antigravity | `agent-governance-suite-antigravity-<tag>.zip` | `agent-governance-suite-antigravity-<tag>-en.zip` |

아래 명령은 한국어 패키지 기준입니다. 영어 전용 패키지는 표의 이름이나 파일로 바꿔 실행합니다. Claude Code에서는 두 패키지의 스킬 이름이 `agent-governance-suite:<스킬>`로 같고, Codex 영어 패키지는 항목 이름과 manifest 이름이 같아야 해서 `agent-governance-suite-en`입니다.

### Claude Code

Claude Code 안에서 실행하고, 설치 후 새 세션을 시작합니다.

```text
/plugin marketplace add jaeseongs95/agent-governance-suite
/plugin install agent-governance-suite@agent-governance-claude
```

### Codex

터미널에서 실행합니다.

<!-- release-install:start -->
```bash
codex plugin marketplace add jaeseongs95/agent-governance-suite --ref v3.7.0
codex plugin add agent-governance-suite@agent-governance
```
<!-- release-install:end -->

새 Codex 세션을 시작한 뒤 `/hooks`에서 AGS hook을 검토하고 신뢰합니다. 신뢰하기 전에는 플러그인 hook이 실행되지 않아 턴 확인 안내, 작업 기록, 현황판, 메시지 전달이 동작하지 않습니다. hook 정의가 바뀐 버전으로 업데이트하면 다시 검토합니다.

### Antigravity (`agy`)

`agy plugin install`은 로컬 디렉터리만 받습니다. 릴리스에 첨부한 설치본을 받아 풀고 그 디렉터리를 설치합니다. 설치본에는 agy가 읽는 파일만 들어 있습니다. 저장소 전체를 설치하면 Antigravity 앱의 설치됨 화면이 멈출 수 있습니다. 설치하는 동안 Antigravity 앱을 닫아 둡니다. 앱이 켜져 있으면 기존 설치 폴더를 지우지 못해 설치가 실패합니다. Windows에서는 `Expand-Archive`로 풉니다.

<!-- release-agy:start -->
```bash
curl -LO https://github.com/jaeseongs95/agent-governance-suite/releases/download/v3.7.0/agent-governance-suite-antigravity-v3.7.0.zip
unzip agent-governance-suite-antigravity-v3.7.0.zip
agy plugin install ./agent-governance-suite
agy plugin list
```
<!-- release-agy:end -->

설치본에는 MCP 서버 등록(`mcp_config.json`, 서버 이름 `ags`, `AGENT_GOVERNANCE_HOST_ATTESTATION=antigravity`)과 hook(`hooks.json`)이 함께 들어 있어 따로 설정할 것이 없습니다. 이 저장소의 `GEMINI.md`와 `AGENTS.md`는 AGS 자체를 개발할 때 쓰는 지침이며 설치본에 들어 있지 않습니다.

## 설치하면 달라지는 것

AGS는 에이전트의 판단을 대신하지 않습니다. 정해진 시점에 안내를 넣고, workflow 도구로 진행 상태를 검사하며, 몇 가지 행동은 거부합니다.

| 시점 | 달라지는 것 |
| --- | --- |
| 세션 시작 | 스킬 선택과 workflow 사용 기준(공통 접수 기준)이 모델에 전달됩니다. 재개·압축 뒤에는 저장된 작업 기록의 후보만 알리고, 본문은 에이전트가 `load_context`를 호출할 때만 불러옵니다. 진행 중인 workflow가 있으면 압축 뒤에 그 요약 카드도 보여 줍니다. |
| 사용자 메시지마다 | `[AGS 턴 확인]` 안내와 설치된 스킬별 적용 대상 목록이 붙습니다. 메시지가 교정, 새 결정·승인·금지, 추가 작업, 범위 변경이면 스킬 선택을 다시 판단하고 `checkpoint_context`로 사용자 원문과 남은 일을 저장하라는 내용입니다. 독립적으로 완료·검증할 수 있는 일이 있으면 위임을 검토하고, 위임 지시문에 무엇을 적을지도 알립니다. 메시지마다 한국어판 약 2,600자가 늘어납니다. Claude Code·Codex는 UserPromptSubmit에서, agy는 각 턴의 첫 모델 호출에서 넣습니다. |
| 서브에이전트 시작 | `[AGS 서브에이전트 시작 확인]` 안내와 설치된 스킬별 적용 대상 목록이 서브에이전트에 들어갑니다. 맡은 일을 대상과 대조해 맞는 스킬을 호출하고, 지시문의 범위·금지 구역·쓰기 소유 안에서 일하라는 내용입니다. Claude Code·Codex는 SubagentStart hook으로 넣습니다. agy에는 서브에이전트 시작 hook이 없어 넣지 못합니다. |
| 제품 파일 편집 | workflow 없이 한 턴에 서로 다른 제품 파일을 세 개째 바꾸는 편집은 거부되고, 거부 문구에 최소 `start_workflow` 호출 예가 실립니다. workflow 진행 중에는 `writeTargets` 밖 파일이 같은 기준으로 거부됩니다. |
| workflow 변경 | `start_workflow`, `record_stage_result`, `finalize_workflow` 같은 workflow 변경 도구가 성공하면 다음 단계와 함께 설치된 스킬 전체의 대상 목록이 응답에 붙습니다. 단계에 적힌 provider는 결과를 기록하는 계약일 뿐이고, 그 단계에서 쓸 스킬을 제한하지 않습니다. |
| 턴 종료 | 이번 구간에 제품 파일을 고쳤는데 진행 중인 workflow에 통과하지 않은 단계가 남아 있으면, 그 workflow의 `runId`·`rootId`와 목표, 남은 단계를 알리고 이어서 진행하게 합니다. 대기 중인 PEER 메시지도 이때 전달될 수 있습니다. |
| 세션 협업 | hook이 세션 ID, 작업 디렉터리, 사용자 입력 시각을 현황판에 기록합니다. 에이전트는 지금 하는 일을 한 줄로 적고, 사용자가 정한 세션의 역할이 있으면 `role`에 함께 적습니다. 받은 요청이 자기 역할 밖이면 그 역할을 맡은 세션에 PEER 메시지로 넘기고, 맡을 세션이 없거나 응답이 없으면 사용자에게 묻도록 공통 접수 기준이 안내합니다. 현황판과 역할은 작업을 막는 관문이나 권한이 아닙니다. |

workflow 완료 결과는 계획한 단계가 모두 통과하고 미해결 항목이 없을 때만 발급됩니다. 끝나지 않은 옛 workflow root가 경로를 잡고 있어 새 workflow가 `ROOT_CONFLICT`로 막히면, 오류의 `details`에 그 root의 시각·최신 run·소유 세션 상태·다음 행동이 실립니다. 자기 root는 `release_convergence_root`로 놓을 수 있습니다. 다른 세션의 root는 소유 세션이 online이 아니고 사용자 결정이 있을 때만 놓을 수 있습니다.

## 사용하기

### 평소처럼 요청하기

작업과 확인할 조건을 평소처럼 요청하면 됩니다. 에이전트가 설치된 스킬의 설명과 적용 조건을 대조해 필요한 스킬을 고릅니다.

```text
이 기능을 구현하고 검증해 줘. 수정 범위와 완료 기준을 먼저 정리하고,
최종 결과에는 실제로 실행한 검사와 아직 해결하지 못한 문제를 함께 적어 줘.
```

스킬을 직접 지정하려면 Codex에서는 `$orchestrator`, Claude Code에서는 `/agent-governance-suite:orchestrator`처럼 요청합니다. 스킬 분류 조언(`classify_skills`)은 분류 설정이 있는 환경에서만 동작하며, 최종 선택은 에이전트가 합니다.

### 여러 세션이 협업하기

같은 컴퓨터, 같은 OS 사용자의 세션끼리 협업합니다. 세션은 현황판(`list_session_status`)에서 상대의 호스트·세션 ID·작업을 찾고, `send_session_message`로 PEER 메시지를 보냅니다. 메시지는 시스템이 발급한 ID로 추적하며 전송, 본문 전달, 처리 확인(ACK)을 따로 기록합니다. **ACK는 메시지를 처리했다는 확인일 뿐, 작업 완료나 실행 승인이 아닙니다.** 수신 세션이 오프라인이면 발신 세션은 기다리며 멈추지 않고 답이 필요 없는 일을 계속합니다.

메시지는 수신 세션의 도구 경계나 턴 종료 때 전달됩니다. 쉬고 있는 세션을 깨우는 방식은 호스트마다 다릅니다.

| 호스트 | 쉬는 세션 깨우기 |
| --- | --- |
| Claude Code | 기본으로 지원합니다(`claude-inbox`). |
| Codex | 기본은 지연 전달(`codex-deferred`)이라 깨우지 않습니다. [queue wake 설정](docs/input-boundaries.md#codex-queue-wake-설정)을 켜면 깨웁니다. |
| Antigravity | Antigravity 실행 환경 정보가 있으면 대기열로 깨웁니다. `AGENT_GOVERNANCE_ANTIGRAVITY_QUEUE_WAKE`로 켜고 끌 수 있습니다. |

두 세션으로 직접 확인하려면 같은 프로젝트를 연 세션 두 개에 다음처럼 요청합니다. 코드는 바꾸지 않습니다.

```text
[검토 세션]
AGS 현황판의 현재 작업을 "AGS-DEMO-REVIEW · 테스트 실행 방법 검토"로 기록해 줘.
PEER 메시지로 검토 요청이 오면 전달받은 파일을 직접 읽고 설명이 맞는지 확인해,
ACK를 남기고 결과와 근거를 별도 PEER 메시지로 회신해 줘. 파일 수정과 테스트 실행은 하지 마.

[조사 세션]
이 프로젝트의 테스트 실행 방법을 문서와 설정에서 찾아 명령과 근거 파일 위치를 정리해 줘.
현황판에서 "AGS-DEMO-REVIEW"를 맡은 세션을 찾아 PEER 메시지로 검토를 요청하고,
ACK와 실제 검토 결과를 구분해서 알려 줘. 파일 수정과 테스트 실행은 하지 마.
```

메시지가 오지 않으면 같은 `messageId`로 `get_session_message_status`를 확인합니다. 결과가 불명확한 메시지를 새 ID로 다시 보내지 않습니다. 자세한 상태 해석은 [메시지 수명](docs/session-message-lifecycle.md)에 있습니다.

## 스킬

전문 스킬 24개의 버전과 출처는 [registry](skills/registry.json)와 [source lock](skills/source-lock.json)을 따릅니다. 이 밖에 흐름을 연결하는 [`orchestrator`](skills/orchestrator/)와 현황판 사용법을 담은 [`session-board`](skills/session-board/)가 있습니다. 작업 기록은 스킬이 아니라 MCP 도구(`checkpoint_context`, `inspect_context`, `load_context`, `suppress_context_restore`, `purge_direct_context`)와 hook이 맡습니다.

| 스킬 | 출처 | 버전 | 하는 일 |
| --- | --- | --- | --- |
| [`instruction-scope-resolver`](skills/instruction-scope-resolver/) | AGS | 1.0.0 | 경로에 적용되는 지침 파일과 우선순위를 확인합니다. |
| [`workspace-convention-profiler`](skills/workspace-convention-profiler/) | AGS | 1.0.0 | 저장소 구조, 관례, 검증 명령을 조사합니다. |
| [`task-contract`](skills/task-contract/) | AGS | 1.1.0 | 목표, 범위, 완료 기준, 위험, 권한을 작업 계약으로 정리합니다. |
| [`model-effort-advisor`](skills/model-effort-advisor/) | AGS | 0.1.0 | 관측된 모델·추론 수준이 작업의 난도와 위험에 맞는지 봅니다. |
| [`coordinate-subagents`](skills/coordinate-subagents/) | AGS | 1.1.0 | 위임할지 판단하고 담당 범위, 전달할 맥락, 검증 책임을 정합니다. |
| [`ponytail`](skills/ponytail/) | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail/tree/83b2cbc3bc50df3030c49d1dfe598ccefe850a85) 기반, AGS 수정 | 4.10.0 | 요구를 만족하는 가장 작은 완전한 구현을 고릅니다. |
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
| [`codex-token-usage-analyzer`](skills/codex-token-usage-analyzer/) | AGS | 0.1.0 | 로컬 Codex 로그에서 작업·프로젝트별 토큰 사용량을 집계합니다. Claude Code 패키지에는 없습니다. |

`test-engineering`과 `code-review`가 함께 쓰는 엔지니어링 모듈은 [엔지니어링 실무 통합](docs/engineering-practices.ko.md)에 정리했습니다.

## 상태 저장과 업데이트

| 데이터 | 위치 |
| --- | --- |
| workflow 상태(`workflows.sqlite3`), 작업 기록(`continuity.sqlite3`) | Claude Code는 `${CLAUDE_PLUGIN_DATA}`. 그 밖의 호스트는 Windows `%LOCALAPPDATA%\agent-governance-suite`, macOS `~/Library/Application Support/agent-governance-suite`, Linux `$XDG_STATE_HOME/agent-governance-suite`(기본 `~/.local/state/agent-governance-suite`) |
| 현황판(`session-board.sqlite3`), 메시지(`session-messaging/`) | 모든 호스트가 함께 쓰는 `~/.agent-governance-suite` |

샌드박스처럼 기본 경로가 달라지는 환경에서는 참여하는 모든 호스트에 같은 절대 경로의 `AGENT_GOVERNANCE_SHARED_STATE_DIR`를 줍니다. 경로를 바꾸는 환경 변수 전체는 [운영 문서](docs/operations.md#상태-저장과-마이그레이션)에 있습니다.

저장 내용은 평문 JSON이며 자동으로 만료되지 않습니다. 비밀값, 개인정보, 원시 로그를 작업 기록이나 단계 결과에 넣지 마십시오. 오래된 상태는 `prepare_state_cleanup`으로 미리 보고, 사용자가 확인한 token을 `execute_state_cleanup`에 넘겨야 지워집니다(끝난 workflow 180일, 비활성 작업 기록 본문 30일). 삭제 전에 backup을 만들며 backup은 자동으로 지우지 않습니다. [보존과 정리](docs/state-cleanup.md)

MCP 서버는 새 공개 안정 버전이 있으면 도구 응답에 한 번 알리며, 직접 확인하려면 `check_for_updates`를 씁니다. 자동으로 설치하지는 않습니다. 업데이트할 때는 기존 AGS MCP·relay를 끝내고, 위 설치 절차로 새 버전을 설치한 뒤 새 세션을 시작합니다. Codex는 `/hooks`에서 hook을 다시 신뢰하고, agy는 앱을 닫고 새 설치본을 설치합니다. [업데이트와 복구](docs/session-message-lifecycle.md#업데이트와-복구)

## 보장하지 않는 것

- **같은 OS 사용자 권한의 프로세스를 막는 보안 경계가 아닙니다.** 그런 프로세스는 상태 DB를 읽고 바꾸거나 MCP 서버를 직접 호출할 수 있습니다. ([아키텍처](docs/architecture.md#세션-메시지-저장소-broker-없음), [보안 정책](SECURITY.md))
- **제출된 근거와 신원을 인증하지 않습니다.** 증거의 `verified` 값, 감사자 신원, 사용자 승인 참조는 형식과 단계 사이의 일관성만 검사합니다.
- **편집 관문은 편집 도구 호출만 셉니다.** 셸 명령으로 바꾼 파일, 버전 관리 밖 파일, 서브에이전트의 편집은 세지 않고, 구간은 턴마다 다시 셉니다.
- **메시지 전달 상태는 작업 결과가 아닙니다.** ACK와 깨우기 시도는 처리나 완료의 증거가 아니며, Esc로 중단된 Codex 세션은 사용자가 재개할 때까지 깨울 수 없습니다.
- **턴 확인 안내는 행동을 강제하지 않습니다.** 앞서 호출한 스킬의 본문은 호스트가 대화에 남기며 AGS가 지울 수 없습니다. 서브에이전트 안내는 서브에이전트 시작 hook이 있는 Claude Code·Codex에만 들어가고, agy의 서브에이전트에는 들어가지 않습니다. 위임 규칙은 공통 접수 기준과 메시지마다 나가는 안내로 알릴 뿐 위임 도구 호출을 검사하지 않습니다.
- **검증 범위가 제한됩니다.** 3.8.0 후보의 hook·현황판 변경은 CI 시험으로만 확인했고 실호스트 시험은 하지 않았습니다([3.8.0 릴리스 노트 초안](docs/release-notes-v3.8.0.md#검증)). 3.7.0은 3.6.0의 실행 코드를 바꾸지 않았으므로 실호스트 시험은 3.6.0의 Linux 시험 서버 비교 시험까지이며, 전체 실호스트 재측정과 양 Cloud 검증은 완료로 주장하지 않습니다. `korean-prose-editor`의 현행 편집 정책 품질 평가와 새 `ui-ux-design`의 실제 설계 품질 평가도 끝나지 않았습니다. ([3.7.0 릴리스 노트](docs/release-notes-v3.7.0.md#검증), [3.6.0 릴리스 노트](docs/release-notes-v3.6.0.md#검증), [로드맵](docs/roadmap.md))

## 문제 해결

| 증상 | 확인할 것 |
| --- | --- |
| 스킬이나 MCP 도구가 보이지 않는다 | 설치 후 새 세션을 시작했는지, 호스트에서 플러그인과 MCP가 켜져 있는지, 같은 호스트에 두 언어 패키지가 함께 켜져 있지 않은지 확인합니다. |
| MCP 서버가 시작되지 않는다 | 호스트가 실행하는 Node.js가 24.0.0 이상인지와 MCP 시작 로그를 확인합니다. |
| Codex에서 안내·현황판·메시지가 동작하지 않는다 | `/hooks`에서 AGS hook을 신뢰했는지 확인합니다. |
| agy 설치가 실패한다 | Antigravity 앱을 닫고 다시 설치합니다. 저장소 전체가 아니라 릴리스 설치본을 설치합니다. |
| 파일 편집이 workflow를 시작하라며 거부된다 | 거부 문구의 예처럼 `start_workflow`로 목표·단계·수용 기준·`writeTargets`를 주고 시작합니다. |
| `start_workflow`가 `ROOT_CONFLICT`로 막힌다 | `details`에 적힌 root와 다음 행동을 확인합니다. 자기 root는 `release_convergence_root`로 놓습니다. |
| `BINDING_REQUIRED` 같은 실행 관측 오류가 난다 | [실행 관측 계약](docs/host-execution-attestation.md)에서 호스트별 원인 코드를 확인합니다. |
| 다른 세션이 현황판에 보이지 않는다 | 상대 세션의 hook이 동작하는지, 두 호스트가 같은 공용 상태 경로를 쓰는지 확인합니다. |
| 메시지에 반응이 없거나 ACK만 왔다 | 같은 `messageId`로 상태를 확인하고, 수신 호스트의 깨우기 방식을 확인합니다. 검토 결과는 별도 메시지로 요청합니다. |
| 업데이트했는데 예전 동작이 남는다 | 이전 AGS MCP·relay가 아직 실행 중인지 확인하고 [업데이트 절차](docs/session-message-lifecycle.md#업데이트와-복구)대로 다시 연결합니다. |

## 문서

| 목적 | 문서 |
| --- | --- |
| 구조와 계약 | [아키텍처](docs/architecture.md), [운영과 참고](docs/operations.md) |
| 세션 협업 | [메시지 수명](docs/session-message-lifecycle.md), [입력 출처와 작업 경계](docs/input-boundaries.md), [peer 대기 정책](docs/peer-wait-policy.md) |
| 실행 관측 | [실행 관측과 호스트 연결](docs/host-execution-attestation.md) |
| 상태와 보안 | [보존과 정리](docs/state-cleanup.md), [보안 정책](SECURITY.md) |
| 개발과 릴리스 | [기여 안내](CONTRIBUTING.md), [개발 참고](docs/development.md), [릴리스 점검](docs/release.md), [로드맵](docs/roadmap.md) |

## 라이선스

[MIT License](LICENSE)
