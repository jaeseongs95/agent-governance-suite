# 출처와 기준

## AGS 기준 snapshot

- 저장소: <https://github.com/jaeseongs95/agent-governance-suite>
- 요청 기준 브랜치: `release-3.0`
- 검토 commit: `5749af69560894b5e3991fae20a12acf16a17da2`
- 확인일: 2026-10-27 (Asia/Seoul)
- 이 commit의 `package.json` 버전은 `2.9.1`이다. 브랜치 이름과 3.0 공개 릴리스 완료를 동일시하지 마라.

| 근거 경로 | 사용한 사실 |
| --- | --- |
| `AGENTS.md` | 전문 책임 분리, 호스트 중립, 배포·검증·등록 규칙 |
| `skills/orchestrator/SKILL.md`, `references/entry-details.md` | 선택은 agent 책임, 기존 capability·artifact·gate 연결 |
| `skills/orchestrator/references/engineering-practices/index.md` | Engineering Practices는 공유 참조 모듈 |
| 같은 디렉터리의 `implementation.md` | IMP-001~004의 최소 변경·실제 경계·오류·자원 수명 |
| 같은 디렉터리의 `agent-instructions.md` | DOC-001/004/006의 선택 조건·단일 원본·의미 보존 |
| `skills/ponytail/SKILL.md` | 단일 구현인 adapter도 실제 계약 경계를 보존 |
| `skills/cs-engineering/SKILL.md`, `assets/rules/software-design.json` | 정확성 의무·draft 설계 카드의 범위 |
| `skills/code-review/SKILL.md`, `skills/test-engineering/SKILL.md` | 리뷰·테스트 소유권과 분석 결과의 한계 |
| `contracts/skill-descriptor.v2.schema.json`, `contracts/provider-result.v1.schema.json` | 기존 provider 등록·결과 envelope |
| `mcp-server/src/registry.ts`, `mcp-server/src/skill-classification/inventory.ts` | 동적 registry와 분류 출처 digest/span 결속 |

고정 원문은 `https://github.com/jaeseongs95/agent-governance-suite/blob/5749af69560894b5e3991fae20a12acf16a17da2/<path>`에서 확인할 수 있다. 실제 작업 시 현재 적용 지침과 구현을 다시 확인하라.

## SOLID 1차 자료

- Robert C. Martin, [The Single Responsibility Principle](https://blog.cleancoder.com/uncle-bob/2014/05/08/SingleReponsibilityPrinciple.html), 2014-05-08. SRP의 변경 이유와 요구 주체.
- Robert C. Martin, [The Open Closed Principle](https://blog.cleancoder.com/uncle-bob/2014/05/12/TheOpenClosedPrinciple.html), 2014-05-12. 안정된 경계와 확장.
- Barbara H. Liskov·Jeannette M. Wing, [A Behavioral Notion of Subtyping](https://www.cs.cmu.edu/~wing/publications/LiskovWing94.pdf), ACM TOPLAS, 1994. 타입 서명만이 아닌 행위·불변조건 보존.
- Robert C. Martin, [Solid Relevance](https://blog.cleancoder.com/uncle-bob/2020/10/18/Solid-Relevance.html), 2020-10-18. 다섯 원칙의 범위.

이 패키지의 AGS 역할 배분, 적용 조건, 결과 상태와 최소 변경 판단은 위 원칙을 AGS의 현재 계약에 맞춘 설계 결정이다. 외부 저자가 AGS의 동작을 검증했다는 뜻이 아니다.
