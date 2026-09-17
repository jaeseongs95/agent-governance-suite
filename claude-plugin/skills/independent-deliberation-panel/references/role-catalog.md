# Perspective Role Catalog

이 문서는 case brief에서 서로 다른 실패 관점을 고를 때만 읽는다. 고정 패널을 만들기 위한 목록이 아니라, 실제 실패 모드에 맞는 role mandate를 설계하기 위한 재료다.

## 역할 후보

| 역할 | Failure function | 주로 공격할 대상 | 우선 증거 |
|---|---|---|---|
| System Architect | 경계·의존성·불변식이 깨진 구조를 찾는다 | 구성요소 책임, 데이터 흐름, 결합도 | 코드, 아키텍처 문서, 인터페이스 |
| Distributed Systems Skeptic | 부분 실패·순서·중복·일관성 결함을 찾는다 | 재시도, 동시성, 장애 복구 | 실행 로그, 프로토콜, 장애 테스트 |
| Minimalist / Scope Critic | 목표에 필요하지 않은 범위와 복잡성을 찾는다 | 필수성과 단계화 가능성 | 요구사항, 일정, 의존성 |
| Security Red Team | 공격자가 악용할 수 있는 권한·신뢰 경계를 찾는다 | 인증, 입력, 비밀, 공급망 | 위협 모델, 코드, 보안 정책 |
| Safety Reviewer | 실패가 사람·데이터·시스템에 주는 위해를 찾는다 | 안전 불변식, fail-safe, 복구 | 안전 요구사항, 테스트, 사고 자료 |
| Operability Reviewer / SRE | 배포·관찰·복구할 수 없는 설계를 찾는다 | 모니터링, 롤백, 용량, 온콜 부담 | 운영 절차, 지표, 장애 기록 |
| User / UX Advocate | 실제 사용자가 완료할 수 없는 흐름을 찾는다 | 사용성, 오류 복구, 접근성 | 사용자 흐름, 연구, 제품 요구사항 |
| Product Strategist | 사용자 가치와 제품 목표가 맞지 않는 선택을 찾는다 | 가치, 채택, 우선순위 | 제품 목표, 사용자 근거, 지표 |
| Contract Auditor | 명시된 계약·정책·요구사항 위반을 찾는다 | MUST/금지 조건, 호환성 | 승인된 요구사항, 계약, 정책 |
| Provider Contract Auditor | 외부 provider의 실제 보장과 로컬 가정을 구분한다 | API 의미, 가용 필드, SLA | 공식 스키마, API 문서, 응답 샘플 |
| Evidence Skeptic | provenance가 없거나 관찰 불가능한 주장을 찾는다 | 출처, 재현성, 합성값 | 원자료, 테스트, 공식 문서 |
| Data / Statistics Reviewer | 데이터 품질·표본·해석 오류를 찾는다 | 편향, 누락, 인과, 집계 | 데이터 사전, 쿼리, 분석 코드 |
| Performance Reviewer | 부하 조건에서 깨지는 시간·공간 가정을 찾는다 | 병목, 확장성, 지연 | 프로파일, 벤치마크, 용량 모델 |
| Cost Optimizer | 비용 대비 정보가치나 효용이 낮은 선택을 찾는다 | 단가, 호출량, 운영비 | 사용량, 가격표, 비용 모델 |
| Release Planner | 의존성과 검증을 무시한 일정 판단을 찾는다 | 순서, 병렬화, 롤백 지점 | 작업 그래프, 릴리스 조건, 인력 제약 |

법률·의료·금융처럼 전문 자격과 최신 자료가 중요한 영역에서는 역할 이름만으로 전문성을 주장하지 않는다. 권위 있는 자료와 필요한 사용자·전문가 확인을 별도 증거로 다룬다.

## 선택 절차

1. case brief의 `failure_modes`를 나열한다.
2. 각 실패 모드에 가장 직접적인 failure function을 하나 배정한다.
3. 두 역할이 같은 자료에서 같은 기준으로 같은 결함을 찾는다면 합친다.
4. 결론이 달라도 실패 기준이 같으면 독립 관점으로 세지 않는다.
5. HIGH에서는 서로 다른 failure function 네 개를 우선한다.
6. CRITICAL에서는 영향이 큰 축에 Red Team 또는 **independent design-assurance reviewer**를 더할 수 있다. 이는 설계·판단의 독립 검토 역할이며, 구현 변경의 final auditor나 audit-gate를 뜻하지 않는다.

보편적으로 Architect, Security, UX, Cost를 채우지 않는다. 예를 들어 계약과 일정이 충돌하는 요청에는 Contract Auditor, Release Planner, Minimalist, Evidence Skeptic가 더 적합할 수 있다.

## Role mandate 형식

```yaml
role_id:
failure_function:
scope:
attack_targets: []
non_goals: []
priority_evidence: []
required_output:
  - claims
  - evidence_refs
  - assumptions
  - risks
  - recommended_action
  - confidence
  - open_questions
delegation_allowed: false
```

mandate에는 선호 결론이나 다른 reviewer의 예상 주장을 넣지 않는다. 역할이 결함을 찾지 못해도 억지 반론을 만들지 말고, 확인한 범위와 남은 불확실성을 보고하게 한다.

## Specialist admission과 중복 방지

specialist는 고정 패널 역할도, reviewer 수를 채우는 대체재도 아니다. Stage 6에서 다음 조건을 모두 만족할 때만 한 명을 admission한다.

1. 증거 확인 뒤에도 material한 `UNRESOLVED` 또는 `NOT_OBSERVABLE` gap이 하나 이상의 특정 claim, issue 또는 axis ID에 연결된다.
2. 후보는 기존 role과 다른 failure function, 원자료 접근 또는 분석 방법을 제공한다.
3. 그 차이가 필수 axis 또는 Judge verdict를 바꿀 수 있다.
4. fresh Judge를 보존한 worker cap 안에 reserve가 남아 있다.

후보가 단지 더 강한 모델, 같은 문서의 재요약, 기존 reviewer의 결론 지지·반박, 일반적 전문성 이름만 제공하면 admission하지 않는다. 같은 도메인이라도 입력·판정 기준·우선 증거가 기존 role과 실질적으로 다르면 중복이 아닐 수 있다. 반대로 이름이 달라도 다음이 모두 같으면 중복으로 합친다.

- 공격 대상과 failure function
- 주요 evidence set 또는 관찰 방법
- 성공·실패를 가르는 판정 기준
- 해결할 material gap

admission을 기록할 때는 `role_id`, impacted claim/issue/axis, 기존 role과 구별되는 failure function, 새 evidence 또는 method, 왜 Judge 전에 필요한지를 남긴다. specialist는 full panel 재검토나 새 투표를 하지 않고 좁은 mandate만 수행한다. 이후 재숙고는 영향 항목과 그 결론을 만든 worker로 한 번만 한정하며 `non_independent`로 표시한다.

## 최종 감사와의 경계

이 카탈로그의 역할은 모두 설계·판단 절차의 participant다. final audit와 외부 workflow 연결은 이 카탈로그의 범위 밖이다.
