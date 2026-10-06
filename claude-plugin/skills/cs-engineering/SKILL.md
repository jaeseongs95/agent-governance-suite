---
name: cs-engineering
description: >
  동시성·DB·메시징·알고리즘·자원 수명·성능이 정확성에 영향을 주는
  설계·구현·기술 검토에서 CS 원리를 적용해 불변조건과 검증 의무를 만들고
  최종 후보와 대조한다. CS 검토를 명시적으로 요청하거나 경쟁·재시도·그래프·
  저장 정합성 문제를 분석할 때 사용한다. 단순 문구 수정·일반 개념 설명에는
  workflow를 만들지 않으며 구현·보안 감사·독립 감사·배포 승인을 대신하지 않는다.
license: MIT
metadata:
  version: "0.2.0"
---

# CS Engineering

## 책임과 경계
작업에 필요한 CS 원리를 구체적인 설계 조건과 검증 의무로 바꿔라.
기존 orchestrator의 선택·순서·위임, ponytail의 최소 구현, task-contract의 계약 동결,
acceptance-evidence-validator의 근거 수용, 독립 감사의 역할을 유지하라.
새 세션·큐·상태 DB·상시 실행기·승인 권한을 만들지 마라.

## 적용과 제외
실제 변경에서 정확성·복잡도·자원·실패 처리를 판단할 필요가 있으면 적용하라.
문구만 바꾸는 작업과 일반 설명에는 관리 workflow를 새로 만들지 마라.
직접 호출에는 이 스킬의 분석과 보고서만 제공하라. 타 스킬을 임의 호출·위임하지 마라.

## 지식 선택
[참조 인덱스](references/index.md)를 먼저 읽고 필요한 모듈·카드만 읽어라.
핵심 5개 모듈의 20개 카드는 제한된 실행 참조 사례를 검사한 validated 상태다.
추가 5개 모듈의 20개 draft 카드는 명시적 도입 근거가 있을 때만 적용하라.
validated는 실제 제품·호스트 평가나 독립 감사 통과를 뜻하지 않는다.
`node <SKILL_DIR>/scripts/validate.mjs catalog --allow-draft`로 목록을 확인할 수 있다.
선택·로딩·조건 도출·구현 적용·검증 완료를 서로 다른 상태로 기록하라.

## 입력
요청·지침·대상의 reference와 실제 내용을 확인하라. 사실·전제·도출한 조건을 구분하라.
사용자 정보를 추정으로 채우지 말고 허용된 소스와 환경 관측을 먼저 확인하라.
리뷰에서는 동결된 제약 보고서와 binding, 현재 후보, task, request, 실제 근거를 받아라.
[입출력 계약](references/contracts-and-cli.md)과 [예시](references/worked-example.md)를 따른다.

## 제약 도출
1. 관련 카드와 적용 근거를 정하라. 카드 문구를 자동으로 필수 요구로 승격하지 마라.
2. 필수 불변조건·설계 선택·개선 권고를 나눠 원래 요구·정책·사실에 연결하라.
3. 각 필수 조건의 실패 관측, 검증 방법, 환경, 원시 근거 계획을 구현 전에 정하라.
4. `cs-constraint-report`를 작성하고 CLI로 형태·참조·규칙 digest를 검증하라.
5. task-contract가 이를 계약과 검증 계획에 반영하도록 전달하라. 동결 이후 변경은
   기존 재계약·frame 검토로 넘기고 보고서만 교체하지 마라.
READY는 계획 입력이 준비됐다는 뜻이며 제품 PASS가 아니다.

## 구현 결과 검토
고정된 같은 조건을 현재 후보와 대조하라. 실제 변경에 빠진 실패 경로도 확인하라.
각 조건을 SATISFIED / VIOLATED / UNVERIFIED / NOT_APPLICABLE로 구분하라.
필수 의무의 NOT_RUN·잘못된 환경·다른 후보의 근거는 PASS로 처리하지 마라.
필수 조건의 사후 제외는 근거와 승인된 재계약을 요구하라. 이번 CLI는 기존 binding에서
필수 NOT_APPLICABLE을 통과시키지 않으므로 새 revision을 만들어라.
정적 검증이 계획된 의무에는 동적 테스트를 억지로 추가하지 마라.
최종 `cs-review-report`를 만들고 `check-bundle`로 결속과 원시 파일 digest를 확인하라.

## 출력과 실패
제약 도출은 READY / NEEDS_INPUT / NEEDS_REDESIGN / BLOCKED를 반환하라.
리뷰는 필수 위반이면 FAIL, 미검증이면 BLOCKED, 모두 충족하면 PASS를 반환하라.
근거 없는 자체 선언, schema 통과, 테스트 명령 나열, 동일한 모델들의 동의는 검증이 아니다.
CLI의 PASS는 입력·참조·근거 결속이 일관됐다는 뜻이며 근거 내용의 진실성이나 독립 감사
통과를 증명하지 않는다. 모드·신뢰·호스트 하한을 사용자 입력만으로 발급하지 마라.

## AGS 2.8 연결
두 provider는 bootstrap 25의 `cs-constraint-derivation`, workflow 67의
`cs-implementation-review`다. [2.x 연결](references/ags-2x-integration.md)을 읽고
동결 입력을 `handoff`로 재검사한 뒤 task-contract·구현자에게 reference와 의무 ID를 전달하라.
선택된 MCP 리뷰 단계는 `cs-review-bundle`와 `cs-review-report` artifact를 받아
기록 시·finalize 시 CLI로 같은 task·후보·조건·원시 근거를 재검증한다.
스킬 배포 버전 0.2.0과 동결 지식팩 0.1.0을 구분하라.
전체 signed plan·lease·start·resume binding 전파와 전 작업의 적용성·acceptance
강제 정책은 미구현이다. 수신자의 의미적 조건 적용과 실호스트 자동 선택도 별도 검증이다.
