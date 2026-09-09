# Independent Deliberation Panel

복잡하거나 실패 비용이 큰 판단을 원안에서 떨어진 제3자 관점으로 검토하는 Codex 스킬입니다. 서로 다른 failure function을 가진 검토자들이 독립 분석을 수행하고, 결론을 바꿀 쟁점이 있을 때만 교차 반박합니다. 확인된 증거와 판정축을 연결해 `consensus`, `conditional_consensus`, `no_consensus` 중 하나로 결론을 냅니다.

에이전트 수를 채우거나 억지 합의를 만드는 용도가 아닙니다. 증거가 부족하거나 실행 환경이 독립 검토를 보장하지 못하면 그 한계를 결과에 표시합니다.

## 언제 쓰나요

- 시스템 설계나 아키텍처의 중요한 선택을 검증할 때
- 보안, 운영, 계약, 사용자 경험처럼 충돌할 수 있는 기준을 함께 판단할 때
- 되돌리기 어렵거나 실패 비용이 큰 결정을 내릴 때
- 기존 AI 분석이나 제안서를 독립적으로 감사할 때
- 복잡한 장애 원인이나 여러 해석이 가능한 데이터를 검토할 때

단일 사실 조회, 짧은 요약, 계산, 문법 수정, 정형 변환에는 사용하지 않습니다.

## 설치

이 저장소는 standalone Codex 스킬을 배포합니다. 아직 plugin이나 marketplace 패키지는 아니며, 여러 스킬을 묶는 오케스트레이션 플러그인은 이후 별도 프로젝트에서 연결합니다. Codex가 읽는 저장소 범위 경로와 사용자 범위 경로는 [OpenAI Skills 문서](https://learn.chatgpt.com/docs/build-skills)에 설명되어 있습니다.

저장소 하나에서만 사용하려면 해당 저장소 루트에서 다음처럼 설치합니다.

```powershell
git clone --branch v1.0.0 --depth 1 https://github.com/jaeseongs95/independent-deliberation-panel.git .agents/skills/independent-deliberation-panel
```

개인 환경에 설치하려면 Codex에서 다음과 같이 요청할 수 있습니다.

```text
$skill-installer로 jaeseongs95/independent-deliberation-panel의 v1.0.0을 사용자 스킬로 설치해 줘.
```

같은 이름의 이전 설치본이 있으면 먼저 변경 사항을 확인해야 합니다. 설치 후 스킬이 보이지 않으면 Codex를 다시 시작합니다.

## 사용

요청에 `$independent-deliberation-panel`을 넣으면 명시적으로 호출할 수 있습니다.

```text
$independent-deliberation-panel을 사용해 이 인증 아키텍처의 출시 여부를 보안, 운영, 사용자 경험 관점에서 검토해 줘.
```

```text
$independent-deliberation-panel로 이 마이그레이션 계획을 제3자 관점에서 논쟁하고, 합의안과 미해결 위험을 구분해 줘.
```

자동 호출이 켜져 있어 스킬 이름을 쓰지 않아도 복잡하거나 고위험인 판단 요청에는 선택될 수 있습니다. LOW로 분류된 요청은 서브에이전트를 만들지 않습니다.

필요하면 요청에 다음 제어 블록을 추가할 수 있습니다. 별도 설정 파일이나 parser가 아니라 스킬이 해석하는 자연어 입력입니다.

```yaml
deliberation:
  execution_assurance: strict | degraded_ok
  adaptive_review: bounded | off
  max_distinct_workers: 8
  include_decision_record: false
```

네 제어의 규범 계약은 다음과 같습니다.

| 제어 | 허용 값 | 기본값 | 의미 |
|---|---|---|---|
| `execution_assurance` | `strict`, `degraded_ok` | `degraded_ok` | required capability가 없으면 preflight-only로 중단할지, 가능한 범위에서 실행할지를 정합니다. |
| `adaptive_review` | `bounded`, `off` | `bounded` | specialist 1명과 영향 범위 재검토 1회의 허용 여부를 정합니다. |
| `max_distinct_workers` | 정수 `0`–`8` | `8` | 실제 instantiated reviewer, Judge, specialist의 합계 상한입니다. |
| `include_decision_record` | `true`, `false` | `false` | schema-valid `DecisionRecord.v1` 전체를 사용자 출력에 포함할지 정합니다. |

상위 지침이 먼저이고, 그 다음 사용자의 명시적 안전·증거·독립성·Judge 요구와 유효한 제어 값, 마지막이 기본값입니다. 한 제어의 값은 다른 제어를 암묵적으로 바꾸지 않습니다. 허용 밖의 값, 정수가 아닌 값·범위 밖 숫자, 모호한 표기, 충돌하는 중복 값은 조용히 보정하지 않고 invalid로 공개해 실행 전 확인합니다. 상위 지침상 즉시 처리해야 하고 나머지 범위가 명확하면 invalid 제어는 적용하지 않으며, 사용한 기본값을 `Method / Run Summary`에 남깁니다.

`adaptive_review: off`는 specialist와 재검토를 금지합니다. cross-examination, evidence 확인, required fresh Judge는 그대로 적용하며 capability shortfall을 뜻하지 않습니다. 낮은 worker 상한에서는 required fresh Judge와 필요한 reviewer를 먼저 보존하고, 줄어든 검토 범위를 결과에 밝힙니다.

## 1.0 동작

1. 현재 환경이 독립 reviewer, 상태 확인, fresh Judge와 증거 접근을 지원하는지 확인합니다.
2. 판단 대상, 사실, 가정, 제약, 성공 기준과 실패 모드를 고정합니다.
3. 서로 다른 failure function을 가진 reviewer를 구성해 비노출 독립 분석을 수행합니다.
4. 충돌, 약한 provenance, 숨은 전제나 고위험 누락이 있을 때만 핵심 쟁점을 교차 반박합니다.
5. 실제 코드, 데이터, 테스트와 공식 문서로 material claim을 확인합니다.
6. `adaptive_review: bounded`이고 기존 패널이 놓친 failure function이 결론을 바꿀 수 있으면 specialist를 최대 한 명 추가합니다.
7. `adaptive_review: bounded`일 때만 새 증거가 영향을 준 claim, issue와 axis를 최대 한 번 재검토합니다.
8. HIGH와 CRITICAL에서는 앞선 분석에 참여하지 않은 fresh Judge가 구조화된 dossier를 판정합니다. MEDIUM은 reviewer 2~3명으로 Coordinator가 통합하고, 사용자가 요청할 때만 실제로 완료한 별도 fresh Judge 1명을 추가해 총 3~4명으로 운영합니다.

specialist와 재검토 결과는 Round 1의 독립 관점 수에 더하지 않습니다. final Judge 이후에는 자동 토론을 다시 시작하지 않습니다.

## 실행 보장 상태

Method / Run Summary에는 다음 상태 중 하나가 기록됩니다.

- `independent`: Coordinator 기록과 관찰 가능한 도구 이벤트상 blind reviewer, 상태 확인, fresh Judge와 필요한 증거 접근을 충족
- `partially_independent`: 일부 역할이나 상태를 완전히 격리하거나 관찰하지 못함
- `single_agent`: LOW 판정 또는 서브에이전트 미사용
- `provisional`: 결론에 필요한 증거, Judge 또는 실행 상태가 부족함

`strict`는 Coordinator가 관찰 가능한 범위에서 required capability 부족을 확인했을 때 무단 축소 실행을 금지하는 절차입니다. Stage 0에서 shortfall을 확인하면 `assurance: provisional`, 비어 있지 않은 `missing_capabilities`, worker 0명, `consensus_proposal: null`을 기록하고 panel·claim·issue·axis·adaptive artifact를 만들지 않습니다. 관찰할 수 없는 capability도 충족으로 추정하지 않고 missing으로 기록합니다. 기본값인 `degraded_ok`는 가능한 분석을 계속하되 누락한 capability와 판정 한계를 공개합니다. `provisional` 결과는 `Strong Consensus`로 표현하지 않습니다.

## 스킬이 통제할 수 있는 범위

이 스킬은 모델이 따를 숙고 절차와 출력 계약을 제공하고, 포함된 validator는 생성된 record의 구조와 내부 일관성을 검사합니다. 스킬 자체는 상위 시스템·개발자 지시를 덮어쓰거나 collaboration 도구를 만들고 켜거나, worker 생성을 강제하거나, provider 수준의 컨텍스트 격리와 participant identity를 증명할 수 없습니다. 숨은 시스템 프롬프트의 내용을 검사하는 기능도 없습니다.

live eval의 `--enable multi_agent`는 평가 하네스가 capability를 제공하는 설정이지 스킬이 그 기능을 활성화한다는 뜻이 아닙니다. 평가기는 제공된 환경에서 실제 spawn·wait·follow-up 이벤트와 Judge 생성 순서를 관찰합니다. 해당 기능이 제공되지 않거나 상위 지침이 막으면 성공으로 우회하지 않고 capability shortfall 또는 실행 실패로 기록합니다.

## DecisionRecord.v1

`include_decision_record: true`를 지정하면 사용자용 결론과 함께 기계 검증 가능한 구조화 기록을 요청할 수 있습니다. 이 기록은 case brief, Coordinator가 기록한 panel 상태, claim과 provenance, 반박 coverage, specialist admission, 재검토 범위, issue ledger, axis verdict와 합의 상태를 담습니다. validator는 record 내부 일관성을 검사합니다. live eval runner는 typed 도구 이벤트에서 spawn·completion의 수와 ID 집합, reviewer 완료 뒤 follow-up 대상, follow-up 뒤 wait, fresh Judge 생성·완료 순서를 대조하되 role과 stage 의미는 record-declared 값입니다. 플랫폼에 결속된 participant identity, 숨은 시스템 지시 또는 실제 격리를 증명하지는 않습니다. `method_notes`도 schema의 필수 필드이므로, 적을 내용이 없을 때 `[]`로 포함합니다.

모델 출력은 외부 증거가 아닙니다. 확인하지 못한 값은 `unverified` 또는 `NOT_OBSERVABLE`로 남깁니다. record와 Judge dossier에는 raw reviewer/Judge output, raw chain-of-thought, 내부 프롬프트, 대화 transcript, 비밀 또는 불필요한 개인 데이터를 저장하지 않습니다. schema와 validator가 확인하는 것은 명시적 금지 필드 부재와 record shape입니다. briefing·dossier 경계와 자유문자열 안의 개인정보·raw output 배제는 Coordinator의 절차 의무이며 기계적으로 증명하지 않습니다. keyword 검사로 프라이버시나 외부 시스템의 비저장을 보장한다고 주장하지 않습니다.

## 검증

검증기는 Python 표준 라이브러리만 사용합니다. Windows에서는 한국어 파일을 일관되게 읽도록 UTF-8 모드를 켭니다.

```powershell
$env:PYTHONUTF8='1'
python scripts/validate_package.py
python scripts/run_evals.py --dry-run
```

실제 행동 평가는 Codex 인증과 모델 사용량을 소비하므로 로컬에서 명시적으로 실행합니다.

```powershell
python scripts/run_evals.py --execute --repeat 1 --model gpt-5.6-sol
python scripts/summarize_evals.py --results-dir evals/results --behavior-gate
```

실제 행동 평가는 여섯 시나리오를 한 번씩 실행해 reviewer 생성, 쟁점별 반박, 대상 worker의 재완료와 fresh Judge 순서를 확인합니다. 일반 CI는 모델을 호출하지 않고 패키지와 계약 fixture를 검사합니다.

## 권한과 알려진 제한

스킬 호출은 파일 수정, 배포, 외부 메시지 같은 권한을 추가하지 않습니다. reviewer에게 제공하는 코드, 문서, 웹 페이지와 모델 출력은 비신뢰 입력으로 취급합니다.

1.0은 standalone 스킬입니다. 영속 memory, 과거 실행 기반 역할 추천, 자동 Astra 승격, 실제 청구 비용 최적화, plugin, orchestrator, audit-gate 구현·배포를 지원하지 않습니다. 모델·토큰·비용 정보가 실행 환경에서 관찰되지 않으면 추정하지 않습니다.

비대화형 `codex exec` 호스트가 실제 subagent spawn 이벤트를 제공하지 않으면 live eval은 통과할 수 없습니다. 하네스는 이 경우 record에 적힌 worker를 실제 worker로 인정하지 않고 실패합니다. 앱이나 대화형 CLI에서 subagent가 지원되더라도 비대화형 실행의 지원 여부를 같다고 추정하지 않습니다.

## 향후 오케스트레이션 연결

미래 오케스트레이션 플러그인은 `include_decision_record: true`로 이 스킬을 호출하고 `DecisionRecord.v1`을 검증해 다음 단계를 선택할 수 있습니다. 연결 규칙은 [integration contract](references/integration-contract.md)에 정리했습니다.

`DecisionRecord.v1`은 선택적 로컬 실행 기록이며 final audit 증명이나 cross-skill handoff가 아닙니다. 플러그인은 이를 비신뢰 입력으로 다루고 자체 권한, 실행 lifecycle과 handoff 계약을 소유해야 합니다. 이 standalone 스킬에는 플러그인 의존성이나 연결 코드가 없습니다.

별도 final audit skill이나 audit-gate는 추후 오케스트레이션 플러그인의 책임입니다.

## 라이선스

[MIT License](LICENSE)
