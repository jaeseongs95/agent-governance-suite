---
name: orchestrator
description: 어떤 거버넌스 스킬이 필요한지 정해야 하거나 거버넌스 전문 스킬을 둘 이상 순서대로 연결해야 할 때 쓴다(예: 계약 정리→관례 조사→구현→범위·근거 확인→감사, 여러 산출물을 하나의 완료 판정으로 묶을 때). 한 스킬로 충분하면 그 스킬을 직접 쓰고, 전문 스킬이 필요 없는 요청이나 전문 판단·감사 자체에는 쓰지 않는다.
license: MIT
metadata:
  version: "1.2.0"
---

# Governance Orchestrator

전문 스킬의 책임을 바꾸지 않고 요청을 적절한 실행 흐름으로 연결한다. 이 스킬은 분류, 선택, 순서 결정, 입출력 전달, 중간 결과 확인과 최종 결과 통합만 맡는다. 보안 판단, 독립 감사, 반박 작성, 구현, 배포를 대신 수행하지 않는다.

## 시작 전 확인

요청의 목적, 상태 변경 여부, 실패 영향, 현재 단계, 수용 기준과 사용자가 이름으로 지정한 스킬을 함께 보고 필요한 capability를 정한다. 키워드, 파일 종류나 `complex` 표시만으로 스킬을 붙이지 않는다. 지정한 전문 스킬은 우선하고 다른 스킬로 대체하지 않지만, 필수 승인·검증·독립성 gate를 생략하는 권한으로 해석하지 않는다.

한 전문 기능으로 충분하면 그 스킬을 직접 호출하고, 여러 전문 결과의 순서·입출력·gate 연결이 필요할 때만 이 흐름으로 연결한다. 전문 스킬이 필요 없는 요청은 그대로 진행하며, 적용 여부가 애매했을 때만 생략 이유를 한 줄로 밝힌다. 이 문서와 참고 자료를 읽는 것은 전문 스킬 실행이 아니다.

한국어 산문을 작성·편집하거나 자연스러움을 검증하는 요청은 일부 단계만 선택하지 않는다. `korean-prose-selection`, `korean-prose-editing`, `korean-prose-verification`, `korean-prose-finalization` 네 capability를 모두 요청하고, descriptor의 artifact 의존성과 `phaseOrder`에 따라 순서대로 실행한다. 원문은 전문 스킬 내부에서만 다루고 MCP 영수증에는 reference-only policy가 허용하는 digest, artifact reference와 고정 토큰만 전달한다.

## Claude Code에서의 호출과 관측

이 절은 호출 방식과 실행 관측만 바꾸며 위의 선택 기준, 아래 참고 자료의 실행 순서·결과 기록 규칙은 그대로 적용한다.

- 전문 스킬은 Skill 도구나 `/agent-governance-suite:<skill-name>` 명령으로 실제 호출한다. 사용자가 slash 명령이나 스킬 이름으로 지정한 스킬을 "이름으로 지정한 스킬"로 본다.
- 독립 감사가 필요한 흐름의 감사자는 구현자와 분리된 fresh 서브에이전트(`agent-governance-suite:independent-auditor`)로 실행한다.
- 플러그인 훅이 UserPromptSubmit이나 Bash 실행 직전에 붙이는 스킬 추천은 후보일 뿐이다. 추천만으로 스킬을 붙이거나 생략하지 않고 위 기준으로 정한다.

### 실행 관측

- `plan_workflow`와 `record_stage_result`를 호출할 때마다 플러그인 훅이 그 호출을 낸 세션(서브에이전트가 호출했으면 그 서브에이전트)의 모델과 추론 수준을 transcript에서 관측해 서버에 넘긴다. 도구 인자에 `executionContext`나 `_hostAttestation`을 넣지 않는다. 넣어도 훅이 지우거나 덮어쓴다.
- semantic stage의 관측값은 그 stage를 기록한 호출자의 것이다. 서브에이전트에 맡긴 stage를 메인 세션이 기록하면 메인 세션의 모델과 추론 수준이 결속되므로, 그 서브에이전트가 계획된 하한(`executionRequirement`) 이상의 모델과 추론 수준으로 실행됐는지 확인한 뒤 기록한다.
- 관측값이 하한보다 낮아 `BINDING_INVALID`가 나오면 값을 고쳐 다시 보내지 않고, 하한을 충족하는 모델·추론 수준의 세션에서 그 stage를 다시 실행한다. 대화형 세션에서 도구 승인에 5분 넘게 걸려 `BINDING_INVALID`가 나오면 같은 호출을 다시 한다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 결과 통합

보안 전문 분석을 요청했거나 수용 기준에서 요구하면 `software-security-audit`를 선택한다. 보안 관련 파일의 존재만으로 추가하지 않는다. phase 65의 `security-audit-request`에는 실제 파일 내용을 고정한 대상과 허용 범위를 전달한다. 보고서는 로컬 CLI로 대상·근거를 검증하고 원자료를 확인한 뒤 기록한다. 이 provider의 `passed`는 조사 산출물 생성 성공이며 안전 판정이 아니다. `partial`의 미검사 항목과 limitations를 생략하지 않는다.

수용 근거 검증도 선택됐다면 `security-audit-report` artifact의 locator·digest·targetDigest와 원시 근거를 기존 `workflow:verification-evidence`에 추가하고 해당 보안 수용 기준에 연결한다. 기준 불충족과 검사 공백은 기존 수용 검증·독립 감사 게이트에서 판단한다. 취약점 심각도만으로 전역 차단 정책을 새로 만들지 않는다. 감사 후 대상 변경이 있으면 영향받은 분석과 근거 결속을 다시 확인한다.

최종 응답에는 선택한 스킬과 실행 순서, 각 단계의 확인된 결과, 열린 제한사항, 다음에 필요한 입력만 포함한다. 전문 스킬의 판정을 덮어쓰지 않는다. 고위험 변경의 완료 가능 여부는 독립 감사 게이트가 `PASS`로 판정한 경우에만 그렇게 표현한다.
