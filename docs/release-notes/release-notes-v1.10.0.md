# Agent Governance Suite v1.10.0

`v1.10.0`은 검토된 Korean prose 용어집을 확장하고, 명시적 배포 승인에 따라 `korean-prose-editor` workflow를 활성화하는 minor 릴리스다.

## 변경 사항

- 공식 프로젝트·표준·공식 한국어 문서에 근거한 43개 entry와 48개 form을 제공한다.
- `protect` 25개, `prefer` 4개, `avoid` 8개, `allow` 6개 정책을 각각 검증한다.
- 중복 ID·충돌 form·비-NFC 값·잘못된 policy·누락된 HTTPS source를 build 단계에서 거부한다.
- registry, 직접 descriptor와 Codex implicit invocation에서 `korean-prose-editor`를 활성화한다.
- 테스트의 가상 업데이트 버전을 현재 plugin metadata에서 계산해 릴리스 버전 상승과 분리한다.

## 품질 상태와 제한

- 용어집 빌드·SQLite/MCP 조회·통합·clean-room 검증은 통과했다.
- 독립 구조·의미 감사를 통과한 100-case corpus에서 SQLite 조회 결과는 100/100 일치했다.
- 실제 모델을 사용한 엄격한 holdout 평가는 direct editing의 최소 편집 범위 검증에서 중단돼 MCP arm과 최종 `≥80%` 지표를 만들지 못했다. 이 릴리스는 해당 임계값을 달성했다고 주장하지 않는다.
- 현재 활성화는 용어집·MCP·통합 검증 결과와 사용자의 명시적 승인에 따른 배포 결정이다.

## 호환성과 복구

workflow와 continuity SQLite schema는 `v1.9.0`과 같다. 문제가 생기면 marketplace ref와 설치 버전을 `v1.9.0`으로 복원한다. 더 이전 `v1.6.0`으로 롤백할 때는 `v1.7.0` 도입 전에 만든 workflow v3·continuity v1 backup을 복원해야 한다.
