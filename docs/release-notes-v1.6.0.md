# Agent Governance Suite v1.6.0

`v1.6.0`은 한국어 산문 평가를 실제 모델 실행 전에 동결·검증하는 readiness gate를 추가하는 minor 릴리스다.

## 변경 사항

- 평가 frame, corpus 타당성 보고서, rubric·threshold digest와 실행 횟수를 하나의 계약으로 결속한다.
- 정답 label을 모델·독립 심사 입력과 분리하고, start claim 이후 평가 대상이 바뀌면 실행을 거부한다.
- 최종 품질 판정은 receipt·SQLite·최종 case와 독립 심사 결과에서 지표를 다시 집계한다.
- 기존 실패·무효 평가를 새 증거로 재해석하지 않는다.

## 품질 상태와 제한

- 이 릴리스는 평가 실행 준비도를 검증하는 기반을 제공하며 `korean-prose-editor` provider를 활성화하지 않는다.
- readiness 통과는 품질 기준 통과나 릴리스 승인을 뜻하지 않는다.

## 호환성과 복구

공개 MCP 도구와 SQLite schema는 바뀌지 않는다. 문제가 생기면 marketplace ref와 설치 버전을 `v1.5.0`으로 복원한다.
