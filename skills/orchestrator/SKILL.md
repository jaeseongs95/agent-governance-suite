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

- 코드 작성·수정·설계나 라이브러리·의존성 선택 단계에는 `ponytail`을 먼저 실제 호출하고 그 지침으로 구현한다. 테스트를 실행한 뒤 결함을 수정하는 요청도 수정 단계에서 적용한다. 코드 설명, 읽기 전용 일반 리뷰·감사·검증만 하는 요청에는 적용하지 않는다.
- 커밋·병합·push·태그처럼 실제 변경을 반영하는 요청에는 `change-scope-guardian`의 범위 확인을 적용한다. 삭제·배포·게시·권한·결제·마이그레이션 등 위험한 실제 변경 전에는 `mutation-risk-preflight`를 적용한다. 목표가 실제 변경인 요청은 상태 확인보다 먼저 해당 전문 스킬이나 `orchestrator`를 실제 호출한다. 개념 설명이나 명령 이력 조회는 그 행동을 실행하는 요청이 아니다.
- 필요한 전문 스킬 하나로 충분하면 그 스킬을 직접 호출한다. 여러 전문 결과의 순서·입출력·필수 gate를 연결해야 하면 `orchestrator`를 실제 호출한 뒤 각 전문 단계를 연결한다. 예를 들어 공개 push·태그·배포의 범위 확인과 위험 사전 점검을 함께 요구하는 흐름은 이 연결 기준으로 판단한다. 읽기 전용 확인에서 환경·권한 선행이 없으면 실제 변경을 실행하지 않는다.
- 선택한 스킬은 설치된 본문과 해당 참고 자료를 로드하고 지침에 따라 실제 작업·검증·산출물까지 수행한다. 이 문서와 참고 자료를 읽는 것은 전문 스킬 실행이 아니다. 스킬 이름을 언급하거나 호출이 시작됐다는 응답만으로 수행 완료를 판단하지 않는다.
- 전문 스킬이 필요 없는 설명·인사·일반 질문은 그대로 답한다. 단독 전문 작업이나 스킬이 필요 없는 요청에 registry 조회·계획·workflow run을 만들지 않는다. 모든 요청에 실패 영향 분류나 생략 이유를 출력하지 않는다.
<!-- skill-intake:end -->

한국어 산문을 작성·편집하거나 자연스러움을 검증하는 요청은 일부 단계만 선택하지 않는다. `korean-prose-selection`, `korean-prose-editing`, `korean-prose-verification`, `korean-prose-finalization` 네 capability를 모두 요청하고, descriptor의 artifact 의존성과 `phaseOrder`에 따라 순서대로 실행한다. 원문은 전문 스킬 내부에서만 다루고 MCP 영수증에는 reference-only policy가 허용하는 digest, artifact reference와 고정 토큰만 전달한다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 결과 통합

최종 응답에는 선택한 스킬과 실행 순서, 각 단계의 확인된 결과, 열린 제한사항, 다음에 필요한 입력만 포함한다. 전문 스킬의 판정을 덮어쓰지 않는다. 고위험 변경의 완료 가능 여부는 독립 감사 게이트가 `PASS`로 판정한 경우에만 그렇게 표현한다.
