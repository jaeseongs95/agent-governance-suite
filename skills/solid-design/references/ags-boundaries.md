# AGS에서의 책임 경계

`solid-design`은 설계 판단 하나를 제공한다. 아래 경로는 AGS 저장소 루트 기준이다. 현재 설치·작업 트리에서 실제 원문과 계약을 확인하고 필요한 모듈만 읽어라. 이 표를 모든 스킬의 실행 목록으로 해석하지 마라.

| 정본 담당 | 이 스킬의 연결 방식 | 유지할 경계 |
| --- | --- | --- |
| `AGENTS.md`, `instruction-scope-resolver` | 현재 적용 지침·제외 경로를 입력으로 사용 | 지침 우선순위·override 규칙을 새로 정하지 않는다. |
| `orchestrator` | 필요한 경우 `solid-design-assessment` 결과 전달 | 선택·순서·권한·위임·gate 연결을 대신하지 않는다. |
| `task-contract` | 기존 objective/scope/acceptance와 contract 참조 | SOLID 권고로 수용 기준·권한을 자동 변경하지 않는다. |
| `ponytail` | 필요한 최소 경계와 변경 방향 제공 | 구현·라이브러리 선택 및 최소 구현 규칙은 기존 담당 유지. |
| `cs-engineering` | 기존 rule/obligation ID와 불변조건 참조 | CS 의무를 재발급하거나 concurrency·DB·성능 검증을 대체하지 않는다. |
| `code-review` | 위치·계약·호출 경로가 있는 설계 finding 제공 | 전체 변경 coverage·결함 검토 완료를 주장하지 않는다. |
| `test-engineering` | 소비자 계약, 오류·취소·수명·대체 검증 질문 제공 | 테스트 계획·oracle·민감도·proof workflow를 복제하지 않는다. |
| `change-scope-guardian`, `mutation-risk-preflight` | 실제 변경이 있으면 기존 흐름 유지 | 읽기 전용 설계 분석만으로 별도 승인 절차를 추가하지 않는다. |
| `acceptance-evidence-validator`, `independent-audit-gate` | 분석 범위·원자료·후보 참조 제공 | 분석 완료를 수용·독립 감사·릴리스 승인으로 바꾸지 않는다. |

## 기존 규칙을 참조하라

Engineering Practices는 `skills/orchestrator/references/engineering-practices/`의 공유 모듈이다. 독립 `engineering-practices` 스킬을 가정하지 마라.

- 구현 시 `implementation.md`의 `IMP-001` 최소 변경, `IMP-002` 실제 추상화 경계, `IMP-003` 오류 의미, `IMP-004` 자원 수명·취소를 참조하라. 이 스킬은 이 규칙에 SOLID 관점의 질문을 보탠다.
- 스킬 추가·변경 시 `agent-instructions.md`의 `DOC-001` 발동·제외, `DOC-004` 정책 단일 원본, `DOC-006` 의미 보존을 참조하라.
- `skills/cs-engineering/assets/rules/software-design.json`의 `DESIGN-CONTRACT-001`, `DESIGN-STATE-002`, `DESIGN-COMPAT-003`, `DESIGN-MINIMAL-004`는 이 기준 snapshot에서 `draft`다. 이번 스킬 추가를 카드 검증 완료·전역 적용의 근거로 삼지 마라.
- 기존 `TaskEnvelope.v1`, `ProviderResult.v1`, CS binding, lease·resume·finalize 계약에 SOLID 점수·승인 필드를 추가하지 마라. 새 결과는 스킬 소유 artifact로 전달하라.

## 적용 순서와 독립 호출

기본 capability는 `solid-design-assessment` 하나이며 registry의 분류는 `bootstrap`, `phaseOrder: 26`이다. 선택된 경우 `plan_workflow` 전에 설계 판단을 수행하라. 이는 CS 조건 도출(25) 뒤, task contract(30) 앞에 둘 수 있는 배치 정보이며 모든 작업에 해당 단계나 앞 단계 스킬을 강제하지 않는다.

`solid-design-assessment`를 `TaskEnvelope.requiredCapabilities`에 넣지 마라. 현재 `plan_workflow`는 bootstrap capability를 workflow 실행 단계로 요청하면 거부한다. 분석 결과를 기존 task-contract 담당에게 전달하여 필요성이 채택된 사항만 기존 계약에 반영하라. 결과나 새 필드를 TaskEnvelope에 임의로 끼워 넣지 마라.

이미 동결된 계약이나 구현 후보를 읽기 전용으로 검토할 때도 직접 호출할 수 있다. 이때 기존 계약을 다시 bootstrap하거나 후속 실행 결과로 위장하지 마라. 구현 뒤 검증·최종 판정은 기존 리뷰·수용 경로가 소유한다.

분류 지원은 오류 가능한 조언이다. 사용자의 명시적 선택·비활성·현재 적용 조건을 실제 agent가 판단하라. `classification.json`의 digest/span은 적용·제외 문구의 출처 결속이며, 실제 모델의 선택 정확도 보장은 아니다. 참조 관계를 실행 `dependencies`로 등록해 다른 스킬 설치를 강제하지 마라.

호스트별 호출·배포 형식은 기존 adapter/overlay가 처리한다. 공통 본문에 특정 제품 API를 추가하거나 생성된 `claude-plugin/`을 직접 고치지 마라.
