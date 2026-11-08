# Agent Governance Suite v1.4.1

`v1.4.1`은 한국어 산문 워크플로의 평가·복구 근거를 현재 구현과 일치시키는 패치 릴리스다. 한국어 산문 provider는 이번 릴리스에서도 비활성이다.

## 변경 사항

- 구조화 평가 cycle을 canonical digest로 기록하고 receipt·SQLite의 원문 비저장과 기존 산출물 비덮어쓰기를 검증한다.
- finalization receipt를 selection의 `edit-decision-set` 입력과 evidence에 결속한다.
- `korean-prose-editor` 사본을 immutable source commit `c5df63749e2edfc8aa424f9935ee3cd4697d3c49`로 갱신한다.
- 범주·용어 보존, 대리 명사 없는 직접화, 편집 후 경계 공백 거부와 실행 provenance v3 계약을 포함한다.

## 품질 상태와 제한

- 기존 11-case gate는 실패 기록과 합격선을 보존한 채 `invalid-corpus`로 종결했다.
- 별도 recovery는 edit 5/8, restraint 4/4, major meaning change 0, protected failure 0으로 실패했다.
- 실패 원인 보정은 구현했지만 같은 recovery는 재실행하지 않았다. 새 정식 frame과 신규 private holdout이 기존 기준을 통과하기 전까지 registry, 직접 descriptor, implicit invocation과 fail-closed 지침의 비활성 상태를 유지한다.

## 호환성

공개 MCP 도구와 SQLite schema는 바뀌지 않는다. 이전 릴리스로 되돌리려면 marketplace ref와 설치 버전을 `v1.4.0`으로 복원한다.
