# 필요한 분야만 선택한다

실제 작업 의미를 먼저 확인한다. 파일명이나 특정 단어만으로 선택하지 않는다.
기본 자동 선택 풀은 아래의 핵심 5개 분야, 20개 규칙이다. `validated`는 이 팩의
제한된 실행 참조 사례를 확인했다는 상태이며 AGS 제품·실제 모델 성능·독립 감사 인증이 아니다.
나머지 5개 분야의 20개 규칙도 본문과 출처가 완성되어 있다. 명시적 도입 근거를
`draftUse`와 정책에 남기는 작업에서 `--allow-draft`로 조회·사용한다.

| 작업의 판단 대상 | 모듈 | 상태 |
| --- | --- | --- |
| 그래프·탐색·자료구조·계산 비용 | algorithms-data-structures | validated |
| 경쟁·락·소유권·취소 | concurrency | validated |
| 트랜잭션·격리·저장 제약·마이그레이션 | databases | validated |
| ACK·중복·재시도·순서·버전 | distributed-systems | validated |
| 계측·백프레셔·캐시·배치 | performance | validated |
| 참조 공유·숫자·예외·메모리 가시성 | language-semantics | draft |
| 파일·프로세스·시간·자원 회수 | operating-systems | draft |
| 부분 수신·deadline·프로토콜·재연결 | networking | draft |
| 계약·상태 전이·호환성·최소 변경 | software-design | draft |
| 신뢰 경계·근거·입력 제한·비밀 | security-boundaries | draft |

```text
node <SKILL_DIR>/scripts/validate.mjs catalog
node <SKILL_DIR>/scripts/validate.mjs rules --domain concurrency,databases
node <SKILL_DIR>/scripts/validate.mjs rules --rule SEC-AUTHORITY-001 --allow-draft
```

카드를 모두 컨텍스트에 넣거나 고정 개수까지만 읽지 않는다. 필요한 만큼 선택하고
각 선택 근거를 기록한다. CLI의 파일 무결성 검사와 모델 컨텍스트 로딩은 별개다.
CLI는 무결성을 위해 잠긴 파일들을 읽지만 모델에는 선택된 카드만 반환한다.
JSON 카드가 정본이며 Markdown은 그 카드의 읽기용 표현이다.
