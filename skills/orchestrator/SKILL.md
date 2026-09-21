---
name: orchestrator
description: 여러 거버넌스 스킬이 함께 필요한 요청을 분류하고, 사용 가능한 전문 스킬의 실행 순서·입출력·결과를 연결한다. 전문 판단이나 감사 자체를 수행할 때는 사용하지 않는다.
license: MIT
metadata:
  version: "1.2.0"
---

# Governance Orchestrator

전문 스킬의 책임을 바꾸지 않고 요청을 적절한 실행 흐름으로 연결한다. 이 스킬은 분류, 선택, 순서 결정, 입출력 전달, 중간 결과 확인과 최종 결과 통합만 맡는다. 보안 판단, 독립 감사, 반박 작성, 구현, 배포를 대신 수행하지 않는다.

## 시작 전 확인

먼저 요청의 목표, 상태 변경 여부, 완료 조건과 명시적으로 호출된 스킬을 확인한다. 명시적으로 `$skill-name`을 지정한 요청에서는 그 스킬을 우선하며, 다른 스킬로 대체하지 않는다.

라우팅 전에 설치 시 노출된 스킬 설명으로 후보 capability를 정하고 `node scripts/query-registry.mjs --capability <capability>`를 실행해 일치하는 활성 provider만 조회한다. 여러 capability는 `--capability`를 반복한다. 후보를 특정할 수 없을 때만 `--all`로 compact 전체 목록을 조회하며, `skills/registry.json` 원문 전체를 모델 컨텍스트로 읽지 않는다. 조회 결과의 `selectionCriteria`, precondition, priority를 선택 설명에 남긴다. 같은 capability의 후보 중 priority가 가장 큰 항목을 선택하되, 동률이나 descriptor 충돌은 임의로 고르지 말고 `needs-input`으로 돌린다. `selectionCriteria`는 사람이 검토하는 근거이며 런타임 필터가 아니다. 필요한 역할이 없으면 `missingCapabilities`, 가능한 직접 스킬 호출 경로와 부족한 capability를 분리해 설명한다.

초기 정책 capability는 `subagent-coordination`, `independent-deliberation`, `independent-audit`다. 일반 변경 흐름에 필요한 모델·추론 수준 적합성, 지침 범위, 작업 계약, 저장소 관례, 변경 기준선·범위 확인, mutation 사전 점검, 수용 근거 확인과 실패 진단도 capability로 찾는다. 현재 provider 이름을 라우팅 조건으로 사용하지 않는다.

한국어 산문을 작성·편집하거나 자연스러움을 검증하는 요청은 일부 단계만 선택하지 않는다. `korean-prose-selection`, `korean-prose-editing`, `korean-prose-verification`, `korean-prose-finalization` 네 capability를 모두 요청하고, descriptor의 artifact 의존성과 `phaseOrder`에 따라 순서대로 실행한다. 원문은 전문 스킬 내부에서만 다루고 MCP 영수증에는 reference-only policy가 허용하는 digest, artifact reference와 고정 토큰만 전달한다.

<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->
- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.
<!-- optimization-navigation:end -->
## 결과 통합

보안 전문 분석을 요청했거나 수용 기준에서 요구하면 `software-security-audit`를 선택한다. 보안 관련 파일의 존재만으로 추가하지 않는다. phase 65의 `security-audit-request`에는 실제 파일 내용을 고정한 대상과 허용 범위를 전달한다. 보고서는 로컬 CLI로 대상·근거를 검증하고 원자료를 확인한 뒤 기록한다. 이 provider의 `passed`는 조사 산출물 생성 성공이며 안전 판정이 아니다. `partial`의 미검사 항목과 limitations를 생략하지 않는다.

수용 근거 검증도 선택됐다면 `security-audit-report` artifact의 locator·digest·targetDigest와 원시 근거를 기존 `workflow:verification-evidence`에 추가하고 해당 보안 수용 기준에 연결한다. 기준 불충족과 검사 공백은 기존 수용 검증·독립 감사 게이트에서 판단한다. 취약점 심각도만으로 전역 차단 정책을 새로 만들지 않는다. 감사 후 대상 변경이 있으면 영향받은 분석과 근거 결속을 다시 확인한다.

최종 응답에는 선택한 스킬과 실행 순서, 각 단계의 확인된 결과, 열린 제한사항, 다음에 필요한 입력만 포함한다. 전문 스킬의 판정을 덮어쓰지 않는다. 고위험 변경의 완료 가능 여부는 독립 감사 게이트가 `PASS`로 판정한 경우에만 그렇게 표현한다.
