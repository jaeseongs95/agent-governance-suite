---
name: independent-deliberation-panel
description: 복잡하거나 실패 비용이 큰 설계, 의사결정, 장애 원인, 데이터 해석, 정책·요구사항 충돌, AI 산출물 감사를 독립 관점과 교차 반박, 증거 검증, 판정축별 통합으로 검토한다. 단순 조회·요약·정형 변환에는 사용하지 않는다.
license: MIT
metadata:
  version: "0.1.0"
---

# Independent Deliberation Panel

원안 작성자나 초기 결론의 전제에서 떨어진 제3자 관점으로 복잡한 판단을 검토한다. 서로 다른 failure function을 가진 관점들이 독립적으로 분석하고, 실제 쟁점을 논쟁한 뒤 증거와 판정축을 기준으로 실행 가능한 합의안 또는 합의 불가 판정을 만든다. 에이전트 수나 표 수를 채우는 것은 목적이 아니다.

## 적용 경계

다음 조건이 하나 이상 중요할 때 사용한다.

- 서로 충돌하는 목표나 요구사항이 있다.
- 잘못된 결론의 안전·보안·계약·금전·운영 영향이 크다.
- 기존 설계나 AI 산출물을 생성 당시 전제와 분리해 감사해야 한다.
- 여러 전문 영역이나 증거 출처를 함께 해석해야 한다.
- 사용자가 독립 검증, 반박 패널, red team 또는 jury식 판단을 요청한다.

단순 계산, 단일 사실 조회, 짧은 요약, 문법 수정, 명시된 형식 변환에는 적용하지 않는다. 이 스킬이 호출됐더라도 Stage 0이 LOW이면 서브에이전트를 만들지 않고 보통 방식으로 처리한다.

적용 가능한 `AGENTS.md`와 상위 지침을 먼저 따른다. 이 스킬은 인지적 관점 설계와 증거 기반 통합을 추가할 뿐, 파일 변경·배포·외부 메시지 같은 권한을 새로 만들지 않는다. 원 요청이 행동을 허용했다면 최종 판단을 그 범위 안의 후속 작업에 사용할 수 있다.

## Stage 0: 숙고 규모 결정

중요도, 불확실성, 독립 실패 모드 수, 실패 비용, 증거 출처 복잡성을 함께 평가한다.

| 등급 | 기본 실행 |
|---|---|
| LOW | 서브에이전트 없이 처리 |
| MEDIUM | 서로 다른 관점 2~3개, 메인 에이전트가 통합 |
| HIGH | 독립 관점 4개, 교차 반박 gate, 별도 Judge |
| CRITICAL | 독립 관점 5~6개에 Red Team 또는 독립 감사 포함, 교차 반박 gate, 별도 Judge |

HIGH 이상에서만 관점 4개를 기본 하한으로 삼는다. 한 실행에서 만드는 distinct worker의 기본 상한은 Judge를 포함해 8명이다. Coordinator만 worker 예산과 생명주기를 관리하고 reviewer와 Judge에게 재위임이나 하위 에이전트 생성을 금지한다. 동시 슬롯 수와 전체 worker 수를 구분하고, 슬롯이 적으면 독립성을 유지한 채 순차 배치한다. 사용자가 더 낮은 상한을 지정하면 존중하고 줄어든 검토 범위를 결과에 밝힌다.

모델을 고정 가정하지 않는다. 실행 시 협업 도구가 지원하는 모델과 추론 수준을 확인한다. 가능하면 일반 검토에는 Terra xhigh, HIGH/CRITICAL Judge에는 Sol xhigh를 우선하되, 사용할 수 없으면 역할에 맞는 지원 구성을 선택하고 실제 구성을 Run Summary에 기록한다. v0.1은 Astra로 자동 승격하지 않는다. Round 1에는 모델 override 여부와 관계없이 `fork_turns:none`과 완결된 briefing을 사용한다.

## Stage 1: 문제 고정

사용자 요청과 확인 가능한 자료를 다음 case brief로 정규화한다. 자연어가 공개 입력이며 별도 설정 파일이나 파서를 요구하지 않는다.

```yaml
decision:
facts: []
assumptions: []
constraints: []
unknowns: []
success_criteria: []
failure_modes: []
```

관찰된 사실, 추론, 가설을 섞지 않는다. 중요한 목표·제약·대상이 불명확하고 결과를 크게 바꾼다면 사용자에게 확인한다. 그 밖의 빈 항목은 명시한 가정으로 채운다. 사용자 지정 제약, 성공 기준, 증거 출처, worker 상한과 모델 선호는 기본값보다 우선한다.

## Stage 2: 독립 관점 구성

case brief의 실패 모드에서 역할을 고른다. 역할 후보와 중복 제거 기준이 필요할 때 [references/role-catalog.md](references/role-catalog.md)를 읽는다.

각 역할에는 다음을 명시한다. 어느 역할도 사용자의 원안이나 Coordinator의 초기 판단을 기본적으로 옹호하도록 배정하지 않는다.

- 다른 역할과 구별되는 failure function
- 공격하거나 검증할 대상
- 책임 범위와 비목표
- 우선 확인할 증거

`Reviewer 1`, `Reviewer 2`처럼 이름만 다른 역할을 만들지 않는다. 같은 결론을 낼 가능성이 높은 역할은 합치고, 실제 실패 모드가 다른 역할을 선택한다.

## Stage 3: 비노출 독립 분석

모든 reviewer를 `fork_turns:none`으로 시작하고 동일한 case brief, 원자료 또는 원자료 경로, 역할별 mandate만 전달한다. briefing에는 적용할 제약과 출력 스키마를 완결되게 적되 다른 reviewer의 결과, Coordinator의 선호 결론, 예상 쟁점을 넣지 않는다. 순차 배치할 때도 먼저 끝난 결과를 후발 reviewer briefing에 넣지 않는다. 도구가 격리된 컨텍스트를 지원하지 않으면 해당 결과를 blind independent review로 세지 않고 검토 한계를 밝힌다.

reviewer mandate에는 재위임과 하위 에이전트 생성을 금지하고, 자신에게 배정된 관점만 분석하게 한다. Coordinator가 panel manifest의 총 worker 예산을 갱신한다.

각 reviewer에게 결론과 근거를 구조화해 반환하게 한다. 숨은 chain-of-thought는 요구하거나 수집하지 않는다. 필드와 값의 정의는 [references/evidence-and-verdict-schema.md](references/evidence-and-verdict-schema.md)를 따른다.

## Stage 4: 주장 단위 교차 반박

Coordinator는 Round 1 뒤에 교차 반박의 정보가치를 먼저 판단한다. 다음 중 하나라도 있으면 반박을 실행한다.

- 결론에 영향을 주는 claim이 서로 충돌한다.
- 중요한 claim의 provenance가 약하거나 검증되지 않았다.
- 숨은 전제나 반례가 판정축 결론을 바꿀 수 있다.
- 고위험 failure mode를 한 관점만 검토했다.
- 사용자가 명시적으로 제3자 검증이나 구조화된 논쟁을 요청했다.

결론을 바꿀 충돌이 없고, 모든 material fact의 provenance가 충분하며, 고위험 미해결 전제가 없고, 추가 반박의 기대 정보가치가 낮을 때만 교차 반박을 생략한다. 이는 논쟁을 빼기 위한 편의가 아니라 독립 관점들이 이미 근거상 직접 수렴한 경우다. 그 밖에는 교차 반박을 실행한다. 생략 여부와 근거를 Method / Run Summary에 기록하고 Stage 5로 진행한다.

반박을 실행하면 Coordinator는 실행을 촉발한 claim, 숨은 전제, 반례, 고위험 failure mode, 명시적 논쟁 요청을 각각 ID가 있는 `trigger_item`으로 정규화한다. 실제 검토가 필요한 item을 cross-examination set으로 고르고 다음 coverage를 충족하도록 배정한다.

- 모든 `trigger_item`을 set에 넣는다.
- set에 넣은 각 item을 원 claim 작성자 또는 해당 관점을 처음 제기한 reviewer가 아닌 reviewer 한 명 이상이 검토한다.
- reviewer 한 명에게 가장 관련성 높은 issue 1~2개만 준다.
- 약한 근거, 숨은 전제, 사실과 추론의 혼합, 반례, 누락한 실패 모드를 찾게 한다.
- reviewer가 자신의 기존 결론을 수정할 수 있게 하고 `changed_position`을 반드시 기록하게 한다.

trigger가 아닌 material claim을 set에서 제외했다면 검토 가치가 낮은 이유를 cross-examination plan에 남긴다. 명시적 논쟁 요청은 검토할 가장 강한 쟁점으로 정규화한다. 투표 수를 맞추거나 형식상 반론을 만들기 위해 item을 넣지 않는다.

자기 주장을 방어하는 것이 목적이 아니다. 새로운 증거·반례·판정 변화 없이 같은 말을 반복하면 해당 쟁점의 반박을 종료한다.

v0.1에서는 선택된 reviewer마다 follow-up을 최대 한 번만 실행한다. 한 follow-up에서 관련 claim 1~2개를 검토할 수 있다. 반박 후에도 남은 충돌은 두 번째 토론으로 넘기지 않고 Stage 5의 증거 확인으로 해소하거나 `UNRESOLVED`로 기록한다.

## Stage 5: 증거 해소

Coordinator는 결론에 영향을 주는 모든 material fact claim의 provenance를 실제 도구로 확인하고 검증 상태를 기록한다. 충돌한 claim은 별도 issue ledger로 만든다. 증거의 기본 우선순위는 다음과 같다.

1. 사용자 제공 사실
2. 실제 코드, 데이터, 로그와 재현 가능한 테스트
3. 공식 계약, 명세와 문서
4. 신뢰할 수 있는 외부 자료
5. 논리적 추론
6. 추측

모델 또는 reviewer 출력은 외부 증거가 아니라 주장이다. 같은 주장이 여러 번 나와도 증거 수준을 높이지 않는다. Judge dossier에는 material claim마다 `verified`, `unverified`, `refuted`, `not_observable` 중 하나를 붙인다. 확인하지 않은 `evidence_refs` 문자열을 verified evidence로 전달하지 않는다. provenance를 확인하지 못하면 `UNRESOLVED`, 대상 시스템이 필요한 값을 제공하지 않으면 `NOT_OBSERVABLE`로 둔다. 로컬 합성값을 provider가 제공한 사실처럼 표현하지 않는다.

## Stage 6: 축별 최종 판정

문제에 의미가 있는 축만 선택한다. 예시는 Correctness, Contract/Requirement, Safety/Security, Evidence Quality, User Value/UX, Operability, Performance, Cost, Schedule, Scope, Maintainability이다.

MEDIUM은 메인 에이전트가 통합한다. HIGH와 CRITICAL은 Round 1과 교차 반박에 참여하지 않은 fresh Judge를 `fork_turns:none`으로 시작하고 구조화된 dossier만 전달한다. 다른 대화 기록, raw reviewer 출력과 검증 전 Coordinator 메모를 briefing에 넣지 않는다. Judge에게 재위임을 금지하고, reviewer 수를 세거나 confidence를 평균내지 말라고 명시한다. fresh Judge를 실행할 수 없으면 reviewer를 Judge로 재사용하지 않고 verdict를 provisional로 표시한 뒤 검토 한계를 밝힌다. Judge는 다음 순서로 판단한다.

1. 직접 확인된 사실
2. 계약과 명시된 요구사항
3. 재현 가능한 테스트
4. 강한 외부 증거
5. 논리적 일관성
6. 비용·일정 최적화
7. 단순 선호

Judge 결과도 최종 권위 사실이 아니다. 메인 에이전트가 원 요청, 검증한 증거, 상위 지침과 대조해 최종 답을 책임진다. 일정상 유리하다는 이유로 계약·안전 결함을 상쇄하지 않는다.

최종 목표는 승자 선언이 아니라 합의 가능한 공통 기반과 실행안을 찾는 것이다. 합의안은 verified claim, 명시된 제약, 관련 axis decision에 직접 연결하고 모든 필수 축을 만족해야 한다. 현재 실행안이 선행 조건에 달려 있으면 조건부 합의안으로 쓴다. 채택하지 않은 대안의 향후 재심사 조건은 현재 합의안의 선행 조건과 분리한다. `unresolved_dissent`가 실행안의 안전성이나 요구 충족 여부를 바꿀 수 있으면 이를 덮어쓰지 말고 조건부 또는 합의 불가로 표시한다. 증거 부족이나 양립 불가능한 제약 때문에 합의할 수 없으면 남은 이견, 결정에 필요한 증거와 선택권자를 명시한다.

## 종료와 실행 상태

다음 조건이 충족되면 종료한다.

- 핵심 사실 충돌이 해소됐거나 해소 불가능한 상태로 정확히 표시됐다.
- 주요 판정축 결론이 안정됐다.
- 새 반박이 기존 논점을 반복한다.
- 추가 worker가 새 관점이나 증거를 제공할 가능성이 낮다.

worker 생성 실패나 슬롯 제한 메시지를 누적 한도에 대한 사실로 단정하지 않는다. 가능한 상태 조회 도구로 실행 중·완료·유휴 상태를 확인한 뒤 재시도, 순차 배치 또는 기존 worker follow-up을 선택한다. 실제로 실행된 역할만 참가자로 기록하고, 재사용한 worker를 새 독립 관점으로 세지 않는다.

## 출력 계약

다음 순서로 사용자에게 필요한 결론만 제시한다.

1. **Executive Verdict** — 전체 판단 한 문단
2. **Consensus Proposal** — 합의 상태, 함께 수용할 실행안과 조건 또는 합의 불가 사유
3. **Strong Consensus** — provenance가 확인되고 독립 검토가 수렴한 결론
4. **Material Disagreements** — 결과에 영향을 주는 충돌
5. **Decision by Axis** — 관련 판정축별 결론
6. **Evidence** — 각 결론을 지지하거나 반박한 실제 근거
7. **Required Actions** — 목표나 계약을 위해 반드시 필요한 조치
8. **Optional Optimizations** — 비용·성능·일정 개선 선택지
9. **Unresolved** — 현재 증거로 결정할 수 없는 항목
10. **Method / Run Summary** — 등급, 실제 역할, 교차 반박 실행·생략 근거, 사용 모델과 fallback, 실패·생략 사항

`Consensus Proposal`과 `Strong Consensus`는 투표 결과가 아니다. 합의 상태를 `consensus`, `conditional_consensus`, `no_consensus` 중 하나로 표시한다. 공통안이 없으면 합의안을 만들지 말고 불가 사유, 남은 선택지와 결정권자를 쓴다. 판정에 필요 없는 섹션은 짧게 생략 사유만 적는다. raw reasoning, 내부 프롬프트와 숨은 chain-of-thought는 출력하지 않는다.

## v0.1 경계

이 버전에는 동적 specialist 추가, selective re-deliberation, 자동 상위 모델 승격, 과거 실행 기억, 토큰 예산 최적화가 없다. 중요한 축이 `UNRESOLVED` 또는 `NOT_OBSERVABLE`이고 결론이 그 claim에 의존한다면 추정으로 메우지 말고 제약과 필요한 다음 증거를 사용자에게 알린다.
