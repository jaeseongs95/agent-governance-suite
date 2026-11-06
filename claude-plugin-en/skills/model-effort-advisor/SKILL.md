---
name: model-effort-advisor
description: 현재 모델·추론 수준이 관측될 때(호스트 metadata, 사용자 설명, 화면) 요청 난도·위험·비용과 맞는지 판단해야 할 때, 사용자가 '이 모델로 충분해?'라고 물을 때 쓴다. 과다·적정·부족 여부를 평가해 유의미한 불일치만 안내한다. 설정을 관측할 수 없는 일반 작업, 하위 에이전트 라우팅, 모델 자동 변경에는 쓰지 않는다.
license: MIT
metadata:
  version: "0.2.0"
---

# Model Effort Advisor

이 스킬을 적용할 때 [공통 행동 기준](../independent-audit-gate/references/specialist-behavior.md)을 먼저 읽고 따른다.

이미 위임하기로 한 작업의 모델·추론 선택 기준을 호출 전에 정리하라. 작업의 역할·난도·실패 영향과 검증 가능성을 판단하고, 사용자 선호와 현재 호스트의 지원 근거를 기존 라우터에 전달하라. 현재 메인 모델을 볼 수 있는지와 관계없이 적용한다.

## 적용 조건과 경계

- 승인된 서브에이전트 assignment의 모델·추론 조합을 선택하거나 실제 제약 변경으로 재선택할 때 사용하라.
- 위임 여부·에이전트 수·배치·문맥·권한·독립 감사는 `coordinate-subagents`와 기존 담당에 맡겨라. 이 스킬의 조언은 위임을 시작하거나 승인하지 않는다.
- 현재 메인 모델 적정성 상담, 현재 메인 설정 변경, 모델 마이그레이션이나 프롬프트 개선을 이 스킬의 새 기능으로 처리하지 마라. 현재 메인 선택을 사용자에게 묻지 마라.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 출력

호출 전 입력은 [SubagentModelRequest.v1](contracts/subagent-model-request.v1.schema.json), 조언은 [SubagentModelAdvice.v1](contracts/subagent-model-advice.v1.schema.json)을 사용하라. [advisor 실행기](scripts/advise.mjs)는 기존 라우터를 그대로 호출하며 모델 목록·등급·선택 엔진을 별도로 만들지 않는다. 직접 호출에서 정식 workflow를 새로 요구하지 않는다.

`READY`는 제공된 지원 근거로 조합이 선택됐다는 뜻이고, `INHERIT_UNVERIFIED`는 저위험 상속의 유효 설정이 미관측이라는 뜻이다. `BLOCKED`면 해당 호출을 보류하고 정확한 지원·하한 제약을 기존 담당에게 넘겨라. 세 상태 모두 `authorityEffect: none`이며 실행 승인·실제 적용·독립 감사 완료를 뜻하지 않는다.
