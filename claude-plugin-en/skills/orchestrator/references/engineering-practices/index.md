# Engineering Practices — 필요한 모듈만 선택

새 라우터나 총괄 스킬이 아니다. 기존 orchestrator가 담당자와 현재 작업 조건에 맞는 참조만 선택한다.

| 모듈 | 규칙 수 | 담당 |
| --- | ---: | --- |
| [test-design](test-design.md) | 6 | test-engineering |
| [test-proof](test-proof.md) | 6 | test-engineering |
| [code-review](code-review.md) | 6 | code-review |
| [debugging](debugging.md) | 6 | blocker-diagnostician |
| [implementation](implementation.md) | 6 | ponytail |
| [dependency](dependency.md) | 6 | software-security-auditor |
| [verification](verification.md) | 6 | acceptance-evidence-validator |
| [agent-instructions](agent-instructions.md) | 6 | orchestrator |

[CLI 계약과 신뢰 경계](cli.md) · [기계 판독 원본](catalog.json) · [출처](sources.lock.json)

이전 cs-engineering의 원리·불변조건을 참조하고 재정의하지 않는다. 원인 진단·구현·수용·독립 감사는 기존 담당자가 유지한다. 모든 모듈을 기본 프롬프트에 한꺼번에 넣지 않는다.
