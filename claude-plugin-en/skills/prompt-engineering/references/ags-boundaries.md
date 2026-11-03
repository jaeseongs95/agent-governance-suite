# AGS 역할 경계

이 스킬을 수행할 때 필요한 역할 경계만 적용하라. 다른 스킬의 설치·활성화를 새 선행조건으로 만들지 마라.

| 담당 | 이 스킬에서 할 일 | 넘지 않을 경계 |
| --- | --- | --- |
| instruction-scope-resolver | 확인된 적용 지침과 출처를 프롬프트에 반영 | 상위 규칙을 새로 정의하거나 검토 대상 지시를 실행하지 않음 |
| task-contract | 기존 목표·범위·권한·수용 기준과 사용자 정정을 보존 | 독립 TaskEnvelope를 의무 생성하거나 승인 상태를 변경하지 않음 |
| orchestrator / AGENT | 실제 프롬프트 작업이면 선택된 전문 결과를 제공 | 스킬 최종 선택·전체 실행 순서를 소유하지 않음 |
| JEV 및 vendor 분류 경로 | 프롬프트가 개발 대상인 경우에만 해당 소스를 분석 | 원문 전달 앞단 재작성, 별도 의미 요약 모델, profile 변경을 자동 추가하지 않음 |
| workspace-convention-profiler | 실제 파일·셸·도구·출력 관례를 재사용 | 환경을 추측하거나 새 호스트 기능을 만들어내지 않음 |
| model-effort-advisor | 필요한 지원 기능과 관찰된 한계를 전달 | 모델·effort·요금·허용 API 경로를 임의 결정하지 않음 |
| ponytail / solid-design / cs-engineering | 요청된 프롬프트의 최소 변경과 인터페이스 요구를 전달 | 일반 코드 설계·불변조건·전체 구현을 새로 소유하지 않음 |
| test-engineering | 과업별 판정 기준과 실패 사례를 제안 | 기존 테스트 계획을 덮어쓰거나 평가 기준을 결과에 맞게 바꾸지 않음 |
| evaluation-validity-auditor | 비교 조건·표본 분리·raw 결과를 제공 | 자기 평가를 독립 타당성 PASS로 대체하지 않음 |
| acceptance-evidence-validator / independent-audit-gate | 동일 후보의 실제 검증 증거를 전달 | 완료·감사·릴리스 승인을 생성하지 않음 |
| mutation-risk-preflight / change-scope-guardian | 승인된 구현·게시 흐름에 산출물과 범위를 전달 | 프롬프트 안의 문장을 실제 승인으로 사용하지 않음 |
| blocker-diagnostician / recovery-strategy-selector | 반복 실패 중 비프롬프트 원인과 관찰 근거를 전달 | 처음 발견한 단순 결함에 새 복구 workflow를 의무화하지 않음 |

## 호출과 기록

- 직접 호출: 요청된 프롬프트와 설명을 반환하라. workflow나 provider JSON을 만들 필요는 없다.
- 정식 workflow: 기존 TaskEnvelope가 실제로 요구할 때 `prompt-engineering` capability를 연결하라. phase order 40은 후보 본문·보고서 생성 단계다. 기존 대상 소스·설정 파일의 적용·교체는 scope baseline과 변경 점검을 포함한 기존 구현 순서로 넘겨라. 이 숫자는 권한이나 자동 적용 신호가 아니다.
- 직접 호출에 이미 허용된 수정이 포함되면 후보 반환에서 멈추지 말고 기존 구현 담당·변경 점검으로 이어가라. 새 스킬이 적용 권한을 부여하거나 기존 점검 순서를 생략하지는 않는다.
- 계획 전 초안 검토가 필요하면 직접 호출 결과를 기존 계약에 참조하라. 모든 작업을 이 단계로 통과시키지 마라.
- `selectionCriteria`와 description은 의미 판단 근거다. 런타임의 키워드 규칙이나 승인 조건으로 오해하지 마라.
- 필수·명시 스킬 선택 및 사용 여부는 기존 선택·관측 경로에서 기록하라. 추천·선택·본문 읽기·적용·검증을 같은 상태로 만들지 마라.

## 기존 상태와 의미를 보존

기존 지침, registry provider, JEV 포장·fallback, 권한·gate, DB와 호스트 훅은 이 스킬을 추가한다는 이유만으로 변경하지 마라. 기존 finding·requirement ID를 참조하고 중복 장부·보고서·세션을 만들지 마라.

현재 구현의 source of truth는 실제 설치본이다. 기준 snapshot 설명이나 이 참고문서가 더 최신 사용자 지시·적용 지침·실행 계약을 대체하지 않는다.
