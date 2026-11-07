# Agent Governance Suite

한국어 | [English](README.en.md)

Agent Governance Suite(AGS)는 Claude Code, Codex, Antigravity(`agy`)에 설치하는 로컬 플러그인입니다. 에이전트가 요청에 맞는 전문 스킬을 사용하고, 여러 단계의 일을 완료 기준에 따라 진행하며, 사용자의 교정과 남은 일을 이어가도록 돕습니다. 문서·조사·의사결정·안내물·소프트웨어 작업에 사용할 수 있습니다.

이 README는 **3.8 작업본의 변경을 포함합니다. 3.8은 아직 발행하지 않았으며**, 아래 설치 명령은 현재 공개 안정 버전 기준입니다. 설치한 버전의 동작은 해당 릴리스 노트와 함께 확인하십시오.

[사용하기](#사용하기) · [설치](#설치) · [설치하면 달라지는 것](#설치하면-달라지는-것) · [작업 기록과 협업](#작업-기록과-협업) · [스킬](#스킬) · [보장하지 않는 것](#보장하지-않는-것) · [문제 해결](#문제-해결) · [문서](#문서)

## 어떤 일에 쓰나요?

| 하려는 일 | AGS가 돕는 부분 |
| --- | --- |
| 자료를 조사하고 결정을 내리기 | 목표·제약·완료 기준 정리, 의견이 갈리는 선택의 검토, 주장과 실제 근거의 대조 |
| 문서·안내문·서비스 절차 만들기 | 독자와 이용자의 흐름·접근성 점검, 프롬프트 설계, 사실을 보존한 한국어 산문 편집 |
| 소프트웨어를 만들거나 고치기 | 작은 구현 방향 선택, 설계·시험·코드 리뷰·보안 검토, 반복 실패의 원인 판별 |
| 여러 단계나 세션에 걸쳐 이어가기 | workflow 진행 상태, 교정·남은 일의 작업 기록, 세션 현황판과 PEER 메시지 |

AGS에는 전문 스킬 23개와 흐름을 연결하는 `orchestrator`, 현황판 사용을 돕는 `session-board`가 들어 있습니다. 로컬 MCP 서버는 workflow와 기록 도구를 제공하고, 호스트 hook은 세션·턴·도구 경계에서 안내와 관측을 보탭니다. 안내가 있다는 사실만으로 에이전트가 지시를 따랐거나 결과가 검증됐다고 볼 수는 없습니다.

## 사용하기

### 평소처럼 요청하기

원하는 결과와 확인할 조건, 바꾸면 안 되는 대상을 함께 알려 주십시오. 모든 요청에 스킬이나 workflow를 직접 지정할 필요는 없습니다. 에이전트가 요청 목적과 스킬의 적용·제외 조건을 대조하고, 단계가 이어지는 변경에는 workflow를 사용합니다. 질문·설명이나 전문 스킬 하나로 끝나는 일은 그 범위에서 처리합니다.

```text
이 안내문을 처음 방문하는 사람이 예약까지 진행할 수 있게 고쳐 줘.
예약 조건과 연락처는 보존하고, 바꾸기 전에 확인할 사례를 적어 줘.
실제로 확인한 것과 사람의 확인이 남은 것을 나눠 알려 줘.
```

```text
이 기능을 구현하고 검증해 줘. 수정 범위와 완료 기준을 먼저 정리하고,
최종 결과에는 실제로 실행한 검사와 아직 해결하지 못한 문제를 함께 적어 줘.
```

스킬을 직접 지정하려면 Codex에서는 `$orchestrator`, Claude Code에서는 `/agent-governance-suite:orchestrator`처럼 요청합니다. 스킬 분류 조언(`classify_skills`)은 분류 설정이 있는 환경에서만 동작하며, 최종 선택은 에이전트가 합니다.

### 설치하면 달라지는 것

| 시점 | AGS의 동작 |
| --- | --- |
| 시작·재개·압축 뒤 | 스킬 선택과 workflow 사용 기준을 안내합니다. 재개·압축 뒤에는 기존 hook으로 현재 메모리 본문을 주입하며, 본문·토큰이 필요하면 `load_context`로 자기 current를 읽습니다. workflow 요약·구조 카드는 별도 계약을 따릅니다. 안내 출력과 모델의 실제 소비·준수는 구분해야 합니다. |
| 사용자 메시지마다 | 턴 확인 안내와 설치된 스킬별 대상 목록으로 선택을 다시 살피게 합니다. 교정·결정·승인·금지·남은 일을 `checkpoint_context`에 저장하라는 안내도 포함합니다. |
| 서브에이전트 시작 | Claude Code·Codex의 SubagentStart hook이 대상 목록과 맡은 범위·금지 구역·쓰기 소유를 지키라는 안내를 넣습니다. agy에는 이 시작 hook이 없습니다. |
| 파일을 바꿀 때 | 호스트가 전달한 편집 대상 경로를 workflow 범위와 대조합니다. workflow가 없는 제품 파일과 진행 중 workflow의 범위 밖 제품 파일은 workflow 시작·턴 종료 검사 사이의 구간에서 세며, 서로 다른 세 번째 파일을 바꾸는 호출부터 거부합니다. 검토·사용자 판단을 기다리는 root의 대상에는 별도 거부가 적용됩니다. 아래 한계를 함께 확인하십시오. |
| 단계 결과·턴 종료 | workflow 도구가 단계 결과와 남은 항목을 검사합니다. 제품 파일 편집 뒤 미통과 단계가 남으면 이어갈 일을 안내합니다. 기록상 완료는 모든 계획 단계 통과와 미해결 항목 없음이 조건이며, 제출 내용의 진실성은 별도 검증이 필요합니다. |

### 하위 작업의 모델과 추론 수준

`model-effort-advisor`는 **이미 승인된 서브에이전트 작업을 호출하기 전에** 역할·난도·위험·검증 가능성과 품질·속도·비용 선호를 살펴 모델·추론 수준을 선택하도록 돕습니다. `economy`, `balanced`, `quality` 선호를 쓸 수 있고 기본값은 `balanced`입니다. 위임할지, 몇 명을 쓸지, 어떤 권한과 감사를 줄지는 이 스킬이 정하지 않습니다. 현재 메인 모델을 관측하거나 UI 설정을 바꾸는 상담 기능도 아닙니다.

공통 선택 계약은 벤더와 분리되어 있습니다. 현재 배포 catalog에는 OpenAI/Codex, Anthropic/Claude Code, Google/Gemini 계열 adapter가 있고, 실행 호스트는 Claude Code·Codex·Gemini·Antigravity 항목으로 구분합니다. **catalog에 있는 조합이 현재 호스트에서 사용 가능하다는 뜻은 아닙니다.** 실제 호스트가 제공한 지원 정보와 호출 필드를 먼저 확인해야 합니다. Gemini catalog 항목 자체는 별도 Gemini CLI 설치 패키지의 지원 선언이 아닙니다.

선택한 값, 실제 호출에 보낸 값, 호스트에서 관측한 유효 설정을 따로 기록합니다. 지원 정보로 선택이 가능해도 실제 적용까지 확인된 것은 아닙니다. 상속 설정을 볼 수 없으면 미확인으로 남기며, 필수 위험 하한을 확인할 수 없는 호출은 보류합니다. [모델 라우팅과 호스트별 적용](skills/coordinate-subagents/references/model-routing.md)

## 설치

필요한 것은 Node.js **24.0.0 이상**과 호스트의 플러그인 기능입니다. 협업할 호스트마다 설치합니다. 플러그인을 쓰는 데 이 저장소를 clone하거나 `pnpm install`을 실행할 필요는 없습니다.

<!-- release-version:start -->
현재 공개 릴리스는 `v3.8.0`이며 아래 설치 예시는 이 버전 기준입니다. 3.x는 2.x와 호환하지 않습니다. 버전별 변경 사항은 [GitHub 릴리스](https://github.com/jaeseongs95/agent-governance-suite/releases)와 `docs/release-notes-v<버전>.md`에 있습니다.
<!-- release-version:end -->

### 패키지 고르기

호스트마다 한국어 패키지와 영어 전용 패키지가 있습니다. 영어 전용 패키지는 AGS 메시지, MCP 도구 설명, hook 문구, 오류를 영어로 내고, 스킬 본문은 원문(대부분 한국어) 그대로 둡니다. 상태는 같은 위치에 저장되므로 다시 설치해서 언어를 바꿀 수 있습니다. **한 호스트에서는 둘 중 하나만 켜십시오.** 둘 다 켜면 Claude Code는 한쪽 hook만 불러오고 Codex는 둘 다 실행합니다.

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
codex plugin marketplace add jaeseongs95/agent-governance-suite --ref v3.8.0
codex plugin add agent-governance-suite@agent-governance
```
<!-- release-install:end -->

새 Codex 세션을 시작한 뒤 `/hooks`에서 AGS hook을 검토하고 신뢰합니다. 신뢰하기 전에는 플러그인 hook이 실행되지 않아 턴 확인 안내, 작업 기록, 현황판, 메시지 전달이 동작하지 않습니다. hook 정의가 바뀐 버전으로 업데이트하면 다시 검토합니다.

### Antigravity (`agy`)

`agy` CLI가 없는 Antigravity 네이티브 앱에서는 [공식 수동 설치 안내](https://antigravity.google/docs/plugins#manual-plugin-installation)를 따릅니다. 앱을 정상 종료하고 기존 AGS 폴더를 플러그인 검색 경로 밖에 복구용으로 보존한 뒤, 릴리스에 첨부된 Antigravity 설치용 ZIP의 `agent-governance-suite` 폴더를 `~/.gemini/config/plugins/` 아래에 배치합니다(Windows: `%USERPROFILE%/.gemini/config/plugins/agent-governance-suite`). 앱을 다시 시작하고 `Customizations > Installed`에서 AGS 버전을 확인합니다. 저장소 전체를 복사하지 마십시오. 이 방식에는 CLI 추가 설치가 필요하지 않습니다.

`agy plugin install`은 로컬 디렉터리만 받습니다. 릴리스에 첨부한 설치본을 받아 풀고 그 디렉터리를 설치합니다. 설치본에는 agy가 읽는 파일만 들어 있습니다. 저장소 전체를 설치하면 Antigravity 앱의 설치됨 화면이 멈출 수 있습니다. 설치하는 동안 Antigravity 앱을 닫아 둡니다. 앱이 켜져 있으면 기존 설치 폴더를 지우지 못해 설치가 실패합니다. Windows에서는 `Expand-Archive`로 풉니다.

<!-- release-agy:start -->
```bash
curl -LO https://github.com/jaeseongs95/agent-governance-suite/releases/download/v3.8.0/agent-governance-suite-antigravity-v3.8.0.zip
unzip agent-governance-suite-antigravity-v3.8.0.zip
agy plugin install ./agent-governance-suite
agy plugin list
```
<!-- release-agy:end -->

설치본에는 MCP 서버 등록(`mcp_config.json`, 서버 이름 `ags`, `AGENT_GOVERNANCE_HOST_ATTESTATION=antigravity`)과 hook(`hooks.json`)이 함께 들어 있어 따로 설정할 것이 없습니다. 이 저장소의 `GEMINI.md`와 `AGENTS.md`는 AGS 자체를 개발할 때 쓰는 지침이며 설치본에 들어 있지 않습니다.

## 작업 기록과 협업

### 작업을 이어가기

에이전트는 교정·결정·남은 일을 작업 기록에 저장하고, 재개할 때 원문과 현재 상태를 대조합니다. 작업 기록은 workflow의 단계 원장을 복제하는 기능이 아닙니다. 저장된 요약이 있어도 실제 파일·환경·시험 결과를 다시 확인해야 합니다. 비밀값이나 개인 로그를 기록에 넣지 마십시오.

사용자가 맡긴 역할이 있으면 현황판에 현재 작업과 함께 기록합니다. 역할 밖 요청은 담당 세션을 찾아 넘기도록 안내하지만, 현황판의 역할은 접근 권한이나 실행 승인이 아닙니다.

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

## 상태 저장과 업데이트

**3.8.0으로 갱신하기 전에는 [기존 데이터 백업·이관·복구 가이드](https://github.com/jaeseongs95/agent-governance-suite/blob/v3.8.0/docs/migrate-to-v3.8.0.md)를 먼저 확인하십시오.**

| 데이터 | 위치 |
| --- | --- |
| workflow 상태(`workflows.sqlite3`), 작업 기록(`continuity.sqlite3`) | Claude Code는 `${CLAUDE_PLUGIN_DATA}`. 그 밖의 호스트는 Windows `%LOCALAPPDATA%\agent-governance-suite`, macOS `~/Library/Application Support/agent-governance-suite`, Linux `$XDG_STATE_HOME/agent-governance-suite`(기본 `~/.local/state/agent-governance-suite`) |
| 현황판(`session-board.sqlite3`), 메시지(`session-messaging/`) | 모든 호스트가 함께 쓰는 `~/.agent-governance-suite` |

샌드박스처럼 기본 경로가 달라지는 환경에서는 참여하는 모든 호스트에 같은 절대 경로의 `AGENT_GOVERNANCE_SHARED_STATE_DIR`를 줍니다. 경로를 바꾸는 환경 변수 전체는 [운영 문서](docs/operations.md#상태-저장과-마이그레이션)에 있습니다.

작업 기록 본문과 단계 결과는 로컬 DB에 암호화 없이 저장되며, 아래 보존 기간만으로 자동 삭제되지 않습니다. 비밀값, 개인정보, 원시 로그를 작업 기록이나 단계 결과에 넣지 마십시오. 오래된 상태는 `prepare_state_cleanup`으로 미리 보고, 사용자가 확인한 token을 `execute_state_cleanup`에 넘겨야 지워집니다(끝난 workflow 180일, 비활성 작업 기록 본문 30일). 삭제 전에 backup을 만들며 backup은 자동으로 지우지 않습니다. [보존과 정리](docs/state-cleanup.md)

MCP 서버는 새 공개 안정 버전이 있으면 도구 응답에 한 번 알리며, 직접 확인하려면 `check_for_updates`를 씁니다. 자동으로 설치하지는 않습니다. 업데이트할 때는 기존 AGS MCP·relay를 끝내고, 위 설치 절차로 새 버전을 설치한 뒤 새 세션을 시작합니다. Codex는 `/hooks`에서 hook을 다시 신뢰하고, agy는 앱을 닫고 새 설치본을 설치합니다. [업데이트와 복구](docs/session-message-lifecycle.md#업데이트와-복구)

### 로컬 프로세스와 메시지 저장

AGS 메시징은 공용 SQLite 파일을 각 프로세스가 직접 엽니다. 별도 메시지 broker 서버·TCP 수신 포트·broker 인증서나 token을 설치하지 않습니다. 다만 세션의 생존 확인과 메시지 깨우기를 맡는 **relay 프로세스는 실행될 수 있습니다**. relay는 호스트 프로세스와 lease에 묶여 동작하며, 이는 “백그라운드 프로세스가 전혀 없다”는 뜻이 아닙니다. 호스트 자체나 외부 모델 서비스의 네트워크 사용은 이 메시징 저장 구조와 별개입니다.

## 스킬

전문 스킬 23개의 버전과 출처는 [registry](skills/registry.json)와 [source lock](skills/source-lock.json)을 따릅니다. 이 밖에 흐름을 연결하는 [`orchestrator`](skills/orchestrator/)와 현황판 사용법을 담은 [`session-board`](skills/session-board/)가 있습니다. 작업 기록은 스킬이 아니라 MCP 도구(`checkpoint_context`, `inspect_context`, `load_context`, `suppress_context_restore`, `purge_direct_context`)와 hook이 맡습니다.

| 스킬 | 출처 | 버전 | 하는 일 |
| --- | --- | --- | --- |
| [`instruction-scope-resolver`](skills/instruction-scope-resolver/) | AGS | 1.0.0 | 경로에 적용되는 지침 파일과 우선순위를 확인합니다. |
| [`workspace-convention-profiler`](skills/workspace-convention-profiler/) | AGS | 1.0.0 | 저장소 구조, 관례, 검증 명령을 조사합니다. |
| [`task-contract`](skills/task-contract/) | AGS | 1.1.0 | 목표, 범위, 완료 기준, 위험, 권한을 작업 계약으로 정리합니다. |
| [`model-effort-advisor`](skills/model-effort-advisor/) | AGS | 0.2.0 | 승인된 서브에이전트를 호출하기 전에 작업 요구와 호스트 지원 조합으로 모델·추론 수준을 선택합니다. |
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

`test-engineering`과 `code-review`가 함께 쓰는 엔지니어링 모듈은 [엔지니어링 실무 통합](docs/engineering-practices.ko.md)에 정리했습니다.

## 보장하지 않는 것

- **같은 OS 사용자 권한에 대한 보안 경계가 아닙니다.** 해당 권한의 프로세스는 상태 DB를 읽고 바꾸거나 MCP 서버를 직접 호출할 수 있습니다. 제출된 근거·감사자 신원·사용자 승인 참조의 형식과 일관성을 검사해도 진실성을 인증하는 것은 아닙니다. [아키텍처](docs/architecture.md#세션-메시지-저장소-broker-없음) · [보안 정책](SECURITY.md)
- **편집 관문은 파일시스템 전체를 감시하지 않습니다.** 지원 편집 도구와 셸의 명시적 출력 리다이렉션·일부 PowerShell 쓰기 경로를 다룹니다. 관측된 child 편집은 부모 세션의 창에 포함됩니다. 임의 스크립트·별칭·동적 경로·제어 흐름으로 생긴 쓰기를 모두 알아내지 못합니다. 버전 관리 밖 파일은 세 파일 한도에서 제외되지만 검토·사용자 판단 대기 root의 대상 확인에는 포함됩니다. AGS 내부 장애로 검사가 불가능하면 편집을 무조건 차단하는 대신 그 상태를 기록하고 알립니다.
- **안내·스킬 호출·도구 성공은 행동 완료와 다릅니다.** 턴 확인 안내는 지시 준수를 강제하지 않으며, 앞서 읽은 스킬 본문을 대화에서 지우지도 못합니다. 위임 규칙은 안내하고, 위임 호출 전체를 검사하지 않습니다. 모델 선택 요청이나 catalog를 실제 적용 관측으로 바꾸지 않습니다.
- **메시지 ACK와 깨우기는 업무 결과나 승인이 아닙니다.** 검토 결과와 근거를 별도로 회수하십시오. Esc로 중단된 Codex 세션은 사용자가 재개할 때까지 깨울 수 없습니다.

### 검증 상태를 읽는 방법

3.8 작업 중 Linux TEST에서 공식 Claude Code·Codex 경로로 실제 모델 pilot을 실행했습니다. 실제 스킬 사용·파일 변경·일부 결함 탐지는 관측했지만, **변경 전 요구별 사례 기록 누락과 허용 범위 밖 임시 파일 작업 같은 행동 실패도 남았습니다.** 실행 종료 코드와 CI 통과만으로 전체 행동을 통과로 판정하지 않습니다. [Claude 후속 결과](v380-d36-t4-e071117f-result.ko.md) · [작업 기록·소비자 시험 결과](v380-qb-m23-result.ko.md) · [다중 턴 결과](v380-qb-m456-result.ko.md)

후보·호스트·CLI 버전별 결과는 서로 대신할 수 없습니다. hook 출력, MCP 성공 응답, 모델에 전달된 입력 전문, 실제 준수는 각각 확인해야 합니다. 모델 입력 전문과 일부 admission 경로, 전체 호스트·Cloud 조합, 실제 인쇄·사람 사용성은 위 결과만으로 입증되지 않습니다. advisor의 새 호출 전 경로도 이 과거 pilot의 검증 결과로 간주하지 않습니다. 한국어 편집 정책과 UX 산출물의 품질 평가 역시 완료됐다고 주장하지 않습니다. [3.8 작업 노트](docs/release-notes-v3.8.0.md#검증) · [3.7 검증](docs/release-notes-v3.7.0.md#검증) · [3.6 검증](docs/release-notes-v3.6.0.md#검증) · [로드맵](docs/roadmap.md)

## 문제 해결

| 증상 | 확인할 것 |
| --- | --- |
| 스킬이나 MCP 도구가 보이지 않는다 | 설치 후 새 세션을 시작했는지, 호스트에서 플러그인과 MCP가 켜져 있는지, 두 언어 패키지가 함께 켜져 있지 않은지 확인합니다. |
| MCP 서버가 시작되지 않는다 | 호스트가 실행하는 Node.js가 24.0.0 이상인지와 해당 호스트의 MCP 시작 진단을 확인합니다. |
| Codex에서 안내·현황판·메시지가 동작하지 않는다 | `/hooks`에서 AGS hook을 검토하고 신뢰했는지 확인합니다. |
| agy 설치가 실패한다 | 앱을 닫고 릴리스 설치본을 설치합니다. 저장소 전체를 설치하지 않습니다. |
| 파일 편집이 workflow를 요구하며 거부된다 | 거부 문구의 예대로 `start_workflow`에 목표·단계·수용 기준·`writeTargets`를 줍니다. 기존 workflow 밖 작업이라면 별도 범위를 정합니다. |
| `ROOT_CONFLICT`로 시작할 수 없다 | 오류 `details`에 있는 기존 root·상태·다음 행동을 확인합니다. 자기 root는 `release_convergence_root`로 해제할 수 있습니다. 다른 세션의 root는 소유자가 online이 아니고 사용자 결정이 있을 때만 해제합니다. |
| advisor가 지원 정보 부족으로 호출을 보류한다 | 현재 호스트의 모델·추론 지원 근거를 확인합니다. catalog나 요청값으로 실제 적용을 추측하지 않습니다. |
| `BINDING_REQUIRED` 같은 실행 관측 오류가 난다 | [실행 관측 계약](docs/host-execution-attestation.md)의 호스트별 원인을 확인합니다. 모델 선택 조언과 실행 자격은 별개입니다. |
| 다른 세션이 보이지 않거나 메시지에 ACK만 온다 | hook·공용 상태 경로·호스트 깨우기 방식을 확인하고, 같은 `messageId`로 상태를 조회합니다. 실제 작업 결과는 따로 요청합니다. |
| 업데이트 뒤 예전 동작이 남는다 | 기존 AGS MCP·relay가 종료됐는지 확인하고 [업데이트 절차](docs/session-message-lifecycle.md#업데이트와-복구)대로 새 세션으로 연결합니다. |

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
