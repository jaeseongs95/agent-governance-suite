# AGS 2.8.1 릴리스 노트 초안

AGS 2.8.1 후보는 테스트 설계·근거 검토와 고정 변경분 코드 리뷰를 기존 전문 스킬 흐름에 연결한다. 새 `test-engineering` 0.1.0과 `code-review` 0.1.0은 소스 패키지 `ags-engineering-practices` 0.1.0에서 편입한다. 패키지 0.1.0과 AGS 2.8.1은 서로 다른 버전 축이다.

공통 지식은 8개 모듈·48개 규칙이며 담당 스킬이 필요한 참조만 읽는다. 닫힌 `engineering-*.v1` 계약 9개는 테스트 계획·proof, 고정 리뷰 입력·보고서, snapshot과 실행 receipt를 표현한다. 디버깅은 `blocker-diagnostician`, 최소 구현은 `ponytail`, 의존성 보안은 `software-security-auditor`, 수용 근거는 `acceptance-evidence-validator`, 흐름 연결은 `orchestrator`의 기존 책임을 유지한다.

이 후보는 새 권한 source, hook, MCP handler, DB·세션 제어 또는 signed binding을 추가하지 않는다. raw proof와 로컬 `CONSISTENT` 결과는 수용·독립 감사·릴리스 승인 근거로 자동 승격되지 않는다. `code-review`의 `NO_BLOCKING_FINDINGS`도 고정된 입력 범위의 리뷰 결과이며 전체 제품의 정확성이나 출시 가능성을 뜻하지 않는다.

`cs-engineering` 0.2.0의 CS 조건 도출, 선택된 stage artifact binding, draft 규칙의 상태와 2.8.0 릴리스 노트의 한계는 그대로 유지한다. Node.js 24 이상, `pnpm@11.19.0`, Registry 2.0, SourceLock 3.0과 TaskEnvelope 1.0 호환 기준도 바꾸지 않으며 새 npm 의존성을 추가하지 않는다.

후보 작업 트리에는 source, registry·source lock, orchestrator bridge와 스킬별 테스트 경로 연결이 반영되어 있다. 새 package script와 npm 의존성은 추가하지 않았다. Linux 생성 artifact의 exact bytes를 인수했으며, source `1b36ec77`의 [CI 37448816713](https://github.com/jaeseongs95/agent-governance-suite/actions/runs/37448816713)에서 양OS 각각 925개 통과·5개 skip과 official exit 0이 관측됐다. 이 결과는 원자료 인수 후 해당 source pin의 검증 범위로 사용하고, 이후 변경된 후보의 PASS로 자동 재사용하지 않는다. 입력 패키지의 자체 검증 보고도 통합 후보의 PASS로 재사용하지 않는다. 실제 2.8.1 Codex·Claude 호스트 로딩과 최종 독립 감사는 미실행이며, official metadata 검증은 실제 호스트 로딩을 대신하지 않는다.

공개 준비용 metadata는 version 2.8.1만 유지하고 candidate/publicVersion 필드를 제거하며 README 설치 예시는 v2.8.1로 맞춘다. 2.8.0 릴리스는 이미 공개돼 있다. 이는 2.8.1 tag·Release 게시 완료를 뜻하지 않으며, v2.8.1 설치 예시는 해당 tag·Release 게시 후 사용한다. 변경 후 최종 후보의 필요한 검사·실제 호스트 검증·최종 독립 감사를 마쳐야 한다.
