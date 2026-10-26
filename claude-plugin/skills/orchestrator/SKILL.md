---
name: orchestrator
description: 어떤 거버넌스 전문 스킬이 필요한지 정해야 하거나 여러 전문 결과의 실행 순서·입출력·gate를 연결해야 할 때 사용한다. 한 전문 스킬로 충분하면 그 스킬을 직접 쓰고, 전문 스킬이 필요 없는 요청이나 전문 판단·감사 자체에는 사용하지 않는다.
license: MIT
metadata:
  version: "1.2.0"
---

# Governance Orchestrator

전문 스킬의 책임을 바꾸지 않고 요청을 적절한 실행 흐름으로 연결한다. 이 스킬은 분류, 선택, 순서 결정, 입출력 전달, 중간 결과 확인과 최종 결과 통합만 맡는다. 보안 판단, 독립 감사, 반박 작성, 구현, 배포를 대신 수행하지 않는다.

<!-- skill-intake:start -->
## 공통 접수·선택 기준

요청의 목적, 실제로 수행할 행동과 전문 스킬의 적용·제외 조건을 대조해 선택한다. 선택 결과를 출력하지 않아도 선택은 상태 확인·읽기를 포함한 첫 도구 호출 전에 끝낸다. 키워드, 파일 종류나 `complex` 표시만으로 스킬을 붙이지 않는다. 사용자가 이름으로 지정한 스킬은 우선하고 다른 스킬로 대체하지 않지만, 필수 승인·검증·독립성 gate를 생략하는 권한으로 해석하지 않는다.

- 코드 작성·수정·설계나 라이브러리·의존성 선택 단계에는 `ponytail`이 현재 가용하고 활성화되어 있으며 사용자 지시와 충돌하지 않을 때 먼저 실제 호출한다. 명시적 disable·사용자 override는 선행 호출보다 우선한다. 후속 사용자의 명시적 사용 지시는 해당 요청 범위에서만 존중하며 전역 설정을 바꾸지 않는다. 부재·비활성인 스킬의 재활성화를 요구하거나 원 작업을 중단하지 않고 일반 engineering 원칙으로 계속한다. 이때 원 요구·수용 기준·필요한 시험은 줄이지 않는다. 코드 설명, 읽기 전용 일반 리뷰·감사·검증만 하는 요청에는 적용하지 않는다.
- 커밋·병합·push·태그처럼 실제 변경을 반영하는 요청에는 `change-scope-guardian`의 범위 확인을 적용한다. 삭제·배포·게시·권한·결제·마이그레이션 등 위험한 실제 변경 전에는 `mutation-risk-preflight`를 적용한다. 목표가 실제 변경인 요청은 상태 확인보다 먼저 해당 전문 스킬이나 `orchestrator`를 실제 호출한다. 개념 설명이나 명령 이력 조회는 그 행동을 실행하는 요청이 아니다.
- 필요한 전문 스킬 하나로 충분하면 그 스킬을 직접 호출한다. 여러 전문 결과의 순서·입출력·필수 gate를 연결해야 하면 `orchestrator`를 실제 호출한 뒤 각 전문 단계를 연결한다. 예를 들어 공개 push·태그·배포의 범위 확인과 위험 사전 점검을 함께 요구하는 흐름은 이 연결 기준으로 판단한다. 읽기 전용 확인에서 환경·권한 선행이 없으면 실제 변경을 실행하지 않는다.
- 선택한 스킬은 설치된 본문과 해당 참고 자료를 로드하고 지침에 따라 실제 작업·검증·산출물까지 수행한다. 이 문서와 참고 자료를 읽는 것은 전문 스킬 실행이 아니다. 스킬 이름을 언급하거나 호출이 시작됐다는 응답만으로 수행 완료를 판단하지 않는다.
- 전문 스킬이 필요 없는 설명·인사·일반 질문은 그대로 답한다. 단독 전문 작업이나 스킬이 필요 없는 요청에 registry 조회·계획·workflow run을 만들지 않는다. 모든 요청에 실패 영향 분류나 생략 이유를 출력하지 않는다.
- 스킬 분류 지원이 설정된 환경에서는 [공통 분류 지원 계약](references/skill-classification.md)에 따라 전체 inventory와 원문을 `classify_skills`에 전달한다. 분류는 오류 가능한 조언이며 AGENT가 사용자 요청과 실제 스킬의 적용·제외 조건을 대조해 채택·교정·기각하고 최종 선택한다. 점수는 정답이나 실행 승인이 아니다. JEV OFF·불가 시 사용 벤더의 검증된 중앙 고정 profile을 사용한다. 추천·선택·읽기·적용·검증과 실행 승인은 구분하며 미가용·미검증을 성공으로 처리하지 않는다.
<!-- skill-intake:end -->

일반 한국어 답변·진행 보고·결과 설명은 요청 목적에 맞게 직접 작성한다. 한국어라는 이유만으로 산문 전문 스킬이나 네 단계 workflow를 추가하지 않는다. 독립된 산문 편집·자연스러움 검증이 필요한 경우에만 요청한 capability를 선택한다. 전체 산문 workflow를 명시적으로 수행할 때는 `korean-prose-selection`, `korean-prose-editing`, `korean-prose-verification`, `korean-prose-finalization` 네 capability를 요청하고 descriptor의 artifact 의존성과 `phaseOrder`를 지킨다. 일부 단계만 요청하면 필요한 기존 artifact를 제공하며, 누락을 다른 단계의 자동 실행이나 검증 완료로 메우지 않는다. 원문은 전문 스킬 내부에서만 다루고 MCP 영수증의 reference-only policy는 유지한다.

## Claude Code에서의 호출과 관측

이 절은 호출 방식과 실행 관측만 바꾸며 위의 선택 기준, 아래 참고 자료의 실행 순서·결과 기록 규칙은 그대로 적용한다.

- 전문 스킬은 Skill 도구나 `/agent-governance-suite:<skill-name>` 명령으로 실제 호출한다. 사용자가 slash 명령이나 스킬 이름으로 지정한 스킬을 "이름으로 지정한 스킬"로 본다.
- 공통 계약이 요구하는 독립 감사자를 Claude Code에서 호출할 때는 `agent-governance-suite:independent-auditor` 서브에이전트 유형을 사용한다.
- SessionStart 훅은 공통 접수 원문을 안내 context로 전달한다. 훅 자체가 스킬을 선택하거나 실행했다고 간주하지 않는다.

### 실행 관측

- `plan_workflow`와 `record_stage_result`를 호출할 때마다 플러그인 훅이 그 호출을 낸 세션(서브에이전트가 호출했으면 그 서브에이전트)의 모델과 추론 수준을 transcript에서 관측해 서버에 넘긴다. 도구 인자에 `executionContext`나 `_hostAttestation`을 넣지 않는다. 넣어도 훅이 지우거나 덮어쓴다.
- `record_stage_result`의 관측 대상은 도구 호출자다. 메인 세션이 호출하면 메인 세션 관측이, 서브에이전트가 호출하면 그 서브에이전트 transcript 관측이 전달된다.
- 메인 세션의 SessionStart·PostModelSwitch 훅은 현재 세션 모델을 기록하고, PreToolUse 훅은 각 대상 도구 호출의 관측을 공통 host-attestation 경로로 전달한다. 관측 실패 뒤 처리 기준은 [MCP 실행 계약](references/mcp-execution.md)을 따른다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 결과 통합

최종 응답에는 선택한 스킬과 실행 순서, 각 단계의 확인된 결과, 열린 제한사항, 다음에 필요한 입력만 포함한다. 전문 스킬의 판정을 덮어쓰지 않는다. 고위험 변경의 완료 가능 여부는 독립 감사 게이트가 `PASS`로 판정한 경우에만 그렇게 표현한다.
