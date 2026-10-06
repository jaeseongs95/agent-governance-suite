# AGS CS Engineering — 통합 설계안 v0.1.0

- 상태: 설계 초안. 구현·테스트·커밋·게시·설치가 수행된 결과가 아니다.
- 작성 기준일: 2026-10-06 (Asia/Seoul)
- 확인한 저장소: `jaeseongs95/agent-governance-suite`
- 기준 브랜치와 commit: `main`, `f39501efe5dfe51d83af9afddf39dec7b7e26b01`
- 기준 `package.json` 버전: `2.7.7`
- 저장소에 둘 권장 위치: `docs/cs-engineering-design.ko.md`
- 이후 3.x 작업 브랜치에 적용할 때는 해당 브랜치의 계약·스킬 선택 구현과 차이를 먼저 확인한다. 이 설계는 확인하지 않은 3.x 소스나 사용자의 설치 캐시를 설명하지 않는다.

## 1. 결정 요약

AGS에 `cs-engineering` 전문 스킬 하나를 추가한다. 그 안에 분야별 CS 참고 모듈을 두되, 별도 오케스트레이터·세션 실행기·메시지 큐·감사 체계·상태 DB는 만들지 않는다.

이 스킬의 단일 책임은 **작업에 관련된 CS 원리를 구체적인 설계 제약과 검증 의무로 변환하고, 결과가 그 조건을 충족하는지 기술적으로 검토하는 것**이다. 구현을 대신하거나 배포를 승인하지 않는다.

기능을 두 provider로 나눈다.

| Capability | 실행 class / 제안 순서 | 책임 | 주요 산출물 |
| --- | --- | --- | --- |
| `cs-constraint-derivation` | `bootstrap` / 25 | 문제·소스·운영 조건에서 필요한 CS 제약과 검증 계획 도출 | `cs-constraint-report` |
| `cs-implementation-review` | `workflow` / 67 | 고정된 제약과 최종 후보·근거를 대조 | `cs-review-report` |

수치 25와 67은 이 설계가 제안하는 값이다. 기준 저장소에서는 workspace discovery가 bootstrap 20, task definition이 bootstrap 30이며, scope verification은 workflow 60, security audit는 workflow 65, acceptance verification은 workflow 70이다. 클래스가 다른 단계의 숫자는 하나의 전역 순서로 비교하지 않는다. [R3]

최종 형태는 다음과 같다.

```text
작업 접수 / 필요한 capability 선택
  ↓
지침·대상·실제 코드와 운영 조건 확인
  ↓
cs-engineering: 제약 도출 (필요한 작업에만)
  ↓
task-contract: 범위·수용 기준·검증 계획 동결
  ↓
기존 AGS 흐름: 기준선 → ponytail 구현 → 필요한 변경 사전점검/실행
  ↓
범위 확인 / 필요한 보안 감사
  ↓
cs-engineering: 고정 제약과 구현·근거 대조
  ↓
acceptance-evidence-validator: 근거의 수용 가능성 검증
  ↓
필요한 independent-audit-gate → 기존 완료 판정
```

**스킬 설명을 읽었다는 사실, JSON 형식이 맞다는 사실, 코드를 실행해 검증했다는 사실은 서로 다른 증거다.** 이 세 가지를 합쳐서 PASS로 표시하지 않는다.

## 2. 현재 AGS와의 정합성

### 2.1 확인한 구현과 규칙

`AGENTS.md`는 전문 스킬의 역할 분리, 호스트 중립 계약, schema·스크립트·MCP에 의한 필수 불변조건 강제, 생성된 Claude 배포물의 직접 수정 금지를 명시한다. [R1]

`skills/orchestrator/references/entry-details.md`는 필요한 capability의 의미적 선택과 MCP의 결정적 provider 매핑을 분리한다. `selectionCriteria`는 런타임 필터가 아니며, 단순 전문 호출에는 workflow run이나 수렴 root를 만들지 않는다. [R2]

`ponytail`은 `minimal-implementation` capability를 제공한다. 이 provider의 현재 `requiredInputArtifacts`와 `inputBindings`는 빈 배열이다. 따라서 새 CS 보고서를 등록하는 것만으로 구현자가 이를 입력으로 받는 것은 아니다. 입력 전달과 실행 기록 검증을 별도로 연결해야 한다. [R3]

현재 저장소에는 `software-security-auditor`, `acceptance-evidence-validator`, `independent-audit-gate`, `evaluation-validity-auditor`, `blocker-diagnostician`, `iteration-frame-auditor`가 있다. 새 CS 스킬이 같은 역할을 재구현하지 않는다. [R3]

`TaskEnvelope.v1`은 `additionalProperties: false`이고, `constraints`와 `acceptanceCriteria`는 문자열 배열이다. 구조화된 CS 객체를 임의의 새 필드로 끼워 넣지 않는다. [R4]

`WorkflowService`는 계획 서명과 재구성 비교, task digest, convergence frame과 revision을 검사한다. 새 binding을 도입하면 최초 계획뿐 아니라 계획 재구성·lease·시작·재개·완료 경로 모두에 같은 의미가 전달돼야 한다. [R5]

### 2.2 하지 않는 일

- 모델의 가중치 재학습, 모델 교체 또는 특정 벤더에 대한 의존 추가.
- 모든 요청에 CS 스킬을 강제로 붙이거나 모든 참고자료를 미리 로딩.
- 별도 CS 오케스트레이터, 전용 상시 에이전트, 임베딩 DB, 새 SQLite 상태 저장소 도입.
- 보안 감사·독립 감사·권한 확인을 CS PASS로 대체.
- 사용자 요구를 단순화 명목으로 삭제하거나, 이미 동결된 수용 기준을 작업자가 수정.
- 외부 community skill을 감사 없이 가져오거나 실행 중 외부 규칙을 자동 업데이트.
- 모든 테스트를 mock으로만 통과시키고 실제 호스트 설치·실행 검증을 완료로 처리.

## 3. 지식 구성: 하나의 스킬과 필요한 분야만 읽는 모듈

이전의 `cs-core-router → 분야별 SKILL.md` 개념을 AGS에 그대로 옮기지 않는다. AGS에는 이미 라우팅 주체가 있으므로, CS 내부에서는 전문 판단에 필요한 **참고자료 선택**만 수행한다. 작업 배분과 세션 생성은 하지 않는다.

분야가 많아도 책임은 동일하다. 개별 분야의 자체 workflow가 실제로 필요해지는 경우에만 향후 독립 스킬 분리를 검토한다.

| 참조 모듈 | 다룰 핵심 | 실제 작업에 연결할 질문 |
| --- | --- | --- |
| `algorithms-data-structures` | 복잡도, 자료구조, 그래프, 종료 조건, 메모이제이션 | 입력 규모는 무엇이며 탐색·중복 제거·메모리 상한은 어떤가? |
| `language-semantics` | 값·타입, aliasing, 가변성, 수명, 예외·숫자 표현 | 참조 공유·경계값·예외가 계약을 깨는 경로가 있는가? |
| `operating-systems` | 프로세스, 파일, 자원 소유권, 시간, 종료·복구 | 자식 프로세스·파일 핸들·락을 누가 회수하며 crash 후 어떤 상태가 남는가? |
| `concurrency` | 경쟁, 원자성, 순서, 교착, 취소, stale owner | 비동기 작업 사이에서 상태 검증과 사용이 분리되어 있는가? |
| `databases` | 격리, 트랜잭션, 제약, 인덱스, 마이그레이션 | 불변조건을 어떤 DB 경계가 보장하며 rollback·경합은 어떻게 검증하는가? |
| `distributed-systems` | 중복·지연·유실, 순서, 멱등성, fencing, 부분 장애 | ACK의 의미, 재전송의 부작용, 오래된 소유자의 결과 수용 여부는 무엇인가? |
| `networking` | framing, deadline, 재연결, 프로토콜 경계 | 부분 응답·timeout·disconnect를 작업 실패와 어떻게 구분하는가? |
| `performance` | 병목, 계측, tail latency, backpressure, 메모리·캐시 | 최적화 전후 동일 부하를 측정했으며 상한과 포화 시 동작은 무엇인가? |
| `software-design` | 모듈 계약, 의존 방향, 상태기계, 사전·사후조건 | 상태 전이·책임·호환성 경계가 코드와 계약에서 일치하는가? |
| `security-boundaries` | 신뢰 경계·권한·입력 검증의 기본 제약 | 별도 보안 감사가 필요한 변경인가? CS 분석이 권한 승인을 대신하고 있지 않은가? |

`security-boundaries`는 기본 설계 제약과 기존 보안 감사로의 연결을 제공한다. 별도 보안 판정 체계를 만들지 않는다.

초기 구현은 concurrency, databases, distributed-systems, algorithms-data-structures, performance의 실제 결함 사례부터 시작한다. 나머지 모듈의 이름만 등록한 뒤 지식이 제공되는 것처럼 광고하지 않는다. 모듈별 상태를 `draft | validated`로 구분하고, 검증된 모듈만 기본 선택 대상으로 둔다.

### 3.1 교과서 요약 대신 규칙 카드

각 카드에는 다음 내용을 둔다.

```yaml
id: CONC-OWNERSHIP-001
version: 0.1.0
domain: concurrency
status: draft
applies_when:
  - 작업을 여러 실행 주체가 가져가거나 재할당할 수 있다.
assumptions:
  - 보호해야 하는 상태 변경의 경계가 식별되어 있다.
principle: 작업 선택과 소유권 확정의 원자성을 구분한다.
invariant: 현재 유효한 소유권 세대만 보호 대상 결과를 확정할 수 있다.
failure_modes:
  - 두 worker가 같은 대기 작업을 관측한 뒤 각각 실행한다.
  - lease가 만료된 이전 worker가 새 worker의 결과를 덮어쓴다.
decision_questions:
  - 소유권 확정의 선형화 지점은 어디인가?
  - 결과 저장이 소유권 세대 검증과 같은 원자적 경계에 있는가?
verification_obligations:
  - 독립 실행 주체의 경합에서 소유권 확정 결과를 관측한다.
  - 재할당 후 이전 세대의 결과 확정을 시도해 거절을 관측한다.
non_goals:
  - lease만으로 외부 부작용의 exactly-once를 보장한다고 주장하지 않는다.
sources:
  - SQLITE-TRANSACTIONS
  - AWS-IDEMPOTENT-APIS
```

이는 카드 형식 예시이며, 해당 규칙에 대한 감사를 통과한 배포 데이터가 아니다. 외부 자료는 일반 메커니즘의 근거이고, 프로젝트에 적용하는 불변조건은 작업별로 도출·검토한다.

### 3.2 규칙과 권고를 구분

한 CS 규칙을 로드했다고 그 카드의 모든 질문이 필수 gate가 되지는 않는다. 작업에 적용한 항목마다 다음 종류를 명시한다.

- `required-invariant`: 사용자 요구·저장소 정책·확인된 시스템 계약을 지키기 위한 필수 조건.
- `design-choice`: 여러 올바른 대안 중 이번 작업이 선택한 방식과 전제.
- `recommendation`: 개선 여지는 있지만 현재 완료를 막지 않는 제안.

권고를 실패 조건으로 승격하거나, 구현 후 불편해졌다는 이유로 필수 조건을 권고로 낮추지 않는다. 적용한 조건에는 원래 요구·정책·관측 사실과의 연결을 남긴다.

## 4. 자동 선택과 로딩

### 4.1 선택은 기존 호스트와 orchestrator가 담당

호스트의 스킬 설명 매칭을 유지한다. `cs-engineering`을 명시하지 않은 요청에서도 작업 목적·예상 동작·실제 변경 의미가 해당하면 선택돼야 한다. 단, 특정 단어의 존재만으로 붙이지 않는다.

| 요청 예 | 기대 경로 |
| --- | --- |
| “두 worker가 같은 작업을 집지 않도록 수정해.” | concurrency + databases 검토 후보 |
| “메시지를 재전송해도 같은 처리가 중복되지 않게 해.” | distributed-systems + persistence 조건 분석 |
| “작업 의존성 그래프의 실행 순서를 계산해.” | algorithms-data-structures + 상태기계 |
| “캐시를 추가해.” | 먼저 유효성·무효화·상한·계측 필요성 분석; 분산 캐시를 기본 도입하지 않음 |
| “README의 오탈자를 고쳐.” | CS 스킬 생략 |
| “큐라는 단어를 설명해.” | 일반 설명; 거버넌스 workflow 생성 안 함 |
| “이 SQLite claim 설계의 경쟁 조건을 읽기 전용으로 검토해.” | CS 스킬 직접 호출; 구현과 ponytail은 선택하지 않음 |

명시한 스킬을 다른 스킬로 치환하지 않는다. CS 입력이 부족하면 허용된 코드·문서·환경 관측으로 먼저 보완한다. 기존 작업 계약이 이미 동결됐다면 이를 덮어쓰지 않고, 새 제약이 기존 기준을 구체화하는지 변경하는지 구분한다.

### 4.2 `SKILL.md` 제안 본문

```markdown
---
name: cs-engineering
description: >
  동시성·DB·메시징·알고리즘·자원 수명·성능이 정확성에 영향을 주는
  설계·구현·기술 검토에서 CS 원리를 적용해 불변조건과 검증 항목을
  만들고 결과와 대조한다. 단순 문구 수정·일반 설명에는 사용하지
  않으며, 구현·보안 감사·독립 감사·배포 승인을 대신하지 않는다.
license: MIT
metadata:
  version: "0.1.0"
---

# CS Engineering

## 책임
작업에 필요한 CS 원리를 설계 제약과 검증 의무로 바꾼다.
새 실행 인프라, 권한 또는 독립 감사 판정을 만들지 않는다.

## 입력
요청과 적용 지침, 허용된 대상의 소스·설계·운영 근거를 확인한다.
기술 검토에서는 고정된 제약 보고서, 후보 digest, 검증 근거를 받는다.

## 수행
1. 요청 목적과 실제 상태 변경을 기준으로 적용 분야를 선택한다.
2. references/index.md에서 관련된 validated 모듈만 읽는다.
3. 사실, 그 사실에서 도출한 제약, 전제, 설계 선택을 구분한다.
4. 규칙마다 적용 범위·실패 조건·검증 방법을 명시한다.
5. 구현 전에는 cs-constraint-report를 반환한다.
6. 구현 후에는 같은 제약을 후보·근거와 대조해 cs-review-report를 반환한다.
7. 필수 미검증 항목과 확인된 위반을 구분하고, 다른 전문 역할이 필요하면
   필요한 capability와 이유를 반환한다. 직접 세션을 생성하지 않는다.

## 제한
사용자 요구·동결된 기준·권한·감사 절차를 축소하지 않는다.
스킬 로드, schema 통과 또는 테스트 명령 나열을 검증 완료로 취급하지 않는다.
가용한 증거보다 넓은 정확성·성능·보안 보장을 하지 않는다.
자료가 적용되지 않는 환경에 일반적인 모범 사례를 강제하지 않는다.

## 실패 처리
설계 입력이 의사결정에 부족하면 NEEDS_INPUT을 반환한다.
필수 근거에 접근할 수 없으면 BLOCKED와 부족한 관측을 반환한다.
구현 검토에서 고정 조건 위반이 확인되면 FAIL을 반환한다.
근거·대상·조건이 바뀌지 않은 반복 실행은 새로운 검증으로 취급하지 않는다.
```

Codex 전용 `agents/openai.yaml`에는 `allow_implicit_invocation: true`를 유지한다. 공용 본문에 특정 모델명이나 벤더별 호출 문법을 넣지 않는다. Claude용 표현 변경이 필요하면 기존 overlay 경계를 사용한다. [R1, R8]

### 4.3 필요한 만큼만 로딩

초기에는 이름·설명만 노출한다. 활성화한 뒤 인덱스를 읽고, 작업의 의미와 관련된 카드만 선택한다. 모델이 상세한 규칙을 요구하거나 새로운 실패 경로가 확인되면 추가 로딩한다. Agent Skills의 단계적 로딩 구조를 따른다. [R8, R9]

모듈 수를 “항상 3개”로 고정하지 않는다. 예산에 걸렸다는 이유로 필수 불변조건을 조용히 버리지도 않는다. 중복 설명 제거, 공유 카드 재사용, 작업 분리 순으로 조정하고, 정말 검토할 수 없는 필수 영역만 명시적으로 미검증으로 남긴다.

`SKILL.md`는 초기 설계 목표로 약 1,500 tokens 이내를 지향하고 세부 내용은 references로 이동한다. 이는 측정된 최적값이 아니라 평가할 예산이다. 토큰 측정에는 해당 호스트·모델 tokenizer 또는 실제 사용량 관측을 사용하며, 바이트 수를 토큰 수로 간주하지 않는다.

캐시는 규칙 ID·규칙 digest·스킬 버전별로 구분한다. 이전 세션에서 로드한 규칙의 존재만으로 현재 세션에서도 로드됐다고 기록하지 않는다.

## 5. 두 provider와 기존 단계 연결

### 5.1 제약 도출: bootstrap 25

요청의 실제 코딩·설계 의미를 확인한 뒤 필요할 때만 호출한다. `instruction-scope-resolution`과 필요한 workspace profile 뒤에 오고, 새로운 task contract를 최종 동결하기 전에 수행한다.

입력:

- 요청 및 지침의 고정된 reference/digest.
- 허용된 소스 또는 설계 대상과 snapshot digest.
- 알려진 운영 조건: 입력 규모, 실행 주체, 저장 경계, 실패 모델 등.
- 필요한 경우 이전 제약 보고서. 이는 참고자료이며 현재 작업 승인이 아니다.

출력:

- 관측 사실과 전제, 선택한 모듈·규칙 및 선택 이유.
- 작업별 불변조건·설계 선택·검증 의무.
- 검사 유형과 필요한 환경, 실패로 판단할 관측.
- 필요한 추가 전문 capability와 그 이유.
- `READY | NEEDS_INPUT | NEEDS_REDESIGN | BLOCKED`.

`READY`는 제약 보고서를 다음 계약 단계의 입력으로 사용할 수 있다는 의미다. 아직 만들지 않은 코드의 정확성이나 테스트 통과를 뜻하지 않는다.

`task-contract`는 사용자 요구를 바꾸지 않는 범위에서 이 결과를 제약·수용 근거 계획으로 정리한다. 새로운 제품 요구·성능 목표·보안 범위를 추가해야 한다면 기존 계약 결정 절차를 따른다. 단순히 “좋은 설계”라는 이유로 사용자 요청을 확대하지 않는다.

이미 동결된 계약이 있을 때도 제약 도출은 가능하다. 다만 그 결과가 기준 변경을 요구하면 새 revision과 기존 재검토 절차를 거쳐야 한다. 보고서만 몰래 교체하지 않는다.

### 5.2 구현: 기존 ponytail

`minimal-implementation`의 현재 역할은 유지한다. 새 역할을 추가하는 것이 아니라, 선택된 CS 작업에서는 고정된 제약 보고서와 검증 의무가 구현 입력에 포함되도록 연결한다.

기존 provider의 빈 `inputBindings`에 무조건 필수 CS 의존성을 추가하면 CS가 필요 없는 구현까지 깨진다. 조건부 optional binding과 런타임의 선택 정책 검사를 함께 추가한다. CS binding이 선택된 plan에서만 누락을 오류로 취급한다.

구현 결과에는 “어떤 제약을 어떤 구현 위치·테스트로 충족했는지”를 제시한다. 이 자체 진술은 기술 검토와 근거 검증을 대체하지 않는다.

단순화 기준:

> 필요한 불변조건을 만족하는 해법 중 가장 단순한 구현을 선택한다.

기존 모듈·표준 기능·DB 제약을 먼저 검토한다. CS 팩을 이유로 특별한 프레임워크·추상화·새 서비스부터 추가하지 않는다.

### 5.3 기술 검토: workflow 67

최종 후보의 target/digest, 고정 제약 보고서, 변경 범위, 실제 검증 근거를 입력으로 받는다. CS 리뷰 자체가 구현자와 같은 actor일 수 있지만, 그 경우 독립 감사라고 부르지 않는다. 최종 감사의 독립성 요구는 기존 감사 스킬이 유지한다.

먼저 목록에 있는 조건만 점검하지 말고, 실제 변경에서 빠진 중요한 실패 경로가 있는지도 검토한다. 빠진 필수 조건을 발견하면 범위·기준 변경 여부를 판단해 기존 재검토 절차로 전달한다. 동일 규칙팩을 읽은 여러 세션의 의견 일치만으로 검증을 대체하지 않는다.

각 필수 조건을 다음처럼 판정한다.

- `SATISFIED`: 사전에 정한 증거 종류와 현재 대상에 맞는 근거가 있다.
- `VIOLATED`: 해당 조건이 깨지는 근거가 있다.
- `UNVERIFIED`: 필요한 검증을 하지 못했거나 근거가 부족하다.
- `NOT_APPLICABLE`: 현재 범위에 적용되지 않는 이유와 근거가 확인됐다.

`NOT_APPLICABLE`은 실패를 지우는 탈출구가 아니다. 동결 뒤 필수 조건을 제외하려면 기준 변경 검토를 거친다.

상위 판정:

| 판정 | AGS 상태 매핑 | 의미 |
| --- | --- | --- |
| `PASS` | `passed` | 현재 범위의 필수 의무가 모두 충족되고 blocking 위반이 없다. |
| `FAIL` | `failed` / `GATE_FAILED` | 확인된 필수 조건 위반이 있다. |
| `BLOCKED` | `blocked` / `MISSING_EVIDENCE` 등 기존 원인 코드 | 필수 근거·대상·환경을 확인할 수 없다. |

형식 오류는 `INVALID_INPUT`, digest 불일치는 기존 무결성 오류 계약에 맞춰 처리한다. 새로운 공용 상태나 에러 코드를 호출 지점에서 임의로 만들지 않는다. [R6]

### 5.4 기존 사전점검 순서는 건드리지 않음

기준 소스에서 ponytail의 workflow `phaseOrder`는 44, mutation preflight는 45다. 이는 구현 단계에서 허용된 저장소 편집·테스트와 사전점검 대상인 외부·위험 변경이 구분되기 때문이다. CS 팩 도입을 핑계로 이 순서 또는 권한 경계를 재해석하지 않는다. [R2, R3]

## 6. 계약과 결속 설계

### 6.1 스킬 내부 계약

새 내부 계약은 세 개로 시작한다.

1. `cs-request.v1.schema.json`: 모드, 요청·지침·대상 reference, 관측 운영 조건.
2. `cs-constraint-report.v1.schema.json`: 분야·규칙·불변조건·검증 의무·전제·판정.
3. `cs-review-report.v1.schema.json`: 후보·조건·검증 근거 연결과 판정.

모든 계약은 모르는 필드를 거절하고, 항목 ID 중복·존재하지 않는 참조를 검사한다. 적용성 평가에서 필수 의무가 있다고 확정한 경우에는 빈 의무 목록도 거절한다. 미적용 작업에 불필요한 의무를 만들어 넣지는 않는다. JSON 구조 검증으로 기술 주장의 진위를 확인했다고 표시하지 않는다.

제약 보고서의 핵심 의미:

```text
requestDigest
sourceSnapshotDigest
knowledgePackVersion + knowledgePackDigest
selectedRules[] = ruleId + ruleDigest + applicabilityReason
facts[] / assumptions[] / designChoices[]
invariants[] = id + statement + scope + basisRefs + requirementLevel
verificationObligations[] =
  id + invariantIds + method + requiredEnvironment + failureOracle
requiredCapabilities[]
verdict
```

검토 보고서의 핵심 의미:

```text
constraintReportDigest
candidateDigest
reviewerActorRef
findings[] = invariantId + status + evidenceRefs + reasoningSummary
verificationResults[] =
  obligationId + executionStatus + targetDigest + environmentRef + evidenceRefs
blockingFindingIds[]
unverifiedRequiredObligationIds[]
verdict
```

`executionStatus`의 `NOT_RUN`·환경 미지원·관측 불가는 정상 수행 PASS와 구분한다. 필요하지 않은 동적 실행을 억지로 요구하지 않는다. 정적 증명·정적 검토가 충분한 의무라면 그 방법을 구현 전에 명시하고 해당 종류의 근거로 충족한다.

### 6.2 공유 계약: 기존 TaskEnvelope는 보존

`TaskEnvelope.v1`에 `csProfile`, `knowledgePack` 같은 임의 필드를 넣지 않는다. 문자열 배열에 구조화 JSON을 숨겨 넣는 방식도 사용하지 않는다.

기계적 결속은 새 공유 `CsEngineeringBinding.v1`로 다룬다.

```text
schemaVersion
requestRef + requestDigest
constraintReportRef + constraintReportDigest
taskDigest
knowledgePackVersion + knowledgePackDigest
policyId + policyVersion
mode = observe | enforce
requiredObligationIds[]
```

서버 정책을 caller가 낮출 권한은 없다. `mode`는 요청이 원하는 값이 아니라, 허용된 정책과 일치하는지 서버가 검증할 대상으로 취급한다. 새 binding은 사용자 승인이나 신뢰된 execution context를 발급하지 않는다.

### 6.3 PlanWorkflowRequest 확장

현재 wrapper는 `schemaVersion`, `taskEnvelope`, 선택적 `evaluationAuditPurpose`를 허용한다. [R7]

CS 결속이 필요한 요청을 지원하려면 wrapper의 **새로운 1.1.0 형태**를 추가하고 `csEngineeringBinding`을 명시적으로 정의한다. 기존 bare TaskEnvelope와 1.0.0 wrapper는 기존 의미로 계속 검증한다. 구버전 서버가 새 요청을 해석하지 못하면 명시적인 호환성 오류를 반환한다. 필드를 지우고 약한 경로로 조용히 재시도하지 않는다.

이 변경은 설계 제안이다. 현재 서버가 이미 해당 필드를 지원한다는 의미가 아니다.

공유 `CONTRACT_VERSION`을 일괄 상향하지 않고, request wrapper의 버전 분기와 새 계약 타입을 별도로 정의한다. 기존 기록은 생성 당시 계약·정책으로 읽으며, 새 강제 정책을 과거 실행에 소급해서 적용하지 않는다. 새 workflow의 정책은 서버가 정한 활성 정책과 결속하고, legacy 형식으로 제출했다는 이유만으로 새 정책의 필수 검토를 우회하게 하지 않는다.

`WorkflowPlan`, 후속 stage 입력, receipt 및 재계획 경로에도 같은 binding 또는 그 검증된 reference/digest를 연결한다. 구현 범위는 다음을 포함한다.

- 최초 요청 정규화와 schema 검증.
- 계획 구성과 서명에 binding 포함.
- expected plan 재구성 시 동일 binding 보존.
- attempt lease 및 guarded start에서 task·보고서·규칙팩 결속 검증.
- stage 입력 로드 시 digest 재검증과 경로 경계 확인.
- CS review와 acceptance 단계가 동일 의무 목록을 평가하는지 확인.
- 재개 시 기존 policy·규칙팩 revision 유지 또는 명시적인 재평가.
- 완료 직전 후보 digest와 최종 근거의 일치 확인.

`ConvergenceFrame`의 통제 자료 목록에는 해당 작업의 규칙팩·제약 보고서·검증 기준을 역할에 맞게 결속한다. 규칙팩이나 필수 의무를 바꾸면 단순 지식 캐시 갱신이 아니라 통제 기준 변경이다. 기존 frame 검토·epoch 경계를 적용한다. 선택할 정확한 기존 role은 의미에 따라 정하고, 보고서 전체를 무조건 제품 target으로 취급하지 않는다.

### 6.4 새 DB 없이 기존 기록 사용

구조화 보고서는 기존 artifact 저장 경계에 두고, 장부·receipt에는 reference와 digest, 요약 결과를 연결한다. 전문 스킬이 자체 장부나 상태 DB를 소유하지 않는다.

다른 세션에 위임할 때도 보고서 본문을 매번 복사하지 않고, 허용된 artifact reference·digest·필수 의무 ID를 전달한다. 수신자는 접근 가능성과 digest를 직접 검증한다. 접근할 수 없는 로컬 파일 경로를 보냈다는 이유로 전달 완료라 하지 않는다.

## 7. 강제 수준과 정책

### 7.1 세 수준을 분리

**호스트 자동 선택**은 스킬 설명과 문맥에 따른 의미적 선택이다. 적절한 선택을 평가해야 하며, 설명문만으로 모든 누락이 방지된다고 보장하지 않는다.

**직접 호출**은 해당 스킬이 판단·보고서를 제공하는 경로다. MCP가 관리하지 않는 shell·파일 작업까지 이 스킬이 기술적으로 차단한다고 주장하지 않는다.

**MCP 관리 workflow**는 선택된 의무·단계 순서·결과·증거의 결속을 런타임에서 강제할 수 있는 경로다. 전체 호스트의 명령 실행 통제와는 구분한다.

### 7.2 선택 정책 제안

- 일반 설명, 문구 수정, 관련 없는 작업은 미적용.
- 기술적 정확성에 관련 CS 조건이 있는 설계·구현은 의미 기반으로 선택.
- 고위험·치명적 코드 구현이 관리 workflow로 들어오면, 적용성 평가와 필요한 CS 검토의 존재를 서버 정책으로 확인.
- 고위험이라는 이유로 세금 문서·배포 승인 등 비코딩 작업에 무조건 CS 스킬을 붙이지 않음.
- 사용자가 스킬을 명시하면 해당 전문 분석을 수행하되, 승인·독립 감사가 면제되지는 않음.

확실히 기계적으로 관측할 수 있는 조건에는 기존 `riskLevel`, 선택한 `minimal-implementation`, 고정 scope·write targets 등을 사용한다. 파일 이름이나 단어만으로 실제 의미까지 확정하지 않는다. 새로운 시스템 의미가 숨겨져 있는 변경은 스킬 선택 테스트와 기술 검토로 탐지해야 한다.

### 7.3 진행 차단 조건

강제 모드에서 다음 상황을 완료 또는 다음 필수 단계로 통과시키지 않는다.

- 선택된 CS 검토 capability나 필수 보고서가 계획에서 빠짐.
- task·규칙팩·제약 보고서·후보·근거의 digest 불일치.
- 필수 의무가 미실행이거나, 필요한 실제 환경의 증거가 없음.
- 관련 근거 없이 필수 의무를 제외하거나 FAIL을 PASS로 변경.
- 자기 보고한 모델 정보·actor 정보만으로 신뢰 또는 독립성을 주장.

반면 단순 권고 미채택, 적용되지 않는 분야의 검토 생략, 필요하지 않은 외부 자료에 접근할 수 없음은 자동 차단 사유가 아니다. 실제 의사결정에 필요한 부분에만 불확실성과 차단을 적용한다.

## 8. 구체 예시: SQLite 작업 큐

이 절은 CS 팩이 생성해야 할 분석 예시다. 현재 AGS 큐에 해당 결함이 존재한다고 진단한 결과가 아니다.

요청: “여러 worker가 작업을 가져가고, 중단된 작업은 다시 처리할 수 있게 한다.”

먼저 확인할 사실:

- 동일 호스트의 SQLite DB인지, 외부 시스템과 통신하는지.
- claim·실제 처리·결과 저장·ACK가 각각 어느 저장 경계에 있는지.
- 허용되는 중복과 반드시 방지해야 하는 중복 부작용이 무엇인지.
- lease·재할당·종료 신호·재시도·영구 실패의 의미.

SQLite에서 쓰기가 직렬화된다는 사실은 여러 문장으로 분리한 애플리케이션 절차 전체의 원자성을 자동으로 보장한다는 뜻이 아니다. 트랜잭션 경계와 실패·재시도 동작을 함께 검토해야 한다. WAL도 동일 DB에 여러 writer가 동시에 쓰게 만드는 기능으로 취급하지 않는다. [R10, R11]

| 조건 | 필요한 판단 | 제안하는 검증 |
| --- | --- | --- |
| 하나의 대기 작업에 대한 경쟁 claim | 작업 선택과 claim 확정의 원자적 경계 | 실제 독립 DB 연결·프로세스에서 경합시켜 성공한 소유권 확정 수를 관측 |
| lease 만료 후 이전 worker의 복귀 | 오래된 세대가 결과를 확정할 수 없는지 | 새 세대 할당 후 이전 token으로 완료 저장 시도 |
| 처리 후 ACK 전 crash | redelivery와 부작용 중복의 처리 | 부작용 직후 강제 종료·재전송을 통해 외부 결과 확인 |
| 잠금·DB busy·중단된 transaction | rollback·재시도 상한과 상태 보존 | 별도 연결의 장기 transaction, 강제 종료, 재시도 소진 검사 |
| 부하 증가 | 큐·메모리·동시 실행 수 상한과 backpressure | 정의한 입력률에서 backlog·지연·메모리 관측 |

중요한 불변조건은 “물리적으로 실행 중인 worker가 항상 한 개”가 아니다. lease가 만료돼도 이전 worker가 실제로 멈췄다는 보장은 따로 필요하다. 보호 대상에는 **유효한 소유권 세대의 결과만 확정된다**는 조건을 두고, 외부 부작용에는 별도의 멱등성 또는 중복 억제 계약을 검토한다.

DB에서 token을 확인한 뒤 외부 API를 호출하는 것만으로 그 외부 API까지 같은 원자적 경계가 생기지는 않는다. 해당 서비스의 idempotency key 지원·보존 기간·요청 동일성·부작용 경계를 확인한다. [R12]

SQLite WAL DB 파일을 네트워크 파일시스템으로 공유해 여러 호스트가 직접 접근하는 구성을 기본 해법으로 제안하지 않는다. 실제 멀티노드 통신 경계와 노드별 저장소를 구분한다. [R11]

이 분석의 결론은 새 분산 프레임워크를 도입하라는 것이 아니다. 확인된 요구를 만족한다면 기존 transaction·조건부 갱신·소유권 token·테스트로 끝낸다.

## 9. 검증과 성능 평가

### 9.1 계약·실행 검증

`tests/cs-engineering/`에 정상·경계·예상 실패 fixture를 둔다. 결정적 테스트에는 다음을 포함한다.

- 잘못된 schema, 중복 ID, 끊어진 rule/invariant/evidence 참조 거절.
- 요청·보고서·규칙팩·후보의 변조와 stale revision 거절.
- 하나의 검증 의무도 없는 report로 필수 검토를 통과하려는 경우 거절.
- `NOT_RUN`을 실행 PASS처럼 제출하거나, 다른 후보의 테스트를 재사용하는 경우 거절.
- CS를 선택하지 않은 기존 direct·workflow·recovery 경로의 회귀 없음.
- CS가 선택된 경우 구현 입력 누락, review 누락, completion 우회 거절.
- 계획 서명·재구성·lease·재개에서 binding 손실 없음.
- report 경로 traversal·허용 root 밖 참조·symlink 탈출·과대 파일 차단.
- 공용 `core.mjs`의 CLI와 MCP 결과 일치.
- `node_modules` 없는 설치 트리에서 CLI·schema validator·reference 로딩 가능.

형식 검증과 semantic validation은 따로 시험한다. 예를 들어 JSON은 유효하지만 근거 없는 PASS인 보고서도 실패해야 한다. 다만 코드가 올바른지의 의미적 판단 전체를 deterministic validator가 증명한다고 표현하지 않는다.

### 9.2 실제 호스트 자동 선택 검증

Codex·Claude 실제 설치본 각각에서 다음을 검증한다.

- 스킬 이름을 넣은 명시 호출.
- 스킬 이름 없이 동작 의미만 설명한 호출.
- 유사 단어가 있지만 CS 검토가 불필요한 음성 사례.
- 기존 ponytail·orchestrator·보안·수용 근거 스킬의 선택 유지.
- 세션 재개·압축·업데이트 후 필요한 본문과 참고자료 로딩 유지.

모의 호스트 테스트는 계약 검증에 유용하지만 실제 스킬 목록 노출·설명 절단·자동 선택·설치 캐시 동작 검증을 대체하지 않는다. OpenAI 문서는 스킬이 많으면 초기 목록의 설명 축약 또는 일부 생략이 가능하다고 명시하므로, 전체 팩을 설치한 실제 상태로 평가한다. [R8]

### 9.3 효과를 분리하는 비교

비교 조건은 다음 세 가지로 제안한다.

```text
A: 기존 AGS
B: 기존 AGS + CS 참고자료/지침
C: 기존 AGS + CS 참고자료/지침 + 계약·근거 결속
```

같은 작업·모델·추론 수준·권한·소스 후보를 사용하고, 사례 순서를 섞는다. 반복 실행의 분산과 비용을 함께 기록한다. 평가 기준은 결과를 보기 전에 동결하고, 숨겨진 결함 사례를 별도 보관한다.

관측 지표:

- 실제 결함 탐지율과 무결함 코드에 대한 오탐.
- 필요한 CS 스킬·모듈 선택 누락과 무관한 활성화.
- 검증 미실행·근거 위조·stale evidence의 차단.
- 최종 정확성, 실패 후 재작업 횟수, 변경 규모.
- 입력·캐시·출력 token, wall-clock 시간, 실행·검토 비용.

품질 효과와 형식 통과율을 혼동하지 않는다. 실제 호스트 평가를 수행하지 않은 상태에서 “판단력이 몇 % 증가했다”거나 “토큰이 몇 % 절약됐다”고 주장하지 않는다.

효율은 첫 호출 비용만이 아니라 재작업과 결함 수정까지 포함해 비교한다. 다만 예상 손실을 임의 금액으로 확정하지 않고 실제 관측 가능한 지표와 가정을 구분한다.

### 9.4 도입 승인 기준

결정적 계약·우회·변조·기존 회귀 테스트는 모두 통과해야 한다. 실제 호스트의 중요 자동 선택 사례와 설치 실행은 실제 증거가 있어야 한다. 결과를 보기 전에 정한 오탐·비용 허용 기준과 결함 탐지 개선 기준을 만족해야 한다.

확인한 샘플에서 누락이 없었다는 결과를 모든 작업에 대한 100% 보장으로 일반화하지 않는다. 알려진 중요 회귀 사례 하나라도 다시 실패하면 원인 수정 후 재평가한다.

## 10. 지식 출처와 배포 안전성

`cs-engineering`은 AGS 내부 관리 스킬로 시작한다. `skills/source-lock.json`의 기존 내부 항목처럼 `updatePolicy: internal`, 적절한 version source와 실제 계산한 integrated checksum을 사용한다. 외부 repository URL을 provenance인 것처럼 꾸며 넣지 않는다. [R13]

추가적인 `sources.json`에는 참고자료 ID, 출처, 적용 범위, 확인일, 필요한 버전·절, 라이선스·귀속 정보를 보존한다. 외부 파일을 vendor할 경우 원본 revision·digest·허용된 재배포 범위도 기록한다.

규칙 카드는 가능하면 AGS의 자체 서술로 작성한다. 외부 스킬은 구조나 항목의 참고 대상일 수 있지만, 감사·권한·컨텍스트 로딩·숨은 도구 호출·라이선스를 확인하기 전에는 팩에 포함하지 않는다.

CS 원리처럼 상대적으로 안정적인 내용과 SQLite·Node·호스트 API처럼 버전 의존인 사실을 분리한다. 후자는 실행 환경에서 관측한 버전 또는 공식 문서 확인이 필요하면 명시한다. 최신 문서 조회 도구는 선택 가능한 자료 공급 경로이지 이 팩의 필수 벤더 종속성이 아니다.

런타임에는 임의 외부 URL을 자동 실행하거나 새 명령을 내려받지 않는다. 참고자료 본문은 데이터·설계 근거이며 사용자 권한이나 저장소 운영 규칙을 대체하지 않는다.

## 11. 파일 배치와 변경 지도

아래 트리의 `NEW`는 새 파일 제안이고, `EDIT`는 기준 저장소에서 확인한 기존 경로의 변경 대상이다. 실제 호스트별 등록 여부는 구현 시 해당 manifest의 등록 방식을 검증한다.

```text
skills/
  cs-engineering/                              NEW
    SKILL.md
    agents/openai.yaml
    references/
      index.md
      algorithms-data-structures.md
      language-semantics.md
      operating-systems.md
      concurrency.md
      databases.md
      distributed-systems.md
      networking.md
      performance.md
      software-design.md
      security-boundaries.md
    assets/
      rule-catalog.json
      sources.json
    contracts/
      cs-request.v1.schema.json
      cs-constraint-report.v1.schema.json
      cs-review-report.v1.schema.json
    scripts/
      core.mjs
      validate.mjs
  registry.json                               EDIT
  source-lock.json                            EDIT
  orchestrator/SKILL.md                        EDIT (짧은 연결 지침만)
  orchestrator/references/entry-details.md      EDIT
  ponytail/SKILL.md                            EDIT (조건부 제약 입력 준수)
  task-contract/                              EDIT (관련 입력·근거 계획 연결)
  acceptance-evidence-validator/               EDIT (CS 의무와 근거 연결)

contracts/
  cs-engineering-binding.v1.schema.json         NEW
  plan-workflow-request.v1.schema.json          EDIT (새 wrapper 형태)
  types.ts                                    EDIT
  [기존 계획·stage·receipt 관련 schema]         EDIT (binding 전달)

mcp-server/src/
  workflow-service.ts                         EDIT
  schema-validator.ts                         EDIT
  [기존 plan/start/record 도구 연결부]          EDIT

claude-overlay/
  adaptations/cs-engineering.json              필요할 때 NEW

tests/
  cs-engineering/                              NEW
  cs-engineering.integration.test.ts           NEW (기존 테스트 관례에 맞게 조정)

README.md                                     EDIT
README.en.md                                  EDIT
docs/cs-engineering-design.ko.md               NEW
```

`core.mjs`는 형태·참조·결속·상태 판정의 결정적 검사를 공유한다. 실제 프로젝트 코드를 검사·실행하는 범용 새 runner를 만드는 파일이 아니다. runtime schema 검증에는 `runtime/schema-validation.mjs`를 재사용하고 설치 후 별도 npm 패키지를 요구하지 않는다. [R1]

공통 intake 안내를 수정할 때는 해당 원본·생성/동기화 경로를 확인하고 연결한다. 여러 SKILL.md에 CS 규칙 전문을 복제하지 않는다. 사용자의 기존 스킬 설명과 자동 선택을 일괄 중립화하지 않는다.

`claude-plugin/`을 직접 수정하지 않는다. Claude 배포를 준비할 때 기존 `pnpm claude:build`로 생성하고 검사한다. 공용 원본 변경만으로 Claude 배포물이 갱신되었다고 보고하지 않는다. [R1]

## 12. 구현 순서와 작업 분담

### 단계 A — 경계·계약 고정

새 작업 브랜치에서 기준 commit과 실제 작업 브랜치 차이를 확인한다. 기존 구조, 스킬 수·버전, 정확한 schema loader·plan/stage 경로를 확인하고 본 설계를 해당 소스에 맞춰 고정한다. 미추적·다른 작업 변경을 보존한다.

제약 도출/리뷰 계약, 부트스트랩 위치, 기존 역할과의 경계, 원천 규칙 provenance부터 확정한다. 기능 구현 전에 승인 없는 범위 확대나 평가 기준 변경을 방지하는 조건을 테스트로 정한다.

### 단계 B — 스킬 내용과 독립 CLI

초기 핵심 모듈의 규칙 카드와 실제 결함 fixture를 작성한다. SKILL 본문, 공식 메타데이터, registry 항목, source-lock, README 두 표를 함께 정리한다.

필요하면 기존 명령으로 최소 scaffold를 만들 수 있다.

```bash
pnpm new:skill --name cs-engineering --phase cs-constraint-derivation --capability cs-constraint-derivation
```

이 명령은 스킬·기본 registry 항목·테스트 scaffold를 만든다. 이 설계의 두 provider, 공유 binding, 전체 배포·검증까지 구현하는 명령은 아니다. 생성 후 bootstrap class와 두 provider 계약 등을 맞춰야 한다. [R14]

### 단계 C — AGS 흐름 통합

기존 task-contract, ponytail, review, acceptance 사이 입력과 근거를 연결한다. PlanWorkflowRequest와 모든 plan 재구성·서명·실행 경로에 binding을 전달한다. 기존 workflow 의미가 바뀌지 않는 것을 회귀 테스트로 확인한다.

초기 후보에서는 `observe` 정책으로 기존 gate를 약화하지 않은 채 CS 결과·추가 비용·누락을 관측한다. `enforce`에서는 선택된 필수 의무가 완료 조건으로 작동한다. 모드·정책은 새 작업 시작 때 고정하고, 진행 중 caller가 낮출 수 없게 한다.

관측 모드는 발견한 문제를 사용자에게 숨긴다는 뜻이 아니다. CS 팩 자체의 자동 차단을 새로 적용하지 않는 단계이며, 기존 위험·승인·감사 gate는 그대로 유효하다.

### 단계 D — 실제 호스트와 독립 검증

Codex와 Claude의 실제 설치 경로에서 자동 선택·reference 로딩·CLI 실행·MCP 연결·후속 스킬 입력 전달을 검증한다. 개발 저장소에서의 통과와 설치물 통과를 구분한다.

구현 참여자와 분리된 감사자가 고정 후보·테스트·라이선스·강제 경계·회귀 결과를 검토한다. 후보가 바뀌면 영향 범위를 재감사한다.

### 단계 E — 명시적 요청이 있을 때만 릴리스

설계 요청은 배포 요청이 아니다. 버전 상향·push·tag·Release·설치 캐시 갱신은 별도 명시 요청 및 기존 절차를 따른다.

기준 `AGENTS.md`의 전체 검증 순서:

```bash
pnpm install --frozen-lockfile
pnpm bundle:check
pnpm claude:drift
pnpm lint
pnpm build
pnpm test
pnpm runtime:check
pnpm validate:all
pnpm validate:official
git diff --check
```

`bundle:check`를 build보다 먼저 실행한다. 추가로 source-lock·컨텍스트 최적화·새 CS 계약/호스트 평가를 해당 변경 범위에 맞게 검사한다. Claude 배포를 함께 준비할 때는 별도 build/check도 수행한다. 실행하지 않은 명령을 통과로 기록하지 않는다. [R1, R15]

### 작업 소유권

규칙·평가 담당, 계약·MCP 통합 담당, 실제 호스트 검증 담당을 병렬로 배치할 수 있다. 공유 registry·source-lock·types·workflow-service는 파일별 단일 작성자를 지정한다. 독립 감사자는 구현에 참여하지 않는다. 배분 자체는 기존 AGS가 수행하며 CS 팩은 새 세션을 자동 생성하지 않는다.

## 13. 완료 정의

이 기능의 완료는 `SKILL.md` 파일이 존재하는 것이 아니다.

1. 스킬을 이름으로 지정하지 않은 관련 요청에서 실제로 선택되고, 무관한 요청에서는 기존 경로가 유지된다.
2. 필요한 참고자료만 로딩한 뒤 원래 요구에 연결된 제약과 검증 의무가 만들어진다.
3. 구현 단계가 그 조건을 입력으로 받고, 최종 리뷰가 동일 조건·후보를 평가한다.
4. 관리 workflow에서 선택된 필수 검증의 누락·변조·stale evidence·우회가 차단된다.
5. 실제 설치 호스트에서 작동하고, 품질·오탐·비용 비교가 사전에 고정한 기준을 만족한다.
6. 기존 승인·감사·모델/추론 하한·장부·컨텍스트·호스트 중립성이 유지된다.

결과적으로 AGS는 CS 자료를 보유하는 것을 넘어, **CS에서 도출한 조건이 구현과 검증 근거까지 이어지는 작업 체계**를 제공하게 된다. 실제 품질 향상의 크기는 도입 평가 결과로 보고한다.

## 근거 목록

저장소 근거는 모두 위에 명시한 기준 commit에서 확인한 파일이다. 이 문서의 phase 25/67, 새 스킬·계약·필드·정책·평가 구성은 현행 기능이 아니라 설계 제안이다.

- [R1] `AGENTS.md`: 역할·호스트 경계, 배포물, 검증 순서, 스킬/README/source-lock 규칙.
- [R2] `skills/orchestrator/SKILL.md`, `skills/orchestrator/references/entry-details.md`: 접수·선택·bootstrap/workflow/recovery·직접 호출·필수 gate 경계.
- [R3] `skills/registry.json`: capability, executionClass, phaseOrder, inputBindings, stateMapping. 특히 task-contract, workspace-convention-profiler, ponytail, change-scope-guardian, software-security-auditor, acceptance-evidence-validator 항목.
- [R4] `contracts/task-envelope.v1.schema.json`: 폐쇄형 필드와 기존 문자열 제약·수용 기준.
- [R5] `mcp-server/src/workflow-service.ts` 1–340행: planWorkflow, 계획 서명, claimWorkflowAttempt와 expected plan 재구성·frame 검증.
- [R6] `contracts/types.ts` 1–220행: 기존 상태, 오류 코드, ExecutionContext·ExecutionRequirement.
- [R7] `contracts/plan-workflow-request.v1.schema.json`: 현재 bare task/wrapper 및 evaluationAuditPurpose.
- [R8] OpenAI, Build skills: `https://learn.chatgpt.com/docs/build-skills` (공식 기존 경로 `https://developers.openai.com/codex/skills/`에서 확인). 단계적 로딩, 설명 기반 선택, 목록 예산, openai.yaml.
- [R9] Agent Skills specification: `https://agentskills.io/specification`.
- [R10] SQLite, Isolation / Transaction: `https://www.sqlite.org/isolation.html`, `https://www.sqlite.org/lang_transaction.html`.
- [R11] SQLite, Write-Ahead Logging: `https://www.sqlite.org/wal.html`.
- [R12] AWS Builders' Library, Making retries safe with idempotent APIs: `https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/`.
- [R13] `skills/source-lock.json` 1–105행: schemaVersion 3.0.0과 internal 소스 기록 형태.
- [R14] `scripts/new-skill.mjs`: scaffold 생성 범위와 명령 인자.
- [R15] `package.json`: 2.7.7, Node 24 이상, pnpm 11.19.0, 실제 검증 스크립트.
