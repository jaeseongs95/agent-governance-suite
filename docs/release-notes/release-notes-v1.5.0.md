# Agent Governance Suite v1.5.0

`v1.5.0`은 현재 task에서 관측 가능한 모델과 reasoning effort를 요청의 난도·위험과 비교하는 `model-effort-advisor`를 추가하는 minor 릴리스다. 적정 설정이나 관측 불가 상태는 일반 작업을 방해하지 않으며, 모델 설정을 자동으로 바꾸지 않는다.

## 변경 사항

- `model-effort-advisor` 스킬과 `ModelEffortAdvice.v1` 출력 schema를 추가한다.
- registry에 bootstrap provider와 `model-effort-fit-assessment` capability를 등록한다.
- 오케스트레이터가 runtime metadata, 사용자 설명 또는 현재 요청의 화면에서 모델·추론 수준을 모두 확인한 경우에만 적합성 평가를 요청한다.
- 과다·부족·적정·관측 불가 사례와 관측 근거 없는 불일치 주장을 검사하는 회귀 fixture를 추가한다.
- 저장소 자체에서 만든 스킬의 생성 커밋과 디렉터리 checksum을 `skills/source-lock.json`에 고정한다.

## 품질 상태와 제한

- 구체적인 적합성 판정에는 현재 task의 모델과 reasoning effort를 신뢰할 수 있는 출처에서 모두 관측해야 한다.
- 스킬은 모델 선택, 구독 한도, 실제 사용량이나 비용을 추정하거나 변경하지 않는다.
- 새 정식 frame과 신규 private holdout이 기존 기준을 통과하기 전까지 `korean-prose-editor`는 registry, 직접 descriptor, implicit invocation과 fail-closed 지침에서 비활성이다.

## 호환성과 복구

공개 MCP 도구와 SQLite schema는 바뀌지 않는다. 문제가 생기면 marketplace ref와 설치 버전을 `v1.4.3`으로 복원한다.
