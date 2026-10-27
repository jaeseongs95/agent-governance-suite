# 출처와 적용 범위

확인일: 2026-10-27. 아래 공식 자료의 원칙을 AGS의 현재 계약에 맞춰 적용했다. 모델별 최신 지원 기능·제품 변경은 실제 사용 시 다시 확인한다.

| 출처 | 채택한 원칙 |
| --- | --- |
| [OpenAI: Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering) | 프롬프트·입력·fixture·평가를 코드와 함께 버전관리 |
| [OpenAI: Reasoning best practices](https://developers.openai.com/api/docs/guides/reasoning-best-practices) | 명료한 지시와 필요한 예시, 내부 사고 과정 전체 요구 회피 |
| [Anthropic: Prompt engineering overview](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview) | 성공 기준·실제 평가 확인, 프롬프트로 해결할 수 있는 문제 구분 |
| [Anthropic: Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) | 관련 예시와 자료 경계, 행동 의도 명시 |
| [Anthropic: Define success criteria and build evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests) | 실제 과업·경계 표본·기준판 비교와 품질·지연·비용 분리 |
| [Anthropic: Mitigate jailbreaks and prompt injections](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks) | 외부 자료의 지시와 실제 권한을 구분 |
| [Google: Prompt design strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies) | 일관된 예시·출력 구조, 과다 예시와 모델별 설정 차이 점검 |

## AGS 기준 snapshot

[release-3.0 분석 기준 c53ad5947bc5cc6a4e076eb9931e454e300d5c3b](https://github.com/jaeseongs95/agent-governance-suite/tree/c53ad5947bc5cc6a4e076eb9931e454e300d5c3b).

- `AGENTS.md`: 전문 역할, 공통 계약, 배포와 테스트 규칙.
- `skills/orchestrator/SKILL.md`, `references/skill-classification.md`: 원문 보존·AGENT 최종 선택·분류 경계.
- `mcp-server/src/skill-classification/request.ts`, `inventory.ts`: 원문 포장·전체 inventory·source digest.
- `skills/task-contract/`, `instruction-scope-resolver/`: 목표·권한·지침 담당.
- `skills/evaluation-validity-auditor/`, `test-engineering/`, `independent-audit-gate/`: 평가·검증·감사 담당.
- `skills/solid-design/`: 좁은 전문 역할과 구조·결속 검사 방식의 선례. 본 스킬은 최종 프롬프트 산출물을 정식 단계로 기록하기 위해 선택형 workflow provider를 사용한다.
- `mcp-server/src/provider-semantics.ts`: CLI 존재와 MCP의 자동 의미 검사 연결은 별개.

특정 공급자의 추가 모델 호출·새 API·평가 서비스를 필수 의존성으로 채택하지 않았다. 이 자료는 현재 설치된 AGS의 지침·권한·계약을 대체하지 않는다.
