---
name: model-effort-advisor
description: 관측 가능한 현재 모델과 추론 수준이 받은 요청의 난도·위험·비용 요구에 비해 과한지, 적절한지, 부족한지 평가하고 유의미한 불일치만 안내한다. 실제 설정을 관측할 수 없는 일반 작업, 하위 에이전트 라우팅이나 모델 자동 변경에는 사용하지 않는다.
license: MIT
metadata:
  version: "0.1.0"
---

# Model Effort Advisor

요청을 시작할 때 현재 모델·추론 수준과 필요한 작업 강도를 비교한다. 평가는 작업을 막는 gate가 아니라 사용자가 사진의 `GPT-5.6 Sol High` 같은 선택을 조정할지 판단하게 돕는 짧은 안내다.

## 적용 조건

- 사용자가 현재 모델이나 추론 수준이 요청에 적절한지 묻는다.
- 호스트가 현재 task의 모델과 추론 수준을 신뢰할 수 있는 runtime metadata로 제공한다.
- 사용자가 현재 선택을 텍스트나 이번 요청의 화면 캡처로 명시했고, 품질·대기 시간·비용에 유의미한 차이가 예상된다.

현재 선택을 관측할 수 없는 일반 작업에서는 이 스킬 때문에 사용자에게 설정을 묻거나 작업을 중단하지 않는다. 하위 에이전트의 모델 라우팅은 `coordinate-subagents`가 맡고, API 모델 마이그레이션이나 프롬프트 튜닝은 이 스킬의 범위가 아니다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 출력

구조화 결과는 [ModelEffortAdvice.v1](contracts/model-effort-advice.v1.schema.json)을 따른다. 근거에는 요청에서 실제로 확인한 신호만 넣고, `userNotice`는 위 안내 조건을 만족할 때만 작성한다.
