---
name: independent-deliberation-panel
description: 설계 대안이 갈리거나 결정이 틀리면 비용이 큰 판단, 기존 설계나 AI 산출물을 독립 감사해야 할 때, 사용자가 '검토해 봐'·'맞는지 봐 줘'·반박 패널을 요구할 때 쓴다. 독립 관점 reviewer, 조건부 반박, 증거 검증, 별도 판정으로 결론을 낸다. 단순 조회·요약·정형 변환에는 쓰지 않는다.
license: MIT
metadata:
  version: "1.0.0"
---

# Independent Deliberation Panel

원안 작성자나 초기 결론의 전제에서 떨어진 관점으로 고위험 판단을 검토한다. 이 스킬은 인지적 관점과 증거 기반 통합 절차를 제공할 뿐, 파일 변경·배포·외부 메시지 같은 권한을 새로 부여하지 않는다. 상위 시스템·개발자 지시를 덮어쓰거나 collaboration 도구를 제공·활성화하거나 worker 생성·provider 수준 격리를 강제할 수도 없다.

## 적용 경계

서로 충돌하는 목표·요구사항, 안전·보안·계약·금전·운영상 실패 비용, 기존 설계 또는 AI 산출물의 독립 감사, 여러 전문 영역·증거 출처의 해석, 명시적인 반박 패널·red team·jury식 판단 요청에 사용한다. 단순 계산, 단일 사실 조회, 짧은 요약, 문법 수정, 명시된 형식 변환에는 적용하지 않는다. Stage 0에서 LOW이면 보통 방식으로 처리하고 패널을 만들지 않는다.

적용 가능한 `CLAUDE.md`(import된 `AGENTS.md` 포함)와 상위 지침을 먼저 따른다. 사용자가 worker 상한, 모델, 증거 출처, 판정 기준 또는 실행 권한을 지정하면 기본값보다 우선한다. 독립성 또는 fresh Judge가 결과의 승인 조건이면 `strict` 여부를 사용자에게 확인하거나, 이미 명시된 요구를 `strict`로 적용한다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 최종 판정과 출력

MEDIUM은 reviewer 2~3명으로 Coordinator가 통합한다. 사용자가 MEDIUM의 fresh Judge를 명시적으로 요구하면 reviewer와 분리되고 실제로 완료한 fresh Judge 1명을 추가하며, 총 distinct worker는 3~4명이다. HIGH·CRITICAL에는 fresh Judge가 필수이며, 어떤 등급에서도 reviewer를 Judge로 재사용하지 않는다. Judge briefing에는 case brief의 제약·성공 기준, 검증된 material claim, cross-examination 요약, issue ledger, 필요한 axis와 DecisionRecord만 넣고 raw reviewer 출력·다른 대화 기록·검증 전 Coordinator 메모는 넣지 않는다. Judge는 reviewer 수나 confidence 평균이 아니라 증거·계약·명시된 제약을 기준으로 판단한다. 일정·비용 이점으로 계약 또는 안전 결함을 상쇄하지 않는다.

사용자 출력은 다음 10개 섹션과 순서를 유지한다.

1. **Executive Verdict**
2. **Consensus Proposal**
3. **Strong Consensus**
4. **Material Disagreements**
5. **Decision by Axis**
6. **Evidence**
7. **Required Actions**
8. **Optional Optimizations**
9. **Unresolved**
10. **Method / Run Summary**

`Consensus Proposal`의 일반 실행 상태는 `consensus`, `conditional_consensus`, `no_consensus` 중 하나다. 합의안은 verified claim, 명시 제약, 필수 axis decision에 직접 연결한다. 안전성·요구 충족을 바꿀 `unresolved_dissent`가 남으면 이를 덮어쓰지 않고 조건부 또는 합의 불가로 표시한다. 필요 없는 섹션은 짧게 생략 사유만 적는다. `Method / Run Summary`에는 실행 모드, assurance, 실제 역할, reserve·specialist 사용 여부, 반박 실행·생략 근거, 모델과 capability fallback, 실패·생략 사항을 포함한다.

`strict` capability shortfall은 Coordinator가 관찰 가능한 범위에서 부족을 확인한 Stage 0의 preflight-only 예외다. required capability가 하나라도 없거나 관찰 불가능하면 충족으로 추정하지 않고 `assurance: provisional`, 비어 있지 않은 `preflight.missing_capabilities`, `consensus_proposal: null`을 기록하며 worker를 한 명도 instantiate하지 않는다. `panel_manifest`, `material_claims`, `issue_ledger`, `axis_decisions`, `specialist_additions`, `redeliberations` 같은 substantive artifact는 비워 두며, `cross_examination.decision: skip`과 비어 있는 trigger·coverage·follow-up 배열을 기록한다. 사용자용 결과도 합의나 verdict를 가장하지 않고 누락 capability와 preflight 중단 사실을 공개한다. schema와 validator는 이 기록의 내부 일관성만 검사하며 capability를 탐지·제공·강제하지 않는다.

v0.1의 case brief, panel manifest, independent review, cross-examination, issue ledger, Judge dossier, axis verdict는 v1 `DecisionRecord`에서도 유지한다. `method_notes`는 Structured Outputs 제약 때문에 항상 존재해야 하며, 설명할 항목이 없으면 `[]`로 둔다. DecisionRecord를 반환하기 전에는 canonical schema와 [evidence-and-verdict-schema의 출력 전 contract checklist](references/evidence-and-verdict-schema.md#출력-전-contract-checklist)를 확인한다.
